import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { decodeDeepSeekRuntimeInfo } from '../lib/chat/deepSeekBinary.ts';
import { dshCacheHome } from '../lib/runtime/dshHome.ts';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOST_CONTRACT = path.join(ROOT, 'contracts/grigdesk-host-contract.json');
const MANIFEST_FORMAT = 1;

const HELP = `grigdesk-dsh — сборка, проверка, допуск и установка DeepSeek Harness для GrigDesk

Использование: grigdesk-dsh <команда> [аргументы]

  build     Собрать ELF: зависимости → pinned Node → снимок upstream → сборка → verify → допуск
            [--out-dir <каталог>] [--binary-version <версия>] [--require-admission] [--cache-dir <каталог>]
  verify    Полная проверка готового ELF
            --binary <ELF>
  admit     Живой smoke GLM; с --admit записывает допуск в compatibility/glm.json
            --binary <ELF> --mode api|coding-plan [--admit] [--force] [--model <модель>]
  install   Установить ELF в GrigDesk штатным установщиком (атомарно, с резервом)
            --binary <ELF> --target <путь> [--host-contract <файл>] [--releases-dir <каталог>]
            [--glm-mode api|coding-plan]
  release   Опубликовать GitHub Release с ELF, manifest.json и sha256
            --tag vX.Y.Z --binary <ELF> [--binary <ELF>...] [--prerelease] [--notes <файл>]
            [--min-server-version <версия GrigDesk>] [--sidecar]
  prune     Чистка кэша поколений и резервных ELF
            [--cache-dir <каталог>] [--keep-builds N] [--keep-releases N]
  check     typecheck, границы импортов и тесты пакета
  help      Эта справка

Общие переменные: GRIGDESK_DSH_CACHE — абсолютный путь кэша (иначе ~/.cache/grigdesk-dsh);
GRIGDESK_DSH_ENV_FILE — файл .env с ключами ZAI_API_KEY / ZAI_CODING_API_KEY (иначе .env
репозитория, затем ~/.grigdesk/.env).`;

interface Parsed {
  values: Map<string, string>;
  repeated: Map<string, string[]>;
  flags: Set<string>;
}

interface CommandSpec {
  values: string[];
  flags: string[];
}

/**
 * Разбирает пары «флаг значение»; одиночные флаги перечислены отдельно.
 * Неизвестный флаг или значение без флага — ошибка до любых эффектов.
 */
function parseFlags(argv: readonly string[], spec: CommandSpec): Parsed {
  const values = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  const flags = new Set<string>();

  for (let index = 0; index < argv.length; index++) {
    const name = argv[index]!;

    if (spec.flags.includes(name)) {
      flags.add(name);

      continue;
    }

    const value = argv[index + 1];

    if (!spec.values.includes(name) || value === undefined || value.startsWith('--')) {
      throw new Error(`Неизвестный или неполный аргумент: ${name}`);
    }

    repeated.set(name, [...repeated.get(name) ?? [], value]);
    values.set(name, value);
    index += 1;
  }

  return { values, repeated, flags };
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name);

  if (!value) {
    throw new Error(`Обязательный аргумент: ${name}`);
  }

  return value;
}

/**
 * Запускает скрипт репозитория текущим Node и возвращает код выхода.
 * Наследует stdio: журналы сборки и проверок видны вызывающему без дублирования.
 */
function script(name: string, args: readonly string[] = []): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', name), ...args], {
      cwd: ROOT,
      stdio: 'inherit',
    });

    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
}

/**
 * Внешняя команда (npm, gh) с наследованием stdio; отсутствие binaries
 * превращается в понятную ошибку имени команды.
 */
function command(binary: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: ROOT, stdio: 'inherit' });

    child.once('error', (error) => reject(new Error(`Не удалось запустить ${binary}: ${(error as Error).message}`)));
    child.once('close', (code) => resolve(code ?? 1));
  });
}

async function ensureCode(code: number, what: string): Promise<void> {
  if (code !== 0) {
    throw new Error(`Не удалось: ${what} (код ${code})`);
  }
}

/**
 * Кэш поставки: явный --cache-dir имеет приоритет над GRIGDESK_DSH_CACHE и стандартным путём.
 */
function cacheHome(values: Map<string, string>): string {
  const explicit = values.get('--cache-dir');

  if (explicit) {
    if (!path.isAbsolute(explicit)) {
      throw new Error('--cache-dir должен быть абсолютным путём');
    }

    return path.resolve(explicit);
  }

  return dshCacheHome();
}

async function readHost(): Promise<{ glm: { mode: string } }> {
  return JSON.parse(await fs.readFile(HOST_CONTRACT, 'utf8')) as { glm: { mode: string } };
}

async function exists(file: string): Promise<boolean> {
  return await fs.access(file).then(() => true, () => false);
}

/**
 * Сборка повторяет порядок чистого checkout: зависимости пакета, pinned worker Node,
 * снимок upstream, ELF и полная проверка. Проверка допуска информационная: кандидат
 * без допуска — нормальный rc; --require-admission превращает код 3 в отказ.
 */
async function build({ values, flags }: Parsed): Promise<void> {
  const cache = cacheHome(values);
  const outDir = path.resolve(values.get('--out-dir') ?? path.join(cache, 'out'));
  const nodeCache = path.join(cache, 'node-cache');

  await ensureCode(await command('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']), 'зависимости пакета');
  await ensureCode(await script('prepareRuntimeDeps.mts', ['--node-cache-dir', nodeCache]), 'подготовка pinned Node');
  await ensureCode(await script('prepareUpstream.mts'), 'снимок upstream');

  const buildArgs = ['--out-dir', outDir, '--node-cache-dir', nodeCache];

  for (const flag of ['--binary-version', '--payload', '--vendor-dir']) {
    const value = values.get(flag);

    if (value) {
      buildArgs.push(flag, flag === '--binary-version' ? value : path.resolve(value));
    }
  }

  await ensureCode(await script('buildBinary.mts', buildArgs), 'сборка ELF');

  const binary = path.join(outDir, 'deepseek');

  await ensureCode(await script('verify.mts', ['--binary', binary]), 'проверка ELF');
  await fs.writeFile(`${binary}.runtime-info.json`, (await run(binary, ['--runtime-info', '--json'], {
    env: { PATH: '' },
    timeout: 60000,
    maxBuffer: 1 << 20,
  })).stdout);

  const admission = await script('admissionCheck.mts', [
    '--binary', binary, '--mode', (await readHost()).glm.mode, '--host-contract', HOST_CONTRACT,
  ]);

  if (admission === 3) {
    const hint = 'допуск GLM отсутствует — получите его: grigdesk-dsh admit --binary <ELF> --mode <режим> --admit';

    if (flags.has('--require-admission')) {
      throw new Error(`Собранный ELF без допуска: ${hint}`);
    }

    process.stdout.write(`Внимание: ${hint}\n`);
  } else {
    await ensureCode(admission, 'проверка допуска');
  }

  process.stdout.write(`Готово: ${binary}\n`);
}

async function install({ values }: Parsed): Promise<void> {
  const args = [
    '--binary', path.resolve(required(values, '--binary')),
    '--target', path.resolve(required(values, '--target')),
    '--host-contract', path.resolve(values.get('--host-contract') ?? HOST_CONTRACT),
  ];

  for (const flag of ['--releases-dir', '--glm-mode']) {
    const value = values.get(flag);

    if (value) {
      args.push(flag, flag === '--releases-dir' ? path.resolve(value) : value);
    }
  }

  await ensureCode(await script('install.mts', args), 'установка ELF');
}

async function admit({ values, flags }: Parsed): Promise<void> {
  const args = [
    '--binary', path.resolve(required(values, '--binary')),
    '--mode', required(values, '--mode'),
    '--host-contract', path.resolve(values.get('--host-contract') ?? HOST_CONTRACT),
  ];

  if (flags.has('--admit')) {
    args.push('--admit');
  }

  if (flags.has('--force')) {
    args.push('--force');
  }

  const model = values.get('--model');

  if (model) {
    args.push('--model', model);
  }

  await ensureCode(await script('glmLiveSmoke.mts', args), 'живой smoke GLM');

  if (flags.has('--admit')) {
    process.stdout.write('Допуск записан в compatibility/glm.json. Зафиксируйте его коммитом: stable-сборка '
      + 'в CI включает допуск для всех платформ, живой smoke после этого не требуется.\n');
  }
}

interface ReleaseAsset {
  file: string;
  platform: string;
  arch: string;
  sha256: string;
  size: number;
  packageId: string;
  buildId: string;
  binaryVersion: string;
  upstreamVersion: string;
  workerNode: { version: string; abi: string };
  capabilities: Record<string, unknown>;
  glm: { profileRevision: string; policyRevision: string; admission: string[] };
}

/**
 * Metadata ELF берётся из рядом лежащего `<ELF>.runtime-info.json`, если он есть:
 * sidecar пишет build-шаг на родном runner, поэтому darwin/arm64 ELF описываются
 * на linux без запуска. Без sidecar бинарник опрашивается сам — только родная платформа.
 */
async function describeAsset(binary: string, withSidecar: boolean): Promise<ReleaseAsset> {
  const absolute = path.resolve(binary);

  if (!await exists(absolute)) {
    throw new Error(`ELF не найден: ${absolute}`);
  }

  const sidecar = `${absolute}.runtime-info.json`;
  const metadata = withSidecar && await exists(sidecar)
    ? JSON.parse(await fs.readFile(sidecar, 'utf8'))
    : JSON.parse((await run(absolute, ['--runtime-info', '--json'], {
      env: { PATH: '' },
      timeout: 60000,
      maxBuffer: 1 << 20,
    })).stdout);
  const info = decodeDeepSeekRuntimeInfo(metadata);
  const bytes = await fs.readFile(absolute);

  return {
    file: path.basename(absolute),
    platform: info.platform,
    arch: info.arch,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    packageId: info.packageId,
    buildId: info.buildId,
    binaryVersion: info.binaryVersion,
    upstreamVersion: info.upstreamVersion,
    workerNode: info.workerNode,
    capabilities: info.capabilities as Record<string, unknown>,
    glm: {
      profileRevision: info.glm.profileRevision,
      policyRevision: info.glm.policyRevision,
      admission: info.glm.admission.map((entry) => entry.mode),
    },
  };
}

/**
 * Stable-релиз требует допуск режима потребителя на каждом ELF: кандидат без допуска
 * публикуется только как prerelease. Проверяется metadata, поэтому CI и локальный
 * запуск дают одинаковый вердикт без живого smoke.
 */
async function assertStableAdmission(tag: string, assets: readonly ReleaseAsset[], prerelease: boolean): Promise<void> {
  if (prerelease) {
    return;
  }

  const mode = (await readHost()).glm.mode;
  const missing = assets.filter((asset) => !asset.glm.admission.includes(mode));

  if (missing.length > 0) {
    throw new Error(`Stable-релиз ${tag} требует допуск GLM режима «${mode}»: `
      + `${missing.map((asset) => asset.file).join(', ')}. Опубликуйте --prerelease или получите допуск.`);
  }
}

/**
 * Release собирается в staging кэша: ELF с именем платформы, manifest.json и sha256.
 * Публикация — только через gh; без него файлы остаются в staging для ручной загрузки.
 */
async function release({ values, repeated, flags }: Parsed): Promise<void> {
  const tag = required(values, '--tag');

  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(tag)) {
    throw new Error(`Тег должен иметь вид vX.Y.Z или vX.Y.Z-rc.N: ${tag}`);
  }

  const binaries = (repeated.get('--binary') ?? []).map((value) => path.resolve(value));

  if (binaries.length === 0) {
    throw new Error('Обязательный аргумент: --binary <ELF> (можно несколько раз)');
  }

  const prerelease = flags.has('--prerelease');
  const assets: ReleaseAsset[] = [];

  const sidecar = flags.has('--sidecar');

  for (const binary of binaries) {
    assets.push(await describeAsset(binary, sidecar));
  }

  const builds = new Set(assets.map((asset) => asset.buildId));

  if (builds.size !== 1) {
    throw new Error(`ELF принадлежат разным generation: ${[...builds].join(', ')}`);
  }

  await assertStableAdmission(tag, assets, prerelease);

  const staging = path.join(cacheHome(values), 'release', tag);

  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true, mode: 0o755 });

  const uploaded: string[] = [];

  for (const [index, asset] of assets.entries()) {
    const name = `deepseek-${asset.platform}-${asset.arch}`;
    const target = path.join(staging, name);

    await fs.copyFile(binaries[index]!, target);
    await fs.chmod(target, 0o755);
    asset.file = name;
    await fs.writeFile(`${target}.sha256`, `${asset.sha256}  ${name}\n`);
    uploaded.push(target, `${target}.sha256`);
  }

  const manifest = {
    format: MANIFEST_FORMAT,
    tag,
    createdAt: new Date().toISOString(),
    minServerVersion: values.get('--min-server-version') ?? null,
    hostContract: await readHost(),
    assets,
  };
  const manifestFile = path.join(staging, 'manifest.json');

  await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  uploaded.push(manifestFile);

  const notes = values.get('--notes') ? path.resolve(values.get('--notes')!) : null;
  const ghArgs = ['release', 'create', tag, '--title', tag];

  if (prerelease) {
    ghArgs.push('--prerelease');
  }

  ghArgs.push(...(notes ? ['--notes-file', notes] : ['--generate-notes']));
  await ensureCode(await command('gh', ghArgs), 'создание GitHub Release');
  await ensureCode(await command('gh', ['release', 'upload', tag, ...uploaded, '--clobber']), 'загрузка активов');
  process.stdout.write(`Опубликован ${tag}: ${uploaded.length} файлов из ${staging}\n`);
}

async function prune({ values }: Parsed): Promise<void> {
  const args = ['--cache-dir', path.join(cacheHome(values), 'node-cache')];

  for (const flag of ['--keep-builds', '--keep-releases']) {
    const value = values.get(flag);

    if (value) {
      args.push(flag, value);
    }
  }

  await ensureCode(await script('pruneRuntimeCache.mts', args), 'чистка кэша');
}

/**
 * Единая проверка перед сдачей: типы, границы импортов и тесты через сторож памяти.
 * Любой отказ останавливает цепочку — частично зелёный результат не сообщается.
 */
async function check(): Promise<void> {
  await ensureCode(await command('npm', ['run', '-s', 'typecheck']), 'typecheck');
  await ensureCode(await script('checkImports.mts'), 'границы импортов');
  await ensureCode(await script('test.mts'), 'тесты');
}

const COMMANDS: Record<string, { spec: CommandSpec; run: (parsed: Parsed) => Promise<void> }> = {
  build: {
    spec: { values: ['--out-dir', '--binary-version', '--payload', '--vendor-dir', '--cache-dir'], flags: ['--require-admission'] },
    run: build,
  },
  verify: {
    spec: { values: ['--binary'], flags: [] },
    run: async ({ values }) => {
      await ensureCode(await script('verify.mts', ['--binary', path.resolve(required(values, '--binary'))]), 'проверка ELF');
    },
  },
  admit: {
    spec: { values: ['--binary', '--mode', '--host-contract', '--model'], flags: ['--admit', '--force'] },
    run: admit,
  },
  install: {
    spec: { values: ['--binary', '--target', '--host-contract', '--releases-dir', '--glm-mode'], flags: [] },
    run: install,
  },
  release: {
    spec: {
      values: ['--tag', '--binary', '--notes', '--min-server-version', '--cache-dir'],
      flags: ['--prerelease', '--sidecar'],
    },
    run: release,
  },
  prune: {
    spec: { values: ['--cache-dir', '--keep-builds', '--keep-releases'], flags: [] },
    run: prune,
  },
  check: {
    spec: { values: [], flags: [] },
    run: check,
  },
};

async function main(): Promise<void> {
  const [name, ...rest] = process.argv.slice(2);

  if (!name || name === 'help' || name === '--help' || name === '-h') {
    process.stdout.write(`${HELP}\n`);

    return;
  }

  const entry = COMMANDS[name];

  if (!entry) {
    process.stderr.write(`Неизвестная команда: ${name}\n\n${HELP}\n`);
    process.exitCode = 2;

    return;
  }

  await entry.run(parseFlags(rest, entry.spec));
}

await main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
});

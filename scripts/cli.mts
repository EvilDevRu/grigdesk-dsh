import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { decodeDeepSeekRuntimeInfo } from '../lib/chat/deepSeekBinary.ts';
import { dshCacheHome, nodeCachePath } from '../lib/runtime/dshHome.ts';
import { releaseAssetName } from '../lib/runtime/executable.ts';
import { runCliMenu } from './cliMenu.mts';
import { runCliAction, runSteps } from './cliProgress.mts';
import {
  assertReleaseDownloadable, isPrereleaseVersion, NPM_PACKAGE_NAME, npmVersionFromTag, stageNpmPackage,
} from './npmPackage.mts';

const run = promisify(execFile);
const ENTRY = fileURLToPath(import.meta.url);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOST_CONTRACT = path.join(ROOT, 'contracts/grigdesk-host-contract.json');
const MANIFEST_FORMAT = 1;

const HELP = `grigdesk-dsh-ctl — сборка, проверка, допуск и установка DeepSeek Harness для GrigDesk

Использование: grigdesk-dsh-ctl <команда> [аргументы]
В терминале вызов без команды открывает меню.

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
            [--min-server-version <версия GrigDesk>] [--sidecar] [--dry-run]
  publish-npm  Опубликовать npm-пакет @grigdesk/dsh версии готового релиза
             (локально, токен в ~/.npmrc) --tag vX.Y.Z [--registry <url>] [--dry-run]
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
function command(binary: string, args: readonly string[], cwd = ROOT): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, stdio: 'inherit' });

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
  const nodeCache = nodeCachePath(cache);
  const binary = path.join(outDir, 'deepseek');
  const buildArgs = ['--out-dir', outDir, '--node-cache-dir', nodeCache];

  for (const flag of ['--binary-version', '--payload', '--vendor-dir']) {
    const value = values.get(flag);

    if (value) {
      buildArgs.push(flag, flag === '--binary-version' ? value : path.resolve(value));
    }
  }

  await runSteps([
    ['Зависимости пакета', async () => {
      const code = await command('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);

      await ensureCode(code, 'зависимости пакета');
    }],
    ['Подготовка закреплённого Node.js', async () => {
      const code = await script('prepareRuntimeDeps.mts', ['--node-cache-dir', nodeCache]);

      await ensureCode(code, 'подготовка pinned Node');
    }],
    ['Снимок DeepSeek Harness', async () => {
      await ensureCode(await script('prepareUpstream.mts'), 'снимок upstream');
    }],
    ['Сборка ELF', async () => {
      await ensureCode(await script('buildBinary.mts', buildArgs), 'сборка ELF');
    }],
    ['Проверка ELF и запись метаданных', async () => {
      await ensureCode(await script('verify.mts', ['--binary', binary]), 'проверка ELF');
      await fs.writeFile(`${binary}.runtime-info.json`, (await run(binary, ['--runtime-info', '--json'], {
        env: { PATH: '' },
        timeout: 60000,
        maxBuffer: 1 << 20,
      })).stdout);
    }],
    ['Проверка допуска GLM', async () => {
      const admission = await script('admissionCheck.mts', [
        '--binary', binary, '--mode', (await readHost()).glm.mode, '--host-contract', HOST_CONTRACT,
      ]);

      if (admission !== 3) {
        await ensureCode(admission, 'проверка допуска');

        return;
      }

      const hint = 'допуск GLM отсутствует — получите его: '
        + 'grigdesk-dsh-ctl admit --binary <ELF> --mode <режим> --admit';

      if (flags.has('--require-admission')) {
        throw new Error(`Собранный ELF без допуска: ${hint}`);
      }

      process.stdout.write(`Внимание: ${hint}\n`);
    }],
  ]);

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

/**
 * Платформонезависимая identity generation: источник Harness, composition и lock
 * общие для всех целей одного тега, тогда как buildId включает платформу, ABI и компилятор.
 */
interface GenerationIdentity {
  binaryVersion: string;
  upstreamVersion: string;
  sourceCommit: string;
  composition: string;
  dependencyLock: string;
  profileRevision: string;
  policyRevision: string;
  admission: string[];
}

interface ReleaseAsset extends GenerationIdentity {
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
    sourceCommit: info.glm.inputs.source.commit,
    composition: info.glm.inputs.inputIdentity.composition,
    dependencyLock: info.glm.inputs.inputIdentity.dependencyLock,
    profileRevision: info.glm.profileRevision,
    policyRevision: info.glm.policyRevision,
    admission: info.glm.admission.map((entry) => entry.mode).toSorted(),
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
 * Ключ generation без платформенных полей; assets одного тега обязаны дать один ключ.
 */
function generationKey(asset: GenerationIdentity): string {
  return JSON.stringify([
    asset.binaryVersion, asset.upstreamVersion, asset.sourceCommit, asset.composition,
    asset.dependencyLock, asset.profileRevision, asset.policyRevision, asset.admission,
  ]);
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

  const generations = new Map<string, string[]>();

  for (const asset of assets) {
    generations.set(generationKey(asset), [...generations.get(generationKey(asset)) ?? [], asset.file]);
  }

  if (generations.size !== 1) {
    throw new Error(`ELF принадлежат разным generation (источник, composition, lock или ревизии GLM): `
      + `${[...generations.values()].map((files) => files.join('+')).join(' против ')}`);
  }

  await assertStableAdmission(tag, assets, prerelease);

  const staging = path.join(cacheHome(values), 'release', tag);

  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true, mode: 0o755 });

  const uploaded: string[] = [];

  for (const [index, asset] of assets.entries()) {
    const name = releaseAssetName(asset.platform, asset.arch);
    const target = path.join(staging, name);

    await fs.copyFile(binaries[index]!, target);
    await fs.chmod(target, 0o755);
    asset.file = name;
    await fs.writeFile(`${target}.sha256`, `${asset.sha256}  ${name}\n`);
    uploaded.push(target, `${target}.sha256`);
  }

  const first = assets[0]!;
  const manifest = {
    format: MANIFEST_FORMAT,
    tag,
    createdAt: new Date().toISOString(),
    minServerVersion: values.get('--min-server-version') ?? null,
    hostContract: await readHost(),
    generation: {
      binaryVersion: first.binaryVersion,
      upstreamVersion: first.upstreamVersion,
      sourceCommit: first.sourceCommit,
      composition: first.composition,
      dependencyLock: first.dependencyLock,
    },
    assets,
  };
  const manifestFile = path.join(staging, 'manifest.json');

  await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  uploaded.push(manifestFile);

  if (flags.has('--dry-run')) {
    // Dry-run останавливается на готовом staging: локально видно всё, что опубликует gh.
    process.stdout.write(`Dry-run ${tag}: staging ${staging}\n`);

    for (const file of uploaded) {
      process.stdout.write(`  ${path.basename(file)}\n`);
    }

    process.stdout.write(`  gh release create ${tag} ${prerelease ? '--prerelease ' : ''}${assets.map((asset) => asset.file).join(' ')}\n`);

    return;
  }

  const notes = values.get('--notes') ? path.resolve(values.get('--notes')!) : null;
  const ghArgs = ['release', 'create', tag, '--title', tag];

  if (prerelease) {
    ghArgs.push('--prerelease');
  }

  ghArgs.push(...(notes ? ['--notes-file', notes] : ['--generate-notes']));

  // Перевешанный тег (rc пересобирается) оставляет прежний Release: он заменяется целиком,
  // чтобы active assets всегда соответствовали коммиту тега.
  const existing = await command('gh', ['release', 'view', tag, '--json', 'tagName']).then((code) => code === 0,
    () => false);

  if (existing) {
    await ensureCode(await command('gh', ['release', 'delete', tag, '--yes']), 'замена прежнего Release');
  }

  await ensureCode(await command('gh', ghArgs), 'создание GitHub Release');
  await ensureCode(await command('gh', ['release', 'upload', tag, ...uploaded, '--clobber']), 'загрузка активов');
  process.stdout.write(`Опубликован ${tag}: ${uploaded.length} файлов из ${staging}\n`);
}

/**
 * Публикация npm-пакета идёт локально, как и допуск GLM: токен берётся из ~/.npmrc
 * человека, в CI секретов нет. Staging копирует npm/ с версией тега, npm pack
 * собирает tarball, prerelease уходит с dist-tag next.
 */
async function publishNpm({ values, flags }: Parsed): Promise<void> {
  const tag = required(values, '--tag');
  const version = npmVersionFromTag(tag);
  const distTag = isPrereleaseVersion(version) ? 'next' : 'latest';
  const registry = values.get('--registry');
  const assets = await assertReleaseDownloadable(tag);
  const staging = path.join(cacheHome(values), 'release', tag, 'npm');

  await stageNpmPackage({
    source: path.join(ROOT, 'npm'),
    staging,
    version,
    license: path.join(ROOT, 'LICENSE'),
  });

  process.stdout.write(`Релиз ${tag}: ${assets.join(', ')}\n`
    + `Пакет ${NPM_PACKAGE_NAME}@${version} → ${distTag}\n`);

  await ensureCode(await command('npm', ['pack', '--pack-destination', staging], staging), 'npm pack');

  const tarball = (await fs.readdir(staging)).find((name) => name.endsWith('.tgz'));

  if (!tarball) {
    throw new Error('npm pack не создал tarball');
  }

  const publish = ['publish', path.join(staging, tarball), '--access', 'public', '--tag', distTag,
    ...(registry ? ['--registry', registry] : [])];

  if (flags.has('--dry-run')) {
    process.stdout.write(`Dry-run. Команда публикации:\n  npm ${publish.join(' ')}\n`);

    return;
  }

  await ensureCode(await command('npm', publish), 'npm publish');
  process.stdout.write(`Опубликован ${NPM_PACKAGE_NAME}@${version} (${distTag}).\n`
    + `Проверка: npx -y ${NPM_PACKAGE_NAME}@${version} --version\n`);
}

async function prune({ values }: Parsed): Promise<void> {
  const args = ['--cache-dir', nodeCachePath(cacheHome(values))];

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
  await runSteps([
    ['Проверка типов', async () => {
      await ensureCode(await command('npm', ['run', '-s', 'typecheck']), 'typecheck');
    }],
    ['Проверка границ импортов', async () => {
      await ensureCode(await script('checkImports.mts'), 'границы импортов');
    }],
    ['Тесты со сторожем памяти', async () => {
      await ensureCode(await script('test.mts'), 'тесты');
    }],
  ]);
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
      flags: ['--prerelease', '--sidecar', '--dry-run'],
    },
    run: release,
  },
  'publish-npm': {
    spec: { values: ['--tag', '--registry', '--cache-dir'], flags: ['--dry-run'] },
    run: publishNpm,
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

/**
 * Терминальное меню и явные команды используют один разбор и общие проверки.
 * Вызов с перенаправленным вводом или выводом сохраняет текстовую справку.
 */
async function runCommand(argv: string[]): Promise<void> {
  const [name, ...rest] = argv;

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

/**
 * Явные build и check в терминале получают экран стадий, как и пункты меню.
 * Дочерняя команда с журналом вместо TTY проходит сюда только один раз.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const interactive = process.stdin.isTTY && process.stdout.isTTY;

  if (argv.length === 0 && interactive) {
    process.exitCode = await runCliMenu(ENTRY, runCommand);

    return;
  }

  const showProgress = interactive && process.stderr.isTTY && process.env.TERM !== 'dumb';

  if (showProgress && (argv[0] === 'build' || argv[0] === 'check')) {
    const title = argv[0] === 'build' ? 'Сборка поставки' : 'Проверка проекта';

    process.exitCode = await runCliAction(ENTRY, argv, title);

    return;
  }

  await runCommand(argv);
}

await main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
});

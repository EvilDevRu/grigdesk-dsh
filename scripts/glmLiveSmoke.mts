// Живой smoke режима GLM напрямую через автономный ELF, без серверного chat-модуля GrigDesk.
// Запускает человек, когда режим выбран и ключ лежит в .env. Скрипт не печатает ключ, держит
// число ходов сценарием, пишет очищенный отчёт в артефакты кэша grigdesk-dsh и удаляет временные
// homes. `--admit` записывает допуск в compatibility/glm.json только после полностью успешного
// сценария: допуск становится входом сборки и попадает в metadata следующего ELF.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { decodeDeepSeekRuntimeInfo } from '../lib/chat/deepSeekBinary.ts';
import type { DeepSeekRuntimeInfo } from '../lib/chat/deepSeekBinary.ts';
import { glmCompatibilityIdentity, parseGlmAccessMode } from '../lib/glm/contract.ts';
import type { GlmAccessMode } from '../lib/glm/contract.ts';
import { DEFAULT_HOST_CONTRACT, hostGlmRevisions, readHostContract } from '../lib/glm/hostContract.ts';
import { buildGlmChildEnv, resolveGlmRouteKey, systemPassthroughEnv } from '../lib/glm/env.ts';
import { buildGlmSmokeProfile } from '../lib/glm/profile.ts';
import { dshArtifactsPath, dshCacheHome } from '../lib/runtime/dshHome.ts';
import { DshWebClient } from '../lib/web/client.ts';
import { openDshStream } from '../lib/web/events.ts';
import type { DshEventSource } from '../lib/web/events.ts';
import { startDshWeb } from '../lib/web/runtime.ts';
import { runGlmTurn } from '../lib/web/turn.ts';
import type { GlmTurnResult } from '../lib/web/turn.ts';
import { writeGlmSmokeAdmission } from './glmSmokeAdmission.mts';
import {
  cleanGlmSmokeDiagnostic, glmSmokeSecrets, readGlmSmokeHttpErrors, writeGlmSmokeHttpObserver,
} from './glmSmokeDiagnostics.mts';

const run = promisify(execFile);
const COMPATIBILITY_FILE = fileURLToPath(new URL('../compatibility/glm.json', import.meta.url));
const USAGE = 'Использование: node scripts/glmLiveSmoke.mts --binary <абсолютный ELF> '
  + '--mode api|coding-plan [--host-contract <файл>] [--model glm-5.3-flash] [--admit] '
  + '[--cache-dir <абсолютный>] [--force]';

// Потолок ходов сценария: живая проверка не должна расходовать квоту сверх нужного.
export const GLM_SMOKE_MAX_TURNS = 4;
// Дешёвая flash-модель по умолчанию: живой допуск проверяет конвейер, а не флагманские модели.
const DEFAULT_MODEL = 'glm-5.3-flash';

export interface GlmSmokeStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface GlmSmokeReport {
  kind: 'live';
  mode: GlmAccessMode;
  compatibility: string;
  packageId: string;
  model: string;
  turns: number;
  ok: boolean;
  steps: GlmSmokeStep[];
  modelErrors: { httpStatus: number | null; errorText: string }[];
}

export interface SmokeArguments {
  binary: string;
  mode: GlmAccessMode;
  hostContract: string;
  model: string;
  admit: boolean;
  force: boolean;
  cacheDir: string;
}

const VALUE_FLAGS = new Set(['--binary', '--mode', '--host-contract', '--model', '--cache-dir']);
const BOOLEAN_FLAGS = new Set(['--admit', '--force']);

/**
 * Разбирает аргументы командной строки до любых эффектов. Ключи и прочие секреты argv
 * не принимает; неизвестный флаг, отсутствие значения или относительный путь — отказ.
 */
export function parseSmokeArguments(argv: readonly string[]): SmokeArguments {
  const values = new Map<string, string>();
  const booleans = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;

    if (VALUE_FLAGS.has(flag)) {
      const value = argv[index + 1];

      if (values.has(flag) || value === undefined || value.startsWith('--')) {
        throw new Error(USAGE);
      }

      values.set(flag, value);
      index += 1;
    } else if (BOOLEAN_FLAGS.has(flag)) {
      if (booleans.has(flag)) {
        throw new Error(USAGE);
      }

      booleans.add(flag);
    } else {
      throw new Error(USAGE);
    }
  }

  const binary = values.get('--binary') ?? '';
  const mode = parseGlmAccessMode(values.get('--mode'));

  if (!binary || !path.isAbsolute(binary) || !mode) {
    throw new Error(USAGE);
  }

  const cacheDir = values.get('--cache-dir') || path.join(dshCacheHome(), 'smoke-cache');

  if (!path.isAbsolute(cacheDir)) {
    throw new Error('--cache-dir должен быть абсолютным путём');
  }

  const model = values.get('--model') || DEFAULT_MODEL;

  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(model)) {
    throw new Error('--model должен быть именем модели без пробелов и спецсимволов');
  }

  return {
    binary,
    mode,
    hostContract: values.get('--host-contract') || DEFAULT_HOST_CONTRACT,
    model,
    admit: booleans.has('--admit'),
    force: booleans.has('--force'),
    cacheDir,
  };
}

/**
 * Metadata кандидата читается отдельным процессом в allowlist-окружении без ключа:
 * launcher сверяет payload и отдаёт входы GLM, по которым считается identity допуска.
 */
export async function probeRuntimeInfo(binary: string): Promise<DeepSeekRuntimeInfo> {
  const { stdout } = await run(binary, ['--runtime-info', '--json'], {
    timeout: 60_000,
    maxBuffer: 1 << 20,
    env: { ...systemPassthroughEnv(process.env), DSH_TELEMETRY_DISABLED: '1', NO_COLOR: '1' },
  });

  return decodeDeepSeekRuntimeInfo(JSON.parse(stdout));
}

/**
 * Ключи читаются из первого существующего файла: явный GRIGDESK_DSH_ENV_FILE, затем .env
 * текущего каталога, затем общий ~/.grigdesk/.env установки GrigDesk. loadEnvFile не перекрывает
 * уже заданные переменные, поэтому экспортированное значение всегда важнее файла.
 * Явный путь, который не существует, — ошибка, а не молчаливый переход к общему файлу.
 */
export async function loadKeyEnvironment(env: NodeJS.ProcessEnv): Promise<string | null> {
  const explicit = env.GRIGDESK_DSH_ENV_FILE?.trim();
  const local = path.resolve('.env');
  const shared = path.join(os.homedir(), '.grigdesk', '.env');

  const exists = async (file: string) => await fs.stat(file).then(() => true, () => false);
  let file: string | null = null;

  if (explicit) {
    if (!await exists(explicit)) {
      throw new Error(`GRIGDESK_DSH_ENV_FILE указывает на отсутствующий файл: ${explicit}`);
    }

    file = explicit;
  } else if (await exists(local)) {
    file = local;
  } else if (await exists(shared)) {
    file = shared;
  }

  if (file) {
    process.loadEnvFile(file);
  }

  return file;
}

/**
 * Очищенный текст для отчёта: временные пути заменены, длина ограничена.
 * Известные секреты вырезаются до ограничения длины, включая ошибки провайдера.
 */
function clean(value: unknown, root: string, secrets: readonly string[]): string {
  return cleanGlmSmokeDiagnostic(value, secrets, [root, os.homedir()]).slice(0, 400);
}

async function readMarker(project: string): Promise<string> {
  return (await fs.readFile(path.join(project, 'marker.txt'), 'utf8').catch(() => '')).trim();
}

/**
 * Сценарий живой проверки: ответ после чтения marker.txt, правка файла по инструкции и
 * resume-вопрос о прежнем маркере в той же сессии. Подтверждения инструментов закрывает ход.
 * Возвращает шаги отчёта; каждый шаг ограничен потолком ходов, чтобы квота не сгорела.
 */
async function runScenario(options: {
  client: DshWebClient;
  events: { follow: DshEventSource; remote: DshEventSource };
  sessionId: string;
  project: string;
  secrets: readonly string[];
  root: string;
}): Promise<{ steps: GlmSmokeStep[]; turns: number }> {
  const marker = await readMarker(options.project);
  const steps: GlmSmokeStep[] = [];
  let turns = 0;

  const step = (name: string, ok: boolean, detail: unknown) => {
    steps.push({ name, ok, detail: clean(detail, options.root, options.secrets) });
  };

  /**
   * Один ход сессии; результат относится к отчёту целиком, события в stdout не печатаются.
   */
  const turn = async (text: string): Promise<GlmTurnResult> => {
    turns += 1;

    if (turns > GLM_SMOKE_MAX_TURNS) {
      throw new Error('Превышен потолок ходов живой проверки');
    }

    return runGlmTurn({
      client: options.client,
      events: options.events,
      sessionId: options.sessionId,
      text,
    });
  };

  const read = await turn('Прочитай файл marker.txt в рабочей папке и ответь только его содержимым: '
    + 'одним словом-маркером, без пояснений.');
  const readOk = read.ok && read.replyText.includes(marker);

  step('ответ после чтения marker.txt', readOk, read.detail || read.replyText);

  if (!read.ok) {
    return { steps, turns };
  }

  const edit = await turn(`Замени в файле marker.txt маркер на тот же текст с суффиксом -EDITED `
    + `(то есть ${marker}-EDITED) и сохрани файл с завершающим переводом строки. Коротко подтверди.`);
  const edited = await readMarker(options.project);

  step('правка marker.txt по инструкции', edit.ok && edited.includes(`${marker}-EDITED`),
    edit.detail || edited || edit.replyText);

  const memory = await turn('Какой маркер был в файле marker.txt до твоей правки? '
    + 'Ответь только исходным маркером, без пояснений.');
  const remembered = memory.replyText.includes(marker) && !memory.replyText.includes(`${marker}-EDITED`);

  step('resume: исходный маркер в памяти', memory.ok && remembered, memory.detail || memory.replyText);

  return { steps, turns };
}

interface SmokeRunOptions extends SmokeArguments {
  info: DeepSeekRuntimeInfo;
  compatibility: string;
}

/**
 * Один запуск сценария: home и project во временном каталоге, профиль, процесс ELF, сессия
 * и ходы. Отчёт пишется до очистки; ошибка запуска или сценария также попадает в шаги.
 */
async function runSmoke(options: SmokeRunOptions): Promise<GlmSmokeReport> {
  const artifacts = path.join(dshArtifactsPath(), 'glm');

  await fs.mkdir(artifacts, { recursive: true, mode: 0o700 });

  const root = await fs.mkdtemp(path.join(artifacts, 'work-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const marker = `GLM-SMOKE-${randomUUID().slice(0, 8)}`;
  const secrets = glmSmokeSecrets(process.env);
  let steps: GlmSmokeStep[] = [];
  let turns = 0;

  try {
    await fs.mkdir(home, { mode: 0o700 });
    await fs.mkdir(project, { mode: 0o700 });
    await fs.mkdir(path.join(project, '.git'), { mode: 0o700 });
    await fs.writeFile(path.join(project, 'marker.txt'), `${marker}\n`, { mode: 0o600 });
    await fs.writeFile(
      path.join(home, '.grigdesk-runtime.json'),
      JSON.stringify({ format: 1, provider: 'glm' }),
      { mode: 0o600, flag: 'wx' },
    );

    const routeKey = resolveGlmRouteKey(options.mode, process.env);
    const env = buildGlmChildEnv(process.env, { dshHome: home, routeKey });
    const observer = await writeGlmSmokeHttpObserver(home);
    const profile = await buildGlmSmokeProfile({
      cwd: project,
      home,
      mode: options.mode,
      model: options.model,
      launchId: randomUUID(),
      observer: observer.plugin,
    });
    const server = await startDshWeb({
      binary: options.binary,
      packageId: options.info.packageId,
      cacheDir: options.cacheDir,
      overlayPath: profile.overlayPath,
      cwd: project,
      env,
    });
    let follow: DshEventSource | undefined;
    let remote: DshEventSource | undefined;

    try {
      const sessionId = await server.client.createSession(project);

      await server.client.selectModel(sessionId, 'zai', options.model);

      follow = openDshStream({
        client: server.client,
        endpoint: 'session/follow',
        args: { request: { address: { kind: 'session', sessionId }, assistantStream: true } },
      });
      remote = openDshStream({ client: server.client, endpoint: '$events' });

      const scenario = await runScenario({
        client: server.client,
        events: { follow, remote },
        sessionId,
        project,
        secrets,
        root,
      });

      steps = scenario.steps;
      turns = scenario.turns;
    } finally {
      follow?.close();
      remote?.close();
      await server.stop().catch(() => {});
    }

    const modelErrors = await readGlmSmokeHttpErrors(observer.file, process.env, root);

    steps.push({
      name: 'ошибки модельного HTTP за сценарий',
      ok: modelErrors.length === 0,
      detail: clean(JSON.stringify(modelErrors), root, secrets),
    });

    return {
      kind: 'live',
      mode: options.mode,
      compatibility: options.compatibility,
      packageId: options.info.packageId,
      model: options.model,
      turns,
      ok: steps.every((item) => item.ok),
      steps,
      modelErrors,
    };
  } catch (error) {
    const detail = clean((error as Error).message, root, secrets);

    steps = [...steps, { name: 'сценарий', ok: false, detail }];

    return {
      kind: 'live',
      mode: options.mode,
      compatibility: options.compatibility,
      packageId: options.info.packageId,
      model: options.model,
      turns,
      ok: false,
      steps,
      modelErrors: [],
    };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

/**
 * Точка входа человека: binary и mode обязательны. Отчёт пишется в артефакты кэша grigdesk-dsh;
 * код выхода 0 — успех, 1 — отказ сценария или запуска, 2 — неверные аргументы.
 * `--admit` дописывает допуск только после полностью успешного сценария.
 */
async function main(): Promise<void> {
  let args: SmokeArguments;

  try {
    args = parseSmokeArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 2;

    return;
  }

  try {
    const info = await probeRuntimeInfo(args.binary);
    const host = await readHostContract(args.hostContract);
    const plugin = info.glm.inputs.llmPiAi;

    if (!info.capabilities.web) {
      throw new Error('Поставка не объявляет capability web: живой smoke недоступен');
    }

    if (!plugin) {
      throw new Error('Поставка не содержит плагин GLM (llm-pi-ai): живой smoke недоступен');
    }

    const compatibility = glmCompatibilityIdentity(
      { ...info.glm.inputs, llmPiAi: plugin },
      args.mode,
      hostGlmRevisions(host),
    );
    const admitted = info.glm.admission.some((entry) => entry.mode === args.mode
      && entry.compatibility === compatibility);

    if (admitted && !args.force) {
      process.stdout.write(`Допуск уже записан: ${args.mode} ${compatibility}\n`);
      process.exitCode = 0;

      return;
    }

    const envFile = await loadKeyEnvironment(process.env);

    process.stdout.write(`Ключи: ${envFile ?? 'только окружение процесса'}\n`);

    const report = await runSmoke({ ...args, info, compatibility });
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
    const file = path.join(dshArtifactsPath(), 'glm', `smoke-${args.mode}-${stamp}.json`);

    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });

    for (const item of report.steps) {
      process.stdout.write(`${item.ok ? 'ok  ' : 'FAIL'} ${item.name}: ${item.detail}\n`);
    }

    process.stdout.write(`${report.ok ? 'OK' : 'FAIL'} ${file}\n`);
    process.exitCode = report.ok ? 0 : 1;

    if (report.ok && args.admit) {
      await writeGlmSmokeAdmission(COMPATIBILITY_FILE, {
        mode: args.mode,
        compatibility: report.compatibility,
      });
      process.stdout.write(`ADMIT ${args.mode} ${report.compatibility}\n`);
      process.stdout.write('Допуск стал входом сборки: пересоберите поставку и опубликуйте выпуск, '
        + 'чтобы новый ELF нёс допуск в metadata.\n');
    }
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { buildGlmRoute, GLM_ROUTE_KEY_ENV, selectGlmServiceKey } from '../../lib/glm/contract.ts';
import { workerEnvironment } from './worker.ts';

export type ChatProvider = 'deepseek' | 'glm' | 'qwen';
export type ChatMode = 'read-only' | 'workspace-write';

export interface ChatOptions {
  help: boolean;
  provider?: ChatProvider;
  mode?: ChatMode;
  cwd: string;
  model?: string;
  effort?: string;
  resume?: string;
  last: boolean;
  glmMode?: 'api' | 'coding-plan';
  writableRoots?: readonly string[];
  schedule?: boolean;
  qwenService?: 'model-studio' | 'token-plan';
}

export interface ChatProfile {
  args: string[];
  env: NodeJS.ProcessEnv;
  credential: string;
  cleanup(): Promise<void>;
}

export const chatHelp = `DeepSeek Harness · терминальный чат

  deepseek chat [-p deepseek|glm|qwen] [-C каталог] [-m модель] [--effort уровень]
                [--mode read-only|workspace-write] [--resume ID | --last]
                [--glm-mode api|coding-plan] [--qwen-service model-studio|token-plan]
                [--add-dir каталог ...] [--schedule]

Подключения: DEEPSEEK_API_KEY, ZAI_API_KEY / ZAI_CODING_API_KEY, QWEN_API_KEY.
Qwen: QWEN_BASE_URL задаёт свой адрес, QWEN_MODELS — список моделей через запятую.
Команды чата: /model, /effort, /resume, /status, /help, /exit.`;

/**
 * Разбираем только аргументы терминального подрежима. Флаги штатного launcher
 * и ACP проходят прежним путём и никогда не интерпретируются этим разбором.
 */
export function parseChatOptions(args: string[], cwd = process.cwd()): ChatOptions {
  const cliOptions = {
    help: { type: 'boolean', short: 'h' },
    provider: { type: 'string', short: 'p' },
    cd: { type: 'string', short: 'C' },
    model: { type: 'string', short: 'm' },
    effort: { type: 'string' },
    'add-dir': { type: 'string', multiple: true },
    schedule: { type: 'boolean' },
    mode: { type: 'string' },
    resume: { type: 'string' },
    last: { type: 'boolean' },
    'glm-mode': { type: 'string' },
    'qwen-service': { type: 'string' },
  } as const;
  let values;

  try {
    ({ values } = parseArgs({ args, options: cliOptions }));
  } catch {
    throw new Error('Некорректные аргументы чата. Справка доступна через deepseek chat --help.');
  }

  const { provider, mode, resume, model, effort } = values;
  const glmMode = values['glm-mode'];
  const qwenService = values['qwen-service'];

  if (provider !== undefined && provider !== 'deepseek' && provider !== 'glm' && provider !== 'qwen') {
    throw new Error('Выберите поставщика модели: deepseek, glm или qwen.');
  }

  if (mode !== undefined && mode !== 'read-only' && mode !== 'workspace-write') {
    throw new Error('Выберите режим доступа: read-only или workspace-write.');
  }

  if (glmMode !== undefined && (glmMode !== 'api' && glmMode !== 'coding-plan'
    || provider && provider !== 'glm')) {
    throw new Error('--glm-mode применяется к GLM и принимает api или coding-plan.');
  }

  if (qwenService !== undefined && (qwenService !== 'model-studio' && qwenService !== 'token-plan'
    || provider && provider !== 'qwen')) {
    throw new Error('--qwen-service применяется к Qwen и принимает model-studio или token-plan.');
  }

  if (resume !== undefined && (!resume.trim() || values.last)) {
    throw new Error('Укажите один способ продолжения: --resume ID или --last.');
  }

  if (glmMode && qwenService) {
    throw new Error('Укажите параметры только одного поставщика.');
  }

  if (model?.trim() === '' || effort?.trim() === '') {
    throw new Error('Значения --model и --effort должны быть непустыми.');
  }

  return {
    help: values.help ?? false,
    provider: provider ?? (glmMode ? 'glm' : qwenService ? 'qwen' : undefined),
    mode, resume, model, effort, glmMode, qwenService,
    writableRoots: values['add-dir']?.map((directory) => path.resolve(cwd, values.cd ?? '.', directory)),
    schedule: values.schedule,
    cwd: path.resolve(cwd, values.cd ?? '.'),
    last: values.last ?? false,
  };
}

/**
 * Настроенный пользователем адрес может быть HTTPS или локальным тестовым HTTP.
 * Имя пользователя, пароль и параметры в URL к модельному API не относятся.
 */
function qwenBaseUrl(configured: string): URL {
  const url = new URL(configured);
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);

  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash) {
    throw new Error('QWEN_BASE_URL требует HTTPS или HTTP на loopback без учётных данных и параметров.');
  }

  return url;
}

/**
 * Список из настроек позволяет использовать сервисы без /models. При discovery
 * ключ уходит только на выбранный адрес: редиректы отклоняются.
 */
async function qwenModels(
  base: URL, key: string, model: string | undefined, signal: AbortSignal,
): Promise<string[]> {
  const valid = (value: unknown): value is string => typeof value === 'string' && /^[\w.\-:/]+$/u.test(value);
  const manual = process.env.QWEN_MODELS?.split(',').map((entry) => entry.trim()).filter(Boolean);

  if (manual?.length) {
    if (manual.some((model) => !valid(model))) {
      throw new Error('QWEN_MODELS содержит недопустимое имя модели.');
    }

    return [...new Set(manual)];
  }

  if (model !== undefined) {
    if (!valid(model)) {
      throw new Error('Укажите корректный ID модели Qwen.');
    }

    return [model];
  }

  try {
    const url = new URL(base);
    url.pathname = `${url.pathname.replace(/\/+$/u, '')}/models`;
    const response = await fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      redirect: 'error',
      headers: { Authorization: `Bearer ${key}` },
    });

    if (response.ok) {
      const body: unknown = await response.json();
      const family = /^(?:qwen|qwq|qvq)(?:[\d./-]|$)/iu;
      const nonChat = /(?:^|[._/-])(?:asr|tts|embedding|rerank(?:er)?|image|video|speech)(?:[._/-]|$)/iu;
      const models = body && typeof body === 'object' && 'data' in body && Array.isArray(body.data)
        ? body.data.flatMap((entry: unknown) => (entry && typeof entry === 'object' && 'id' in entry
          && valid(entry.id) && family.test(entry.id) && !nonChat.test(entry.id)
          ? [entry.id] : [])) : [];

      if (models.length) {
        return [...new Set(models)].sort();
      }
    }
  } catch {
    signal.throwIfAborted();
  }

  throw new Error('Не получен каталог Qwen. Проверьте доступ или задайте QWEN_MODELS либо --model.');
}

/**
 * Строки, которые без аккаунта DeepSeek либо ждут его сервис, либо запускают
 * фоновые ходы через штатный маршрут. Список совпадает с модельным маршрутом GrigDesk.
 */
const deepseekOnlyRows = [
  'llm-deepseek', 'llm-deepseek-account', 'session-title-llm', 'web-search-deepseek',
  'schedule', 'goal-round-driver', 'tool-jobs', 'tool-workflow', 'workflow-worker-thread',
  'subagent-spawn-in-process', 'subagent-fork-in-process',
];

/**
 * Терминал принимает только физические каталоги. Весь home и файловый корень
 * нельзя подключить как дополнительную область записи.
 */
async function terminalWritableRoots(options: ChatOptions, mode: ChatMode): Promise<string[]> {
  if (!options.writableRoots?.length) {
    return [];
  }
  if (mode !== 'workspace-write') {
    throw new Error('--add-dir требует режим workspace-write.');
  }

  const home = await realpath(os.homedir());
  const roots = await Promise.all(options.writableRoots.map(async (directory) => {
    const root = await realpath(directory);

    if (root === home || root === path.parse(root).root || !(await stat(root)).isDirectory()) {
      throw new Error('--add-dir требует конкретную рабочую папку.');
    }

    return root;
  }));

  return [...new Set(roots)].sort();
}

/**
 * GLM использует штатный каталог zai и отдельный ключ поиска. Native jobs и
 * цели хранят состояние в private home текущего подключения и режима доступа.
 */
function glmChatRows(env: NodeJS.ProcessEnv, mode: ChatMode, schedule: boolean): unknown[] {
  const searchKey = process.env.GRIGDESK_GLM_SEARCH_API_KEY?.trim();

  if (searchKey) {
    env.GRIGDESK_GLM_SEARCH_API_KEY = searchKey;
  }

  return [
    ...['llm-deepseek', 'llm-deepseek-account', 'session-title-llm']
      .map((id) => ({ id, disabled: true })),
    { id: 'web', config: { searchProvider: 'deepseek-official', fetchProvider: 'http' } },
    { id: 'web-search-deepseek', disabled: !searchKey, config: { apiKeyEnv: 'GRIGDESK_GLM_SEARCH_API_KEY' } },
    { id: 'tool-web', config: { search: Boolean(searchKey), fetch: true } },
    { id: 'goal', config: { defaultMaxGoalRounds: 16 } },
    { id: 'tool-subagent-control', config: { interrupt: true } },
    ...['spawn', 'fork'].map((provider) => ({
      id: provider === 'spawn' ? 'tool-subagent' : 'tool-subagent-fork',
      config: {
        provider,
        toolName: provider === 'spawn' ? 'subagent' : 'subagent_fork',
        modelSelection: provider === 'spawn',
        modelDiscovery: provider === 'spawn',
        maxDepth: 3,
        grigdeskForeground: true,
        grigdeskBackground: true,
      },
    })),
    ...(mode === 'read-only' ? [{ id: 'tool-workflow', disabled: true }] : []),
    { insert: [
      { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
      { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
      ...(mode === 'workspace-write' ? [{
        id: 'tool-ralph', name: '@deepseek-ai/dsh-tool-ralph', config: { maxRounds: 16 },
      }] : []),
      ...(schedule ? [
        { id: 'schedule', name: '@deepseek-ai/dsh-schedule' },
        { id: 'tool-schedule', name: '@deepseek-ai/dsh-tool-schedule' },
      ] : []),
    ] },
  ];
}

/**
 * Передаём движку один комплект ключей и отдельное состояние терминального чата.
 * Ключ остаётся в окружении процесса. Во временный профиль попадают только ссылки на переменные.
 * Loader заменяет config строки целиком, поэтому таблица presets повторяет штатную.
 */
export async function createChatProfile(
  options: ChatOptions,
  provider: ChatProvider,
  mode: ChatMode,
  signal: AbortSignal,
): Promise<ChatProfile> {
  const writableRoots = await terminalWritableRoots(options, mode);
  const schedule = options.schedule === true;

  if (schedule && (provider !== 'glm' || mode !== 'workspace-write')) {
    throw new Error('--schedule требует профиль GLM workspace-write.');
  }

  const patches: unknown[] = [
    { id: 'sandbox-policy', config: { mode, workspaceRoot: options.cwd, additionalWritableRoots: writableRoots } },
    { id: 'approval', config: { policy: 'ask' } },
    { id: 'permission', config: {
      presets: {
        'read-only': { sandbox: 'read-only', approval: 'ask' },
        'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
        'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
      },
      defaultPreset: mode,
    } },
  ];
  const ambient = [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR',
    'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy',
  ];
  const env = workerEnvironment(Object.fromEntries(ambient.map((name) => [name, process.env[name]])));
  env.DSH_TELEMETRY_DISABLED = '1';
  let route: string = provider;
  let credential: string;

  if (provider === 'deepseek') {
    credential = process.env.DEEPSEEK_API_KEY ?? '';

    if (!credential) {
      throw new Error('Для DeepSeek задайте DEEPSEEK_API_KEY.');
    }

    env.DEEPSEEK_API_KEY = credential;
  } else {
    let id: string;
    let model: string;
    let config: Record<string, unknown>;

    if (provider === 'glm') {
      const access = options.glmMode ?? (process.env.ZAI_API_KEY || !process.env.ZAI_CODING_API_KEY
        ? 'api' : 'coding-plan');
      credential = selectGlmServiceKey(access, process.env) ?? '';

      if (!credential) {
        throw new Error(access === 'api' ? 'Для API GLM задайте ZAI_API_KEY.'
          : 'Для GLM Coding Plan задайте ZAI_CODING_API_KEY.');
      }

      env[GLM_ROUTE_KEY_ENV] = credential;
      env.GRIGDESK_DSH_TERMINAL_CHAT = '1';
      id = 'zai';
      route = `glm-${access}`;
      model = 'glm-5.3-flash';
      config = buildGlmRoute(access);
      const localModelApi = process.env.GRIGDESK_DSH_GLM_LOOPBACK_URL;

      if (localModelApi) {
        const url = qwenBaseUrl(localModelApi);

        if (!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) {
          throw new Error('GRIGDESK_DSH_GLM_LOOPBACK_URL требует адрес loopback.');
        }

        config.baseURL = url.href.replace(/\/+$/u, '');
        route += '-' + createHash('sha256').update(url.href).digest('hex').slice(0, 16);
      }
    } else {
      credential = process.env.QWEN_API_KEY ?? '';

      if (!credential) {
        throw new Error('Для Qwen задайте QWEN_API_KEY.');
      }

      const base = qwenBaseUrl(process.env.QWEN_BASE_URL ?? (options.qwenService === 'token-plan'
        ? 'https://token-plan.maas.qwencloudapi.com/compatible-mode/v1'
        : 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'));
      const models = await qwenModels(base, credential, options.model, signal);
      env.QWEN_API_KEY = credential;
      id = 'qwen';
      route = `qwen-${createHash('sha256').update(base.href).digest('hex').slice(0, 16)}`;
      model = models[0]!;
      config = {
        api: 'openai-completions', baseURL: base.href.replace(/\/+$/u, ''), apiKeyEnv: 'QWEN_API_KEY',
        displayName: 'Qwen',
        models: models.map((modelId) => ({ id: modelId, contextWindow: 32768, maxTokens: 8192 })),
      };
    }

    const rows = provider === 'glm'
      ? glmChatRows(env, mode, schedule) : deepseekOnlyRows.map((id) => ({ id, disabled: true }));

    patches.push(...rows,
      { id: 'acp', config: { provider: id, model } },
      { insert: [{
        id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { [id]: config } },
      }] });
  }

  // Данные терминального чата живут в своём каталоге пользователя, как у Claude Code
  // (~/.claude): сессии по подключению и режиму доступа, отдельно от переписки GrigDesk.
  const root = process.env.GRIGDESK_DEEPSEEK_HOME ?? path.join(os.homedir(), '.deepseek');

  if (!path.isAbsolute(root)) {
    throw new Error('GRIGDESK_DEEPSEEK_HOME требует абсолютный путь.');
  }

  const scope = writableRoots.length || schedule
    ? createHash('sha256').update(JSON.stringify([schedule ? await realpath(options.cwd) : null, writableRoots]))
      .digest('hex').slice(0, 16) : undefined;
  const home = path.join(root, 'cli', route, mode, ...scope ? [scope] : []);
  env.DSH_HOME = home;
  await mkdir(home, { recursive: true, mode: 0o700 });
  const details = await stat(home);
  const uid = process.getuid?.();

  if ((details.mode & 0o077) !== 0 || (uid !== undefined && details.uid !== uid)) {
    throw new Error('Каталог сессий должен быть доступен только текущему пользователю.');
  }

  const launch = await mkdtemp(path.join(await realpath(home), 'launch-'));
  const overlay = path.join(launch, 'profile.yml');

  try {
    await writeFile(overlay, JSON.stringify(patches), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    await rm(launch, { recursive: true, force: true });
    throw error;
  }

  return {
    args: ['--profile', 'acp', '--patch', overlay],
    env,
    credential,
    cleanup: () => rm(launch, { recursive: true, force: true }),
  };
}

import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, sep } from 'node:path';

import { openChatAcp, record, type AcpPeer } from './chatAcp.ts';
import type { Style } from './tui/palette.ts';
import type { Tool, ToolBlock } from './tui/screen.ts';
import { clean } from './tui/text.ts';
import { createTuiView, type TuiView } from './tui/view.ts';
import {
  chatHelp, createChatProfile, type ChatMode, type ChatOptions, type ChatProvider,
} from './chatProfile.ts';
import { checkChatUpdate, type UpdateTarget } from './updateCheck.ts';

interface Choice<Value extends string = string> {
  value: Value;
  name: string;
}

interface ConfigChoice {
  current?: string;
  choices: Choice[];
}

interface TrackedTool {
  event: Record<string, unknown>;
  block: ToolBlock;
}

const abortOutcome = { outcome: { outcome: 'cancelled' } };
const providerChoices: Choice<ChatProvider>[] = [
  { value: 'deepseek', name: 'DeepSeek' },
  { value: 'glm', name: 'GLM (Z.ai)' },
  { value: 'qwen', name: 'Qwen' },
];
const modeChoices: Choice<ChatMode>[] = [
  { value: 'workspace-write', name: 'Запись в рабочей папке' }, { value: 'read-only', name: 'Только чтение' },
];

/**
 * Сокращение домашнего пути применяется только в футере. Проверка границы
 * каталога сохраняет абсолютный путь для соседней папки с похожим именем.
 */
function displayDirectory(cwd: string): string {
  const fromHome = relative(homedir(), cwd);

  return fromHome === '' ? '~'
    : isAbsolute(fromHome) || fromHome === '..' || fromHome.startsWith('..' + sep) ? cwd
    : '~' + sep + fromHome;
}

/**
 * Harness поставляет текст результата в ACP content. Для других форм ACP
 * сохраняем текстовый rawOutput, когда содержимое не имеет текстовой части.
 */
function toolDisplay(event: Record<string, unknown>, safe: (text: string) => string): Tool {
  const input = record(event.rawInput);
  const name = typeof event.title === 'string' ? event.title : 'Инструмент';
  const shell = event.kind === 'execute' || name === 'bash';
  const command = shell && typeof input.command === 'string' ? input.command : '';
  const content = Array.isArray(event.content) ? event.content.map(record).flatMap((item) => {
    const { text } = record(item.content);

    return typeof text === 'string' ? [text] : [];
  }).join('\n') : '';
  const output = content || (typeof event.rawOutput === 'string'
    ? event.rawOutput : event.rawOutput == null ? '' : JSON.stringify(event.rawOutput, null, 2));

  return {
    name: safe(name),
    command: safe(command),
    status: typeof event.status === 'string' ? event.status : '',
    output: safe(output),
  };
}

/**
 * Время считается по монотонным часам и показывает только целые секунды.
 * Минуты появляются, когда ход длится достаточно долго.
 */
function turnDuration(elapsed: number): string {
  const seconds = Math.floor(elapsed / 1000);
  const minutes = Math.floor(seconds / 60);

  return `${minutes ? `${minutes}м ` : ''}${seconds % 60}с`;
}

/**
 * Список получает очищенные имена. Esc сохраняет текущее значение настройки,
 * а для первого запуска позволяет выйти до подключения к провайдеру.
 */
async function pick<Value extends string>(
  view: TuiView, title: string, choices: readonly Choice<Value>[], current?: Value,
): Promise<Value | undefined> {
  return await view.pick(title, choices.map((item) => ({ ...item, name: clean(item.name) })), current);
}

/**
 * Harness отдаёт плоские параметры рассуждения и сгруппированные провайдером
 * модели. Для выбора сохраняем исходные значения ACP, для флагов — имена моделей.
 */
function configChoice(config: unknown, id: string): ConfigChoice {
  const option = Array.isArray(config) ? config.map(record).find((item) => item.id === id) : undefined;
  const choices = Array.isArray(option?.options) ? option.options.map(record).flatMap((item) => (
    Array.isArray(item.options) ? item.options.map(record) : [item]
  )) : [];

  return {
    current: typeof option?.currentValue === 'string' ? option.currentValue : undefined,
    choices: choices.flatMap(({ value, name }) => typeof value === 'string'
      ? [{ value, name: typeof name === 'string' ? name : value }] : []),
  };
}

/**
 * Значение модели в ACP содержит пару провайдер/модель. Пользовательский флаг
 * также принимает привычный короткий ID без фигурных скобок и префикса.
 */
function modelId(value: string): string {
  if (value.startsWith('[')) {
    try {
      const pair: unknown = JSON.parse(value);

      if (Array.isArray(pair) && typeof pair[1] === 'string') {
        return pair[1];
      }
    } catch {
      return value;
    }
  }

  return value;
}

/**
 * Терминал управляет вводом и подтверждениями, а ACP владеет сессиями, каталогом
 * и ходами. Завершение ввода закрывает дочерний процесс и временный профиль.
 */
export async function runTerminalChat(
  options: ChatOptions, launcher: string[], updateTarget?: UpdateTarget,
): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Для deepseek chat откройте интерактивный терминал.');
  }

  let view: TuiView;
  const stop = new AbortController();
  let exitCode = 0;
  let turn: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let peer: AcpPeer | undefined;
  let sessionId: string | undefined;
  let config: unknown;
  let approvalQueue: Promise<unknown> = Promise.resolve();
  let credential = '';
  let failure: string | undefined;
  const tools = new Map<string, Map<string, TrackedTool>>();
  const tasks = new Map<string, string>();

  // Ключ не должен попасть в транскрипт и в сообщение об ошибке, которое пишет сам терминал.
  const safe = (value: string) => clean(credential ? value.replaceAll(credential, '[ключ скрыт]') : value);
  const print = (value: string, style?: Style, literal?: boolean) => view.print(safe(value), style, literal);
  const ask = (question: string, signal = stop.signal, style?: Style) =>
    view.ask(question, AbortSignal.any([stop.signal, signal]), style);

  /**
   * Ctrl+C отменяет активный ход. Повторное прерывание или истечение срока
   * отмены закрывает соединение, чтобы следующий запрос не попал в старый ход.
   */
  function interrupt(): void {
    if (turn && !turn.signal.aborted && peer && sessionId) {
      turn.abort();
      peer.notify('session/cancel', { sessionId });
      timer = setTimeout(() => {
        exitCode = 130;
        stop.abort();
      }, 5000);
      return;
    }

    exitCode = 130;
    stop.abort();
  }

  const terminate = () => {
    exitCode = 143;
    stop.abort();
  };
  process.on('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  view = createTuiView({
    stdin: process.stdin, stdout: process.stdout, signal: stop.signal, onInterrupt: interrupt,
    title: 'Терминальный чат',
  });

  if (updateTarget && !options.noUpdateCheck) {
    void checkChatUpdate(updateTarget, stop.signal, view.updateNotice);
  }

  try {
    options = { ...options, cwd: await realpath(options.cwd) };
    const provider = options.provider ?? await pick(view, 'Поставщик модели', providerChoices);

    if (!provider) {
      return 0;
    }

    const mode = options.mode ?? await pick(view, 'Доступ к файлам', modeChoices);

    if (!mode) {
      return 0;
    }

    if (provider === 'glm' && !options.glmMode && process.env.ZAI_API_KEY && process.env.ZAI_CODING_API_KEY) {
      options.glmMode = await pick(view, 'Подключение GLM', [
        { value: 'api', name: 'Z.ai API' },
        { value: 'coding-plan', name: 'Z.ai Coding Plan' },
      ] as const);
      if (!options.glmMode) {
        return 0;
      }
    }

    if (provider === 'qwen' && !options.qwenService && !process.env.QWEN_BASE_URL) {
      options.qwenService = await pick(view, 'Подключение Qwen', [
        { value: 'model-studio', name: 'Alibaba Model Studio' },
        { value: 'token-plan', name: 'QwenCloud Token Plan' },
      ] as const);
      if (!options.qwenService) {
        return 0;
      }
    }

    const profile = await createChatProfile(options, provider, mode, stop.signal);
    credential = profile.credential;
    const connection = providerChoices.find(({ value }) => value === provider)!.name;
    const access = modeChoices.find(({ value }) => value === mode)!.name;

    /**
     * Футер берёт модель и уровень рассуждения из текущей конфигурации ACP.
     * Команда статуса дополнительно показывает название подключения.
     */
    function updateStatus(): string {
      const model = configChoice(config, 'model').current;
      const effort = configChoice(config, 'reasoning_effort').current;
      const title = [connection, model && modelId(model), effort].filter(Boolean).join(' · ');

      view.status({
        model: safe(model ? modelId(model) : connection),
        effort: effort ? safe(effort) : undefined,
        directory: safe(displayDirectory(options.cwd)),
      });

      return title;
    }

    try {
      stop.signal.throwIfAborted();
      updateStatus();
      view.busy('Подключение…');
      const client = openChatAcp({
        command: process.execPath, args: [...launcher, ...profile.args], cwd: options.cwd, env: profile.env,
        update: ({ sessionId: incoming, update: payload }) => {
          if (typeof incoming !== 'string' || incoming !== sessionId) {
            return;
          }

          const update = record(payload);
          const content = record(update.content);

          if (update.sessionUpdate === 'config_option_update') {
            config = update.configOptions;
            updateStatus();
          } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
            const id = update.toolCallId;

            if (typeof id !== 'string') {
              return;
            }

            const tracked = tools.get(incoming) ?? new Map<string, TrackedTool>();
            tools.set(incoming, tracked);
            const previous = tracked.get(id);
            // Частичное обновление дополняет исходные аргументы для запроса разрешения.
            const event = { ...previous?.event, ...update };
            const block = view.tool(toolDisplay(event, safe), previous?.block);

            tracked.set(id, { event, block });
          } else if (update.sessionUpdate === 'agent_message_chunk' && typeof content.text === 'string') {
            const messageId = typeof update.messageId === 'string' ? update.messageId : undefined;

            view.stream(safe(content.text), messageId);
          } else if (update.sessionUpdate === 'user_message_chunk'
            && !turn && typeof content.text === 'string') {
            // Собственный запрос уже показан при отправке. Здесь отображается история при resume.
            print(content.text, 'user');
            const task = safe(content.text.trim().split('\n')[0] ?? '');

            tasks.set(incoming, task);
            view.task(task);
          }
        },
        child: (params) => {
          if (params.sessionId === sessionId) {
            print(`· ${String(params.name)} · ${String(params.status)}\n${String(params.text ?? '')}`, 'dim');
          }
        },
        question: (params) => {
          const current = turn;
          const pending = approvalQueue.then(async () => {
            if (!current || current.signal.aborted || params.sessionId !== sessionId
              || !Array.isArray(params.questions)) {
              return { answers: [] };
            }

            const answers = [];

            for (const item of params.questions) {
              const question = record(item);
              const choices = Array.isArray(question.options) ? question.options.map(record) : [];

              print(String(question.question ?? ''), 'accent');
              if (question.detail) {
                print(`${String(question.detail)}\n`);
              }
              if (choices.length) {
                print(choices.map((choice, index) => `${index + 1}. ${String(choice.label)}`).join('\n'));
              }

              const response = (await ask('Ответ › ', current.signal)).trim();
              const choice = /^\d+$/u.test(response) ? choices[Number(response) - 1] : undefined;
              answers.push({
                id: question.id,
                selected: choice ? [choice.label] : [],
                ...!choice && response ? { custom: response } : {},
              });
            }

            return { answers };
          });
          approvalQueue = pending.catch(() => {});

          return pending;
        },
        approve: (params) => {
          const currentTurn = turn;
          const answer = approvalQueue.then(async () => {
            if (!currentTurn || currentTurn !== turn || currentTurn.signal.aborted
              || params.sessionId !== sessionId) {
              return abortOutcome;
            }

            const options = Array.isArray(params.options) ? params.options.map(record) : [];
            const allow = options.find(({ kind }) => kind === 'allow_once');
            const reject = options.find(({ kind }) => kind === 'reject_once');
            let approved = false;

            if (mode === 'workspace-write' && typeof allow?.optionId === 'string') {
              const detail = record(params.toolCall);
              const tool = typeof detail.toolCallId === 'string' && sessionId
                ? tools.get(sessionId)?.get(detail.toolCallId)?.event : undefined;
              const args = detail.rawInput ?? tool?.rawInput;
              print(`Запрос разрешения · ${String(detail.title ?? tool?.title ?? 'инструмент')}`, 'warning');

              if (args !== undefined) {
                print(JSON.stringify(args, null, 2).slice(0, 4000), 'normal', true);
              }

              const confirmation = await ask('Разрешить один раз? [y/N] › ', currentTurn.signal, 'warning');
              approved = /^(y|д|да)$/iu.test(confirmation.trim());
            }

            const id = approved ? allow?.optionId : reject?.optionId;

            return typeof id === 'string' ? { outcome: { outcome: 'selected', optionId: id } } : abortOutcome;
          });

          approvalQueue = answer.catch(() => abortOutcome);

          return answer;
        },
      });
      peer = client;
      const close = () => void client.close();
      stop.signal.addEventListener('abort', close, { once: true });

      try {
        const init = await client.request('initialize', {
          protocolVersion: 1, clientCapabilities: {},
        }, 90000);

        if (init.protocolVersion !== 1) {
          throw new Error('Harness вернул неподдерживаемую версию ACP.');
        }

        const workspace = { cwd: options.cwd, mcpServers: [] };

        /**
         * Продолжение выбирает только сессии этой рабочей папки. При отказе
         * открыть другую сессию текущая привязка и её параметры сохраняются.
         */
        async function resume(id: string): Promise<void> {
          const previous = sessionId;
          const previousConfig = config;
          sessionId = id;

          try {
            const resumed = await client.request('session/resume', { ...workspace, sessionId: id });
            config = resumed.configOptions;
          } catch (error) {
            sessionId = previous;
            config = previousConfig;
            view.task(previous ? tasks.get(previous) ?? '' : '');
            throw error;
          }

          if (previous && previous !== id) {
            await client.request('session/close', { sessionId: previous }, 5000);
            tools.delete(previous);
          }

          view.task(tasks.get(id) ?? '');
          view.note('Сессия продолжена.');
        }

        /**
         * Каталог параметров принадлежит Harness. После смены модели он заново
         * сообщает допустимые уровни рассуждения и выбранное значение.
         */
        async function selectConfig(id: string, label: string, requested?: string): Promise<string> {
          const { current, choices } = configChoice(config, id);

          if (choices.length === 0) {
            throw new Error(`Harness не предоставил настройку «${label}» для этой сессии.`);
          }

          const value = requested !== undefined ? choices.find((item) => item.value === requested
            || item.name === requested || id === 'model' && modelId(item.value) === requested)?.value
            : await pick(view, label, choices, current);

          if (value === undefined && requested !== undefined) {
            throw new Error(`Недоступное значение «${requested}» для настройки «${label}».`);
          }

          if (value !== undefined && value !== current) {
            const next = await client.request('session/set_config_option', {
              sessionId, configId: id, value,
            });
            config = next.configOptions;
          }

          const selected = configChoice(config, id).current;

          updateStatus();

          return id === 'model' && selected ? modelId(selected) : selected ?? 'по умолчанию';
        }

        const availableSessions = async () => {
          const { sessions } = await client.request('session/list', { cwd: options.cwd });

          return Array.isArray(sessions) ? sessions.map(record).flatMap(({ sessionId }) => (
            typeof sessionId === 'string' ? [{ value: sessionId, name: sessionId }] : []
          )) : [];
        };

        if (options.last || options.resume) {
          const target = options.resume ?? (await availableSessions())[0]?.value;

          if (!target) {
            throw new Error('Для этой папки, поставщика и режима пока нет сессий.');
          }

          await resume(target);
        } else {
          const created = await client.request('session/new', workspace, 90000);

          if (typeof created.sessionId !== 'string' || !created.sessionId) {
            throw new Error('Harness не вернул идентификатор сессии.');
          }

          sessionId = created.sessionId;
          config = created.configOptions;
        }

        if (options.model) {
          await selectConfig('model', 'Модель', options.model);
        } else if (!options.resume && !options.last && configChoice(config, 'model').choices.length > 1) {
          await selectConfig('model', 'Модель');
        }

        if (options.effort) {
          await selectConfig('reasoning_effort', 'Уровень рассуждения', options.effort);
        }

        if (options.schedule) {
          await client.request('_grigdesk/terminal/ready', { sessionId });
        }

        updateStatus();
        view.busy(null);
        view.note(access);

        while (!stop.signal.aborted) {
          const value = (await ask('')).trim();
          const [command, ...rest] = value.split(/\s+/u);
          const arg = rest.join(' ') || undefined;

          try {
            switch (command) {
              case '':
                break;
              case '/exit':
                return 0;
              case '/model':
                print(`Модель · ${await selectConfig('model', 'Модель', arg)}`);
                break;
              case '/effort': {
                const effort = await selectConfig('reasoning_effort', 'Уровень рассуждения', arg);

                print(`Уровень рассуждения · ${effort}`);
                break;
              }
              case '/status':
                print(`${updateStatus()}\n${access} · ${options.cwd}\nСессия ${sessionId}`);
                break;
              case '/help':
                print(`${chatHelp}\n`);
                break;
              case '/resume': {
                const choices = arg ? [] : await availableSessions();

                if (!arg && choices.length === 0) {
                  print('Для этой папки пока нет других сохранённых сессий.\n');
                  break;
                }

                const target = arg ?? await pick(view, 'Продолжить сессию', choices);

                if (target && target !== sessionId) {
                  await resume(target);
                  if (options.schedule) {
                    await client.request('_grigdesk/terminal/ready', { sessionId });
                  }
                  updateStatus();
                }

                break;
              }
              default: {
                let prompt = value;

                if (provider === 'glm' && (command === '/plan' || command === '/goal')) {
                  const line = command === '/plan' && arg !== 'off' ? '/plan' : value;
                  const result = await client.request('_grigdesk/terminal/command', { sessionId, line });

                  print(`${String(result.text ?? '')}\n`);
                  if (result.kind !== 'success' || command === '/goal' || !arg || arg === 'off') {
                    break;
                  }

                  prompt = arg;
                }

                turn = new AbortController();
                const started = performance.now();
                const task = safe(prompt.split('\n')[0] ?? '');

                if (sessionId) {
                  tasks.set(sessionId, task);
                }

                view.task(task);
                view.busy('Ответ модели…');

                try {
                  await client.request('session/prompt', {
                    sessionId, prompt: [{ type: 'text', text: prompt }],
                  }, 0);

                  if (!turn.signal.aborted) {
                    view.note(`Готово · ${turnDuration(performance.now() - started)}`);
                  }
                } finally {
                  view.busy(null);

                  if (turn.signal.aborted) {
                    print('Ход отменён.', 'warning');
                  }

                  turn.abort();
                  turn = undefined;
                  clearTimeout(timer);
                }
              }
            }
          } catch (error) {
            if (!stop.signal.aborted) {
              print((error as Error).message, 'error', true);
            }
          }
        }
      } finally {
        stop.signal.removeEventListener('abort', close);
        await client.close();
        peer = undefined;
      }
    } finally {
      await profile.cleanup();
    }
  } catch (error) {
    if (!stop.signal.aborted) {
      // Кадр TUI после close уже не рисуется: ошибку терминал покажет после восстановления экрана.
      failure = safe(`Ошибка чата · ${(error as Error).message}`);
      return 1;
    }
  } finally {
    clearTimeout(timer);
    view.close(failure);
    stop.abort();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }

  return exitCode;
}

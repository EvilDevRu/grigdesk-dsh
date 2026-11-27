import { realpath } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';

import { openChatAcp, record, type AcpPeer } from './chatAcp.ts';
import { createTuiView, type TuiView } from './tui/view.ts';
import {
  chatHelp, createChatProfile, type ChatMode, type ChatOptions, type ChatProvider,
} from './chatProfile.ts';

interface Choice<Value extends string = string> {
  value: Value;
  name: string;
}

interface ConfigChoice {
  current?: string;
  choices: Choice[];
}

type Ask = (prompt: string, signal?: AbortSignal) => Promise<string>;

const abortOutcome = { outcome: { outcome: 'cancelled' } };
const providerChoices: Choice<ChatProvider>[] = [
  { value: 'deepseek', name: 'DeepSeek' },
  { value: 'glm', name: 'GLM (Z.ai)' },
  { value: 'qwen', name: 'Qwen' },
];
const modeChoices: Choice<ChatMode>[] = [
  { value: 'workspace-write', name: 'Запись в рабочей папке' }, { value: 'read-only', name: 'Только чтение' },
];

function terminalText(value: string): string {
  return stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, '');
}

/**
 * Список получает очищенные имена. Esc сохраняет текущее значение настройки,
 * а для первого запуска позволяет выйти до подключения к провайдеру.
 */
async function pick<Value extends string>(
  view: TuiView, title: string, choices: readonly Choice<Value>[], current?: Value,
): Promise<Value | undefined> {
  return await view.pick(title, choices.map((item) => ({ ...item, name: terminalText(item.name) })), current);
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
export async function runTerminalChat(options: ChatOptions, launcher: string[]): Promise<number> {
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
  const tools = new Map<unknown, Record<string, unknown>>();

  // Ключ не должен попасть в транскрипт и в сообщение об ошибке, которое пишет сам терминал.
  const safe = (value: string) => terminalText(credential
    ? value.replaceAll(credential, '[ключ скрыт]') : value);
  const print = (value: string) => view.print(safe(value));
  const ask: Ask = (question, signal = stop.signal) =>
    view.ask(question, AbortSignal.any([stop.signal, signal]));

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
     * Заголовок обновляется по фактической конфигурации сессии после
     * подключения, смены параметров и продолжения сохранённого диалога.
     */
    function updateHeader(): string {
      const model = configChoice(config, 'model').current;
      const effort = configChoice(config, 'reasoning_effort').current;
      const title = [connection, model && modelId(model), effort].filter(Boolean).join(' · ');

      view.status(safe(title));

      return title;
    }

    try {
      stop.signal.throwIfAborted();
      updateHeader();
      view.busy('Подключение…');
      const client = openChatAcp({
        command: process.execPath, args: [...launcher, ...profile.args], cwd: options.cwd, env: profile.env,
        update: ({ sessionId: incoming, update: payload }) => {
          if (incoming !== sessionId) {
            return;
          }

          const update = record(payload);
          const content = record(update.content);

          if (update.sessionUpdate === 'config_option_update') {
            config = update.configOptions;
            updateHeader();
          } else if (update.sessionUpdate === 'tool_call') {
            tools.set(update.toolCallId, update);
            print(`\n· ${String(update.title ?? 'Инструмент')}\n`);
          } else if (update.sessionUpdate === 'tool_call_update' && tools.has(update.toolCallId)) {
            // Исходный rawInput нужен для показа запроса разрешения: обновление статуса его дополняет.
            tools.set(update.toolCallId, { ...tools.get(update.toolCallId), ...update });
            if (update.status === 'completed' || update.status === 'failed') {
              view.amend(update.status === 'completed' ? '  ✓' : '  ✗ ошибка');
            }
          } else if (update.sessionUpdate === 'agent_message_chunk' && typeof content.text === 'string') {
            view.stream(safe(content.text));
          } else if (update.sessionUpdate === 'user_message_chunk'
            && !turn && typeof content.text === 'string') {
            // Собственный запрос уже показан при отправке. Здесь отображается история при resume.
            print(`\nВы › ${content.text}\n`);
          }
        },
        child: (params) => {
          if (params.sessionId === sessionId) {
            print(`\n· ${String(params.name)} · ${String(params.status)}\n${String(params.text ?? '')}\n`);
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

              print(`\n${String(question.question ?? '')}\n`);
              if (question.detail) {
                print(`${String(question.detail)}\n`);
              }
              for (const [index, choice] of choices.entries()) {
                print(`${index + 1}. ${String(choice.label)}\n`);
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
              const tool = tools.get(detail.toolCallId);
              const args = detail.rawInput ?? tool?.rawInput;
              print(`\nЗапрос разрешения · ${String(detail.title ?? tool?.title ?? 'инструмент')}\n`);

              if (args !== undefined) {
                print(`${JSON.stringify(args, null, 2).slice(0, 4000)}\n`);
              }

              const confirmation = await ask('Разрешить один раз? [y/N] › ', currentTurn.signal);
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
            throw error;
          }

          if (previous && previous !== id) {
            await client.request('session/close', { sessionId: previous }, 5000);
          }

          print('\nСессия продолжена.\n');
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

          updateHeader();

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

        updateHeader();
        view.busy(null);
        view.note(safe(`${access} · ${options.cwd}`));

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
              case '/effort':
                print(
                  `Уровень рассуждения · ${await selectConfig('reasoning_effort', 'Уровень рассуждения', arg)}`,
                );
                break;
              case '/status':
                print(`${updateHeader()}\n${access} · ${options.cwd}\nСессия ${sessionId}`);
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
                  updateHeader();
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
                tools.clear();
                view.busy('Ответ модели…');
                print('');

                try {
                  await client.request('session/prompt', {
                    sessionId, prompt: [{ type: 'text', text: prompt }],
                  }, 0);
                } finally {
                  view.busy(null);
                  print(turn.signal.aborted ? 'Ход отменён.' : '');
                  turn.abort();
                  turn = undefined;
                  clearTimeout(timer);
                }
              }
            }
          } catch (error) {
            if (!stop.signal.aborted) {
              print(`${(error as Error).message}\n`);
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
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }

  return exitCode;
}

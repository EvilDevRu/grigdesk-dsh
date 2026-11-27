import { on } from 'node:events';
import path from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';

import { dshCacheHome } from '../lib/runtime/dshHome.ts';

interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
}

interface Terminal {
  read: () => Promise<{ text: string; key: Key }>;
  draw: (render: () => string) => void;
  redraw: () => void;
}

interface Choice<Value extends string> {
  value: Value;
  label: string;
  description?: string;
}

class MenuExit extends Error {
  readonly code: number;

  constructor(code: number) {
    super('Работа меню завершена');
    this.code = code;
  }
}

const actions = [
  {
    value: 'build',
    label: 'Собрать поставку',
    description: 'Подготовить зависимости, собрать и проверить ELF.',
  },
  {
    value: 'verify',
    label: 'Проверить ELF',
    description: 'Проверить метаданные и содержимое готовой поставки.',
  },
  {
    value: 'install',
    label: 'Установить ELF',
    description: 'Установить поставку с резервом прежней версии.',
  },
  {
    value: 'admit',
    label: 'Проверить допуск GLM',
    description: 'Запустить живую проверку через выбранный API Z.ai.',
  },
  {
    value: 'release',
    label: 'Подготовить релиз',
    description: 'Подготовить файлы релиза или опубликовать их на GitHub.',
  },
  {
    value: 'check',
    label: 'Проверить проект',
    description: 'Проверить типы, границы импортов и прогнать тесты.',
  },
  { value: 'prune', label: 'Очистить кэш', description: 'Удалить старые сборки и резервные копии.' },
  { value: 'help', label: 'Справка', description: 'Посмотреть команды CLI и доступные параметры.' },
  { value: 'exit', label: 'Выход' },
] as const;

type Action = typeof actions[number]['value'];

/**
 * Меню временно владеет терминалом. Перед командой и при любом выходе возвращаем
 * обычный ввод, видимый курсор и основной экран с исходным содержимым.
 */
async function terminalSession<T>(screen: boolean, run: (terminal: Terminal) => Promise<T>): Promise<T> {
  const { stdin, stdout } = process;
  const raw = stdin.isRaw;
  const flowing = stdin.readableFlowing;
  const alternate = screen && process.env.TERM !== 'dumb';
  const stop = new AbortController();
  const interrupt = () => stop.abort(130);
  const terminate = () => stop.abort(143);
  let render: (() => string) | undefined;

  /**
   * Перерисовка использует текущий размер окна. Простой терминал получает только текст.
   * Полный экран занимает один кадр, а результаты команд сохраняются в основной прокрутке.
   */
  function redraw(): void {
    if (render) {
      stdout.write(`${alternate ? '\x1b[H\x1b[J' : '\n'}${render()}\n`);
    }
  }

  emitKeypressEvents(stdin);
  const keys = on(stdin, 'keypress', { signal: stop.signal, close: ['end', 'close'] });
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  stdout.on('resize', redraw);

  try {
    stdin.setRawMode(true);
    stdin.resume();

    if (alternate) {
      stdout.write('\x1b[?1049h\x1b[?25l');
    }

    return await run({
      read: async () => {
        const next = await keys.next();

        if (stop.signal.aborted) {
          throw new MenuExit(stop.signal.reason as number);
        }

        const [text = '', key = {}] = (next.value ?? []) as [string?, Key?];

        if (key.ctrl && key.name === 'c') {
          throw new MenuExit(130);
        }

        if (next.done || key.ctrl && key.name === 'd') {
          throw new MenuExit(0);
        }

        return { text, key };
      },
      draw: (next) => {
        render = next;
        redraw();
      },
      redraw,
    });
  } catch (error) {
    if (stop.signal.aborted) {
      throw new MenuExit(stop.signal.reason as number);
    }

    throw error;
  } finally {
    await keys.return?.();
    stdin.setRawMode(raw);

    if (!flowing) {
      stdin.pause();
    }

    stdout.off('resize', redraw);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);

    if (alternate) {
      stdout.write('\x1b[?25h\x1b[?1049l');
    }
  }
}

/**
 * Обрезаем строки по ширине окна и убираем управляющие символы из введённых путей.
 * Маркер выбранной строки остаётся виден и при отключённом цвете.
 */
function frame(title: string, rows: string[], footer: string, selected = -1): string {
  const width = Math.max(1, Math.min(76, (process.stdout.columns || 80) - 1));
  const color = process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';
  const rule = '─'.repeat(width);
  const lines = ['GrigDesk · DeepSeek Harness', rule, title, ...rows, rule, footer];

  return lines.map((line, index) => {
    const visible = [...stripVTControlCharacters(line).replace(/\p{Cc}/gu, '')].slice(0, width).join('');

    if (color && index === selected + 3 && selected >= 0) {
      return `\x1b[48;2;41;59;67m\x1b[1;96m${visible.padEnd(width)}\x1b[0m`;
    }

    return color && index === 0 ? `\x1b[1;96m${visible}\x1b[0m` : visible;
  }).join('\n');
}

/**
 * Стрелки и Home/End перемещают выбор. Короткое окно прокручивает список вслед
 * за выбранным пунктом и сохраняет его описание под списком.
 */
async function choose<Value extends string>(
  terminal: Terminal,
  title: string,
  items: readonly Choice<Value>[],
  initialValue?: NoInfer<Value>,
): Promise<Value | undefined> {
  let selected = Math.max(0, items.findIndex(({ value }) => value === initialValue));
  terminal.draw(() => {
    const count = Math.max(1, (process.stdout.rows || 24) - 8);
    const start = Math.min(Math.max(0, selected - count + 1), Math.max(0, items.length - count));
    const rows = items.slice(start, start + count).map(({ label }, index) => (
      `${index + start === selected ? '›' : ' '} ${label}`
    ));

    rows.push('', items[selected]!.description ?? '');

    return frame(title, rows, '↑↓ Выбор    Enter Дальше    Esc Назад', selected - start);
  });

  while (true) {
    const { key } = await terminal.read();

    switch (key.name) {
      case 'up':
        selected = (selected + items.length - 1) % items.length;
        break;
      case 'down':
        selected = (selected + 1) % items.length;
        break;
      case 'home':
        selected = 0;
        break;
      case 'end':
        selected = items.length - 1;
        break;
      case 'return':
      case 'enter':
        return items[selected]!.value;
      case 'escape':
        return undefined;
      default:
        continue;
    }

    terminal.redraw();
  }
}

/**
 * Путь вводится целиком, включая пробелы. Пустой Enter принимает предложенное
 * значение, а Esc отменяет действие до передачи каких-либо аргументов команде.
 */
async function ask(
  terminal: Terminal,
  title: string,
  options: { preset?: string; optional?: boolean } = {},
): Promise<string | undefined> {
  let value = '';
  const hint = options.preset ? `Пустой Enter — ${options.preset}` : '';
  terminal.draw(() => {
    const width = Math.max(1, Math.min(72, (process.stdout.columns || 80) - 5));
    const visible = [...value].slice(-width).join('');

    return frame(title, [`› ${visible}▏`, hint], 'Enter Дальше    Esc Назад', 0);
  });

  while (true) {
    const { text, key } = await terminal.read();

    if (key.name === 'escape') {
      return undefined;
    }

    if (key.name === 'return' || key.name === 'enter') {
      if (value.trim() || options.preset !== undefined || options.optional) {
        return value.trim() ? value : options.preset ?? '';
      }
    } else if (key.name === 'backspace') {
      value = [...value].slice(0, -1).join('');
    } else if (key.ctrl && key.name === 'u') {
      value = '';
    } else if (text && !key.ctrl && !key.meta && !/\p{Cc}/u.test(text)) {
      value += text;
    } else {
      continue;
    }

    terminal.redraw();
  }
}

/**
 * Релиз принимает все платформенные ELF и поддерживает sidecar. По умолчанию
 * файлы только готовятся локально, публикация и замена требуют явного выбора.
 */
async function releaseArgs(terminal: Terminal, binary: string): Promise<string[] | undefined> {
  const tag = await ask(terminal, 'Тег релиза (vX.Y.Z или vX.Y.Z-rc.N)');

  if (tag === undefined) {
    return;
  }

  const first = await ask(terminal, 'Путь к первому ELF', { preset: binary });

  if (first === undefined) {
    return;
  }

  const args = ['release', '--tag', tag, '--sidecar', '--binary', first];

  while (true) {
    const next = await ask(terminal, 'Следующий ELF (пустой Enter — продолжить)', { optional: true });

    if (next === undefined) {
      return;
    }

    if (next === '') {
      break;
    }

    args.push('--binary', next);
  }

  const kind = await choose(terminal, 'Тип релиза', [
    { value: 'prerelease', label: 'Предварительный релиз' },
    { value: 'stable', label: 'Стабильный релиз с допуском GLM' },
  ]);

  if (kind === undefined) {
    return;
  }

  const destination = await choose(terminal, `Релиз ${tag}`, [
    { value: 'local', label: 'Только подготовить файлы' },
    {
      value: 'github',
      label: 'Опубликовать на GitHub',
      description: 'Существующий релиз тега будет заменён.',
    },
  ]);

  if (destination === undefined) {
    return;
  }

  const kindFlags = kind === 'prerelease' ? ['--prerelease'] : [];
  const destinationFlags = destination === 'local' ? ['--dry-run'] : [];

  return [...args, ...kindFlags, ...destinationFlags];
}

/**
 * Меню собирает только аргументы уже существующих команд. Отмена остаётся внутри
 * меню, а проверка файлов, допусков и запуск операций принадлежат диспетчеру CLI.
 */
async function actionArgs(terminal: Terminal, name: Exclude<Action, 'exit'>): Promise<string[] | undefined> {
  if (name === 'build' || name === 'check' || name === 'help') {
    return [name];
  }

  if (name === 'prune') {
    const selected = await choose(terminal, 'Очистить кэш?', [
      { value: 'cancel', label: 'Отмена' },
      {
        value: 'prune',
        label: 'Очистить',
        description: 'Сохраняются две последние сборки и две резервные копии.',
      },
    ]);

    return selected === 'prune' ? [name] : undefined;
  }

  const defaultBinary = path.join(dshCacheHome(), 'out', 'deepseek');

  if (name === 'release') {
    return releaseArgs(terminal, defaultBinary);
  }

  const binary = await ask(terminal, 'Путь к ELF', { preset: defaultBinary });

  if (binary === undefined) {
    return;
  }

  const args = [name, '--binary', binary];

  if (name === 'verify') {
    return args;
  }

  if (name === 'install') {
    const target = await ask(terminal, 'Путь установки ELF');

    return target === undefined ? undefined : [...args, '--target', target];
  }

  const mode = await choose(terminal, 'Доступ GLM', [
    { value: 'api', label: 'Обычный API Z.ai' },
    { value: 'coding-plan', label: 'Z.ai Coding Plan' },
  ]);

  if (mode === undefined) {
    return;
  }

  const selected = await choose(terminal, 'Живая проверка расходует квоту Z.ai', [
    { value: 'cancel', label: 'Отмена' },
    { value: 'smoke', label: 'Проверить без записи' },
    { value: 'admit', label: 'Проверить и записать допуск' },
  ]);

  if (selected === 'smoke' || selected === 'admit') {
    const flags = selected === 'admit' ? ['--admit'] : [];

    return [...args, '--mode', mode, ...flags];
  }
}

/**
 * Цикл отдаёт терминал обычной команде, дожидается чтения результата и возвращает
 * меню. Открытие меню само по себе не запускает сборку, проверку или публикацию.
 */
export async function runCliMenu(dispatch: (argv: string[]) => Promise<void>): Promise<number> {
  let current: Action | undefined;

  try {
    while (true) {
      const args = await terminalSession(true, async (terminal) => {
        let argv: string[] | undefined;

        while (argv === undefined) {
          const name = await choose(terminal, 'Меню поставки', actions, current);

          if (name === undefined || name === 'exit') {
            throw new MenuExit(0);
          }

          current = name;
          argv = await actionArgs(terminal, name);
        }

        return argv;
      });

      try {
        await dispatch(args);
      } catch (error) {
        process.stderr.write(`${(error as Error).message}\n`);
      }

      await terminalSession(false, async (terminal) => {
        process.stdout.write('\nEnter или Esc — вернуться в меню.\n');

        while (true) {
          const { key } = await terminal.read();

          if (key.name === 'return' || key.name === 'enter' || key.name === 'escape') {
            return;
          }
        }
      });
    }
  } catch (error) {
    if (error instanceof MenuExit) {
      return error.code;
    }

    throw error;
  }
}

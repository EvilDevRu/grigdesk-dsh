import path from 'node:path';

import { dshCacheHome } from '../lib/runtime/dshHome.ts';
import { runCliAction } from './cliProgress.mts';
import { screenFrame, wrapText } from './cliScreen.mts';
import type { ScreenRow } from './cliScreen.mts';
import { MenuExit, terminalSession } from './cliTerminal.mts';
import type { Terminal } from './cliTerminal.mts';

interface Choice<Value extends string> {
  value: Value;
  label: string;
  description: string;
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
    value: 'publish-npm',
    label: 'Опубликовать npm-пакет',
    description: 'Собрать @grigdesk/deepseek версии готового релиза и опубликовать в npm.',
  },
  {
    value: 'check',
    label: 'Проверить проект',
    description: 'Проверить типы, границы импортов и прогнать тесты.',
  },
  { value: 'prune', label: 'Очистить кэш', description: 'Удалить старые сборки и резервные копии.' },
  { value: 'help', label: 'Справка', description: 'Посмотреть команды CLI и доступные параметры.' },
  { value: 'exit', label: 'Выход', description: 'Закрыть меню и вернуться в оболочку.' },
] as const;

type Action = typeof actions[number]['value'];

/**
 * Клавиши и указатель меняют один выбор. Координаты мыши относятся только к видимым
 * строкам списка, а подсказка остаётся под ним и при уменьшении окна.
 */
async function choose<Value extends string>(
  terminal: Terminal,
  title: string,
  items: readonly Choice<Value>[],
  initialValue?: NoInfer<Value>,
): Promise<Value | undefined> {
  let selected = Math.max(0, items.findIndex(({ value }) => value === initialValue));
  let start = 0;
  let firstRow = 0;
  let shown = 0;
  let right = 0;
  const mouse = process.env.TERM !== 'dumb';

  try {
    terminal.draw(() => {
      const frame = screenFrame(title);
      const navigation = frame.width >= 42 && mouse ? '↑↓ Выбор   Enter / клик Открыть   Esc Назад'
        : frame.width >= 27 ? '↑↓ Выбор   Enter   Esc' : '↑↓  Enter  Esc';
      const help = frame.capacity >= 5;
      const detail = items.map(({ description }) => wrapText(description, frame.width));
      const reserved = Math.min(Math.max(...detail.map((lines) => lines.length)),
        Math.max(0, frame.capacity - (help ? 4 : 1)));
      const count = Math.max(1, frame.capacity - reserved - (help ? 3 : 0));

      start = Math.max(0, Math.min(start, selected, items.length - count));
      start = Math.max(start, selected - count + 1);
      firstRow = frame.firstRow;
      right = frame.gutter * 2 + frame.width;

      const rows = items.slice(start, start + count).map(({ label }, index): ScreenRow => ({
        text: `${index + start === selected ? '›' : ' '} ${label}`,
        selected: index + start === selected,
      }));
      shown = rows.length;

      const footer: ScreenRow[] = [];

      if (help) {
        footer.push({ text: '' });
      }

      for (let index = 0; index < reserved; index++) {
        footer.push({ text: detail[selected]![index] ?? '', tone: 'muted' });
      }

      if (help) {
        footer.push(frame.rule, { text: navigation, tone: 'muted' });
      }

      return frame.render(rows, footer);
    });
    terminal.trackPointer(true);

    while (true) {
      const { key } = await terminal.read();
      const pointer = key.pointer;

      if (pointer) {
        const row = pointer.row - firstRow;

        if (pointer.column < 1 || pointer.column > right) {
          continue;
        }

        if (pointer.action === 'up' || pointer.action === 'down') {
          const delta = pointer.action === 'up' ? -1 : 1;

          selected = Math.max(0, Math.min(items.length - 1, selected + delta));
          terminal.redraw();
          continue;
        }

        if (row < 0 || row >= shown) {
          continue;
        }

        if (pointer.action === 'press') {
          return items[start + row]!.value;
        }

        if (selected !== start + row) {
          selected = start + row;
          terminal.redraw();
        }

        continue;
      }

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
  } finally {
    terminal.trackPointer(false);
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
    const frame = screenFrame(title);
    const width = Math.max(1, frame.width - 3);
    const visible = [...value].slice(-width).join('');
    const preset = hint ? wrapText(hint, frame.width).slice(0, Math.max(0, frame.capacity - 3)) : [];

    return frame.render([
      { text: `› ${visible}▏`, selected: true },
      ...preset.map((text): ScreenRow => ({ text, tone: 'muted' })),
    ], [frame.rule, { text: 'Enter Дальше   Esc Назад', tone: 'muted' }]);
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
 * Публикация npm требует готового GitHub-релиза того же тега. Dry-run собирает
 * tarball и показывает команду; реальная публикация — явный выбор, токен в ~/.npmrc.
 */
async function publishNpmArgs(terminal: Terminal): Promise<string[] | undefined> {
  const tag = await ask(terminal, 'Тег опубликованного релиза (vX.Y.Z или vX.Y.Z-rc.N)');

  if (tag === undefined) {
    return;
  }

  const action = await choose(terminal, `npm-пакет для ${tag}`, [
    {
      value: 'dry-run',
      label: 'Только собрать tarball',
      description: 'Проверить manifest релиза и показать команду публикации.',
    },
    {
      value: 'publish',
      label: 'Опубликовать в npm',
      description: 'npm publish с токеном из ~/.npmrc; prerelease уходит с тегом next.',
    },
  ]);

  return action === undefined ? undefined
    : ['publish-npm', '--tag', tag, ...(action === 'dry-run' ? ['--dry-run'] : [])];
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
    {
      value: 'prerelease',
      label: 'Предварительный релиз',
      description: 'Подготовить выпуск-кандидат. Допуск GLM для него необязателен.',
    },
    {
      value: 'stable',
      label: 'Стабильный релиз с допуском GLM',
      description: 'Проверить допуск GLM для режима из контракта GrigDesk на всех платформах.',
    },
  ]);

  if (kind === undefined) {
    return;
  }

  const destination = await choose(terminal, `Релиз ${tag}`, [
    {
      value: 'local',
      label: 'Только подготовить файлы',
      description: 'Сохранить ELF, манифест и SHA-256 в кэше.',
    },
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
      { value: 'cancel', label: 'Отмена', description: 'Вернуться в меню без очистки.' },
      {
        value: 'prune',
        label: 'Очистить',
        description: 'Сохраняются две последние сборки и две резервные копии.',
      },
    ]);

    return selected === 'prune' ? [name] : undefined;
  }

  const defaultBinary = path.join(dshCacheHome(), 'out', 'deepseek');

  if (name === 'publish-npm') {
    return publishNpmArgs(terminal);
  }

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
    { value: 'api', label: 'Обычный API Z.ai', description: 'Проверить маршрут с ключом ZAI_API_KEY.' },
    {
      value: 'coding-plan',
      label: 'Z.ai Coding Plan',
      description: 'Проверить маршрут с ключом ZAI_CODING_API_KEY.',
    },
  ]);

  if (mode === undefined) {
    return;
  }

  const selected = await choose(terminal, 'Живая проверка расходует квоту Z.ai', [
    { value: 'cancel', label: 'Отмена', description: 'Вернуться в меню без обращения к Z.ai.' },
    {
      value: 'smoke',
      label: 'Проверить без записи',
      description: 'Запустить живую проверку выбранного режима.',
    },
    {
      value: 'admit',
      label: 'Проверить и записать допуск',
      description: 'При успешной проверке обновить compatibility/glm.json.',
    },
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
export async function runCliMenu(
  entry: string, dispatch: (argv: string[]) => Promise<void>,
): Promise<number> {
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
        if (args[0] === 'help' || !process.stderr.isTTY || process.env.TERM === 'dumb') {
          await dispatch(args);
        } else {
          const title = actions.find(({ value }) => value === args[0])!.label;
          const code = await runCliAction(entry, args, title);

          if (code === 130 || code === 143) {
            return code;
          }
        }
      } catch (error) {
        if (error instanceof MenuExit) {
          throw error;
        }

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

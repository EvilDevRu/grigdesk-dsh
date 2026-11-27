/**
 * Контроллер TUI владеет режимами терминала и редактированием, а Harness
 * получает только завершённый ввод, результат выбора или сигнал прерывания.
 */
import type { ReadStream, WriteStream } from 'node:tty';

import { KeyDecoder, type Key } from './keys.ts';
import {
  amend, append, caretAt, caretRow, createScreen, diff, inputLines, render, setInput,
  type Frame, type SelectModal,
} from './screen.ts';
import { clean, graphemes, singleLine } from './text.ts';

export interface Choice<Value extends string = string> {
  value: Value;
  name: string;
}

export interface TuiView {
  print(text: string): void;
  stream(text: string): void;
  note(text: string): void;
  amend(text: string): void;
  status(title: string): void;
  busy(text: string | null): void;
  hint(text: string): void;
  ask(prompt: string, signal?: AbortSignal): Promise<string>;
  /** Esc возвращает текущее значение, если оно задано. */
  pick<Value extends string>(
    title: string, choices: readonly Choice<Value>[], current?: Value,
  ): Promise<Value | undefined>;
  confirm(prompt: string, signal?: AbortSignal): Promise<boolean>;
  close(message?: string): void;
}

interface Waiter<T> {
  resolve(value: T): void;
  reject(error: Error): void;
}

interface Modal extends Waiter<string | undefined> {
  screen: SelectModal;
  choices: readonly Choice[];
  current?: string;
}

interface InputWaiter extends Waiter<string> {
  prompt: string;
  signal?: AbortSignal;
}

/**
 * Переключает TTY в raw mode на время чата и связывает ввод с последним
 * нарисованным кадром. Ожидание ответа и выбор закрываются вместе с экраном.
 */
export function createTuiView(options: {
  stdin: ReadStream;
  stdout: WriteStream;
  signal: AbortSignal;
  onInterrupt(): void;
  title?: string;
}): TuiView {
  const { stdin, stdout } = options;
  const decoder = new KeyDecoder();
  const model = createScreen(options.title ?? 'Терминальный чат');
  model.editing = false;
  model.color = process.env.NO_COLOR === undefined;

  const history: string[] = [];
  let historyIndex = -1;
  let frame: Frame | undefined;
  let drawnModal: Modal | null = null;
  let scheduled = false;
  let closed = false;
  let streaming = false;
  let modal: Modal | null = null;
  let waiter: InputWaiter | null = null;
  let width = stdout.columns || 80;
  let height = stdout.rows || 24;
  const wasRaw = stdin.isRaw ?? false;
  const wasFlowing = stdin.readableFlowing;

  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.on('data', onData);
  stdin.resume();
  stdout.write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?2004h');
  decoder.onFlush(processKeys);
  stdout.on('resize', onResize);
  options.signal.addEventListener('abort', onAbort, { once: true });

  /**
   * Несколько событий ACP и клавиш за один оборот цикла получают один кадр.
   */
  function schedule(): void {
    if (scheduled || closed) {
      return;
    }

    scheduled = true;
    setImmediate(() => {
      scheduled = false;

      if (!closed) {
        const next = render(model, width, height);

        if (modal && next.select) {
          modal.screen.offset = next.select.first;
        }

        if (!modal && model.scroll !== null) {
          model.scroll = next.history.top < next.history.max ? next.history.top : null;
        }

        stdout.write(diff(frame?.lines ?? null, next));
        frame = next;
        drawnModal = modal;
      }
    });
  }

  function onResize(): void {
    width = stdout.columns || width;
    height = stdout.rows || height;
    frame = undefined;
    schedule();
  }

  function onAbort(): void {
    close();
  }

  function onData(chunk: string): void {
    processKeys(decoder.push(chunk));
  }

  /**
   * Обрабатывает клавиши в порядке передачи, пока Ctrl+C не закрыл терминал.
   */
  function processKeys(keys: readonly Key[]): void {
    for (const key of keys) {
      if (closed) {
        break;
      }

      handle(key);
    }

    if (keys.length) {
      schedule();
    }
  }

  /**
   * Модальный список получает навигацию раньше истории. Клавиши редактирования
   * действуют только при видимом поле, поэтому ввод во время хода не отвечает
   * на ещё не показанный запрос разрешения.
   */
  function handle(key: Key): void {
    if (key.kind === 'ctrl' && (key.key === 'c' || key.key === 'd' && !model.input && !modal)) {
      options.onInterrupt();

      return;
    }

    if (modal) {
      modalKey(modal, key);

      return;
    }

    if (key.kind === 'pageUp' || key.kind === 'pageDown') {
      scroll((key.kind === 'pageUp' ? -1 : 1) * (frame?.history.page || 1));

      return;
    }

    if (key.kind === 'pointer') {
      if (key.action !== 'press') {
        scroll(key.action === 'up' ? -3 : 3);
      } else if (waiter && drawnModal === null && frame?.input) {
        const row = frame.input.lines[key.row - frame.input.row];

        if (row && key.column <= width) {
          model.caret = caretAt(row, key.column);
        }
      }

      return;
    }

    if (waiter) {
      inputKey(key);
    }
  }

  /**
   * Позиция считается от начала истории, чтобы новые строки ответа
   * не уводили экран от прочитанного места.
   */
  function scroll(delta: number): void {
    if (frame && drawnModal === null) {
      const { max } = frame.history;
      const top = Math.max(0, Math.min(max, (model.scroll ?? max) + delta));

      model.scroll = top === max ? null : top;
    }
  }

  /**
   * Выбор и подсветка хранятся в одном объекте. Клик проверяется по диапазону
   * показанных строк, а границы клавиш и колеса ограничены списком.
   */
  function modalKey(active: Modal, key: Key): void {
    const { choices, screen } = active;
    const count = choices.length;
    const page = frame?.select?.count || 1;

    switch (key.kind) {
      case 'up':
        screen.selected = (screen.selected - 1 + count) % count;
        break;
      case 'down':
        screen.selected = (screen.selected + 1) % count;
        break;
      case 'home':
        screen.selected = 0;
        break;
      case 'end':
        screen.selected = count - 1;
        break;
      case 'pageUp':
        screen.selected = Math.max(0, screen.selected - page);
        break;
      case 'pageDown':
        screen.selected = Math.min(count - 1, screen.selected + page);
        break;
      case 'ctrl':
        if (key.key === 'escape') {
          finishModal(active, active.current);
        }
        break;
      case 'enter':
        finishModal(active, choices[screen.selected]!.value);
        break;
      case 'text': {
        const index = /^[1-9]$/u.test(key.value) ? Number(key.value) - 1 : -1;

        if (choices[index]) {
          finishModal(active, choices[index].value);
        }
        break;
      }
      case 'pointer': {
        const area = frame?.select;
        const row = key.row - (area?.row ?? 0);

        if (!area || drawnModal !== active || key.column < area.left || key.column > area.right) {
          break;
        }

        if (key.action !== 'press') {
          const delta = key.action === 'up' ? -1 : 1;

          screen.selected = Math.max(0, Math.min(count - 1, screen.selected + delta));
        } else if (row >= 0 && row < area.count) {
          finishModal(active, choices[area.first + row]!.value);
        }
        break;
      }
      default:
    }
  }

  /**
   * Освобождает список до разрешения Promise. Подтверждённую настройку выводит
   * сам чат после ответа Harness.
   */
  function finishModal(active: Modal, value: string | undefined): void {
    modal = null;
    model.modal = null;
    active.resolve(value);
  }

  /**
   * Меняет диапазон между границами графем и ставит курсор после вставленного текста.
   */
  function replace(start: number, end: number, value: string): void {
    const glyphs = graphemes(model.input);
    const prefix = glyphs.slice(0, start).join('') + singleLine(value);

    setInput(model, prefix + glyphs.slice(end).join(''), graphemes(prefix).length);
    historyIndex = -1;
  }

  /**
   * Стрелки сначала перемещаются между строками черновика. На пустом
   * обычном вводе они открывают историю отправленных запросов.
   */
  function vertical(direction: -1 | 1): void {
    const lines = inputLines(model, width);
    const index = caretRow(lines, model.caret);
    const target = lines[index + direction];

    if (historyIndex === -1 && target) {
      const current = lines[index]!;

      const column = current.columns[model.caret - current.start] ?? 1;
      const nextRow = lines[index + direction + 1];
      const last = nextRow && nextRow.start > target.start ? nextRow.start - 1 : Infinity;

      model.caret = Math.min(caretAt(target, column), last);
    } else if (!waiter?.prompt && history.length && (historyIndex !== -1 || !model.input && direction < 0)) {
      const from = historyIndex === -1 ? history.length : historyIndex;
      const next = Math.max(0, Math.min(history.length, from + direction));

      historyIndex = next === history.length ? -1 : next;
      setInput(model, history[next] ?? '');
    }
  }

  /**
   * Стрелки, Home/End и Delete работают в середине строки и на составных символах.
   */
  function inputKey(key: Key): void {
    const at = model.caret;
    const length = graphemes(model.input).length;

    switch (key.kind) {
      case 'text':
      case 'paste':
        replace(at, at, key.value);
        break;
      case 'backspace':
        replace(Math.max(0, at - 1), at, '');
        break;
      case 'delete':
        replace(at, at + 1, '');
        break;
      case 'left':
        model.caret = Math.max(0, at - 1);
        break;
      case 'right':
        model.caret = Math.min(length, at + 1);
        break;
      case 'home':
        model.caret = 0;
        break;
      case 'end':
        model.caret = length;
        break;
      case 'up':
        vertical(-1);
        break;
      case 'down':
        vertical(1);
        break;
      case 'enter':
        submit();
        break;
      case 'ctrl':
        switch (key.key) {
          case 'escape':
            replace(0, length, '');
            break;
          case 'a':
            model.caret = 0;
            break;
          case 'e':
            model.caret = length;
            break;
          case 'u':
            replace(0, at, '');
            break;
          case 'k':
            replace(at, length, '');
            break;
          default:
        }
        break;
      default:
    }
  }

  /**
   * Снимает ожидание и очищает поле даже при отмене. Вопрос следующего хода
   * получает пустой ввод и собственную подписку на abort.
   */
  function takeInput(): InputWaiter | null {
    const pending = waiter;

    waiter = null;
    pending?.signal?.removeEventListener('abort', onWaiterAbort);
    setInput(model, '');
    historyIndex = -1;
    model.prompt = '› ';
    model.editing = false;

    return pending;
  }

  /**
   * История содержит обычные запросы. Ответы на вопросы видны в транскрипции.
   */
  function submit(): void {
    const value = model.input.trim();
    const pending = takeInput();

    if (pending?.prompt && value) {
      add(`› ${value}`, 'bold');
    } else if (value) {
      add(`\nВы › ${value}`, 'bold');
      history.push(value);
    }

    model.scroll = null;
    pending?.resolve(value);
  }

  function onWaiterAbort(): void {
    takeInput()?.reject(new DOMException('Ввод отменён', 'AbortError'));
    schedule();
  }

  /**
   * Пустая подсказка означает обычный запрос, а непустая выводится в истории
   * над полем для уточнения или разрешения.
   */
  function askRaw(prompt: string, prefix: string, signal?: AbortSignal): Promise<string> {
    if (closed || signal?.aborted) {
      return Promise.reject(new DOMException('Ввод отменён', 'AbortError'));
    }

    if (prompt) {
      add(prompt, 'accent');
      model.scroll = null;
    }

    model.prompt = prefix;
    model.editing = true;

    return new Promise((resolve, reject) => {
      waiter = { resolve, reject, prompt, signal };
      signal?.addEventListener('abort', onWaiterAbort, { once: true });
      schedule();
    });
  }

  /**
   * Создаёт один объект списка для отрисовки, выбора и привязки координат.
   */
  function pick<Value extends string>(
    title: string, choices: readonly Choice<Value>[], current?: Value,
  ): Promise<Value | undefined> {
    if (closed) {
      return Promise.reject(new DOMException('Выбор отменён', 'AbortError'));
    }

    if (choices.length === 0) {
      return Promise.resolve(current);
    }

    return new Promise((resolve, reject) => {
      const selected = Math.max(0, choices.findIndex((item) => item.value === current));
      const screen = { title, items: choices.map(({ name }) => name), selected, offset: 0 };

      model.modal = screen;
      modal = { screen, choices, current, resolve: resolve as Modal['resolve'], reject };
      schedule();
    });
  }

  /**
   * Вывод отдельного события заканчивает предыдущий поток ответа.
   */
  function add(text: string, style: 'normal' | 'dim' | 'bold' | 'accent' = 'normal'): void {
    streaming = false;
    append(model, text, style);
    schedule();
  }

  /**
   * Перед выводом ошибки возвращает настройки оболочки и снимает ожидания ввода.
   */
  function close(message?: string): void {
    if (closed) {
      return;
    }

    closed = true;
    const error = new DOMException('Терминальный чат закрыт', 'AbortError');
    takeInput()?.reject(error);
    modal?.reject(error);
    modal = null;
    stdin.off('data', onData);
    decoder.dispose();
    stdout.off('resize', onResize);
    options.signal.removeEventListener('abort', onAbort);
    stdin.setRawMode(wasRaw);

    if (!wasFlowing) {
      stdin.pause();
    }

    stdout.write('\x1b[?2004l\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l');

    if (message) {
      stdout.write(message.endsWith('\n') ? message : `${message}\n`);
    }
  }

  if (options.signal.aborted) {
    onAbort();
  }

  schedule();

  return {
    print: add,
    stream: (text) => {
      if (streaming) {
        amend(model, text);
      } else if (clean(text)) {
        append(model, text);
        streaming = true;
      }

      schedule();
    },
    note: (text) => add(text, 'dim'),
    amend: (text) => {
      amend(model, text);
      schedule();
    },
    status: (title) => {
      model.title = title;
      schedule();
    },
    busy: (text) => {
      model.busy = text;
      schedule();
    },
    hint: (text) => {
      model.hint = text;
      schedule();
    },
    ask: (prompt, signal) => askRaw(prompt, '› ', signal),
    confirm: async (prompt, signal) => {
      const answer = await askRaw(`${prompt} [y/N]`, 'y/N › ', signal);

      return /^(y|д|да)$/iu.test(answer.trim());
    },
    pick,
    close,
  };
}

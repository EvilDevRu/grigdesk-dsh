import { on } from 'node:events';
import { emitKeypressEvents } from 'node:readline';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  pointer?: { column: number; row: number; action: 'hover' | 'press' | 'up' | 'down' };
}

export interface Terminal {
  signal: AbortSignal;
  read: () => Promise<{ text: string; key: Key }>;
  draw: (render: () => string) => void;
  redraw: () => void;
  trackPointer: (enabled: boolean) => void;
}

export class MenuExit extends Error {
  readonly code: number;

  constructor(code: number) {
    super('Работа меню завершена');
    this.code = code;
  }
}

const mouseOn = '\x1b[?1006h\x1b[?1003h';
const mouseOff = '\x1b[?1003l\x1b[?1006l';
const mousePacket = /\x1b\[<(\d{1,3});(\d{1,6});(\d{1,6})([Mm])/gu;
const mousePrefix = /\x1b(?:\[(?:<(?:\d{1,3}(?:;\d{0,6}(?:;\d{0,6})?)?)?)?)?(?![\s\S])/u;

/**
 * Readline разбирает клавиши, но не отчёты мыши SGR. Перехватываем их до readline,
 * сохраняя порядок со стрелками и собирая отчёт, если граница чанка прошла внутри него.
 */
function connectInput(input: PassThrough): () => void {
  const { stdin } = process;
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let timer: NodeJS.Timeout | undefined;

  /**
   * Таймаут передаёт Esc в readline, а обрывок отчёта мыши целиком отбрасывает.
   */
  function flush(): void {
    if (!pending.startsWith('\x1b[<')) {
      input.write(pending);
    }
    pending = '';
  }

  /**
   * Храним только возможное начало следующего отчёта. Таймер передаёт одиночный Esc
   * в readline, даже когда терминал больше ничего не прислал.
   */
  function receive(chunk: Buffer): void {
    clearTimeout(timer);
    const text = pending + decoder.write(chunk);
    let start = 0;

    for (const match of text.matchAll(mousePacket)) {
      input.write(text.slice(start, match.index));
      start = match.index + match[0].length;
      const button = Number(match[1]) & 0b11100011;

      const action = button === 0 ? 'press' : button === 35 ? 'hover'
        : button === 64 ? 'up' : button === 65 ? 'down' : undefined;

      if (match[4] === 'M' && action) {
        input.emit('keypress', '', {
          pointer: { column: Number(match[2]), row: Number(match[3]), action },
        });
      }
    }

    const tail = text.slice(start);
    pending = tail.match(mousePrefix)?.[0] ?? '';
    input.write(tail.slice(0, tail.length - pending.length));

    if (pending) {
      timer = setTimeout(flush, 40);
      timer.unref();
    }
  }

  const end = () => {
    clearTimeout(timer);

    if (!input.writableEnded) {
      input.end(pending + decoder.end());
    }
  };
  stdin.on('data', receive);
  stdin.once('end', end);
  stdin.once('close', end);

  return () => {
    clearTimeout(timer);
    stdin.off('data', receive);
    stdin.off('end', end);
    stdin.off('close', end);
    input.destroy();
  };
}

/**
 * Сессия владеет вводом, курсором и дополнительным экраном до завершения callback.
 * Сигналы и Ctrl+C доступны и тогда, когда экран выполнения ещё не ждёт клавишу.
 */
export async function terminalSession<T>(
  screen: boolean, run: (terminal: Terminal) => Promise<T>,
): Promise<T> {
  const { stdin, stdout } = process;
  const raw = stdin.isRaw;
  const flowing = stdin.readableFlowing;
  const alternate = screen && process.env.TERM !== 'dumb';
  const stop = new AbortController();
  const input = new PassThrough();
  const interrupt = () => stop.abort(130);
  const terminate = () => stop.abort(143);
  const interruptKey = (_: string, key: Key = {}) => {
    if (key.ctrl && key.name === 'c') {
      interrupt();
    }
  };
  let render: (() => string) | undefined;
  let pointer = false;

  function redraw(): void {
    if (render) {
      stdout.write(render());
    }
  }

  /**
   * Отчёты мыши нужны только в списках. Поля ввода и прокрутка журнала
   * возвращают терминалу его обычное управление указателем.
   */
  function trackPointer(enabled: boolean): void {
    const next = alternate && enabled;

    if (pointer !== next) {
      stdout.write(next ? mouseOn : mouseOff);
      pointer = next;
    }
  }

  emitKeypressEvents(input);
  input.on('keypress', interruptKey);
  const keys = on(input, 'keypress', { signal: stop.signal, close: ['end', 'close'] });
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  stdout.on('resize', redraw);
  const disconnectInput = connectInput(input);

  try {
    stdin.setRawMode(true);
    stdin.resume();

    if (alternate) {
      stdout.write('\x1b[?1049h\x1b[?25l');
    }

    return await run({
      signal: stop.signal,
      read: async () => {
        const next = await keys.next();

        if (stop.signal.aborted) {
          throw new MenuExit(stop.signal.reason as number);
        }

        const [text = '', key = {}] = (next.value ?? []) as [string?, Key?];

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
      trackPointer,
    });
  } catch (error) {
    if (stop.signal.aborted) {
      throw new MenuExit(stop.signal.reason as number);
    }

    throw error;
  } finally {
    disconnectInput();
    await keys.return?.();
    stdin.setRawMode(raw);

    if (!flowing) {
      stdin.pause();
    }

    stdout.off('resize', redraw);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    trackPointer(false);

    if (alternate) {
      stdout.write('\x1b[?25h\x1b[?1049l');
    }
  }
}

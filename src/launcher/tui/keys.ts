/**
 * Декодер ввода терминала в raw mode: UTF-8 текст, CSI-последовательности стрелок и
 * прокрутки, bracketed paste. Побайтовые фрагменты последовательности копятся, пока
 * последовательность не завершится, поэтому стрелка никогда не печатается буквами.
 */

export type Key =
  | { kind: 'text'; value: string }
  | { kind: 'enter' }
  | { kind: 'backspace' }
  | { kind: 'delete' }
  | { kind: 'tab' }
  | { kind: 'up' } | { kind: 'down' } | { kind: 'left' } | { kind: 'right' }
  | { kind: 'pageUp' } | { kind: 'pageDown' } | { kind: 'home' } | { kind: 'end' }
  | { kind: 'ctrl'; key: string }
  | { kind: 'paste'; value: string }
  | { kind: 'pointer'; action: 'press' | 'up' | 'down'; column: number; row: number };

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * Задержка, после которой одиночный Esc считается нажатием, а не началом CSI-последовательности.
 * Достаточна для SSH, где стрелка может прийти двумя кусочками; без неё модалка закрывалась бы
 * только следующей клавишей.
 */
export const ESCAPE_TIMEOUT_MS = 50;

export class KeyDecoder {
  #pending = '';
  #pasting = false;
  #escapeTimer: ReturnType<typeof setTimeout> | undefined;
  #flush: (keys: Key[]) => void = () => {};

  /**
   * Ключи, дозревшие по таймауту (одиночный Esc), возвращаются через обработчик: push уже вернулся.
   */
  onFlush(listener: (keys: Key[]) => void): void {
    this.#flush = listener;
  }

  /** Снимает отложенный Esc; после закрытия TUI таймер не должен будить обработчики ввода. */
  dispose(): void {
    clearTimeout(this.#escapeTimer);
    this.#escapeTimer = undefined;
  }

  /**
   * Принимает очередной кусок stdin и возвращает готовые нажатия. Неполная последовательность
   * остаётся до следующего куска; одиночный Esc дозревает по таймауту через onFlush.
   */
  push(chunk: string): Key[] {
    this.#pending += chunk;
    clearTimeout(this.#escapeTimer);
    this.#escapeTimer = undefined;
    const keys = this.#drain(false);

    // Осталась неполная escape-последовательность (полная уже съедена) — даём ей дозреть до Esc.
    if (!this.#pasting && this.#pending.startsWith('\x1b')) {
      this.#escapeTimer = setTimeout(() => {
        this.#escapeTimer = undefined;
        this.#flush(this.#drain(true));
      }, ESCAPE_TIMEOUT_MS);
    }

    return keys;
  }

  #drain(escape: boolean): Key[] {
    const keys: Key[] = [];

    while (this.#pending.length > 0) {
      if (this.#pasting) {
        const end = this.#pending.indexOf(PASTE_END);

        if (end === -1) {
          break;
        }

        const value = this.#pending.slice(0, end);

        this.#pending = this.#pending.slice(end + PASTE_END.length);
        this.#pasting = false;

        if (value) {
          keys.push({ kind: 'paste', value });
        }

        continue;
      }

      if (this.#pending.startsWith(PASTE_START)) {
        this.#pasting = true;
        this.#pending = this.#pending.slice(PASTE_START.length);

        continue;
      }

      const key = this.#next(escape);

      if (key === null) {
        break;
      }

      if (key !== undefined) {
        keys.push(key);
      }
    }

    return keys;
  }

  /**
   * null ждёт продолжения пакета, undefined пропускает полностью прочитанное событие.
   */
  #next(escape: boolean): Key | null | undefined {
    const input = this.#pending;

    if (input.startsWith('\x1b')) {
      return this.#escape(escape);
    }

    this.#pending = input.slice(1);

    if (input[0] === '\r' || input[0] === '\n') {
      return { kind: 'enter' };
    }

    if (input[0] === '\u007f' || input[0] === '\b') {
      return { kind: 'backspace' };
    }

    if (input[0] === '\t') {
      return { kind: 'tab' };
    }

    if (input[0]! < ' ') {
      return { kind: 'ctrl', key: String.fromCharCode(input[0]!.charCodeAt(0) + 96) };
    }

    // Многобайтовый символ мог прийти целиком: stdin отдаёт декодированный UTF-8.
    const code = input.codePointAt(0)!;
    const char = String.fromCodePoint(code);

    this.#pending = input.slice(char.length);

    return { kind: 'text', value: char };
  }

  /**
   * Esc как клавиша приходит одним байтом. Служебные CSI/SS3 целиком
   * поглощаются декодером, включая неподдержанные клавиши и отчёты терминала.
   */
  #escape(due: boolean): Key | null | undefined {
    const input = this.#pending;
    const match = /^\x1b(?:\[|O)([0-?]*[ -/]*)([@-~])/u.exec(input);

    if (match === null) {
      const incomplete = input.length === 1 || input.startsWith('\x1b[') || input.startsWith('\x1bO');

      // Неполная последовательность ждёт продолжения, пока не истёк срок одиночного Esc.
      if (incomplete && !due) {
        return null;
      }

      this.#pending = incomplete ? '' : input.slice(1);

      if (incomplete && input.length > 1) {
        return undefined;
      }

      if (!incomplete && input[1] !== '\x1b') {
        this.#pending = input.slice(1 + String.fromCodePoint(input.codePointAt(1)!).length);

        return undefined;
      }

      return { kind: 'ctrl', key: 'escape' };
    }

    this.#pending = input.slice(match[0].length);
    const [, parameters, final] = match;

    switch (final) {
      case 'A':
        return { kind: 'up' };
      case 'B':
        return { kind: 'down' };
      case 'C':
        return { kind: 'right' };
      case 'D':
        return { kind: 'left' };
      case 'H':
        return { kind: 'home' };
      case 'F':
        return { kind: 'end' };
      case '~':
        const code = parameters?.split(';')[0];

        if (code === '3') {
          return { kind: 'delete' };
        }

        if (code === '5') {
          return { kind: 'pageUp' };
        }

        if (code === '6') {
          return { kind: 'pageDown' };
        }

        if (code === '1' || code === '7') {
          return { kind: 'home' };
        }

        if (code === '4' || code === '8') {
          return { kind: 'end' };
        }

        return undefined;
      case 'M':
        return input.startsWith('\x1b[') ? this.#mouse(parameters ?? '') : undefined;
      default:
        return undefined;
    }
  }

  /**
   * SGR 1006 передаёт координаты от единицы. Отпускание кнопки игнорируется,
   * модификаторы Shift/Alt/Ctrl могут присутствовать и у колеса.
   */
  #mouse(parameters: string): Key | undefined {
    const match = /^<(\d{1,3});([1-9]\d{0,5});([1-9]\d{0,5})$/u.exec(parameters);

    if (!match) {
      return undefined;
    }

    const code = Number(match[1]) & 0b11100011;
    const action = code === 0 ? 'press' : code === 64 ? 'up' : code === 65 ? 'down' : undefined;

    return action ? { kind: 'pointer', action, column: Number(match[2]), row: Number(match[3]) } : undefined;
  }
}

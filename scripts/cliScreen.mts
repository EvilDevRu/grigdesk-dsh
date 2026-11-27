import { stripVTControlCharacters } from 'node:util';

const background = '\x1b[48;2;27;31;38m';
const selectedBackground = '\x1b[48;2;41;59;67m';
const reset = '\x1b[0m';

const tones = {
  text: '\x1b[38;2;224;229;237m',
  accent: '\x1b[1;38;2;140;206;206m',
  muted: '\x1b[38;2;154;165;181m',
  rule: '\x1b[38;2;83;97;116m',
  success: '\x1b[38;2;142;203;167m',
  error: '\x1b[38;2;239;144;144m',
};

export interface ScreenRow {
  text: string;
  tone?: keyof typeof tones;
  selected?: boolean;
}

export function cleanText(text: string): string {
  return stripVTControlCharacters(text).replace(/\p{Cc}/gu, '');
}

/**
 * Подсказка переносится по словам, длинные пути при необходимости делятся посимвольно.
 * Управляющие символы убираются до расчёта ширины строки.
 */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  let remaining = [...cleanText(text)];

  while (remaining.length > width) {
    const space = remaining.slice(0, width + 1).lastIndexOf(' ');
    const end = space > 0 ? space : width;

    lines.push(remaining.slice(0, end).join(''));
    remaining = remaining.slice(end + Number(space > 0));
  }

  lines.push(remaining.join(''));

  return lines;
}

/**
 * Общая графитовая рамка оставляет один столбец свободным, чтобы кадр не прокручивал экран.
 * Раскладка пересчитывается при каждом кадре и сообщает меню координату первой строки.
 */
export function screenFrame(title: string) {
  const { columns, rows } = process.stdout;
  const screenRows = rows || 24;
  const outerWidth = Math.max(1, Math.min(80, (columns || 80) - 1));
  const inset = outerWidth >= 28 ? '  ' : '';
  const width = outerWidth - inset.length * 2;
  const positioned = process.env.TERM !== 'dumb';
  const color = positioned && process.env.NO_COLOR === undefined;
  const rule: ScreenRow = { text: '─'.repeat(width), tone: 'rule' };
  const header: ScreenRow[] = [{ text: title, tone: 'accent' }];

  if (screenRows >= 9) {
    header.unshift({ text: '◆ GrigDesk · DeepSeek Harness', tone: 'accent' });
    header.push(rule);
  }

  if (screenRows >= 20) {
    header.unshift({ text: '' });
    header.push({ text: '' });
  }

  return {
    width,
    firstRow: header.length + 1,
    gutter: inset.length,
    capacity: Math.max(1, screenRows - header.length),
    rule,
    render(body: readonly ScreenRow[], footer: readonly ScreenRow[] = []) {
      const content = [...header, ...body, ...footer].slice(0, screenRows).map((row) => {
        const visible = [...cleanText(row.text)].slice(0, width).join('');

        if (!color) {
          return inset + visible + (positioned ? '\x1b[K' : '');
        }

        const fill = ' '.repeat(width - [...visible].length + inset.length);
        const base = row.selected ? selectedBackground : background;
        const foreground = tones[row.selected ? 'accent' : row.tone ?? 'text'];

        return `${base}${foreground}${inset}${visible}${fill}${reset}${background}\x1b[K`;
      });

      if (!positioned) {
        return `\n${content.join('\n')}\n`;
      }

      const fill = color ? background : '';

      return `\x1b[H${fill}${content.join('\r\n')}\x1b[J${color ? reset : ''}`;
    },
  };
}

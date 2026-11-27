/**
 * Текстовые примитивы TUI. Перенос, обрезка и ввод используют одни и те же
 * границы графем, чтобы курсор и столбцы совпадали на кириллице и широких символах.
 */

const segmenter = new Intl.Segmenter('ru', { granularity: 'grapheme' });
const ascii = /^[\x20-\x7e]*$/u;
const invisible = /^[\p{M}\p{Cf}]+$/u;
const emoji = /\p{Emoji_Presentation}|\ufe0f/u;
const wide = new RegExp(
  '^[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff'
    + '\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]', 'u',
);

export function graphemes(text: string): string[] {
  return ascii.test(text) ? text.split('') : Array.from(segmenter.segment(text), ({ segment }) => segment);
}

/**
 * Количество клеток, занятых одной графемой, включая составные эмодзи.
 */
export function glyphWidth(glyph: string): number {
  if (invisible.test(glyph)) {
    return 0;
  }

  return wide.test(glyph) || emoji.test(glyph) ? 2 : 1;
}

/**
 * Ширина печатной строки в клетках, с быстрым путём для обычного ASCII.
 */
export function cells(text: string): number {
  return ascii.test(text) ? text.length
    : graphemes(text).reduce((width, glyph) => width + glyphWidth(glyph), 0);
}

/**
 * Убирает управляющие последовательности из текста, сохраняя переводы строк.
 */
export function clean(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu, '')
    .replace(/\x1b[@-Z\\-_]/gu, '')
    .replace(/\r\n?/gu, '\n')
    .replace(/\t/gu, '    ')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/gu, '');
}

export function singleLine(value: string): string {
  return clean(value).replace(/\n/gu, ' ');
}

/**
 * Переносит абзацы по словам, а слишком длинные слова режет по целым графемам.
 */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];

  for (const paragraph of text.split('\n')) {
    const glyphs = graphemes(paragraph);
    let start = 0;

    while (start < glyphs.length) {
      let end = start;
      let space = -1;
      let used = 0;

      while (end < glyphs.length) {
        const glyph = glyphs[end]!;
        const size = glyphWidth(glyph);

        if (glyph === ' ' && end > start) {
          space = end;
        }

        if (used + size > width) {
          break;
        }

        used += size;
        end += 1;
      }

      if (end === glyphs.length) {
        lines.push(glyphs.slice(start).join(''));
        break;
      }

      if (end === start) {
        lines.push('�');
        start += 1;
      } else {
        const cut = space === -1 ? end : space;

        lines.push(glyphs.slice(start, cut).join(''));
        start = cut + Number(space !== -1);
      }
    }

    if (!glyphs.length) {
      lines.push('');
    }
  }

  return lines;
}

/**
 * Выравнивает строку, не оставляя половину широкого символа у правого края.
 */
export function pad(text: string, width: number): string {
  const size = cells(text);

  if (size <= width) {
    return text + ' '.repeat(width - size);
  }

  let result = '';
  let used = 0;

  for (const glyph of graphemes(text)) {
    const size = glyphWidth(glyph);

    if (used + size > width) {
      break;
    }

    result += glyph;
    used += size;
  }

  return result + ' '.repeat(width - used);
}

/**
 * Текстовые примитивы TUI. Перенос, обрезка и ввод используют одни и те же
 * границы графем, чтобы курсор и столбцы совпадали на кириллице и широких символах.
 */

import type { Segment } from './palette.ts';

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
 * Переносит один абзац между графемами, сохраняя атрибуты и адрес ссылки.
 * Пробел разделяет слова только после первого печатного символа строки.
 */
export function wrapSegments(
  segments: readonly Segment[], width: number, indent = 0, wordWrap = true,
): Segment[][] {
  let offset = 0;
  let part = 0;
  let boundary = segments[0]?.text.length ?? 0;
  const glyphs = graphemes(segments.map(({ text }) => text).join('')).map((text) => {
    while (offset >= boundary) {
      part += 1;
      boundary += segments[part]!.text.length;
    }

    offset += text.length;

    return { text, segment: segments[part]! };
  });
  const lines: Segment[][] = [];
  const hanging = indent < width - 1 ? indent : 0;
  let start = 0;

  while (start < glyphs.length) {
    const padding = lines.length ? hanging : 0;
    let used = padding;
    let end = start;
    let space = -1;
    let word = false;

    while (end < glyphs.length) {
      const { text } = glyphs[end]!;
      const size = glyphWidth(text);

      if (wordWrap && text === ' ' && word && (lines.length > 0 || used >= hanging)) {
        space = end;
      }

      if (used + size > width) {
        break;
      }

      word ||= text !== ' ';
      used += size;
      end += 1;
    }

    const cut = end < glyphs.length && space >= 0 ? space : end;
    const line: Segment[] = padding ? [{ text: ' '.repeat(padding), style: 'normal' }] : [];
    let previous: Segment | undefined;

    for (let index = start; index < Math.max(cut, start + 1); index += 1) {
      const { text, segment } = glyphs[index]!;
      const visible = cut === start ? '�' : text;

      if (previous === segment) {
        line.at(-1)!.text += visible;
      } else {
        line.push({ ...segment, text: visible });
        previous = segment;
      }
    }

    lines.push(line);
    start = cut === start ? start + 1 : cut + Number(end < glyphs.length && space >= 0);
  }

  return lines.length ? lines : [[]];
}

/**
 * Переносит и обычные строки через те же правила ширины и разбиения слов.
 */
export function wrap(text: string, width: number): string[] {
  return text.split('\n').flatMap((line) => wrapSegments([{ text: line, style: 'normal' }], width)
    .map((row) => row.map(({ text }) => text).join('')));
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

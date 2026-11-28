import type { Segment, Style } from './palette.ts';
import { cells, clean } from './text.ts';

export interface Paragraph {
  segments: Segment[];
  indent: number;
}

export type Alignment = 'left' | 'center' | 'right';

export interface Table {
  header: string[];
  align: Alignment[];
  rows: string[][];
}

type MarkdownBlock = { kind: 'text' | 'heading' | 'quote'; paragraphs: Paragraph[] }
  | { kind: 'code'; language: string; lines: string[] }
  | { kind: 'table'; table: Table };

const markup = [
  /\\([*_`[\]\\|])|(`+)|\*\*|\*|(?<![\p{L}\p{N}_])_(?=\S)|(?<=\S)_(?![\p{L}\p{N}_])/u,
  /\[([^\[\]\n]+)\]\(((?:[^\s()]|\([^\s()]*\))+)\)/u,
  /https?:\/\/[^\s<>"`*]+/u,
].map(({ source }) => source).join('|');
const list = /^( *)([-*+] |\d+[.)] )(.*)$/u;
const heading = /^ {0,3}#{1,6} +(.+)$/u;
const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const quote = /^ {0,3}> ?(.*)$/u;
const italicEnd = {
  '*': /(?<=\S)(?<![\\*])\*(?!\*)/u,
  _: /(?<=\S)(?<!\\)_(?![\p{L}\p{N}_])/u,
};

/**
 * OSC 8 принимает только проверенные HTTP(S)-адреса. Остальные ссылки
 * сохраняют видимую подпись без передачи управляющей команды терминалу.
 */
function linkTarget(value: string): string | undefined {
  const url = URL.parse(value);

  return url && /^https?:$/u.test(url.protocol) ? url.href : undefined;
}

/**
 * Завершающая пунктуация относится к предложению. Закрывающие скобки
 * остаются в URL только при наличии соответствующей открывающей скобки.
 */
function bareUrl(value: string): string {
  const punctuation = /[.,:;!?]+$/u;
  const opens = { ')': '(', ']': '[', '}': '{' } as const;
  let url = value.replace(punctuation, '');

  while (/[)\]}]$/u.test(url)) {
    const close = url.at(-1)! as keyof typeof opens;

    if (url.split(opens[close]).length >= url.split(close).length) {
      break;
    }

    url = url.slice(0, -1).replace(punctuation, '');
  }

  return url;
}

/**
 * Размечает фрагмент без HTML и переносит выделение внутрь ссылок и кода.
 * Одиночный маркер курсива остаётся видимым до появления закрывающего.
 */
export function inline(text: string, style: Style, literal = false): Segment[] {
  if (literal) {
    return [{ text, style }];
  }

  const segments: Segment[] = [];
  const tokens = new RegExp(markup, 'giu');
  let cursor = 0;
  let bold = false;
  let italic = '';
  const push = (value: string, tone = style, href?: string) => {
    if (value) {
      segments.push({ text: value, style: tone, ...bold && { bold },
        ...italic && { italic: true }, ...href && { href } });
    }
  };

  for (let match = tokens.exec(text); match; match = tokens.exec(text)) {
    const [token, escaped, ticks, label, target] = match;

    push(text.slice(cursor, match.index));
    cursor = tokens.lastIndex;

    if (escaped) {
      push(escaped);
    } else if (ticks) {
      const delimiters = /`+/gu;
      delimiters.lastIndex = cursor;
      let closing = delimiters.exec(text);

      while (closing && closing[0] !== ticks) {
        closing = delimiters.exec(text);
      }

      push(text.slice(cursor, closing?.index), 'code');
      cursor = tokens.lastIndex = closing ? delimiters.lastIndex : text.length;
    } else if (token === '**') {
      bold = !bold;
    } else if (token === '*' || token === '_') {
      if (italic === token && /\S/u.test(text[match.index - 1] ?? '')) {
        italic = '';
      } else if (!italic && /\S/u.test(text[cursor] ?? '')
        && italicEnd[token].test(text.slice(cursor))) {
        italic = token;
      } else {
        push(token);
      }
    } else if (label && target) {
      const href = linkTarget(target);

      for (const part of inline(label, 'link')) {
        segments.push({ text: part.text, style: 'link', ...bold || part.bold ? { bold: true } : {},
          ...italic || part.italic ? { italic: true } : {},
          ...href && { href } });
      }
    } else {
      const url = bareUrl(token);

      push(url, 'link', linkTarget(url));
      push(token.slice(url.length));
    }
  }

  push(text.slice(cursor));

  return segments;
}

/**
 * Списки используют висячий отступ. Буквальный текст остаётся неизменным,
 * в том числе когда содержит синтаксис списков или ссылки.
 */
function paragraph(line: string, style: Style, literal: boolean): Paragraph {
  const item = literal ? null : list.exec(line);
  const prefix = item ? item[1]! + (item[2]!.length === 2 ? '• ' : item[2]!) : '';
  const segments = inline(item?.[3] ?? line, style, literal);

  if (prefix) {
    segments.unshift({ text: prefix, style: 'accent' });
  }

  return { segments, indent: prefix ? cells(prefix) : /^ */u.exec(line)![0].length };
}

/**
 * Вертикальная черта разделяет ячейки вне инлайн-кода. Экранированная
 * черта остаётся в тексте и не создаёт дополнительного столбца.
 */
function tableCells(line: string): string[] | undefined {
  const source = line.trim();
  const parts: string[] = [];
  const markers = /\\[|`\\]|`+|\|/gu;
  let ticks = '';
  let start = 0;

  for (const match of source.matchAll(markers)) {
    const token = match[0];

    if (token.startsWith('`')) {
      ticks = token === ticks ? '' : ticks || token;
    } else if (token === '|' && !ticks) {
      parts.push(source.slice(start, match.index));
      start = match.index + 1;
    }
  }

  if (!parts.length) {
    return undefined;
  }

  if (start < source.length) {
    parts.push(source.slice(start));
  }

  if (source.startsWith('|')) {
    parts.shift();
  }

  return parts.map((part) => part.trim().replace(/\\\|/gu, '|'));
}

/**
 * Разделитель определяет число столбцов и их выравнивание. Без полного
 * разделителя соседние строки продолжают отображаться обычным текстом.
 */
function tableHeader(line: string, next = ''): Table | undefined {
  if (!line.includes('|') || !/^\s*[:| -]+\s*$/u.test(next)) {
    return undefined;
  }

  const header = tableCells(line);
  const delimiter = tableCells(next);

  if (!header?.length || delimiter?.length !== header.length
    || !delimiter.every((part) => /^:?-{3,}:?$/u.test(part))) {
    return undefined;
  }

  const align = delimiter.map((x) => x.endsWith(':') ? x.startsWith(':') ? 'center' : 'right' : 'left');

  return { header, align, rows: [] };
}

/**
 * Выделяет блоки до расчёта ширины. Незакрытая ограда остаётся кодом,
 * а таблица растёт по мере появления строк в потоке ответа.
 */
export function markdownBlocks(value: string, style: Style, literal: boolean): MarkdownBlock[] {
  const result: MarkdownBlock[] = [];
  const lines = clean(value).split('\n');

  if (literal) {
    return [{ kind: 'text', paragraphs: lines.map((line) => paragraph(line, style, true)) }];
  }

  let index = 0;

  while (index < lines.length) {
    const line = lines[index++]!;
    const marker = fence.exec(line);
    const title = heading.exec(line)?.[1];
    const quoted = quote.exec(line)?.[1];

    if (marker) {
      const language = marker[2]!.trim().split(/\s/u, 1)[0]!;
      const code: string[] = [];

      while (index < lines.length) {
        const source = lines[index++]!;
        const closing = fence.exec(source);

        if (closing?.[1]?.startsWith(marker[1]!) && !closing[2]!.trim()) {
          break;
        }

        code.push(source);
      }

      result.push({ kind: 'code', language, lines: code });
    } else if (title) {
      result.push({ kind: 'heading', paragraphs: [paragraph(title, 'heading', false)] });
    } else if (quoted !== undefined) {
      const paragraphs = [paragraph(quoted, style, false)];

      for (let next = quote.exec(lines[index] ?? ''); next; next = quote.exec(lines[++index] ?? '')) {
        paragraphs.push(paragraph(next[1]!, style, false));
      }

      result.push({ kind: 'quote', paragraphs });
    } else {
      const table = tableHeader(line, lines[index]);

      if (table) {
        index += 1;

        for (let row = tableCells(lines[index] ?? ''); row; row = tableCells(lines[++index] ?? '')) {
          table.rows.push(row);
        }

        result.push({ kind: 'table', table });
      } else {
        const previous = result.at(-1);
        const text = paragraph(line, style, false);

        if (previous?.kind === 'text') {
          previous.paragraphs.push(text);
        } else {
          result.push({ kind: 'text', paragraphs: [text] });
        }
      }
    }
  }

  return result;
}

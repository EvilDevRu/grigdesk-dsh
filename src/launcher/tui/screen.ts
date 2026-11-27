/**
 * Раскладка терминального чата возвращает кадр и координаты интерактивных областей.
 * Контроллер использует те же координаты для кликов, которые терминал уже показал.
 */
import { cells, clean, glyphWidth, graphemes, pad, singleLine, wrap } from './text.ts';

export type Style = 'normal' | 'dim' | 'bold' | 'accent';

export interface Entry {
  text: string;
  style: Style;
}

export interface SelectModal {
  title: string;
  items: string[];
  selected: number;
  offset: number;
}

export interface ScreenModel {
  title: string;
  entries: Entry[];
  /** Первая видимая строка истории. null держит экран у конца. */
  scroll: number | null;
  input: string;
  caret: number;
  prompt: string;
  editing: boolean;
  hint: string;
  modal: SelectModal | null;
  busy: string | null;
  color: boolean;
}

interface InputLine {
  text: string;
  start: number;
  columns: number[];
}

export interface Frame {
  lines: string[];
  cursor: { row: number; column: number } | null;
  history: { top: number; max: number; page: number };
  select?: { row: number; left: number; right: number; first: number; count: number };
  input?: { row: number; lines: InputLine[] };
}

const tones = {
  normal: '',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  accent: '\x1b[1;36m',
  bar: '\x1b[48;2;27;31;38;38;2;224;229;237m',
  selected: '\x1b[1;48;2;41;59;67;38;2;164;224;224m',
  field: '\x1b[48;2;34;41;50;38;2;239;244;250m',
};

const actionHint = '↑↓ Выбор   Enter / клик Применить   Esc Назад';

export function createScreen(title = ''): ScreenModel {
  return {
    title, entries: [], scroll: null, input: '', caret: 0, prompt: '› ',
    editing: true, hint: '', modal: null, busy: null, color: true,
  };
}

/**
 * Сохраняет границы абзацев и пустые строки внутри сообщения.
 */
export function append(model: ScreenModel, text: string, style: Style = 'normal'): void {
  const cleaned = clean(text);

  if (cleaned) {
    for (const paragraph of cleaned.split('\n')) {
      model.entries.push({ text: paragraph, style });
    }
  }
}

/**
 * Продолжает последний абзац и сохраняет переводы строк в потоковом тексте.
 */
export function amend(model: ScreenModel, text: string): void {
  const [first, ...rest] = clean(text).split('\n');
  const last = model.entries.at(-1);

  if (last) {
    last.text += first;
    for (const paragraph of rest) {
      model.entries.push({ text: paragraph, style: last.style });
    }
  } else {
    append(model, text);
  }
}

export function setInput(model: ScreenModel, value: string, caret?: number): void {
  model.input = singleLine(value);
  model.caret = caret ?? graphemes(model.input).length;
}

/**
 * Поле переносится по графемам. Колонки границ считаются вместе с приглашением,
 * чтобы правка и клик попадали в одну и ту же позицию даже на широком символе.
 */
export function inputLines(model: ScreenModel, width: number): InputLine[] {
  const inset = width >= 28 ? 2 : 0;
  const prefix = width >= 6 ? model.prompt : '';
  const limit = width - inset;
  const lines: InputLine[] = [];
  let line: InputLine = { text: prefix, start: 0, columns: [inset + cells(prefix) + 1] };

  for (const [index, glyph] of graphemes(model.input).entries()) {
    const size = glyphWidth(glyph);
    const visibleSize = Math.min(size, limit - inset);

    if (line.columns.at(-1)! + visibleSize > limit + 1) {
      lines.push(line);
      line = { text: '', start: index, columns: [inset + 1] };
    }

    line.text += size === visibleSize ? glyph : '�';
    line.columns.push(line.columns.at(-1)! + visibleSize);
  }

  lines.push(line);

  if (line.columns.at(-1)! > limit) {
    lines.push({ text: '', start: line.start + line.columns.length - 1, columns: [inset + 1] });
  }

  return lines;
}

/**
 * Граница переноса относится к следующей строке. Это даёт курсору место
 * и тогда, когда последний символ занял последнюю клетку предыдущей строки.
 */
export function caretRow(lines: readonly InputLine[], caret: number): number {
  return Math.max(0, lines.findLastIndex(({ start }) => start <= caret));
}

/**
 * Возвращает ближайшую позицию вставки к колонке указателя или вертикального перемещения.
 */
export function caretAt(line: InputLine, column: number): number {
  const next = line.columns.findIndex((current, index) => {
    const following = line.columns[index + 1];

    return following === undefined || column < (current + following) / 2;
  });

  return line.start + next;
}

/**
 * Держит заголовок, историю и поле в видимых клетках даже на низком терминале.
 * Модальный выбор использует место истории и поля целиком.
 */
export function render(model: ScreenModel, width: number, height: number): Frame {
  const inset = width >= 28 ? 2 : 0;
  const inner = width - inset * 2;
  const prefix = ' '.repeat(inset);
  const row = (text: string, tone: keyof typeof tones = 'normal') => {
    const content = pad(prefix + pad(text, inner), width);

    return model.color && tones[tone] ? `${tones[tone]}${content}\x1b[0m` : content;
  };
  const lines: string[] = [];
  const footer = height >= 4;
  const heading = height >= 2;
  const history = { top: 0, max: 0, page: 0 };

  if (heading) {
    const state = model.busy ? ` · ${singleLine(model.busy)}` : '';
    const title = `◆ DSH · ${singleLine(model.title)}`;
    const room = Math.max(0, inner - cells(state));

    lines.push(row(pad(title, room).trimEnd() + state, 'bar'));
  }

  if (model.modal) {
    const modal = model.modal;
    const label = height - lines.length > 1;
    const count = Math.min(modal.items.length, height - lines.length - Number(label) - Number(footer));
    const first = Math.max(0, Math.min(modal.offset, modal.selected, modal.items.length - count),
      modal.selected - count + 1);
    const modalWidth = Math.min(inner, 72);

    if (label) {
      lines.push(row(singleLine(modal.title), 'accent'));
    }

    const select = { row: lines.length + 1, first, count, left: inset + 1, right: inset + modalWidth };

    for (let index = first; index < first + count; index += 1) {
      const selected = index === modal.selected;
      const number = index < 9 && inner >= 24 ? `${index + 1}. ` : '';
      const text = `${selected ? '›' : ' '} ${number}${singleLine(modal.items[index]!)}`;
      const content = pad(text, modalWidth);

      lines.push(selected && model.color
        ? prefix + tones.selected + content + '\x1b[0m' + ' '.repeat(width - inset - modalWidth)
        : row(content));
    }

    while (lines.length < height - Number(footer)) {
      lines.push(row(''));
    }

    if (footer) {
      const keys = cells(actionHint) <= inner ? actionHint : '↑↓ Enter Esc';
      const position = modal.items.length > count ? `   ${modal.selected + 1}/${modal.items.length}` : '';

      lines.push(row(keys + position, 'dim'));
    }

    return { lines, cursor: null, history, select };
  }

  const composer = inputLines(model, width);
  const cursorLine = caretRow(composer, model.caret);
  const maxInput = Math.max(1, Math.min(height - lines.length - Number(footer), 5, Math.floor(height / 3)));
  const inputStart = Math.max(0, Math.min(cursorLine, composer.length - maxInput));
  const input = composer.slice(inputStart, inputStart + maxInput);
  history.page = Math.max(0, height - lines.length - input.length - Number(footer));
  const transcript = model.entries.flatMap(({ text, style }) =>
    wrap(text, inner).map((line) => ({ text: line, style })));
  history.max = Math.max(0, transcript.length - history.page);
  history.top = Math.min(model.scroll ?? history.max, history.max);

  for (const entry of transcript.slice(history.top, history.top + history.page)) {
    lines.push(row(entry.text, entry.style));
  }

  while (lines.length < height - input.length - Number(footer)) {
    lines.push(row(''));
  }

  const inputRow = lines.length + 1;

  for (const line of input) {
    lines.push(row(model.editing ? line.text : singleLine(model.busy ?? 'Ожидание…'), 'field'));
  }

  if (footer) {
    const keys = 'Enter Отправить   PgUp/PgDn История   /help Команды   Ctrl+C Отмена';
    const older = history.top < history.max;
    const hint = older ? '↓ PgDn · к новым сообщениям' : singleLine(model.hint) || keys;
    const shortHint = older ? '↓ PgDn' : 'Enter · PgUp · Ctrl+C';

    lines.push(row(cells(hint) <= inner ? hint : shortHint, 'dim'));
  }

  const currentLine = composer[cursorLine]!;
  const cursor = model.editing ? {
    row: inputRow + cursorLine - inputStart,
    column: currentLine.columns[model.caret - currentLine.start] ?? 1,
  } : null;

  return { lines, cursor, history, input: model.editing ? { row: inputRow, lines: input } : undefined };
}

/**
 * Позиционирование каждой строки отдельно исключает перенос на следующую строку
 * и прокрутку при попадании в правый нижний угол.
 */
export function diff(previous: string[] | null, next: Frame): string {
  const repaint = !previous || previous.length !== next.lines.length;
  let output = repaint ? '\x1b[H' : '';

  for (const [index, line] of next.lines.entries()) {
    if (repaint || previous[index] !== line) {
      output += `\x1b[${index + 1};1H\x1b[K${line}`;
    }
  }

  if (next.cursor === null) {
    return output + '\x1b[?25l';
  }

  return output + `\x1b[${next.cursor.row};${next.cursor.column}H\x1b[?25h`;
}

export function full(next: Frame): string {
  return diff(null, next);
}

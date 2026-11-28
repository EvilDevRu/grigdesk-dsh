/**
 * Раскладка терминального чата возвращает кадр и координаты интерактивных областей.
 * Контроллер использует те же координаты для кликов, которые терминал уже показал.
 */
import type { UpdateNotice } from '../updateCheck.ts';
import { codeLine } from './code.ts';
import { markdownBlocks } from './markdown.ts';
import { paint, type Background, type Segment, type Style } from './palette.ts';
import { tableRows, type TableLine } from './table.ts';
import { cells, clean, glyphWidth, graphemes, pad, singleLine, wrapSegments } from './text.ts';

interface Entry {
  text: string;
  style: Style;
  literal: boolean;
}

export interface Tool {
  name: string;
  command: string;
  status: string;
  output: string;
}

export interface ToolBlock {
  tool: Tool;
  expanded: boolean;
}

export interface SelectModal {
  title: string;
  items: string[];
  selected: number;
  offset: number;
}

export interface ChatStatus {
  model: string;
  effort?: string;
  directory: string;
}

export interface ScreenModel {
  title: string;
  update: UpdateNotice | null;
  entries: (Entry | ToolBlock)[];
  /** Первая видимая строка истории. null держит экран у конца. */
  scroll: number | null;
  input: string;
  caret: number;
  prompt: string;
  editing: boolean;
  hint: string;
  warning: string;
  status: ChatStatus | null;
  task: string;
  toolFocus: ToolBlock | null;
  modal: SelectModal | null;
  busy: string | null;
  color: boolean;
}

interface InputLine {
  text: string;
  start: number;
  columns: number[];
}

interface ToolArea {
  block: ToolBlock;
  row: number;
  left: number;
  right: number;
  index: number;
}

export interface Frame {
  lines: string[];
  cursor: { row: number; column: number } | null;
  history: { top: number; max: number; page: number };
  select?: { row: number; left: number; right: number; first: number; count: number };
  tools?: ToolArea[];
  input?: { row: number; lines: InputLine[] };
}

interface HistoryLine extends TableLine {
  block?: ToolBlock;
  width?: number;
  offset?: number;
}

const actionHint = '↑↓ Выбор   Enter / клик Применить   Esc Назад';
const paddedMinWidth = 32;
const proseWidth = 104;
const panelWidth = 112;
const toolStates: Record<string, Segment> = {
  pending: { text: '·', style: 'dim' },
  in_progress: { text: '◌', style: 'accent' },
  completed: { text: '✓', style: 'success' },
  failed: { text: '✗', style: 'error' },
  cancelled: { text: '–', style: 'warning' },
};
const outputPlural = new Intl.PluralRules('ru');
const messageCache = new WeakMap<Entry, { width: number; text: string; rows: HistoryLine[] }>();
const toolCache = new WeakMap<ToolBlock, {
  width: number; tool: Tool; expanded: boolean; rows: HistoryLine[];
}>();

export function createScreen(title = ''): ScreenModel {
  return {
    title, update: null, entries: [], scroll: null, input: '', caret: 0, prompt: '› ',
    editing: true, hint: '', warning: '', status: null, task: '', toolFocus: null,
    modal: null, busy: null, color: process.env.NO_COLOR === undefined,
  };
}

/**
 * Сохраняет сообщение целиком, чтобы разметка и интервалы не зависели
 * от того, какими фрагментами текст пришёл из ACP.
 */
export function append(model: ScreenModel, text: string, style: Style = 'normal', literal = false): void {
  const cleaned = clean(text);

  if (cleaned) {
    model.entries.push({ text: cleaned, style, literal });
  }
}

/**
 * Дописывает фрагмент только к последнему сообщению.
 * Обновления инструментов редактируют свои блоки отдельно.
 */
export function amend(model: ScreenModel, text: string): void {
  const last = model.entries.at(-1);

  if (last && 'text' in last) {
    last.text += clean(text);
  } else {
    append(model, text);
  }
}

export function setInput(model: ScreenModel, value: string, caret?: number): void {
  model.input = clean(value);
  model.caret = caret ?? graphemes(model.input).length;
}

/**
 * Поле переносится по графемам. Колонки границ включают приглашение и отступы,
 * поэтому клик и вертикальное движение работают при любом размере окна.
 */
export function inputLines(model: ScreenModel, width: number, padded = width >= paddedMinWidth): InputLine[] {
  const inset = (width >= 28 ? 2 : 0) + (padded ? 2 : 0);
  const limit = width - inset;
  const prefix = width >= 6 ? model.prompt : '';
  const lines: InputLine[] = [];
  let line: InputLine = { text: prefix, start: 0, columns: [inset + cells(prefix) + 1] };

  for (const [index, glyph] of graphemes(model.input).entries()) {
    const size = glyphWidth(glyph);
    const visibleSize = Math.min(size, limit - inset);
    const newline = glyph === '\n';

    if (newline || line.columns.at(-1)! + visibleSize > limit + 1) {
      lines.push(line);
      line = { text: '', start: index + Number(newline), columns: [inset + 1] };
    }

    if (!newline) {
      line.text += size === visibleSize ? glyph : '�';
      line.columns.push(line.columns.at(-1)! + visibleSize);
    }
  }

  lines.push(line);

  if (line.columns.at(-1)! > limit) {
    lines.push({ text: '', start: line.start + line.columns.length - 1, columns: [inset + 1] });
  }

  return lines;
}

/**
 * Граница автоматического переноса относится к следующей строке.
 * На явном переводе строки остаётся отдельная позиция перед ним.
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

function segment(text: string, style: Style = 'normal'): Segment {
  return { text, style };
}

/**
 * Обрезка и выравнивание происходят до добавления ANSI. Правая сторона
 * строки сохраняет свои координаты при любом наборе атрибутов слева.
 */
function draw(segments: Segment[], width: number, color: boolean, surface?: Background): string {
  let rest = width;
  let output = '';

  for (const part of segments) {
    if (rest <= 0) {
      break;
    }

    const size = cells(part.text);
    const text = size > rest ? pad(part.text, rest) : part.text;

    output += paint({ ...part, text }, color, surface);
    rest -= cells(text);
  }

  const fill = ' '.repeat(rest);

  return output + (surface ? paint(segment(fill), color, surface) : fill);
}

const lineWidth = (parts: readonly Segment[]) => parts.reduce((total, part) => total + cells(part.text), 0);

/**
 * Полоса слева отмечает автора и вид сообщения. На минимальной ширине
 * всё место отдаётся самому тексту, чтобы панель оставалась читаемой.
 */
function panelRows(
  lines: Segment[][], width: number, surface: Background, rail: Segment, inset: number,
): HistoryLine[] {
  return lines.map((segments) => ({ segments: inset ? [rail, ...segments] : segments, width, surface }));
}

/**
 * Проза, таблицы и вставки начинают текст с одной колонки. Код оборачивается
 * по клеткам с сохранением пробелов, а цитата сохраняет переносы Markdown.
 */
function markdownRows(entry: Entry, text: string, width: number): HistoryLine[] {
  const offset = width >= 24 ? 3 : 0;
  const available = width - offset;
  const prose = Math.min(available, proseWidth);
  const panel = Math.min(available, panelWidth);
  const gutter = panel >= 12 ? 3 : 0;
  const rows: HistoryLine[] = [];

  for (const block of markdownBlocks(text, entry.style, entry.literal)) {
    let next: HistoryLine[];

    if (block.kind === 'table') {
      next = tableRows(block.table, panel, entry.style);
    } else if (block.kind === 'code') {
      const label = segment(block.language || 'Код', 'dim');
      const source = block.lines.flatMap((line) =>
        wrapSegments(codeLine(line, block.language), panel - gutter, 0, false));

      next = panelRows([[label], ...source], panel, 'code', segment('│  ', 'border'), gutter);
    } else {
      const quoted = block.kind === 'quote';
      const size = quoted ? panel - gutter : prose;
      const lines = block.paragraphs.flatMap(({ segments, indent }) =>
        wrapSegments(segments, size, indent, !entry.literal));

      next = quoted ? panelRows(lines, panel, 'quote', segment('│  ', 'warning'), gutter)
        : lines.map((segments) => ({ segments }));
    }

    if (rows.at(-1)?.segments.length && next[0]?.segments.length) {
      rows.push({ segments: [] });
    }

    for (const line of next) {
      rows.push({ ...line, offset });
    }
  }

  return rows;
}

/**
 * Законченные сообщения повторно используют раскладку. Изменение текста
 * текущего сообщения или ширины окна заставляет пересчитать его строки.
 */
function messageRows(entry: Entry, width: number): HistoryLine[] {
  const cached = messageCache.get(entry);

  if (cached?.width === width && cached.text === entry.text) {
    return cached.rows;
  }

  const text = entry.text.replace(/^\n+|\n+$/gu, '');
  let rows: HistoryLine[] = [];

  if (text.trim() && entry.style === 'user') {
    const size = Math.min(width, panelWidth);
    const gutter = size >= 6 ? 3 : 0;
    const lines = text.split('\n').flatMap((line) => wrapSegments([segment(line)], size - gutter));

    rows = panelRows(lines, size, 'user', segment('▌  ', 'user'), gutter);
  } else if (text.trim()) {
    rows = markdownRows(entry, text, width);
  }

  messageCache.set(entry, { width, text: entry.text, rows });

  return rows;
}

/**
 * Статус всегда предшествует названию. Счётчик вывода и стрелка находятся
 * в той же строке, которая целиком служит зоной клика для разворота.
 */
function toolRows(block: ToolBlock, available: number): HistoryLine[] {
  const width = Math.min(available, panelWidth);
  const { tool, expanded } = block;
  const cached = toolCache.get(block);

  if (cached?.width === width && cached.tool === tool && cached.expanded === expanded) {
    return cached.rows;
  }

  const output = clean(tool.output).replace(/\n+$/u, '');
  const hasRail = width >= 12;
  const rail = segment('│ ', 'border');
  const state = Object.hasOwn(toolStates, tool.status) ? toolStates[tool.status]! : toolStates.pending!;
  const header = hasRail ? [rail, state] : [state];
  const name = singleLine(tool.name).trim() || 'Инструмент';
  const commandLines = clean(tool.command).split('\n');
  const command = commandLines[0]! + (commandLines.length > 1 ? '…' : '');
  const headWidth = lineWidth(header);
  const nameWidth = Math.min(cells(name), Math.max(6, Math.floor(width / 3)));
  const commandFits = commandLines.length === 1 && cells(command) <= width - headWidth - nameWidth - 4;
  const expandable = Boolean(output || command && !commandFits);
  const count = output ? output.split('\n').length : 0;
  const form = outputPlural.select(count);
  const unit = form === 'one' ? 'строка' : form === 'few' ? 'строки' : 'строк';
  const toggle = expanded ? '▾' : '▸';
  const detail = count ? `${toggle} ${count} ${unit}` : `${toggle} Команда`;
  const short = count && width >= 16 ? `${toggle} ${count}` : toggle;
  const suffix = expandable && width >= headWidth + 2 ? width >= 30 ? `  ${detail} ` : ` ${short}` : '';
  const room = width - headWidth - cells(suffix);
  const title = room > 1 ? ' ' + elide(name, command ? Math.min(room - 1, nameWidth) : room - 1) : '';
  const commandRoom = room - cells(title) - 2;

  header.push(segment(title, 'bold'));

  if (command && commandRoom > 0) {
    header.push(segment('  ' + elide(command, commandRoom), 'dim'));
  }

  if (suffix) {
    const gap = Math.max(0, width - lineWidth(header) - cells(suffix));

    header.push(segment(' '.repeat(gap)), segment(suffix, 'accent'));
  }

  const rows: HistoryLine[] = [{ segments: header, width, surface: 'tool', ...expandable && { block } }];

  if (expanded && expandable) {
    const text = tool.command && (!commandFits || cells(command) > commandRoom)
      ? [...commandLines, ...(output ? ['', ...output.split('\n')] : [])]
      : output.split('\n');
    const gutter = hasRail ? 5 : 0;
    const lines = text.flatMap((line) => wrapSegments([segment(line)], width - gutter, 0, false));

    for (const line of panelRows(lines, width, 'code', segment('│    ', 'border'), gutter)) {
      rows.push(line);
    }
  }

  toolCache.set(block, { width, tool, expanded, rows });

  return rows;
}

/**
 * Сообщения отделены пустой строкой. Соседние инструменты образуют
 * компактную группу с общей полосой и одинаковым отступом.
 */
function historyRows(entries: ScreenModel['entries'], width: number): HistoryLine[] {
  const rows: HistoryLine[] = [];
  let previousTool = false;

  for (const entry of entries) {
    const tool = 'tool' in entry;
    const next = tool ? toolRows(entry, width) : messageRows(entry, width);

    if (next.length === 0) {
      continue;
    }

    if (rows.length && (!tool || !previousTool)) {
      rows.push({ segments: [] });
    }

    for (const line of next) {
      rows.push(line);
    }

    previousTool = tool;
  }

  return rows;
}

/**
 * Многоточие занимает одну клетку и обозначает обрезанный путь или заголовок.
 */
function elide(text: string, width: number): string {
  return width <= 0 ? '' : cells(text) <= width ? text : pad(text, width - 1).trimEnd() + '…';
}

/**
 * Модель, папка и задача имеют собственные стили. Длинная задача сокращается
 * первой, а модель остаётся видимой даже в узком терминале.
 */
function footerInfo(model: ScreenModel): Segment[] {
  const fields = [
    segment(model.status?.model ?? '', 'accent'),
    segment(model.status?.effort ?? '', 'dim'),
    segment(model.status?.directory ?? '', 'user'),
    segment(model.task, 'normal'),
  ];
  const info: Segment[] = [];

  for (const part of fields) {
    const text = singleLine(part.text);

    if (text) {
      if (info.length) {
        info.push(segment(' · ', 'border'));
      }

      info.push({ ...part, text });
    }
  }

  return info;
}

/**
 * Правая часть футера резервирует клавиши и предупреждение. При нехватке
 * места оставляет короткую подсказку и обрезает поля слева по графемам.
 */
function footerRow(model: ScreenModel, width: number, older: boolean, tools: boolean): Segment[] {
  const info = footerInfo(model);
  const infoWidth = lineWidth(info);
  const actions = model.toolFocus ? `Enter ${model.toolFocus.expanded ? 'Свернуть' : 'Развернуть'}   Esc Ввод`
    : model.editing ? 'Enter Отправить   Ctrl+C' : 'Ctrl+C Отмена';
  const fullHint = tools ? `Tab Вывод   ${actions}`
    : model.editing && !model.warning ? `${actions}   /help` : actions;
  const shortHint = model.toolFocus ? 'Tab · Enter · Esc' : tools ? 'Tab · Ctrl+C' : 'Ctrl+C';
  const hint = older ? '↓ PgDn · к новым сообщениям' : singleLine(model.hint) || fullHint;
  const warning = model.warning ? elide(`⚠ ${singleLine(model.warning)}`, width) : '';
  const room = width - cells(warning) - (warning ? 2 : 0);
  const keys = cells(hint) + (infoWidth ? infoWidth + 2 : 0) <= room ? hint : older ? '↓ PgDn' : shortHint;
  const help = cells(keys) + (infoWidth ? 8 : 0) <= room ? keys : '';
  const right = [segment(warning, 'warning'), segment(warning && help ? '  ' + help : help, 'dim')];
  const rightWidth = lineWidth(right);
  const gap = rightWidth && infoWidth ? 2 : 0;
  const leftWidth = width - rightWidth - gap;

  if (leftWidth <= 0 || !infoWidth) {
    return [segment(' '.repeat(Math.max(0, width - rightWidth))), ...right];
  }

  const left: Segment[] = [];
  let remaining = leftWidth;

  for (const [index, part] of info.entries()) {
    if (remaining <= 0 || index % 2 === 1 && remaining <= 3) {
      break;
    }

    const text = elide(part.text, remaining);

    left.push({ ...part, text });
    remaining -= cells(text);

    if (text !== part.text) {
      break;
    }
  }

  return [...left, segment(' '.repeat(remaining + gap)), ...right];
}

/**
 * Список использует всю оставшуюся высоту. Область выбора ограничена
 * строками, которые реально попали в кадр.
 */
function renderSelect(
  model: ScreenModel, modal: SelectModal, lines: string[], width: number, height: number,
  inset: number, footer: boolean, history: Frame['history'],
): Frame {
  const inner = width - inset * 2;
  const row = (parts: Segment[]) => ' '.repeat(inset) + draw(parts, inner, model.color) + ' '.repeat(inset);
  const label = height - lines.length > 1;
  const count = Math.min(modal.items.length, height - lines.length - Number(label) - Number(footer));
  const first = Math.max(0, Math.min(modal.offset, modal.selected, modal.items.length - count),
    modal.selected - count + 1);
  const modalWidth = Math.min(inner, 72);

  if (label) {
    lines.push(row([segment(singleLine(modal.title), 'accent')]));
  }

  const select = { row: lines.length + 1, first, count, left: inset + 1, right: inset + modalWidth };

  for (let index = first; index < first + count; index += 1) {
    const selected = index === modal.selected;
    const number = index < 9 && inner >= 24 ? `${index + 1}. ` : '';
    const text = `${selected ? '›' : ' '} ${number}${singleLine(modal.items[index]!)}`;

    const surface = selected ? 'selected' : undefined;

    lines.push(' '.repeat(inset) + draw([segment(text, selected ? 'selected' : 'normal')],
      modalWidth, model.color, surface) + ' '.repeat(width - inset - modalWidth));
  }

  while (lines.length < height - Number(footer)) {
    lines.push(row([]));
  }

  if (footer) {
    const keys = cells(actionHint) <= inner ? actionHint : '↑↓ Enter Esc';
    const position = modal.items.length > count ? `   ${modal.selected + 1}/${modal.items.length}` : '';

    lines.push(row([segment(keys + position, 'dim')]));
  }

  return { lines, cursor: null, history, select };
}

export function composerPadded(width: number, height: number): boolean {
  return width >= paddedMinWidth && height >= 7;
}

/**
 * Уведомление занимает правую часть шапки и оставляет историю на месте.
 * В узком окне сохраняется номер версии, а подпись чата по необходимости сокращается.
 */
function headerParts(model: ScreenModel, width: number): Segment[] {
  const title = singleLine(model.title);
  const brand = segment('DSH', 'heading');
  const label = title ? ` · ${title}` : '';
  const notice = model.update;

  if (!notice) {
    return [brand, segment(label, 'dim')];
  }

  const full = `↑ Доступна версия ${notice.version}`;
  const badge = cells(full) + 5 <= width ? full : `↑ ${notice.version}`;
  const room = width - cells(badge) - 5;

  if (room < 0) {
    return [brand, segment(label, 'dim')];
  }

  const subtitle = room >= 7 ? elide(label, room) : '';
  const space = ' '.repeat(width - 3 - cells(subtitle) - cells(badge));

  return [brand, segment(subtitle, 'dim'), segment(space), { text: badge, style: 'link', href: notice.href }];
}

/**
 * Поле отделяется от истории свободной строкой и занимает до пяти строк
 * черновика. Интервал, отступы и интерактивные зоны рассчитываются в клетках.
 */
export function render(model: ScreenModel, width: number, height: number): Frame {
  const inset = width >= 28 ? 2 : 0;
  const inner = width - inset * 2;
  const row = (parts: Segment[]) => ' '.repeat(inset) + draw(parts, inner, model.color) + ' '.repeat(inset);
  const lines: string[] = [];
  const footer = height >= 4;
  const history = { top: 0, max: 0, page: 0 };

  if (height >= 2) {
    lines.push(row(headerParts(model, inner)));
  }

  if (model.modal) {
    return renderSelect(model, model.modal, lines, width, height, inset, footer, history);
  }

  if (height >= 10 && inset) {
    lines.push(row([]));
  }

  const padded = composerPadded(width, height);
  const composer = inputLines(model, width, padded);
  const cursorLine = caretRow(composer, model.caret);
  const available = height - lines.length - Number(footer) - 2 * Number(padded);
  const maxInput = Math.min(5, available > 2 ? available - 2 : 1);
  const inputStart = Math.max(0, Math.min(cursorLine, composer.length - maxInput));
  const input = composer.slice(inputStart, inputStart + maxInput);
  history.page = available - input.length;

  const transcript = historyRows(model.entries, inner);
  const tools: ToolArea[] = [];
  history.max = Math.max(0, transcript.length - history.page);
  history.top = Math.min(model.scroll ?? history.max, history.max);

  for (const [offsetIndex, entry] of transcript.slice(history.top, history.top + history.page).entries()) {
    const { block, segments, offset = 0 } = entry;
    const visibleWidth = entry.width ?? lineWidth(segments);
    const focused = block && model.toolFocus === block;

    if (block) {
      tools.push({
        block, row: lines.length + 1, left: inset + offset + 1,
        right: inset + offset + visibleWidth, index: history.top + offsetIndex,
      });
    }

    const start = inset + offset;
    const parts = focused && visibleWidth >= 12 ? [segment('▐ ', 'accent'), ...segments.slice(1)] : segments;

    lines.push(' '.repeat(start) + draw(parts, visibleWidth, model.color,
      focused ? 'selected' : entry.surface) + ' '.repeat(width - start - visibleWidth));
  }

  while (lines.length < height - input.length - Number(footer) - Number(padded)) {
    lines.push(row([]));
  }

  const inputRow = lines.length + 1;
  const margin = ' '.repeat(inset);
  const rail = segment('│ ', model.warning ? 'warning' : model.editing ? 'user' : 'border');

  for (const line of input) {
    const placeholder = model.prompt === '› ' ? 'Спроси что угодно…' : '';
    const text = model.editing ? line.text : singleLine(model.busy ?? 'Ожидание…');
    const prefix = model.editing && line === composer[0] && width >= 6 ? model.prompt : '';
    const style = model.editing ? 'normal' : 'dim';
    const content = [segment(prefix, 'user'), segment(text.slice(prefix.length), style)];

    if (model.editing && !model.input) {
      content.push(segment(placeholder, 'dim'));
    }

    lines.push(padded ? margin + paint(rail, model.color, 'composer')
      + draw(content, inner - 4, model.color, 'composer')
      + paint(segment('  '), model.color, 'composer') + margin : row(content));
  }

  if (padded) {
    lines.push(margin + draw([rail], inner, model.color, 'composer') + margin);
  }

  if (footer) {
    lines.push(row(footerRow(model, inner, history.top < history.max, tools.length > 0)));
  }

  const currentLine = composer[cursorLine]!;
  const cursor = model.editing && model.toolFocus === null ? {
    row: inputRow + cursorLine - inputStart,
    column: currentLine.columns[model.caret - currentLine.start] ?? 1,
  } : null;

  return {
    lines, cursor, history, tools,
    input: model.editing ? { row: inputRow, lines: input } : undefined,
  };
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

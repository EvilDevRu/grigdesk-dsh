import { inline, type Alignment, type Table } from './markdown.ts';
import type { Background, Segment, Style } from './palette.ts';
import { cells, wrapSegments } from './text.ts';

export interface TableLine {
  segments: Segment[];
  surface?: Background;
}

const lineWidth = (line: readonly Segment[]) => line.reduce((total, part) => total + cells(part.text), 0);

/**
 * Короткие столбцы сразу получают свою естественную ширину. Остальное место
 * делится между широкими столбцами, чтобы один длинный URL не занял всю таблицу.
 */
function fitColumns(rows: Segment[][][], columns: number, width: number): number[] {
  const preferred = Array<number>(columns).fill(4);

  for (const row of rows) {
    for (const [index, cell] of row.entries()) {
      preferred[index] = Math.max(preferred[index]!, lineWidth(cell));
    }
  }

  const widths = Array<number>(columns).fill(4);
  let remaining = width - columns * 4;

  for (let limit = 4; remaining > 0 && widths.some((value, index) => value < preferred[index]!); limit += 1) {
    for (const [index, natural] of preferred.entries()) {
      if (natural > limit && remaining > 0) {
        widths[index]! += 1;
        remaining -= 1;
      }
    }
  }

  return widths;
}

/**
 * В очень узком окне строки становятся списком «поле — значение». Каждое
 * поле получает доступную ширину, поэтому содержимое столбцов остаётся видимым.
 */
function stackedRows(rows: Segment[][][], width: number): TableLine[] {
  const [header, ...body] = rows;

  if (!body.length) {
    return header!.flatMap((label) => wrapSegments(label, width).map((segments) => ({ segments })));
  }

  const result: TableLine[] = [];

  for (const row of body) {
    if (result.length) {
      result.push({ segments: [] });
    }

    for (const [index, cell] of row.entries()) {
      const label = header![index]!;
      const indent = width >= 8 ? 2 : 0;
      const prefix: Segment[] = label.length ? [...label, { text: ' · ', style: 'border' }] : [];

      result.push(...wrapSegments([...prefix, ...cell], width, indent).map((segments) => ({ segments })));
    }
  }

  return result;
}

/**
 * Выравнивание добавляет только пробелы. Стили и адреса ссылок
 * сохраняются после переноса содержимого каждой ячейки.
 */
function cellParts(parts: Segment[], width: number, align: Alignment): Segment[] {
  const spare = width - lineWidth(parts);
  const left = align === 'right' ? spare : align === 'center' ? Math.floor(spare / 2) : 0;

  return [{ text: ' '.repeat(left + 1), style: 'normal' }, ...parts,
    { text: ' '.repeat(spare - left + 1), style: 'normal' }];
}

/**
 * Рисует общую сетку по ширине терминала. Фон выделяет заголовок
 * и помогает следить за строкой через несколько столбцов.
 */
export function tableRows(table: Table, width: number, style: Style): TableLine[] {
  const { header, rows, align } = table;
  const columns = header.length;
  const content = [header, ...rows].map((row, index) =>
    header.map((_, column) => inline(row[column] ?? '', index ? style : 'bold')));
  const available = width - 3 * columns - 1;

  if (available < columns * 4) {
    return stackedRows(content, width);
  }

  const widths = fitColumns(content, columns, available);
  const rule = (left: string, middle: string, right: string): TableLine => ({ segments: [{
    text: left + widths.map((size) => '─'.repeat(size + 2)).join(middle) + right,
    style: 'border',
  }] });
  const separator: Segment = { text: '│', style: 'border' };
  const result = [rule('╭', '┬', '╮')];

  for (const [index, row] of content.entries()) {
    const wrapped = row.map((cell, column) => wrapSegments(cell, widths[column]!));
    const height = Math.max(...wrapped.map((lines) => lines.length));
    const surface = index === 0 ? 'tableHead' : index % 2 === 0 ? 'tableAlt' : undefined;

    for (let line = 0; line < height; line += 1) {
      const segments = [separator];

      for (const [column, text] of wrapped.entries()) {
        segments.push(...cellParts(text[line] ?? [], widths[column]!, align[column]!), separator);
      }

      result.push({ segments, surface });
    }

    if (index === 0 && rows.length) {
      result.push(rule('├', '┼', '┤'));
    }
  }

  result.push(rule('╰', '┴', '╯'));

  return result;
}

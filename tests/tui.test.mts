import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { ESCAPE_TIMEOUT_MS, KeyDecoder, type Key } from '../src/launcher/tui/keys.ts';
import {
  append, createScreen, diff, full, render, setInput, type ScreenModel,
} from '../src/launcher/tui/screen.ts';
import { inline, markdownBlocks } from '../src/launcher/tui/markdown.ts';
import { cells, clean, pad, wrap, wrapSegments } from '../src/launcher/tui/text.ts';

/** Каждый кадр обязан занимать ровно height строк по width колонок без escape в середине. */
function assertFrame(model: ScreenModel, width: number, height: number) {
  const frame = render(model, width, height);

  assert.equal(frame.lines.length, height);

  for (const line of frame.lines) {
    assert.equal(cells(clean(line)), width, JSON.stringify(line));
  }

  return frame;
}

test('ширина, очистка и перенос учитывают двухколоночные символы и режут длинные слова', () => {
  assert.equal(cells('привет'), 6);
  assert.equal(cells('日本語'), 6);
  assert.equal(cells('a\u200bb'), 2);
  assert.equal(clean('\x1b[1mжирный\x1b[22m\r\n\x07текст\u0000'), 'жирный\nтекст');
  assert.deepEqual(wrap('aa bb cc', 5), ['aa bb', 'cc']);
  assert.deepEqual(wrap('abcdef', 3), ['abc', 'def']);
  assert.deepEqual(wrap('', 10), ['']);
  assert.deepEqual(wrap('日本語 テスト', 7), ['日本語', 'テスト']);
  assert.equal(pad('ab', 5), 'ab   ');
  assert.equal(pad('日本語', 5), '日本 ');
  assert.equal(cells('е\u0301👩‍💻🇷🇺'), 5);
  assert.deepEqual(wrap('日', 1), ['�']);
});

test('разметка выделяет текст, код, ссылки и сохраняет отступы списков', () => {
  const text = '**Жирный**: `x`, [**док**](https://example.org/a), https://example.org/b.';

  assert.deepEqual(inline(text, 'normal'), [
    { text: 'Жирный', style: 'normal', bold: true },
    { text: ': ', style: 'normal' },
    { text: 'x', style: 'code' },
    { text: ', ', style: 'normal' },
    { text: 'док', style: 'link', bold: true, href: 'https://example.org/a' },
    { text: ', ', style: 'normal' },
    { text: 'https://example.org/b', style: 'link', href: 'https://example.org/b' },
    { text: '.', style: 'normal' },
  ]);
  assert.deepEqual(inline('`ещё печатается', 'normal'), [{ text: 'ещё печатается', style: 'code' }]);
  assert.deepEqual(inline('[ссылка](file:///a)', 'normal'), [{ text: 'ссылка', style: 'link' }]);
  assert.deepEqual(inline('(https://example.org/a(b)).', 'normal').map(({ text }) => text), [
    '(', 'https://example.org/a(b)', ').',
  ]);

  const parsed = markdownBlocks('# Файлы\n  - путь\n    1. имя\n```sh\n  echo **\n```', 'normal', false);
  const paragraphs = parsed.flatMap((block) => 'paragraphs' in block ? block.paragraphs : []);

  assert.deepEqual(paragraphs.map(({ segments }) => segments.map(({ text }) => text).join('')),
    ['Файлы', '  • путь', '    1. имя']);
  assert.deepEqual(paragraphs.map(({ indent }) => indent), [0, 4, 7]);
  assert.equal(paragraphs[0]?.segments[0]?.style, 'heading');
  assert.deepEqual(parsed.at(-1), { kind: 'code', language: 'sh', lines: ['  echo **'] });
  assert.deepEqual(inline('*Курсив*, snake_case и _ещё_', 'normal'), [
    { text: 'Курсив', style: 'normal', italic: true },
    { text: ', snake_case и ', style: 'normal' },
    { text: 'ещё', style: 'normal', italic: true },
  ]);
});

test('перенос сохраняет широкие графемы, оформление и адрес ссылки на каждой строке', () => {
  const block = markdownBlocks('  - [日本語👩‍💻](https://example.org)', 'normal', false)[0]!;

  assert.equal(block.kind, 'text');
  const { segments, indent } = block.paragraphs[0]!;
  const rows = wrapSegments(segments, 8, indent);

  assert.deepEqual(rows.map((row) => row.map(({ text }) => text).join('')), ['  • 日本', '    語👩‍💻']);
  assert.deepEqual(rows.map((row) => row.find(({ style }) => style === 'link')?.href),
    ['https://example.org/', 'https://example.org/']);
  assert.deepEqual(wrapSegments(inline('**Ж**`日`', 'normal'), 2), [
    [{ text: 'Ж', style: 'normal', bold: true }], [{ text: '日', style: 'code' }],
  ]);
  assert.deepEqual(wrapSegments(inline('е**\u0301**ж', 'normal'), 1), [
    [{ text: 'е\u0301', style: 'normal' }], [{ text: 'ж', style: 'normal' }],
  ]);
});

test('декодер собирает стрелки из кусков, различает Ctrl, Enter, вставку и колесо', () => {
  const decoder = new KeyDecoder();

  assert.deepEqual(decoder.push('\x1b'), [], 'неполная последовательность ждёт продолжения');
  assert.deepEqual(decoder.push('[A'), [{ kind: 'up' }]);
  assert.deepEqual(decoder.push('\x1bп'), [], 'Alt+буква не стирает черновик');
  assert.deepEqual(decoder.push('\x1b[B\x1bOC\x1b[3~\x1b[5~\x1b[6~\x1b[H\x1b[F'), [
    { kind: 'down' }, { kind: 'right' }, { kind: 'delete' }, { kind: 'pageUp' }, { kind: 'pageDown' },
    { kind: 'home' }, { kind: 'end' },
  ]);
  assert.deepEqual(decoder.push('\r\u007f\t\x03\x04\x1b'), [
    { kind: 'enter' }, { kind: 'backspace' }, { kind: 'tab' }, { kind: 'ctrl', key: 'c' },
    { kind: 'ctrl', key: 'd' },
  ]);
  assert.deepEqual(decoder.push('\x1b'), [{ kind: 'ctrl', key: 'escape' }],
    'Esc закрывается следующим байтом: второй Esc — Alt+Esc');
  assert.deepEqual(decoder.push('x'), []);
  assert.deepEqual(decoder.push('\x1b\r\x1b[13;3u'), [{ kind: 'newline' }, { kind: 'newline' }]);
  assert.deepEqual(decoder.push('\x1b[200~ста\nрая\x1b[201~x'), [{ kind: 'paste', value: 'ста\nрая' },
    { kind: 'text', value: 'x' }]);
  assert.deepEqual(decoder.push('\x1b[<0;10;'), []);
  assert.deepEqual(decoder.push('5M\x1b[<0;10;5m\x1b[<68;10;5M\x1b[<65;11;6M\x1b[15~\x1b[I'), [
    { kind: 'pointer', action: 'press', column: 10, row: 5 },
    { kind: 'pointer', action: 'up', column: 10, row: 5 },
    { kind: 'pointer', action: 'down', column: 11, row: 6 },
  ]);
});

test('одиночный Esc дозревает по таймауту через onFlush; dispose снимает таймер', async () => {
  const track = (decoder: KeyDecoder) => {
    const flushes: Key[][] = [];

    decoder.onFlush((keys) => flushes.push(keys));

    return flushes;
  };
  const alone = new KeyDecoder();
  const torn = new KeyDecoder();
  const disposed = new KeyDecoder();
  const [aloneFlushed, tornFlushed, disposedFlushed] = [alone, torn, disposed].map(track);

  assert.deepEqual(alone.push('\x1b'), []);
  assert.deepEqual(torn.push('\x1b['), [], 'обрывок CSI ждёт продолжения');
  assert.deepEqual(disposed.push('\x1b'), []);
  disposed.dispose();
  await new Promise((resolve) => setTimeout(resolve, ESCAPE_TIMEOUT_MS + 20));
  assert.deepEqual(aloneFlushed, [[{ kind: 'ctrl', key: 'escape' }]],
    'Esc закрывает модалку без лишней клавиши');
  assert.deepEqual(tornFlushed, [[]], 'обрывок не превращается в Escape');
  assert.deepEqual(disposedFlushed, [], 'после dispose таймер не будит ввод');
});

test('кадр держит поле и навигацию на экране при длинном вводе и в узком окне', () => {
  const model = createScreen('DeepSeek · glm-5.3');

  append(model, 'привет', 'user');
  append(model, '· Bash(ls)\nответ модели');
  setInput(model, 'строка ввода');

  const frame = assertFrame(model, 20, 10);

  // Заголовок, разделитель и подсказка на своих местах; текст не потерян.
  // Заголовок на 20 колонок обрезается по границе без выхода за кадр.
  assert.match(clean(frame.lines[0]!), /DSH · DeepSeek/u);
  assert.match(clean(frame.lines.join('\n')), /▌  привет[\s\S]*ответ модели/u);
  assert.doesNotMatch(clean(frame.lines.join('\n')), /[╭╮│╰╯]/u);
  assert.equal(frame.cursor?.row, 9);
  assert.equal(frame.cursor?.column, cells('› строка ввода') + 1);

  // Модальный список заменяет область транскрипции и прячет курсор.
  model.modal = {
    title: 'Модель', items: ['deepseek-v4-flash', 'deepseek-v4-pro'], selected: 1, offset: 0,
  };
  const modal = assertFrame(model, 24, 12);

  assert.equal(modal.cursor, null);
  const picture = clean(modal.lines.join('\n'));

  assert.match(picture, /Модель[\s\S]*› 2\. deepseek-v4-pro[\s\S]*Enter Esc/u);
  assert.deepEqual(modal.select, { row: 3, left: 1, right: 24, first: 0, count: 2 });
  assert.equal(assertFrame(model, 1, 1).select?.count, 1);

  // Длинный черновик не закрывает подсказку, курсор виден и до, и после переноса.
  model.modal = null;
  model.scroll = 0;
  const scrolled = assertFrame(model, 8, 6);

  assert.doesNotMatch(clean(scrolled.lines.join('\n')), /ответ модели/u);
  setInput(model, '日本ский текст '.repeat(20));
  const tail = assertFrame(model, 14, 6);

  assert.equal(tail.cursor?.row, 5);
  assert.ok(tail.input && tail.input.lines[0]!.start > 0);
  setInput(model, model.input, 0);
  assert.equal(assertFrame(model, 14, 6).input?.lines[0]!.start, 0);
  assert.equal(assertFrame(model, 1, 1).cursor?.column, 1);
});

test('цвет и NO_COLOR сохраняют ту же геометрию истории, композера и футера', () => {
  const model = createScreen('Терминальный чат');
  const previous = process.env.NO_COLOR;

  try {
    process.env.NO_COLOR = '1';
    assert.equal(createScreen().color, false);
  } finally {
    if (previous === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = previous;
    }
  }

  model.color = true;
  model.status = { model: 'glm', effort: 'high', directory: '~/репозиторий' };
  model.task = 'Текущая задача';
  model.warning = 'Разрешение';
  append(model, 'запрос', 'user');
  append(model, '**Ответ** и `ls` с [ссылкой](https://example.org)');
  append(model, 'Готово · 2м 4с', 'dim');
  const frame = assertFrame(model, 100, 13);
  const colored = frame.lines.join('\n');

  assert.match(colored, /\x1b\[38;2;127;218;199;48;2;31;48;51m▌/u);
  assert.match(colored, /\x1b\[1;38;2;224;229;237mОтвет/u);
  assert.match(colored, /\x1b\[38;2;203;166;102mls/u);
  assert.match(colored, /\x1b\[4;38;2;97;175;239mссылкой/u);
  assert.match(colored, /\x1b\[38;2;229;192;123m⚠ Разрешение/u);
  assert.match(colored, /\x1b\[38;2;155;166;182;48;2;36;47;59mСпроси что угодно…/u);

  model.color = false;
  const plain = assertFrame(model, 100, 13);
  const picture = plain.lines.join('\n');

  assert.doesNotMatch(picture, /\x1b|\*\*|`|https:/u);
  assert.deepEqual(plain.lines, frame.lines.map(clean));
  assert.deepEqual(plain.cursor, frame.cursor);
  assert.match(picture, /▌  запрос *\n +\n *Ответ и ls с ссылкой/u);
  assert.match(picture, /│ › Спроси что угодно… +\n *│/u);
  assert.match(plain.lines.at(-1)!, /glm · high · ~\/репозиторий · Текущая задача +⚠ Разрешение/u);
});

test('композер показывает до пяти строк и подстраивает курсор под явные переводы', () => {
  const model = createScreen();

  setInput(model, 'одна\n日本\nтри\nчетыре\nпять\nшесть');
  const frame = assertFrame(model, 80, 16);

  assert.deepEqual(frame.input?.lines.map(({ text }) => text), ['日本', 'три', 'четыре', 'пять', 'шесть']);
  assert.deepEqual(frame.cursor, { row: 14, column: 10 });
  setInput(model, model.input, 7);
  assert.equal(assertFrame(model, 80, 16).cursor?.column, 9);
});

test('таблица, цитата и код сохраняют структуру и ширину на разных терминалах', () => {
  const model = createScreen();
  const answer = [
    '## Проверка',
    '| Поле | Итог |',
    '| :--- | ---: |',
    '| `a|b` | ✓ |',
    '| Путь \\| имя | [журнал](https://example.org) |',
    '> *Уточнение*',
    '```ts',
    '  const value = "// строка"; // комментарий',
    '```',
  ].join('\n');

  model.color = true;
  append(model, answer);
  append(model, '```sh\n  echo *буквально*\n```', 'normal', true);

  const wide = assertFrame(model, 80, 25).lines.join('\n');
  const plain = clean(wide);

  assert.match(plain, /Проверка *\n +\n *╭─+┬─+╮/u);
  assert.match(plain, /│ a\|b +│ +✓ │/u);
  assert.match(plain, /│ Путь \| имя +│ журнал │/u);
  assert.match(plain, /╰─+┴─+╯ *\n +\n *│  Уточнение/u);
  assert.match(wide, /\x1b\[3;38;2;224;229;237;48;2;45;41;38mУточнение/u);
  assert.match(wide, /\x1b\[38;2;197;168;238;48;2;30;36;46mconst/u);
  assert.match(wide, /\x1b\[38;2;155;166;182;48;2;30;36;46m\/\/ комментарий/u);
  assert.match(plain, /│    const value = "\/\/ строка"; \/\/ комментарий/u);
  assert.match(plain, /```sh *\n *echo \*буквально\* *\n *```/u);

  const narrow = clean(assertFrame(model, 14, 40).lines.join('\n'));

  assert.match(narrow, /Поле · a\|b/u);
  assert.match(narrow, /Итог · журнал/u);

  for (const width of [1, 7, 15, 27, 29, 32, 45, 112, 180]) {
    const decorated = assertFrame(model, width, 45);
    const bare = assertFrame({ ...model, color: false }, width, 45);

    assert.deepEqual(bare.lines, decorated.lines.map(clean));
  }
});

test('длинная команда раскрывается целиком, а статус и счётчик видны в одной строке', () => {
  const model = createScreen();
  const block = { tool: {
    name: 'bash', command: 'echo первая\necho вторая с длинным концом', status: 'completed', output: 'готово',
  }, expanded: false };

  model.entries.push(block);

  const collapsed = assertFrame(model, 42, 16);
  const [area] = collapsed.tools!;

  assert.equal(collapsed.tools?.length, 1);
  assert.match(clean(collapsed.lines[area!.row - 1]!), /✓ bash  echo первая… +▸ 1 строка/u);
  assert.equal(area!.right, 40);
  assert.doesNotMatch(clean(collapsed.lines.join('\n')), /длинным концом|готово/u);

  block.expanded = true;
  const expanded = clean(assertFrame(model, 42, 16).lines.join('\n'));

  assert.match(expanded, /✓ bash .+▾ 1 строка/u);
  assert.match(expanded, /│    echo первая +\n *│    echo вторая с длинным концом +\n[\s\S]*│    готово/u);
});

test('diff печатает только изменившиеся строки, первый кадр и смена высоты — полностью', () => {
  const model = createScreen('T');

  const first = render(model, 10, 4);

  assert.ok(full(first).startsWith('\x1b[H'));
  assert.equal(diff(null, first), full(first));

  append(model, 'b');
  const second = render(model, 10, 4);
  const output = diff(first.lines, second);

  assert.match(output, /\x1b\[2;1H\x1b\[K/u);
  assert.equal(output.includes('\x1b[1;1H'), false);
  assert.match(diff(first.lines, render({ ...model, modal: null }, 10, 5)), /^\x1b\[H/u);
});

class FakeTty extends PassThrough {
  isTTY = true;
  columns = 80;
  rows = 12;
  raw: boolean | null = null;

  setRawMode(mode: boolean): this {
    this.raw = mode;

    return this;
  }
}

/** Даёт контроллеру отрисоваться: schedule идёт через setImmediate. */
async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('view: кадр в alternate screen, выбор стрелками, ввод Enter, Ctrl+C → interrupt', async () => {
  const { createTuiView } = await import('../src/launcher/tui/view.ts');
  const stdin = new FakeTty();
  const stdout = new FakeTty();
  const stop = new AbortController();
  let interrupts = 0;
  let output = '';

  stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });

  const view = createTuiView({
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
    signal: stop.signal, onInterrupt: () => {
      interrupts += 1;
    }, title: 'DeepSeek Harness',
  });

  assert.ok(stdin.raw, 'raw mode включён');
  assert.ok(output.includes('\x1b[?1049h'), 'alternate screen');
  assert.ok(output.includes('\x1b[?2004h'), 'вставка объявлена терминалу');

  view.print('привет', 'user');
  view.hint('подсказка');
  await settle();
  assert.match(clean(output), /▌  привет[\s\S]*подсказка/u);

  // Модальный список: вторая стрелка вниз + Enter выбирает третий пункт.
  const picking = view.pick('Модель', [
    { value: 'a', name: 'Модель A' }, { value: 'b', name: 'Модель B' }, { value: 'c', name: 'Модель C' },
  ], 'a');

  await settle();
  assert.match(clean(output), /› 1\. Модель A[\s\S]*Модель B[\s\S]*Модель C/u);
  let redraw = output.length;

  stdin.write('\x1b[B');
  await settle();
  assert.match(clean(output.slice(redraw)), /› 2\. Модель B/u);
  assert.doesNotMatch(clean(output.slice(redraw)), /› 1\. Модель A/u);
  redraw = output.length;
  stdin.write('\x1b[6~');
  await settle();
  assert.match(clean(output.slice(redraw)), /› 3\. Модель C/u, 'PgDn перемещает выбор');
  stdin.write('\x1b[<0;8;2M\x1b[<0;8;2m');
  await settle();
  stdin.write('\x1b[<0;8;4M\x1b[<0;8;4m');
  assert.equal(await picking, 'b', 'клик по заголовку пропускается, а клик по строке выбирает её');

  // Ввод текста: Backspace и вставка; Enter закрывает ask.
  const answer = view.ask('Разрешить один раз? [y/N]');

  stdin.write('d');
  stdin.write('\u007f');
  stdin.write('\x1b[200~да\x1b[201~');
  await settle();
  const timeout = new Promise((resolve) => setTimeout(() => resolve('таймаут'), 50));

  assert.equal(await Promise.race([answer, timeout]), 'таймаут', 'Enter ещё не нажат');
  stdin.write('\r');
  assert.equal(await answer, 'да');
  await settle();
  assert.match(clean(output), /› да/u);

  const edited = view.ask('');

  stdin.write('а👩‍💻в\x1bOH\x1b[C\x1b[3~');
  await settle();
  stdin.write('\x1b[<0;8;10M\x1b[<0;8;10mб\x1bOF!\r');
  assert.equal(await edited, 'абв!', 'Delete убирает целый эмодзи, клик и End меняют позицию вставки');
  await settle();
  assert.match(clean(output), /▌  абв!/u, 'отправленный запрос остаётся виден в истории');
  const recalled = view.ask('');

  stdin.write('\x1b[A\r');
  assert.equal(await recalled, 'абв!', 'стрелка вверх возвращает отправленный запрос');

  // Ctrl+D выходит только при пустом вводе вне модального списка; модальное окно его поглощает.
  const again = view.pick('Ещё', [{ value: 'x', name: 'X' }]);

  stdin.write('\x04');
  await settle();
  assert.equal(interrupts, 0, 'Ctrl+D в модальном окне не закрывает чат');
  stdin.write('\x1b');
  assert.equal(await again, undefined, 'Esc закрывает список без выбора');
  stdin.write('\x04');
  assert.equal(interrupts, 1, 'Ctrl+D при пустом вводе передаётся чату');

  // Ctrl+C без активного вопроса передаётся чату; закрытие возвращает терминал.
  stdin.write('\x03');
  assert.equal(interrupts, 2);
  view.close();
  assert.equal(stdin.raw, false);
  assert.ok(output.includes('\x1b[?1049l'), 'alternate screen выключен');
  assert.ok(output.includes('\x1b[?2004l'), 'вставка возвращена оболочке');
  stop.abort();
});

test('view: колесо удерживает место в истории, части ответа складываются в строку', async (t) => {
  const { createTuiView } = await import('../src/launcher/tui/view.ts');
  const stdin = new FakeTty();
  const stdout = new FakeTty();
  let output = '';

  stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });

  const view = createTuiView({
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
    signal: new AbortController().signal, onInterrupt: () => {},
  });
  t.after(() => view.close());
  view.print(Array.from({ length: 30 }, (_, index) => `Строка ${index + 1}`).join('\n'));
  await settle();
  output = '';
  stdin.write('\x1b[<64;10;5M');
  await settle();
  assert.match(clean(output), /Строка 22[\s\S]*Строка 27[\s\S]*к новым сообщениям/u);

  output = '';
  view.stream('Часть ');
  view.stream('ответа');
  await settle();
  assert.doesNotMatch(clean(output), /Часть ответа/u);
  stdin.write('\x1b[6~');
  await settle();
  assert.match(clean(output), /Часть ответа/u);
});

test('view: Enter и клик меняют только выбранный блок, Enter в поле отправляет черновик', async (t) => {
  const { createTuiView } = await import('../src/launcher/tui/view.ts');
  const stdin = new FakeTty();
  const stdout = new FakeTty();
  let output = '';

  stdout.rows = 18;
  stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });

  const view = createTuiView({
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
    signal: new AbortController().signal, onInterrupt: () => {},
  });
  t.after(() => view.close());

  const shell = { name: 'bash', command: 'echo привет', status: 'in_progress', output: '' };
  const running = view.tool(shell);
  view.tool({ name: 'read', command: '', status: 'failed', output: 'ошибка чтения' });
  view.stream('Часть **ответа');
  view.tool({ ...shell, status: 'completed', output: 'первая\nвторая' }, running);
  view.stream('** модели');
  const pending = view.ask('');
  await settle();
  assert.match(clean(output), /✓ bash  echo привет +▸ 2 строки/u);
  assert.match(clean(output), /✗ read +▸ 1 строка[\s\S]*Часть ответа модели/u);
  assert.doesNotMatch(clean(output), /первая|вторая|ошибка чтения|\*\*/u);

  output = '';
  stdin.write('\t\r');
  await settle();
  assert.equal(running.expanded, true);
  assert.match(clean(output), /▐ ✓ bash +echo привет +▾ 2 строки[\s\S]*первая[\s\S]*вторая/u);
  assert.doesNotMatch(clean(output), /ошибка чтения/u);
  stdin.write('\x1b[<0;7;3M');
  await settle();
  assert.equal(running.expanded, false);

  stdin.write('строка\x1b\rещё\r');
  assert.equal(await pending, 'строка\nещё');
});

test('close с сообщением пишет ошибку в основной экран после выхода из alternate screen', async () => {
  const { createTuiView } = await import('../src/launcher/tui/view.ts');
  const stdin = new FakeTty();
  const stdout = new FakeTty();
  let output = '';

  stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });

  const view = createTuiView({
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
    signal: new AbortController().signal, onInterrupt: () => {},
  });

  // Кадр print перед close отбрасывается: alternate screen всё равно гаснет в тот же тик.
  view.print('Ошибка чата · потерянный кадр');
  view.close('Ошибка чата · ENOENT');
  await settle();

  const leave = output.indexOf('\x1b[?1049l');

  assert.ok(leave >= 0, 'alternate screen выключен');
  assert.equal(stdin.raw, false);
  assert.ok(output.slice(leave).includes('Ошибка чата · ENOENT\n'), 'сообщение видно в терминале');
  assert.ok(!output.slice(0, leave).includes('ENOENT'), 'ошибка не рисуется в гаснущем экране');
  assert.ok(!output.includes('потерянный кадр'), 'отложенный кадр после close не рисуется');
});

test('runTerminalChat: ошибка профиля видна в терминале после закрытия TUI, код выхода 1', async () => {
  const { runTerminalChat } = await import('../src/launcher/terminalChat.ts');
  const { parseChatOptions } = await import('../src/launcher/chatProfile.ts');
  const stdin = new FakeTty();
  const stdout = new FakeTty();
  let output = '';

  stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });

  // Чат читает process.stdin/stdout напрямую: на время проверки подменяем их фейковым tty.
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, 'stdout');
  const savedKey = process.env.DEEPSEEK_API_KEY;

  delete process.env.DEEPSEEK_API_KEY;
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
  Object.defineProperty(process, 'stdout', { value: stdout, configurable: true });

  try {
    const options = {
      ...parseChatOptions([]), provider: 'deepseek' as const, mode: 'read-only' as const, cwd: process.cwd(),
    };

    assert.equal(await runTerminalChat(options, []), 1);
  } finally {
    if (stdinDescriptor) {
      Object.defineProperty(process, 'stdin', stdinDescriptor);
    }

    if (stdoutDescriptor) {
      Object.defineProperty(process, 'stdout', stdoutDescriptor);
    }

    if (savedKey === undefined) {
      delete process.env.DEEPSEEK_API_KEY;
    } else {
      process.env.DEEPSEEK_API_KEY = savedKey;
    }
  }

  await settle();

  const leave = output.indexOf('\x1b[?1049l');

  assert.ok(leave >= 0, 'alternate screen выключен');
  assert.ok(output.slice(leave).includes('Ошибка чата · Для DeepSeek задайте DEEPSEEK_API_KEY.\n'));
  assert.ok(!output.slice(0, leave).includes('Ошибка чата'), 'ошибка не остаётся в погасшем экране');
});

test('runTerminalChat: инструмент, разрешение и восстановленный запрос', { timeout: 8000 }, async (t) => {
  const { runTerminalChat } = await import('../src/launcher/terminalChat.ts');
  const { parseChatOptions } = await import('../src/launcher/chatProfile.ts');
  const stdin = new FakeTty();
  const stdout = new FakeTty();
  const home = await mkdtemp(join(tmpdir(), 'dsh-tui-'));
  const savedIn = Object.getOwnPropertyDescriptor(process, 'stdin')!;
  const savedOut = Object.getOwnPropertyDescriptor(process, 'stdout')!;
  const savedEnv = process.env;
  let finishUpdate!: (response: Response) => void;
  const updateResponse = new Promise<Response>((resolve) => {
    finishUpdate = resolve;
  });
  t.mock.method(globalThis, 'fetch', () => updateResponse);
  let output = '';

  stdout.columns = 120;
  stdout.rows = 24;
  stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
  Object.defineProperty(process, 'stdout', { value: stdout, configurable: true });
  process.env = {
    ...savedEnv, DEEPSEEK_API_KEY: 'тестовый-ключ', GRIGDESK_DEEPSEEK_HOME: home, GRIGDESK_DSH_CACHE: home,
  };

  const worker = `
    import { createInterface } from 'node:readline';
    const sessionId = 'тест';
    const send = (message) => console.log(JSON.stringify({ jsonrpc: '2.0', ...message }));
    const update = (sessionUpdate, data, active = sessionId) => send({
      method: 'session/update', params: { sessionId: active, update: { sessionUpdate, ...data } },
    });
    const configOptions = [
      { id: 'model', currentValue: 'test-model' }, { id: 'reasoning_effort', currentValue: 'high' },
    ];
    let prompt;
    for await (const line of createInterface({ input: process.stdin })) {
      const message = JSON.parse(line);
      const { method, id } = message;
      if (method === 'initialize') {
        send({ id, result: { protocolVersion: 1 } });
      } else if (method === 'session/new') {
        send({ id, result: { sessionId, configOptions } });
      } else if (method === 'session/resume') {
        update('user_message_chunk', { content: { text: 'Сохранённый запрос **как есть**' } },
          message.params.sessionId);
        send({ id, result: { configOptions } });
      } else if (method === 'session/close') {
        send({ id, result: {} });
      } else if (method === 'session/prompt') {
        prompt = id;
        update('tool_call', {
          toolCallId: 'a', title: 'bash', rawInput: { command: 'echo **буквально**' }, status: 'pending',
        });
        update('tool_call_update', { toolCallId: 'a', status: 'in_progress' });
        send({ id: 'permission', method: 'session/request_permission', params: {
          sessionId, toolCall: { toolCallId: 'a' }, options: [{ kind: 'allow_once', optionId: 'once' }],
        } });
      } else if (id === 'permission') {
        update('agent_message_chunk', { content: { text: '**Ответ**' }, messageId: 'ответ' });
        update('tool_call_update', {
          toolCallId: 'a', status: message.result.outcome.optionId === 'once' ? 'completed' : 'failed',
          content: [{ type: 'content', content: { type: 'text', text: 'скрытая строка' } }],
        });
        send({ id: prompt, result: { stopReason: 'end_turn' } });
      }
    }
  `;

  /**
   * Дочерний процесс отвечает локально по ACP. Ждём конкретный кадр,
   * чтобы клавиша не пришла до активации соответствующего поля.
   */
  async function waitFor(pattern: RegExp): Promise<void> {
    const deadline = performance.now() + 3000;

    while (!pattern.test(clean(output)) && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.match(clean(output), pattern);
  }

  const options = parseChatOptions(['-p', 'deepseek', '--mode', 'workspace-write']);
  const chat = runTerminalChat(options, ['--input-type=module', '--eval', worker, '--'], {
    binaryVersion: '1.0.0', packageId: '1'.repeat(64), platform: 'linux', arch: 'x64',
  });

  try {
    await waitFor(/Спроси что угодно/u);
    stdin.write('Тестовая задача\r');
    await waitFor(/Разрешить один раз/u);
    assert.doesNotMatch(clean(output), /Доступна версия/u);
    finishUpdate(Response.json({
      format: 1, tag: 'v1.1.0', assets: [{ file: 'deepseek-linux-x64', packageId: '2'.repeat(64) }],
    }));
    await waitFor(/Доступна версия 1\.1\.0/u);
    assert.match(clean(output), /"command": "echo \*\*буквально\*\*"/u);
    assert.match(clean(output), /⚠ Требуется разрешение/u);
    stdin.write('да\r');
    await waitFor(/Готово · \d+с/u);
    assert.match(clean(output), /test-model · high · .* · Тестовая задача/u);
    assert.match(clean(output), /✓ bash  echo \*\*буквально\*\* +▸ 1 строка/u);
    assert.match(clean(output), /▌  Тестовая задача/u);
    assert.doesNotMatch(clean(output), /скрытая строка|\*\*Ответ\*\*/u);
    stdin.write('/resume сохранённая\r');
    await waitFor(/Сессия продолжена/u);
    assert.match(clean(output), /▌  Сохранённый запрос \*\*как есть\*\*/u);
    assert.doesNotMatch(clean(output), /Вы ›/u);
    stdin.write('/exit\r');
    assert.equal(await chat, 0);
  } finally {
    finishUpdate(new Response(null, { status: 503 }));
    stdin.write('\x03\x03');
    await chat;
    process.env = savedEnv;
    Object.defineProperty(process, 'stdin', savedIn);
    Object.defineProperty(process, 'stdout', savedOut);
    await rm(home, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { ESCAPE_TIMEOUT_MS, KeyDecoder, type Key } from '../src/launcher/tui/keys.ts';
import {
  append, createScreen, diff, full, render, setInput, type ScreenModel,
} from '../src/launcher/tui/screen.ts';
import { cells, clean, pad, wrap } from '../src/launcher/tui/text.ts';

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

  append(model, 'Вы › привет\n· Bash(ls)\nответ модели');
  setInput(model, 'строка ввода');

  const frame = assertFrame(model, 20, 10);

  // Заголовок, разделитель и подсказка на своих местах; текст не потерян.
  // Заголовок на 20 колонок обрезается по границе без выхода за кадр.
  assert.match(clean(frame.lines[0]!), /◆ DSH · DeepSeek/u);
  assert.match(clean(frame.lines.join('\n')), /Вы › привет[\s\S]*ответ модели/u);
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

  view.print('Вы › привет');
  view.hint('подсказка');
  await settle();
  assert.match(clean(output), /Вы › привет[\s\S]*подсказка/u);

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
  stdin.write('\x1b[<0;6;11M\x1b[<0;6;11mб\x1bOF!\r');
  assert.equal(await edited, 'абв!', 'Delete убирает целый эмодзи, клик и End меняют позицию вставки');
  await settle();
  assert.match(clean(output), /Вы › абв!/u, 'отправленный запрос остаётся виден в истории');
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
  assert.match(clean(output), /Строка 19[\s\S]*Строка 27[\s\S]*к новым сообщениям/u);

  output = '';
  view.stream('Часть ');
  view.stream('ответа');
  await settle();
  assert.doesNotMatch(clean(output), /Часть ответа/u);
  stdin.write('\x1b[6~');
  await settle();
  assert.match(clean(output), /Часть ответа/u);
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

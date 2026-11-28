import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { checkChatUpdate, type UpdateNotice, type UpdateTarget } from '../src/launcher/updateCheck.ts';

const current: UpdateTarget = {
  binaryVersion: '1.9.0', packageId: '1'.repeat(64), platform: 'linux', arch: 'x64',
};
const nextId = '2'.repeat(64);
const manifestUrl = 'https://github.com/EvilDevRu/grigdesk-dsh/releases/latest/download/manifest.json';
const notice = {
  version: '1.10.0', href: 'https://github.com/EvilDevRu/grigdesk-dsh/releases/tag/v1.10.0',
};

/**
 * Изолирует кэш проверок от пользовательской установки и восстанавливает
 * переменную окружения даже при сбое теста.
 */
async function cacheFixture(t: TestContext): Promise<string> {
  const cache = await mkdtemp(join(tmpdir(), 'dsh-update-'));
  const previous = process.env.GRIGDESK_DSH_CACHE;
  process.env.GRIGDESK_DSH_CACHE = cache;

  t.after(async () => {
    if (previous === undefined) {
      delete process.env.GRIGDESK_DSH_CACHE;
    } else {
      process.env.GRIGDESK_DSH_CACHE = previous;
    }

    await rm(cache, { recursive: true, force: true });
  });

  return cache;
}

function release(tag = 'v1.10.0', file = 'dsh-linux-x64', packageId = nextId): Response {
  return Response.json({ format: 1, tag, assets: [{ file, packageId }] });
}

test('проверка кэширует публичный манифест и работает при недоступной сети', async (t) => {
  const cache = await cacheFixture(t);
  const shown: (UpdateNotice | null)[] = [];
  const show = (item: UpdateNotice | null) => shown.push(item);
  const signal = new AbortController().signal;
  const fetchImpl = t.mock.fn<typeof fetch>(async () => release());

  await checkChatUpdate(current, signal, show, fetchImpl);
  assert.deepEqual(shown, [notice]);
  assert.equal(fetchImpl.mock.calls[0]?.arguments[0], manifestUrl);
  const headers = new Headers(fetchImpl.mock.calls[0]?.arguments[1]?.headers);
  assert.deepEqual([...headers], [['accept', 'application/json']]);

  await checkChatUpdate(current, signal, show, fetchImpl);
  assert.deepEqual(shown, [notice, notice]);
  assert.equal(fetchImpl.mock.callCount(), 1);

  const stored = JSON.parse(await readFile(join(cache, 'updates', 'linux-x64.json'), 'utf8'));
  t.mock.method(Date, 'now', () => stored.checkedAt + 21 * 60 * 60 * 1000);
  const offline = t.mock.fn<typeof fetch>(async () => {
    throw new Error('нет сети');
  });

  await checkChatUpdate(current, signal, show, offline);
  assert.equal(offline.mock.callCount(), 1);
  assert.deepEqual(shown, [notice, notice, notice]);

  await checkChatUpdate(current, signal, show, async () => release('v1.8.0'));
  assert.deepEqual(shown.slice(-2), [notice, null], 'отозванная версия исчезает после обновления кэша');
});

test('обновление сравнивает стабильный тег, identity и файл текущей платформы', async (t) => {
  const cache = await cacheFixture(t);
  const win = { ...current, platform: 'win32', arch: 'arm64' };
  const cases = [
    { target: { ...current, binaryVersion: '1.10.0-rc.1' }, response: release(), expected: [notice] },
    { target: { ...current, binaryVersion: '1.10.0+build' }, response: release(), expected: [null] },
    { target: { ...current, binaryVersion: '1.11.0' }, response: release(), expected: [null] },
    {
      target: current,
      response: release('v1.10.0', 'dsh-linux-x64', current.packageId),
      expected: [null],
    },
    { target: current, response: release('v1.10.0-beta.1'), expected: [] },
    { target: win, response: release(), expected: [null] },
    { target: win, response: release('v1.10.0', 'dsh-win32-arm64.exe'), expected: [notice] },
  ];

  for (const { target, response, expected } of cases) {
    await rm(join(cache, 'updates'), { recursive: true, force: true });
    const shown: (UpdateNotice | null)[] = [];

    const signal = new AbortController().signal;

    await checkChatUpdate(target, signal, (item) => shown.push(item), async () => response);
    assert.deepEqual(shown, expected, `${target.platform} ${target.binaryVersion}`);
  }
});

test('закрытие чата отменяет запрос и предотвращает позднее уведомление', async (t) => {
  await cacheFixture(t);
  const stop = new AbortController();
  const shown: (UpdateNotice | null)[] = [];
  let requestSignal: AbortSignal | null | undefined;
  const fetchImpl: typeof fetch = async (_, options) => {
    requestSignal = options?.signal;
    stop.abort();

    return release();
  };

  await checkChatUpdate(current, stop.signal, (item) => shown.push(item), fetchImpl);
  assert.equal(requestSignal?.aborted, true);
  assert.deepEqual(shown, []);

  const skipped = t.mock.fn<typeof fetch>(async () => release());
  const signal = new AbortController().signal;

  await checkChatUpdate({ ...current, platform: 'android' }, signal, () => {}, skipped);
  await checkChatUpdate({ ...current, binaryVersion: 'workspace' }, signal, () => {}, skipped);
  assert.equal(skipped.mock.callCount(), 0);
});

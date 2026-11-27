import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  dataHome, DEFAULT_DOWNLOAD_BASE, downloadBase, readCurrentElf, recordedDataHome, recordDataHome,
} from '../npm/scripts/lib/layout.mjs';
import { COMMANDS, installVersion, linkCommands } from '../npm/scripts/lib/install.mjs';
import { describePlatform } from '../npm/scripts/lib/platform.mjs';
import { forward, install } from '../npm/bin/launcher.mjs';
import {
  isPrereleaseVersion, NPM_DOWNLOAD_BASE, NPM_PACKAGE_FILES, npmVersionFromTag, stageNpmPackage,
} from '../scripts/npmPackage.mts';

const packageDirectory = fileURLToPath(new URL('../npm/', import.meta.url));

test('стадия npm-пакета получает версию тега, лицензию и только публикуемые файлы', async (t) => {
  const staging = path.join(os.tmpdir(), `dsh-npm-stage-${process.pid}`);

  t.after(async () => {
    await rm(staging, { recursive: true, force: true });
  });

  assert.equal(npmVersionFromTag('v1.2.3'), '1.2.3');
  assert.equal(npmVersionFromTag('v1.2.3-rc.1'), '1.2.3-rc.1');
  assert.throws(() => npmVersionFromTag('1.2.3'), /vX\.Y\.Z/u);
  assert.equal(isPrereleaseVersion('1.2.3-rc.1'), true);
  assert.equal(isPrereleaseVersion('1.2.3'), false);
  // CLI и postinstall обязаны смотреть на один адрес релизов.
  assert.equal(NPM_DOWNLOAD_BASE, DEFAULT_DOWNLOAD_BASE);

  const staged = await stageNpmPackage({
    source: packageDirectory,
    staging,
    version: '1.2.3',
    license: fileURLToPath(new URL('../LICENSE', import.meta.url)),
  });

  assert.equal(staged.directory, staging);
  assert.equal(JSON.parse(await readFile(staged.packageJson, 'utf8')).version, '1.2.3');
  assert.deepEqual((await readdir(staging)).sort(), [...NPM_PACKAGE_FILES, 'LICENSE'].sort());
  const manifest = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'));

  assert.equal(manifest.version, '0.0.0-dev');

  assert.deepEqual(Object.keys(manifest.bin).sort(), [...COMMANDS].sort());
  assert.equal(manifest.scripts.postinstall, 'node scripts/postinstall.mjs');
  for (const [command, entry] of Object.entries(manifest.bin) as [string, string][]) {
    const mode = (await lstat(path.join(packageDirectory, entry))).mode;

    assert.equal(mode & 0o111, 0o111, `${command} без exec-бита`);
  }

  // Корень данных записывается в пакет и читается без переменных окружения;
  // относительная или пустая запись не считается.
  assert.equal(await recordedDataHome(staging), null);
  await recordDataHome(staging, staging);
  assert.equal(await recordedDataHome(staging), staging);
  await writeFile(path.join(staging, 'scripts', 'data-home'), 'relative/path\n');
  assert.equal(await recordedDataHome(staging), null);

  // Checkout с 0.0.0-dev не притворяется опубликованной версией: install отказывает до сети.
  await assert.rejects(install({ env: { GRIGDESK_DEEPSEEK_DATA_HOME: staging }, fetchImpl: (() => {
    throw new Error('сеть не должна запрашиваться');
  }) as unknown as typeof fetch }), /не опубликована/u);
});

/**
 * Локальный релиз: manifest.json и ELF по счётчику запросов, чтобы доказать
 * отсутствие повторной загрузки уже установленной версии.
 */
async function fakeRelease(elf: Buffer, sha256 = createHash('sha256').update(elf).digest('hex')) {
  const requests: string[] = [];
  const manifest = {
    format: 1,
    tag: 'v1.2.3',
    assets: [{ file: 'deepseek-linux-x64', sha256, size: elf.length, platform: 'linux', arch: 'x64' }],
  };
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');

    if (request.url === '/v1.2.3/manifest.json') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(manifest));
    } else if (request.url === '/v1.2.3/deepseek-linux-x64') {
      response.end(elf);
    } else {
      response.statusCode = 404;
      response.end();
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();

  assert.ok(address && typeof address === 'object');

  return {
    base: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
  };
}

test('launcher glm и qwen открывают чат провайдера, служебные флаги идут ELF напрямую', () => {
  assert.deepEqual(forward('glm', []), ['chat', '-p', 'glm']);
  assert.deepEqual(forward('qwen', ['-m', 'qwen-plus', '--mode', 'read-only']),
    ['chat', '-p', 'qwen', '-m', 'qwen-plus', '--mode', 'read-only']);
  assert.deepEqual(forward('glm', ['chat', '-m', 'glm-5.3']), ['chat', '-p', 'glm', '-m', 'glm-5.3']);
  assert.deepEqual(forward('glm', ['chat', '-p', 'qwen']), ['chat', '-p', 'qwen']);
  assert.deepEqual(forward('glm', ['--version']), ['--version']);
  assert.deepEqual(forward('glm', ['login']), ['login', 'glm']);
  assert.deepEqual(forward('qwen', ['logout', '--all']), ['logout', '--all']);
  assert.deepEqual(forward('qwen', ['--runtime-info', '--json']), ['--runtime-info', '--json']);
  assert.equal(describePlatform('win32', 'x64').supported, false);
  assert.equal(describePlatform('linux', 'x64').asset, 'deepseek-linux-x64');
  assert.throws(() => downloadBase({ GRIGDESK_DEEPSEEK_DOWNLOAD_BASE: 'http://evil.example/x' }), /HTTPS/u);
  const loopback = { GRIGDESK_DEEPSEEK_DOWNLOAD_BASE: 'http://127.0.0.1:9/' };

  assert.equal(downloadBase(loopback), 'http://127.0.0.1:9');
  assert.throws(() => dataHome({ GRIGDESK_DEEPSEEK_DATA_HOME: 'relative' }), /абсолютный/u);
});

test('installVersion скачивает проверенный ELF, переключает current и не качает повторно', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-npm-install-'));
  const elf = Buffer.concat([Buffer.from('#!/bin/sh\nexit 0\n'), randomBytes(4096)]);
  const release = await fakeRelease(elf);
  const env = {
    GRIGDESK_DEEPSEEK_DATA_HOME: root,
    GRIGDESK_DEEPSEEK_DOWNLOAD_BASE: release.base,
  };
  const platform = describePlatform('linux', 'x64');
  const log = (line: string) => t.diagnostic(line);

  t.after(async () => {
    await release.close();
    await rm(root, { recursive: true, force: true });
  });

  const binary = await installVersion({ tag: 'v1.2.3', platform, env, log });

  assert.equal(binary, path.join(root, 'versions', 'v1.2.3', 'deepseek'));
  assert.deepEqual(await readFile(binary), elf);
  assert.equal((await lstat(binary)).mode & 0o111, 0o111);
  const partials = (await readdir(path.dirname(binary))).filter((name) => name.startsWith('.partial-'));

  assert.equal(partials.length, 0);
  assert.equal(await readlink(path.join(root, 'current')), 'versions/v1.2.3');
  assert.equal(await readCurrentElf(root), binary);
  assert.match(await readFile(path.join(path.dirname(binary), 'asset.json'), 'utf8'), /"tag": "v1.2.3"/u);
  assert.deepEqual(release.requests.sort(),
    ['/v1.2.3/deepseek-linux-x64', '/v1.2.3/manifest.json']);

  // Повторная установка: manifest читается, ELF уже на месте — загрузки нет.
  await installVersion({ tag: 'v1.2.3', platform, env, log: () => {} });
  assert.equal(release.requests.filter((url) => url.endsWith('deepseek-linux-x64')).length, 1);

  // Побитый ELF не выдаётся за установленный: receipt требует совпадения с manifest.
  await chmod(binary, 0o644);
  assert.equal(await readCurrentElf(root), null);
});

test('installVersion отвергает несовпавшую контрольную сумму и чужую ссылку current', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-npm-reject-'));
  const release = await fakeRelease(randomBytes(2048), '0'.repeat(64));
  const env = { GRIGDESK_DEEPSEEK_DATA_HOME: root, GRIGDESK_DEEPSEEK_DOWNLOAD_BASE: release.base };
  const platform = describePlatform('linux', 'x64');

  t.after(async () => {
    await release.close();
    await rm(root, { recursive: true, force: true });
  });

  await assert.rejects(installVersion({ tag: 'v1.2.3', platform, env }), /Контрольная сумма/u);
  await assert.rejects(lstat(path.join(root, 'versions', 'v1.2.3', 'deepseek')), { code: 'ENOENT' });
  assert.deepEqual(await readdir(path.join(root, 'versions', 'v1.2.3')), []);
  await assert.rejects(lstat(path.join(root, 'current')), { code: 'ENOENT' });

  // Обычный каталог с именем current — чужая запись, установщик её не перезаписывает.
  await mkdir(path.join(root, 'current'));
  const good = await fakeRelease(randomBytes(1024));
  await release.close();
  env.GRIGDESK_DEEPSEEK_DOWNLOAD_BASE = good.base;
  t.after(() => good.close());

  await assert.rejects(installVersion({ tag: 'v1.2.3', platform, env }),
    /занят обычным файлом или каталогом/u);
  assert.ok(await lstat(path.join(root, 'versions', 'v1.2.3', 'deepseek')));
  assert.ok((await lstat(path.join(root, 'current'))).isDirectory());
});

test('linkCommands связывает три команды с пакетом и не трогает чужой файл', async (t) => {
  const bin = await mkdtemp(path.join(os.tmpdir(), 'dsh-npm-bin-'));
  const env = { GRIGDESK_DEEPSEEK_BIN_DIR: bin, PATH: `/usr/bin:${bin}` };

  t.after(async () => {
    await rm(bin, { recursive: true, force: true });
  });

  const messages: string[] = [];
  await writeFile(path.join(bin, 'glm'), '#!/bin/sh\necho foreign\n');
  const directory = await linkCommands({ packageDirectory, env, log: (line) => messages.push(line) });

  assert.equal(directory, bin);
  assert.equal(await readlink(path.join(bin, 'deepseek')),
    path.join(packageDirectory, 'bin', 'deepseek.mjs'));
  assert.equal(await readlink(path.join(bin, 'qwen')), path.join(packageDirectory, 'bin', 'qwen.mjs'));
  assert.equal(await readFile(path.join(bin, 'glm'), 'utf8'), '#!/bin/sh\necho foreign\n');
  assert.ok(messages.some((line) => line.includes('glm') && line.includes('уже существует')));

  // Повторный запуск идемпотентен, ссылки не дублируются.
  await linkCommands({ packageDirectory, env, log: () => {} });
  assert.deepEqual((await readdir(bin)).sort(), ['deepseek', 'glm', 'qwen']);
});

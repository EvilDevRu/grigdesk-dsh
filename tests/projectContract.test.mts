import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { seaConfig } from '../lib/node/seaBuild.ts';

test('SEA config принимает assets пакета и сохраняет независимый NODE-LICENSE трекера', () => {
  const assets = {
    'manifest.json': 'manifest.json',
    'payload.zip': 'payload.zip',
  };
  const config = seaConfig(assets);

  assert.deepEqual(config.assets, {
    'NODE-LICENSE': 'LICENSE',
    ...assets,
  });
  assert.deepEqual(seaConfig().assets, { 'NODE-LICENSE': 'LICENSE' });
  assert.deepEqual(assets, {
    'manifest.json': 'manifest.json',
    'payload.zip': 'payload.zip',
  });
});

test('пакет DeepSeek закрепляет свои build deps без runtime npm dependencies', async () => {
  const manifest = JSON.parse(await readFile(
    new URL('../package.json', import.meta.url), 'utf8',
  ));
  const lock = JSON.parse(await readFile(
    new URL('../package-lock.json', import.meta.url), 'utf8',
  ));

  assert.equal(manifest.name, 'grigdesk-dsh');
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.dependencies, undefined);
  assert.deepEqual(manifest.devDependencies, {
    '@types/node': '22.20.1',
    esbuild: '0.25.12',
    fflate: '0.8.3',
    postject: '1.0.0-alpha.6',
    typescript: '5.9.3',
  });
  assert.equal(lock.packages[''].name, 'grigdesk-dsh');
  assert.equal(manifest.scripts.build, 'node scripts/buildBinary.mts');
  assert.equal(manifest.scripts.test, 'node scripts/test.mts');
  assert.equal(manifest.scripts.cli, 'node scripts/cli.mts');
  assert.deepEqual(manifest.bin, { 'grigdesk-dsh-ctl': 'bin/grigdesk-dsh-ctl' });
  assert.deepEqual(lock.packages[''].bin, manifest.bin);
  assert.equal(manifest.scripts.verify, 'node scripts/verify.mts');
});

test('команда grigdesk-dsh-ctl работает через символическую ссылку npm', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-ctl-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const launcher = fileURLToPath(new URL('../bin/grigdesk-dsh-ctl', import.meta.url));
  const link = path.join(directory, 'grigdesk-dsh-ctl');
  await symlink(path.relative(directory, launcher), link);

  const exec = promisify(execFile);
  const { stdout } = await exec(link, ['help'], { cwd: directory });

  assert.match(stdout, /Использование: grigdesk-dsh-ctl <команда>/u);
});

test('package runner отвергает неизвестные параметры до запуска набора тестов', async () => {
  const script = fileURLToPath(new URL('../scripts/test.mts', import.meta.url));

  await assert.rejects(promisify(execFile)(process.execPath, [script, '--unexpected']), (error: any) => {
    assert.equal(error.code, 2);
    assert.equal(error.stdout, '');
    assert.match(error.stderr, /Использование/u);

    return true;
  });
});

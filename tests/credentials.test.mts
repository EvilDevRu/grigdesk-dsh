import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Writable } from 'node:stream';

import {
  applyCredentials, credentialsPath, describeCredentials, grigdeskEnvPath, readCredentials, resolveCredential,
  writeCredentials,
} from '../src/launcher/credentials.ts';
import { runLogin } from '../src/launcher/login.ts';

/**
 * Песочница: свой HOME для ~/.deepseek, GrigDesk .env в GRIGDESK_HOME и фейковый stdin/stdout.
 */
async function sandbox(t: test.TestContext, grigdeskEnv = '') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-credentials-'));
  const home = path.join(root, 'home');
  const dataHome = path.join(root, 'grigdesk');
  const env: NodeJS.ProcessEnv = {
    HOME: home, GRIGDESK_HOME: dataHome, GRIGDESK_DEEPSEEK_HOME: path.join(home, '.deepseek'),
  };

  await mkdir(home);
  await mkdir(dataHome);

  if (grigdeskEnv) {
    await writeFile(path.join(dataHome, '.env'), grigdeskEnv, { mode: 0o600 });
  }

  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const output: string[] = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      output.push(String(chunk));
      callback();
    },
  }) as unknown as NodeJS.WriteStream;

  return {
    env,
    file: path.join(home, '.deepseek', 'credentials.json'),
    home,
    grigdesk: path.join(dataHome, '.env'),
    io: {
      stdin: { isTTY: false } as unknown as NodeJS.ReadStream,
      stdout,
      env,
      text: () => output.join(''),
    },
  };
}

test('ключ разрешается по приоритету env → login → GrigDesk .env, с алиасом DASHSCOPE', async (t) => {
  const box = await sandbox(t, 'DEEPSEEK_API_KEY=from-grigdesk-deepseek-0001\n'
    + 'DASHSCOPE_API_KEY="from-grigdesk-qwen-0002" # комментарий\nZAI_API_KEY=\n');

  assert.equal(grigdeskEnvPath(box.env), box.grigdesk);
  assert.equal(grigdeskEnvPath({ GRIGDESK_HOME: 'relative' }), null);

  await writeCredentials(box.file, { version: 1, values: { QWEN_API_KEY: 'from-login-qwen-0003' } });

  const sources = { env: box.env, file: box.file, grigdeskEnv: box.grigdesk };

  assert.deepEqual(await resolveCredential('DEEPSEEK_API_KEY', sources),
    { value: 'from-grigdesk-deepseek-0001', source: 'grigdesk' });
  assert.deepEqual(await resolveCredential('QWEN_API_KEY', sources),
    { value: 'from-login-qwen-0003', source: 'login' });
  assert.deepEqual(await resolveCredential('ZAI_API_KEY', sources), null);
  assert.equal((await readCredentials(box.file)).values.QWEN_API_KEY, 'from-login-qwen-0003');

  box.env.QWEN_API_KEY = ' from-terminal-qwen-0004 ';
  assert.deepEqual(await resolveCredential('QWEN_API_KEY', sources),
    { value: 'from-terminal-qwen-0004', source: 'env' });
  delete box.env.QWEN_API_KEY;
  await rm(box.file);

  assert.deepEqual(await resolveCredential('QWEN_API_KEY', sources),
    { value: 'from-grigdesk-qwen-0002', source: 'grigdesk' });
});

test('credentials.json пишется атомарно с правами 0600 в каталоге 0700 и без временных файлов', async (t) => {
  const box = await sandbox(t);
  const directory = path.dirname(box.file);

  await mkdir(directory);
  await chmod(directory, 0o755);
  await writeCredentials(box.file, { version: 1, values: { DEEPSEEK_API_KEY: 'sk-secret-value-1234' } });
  await writeCredentials(box.file, { version: 1, values: { DEEPSEEK_API_KEY: 'sk-secret-value-5678' } });

  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  assert.equal((await lstat(box.file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(directory), ['credentials.json']);
  assert.equal((await readCredentials(box.file)).values.DEEPSEEK_API_KEY, 'sk-secret-value-5678');
  // Посторонние и пустые значения при чтении отбрасываются.
  await writeFile(box.file, JSON.stringify({ version: 1, values: { ZAI_API_KEY: '  ', OTHER: 'x' } }));
  assert.deepEqual((await readCredentials(box.file)).values, {});
});

test('applyCredentials дополняет окружение, не перекрывая явные переменные терминала', async (t) => {
  const box = await sandbox(t, 'DEEPSEEK_API_KEY=grigdesk-deepseek-1234\n'
    + 'DASHSCOPE_API_KEY=grigdesk-qwen-1234\n');
  const env: NodeJS.ProcessEnv = { ...box.env, DEEPSEEK_API_KEY: 'terminal-deepseek-1234' };

  await writeCredentials(box.file, { version: 1, values: { ZAI_CODING_API_KEY: 'login-coding-1234' } });
  await applyCredentials(env);

  assert.equal(env.DEEPSEEK_API_KEY, 'terminal-deepseek-1234');
  assert.equal(env.ZAI_CODING_API_KEY, 'login-coding-1234');
  assert.equal(env.QWEN_API_KEY, 'grigdesk-qwen-1234');
  assert.equal(env.ZAI_API_KEY, undefined);
  assert.equal(env.GRIGDESK_DEEPSEEK_HOME, box.env.GRIGDESK_DEEPSEEK_HOME);
});

test('deepseek login --status показывает источник и хвост ключа, но не сам ключ', async (t) => {
  const box = await sandbox(t, 'DEEPSEEK_API_KEY=grigdesk-deepseek-abcd\n');
  assert.equal(credentialsPath(box.env), box.file);
  assert.equal(await runLogin(['--status'], box.io), 0);
  const text = box.io.text();

  assert.match(text, /abcd · \.env GrigDesk/u);
  assert.doesNotMatch(text, /grigdesk-deepseek-abcd/u);
  assert.match(text, /GLM · Z\.ai API\s+не задан/u);

  assert.equal(await runLogin(['logout', '--all'], box.io), 0);
  assert.match(box.io.text(), /не было таких ключей/u);
  assert.equal(await runLogin(['nonsense'], box.io), 2);
});

test('describeCredentials не раскрывает значения', async (t) => {
  const box = await sandbox(t);
  const env = { ...box.env, ZAI_API_KEY: 'zai-terminal-key-9876' };

  assert.deepEqual(await describeCredentials({ env, file: box.file }), {
    DEEPSEEK_API_KEY: null,
    ZAI_API_KEY: { source: 'env', preview: '…9876' },
    ZAI_CODING_API_KEY: null,
    QWEN_API_KEY: null,
  });
});

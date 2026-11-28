import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GLM_ROUTE_KEY_ENV } from '../lib/glm/contract.ts';
import { openChatAcp } from '../src/launcher/chatAcp.ts';
import { createChatProfile, parseChatOptions } from '../src/launcher/chatProfile.ts';

test('параметры терминального чата выбирают одно подключение, разрешения и рабочую папку', () => {
  const args = ['--glm-mode', 'coding-plan', '-C', 'папка проекта', '--mode', 'read-only'];
  const options = parseChatOptions(args, '/tmp');

  assert.equal(options.provider, 'glm');
  assert.equal(options.glmMode, 'coding-plan');
  assert.equal(options.cwd, '/tmp/папка проекта');
  assert.equal(options.mode, 'read-only');
  assert.equal(parseChatOptions(['--no-update-check']).noUpdateCheck, true);
  assert.throws(() => parseChatOptions(['-p', 'deepseek', '--glm-mode', 'api']), /применяется к GLM/u);
  assert.throws(() => parseChatOptions(['--last', '--resume', 'session']), /один способ продолжения/u);
  assert.throws(() => parseChatOptions(['--mode', 'danger-full-access']), /режим доступа/u);
});

test('терминальный профиль разделяет ключи и память GLM, Qwen и режимов доступа', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-terminal-profile-'));
  const values = {
    GRIGDESK_DEEPSEEK_HOME: root,
    DEEPSEEK_API_KEY: 'hidden-deepseek-key',
    ZAI_API_KEY: 'скрытый-ключ-обычного-api',
    ZAI_CODING_API_KEY: 'скрытый-ключ-подписки',
    QWEN_API_KEY: 'hidden-qwen-key',
    QWEN_BASE_URL: 'http://127.0.0.1:1/v1',
    QWEN_MODELS: 'qwen-plus,qwen-coder,qwen-plus',
  };
  const saved = Object.keys(values).map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, values);

  t.after(async () => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    await rm(root, { recursive: true, force: true });
  });

  const signal = new AbortController().signal;
  const api = await createChatProfile(parseChatOptions(['--glm-mode', 'api']), 'glm', 'read-only', signal);
  const planArgs = parseChatOptions(['--glm-mode', 'coding-plan']);
  const plan = await createChatProfile(planArgs, 'glm', 'read-only', signal);
  const qwen = await createChatProfile(parseChatOptions(['-p', 'qwen']), 'qwen', 'workspace-write', signal);

  assert.equal(api.env[GLM_ROUTE_KEY_ENV], values.ZAI_API_KEY);
  assert.equal(plan.env[GLM_ROUTE_KEY_ENV], values.ZAI_CODING_API_KEY);
  assert.equal(api.env.QWEN_API_KEY, undefined);
  assert.equal(qwen.env[GLM_ROUTE_KEY_ENV], undefined);
  assert.notEqual(api.env.DSH_HOME, plan.env.DSH_HOME);
  assert.match(qwen.env.DSH_HOME!, /qwen-.+\/workspace-write$/u);
  const patch = await readFile(qwen.args[3]!, 'utf8');
  assert.doesNotMatch(patch, /скрытый-ключ|hidden-qwen-key/u);
  assert.match(patch, /"baseURL":"http:\/\/127\.0\.0\.1:1\/v1"/u);
  assert.equal(patch.match(/qwen-plus/gu)?.length, 2);

  // Loader заменяет config строки целиком: штатная таблица presets обязана ехать вместе с defaultPreset.
  const patches = (value: string) => JSON.parse(value) as Array<Record<string, any>>;
  const byId = (value: string, id: string) => patches(value).find((entry) => entry.id === id);
  const qwenPatches = patches(patch);
  const permission = byId(patch, 'permission');

  assert.equal(permission?.config.defaultPreset, 'workspace-write');
  assert.deepEqual(Object.keys(permission?.config.presets).sort(),
    ['danger-full-access', 'read-only', 'workspace-write']);
  assert.equal(byId(patch, 'sandbox-policy')?.config.mode, 'workspace-write');
  assert.equal(byId(patch, 'sandbox-policy')?.config.workspaceRoot, process.cwd());
  assert.equal(byId(patch, 'acp')?.config.provider, 'qwen');
  assert.ok(qwenPatches.some((entry) => entry.insert?.[0]?.id === 'llm-pi-ai'
    && entry.insert[0].config?.providers?.qwen));
  for (const id of ['llm-deepseek', 'llm-deepseek-account', 'web-search-deepseek', 'session-title-llm',
    'schedule', 'goal-round-driver', 'tool-jobs', 'tool-workflow', 'workflow-worker-thread']) {
    assert.equal(byId(patch, id)?.disabled, true, `${id} остался включён без аккаунта DeepSeek`);
  }

  // Посторонние модельные ключи не доходят до чужого провайдера.
  assert.equal(qwen.env.DEEPSEEK_API_KEY, undefined);
  assert.equal(api.env.DEEPSEEK_API_KEY, undefined);
  assert.equal(api.env.QWEN_API_KEY, undefined);

  const readOnly = await createChatProfile(parseChatOptions(['-p', 'deepseek', '--mode', 'read-only']),
    'deepseek', 'read-only', signal);
  const readOnlyPatch = await readFile(readOnly.args[3]!, 'utf8');

  assert.equal(byId(readOnlyPatch, 'permission')?.config.defaultPreset, 'read-only');
  assert.equal(byId(readOnlyPatch, 'sandbox-policy')?.config.mode, 'read-only');
  assert.equal(byId(readOnlyPatch, 'acp'), undefined);
  assert.equal(byId(readOnlyPatch, 'llm-deepseek'), undefined);
  assert.doesNotMatch(readOnlyPatch, /llm-pi-ai|hidden-deepseek-key/u);
  assert.equal(readOnly.env.DEEPSEEK_API_KEY, values.DEEPSEEK_API_KEY);
  assert.equal(readOnly.env[GLM_ROUTE_KEY_ENV], undefined);
  await readOnly.cleanup();
  await qwen.cleanup();
  await assert.rejects(readFile(qwen.args[3]!, 'utf8'), { code: 'ENOENT' });

  const server = createServer((request, response) => {
    assert.equal(request.url, '/v1/models');
    assert.equal(request.headers.authorization, `Bearer ${values.QWEN_API_KEY}`);
    const data = [{ id: 'qwen3.8-plus' }, { id: 'qwen3-tts-flash' }, { id: 'qwen3-embedding' }];
    response.end(JSON.stringify({ data }));
  });
  t.after(() => {
    server.close();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  process.env.QWEN_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  delete process.env.QWEN_MODELS;
  const discovered = await createChatProfile(parseChatOptions(['-p', 'qwen']), 'qwen', 'read-only', signal);
  const listingPatch = await readFile(discovered.args[3]!, 'utf8');
  assert.match(listingPatch, /qwen3\.8-plus/u);
  assert.doesNotMatch(listingPatch, /qwen3-(?:tts|embedding)/u);
});

test('чат читает обновление и отвечает на разрешение во время одного хода', async (t) => {
  const worker = `
    const { createInterface } = require('node:readline');
    const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
    let request;
    createInterface({ input: process.stdin }).on('line', (line) => {
      const value = JSON.parse(line);
      if (value.method === 'session/prompt') {
        request = value;
        send({ method: 'session/update', params: { sessionId: 'probe', update: { title: 'Пример' } } });
        send({ method: 'session/request_permission', id: 'ask', params: { sessionId: 'probe' } });
      } else if (value.id === 'ask') {
        send({ id: request.id, result: value.result });
      }
    });
  `;
  const updates: unknown[] = [];
  const client = openChatAcp({
    command: process.execPath, args: ['--input-type=commonjs', '-e', worker], cwd: process.cwd(),
    env: {},
    update: (params) => {
      updates.push(params);
    },
    approve: async (params) => ({ received: params.sessionId }),
  });

  t.after(() => client.close());

  assert.deepEqual(await client.request('session/prompt', {}), { received: 'probe' });
  assert.deepEqual(updates, [{ sessionId: 'probe', update: { title: 'Пример' } }]);
});

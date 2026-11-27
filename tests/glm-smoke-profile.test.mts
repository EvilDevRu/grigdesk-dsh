import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { buildGlmChildEnv, resolveGlmRouteKey } from '../lib/glm/env.ts';
import { buildGlmSmokeProfile } from '../lib/glm/profile.ts';
import { parseSmokeArguments } from '../scripts/glmLiveSmoke.mts';

/**
 * Приватный одноразовый каталог теста: home и project smoke создаются внутри него
 * и удаляются после проверки, чтобы тест не зависел от настоящей папки данных.
 */
async function temporaryRoot(context: test.TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-smoke-profile-'));

  context.after(() => fs.rm(root, { recursive: true, force: true }));

  return root;
}

function privateModes(profile: { launchDir: string; overlayPath: string; settingsPath: string }) {
  return Promise.all([
    fs.stat(profile.launchDir).then((info) => info.mode & 0o777),
    fs.stat(profile.overlayPath).then((info) => info.mode & 0o777),
    fs.stat(profile.settingsPath).then((info) => info.mode & 0o777),
  ]);
}

test('профиль smoke строит приватные файлы и маршрут zai без шлюза grigdesk', async (context) => {
  const root = await temporaryRoot(context);
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const observer = path.join(root, 'observer.mjs');

  await fs.writeFile(observer, 'export const name = "observer";\n');

  const profile = await buildGlmSmokeProfile({
    cwd: project,
    home,
    mode: 'api',
    model: 'glm-5.3-flash',
    launchId: randomUUID(),
    observer,
  });
  const overlay = await fs.readFile(profile.overlayPath, 'utf8');
  const settings = await fs.readFile(profile.settingsPath, 'utf8');

  assert.equal(profile.launchDir, path.join(home, 'turns', path.basename(profile.launchDir)));
  assert.equal(profile.settingsPath, path.join(home, 'settings.yaml'));
  assert.equal(profile.observer, observer);
  assert.equal(settings, '{}\n');
  assert.deepEqual(await privateModes(profile), [0o700, 0o600, 0o600]);

  // Отступы повторяют серверный serializer GrigDesk: элемент списка, config, поля config.
  const expectedRows = [
    `- id: "settings"\n  config:\n    path: "${profile.settingsPath}"`,
    `- id: "sandbox-policy"\n  config:\n    mode: "workspace-write"\n    workspaceRoot: "${project}"`,
    '- id: "approval"\n  config:\n    policy: "ask"',
    '- id: "agent-presets"\n  config:\n    default: "grigdesk-glm"\n    includeUserRoot: false',
    '- id: "llm-deepseek"\n  disabled: true',
    '- id: "session-title-llm"\n  disabled: true',
    '- id: "agent-default-model"\n  config:\n    provider: "zai"\n    model: "glm-5.3-flash"',
    '- insert:\n    - id: "llm-pi-ai"\n      name: "@deepseek-ai/dsh-llm-pi-ai"\n'
      + '      config:\n        providers:\n          zai:\n'
      + '            baseURL: "https://api.z.ai/api/paas/v4"\n'
      + '            apiKeyEnv: "GRIGDESK_GLM_ROUTE_KEY"',
    `    - id: "grigdesk-glm-egress-guard"\n      name: "${pathToFileURL(observer).href}"`,
  ];

  assert.match(overlay, /^# grigdesk-dsh overlay[^\n]*\n/u);

  for (const row of expectedRows) {
    assert.ok(overlay.includes(row), `overlay должен содержать строку ${JSON.stringify(row)}`);
  }

  assert.match(overlay, /defaultPreset: "workspace-write"/u);

  // Шлюз политики и мост hooks сервера GrigDesk в профиль не входят.
  assert.doesNotMatch(overlay, /glm-gate/u);
  assert.doesNotMatch(overlay, /hooks-claude-code/u);
  assert.doesNotMatch(overlay, /PreToolUse/u);
});

test('coding-plan не задаёт baseURL, а наблюдатель необязателен', async (context) => {
  const root = await temporaryRoot(context);
  const profile = await buildGlmSmokeProfile({
    cwd: path.join(root, 'project'),
    home: path.join(root, 'home'),
    mode: 'coding-plan',
    model: 'glm-5.3-flash',
    launchId: 'launch-1',
  });
  const overlay = await fs.readFile(profile.overlayPath, 'utf8');

  assert.equal(profile.observer, null);
  assert.doesNotMatch(overlay, /baseURL/u);
  assert.doesNotMatch(overlay, /grigdesk-glm-egress-guard/u);
});

test('профиль smoke отклоняет относительные пути и недопустимые идентификаторы', async (context) => {
  const root = await temporaryRoot(context);
  const base = { cwd: root, home: path.join(root, 'home'), mode: 'api' as const, model: 'glm-5.3-flash' };

  await assert.rejects(
    buildGlmSmokeProfile({ ...base, cwd: 'relative/project', launchId: 'launch-1' }),
    /абсолютным путём/u,
  );
  await assert.rejects(
    buildGlmSmokeProfile({ ...base, launchId: '../escape' }),
    /launchId/u,
  );
  await assert.rejects(
    buildGlmSmokeProfile({ ...base, launchId: 'launch-1', model: 'glm\n5' }),
    /model/u,
  );
  await assert.rejects(
    buildGlmSmokeProfile({ ...base, launchId: 'launch-1', observer: 'observer.mjs' }),
    /абсолютным путём/u,
  );
});

test('ключ маршрута выбирается только из переменной своего режима', () => {
  const keys = { ZAI_API_KEY: 'key-api', ZAI_CODING_API_KEY: 'key-plan' };

  assert.equal(resolveGlmRouteKey('api', keys), 'key-api');
  assert.equal(resolveGlmRouteKey('coding-plan', keys), 'key-plan');

  assert.throws(
    () => resolveGlmRouteKey('api', { ZAI_CODING_API_KEY: 'key-plan' }),
    (error: unknown) => {
      const failure = error as Error & { code?: string };

      return failure.code === 'glm_key_missing'
        && failure.message.includes('ZAI_API_KEY') && failure.message.includes('api')
        && !failure.message.includes('key-plan');
    },
  );
  assert.throws(
    () => resolveGlmRouteKey('coding-plan', {}),
    (error: unknown) => (error as Error & { code?: string }).code === 'glm_key_missing'
      && (error as Error).message.includes('ZAI_CODING_API_KEY'),
  );
  assert.throws(
    () => resolveGlmRouteKey('api', { ZAI_API_KEY: 'bad\0key' }),
    (error: unknown) => (error as Error & { code?: string }).code === 'glm_key_invalid',
  );
});

test('окружение ребёнка — allowlist без loader-переменных и чужих ключей', () => {
  const env = buildGlmChildEnv({
    PATH: '/usr/bin',
    HOME: '/home/operator',
    LANG: 'C.UTF-8',
    DEEPSEEK_API_KEY: 'foreign-key',
    HTTP_PROXY: 'http://proxy.invalid',
    NODE_OPTIONS: '--require /tmp/evil.js',
    NODE_V8_COVERAGE: '/tmp/coverage',
    GRIGDESK_GLM_SEARCH_API_KEY: '   ',
  }, { dshHome: '/tmp/smoke-home', routeKey: 'route-key' });

  assert.deepEqual(env, {
    PATH: '/usr/bin',
    HOME: '/home/operator',
    LANG: 'C.UTF-8',
    DSH_HOME: '/tmp/smoke-home',
    DSH_TELEMETRY_DISABLED: '1',
    GRIGDESK_GLM_ROUTE_KEY: 'route-key',
    NO_COLOR: '1',
  });

  const withSearch = buildGlmChildEnv({ GRIGDESK_GLM_SEARCH_API_KEY: ' search-key ' }, {
    dshHome: '/tmp/smoke-home',
    routeKey: 'route-key',
    searchKey: 'search-key',
  });

  assert.equal(withSearch.GRIGDESK_GLM_SEARCH_API_KEY, 'search-key');
  assert.throws(() => buildGlmChildEnv({}, { dshHome: 'relative', routeKey: 'k' }), /абсолютным/u);
  assert.throws(() => buildGlmChildEnv({}, { dshHome: '/tmp/h', routeKey: '' }), /непустой/u);
});

test('аргументы smoke требуют абсолютный ELF и известный режим', () => {
  const binary = path.resolve('/tmp/deepseek');
  const args = (...rest: string[]) => ['--binary', binary, ...rest];

  assert.equal(parseSmokeArguments(args('--mode', 'api')).admit, false);
  assert.equal(parseSmokeArguments(args('--mode', 'coding-plan', '--admit', '--force')).force, true);
  assert.equal(parseSmokeArguments(args('--mode', 'api', '--model', 'glm-5.3')).model, 'glm-5.3');
  const withCache = parseSmokeArguments(args('--mode', 'api', '--cache-dir', '/tmp/cache'));

  assert.equal(withCache.cacheDir, '/tmp/cache');
  assert.equal(parseSmokeArguments(args('--mode', 'api')).model, 'glm-5.3-flash');

  const invalid: string[][] = [
    [],
    ['--binary', 'relative/deepseek', '--mode', 'api'],
    args('--mode', 'unknown'),
    args('--mode', 'api', '--unknown'),
    args('--mode', 'api', '--binary', binary),
    args('--mode'),
  ];

  for (const argv of invalid) {
    assert.throws(() => parseSmokeArguments(argv), /Использование/u, JSON.stringify(argv));
  }

  assert.throws(() => parseSmokeArguments(args('--mode', 'api', '--cache-dir', 'cache')), /абсолютным/u);
  assert.throws(() => parseSmokeArguments(args('--mode', 'api', '--model', 'bad model')), /--model/u);
});

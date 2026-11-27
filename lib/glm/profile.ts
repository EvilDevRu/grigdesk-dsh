import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildGlmRoute, GLM_GOAL_ROUND_LIMIT } from './contract.ts';
import type { GlmAccessMode } from './contract.ts';
import { GLM_SEARCH_KEY_ENV } from './env.ts';

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

export interface GlmSmokeProfileOptions {
  cwd: string;
  home: string;
  mode: GlmAccessMode;
  model: string;
  launchId: string;
  observer?: string;
}

export interface GlmSmokeProfile {
  overlayPath: string;
  launchDir: string;
  settingsPath: string;
  observer: string | null;
}

const AGENT_INSTRUCTIONS_MAX_BYTES = 262_144;

function yamlScalar(value: string | number | boolean | null): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (value === null) {
    return 'null';
  }

  return String(value);
}

/**
 * Минимальный YAML-сериализатор профиля: скаляры в JSON-кавычках, вложенные объекты
 * с отступом, элементы списка с продолжением полей первого ключа. Он повторяет
 * серверный serializer GrigDesk байт в байт, чтобы patch читался штатным Loader.
 */
function yamlLines(value: YamlValue, indent = 0): string[] {
  const prefix = ' '.repeat(indent);

  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return [`${prefix}- ${yamlScalar(entry as string | number | boolean | null)}`];
      }

      return Object.entries(entry).flatMap(([key, child], index) => {
        const itemPrefix = index === 0 ? `${prefix}- ` : `${prefix}  `;

        if (child && typeof child === 'object') {
          return [`${itemPrefix}${key}:`, ...yamlLines(child, indent + 4)];
        }

        return [`${itemPrefix}${key}: ${yamlScalar(child as string | number | boolean | null)}`];
      });
    });
  }

  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => {
      if (child && typeof child === 'object') {
        return [`${prefix}${key}:`, ...yamlLines(child, indent + 2)];
      }

      return [`${prefix}${key}: ${yamlScalar(child as string | number | boolean | null)}`];
    });
  }

  return [`${prefix}${yamlScalar(value)}`];
}

function serializeOverlay(value: YamlValue): string {
  return [
    '# grigdesk-dsh overlay живого smoke GLM для штатного профиля web. Генерируется на каждый запуск.',
    ...yamlLines(value),
    '',
  ].join('\n');
}

function assertAbsolute(label: string, value: string): void {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) {
    throw new TypeError(`Профиль smoke GLM: ${label} должен быть абсолютным путём`);
  }
}

async function privateFile(file: string, content: string): Promise<void> {
  await fs.writeFile(file, content, { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

/**
 * Строит server-owned overlay одного smoke-запуска GLM без шлюза grigdesk:glm-gate
 * и без hooks-claude-code: режим песочницы и approval задаются строками профиля,
 * а вопрос подтверждения инструмента закрывает сам smoke через $events.
 * DeepSeek-провайдер и заголовки выключены, маршрут zai вставляется плагином llm-pi-ai,
 * пользовательские корни preset-ов не читаются. Файлы создются приватными (0600/0700).
 */
export async function buildGlmSmokeProfile(options: GlmSmokeProfileOptions): Promise<GlmSmokeProfile> {
  const { cwd, home, launchId, observer = null } = options;

  assertAbsolute('cwd', cwd);
  assertAbsolute('home', home);

  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(launchId)) {
    throw new TypeError('Профиль smoke GLM: launchId должен быть коротким идентификатором');
  }

  if (observer !== null) {
    assertAbsolute('observer', observer);
  }

  if (!options.model.trim() || /[\r\n]/u.test(options.model)) {
    throw new TypeError('Профиль smoke GLM: model должен быть непустой строкой без переводов строк');
  }

  const launchDir = path.join(home, 'turns', launchId);
  const settingsPath = path.join(home, 'settings.yaml');
  const observerUrl = observer ? pathToFileURL(observer).href : null;

  await fs.mkdir(launchDir, { recursive: true, mode: 0o700 });
  await fs.chmod(launchDir, 0o700);

  // Пользовательская секция llm-pi-ai в настройках переопределила бы маршрут на каждый запрос.
  await privateFile(settingsPath, '{}\n');

  // Маршрут строится контрактом как обычная запись; сериализатору нужны только YAML-значения.
  const route = buildGlmRoute(options.mode) as { [key: string]: YamlValue };

  const overlay = serializeOverlay([
    { id: 'settings', config: { path: settingsPath } },
    { id: 'sandbox-policy', config: { mode: 'workspace-write', workspaceRoot: cwd } },
    { id: 'approval', config: { policy: 'ask' } },
    {
      id: 'permission',
      config: {
        presets: {
          'read-only': { sandbox: 'read-only', approval: 'ask' },
          'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
          'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
          'factory-state-only': { sandbox: 'read-only', approval: 'never' },
          'factory-workspace-write': { sandbox: 'workspace-write', approval: 'never' },
        },
        defaultPreset: 'workspace-write',
      },
    },
    { id: 'agent-instructions', config: { maxBytes: AGENT_INSTRUCTIONS_MAX_BYTES } },
    { id: 'agent-presets', config: { default: 'grigdesk-glm', includeUserRoot: false } },
    { id: 'goal', config: { defaultMaxGoalRounds: GLM_GOAL_ROUND_LIMIT } },
    { id: 'web-search-deepseek', config: { apiKeyEnv: GLM_SEARCH_KEY_ENV } },
    { id: 'llm-deepseek', disabled: true },
    { id: 'session-title-llm', disabled: true },
    { id: 'agent-default-model', config: { provider: 'zai', model: options.model } },
    {
      insert: [
        {
          id: 'llm-pi-ai',
          name: '@deepseek-ai/dsh-llm-pi-ai',
          config: { providers: { zai: route } },
        },
        ...(observerUrl
          ? [{ id: 'grigdesk-glm-egress-guard', name: observerUrl }]
          : []),
      ],
    },
  ]);
  const overlayPath = path.join(launchDir, 'overlay.yml');

  await privateFile(overlayPath, overlay);

  return { overlayPath, launchDir, settingsPath, observer };
}

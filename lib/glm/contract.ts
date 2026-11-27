import { canonicalJson } from '../core/canonicalJson.ts';
import { glmCompatibilityHash, type GlmCompatibilityRuntime } from '../node/glmCompatibility.ts';

export type GlmAccessMode = 'api' | 'coding-plan';

export type { GlmCompatibilityRuntime };

export const GLM_GOAL_ROUND_LIMIT = 16;
export const GLM_DEFAULT_EFFORT = 'high';
export const GLM_ALLOWED_MODES: readonly GlmAccessMode[] = Object.freeze(['api', 'coding-plan']);

/**
 * Переменная окружения процесса Harness, из которой плагин llm-pi-ai читает ключ маршрута.
 * В окружение ребёнка попадает только она: остальные модельные ключи не наследуются.
 */
export const GLM_ROUTE_KEY_ENV = 'GRIGDESK_GLM_ROUTE_KEY';

/**
 * Режим доступа задаёт человек в окружении или аргументе команды.
 * Неизвестное значение не превращается в неявный выбор режима.
 */
export function parseGlmAccessMode(value: unknown): GlmAccessMode | null {
  return value === 'api' || value === 'coding-plan' ? value : null;
}

/**
 * Один маршрут zai обслуживает оба режима доступа.
 * Адрес Coding Plan остаётся встроенным адресом библиотеки pi-ai.
 */
export function buildGlmRoute(mode: GlmAccessMode): Record<string, unknown> {
  return {
    ...(mode === 'api' ? { baseURL: 'https://api.z.ai/api/paas/v4' } : {}),
    apiKeyEnv: GLM_ROUTE_KEY_ENV,
    // Harness помечает кодом RATE_LIMIT и частоту, и окончательные отказы Z.ai по HTTP 429.
    // Передаём их вызывающей стороне сразу, чтобы она прочитала бизнес-код.
    retryPolicy: {
      mode: 'normal',
      maxRetries: 10,
      retryableCodes: ['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
    },
    modelOverrides: {
      'glm-4.7': { reasoningEfforts: { high: 'high' } },
      'glm-5-turbo': { reasoningEfforts: { high: 'high' } },
    },
  };
}

/**
 * Ключ режима выбирается только из его собственной переменной.
 * Другие модельные ключи никогда не становятся запасным источником.
 */
export function selectGlmServiceKey(
  mode: GlmAccessMode,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const name = mode === 'api' ? 'ZAI_API_KEY' : 'ZAI_CODING_API_KEY';

  return env[name] || null;
}

/**
 * Допуск относится к входам runtime и требованиям потребителя.
 * Платформа, путь и buildId не являются входами этого отпечатка, поэтому один
 * живой smoke допускает поставки всех платформ одной generation.
 */
export function glmCompatibilityIdentity(
  runtime: GlmCompatibilityRuntime,
  mode: GlmAccessMode,
  revisions: { profile: string; policy: string },
): string {
  return glmCompatibilityHash(runtime, mode, revisions);
}

export { canonicalJson };

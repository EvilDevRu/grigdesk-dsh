import path from 'node:path';

import { GLM_ROUTE_KEY_ENV, selectGlmServiceKey } from './contract.ts';
import type { GlmAccessMode } from './contract.ts';

type GlmEnv = Readonly<Record<string, string | undefined>>;

/** Служебное имя ключа web-search; в окружение ребёнка попадает только по явному выбору. */
export const GLM_SEARCH_KEY_ENV = 'GRIGDESK_GLM_SEARCH_API_KEY';

const PASSTHROUGH_ENV = ['PATH', 'HOME', 'GRIGDESK_HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR'] as const;
// Loader-переменные родителя не должны менять исполнение закреплённого worker Node.
const LOADER_ENV = ['NODE_OPTIONS', 'NODE_V8_COVERAGE'] as const;

export interface GlmChildEnvOptions {
  dshHome: string;
  routeKey: string;
  searchKey?: string;
}

/**
 * Ошибка доступа GLM несёт только публичный код: ни ключа, ни значения окружения в ней нет.
 * Код совпадает с причиной отказа, поэтому отчёт и сообщение говорят одно и то же.
 */
export function glmAccessError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/**
 * Ключ маршрута берётся только из собственной переменной выбранного режима.
 * Отчёт называет имя переменной и режим: по нему человек понимает, что именно дописать в .env,
 * не получив в выводе ни самого ключа, ни чужих переменных.
 */
export function resolveGlmRouteKey(mode: GlmAccessMode, env: GlmEnv): string {
  const name = mode === 'api' ? 'ZAI_API_KEY' : 'ZAI_CODING_API_KEY';
  const value = selectGlmServiceKey(mode, env);

  if (!value) {
    throw glmAccessError(
      'glm_key_missing',
      `Для режима GLM «${mode}» нужен ключ в переменной ${name} окружения или файла .env`,
    );
  }

  if (value.includes('\0')) {
    throw glmAccessError('glm_key_invalid', `Ключ ${name} содержит недопустимые символы`);
  }

  return value;
}

/**
 * Общий allowlist системных имён процесса Harness: без чужих ключей и proxy.
 * Metadata-зонд обходится им без ключа маршрута; значения с NUL не передаются.
 */
export function systemPassthroughEnv(source: GlmEnv): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of PASSTHROUGH_ENV) {
    const value = source[key];

    if (typeof value === 'string' && value.length > 0 && !value.includes('\0')) {
      env[key] = value;
    }
  }

  return env;
}

/**
 * Окружение процесса GLM строится allowlist-ом: системные имена, служебные флаги и один
 * ключ маршрута под служебным именем. Чужие модельные ключи, proxy и loader-переменные
 * родителя не наследуются, поэтому smoke не зависит от оболочки, из которой его запустили.
 */
export function buildGlmChildEnv(
  source: GlmEnv,
  options: GlmChildEnvOptions,
): Record<string, string> {
  if (!path.isAbsolute(options.dshHome)) {
    throw new TypeError('DSH_HOME должен быть абсолютным путём');
  }

  if (!options.routeKey || options.routeKey.includes('\0')) {
    throw new TypeError('Ключ маршрута GLM должен быть непустой строкой без NUL');
  }

  const env = systemPassthroughEnv(source);

  env.DSH_HOME = options.dshHome;
  env.DSH_TELEMETRY_DISABLED = '1';
  env[GLM_ROUTE_KEY_ENV] = options.routeKey;
  env.NO_COLOR = '1';

  const searchKey = options.searchKey?.trim();

  if (searchKey && !searchKey.includes('\0')) {
    env[GLM_SEARCH_KEY_ENV] = searchKey;
  }

  // Allowlist уже не пропускает эти имена; удаление закрепляет инвариант для будущих правок.
  for (const key of LOADER_ENV) {
    delete env[key];
  }

  return env;
}

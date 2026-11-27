import os from 'node:os';
import path from 'node:path';

/**
 * Корень кэшей, сборочных кандидатов и тестовых артефактов grigdesk-dsh.
 * Он отделён от папки данных GrigDesk: установленный ELF при запуске использует
 * `runtimes/deepseek` папки данных (контракт потребителя), а сборка и тесты
 * поставки не пишут в чужую папку данных.
 */
export interface DshCacheInput {
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
}

/**
 * `GRIGDESK_DSH_CACHE` — явный абсолютный путь; иначе XDG cache, иначе `~/.cache`.
 * Относительный явный путь не принимается: кэш участвует в атомарных rename.
 */
export function dshCacheHome(input: DshCacheInput = {}): string {
  const env = input.env ?? process.env;
  const home = input.home ?? os.homedir();
  const explicit = env.GRIGDESK_DSH_CACHE;

  if (explicit !== undefined && explicit !== '') {
    if (!path.isAbsolute(explicit)) {
      throw new Error('GRIGDESK_DSH_CACHE должен быть абсолютным путём');
    }

    return path.resolve(explicit);
  }

  const xdg = env.XDG_CACHE_HOME;

  return xdg ? path.resolve(xdg, 'grigdesk-dsh') : path.join(home, '.cache', 'grigdesk-dsh');
}

/**
 * Каталог артефактов внутри кэша: журналы сборки, smoke-отчёты, тестовые candidates.
 */
export function dshArtifactsPath(input: DshCacheInput = {}): string {
  return path.join(dshCacheHome(input), 'artifacts');
}

/**
 * Кэш pinned worker Node и runtime deps внутри корня кэша.
 * Один источник пути для CLI, workflow и тестового хелпера: расхождение здесь
 * приводило к тому, что CI готовил кэш не там, где его искали тесты.
 */
export function nodeCachePath(cacheHome: string): string {
  return path.join(cacheHome, 'node-cache');
}

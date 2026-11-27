import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Быстрый и SEA-наборы пакетов перечисляют только непосредственные *.test.mts.
 * Общий запуск всегда проходит через переданный сторож памяти репозитория.
 */
export interface PackageTestsOptions {
  root: string;
  runner: string;
  directory: string;
  /**
   * Последовательный набор (true) или параллельный; параллельность ограничивается
   * GRIGDESK_DSH_TEST_CONCURRENCY, потому что сборки ELF-кандидатов тяжёлые по памяти.
   */
  sequential?: boolean;
}

/**
 * Параметры сторожа памяти берутся из окружения: CI задаёт параллельность 1 и
 * свой бюджет RSS под размер runner, локальный прогон использует значения по умолчанию.
 */
export function packageTestConcurrency(env: Readonly<Record<string, string | undefined>>): number {
  const raw = Number(env.GRIGDESK_DSH_TEST_CONCURRENCY ?? 2);

  if (!Number.isInteger(raw) || raw < 1 || raw > 8) {
    throw new Error('GRIGDESK_DSH_TEST_CONCURRENCY должен быть целым от 1 до 8');
  }

  return raw;
}

export async function runPackageTests(options: PackageTestsOptions): Promise<number> {
  const entries = await readdir(options.directory, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw error;
  });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.test.mts'))
    .map((entry) => path.join(options.directory, entry.name)).sort();

  if (files.length === 0) {
    process.stderr.write(`Не найдено тестов в ${options.directory}.\n`);

    return 2;
  }

  const child = spawn('bash', [options.runner, '--test',
    `--test-concurrency=${options.sequential ? 1 : packageTestConcurrency(process.env)}`, ...files], {
    cwd: options.root,
    stdio: 'inherit',
    env: { ...process.env, NODE_TEST_MAX_RSS_MB: process.env.NODE_TEST_MAX_RSS_MB ?? '4096' },
  });

  return await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
}

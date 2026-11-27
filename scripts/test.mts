import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runPackageTests } from '../lib/node/packageTests.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * Единый запуск тестов пакета через сторож памяти репозитория.
 * Настоящие ELF-сценарии против серверного клиента остаются consumer-тестами GrigDesk,
 * поэтому отдельного SEA-набора здесь нет; неизвестный аргумент — код 2 до запуска.
 */
async function main(): Promise<void> {
  if (process.argv.length > 2) {
    process.stderr.write('Использование: node scripts/test.mts\n');
    process.exitCode = 2;

    return;
  }

  process.exitCode = await runPackageTests({
    root,
    runner: path.join(root, 'tests/run-node-tests-safe.sh'),
    directory: path.join(root, 'tests'),
  });
}

await main().catch((error: unknown) => {
  process.stderr.write(`Не удалось запустить тесты grigdesk-dsh: ${(error as Error).message}\n`);
  process.exitCode = 1;
});

import { materializeDeepSeekSnapshot } from './deepseekVendorManifest.ts';
import { deepSeekPackagePaths } from './paths.ts';

/**
 * Готовит снимок upstream Harness по `vendor/deepseek-harness/upstream.lock.json`.
 * Исходники не хранятся в Git: берётся проверенная копия (`--seed-dir`), локальный Git
 * с нужным commit (`--source-dir`) или сеть. Готовый кэш заменяется только целиком.
 */
function optionalDirectory(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);

  if (index === -1) {
    return undefined;
  }

  const value = argv[index + 1];

  if (!value || value.startsWith('--')) {
    throw new Error(`Использование: prepareUpstream.mts [--seed-dir <каталог> | --source-dir <git>]`);
  }

  return value;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const known = argv.filter((argument, index) => index % 2 === 0);
  const unsupported = known.filter((argument) => !['--seed-dir', '--source-dir'].includes(argument));

  if (unsupported.length > 0 || argv.length % 2 !== 0) {
    throw new Error('Использование: prepareUpstream.mts [--seed-dir <каталог> | --source-dir <git>]');
  }

  const manifest = await materializeDeepSeekSnapshot(deepSeekPackagePaths().vendorDir, {
    seedDir: optionalDirectory(argv, '--seed-dir'),
    sourceDir: optionalDirectory(argv, '--source-dir'),
  });

  process.stdout.write(`Снимок upstream готов: ${manifest.version} ${manifest.commit}\n`);
}

await main().catch((error: unknown) => {
  process.stderr.write(`Не удалось подготовить снимок upstream: ${(error as Error).message}\n`);
  process.exitCode = 1;
});

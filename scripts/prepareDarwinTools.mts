import fs from 'node:fs/promises';
import path from 'node:path';

import { prepareDarwinBuildTools } from './darwinBuildTools.mts';

/**
 * Готовит нативные инструменты darwin (process-identity и setsid) для сборки и проверки ELF
 * на Apple Silicon. Печатает строки `KEY=value` для `$GITHUB_ENV` либо JSON с `--json`:
 * сборщик читает helper и его SHA только из окружения, PATH не расширяется.
 */
function parseArguments(argv: string[]): { toolsRoot: string; json: boolean } {
  const flags = argv.filter((argument) => argument.startsWith('--'));
  const values = argv.filter((argument) => !argument.startsWith('--'));

  if (values.length !== 1 || flags.some((flag) => flag !== '--json')) {
    throw new Error('Использование: prepareDarwinTools.mts [--json] <пустой абсолютный каталог 0700>');
  }

  const toolsRoot = path.resolve(values[0]!);

  if (!path.isAbsolute(values[0]!)) {
    throw new Error('Каталог инструментов должен быть абсолютным путём');
  }

  return { toolsRoot, json: flags.includes('--json') };
}

async function main(): Promise<void> {
  const { toolsRoot, json } = parseArguments(process.argv.slice(2));

  await fs.mkdir(path.dirname(toolsRoot), { recursive: true });
  await fs.mkdir(toolsRoot, { mode: 0o700 });
  const physical = await fs.realpath(toolsRoot);

  if (physical !== toolsRoot) {
    throw new Error(`Каталог инструментов должен быть физическим путём: ${physical}`);
  }

  const tools = await prepareDarwinBuildTools({
    sourceRoot: await fs.realpath(new URL('..', import.meta.url).pathname),
    toolsRoot,
  });

  if (json) {
    process.stdout.write(`${JSON.stringify(tools, null, 2)}\n`);

    return;
  }

  process.stdout.write([
    `GRIGDESK_BUILD_PROCESS_HELPER=${tools.processIdentity.path}`,
    `GRIGDESK_BUILD_PROCESS_HELPER_SHA256=${tools.processIdentity.sha256}`,
    `GRIGDESK_TEST_SETSID_BIN=${tools.setsid.path}`,
    `GRIGDESK_BUILD_SETSID_SHA256=${tools.setsid.sha256}`,
    '',
  ].join('\n'));
}

await main().catch((error: unknown) => {
  process.stderr.write(`Нативные инструменты darwin не подготовлены: ${(error as Error).message}\n`);
  process.exitCode = 1;
});

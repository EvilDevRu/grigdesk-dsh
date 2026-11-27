import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKFLOWS = path.join(ROOT, '.github/workflows');

/**
 * Собирает все `run:`-блоки документа workflow в порядке появления.
 */
function runBlocks(node: unknown, found: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      runBlocks(item, found);
    }

    return;
  }

  if (node === null || typeof node !== 'object') {
    return;
  }

  const record = node as Record<string, unknown>;

  if (typeof record.run === 'string') {
    found.push(record.run);
  }

  for (const value of Object.values(record)) {
    runBlocks(value, found);
  }
}

/**
 * Выражения Actions заменяются пустой строкой, кроме `matrix.*` — им даётся
 * правдоподобное значение, чтобы bash не спотыкался на пустых аргументах.
 */
function shellView(block: string): string {
  return block
    .replace(/\$\{\{\s*matrix\.(os|target)\s*\}\}/gu, 'linux-x64')
    .replace(/\$\{\{[^}]*\}\}/gu, '');
}

/**
 * Локальная проверка workflow до push: YAML разбирается системным python (без
 * новых зависимостей), а каждый `run:`-блок проходит `bash -n`. Ошибка bash в CI
 * стоит полный прогон в 25 минут — здесь она видна за секунду.
 */
async function main(): Promise<void> {
  const files = (await readdir(WORKFLOWS)).filter((name) => name.endsWith('.yml')).sort();
  let failures = 0;

  for (const file of files) {
    const { stdout } = await run('python3', ['-c',
      'import json,sys,yaml; json.dump(yaml.safe_load(open(sys.argv[1])), sys.stdout)',
      path.join(WORKFLOWS, file)]);
    const blocks: string[] = [];

    runBlocks(JSON.parse(stdout), blocks);

    for (const [index, block] of blocks.entries()) {
      await run('bash', ['-n', '-c', shellView(block)]).catch((error: Error & { stderr?: string }) => {
        failures += 1;
        process.stderr.write(`${file} run[${index}]: ${String(error.stderr ?? error.message).trim()}\n`);
        return null;
      });
    }

    process.stdout.write(`${file}: ${blocks.length} run-блоков, bash -n пройден\n`);
  }

  if (failures > 0) {
    process.exitCode = 1;
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(`Проверка workflow не удалась: ${(error as Error).message}\n`);
  process.exitCode = 1;
});

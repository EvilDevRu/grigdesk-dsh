import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Сторож границ репозитория: каждый относительный импорт в src, scripts, lib и tests
 * должен разрешаться в файл внутри grigdesk-dsh. Имена прежнего дерева GrigDesk
 * (`shared/`, `server/`, каталог `deepseek/`) запрещены — репозиторий самодостаточен
 * и не возвращается к ссылкам на соседний checkout.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ROOTS = ['src', 'scripts', 'lib', 'tests'];
const EXTENSIONS = ['', '.ts', '.mts', '.mjs', '.js', '.cjs', '.json', '/index.ts'];
const IMPORT_PATTERN = /(?:from|import|export)\s*\(?\s*['"](\.[^'"\n]+)['"]/g;
const FORBIDDEN_SEGMENTS = new Set(['shared', 'server', 'deepseek']);
// Модуль появляется в staging сборки: buildRuntime бандлит lib/node/glmGateProtocol.ts
// в glmGateProtocol.mjs рядом с host gate, поэтому в исходнике файла нет.
const GENERATED = new Set([path.join(ROOT, 'src/host/glmGate.mjs') + ' -> ./glmGateProtocol.mjs']);

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const full = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (['node_modules', '.cache', 'vendor', 'upstream'].includes(entry.name)) {
        continue;
      }

      files.push(...await walk(full));
    } else if (/\.(?:ts|mts|mjs|js|cjs)$/u.test(entry.name)) {
      files.push(full);
    }
  }

  return files;
}

async function resolveSpecifier(from: string, specifier: string): Promise<string | null> {
  const base = path.resolve(path.dirname(from), specifier);

  for (const extension of EXTENSIONS) {
    const candidate = `${base}${extension}`;
    const info = await stat(candidate).catch(() => null);

    if (info?.isFile()) {
      return candidate;
    }
  }

  return null;
}

async function main(): Promise<void> {
  const files = (await Promise.all(ROOTS.map((root) => walk(path.join(ROOT, root))))).flat();
  const violations: string[] = [];

  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const pattern = new RegExp(IMPORT_PATTERN.source, 'g');
    let match = pattern.exec(text);

    while (match !== null) {
      const specifier = match[1]!;
      const resolved = await resolveSpecifier(file, specifier);

      if (resolved === null) {
        if (!GENERATED.has(`${file} -> ${specifier}`)) {
          violations.push(`${path.relative(ROOT, file)} -> ${specifier}: не разрешается`);
        }
      } else if (!resolved.startsWith(`${ROOT.endsWith('/') ? ROOT : `${ROOT}/`}`)) {
        violations.push(`${path.relative(ROOT, file)} -> ${specifier}: выходит за пределы репозитория`);
      } else {
        const segments = path.relative(ROOT, resolved).split(path.sep);

        if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment))) {
          violations.push(`${path.relative(ROOT, file)} -> ${specifier}: имя прежнего дерева GrigDesk`);
        }
      }

      match = pattern.exec(text);
    }
  }

  if (violations.length > 0) {
    process.stderr.write(`Границы импортов нарушены (${violations.length}):\n`);

    for (const violation of violations) {
      process.stderr.write(`  ${violation}\n`);
    }

    process.exitCode = 1;

    return;
  }

  process.stdout.write(`Границы импортов в порядке: ${files.length} файлов проверено.\n`);
}

await main();

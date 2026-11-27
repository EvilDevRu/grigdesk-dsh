import { appendFile, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface GlmSmokeHttpError {
  httpStatus: number | null;
  errorText: string;
}

/**
 * Собирает значения для маскирования, не меняя выбор ключа модели.
 * Короткие служебные флаги с TOKEN/KEY в имени не должны портить код ошибки 1113.
 */
export function glmSmokeSecrets(env: Readonly<Record<string, string | undefined>>): string[] {
  const selected = /^(?:ZAI_API_KEY|ZAI_CODING_API_KEY|GRIGDESK_GLM_ROUTE_KEY)$/u;

  return Object.entries(env)
    .filter(([name, value]) => /KEY|TOKEN|SECRET|PASSWORD/u.test(name) && value
      && (selected.test(name) || value.length >= 8))
    .map(([, value]) => value!);
}

/**
 * Полный текст ошибки сохраняется без усечения, но секреты, контакты и приватные пути скрываются.
 * Диагностическое тело не ограничается кратким сообщением runner-а.
 */
export function cleanGlmSmokeDiagnostic(
  value: unknown,
  secrets: readonly string[],
  roots: readonly string[],
): string {
  let text = String(value ?? '');
  const privateField = new RegExp([
    '("(?:api_?key|secret|token|phone|customerId|userId|accountId|request_id)"\\s*:\\s*)',
    '(?:"(?:\\\\.|[^"\\\\])*"|-?\\d+(?:\\.\\d+)?|true|false|null)',
  ].join(''), 'giu');

  for (const secret of secrets.filter(Boolean)) {
    text = text.replaceAll(secret, '<secret>');
  }

  for (const root of roots.filter(Boolean)) {
    text = text.replaceAll(root, '<path>');
  }

  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer <secret>')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '<email>')
    .replace(privateField, '$1"<private>"');
}

// Наблюдатель выполняется в worker Node ELF, поэтому плагин пишется самодостаточным .mjs:
// без импорта .ts-модулей репозитория и без зависимости от type stripping закреплённого worker.
// Секреты для маскирования берутся из process.env самого worker; ключ в файл не попадает.
const OBSERVER_SOURCE = [
  'export const name = "grigdesk-glm-egress-guard";',
  '/**',
  ' * Наблюдение за HTTP-ошибками модельного адреса не меняет маршрут и допуск модели.',
  ' * Записываются только неуспешные ответы и сетевые исключения; prompt и ответы не сохраняются.',
  ' */',
  'export async function apply() {',
  '  const original = globalThis.fetch;',
  '  const secrets = Object.entries(process.env)',
  '    .filter(([name, value]) => /KEY|TOKEN|SECRET|PASSWORD/u.test(name) && value && value.length >= 8)',
  '    .map(([, value]) => value);',
  '  const clean = (value) => {',
  '    let text = String(value ?? "");',
  '    for (const secret of secrets) {',
  '      text = text.replaceAll(secret, "<secret>");',
  '    }',
  '    return text',
  '      .replace(/Bearer\\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer <secret>")',
  '      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/giu, "<email>");',
  '  };',
  '  const record = async (httpStatus, errorText) => {',
  '    const line = JSON.stringify({ httpStatus, errorText: clean(errorText) }) + "\\n";',
  '    await appendFile(FILE, line, { mode: 0o600 });',
  '  };',
  '  const observed = async (input, init) => {',
  '    const url = input instanceof Request ? input.url : String(input);',
  '    let parsed;',
  '    try {',
  '      parsed = new URL(url);',
  '    } catch {',
  '      return original(input, init);',
  '    }',
  '    const modelRequest = parsed.origin === "https://api.z.ai"',
  '      && parsed.pathname.endsWith("/chat/completions");',
  '    if (!modelRequest) {',
  '      return original(input, init);',
  '    }',
  '    let response;',
  '    try {',
  '      response = await original(input, init);',
  '    } catch (error) {',
  '      await record(null, error instanceof Error ? error.message : String(error));',
  '      throw error;',
  '    }',
  '    if (!response.ok) {',
  '      await record(response.status, await response.clone().text());',
  '    }',
  '    return response;',
  '  };',
  '  globalThis.fetch = observed;',
  '}',
  '',
].join('\n');

/**
 * Пишет в приватный home одноразовый плагин наблюдателя и пустой журнал model-errors.jsonl.
 * Plug-in подключается строкой overlay grigdesk-glm-egress-guard и перехватывает fetch
 * настоящего процесса Harness: успешные ответы проходят без изменений.
 */
export async function writeGlmSmokeHttpObserver(home: string): Promise<{ file: string; plugin: string }> {
  const file = path.join(home, 'model-errors.jsonl');
  const plugin = path.join(home, 'model-observer.mjs');
  const source = [
    `import { appendFile } from "node:fs/promises";`,
    `const FILE = ${JSON.stringify(file)};`,
    OBSERVER_SOURCE,
  ].join('\n');

  await writeFile(file, '', { mode: 0o600 });
  await writeFile(plugin, source, { mode: 0o600 });

  return { file, plugin };
}

/**
 * Итоговый отчёт повторно очищает накопленные ошибки ключами родительского процесса.
 * Даже секрет из старого окружения не попадает в сохраняемый человеком JSON.
 */
export async function readGlmSmokeHttpErrors(
  file: string,
  env: Readonly<Record<string, string | undefined>>,
  root: string,
): Promise<GlmSmokeHttpError[]> {
  const secrets = glmSmokeSecrets(env);
  const text = await readFile(file, 'utf8');

  return text.split('\n').filter(Boolean).map((line) => {
    const item = JSON.parse(line) as GlmSmokeHttpError;

    return {
      httpStatus: item.httpStatus,
      errorText: cleanGlmSmokeDiagnostic(item.errorText, secrets, [root, os.homedir()]),
    };
  });
}

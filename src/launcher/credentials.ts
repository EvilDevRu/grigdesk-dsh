import { chmod, mkdir, open, readFile, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';

/**
 * Источники ключа терминального чата, от сильного к слабому: окружение терминала,
 * ~/.deepseek/credentials.json (deepseek login), файл настроек GrigDesk (.env папки
 * данных). GrigDesk называет ключ Qwen DASHSCOPE_API_KEY — алиас учитывается на каждом уровне.
 */
export type CredentialName = 'DEEPSEEK_API_KEY' | 'ZAI_API_KEY' | 'ZAI_CODING_API_KEY' | 'QWEN_API_KEY';

export interface Credentials {
  version: 1;
  values: Partial<Record<CredentialName, string>>;
}

export interface CredentialSources {
  env?: NodeJS.ProcessEnv;
  /** Файл deepseek login; отсутствие файла — пустой источник, а не ошибка. */
  file?: string;
  /** .env папки данных GrigDesk: читается только для имён, которых нет сильнее. */
  grigdeskEnv?: string;
}

const ALIASES: Partial<Record<CredentialName, readonly string[]>> = {
  QWEN_API_KEY: ['DASHSCOPE_API_KEY'],
};

export const CREDENTIAL_NAMES: readonly CredentialName[] = Object.freeze([
  'DEEPSEEK_API_KEY', 'ZAI_API_KEY', 'ZAI_CODING_API_KEY', 'QWEN_API_KEY',
]);

/**
 * ~/.deepseek — тот же каталог, где лежат сессии терминального чата.
 */
export function deepseekHome(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.GRIGDESK_DEEPSEEK_HOME ?? path.join(os.homedir(), '.deepseek');

  if (!path.isAbsolute(root)) {
    throw new Error('GRIGDESK_DEEPSEEK_HOME требует абсолютный путь.');
  }

  return root;
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(deepseekHome(env), 'credentials.json');
}

/**
 * Файл настроек GrigDesk читается по тем же правилам, что и сервером: GRIGDESK_HOME
 * или ~/.grigdesk. Файл принадлежит другому приложению, поэтому только читается.
 */
export function grigdeskEnvPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.GRIGDESK_HOME;

  if (override !== undefined && (!path.isAbsolute(override) || override === '/')) {
    return null;
  }

  return path.join(override ?? path.join(os.homedir(), '.grigdesk'), '.env');
}

export async function readCredentials(file: string): Promise<Credentials> {
  const text = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return '';
    }

    throw error;
  });

  if (!text.trim()) {
    return { version: 1, values: {} };
  }

  const parsed: unknown = JSON.parse(text);
  const holder = parsed && typeof parsed === 'object' ? (parsed as { values?: unknown }) : undefined;
  const values = holder?.values as Record<string, unknown> | undefined;
  const result: Credentials = { version: 1, values: {} };

  for (const name of CREDENTIAL_NAMES) {
    const value = values?.[name];

    if (typeof value === 'string' && value.trim()) {
      result.values[name] = value.trim();
    }
  }

  return result;
}

/**
 * Ключи пишутся атомарно в приватный каталог: временный файл 0600 и rename,
 * чтобы другой процесс не увидел половину документа и не получил его по наследству.
 */
export async function writeCredentials(file: string, credentials: Credentials): Promise<void> {
  const directory = path.dirname(file);

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${file}.${process.pid}.tmp`;
  const handle = await open(temporary, 'w', 0o600);

  await handle.writeFile(`${JSON.stringify(credentials, null, 2)}\n`);
  await handle.close();
  await rename(temporary, file);
}

/**
 * Возвращает источник ключа: само значение не логируется, источник — для /status.
 */
export async function resolveCredential(
  name: CredentialName,
  sources: CredentialSources = {},
): Promise<{ value: string; source: 'env' | 'login' | 'grigdesk' } | null> {
  const env = sources.env ?? process.env;

  for (const candidate of [name, ...(ALIASES[name] ?? [])]) {
    const value = env[candidate]?.trim();

    if (value) {
      return { value, source: 'env' };
    }
  }

  if (sources.file) {
    const saved = (await readCredentials(sources.file)).values[name]?.trim();

    if (saved) {
      return { value: saved, source: 'login' };
    }
  }

  const grigdesk = sources.grigdeskEnv ?? grigdeskEnvPath(env);

  if (grigdesk) {
    const text = await readFile(grigdesk, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return '';
      }

      throw error;
    });
    const parsed = text.trim() ? parseEnv(text) : {};

    for (const candidate of [name, ...(ALIASES[name] ?? [])]) {
      const value = parsed[candidate]?.trim();

      if (value) {
        return { value, source: 'grigdesk' };
      }
    }
  }

  return null;
}

/**
 * Дополняет окружение процесса launcher недостающими ключами. Явные переменные
 * терминала не перекрываются; дальше чат читает их как раньше.
 */
export async function applyCredentials(env: NodeJS.ProcessEnv): Promise<void> {
  const sources: CredentialSources = { env, file: credentialsPath(env) };

  for (const name of CREDENTIAL_NAMES) {
    const resolved = await resolveCredential(name, sources);

    if (resolved) {
      env[name] = resolved.value;
    }
  }
}

/**
 * Краткое состояние для /status и deepseek login --status: источник и последние
 * четыре символа, которых недостаточно для восстановления ключа.
 */
export async function describeCredentials(
  sources: CredentialSources = {},
): Promise<Record<CredentialName, { source: string; preview: string } | null>> {
  const result = {} as Record<CredentialName, { source: string; preview: string } | null>;

  for (const name of CREDENTIAL_NAMES) {
    const resolved = await resolveCredential(name, sources);

    result[name] = resolved
      ? { source: resolved.source, preview: `…${resolved.value.slice(-4)}` }
      : null;
  }

  return result;
}

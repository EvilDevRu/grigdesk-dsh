import { promises as fs } from 'node:fs';
import path from 'node:path';

export const NPM_PACKAGE_FILES = Object.freeze(['package.json', 'README.md', 'bin', 'scripts']);
export const NPM_PACKAGE_NAME = '@grigdesk/dsh';
/** Тот же адрес, что в npm/scripts/lib/layout.mjs: postinstall качает assets этого релиза. */
export const NPM_DOWNLOAD_BASE = 'https://github.com/EvilDevRu/grigdesk-dsh/releases/download';

/**
 * Версия npm-пакета — тег релиза без ведущего v: 1.2.3 или 1.2.3-rc.1.
 * Пакет другой версии, чем его релиз, установщик не скачает.
 */
export function npmVersionFromTag(tag: string): string {
  const match = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(tag);

  if (!match) {
    throw new Error(`Тег должен иметь вид vX.Y.Z или vX.Y.Z-rc.N: ${tag}`);
  }

  return match[1]!;
}

export function isPrereleaseVersion(version: string): boolean {
  return version.includes('-');
}

/**
 * Публикация имеет смысл только для релиза, чей manifest.json доступен по тому же
 * адресу, откуда его возьмёт postinstall. Список assets возвращается для отчёта.
 */
export async function assertReleaseDownloadable(tag: string, base = NPM_DOWNLOAD_BASE): Promise<string[]> {
  const url = `${base}/${encodeURIComponent(tag)}/manifest.json`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30000),
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Релиз ${tag} недоступен для npm-пакета (HTTP ${response.status}): ${url}`);
  }

  const manifest = await response.json() as { format?: unknown; assets?: unknown };
  const assets = Array.isArray(manifest.assets)
    ? manifest.assets.flatMap((entry) => (entry && typeof entry === 'object' && typeof entry.file === 'string'
      ? [entry.file] : [])) : [];

  if (manifest.format !== 1 || assets.length === 0) {
    throw new Error(`manifest.json релиза ${tag} не содержит assets`);
  }

  return assets;
}

/**
 * Собирает в staging ровно те файлы, которые уйдут в tarball, с версией тега и
 * лицензией репозитория. Исходный npm/package.json не меняется: 0.0.0-dev остаётся
 * признаком нераспубликованного checkout для launcher'а.
 */
export async function stageNpmPackage(options: {
  source: string;
  staging: string;
  version: string;
  license: string;
}): Promise<{ packageJson: string; directory: string }> {
  await fs.rm(options.staging, { recursive: true, force: true });
  await fs.mkdir(options.staging, { recursive: true, mode: 0o755 });

  for (const name of NPM_PACKAGE_FILES) {
    await fs.cp(path.join(options.source, name), path.join(options.staging, name), { recursive: true });
  }

  await fs.copyFile(options.license, path.join(options.staging, 'LICENSE'));

  const packageFile = path.join(options.staging, 'package.json');
  const manifest = JSON.parse(await fs.readFile(packageFile, 'utf8')) as Record<string, unknown>;

  if (manifest.name !== NPM_PACKAGE_NAME) {
    throw new Error(`npm/package.json объявляет чужое имя: ${String(manifest.name)}`);
  }

  manifest.version = options.version;
  await fs.writeFile(packageFile, `${JSON.stringify(manifest, null, 2)}\n`);

  return { packageJson: packageFile, directory: options.staging };
}

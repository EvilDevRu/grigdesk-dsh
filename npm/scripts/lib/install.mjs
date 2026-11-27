/**
 * Установка одной версии ELF: manifest релиза → asset платформы → поток во временный
 * файл с SHA-256 → атомарная публикация в versions/<tag> → ссылка current.
 * Уже установленная версия с совпавшей суммой не скачивается повторно.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  binaryPath, commandDirectory, currentLink, dataHome, downloadBase, versionDirectory,
} from './layout.mjs';

const MANIFEST_FORMAT = 1;
const MANIFEST_TIMEOUT_MS = 30000;
const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000;
export const COMMANDS = Object.freeze(['deepseek', 'glm', 'qwen']);

/**
 * Читает manifest.json релиза и выбирает asset платформы. Только полный SHA-256 и
 * положительный размер из манифеста дают право считать скачанные байты поставкой.
 */
export async function selectAsset({ tag, platform, env = process.env, fetchImpl = fetch }) {
  const url = `${downloadBase(env)}/${encodeURIComponent(tag)}/manifest.json`;
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Релиз ${tag} не отдал manifest.json (HTTP ${response.status}): ${url}`);
  }

  const manifest = await response.json();
  const asset = Array.isArray(manifest?.assets) ? manifest.assets.find((entry) => (
    entry && typeof entry === 'object' && entry.file === platform.asset
    && /^[a-f0-9]{64}$/u.test(String(entry.sha256))
    && Number.isSafeInteger(entry.size) && entry.size > 0
  )) : undefined;

  if (manifest?.format !== MANIFEST_FORMAT || !asset) {
    throw new Error(`В релизе ${tag} нет проверенного asset ${platform.asset} в manifest.json`);
  }

  return { asset, manifest };
}

/**
 * Поток во временный файл целевого каталога: rename в пределах одной файловой системы
 * атомарен, поэтому недокачанный или побитый файл никогда не становится deepseek.
 */
export async function downloadVerified({ source, directory, name, sha256, size, fetchImpl = fetch }) {
  await mkdir(directory, { recursive: true, mode: 0o755 });
  const partial = path.join(directory, `.partial-${randomBytes(6).toString('hex')}`);
  const response = await fetchImpl(source, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });

  if (!response.ok || !response.body) {
    throw new Error(`Не удалось скачать ${source} (HTTP ${response.status})`);
  }

  const declared = Number(response.headers.get('content-length'));
  const hash = createHash('sha256');
  let bytes = 0;
  const counter = new TransformStream({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      hash.update(chunk);
      controller.enqueue(chunk);
    },
  });

  try {
    await pipeline(response.body.pipeThrough(counter),
      createWriteStream(partial, { mode: 0o700, flags: 'wx' }));

    if (declared && declared !== bytes) {
      throw new Error(`Размер ${name} не совпал с объявленным: получено ${bytes}, ожидалось ${declared}`);
    }

    if (bytes !== size || hash.digest('hex') !== sha256) {
      throw new Error(`Контрольная сумма ${name} не совпала с manifest.json релиза`);
    }

    return partial;
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

/**
 * Ставит версию, если её ещё нет, и делает её действующей. Возвращает путь к ELF.
 * Рядом с бинарником хранится описание asset: повторный запуск без сети сразу
 * переключает current вместо повторной загрузки.
 * @param {{ tag: string, platform: { asset: string }, env?: NodeJS.ProcessEnv,
 *   log?: (line: string) => void, fetchImpl?: typeof fetch }} options
 */
export async function installVersion({
  tag, platform, env = process.env, log = () => {}, fetchImpl = fetch,
}) {
  const home = dataHome(env);
  const { asset } = await selectAsset({ tag, platform, env, fetchImpl });
  const binary = binaryPath(home, tag);
  const receipt = path.join(versionDirectory(home, tag), 'asset.json');
  const present = await readFile(receipt, 'utf8').then(() => asset.sha256, () => null);

  if (present === asset.sha256 && await executable(binary)) {
    log(`deepseek ${tag} уже установлен: ${binary}`);
  } else {
    const source = `${downloadBase(env)}/${encodeURIComponent(tag)}/${asset.file}`;

    log(`Скачиваю ${source} (${Math.ceil(asset.size / 1048576)} МБ)…`);
    const partial = await downloadVerified({
      source, directory: versionDirectory(home, tag), name: asset.file,
      sha256: asset.sha256, size: asset.size, fetchImpl,
    });

    await rm(binary, { force: true });
    await chmod(partial, 0o755);
    await rename(partial, binary);
    await writeReceipt(receipt, `${JSON.stringify({
      tag, file: asset.file, sha256: asset.sha256, size: asset.size,
    }, null, 2)}\n`);
    log(`Готово: ${binary}`);
  }

  await switchCurrent(home, tag);

  return binary;
}

/**
 * Ссылка current меняется через временную: читатель видит либо прежнюю версию,
 * либо новую целиком. Чужой файл или каталог с этим именем не перезаписывается.
 */
export async function switchCurrent(home, tag) {
  const link = currentLink(home);
  const temporary = `${link}.${randomBytes(6).toString('hex')}`;
  const info = await lstat(link).catch(() => null);

  if (info && !info.isSymbolicLink()) {
    throw new Error(`${link} занят обычным файлом или каталогом — уберите его вручную`);
  }

  await symlink(path.relative(home, versionDirectory(home, tag)), temporary);
  await rename(temporary, link);
}

/**
 * Команды в ~/.local/bin ссылаются на launcher'ы пакета. Чужой файл не трогаем,
 * собственную прежнюю ссылку (пакет переехал) заменяем.
 * @param {{ packageDirectory: string, env?: NodeJS.ProcessEnv, log?: (line: string) => void }} options
 */
export async function linkCommands({ packageDirectory, env = process.env, log = () => {} }) {
  const directory = commandDirectory(env);

  await mkdir(directory, { recursive: true, mode: 0o755 });

  for (const command of COMMANDS) {
    const file = path.join(directory, command);
    const target = path.join(packageDirectory, 'bin', `${command}.mjs`);
    const info = await lstat(file).catch(() => null);

    if (info?.isSymbolicLink()) {
      const current = await readFile(file).catch(() => null);

      if (current === target) {
        continue;
      }

      const pointsToUs = await realpathOrNull(file);

      if (!pointsToUs?.startsWith(`${path.resolve(packageDirectory)}${path.sep}`)) {
        log(`Пропускаю ${file}: ссылка ведёт на чужую программу`);
        continue;
      }

      await unlink(file);
    } else if (info) {
      log(`Пропускаю ${file}: уже существует ${info.isDirectory() ? 'каталог' : 'файл'}`);
      continue;
    }

    await symlink(target, file);
    log(`Команда ${command} → ${file}`);
  }

  return directory;
}

async function executable(file) {
  const info = await lstat(file).catch(() => null);

  return info?.isFile() && (info.mode & 0o111) !== 0;
}

async function writeReceipt(file, content) {
  const handle = await open(file, 'w', 0o644);

  await handle.writeFile(content);
  await handle.close();
}

async function realpathOrNull(file) {
  return await realpath(file).catch(() => null);
}

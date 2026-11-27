/**
 * Каталоги установки по образцу Claude Code: версии ELF лежат в data-home пользователя,
 * а команды — в ~/.local/bin. Переопределения через окружение нужны тестам и GrigDesk.
 */
import { access, constants, readFile, readlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_DOWNLOAD_BASE = 'https://github.com/EvilDevRu/grigdesk-dsh/releases/download';

/**
 * Корень данных ELF: $GRIGDESK_DEEPSEEK_DATA_HOME, иначе путь, записанный install
 * в пакет, иначе XDG_DATA_HOME/grigdesk-dsh или ~/.local/share/grigdesk-dsh.
 * Пользовательские данные чата в этот корень не входят.
 */
export function dataHome(env = process.env) {
  return absoluteOverride(env.GRIGDESK_DEEPSEEK_DATA_HOME, 'GRIGDESK_DEEPSEEK_DATA_HOME')
    ?? path.join(xdgDataHome(env), 'grigdesk-dsh');
}

/**
 * Установщик запоминает выбранный корень рядом с собой: повторный `install` и
 * обычный запуск находят версии без повторения переменных окружения.
 */
export async function recordedDataHome(packageDirectory) {
  const file = path.join(packageDirectory, 'scripts', 'data-home');
  const recorded = (await readFile(file, 'utf8').catch(() => '')).trim();

  return recorded && path.isAbsolute(recorded) ? recorded : null;
}

export async function recordDataHome(packageDirectory, home) {
  await writeFile(path.join(packageDirectory, 'scripts', 'data-home'), `${home}\n`);
}

/**
 * Каталог команд: $GRIGDESK_DEEPSEEK_BIN_DIR, иначе ~/.local/bin.
 */
export function commandDirectory(env = process.env) {
  return absoluteOverride(env.GRIGDESK_DEEPSEEK_BIN_DIR, 'GRIGDESK_DEEPSEEK_BIN_DIR')
    ?? path.join(os.homedir(), '.local', 'bin');
}

export function downloadBase(env = process.env) {
  const base = env.GRIGDESK_DEEPSEEK_DOWNLOAD_BASE ?? DEFAULT_DOWNLOAD_BASE;
  const url = new URL(base);

  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname)))
    || url.username || url.password || url.search || url.hash) {
    throw new Error('GRIGDESK_DEEPSEEK_DOWNLOAD_BASE требует HTTPS или HTTP на loopback '
      + 'без учётных данных и параметров');
  }

  return url.href.replace(/\/+$/u, '');
}

export function versionsDirectory(home) {
  return path.join(home, 'versions');
}

export function versionDirectory(home, tag) {
  return path.join(versionsDirectory(home), tag);
}

export function binaryPath(home, tag) {
  return path.join(versionDirectory(home, tag), 'deepseek');
}

export function currentLink(home) {
  return path.join(home, 'current');
}

/**
 * Действующая версия — символическая ссылка current на каталог versions/<tag>.
 * Обычный файл или каталог с этим именем считается чужой записью и не читается как наша.
 */
export async function readCurrentElf(home) {
  let target;

  try {
    target = await readlink(currentLink(home));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EINVAL') {
      return null;
    }

    throw error;
  }

  const binary = path.join(path.resolve(path.dirname(currentLink(home)), target), 'deepseek');

  try {
    await access(binary, constants.X_OK);

    return binary;
  } catch {
    return null;
  }
}

export function isLoopback(hostname) {
  return ['127.0.0.1', '[::1]', 'localhost'].includes(hostname);
}

function xdgDataHome(env) {
  const xdg = env.XDG_DATA_HOME;

  return xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.local', 'share');
}

function absoluteOverride(value, name) {
  if (value === undefined) {
    return null;
  }

  if (!path.isAbsolute(value) || value === '/') {
    throw new Error(`${name} требует абсолютный путь`);
  }

  return value;
}

import { getSystemErrorName } from 'node:util';

let bindings;

/**
 * Bionic публикует синхронизированный файл атомарно с RENAME_NOREPLACE.
 * Занятый путь сохраняется, а вызывающий код синхронизирует каталог как прежде.
 */
export async function publishNewFileAndroid(source, target) {
  if (!bindings) {
    const { default: koffi } = await import('koffi');
    const libc = koffi.load('libc.so');

    bindings = { libc, rename: libc.func('int renameat2(int, const char *, int, const char *, unsigned int)'),
      errno: koffi.errno };
  }

  const fdCwd = -100;
  const noReplace = 1;

  if (bindings.rename(fdCwd, source, fdCwd, target, noReplace) === 0) {
    return;
  }

  const errno = bindings.errno();
  const code = errno > 0 ? getSystemErrorName(-errno) : 'EIO';

  throw Object.assign(new Error(`renameat2 ${code}: ${source} -> ${target}`), {
    code, errno: -errno, syscall: 'renameat2', path: source, dest: target,
  });
}

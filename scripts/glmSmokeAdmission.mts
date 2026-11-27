import { promises as fs } from 'node:fs';
import path from 'node:path';

import { acquireDirectoryLock } from '../lib/node/directoryLock.ts';
import { syncDirectory, withWorkDirectory } from '../lib/node/files.ts';
import type { GlmAccessMode } from '../lib/glm/contract.ts';

export interface GlmSmokeAdmission {
  mode: GlmAccessMode;
  compatibility: string;
}

/**
 * Сохраняет результат живой проверки в списке выпуска, заменяя записи только своего режима.
 * Блокировка охватывает чтение и замену файла, чтобы параллельные записи не теряли соседний
 * режим; файл подменяется атомарным rename с сохранением прежних прав доступа.
 */
export async function writeGlmSmokeAdmission(file: string, admission: GlmSmokeAdmission): Promise<void> {
  const target = await fs.realpath(file);
  const directory = path.dirname(target);
  const lock = await acquireDirectoryLock(`${target}.lock`);

  try {
    const current = JSON.parse(await fs.readFile(target, 'utf8')) as {
      admission?: Array<{ mode: string; compatibility: string }>;
    };

    if (!Array.isArray(current.admission)) {
      throw new TypeError('Файл compatibility не содержит список admission');
    }

    current.admission = [
      ...current.admission.filter((entry) => entry.mode !== admission.mode),
      { mode: admission.mode, compatibility: admission.compatibility },
    ];

    const permissions = (await fs.stat(target)).mode & 0o777;

    await withWorkDirectory(directory, async (work) => {
      const next = path.join(work, path.basename(target));

      await fs.writeFile(next, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600, flush: true });
      await fs.chmod(next, permissions);
      await fs.rename(next, target);
      await syncDirectory(directory);
    });
  } finally {
    await lock.release();
  }
}

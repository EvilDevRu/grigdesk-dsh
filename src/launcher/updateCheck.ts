import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { seaHostTarget } from '../../lib/node/nodeRuntime.ts';
import { dshCacheHome } from '../../lib/runtime/dshHome.ts';
import { releaseAssetName } from '../../lib/runtime/executable.ts';
import { record } from './chatAcp.ts';

export interface UpdateTarget {
  binaryVersion: string;
  packageId: string;
  platform: string;
  arch: string;
}

export interface UpdateNotice {
  version: string;
  href: string;
}

interface Release {
  tag: string;
  packageId: string;
}

interface CachedCheck {
  checkedAt: number;
  release: Release | null;
}

const releases = 'https://github.com/EvilDevRu/grigdesk-dsh/releases';
const checkInterval = 20 * 60 * 60 * 1000;
const coreVersion = String.raw`(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)`;
const preRelease = String.raw`[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*`;
const versionPattern = new RegExp(`^v?${coreVersion}(-${preRelease})?(?:\\+${preRelease})?$`, 'u');
const stableTag = new RegExp(`^v${coreVersion}$`, 'u');
const packageId = /^[a-f0-9]{64}$/u;

/**
 * Из кэша и ответа принимаются только стабильный тег и identity сборки.
 * Адрес для терминальной ссылки строится из константы и проверенного тега.
 */
function releaseIdentity(tag: unknown, id: unknown): Release | null {
  return typeof tag === 'string' && stableTag.test(tag) && typeof id === 'string' && packageId.test(id)
    ? { tag, packageId: id } : null;
}

/**
 * Сравнивает числовые части версии. Стабильный выпуск того же номера новее
 * предварительного, а тега переизданного текущего бинарника для показа недостаточно.
 */
function noticeFor(current: RegExpExecArray, id: string, release: Release | null): UpdateNotice | null {
  if (!release || release.packageId === id) {
    return null;
  }

  const match = stableTag.exec(release.tag)!;
  let newer = Boolean(current[4]);

  for (const index of [1, 2, 3]) {
    const latest = BigInt(match[index]!);
    const installed = BigInt(current[index]!);

    if (latest !== installed) {
      newer = latest > installed;
      break;
    }
  }

  return newer ? { version: release.tag.slice(1), href: `${releases}/tag/${release.tag}` } : null;
}

/**
 * Отсутствующий и повреждённый кэш считаются первым запуском. Пустой результат
 * предыдущей проверки хранится явно, например если для этой платформы нет файла.
 */
async function readCheck(file: string): Promise<CachedCheck | undefined> {
  try {
    const { checkedAt, release } = record(JSON.parse(await readFile(file, 'utf8')));
    const identity = record(release);
    const checkedRelease = releaseIdentity(identity.tag, identity.packageId);

    if (typeof checkedAt === 'number' && Number.isSafeInteger(checkedAt)
      && checkedAt > 0 && (release === null || checkedRelease)) {
      return { checkedAt, release: checkedRelease };
    }
  } catch {
    // Ошибка кэша не мешает чату и будет исправлена успешной проверкой.
  }
}

/**
 * Параллельные запуски пишут отдельные временные файлы. Терминал видит
 * только полный результат последней завершившейся проверки.
 */
async function writeCheck(file: string, value: CachedCheck): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;

  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/**
 * Запрашивает публичное описание стабильного выпуска и выбирает файл цели.
 * Манифест для другой платформы не считается обновлением этого терминала.
 */
async function fetchRelease(
  assetName: string, signal: AbortSignal, fetchImpl: typeof fetch,
): Promise<Release | null> {
  const response = await fetchImpl(`${releases}/latest/download/manifest.json`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  });

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Манифест стабильного выпуска недоступен');
  }

  const { format, tag, assets } = record(await response.json());

  if (format !== 1 || typeof tag !== 'string' || !stableTag.test(tag) || !Array.isArray(assets)) {
    throw new Error('Некорректный манифест стабильного выпуска');
  }

  const asset = assets.map(record).find(({ file }) => file === assetName);

  return releaseIdentity(tag, asset?.packageId);
}

/**
 * Сначала показывает сохранённый результат, затем при необходимости обновляет
 * его в фоне. Офлайн, таймаут и закрытый терминал не влияют на работу чата.
 */
export async function checkChatUpdate(
  current: UpdateTarget, signal: AbortSignal, show: (notice: UpdateNotice | null) => void,
  fetchImpl = fetch,
): Promise<void> {
  const installed = versionPattern.exec(current.binaryVersion);

  if (!installed || signal.aborted) {
    return;
  }

  try {
    const target = seaHostTarget(current.platform, current.arch);
    const file = path.join(dshCacheHome(), 'updates', target + '.json');
    const cached = await readCheck(file);

    signal.throwIfAborted();

    if (cached) {
      show(noticeFor(installed, current.packageId, cached.release));

      const age = Date.now() - cached.checkedAt;

      if (age >= 0 && age < checkInterval) {
        return;
      }
    }

    const asset = releaseAssetName(current.platform, current.arch);
    const release = await fetchRelease(asset, signal, fetchImpl);

    signal.throwIfAborted();
    show(noticeFor(installed, current.packageId, release));
    await writeCheck(file, { checkedAt: Date.now(), release });
  } catch {
    // Проверка обновлений работает независимо от соединения с моделью.
  }
}

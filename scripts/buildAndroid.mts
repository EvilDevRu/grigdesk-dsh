import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { decodeDeepSeekRuntimeInfo } from '../lib/chat/deepSeekBinary.ts';
import { withWorkDirectory } from '../lib/node/files.ts';
import { sha256File } from '../lib/node/hash.ts';
import { assertUntracked, SEA_FUSE } from '../lib/node/nodeRuntime.ts';
import { injectSea, seaConfig } from '../lib/node/seaBuild.ts';
import { readWorkerArtifact } from '../src/runtime/artifact.ts';
import { manifestBytes } from '../src/runtime/metadata.ts';
import { androidTargets, prepareAndroidGeneration, type AndroidAbi } from './androidGeneration.mts';
import { bundleBinaryEntries } from './buildBinary.mts';
import { packBinaryGeneration, sealBinaryPayload } from './buildPayload.mts';
import { deepSeekPackagePaths } from './paths.ts';
import { readPreparedRuntimeDependencies } from './prepareRuntimeDeps.mts';

const run = promisify(execFile);
const paths = deepSeekPackagePaths();

/**
 * Postject записывает новый PT_LOAD с p_align 4 КиБ. Для ARM64 сохраняем 16 КиБ,
 * только если файловое и виртуальное смещения секции уже согласованы.
 */
async function alignAndroidSea(file: string): Promise<void> {
  const handle = await open(file, 'r+');

  try {
    const elf = Buffer.alloc(64);

    if ((await handle.read(elf, 0, elf.length, 0)).bytesRead !== elf.length
      || elf.readUInt32BE(0) !== 0x7f454c46 || elf[4] !== 2 || elf[5] !== 1 || elf.readUInt16LE(54) !== 56) {
      throw new Error('Неожиданный ELF Android после postject');
    }

    const start = elf.readBigUInt64LE(32);
    const count = elf.readUInt16LE(56);
    const program = Buffer.alloc(56);

    for (let index = 0; index < count; index++) {
      const offset = Number(start) + index * program.length;

      if ((await handle.read(program, 0, program.length, offset)).bytesRead !== program.length) {
        throw new Error('Таблица ELF Android оборвана');
      }

      if (program.readUInt32LE(0) !== 1 || program.readBigUInt64LE(48) >= 16384n) {
        continue;
      }

      if ((program.readBigUInt64LE(8) - program.readBigUInt64LE(16)) % 16384n !== 0n) {
        throw new Error('Секция SEA не выровнена на 16 КиБ для Android ARM64');
      }

      program.writeBigUInt64LE(16384n, 48);
      await handle.write(program, 48, 8, offset + 48);
    }
  } finally {
    await handle.close();
  }
}

/**
 * Проверяет имя и байты ресурса SEA прямо в PT_NOTE, без запуска Android ELF.
 * Postject оставляет имя секции пустым, поэтому имя берётся из самой записи ELF.
 */
async function checkAndroidSeaNote(file: string, elfHeaders: string, blob: string): Promise<void> {
  const notes = /^\s+NOTE\s+(0x[\da-f]+)\s+0x[\da-f]+\s+0x[\da-f]+\s+(0x[\da-f]+)/gmu;
  const handle = await open(file, 'r');

  try {
    for (const [, start, length] of elfHeaders.matchAll(notes)) {
      const end = Number(start) + Number(length);
      const header = Buffer.alloc(12);

      for (let offset = Number(start); offset + header.length <= end;) {
        await handle.read(header, 0, header.length, offset);
        const nameLength = header.readUInt32LE(0);
        const size = header.readUInt32LE(4);
        const data = offset + header.length + Math.ceil(nameLength / 4) * 4;

        if (nameLength === 14 && size > 0 && data + size <= end) {
          const name = Buffer.alloc(nameLength);

          await handle.read(name, 0, nameLength, offset + header.length);

          if (name.toString() === 'NODE_SEA_BLOB\0') {
            const hash = createHash('sha256');

            for await (const chunk of createReadStream(file, { start: data, end: data + size - 1 })) {
              hash.update(chunk);
            }

            if (hash.digest('hex') === await sha256File(blob)) {
              return;
            }

            throw new Error('Ресурс SEA Android отличается от подготовленного blob');
          }
        }

        offset = data + Math.ceil(size / 4) * 4;
      }
    }
  } finally {
    await handle.close();
  }

  throw new Error('Ресурс SEA отсутствует в ELF Android');
}

/**
 * Сверяет ELF по архитектуре, загрузчику Bionic и выравниванию для устройства.
 * После внедрения SEA также проверяет точные байты подготовленного blob.
 */
async function verifyAndroidElf(file: string, abi: AndroidAbi, ndkBin: string, blob?: string): Promise<void> {
  const { stdout } = await run(path.join(ndkBin, 'llvm-readelf'), ['-W', '-h', '-l', file]);
  const machine = abi === 'arm64-v8a' ? 'AArch64' : 'Advanced Micro Devices X86-64';
  const align = abi === 'arm64-v8a' ? 16384 : 4096;
  const loads = [...stdout.matchAll(/^\s+LOAD\s+.*\s(0x[\da-f]+)\s*$/gmu)];

  if (!stdout.includes(machine) || !stdout.includes('[Requesting program interpreter: /system/bin/linker64]')
    || loads.length === 0 || loads.some((load) => Number(load[1]) < align)) {
    throw new Error(`Некорректный ELF Android ${abi}: ${path.basename(file)}`);
  }

  if (blob) {
    await checkAndroidSeaNote(file, stdout, blob);
  }
}

/**
 * Собирает SEA и worker одного ABI в раскладке для nativeLibraryDir APK.
 * Чистый staging становится выходом только после проверки ELF и хешей комплекта.
 */
async function buildAndroid(abi: AndroidAbi, toolchain: string, nodeCache: string, out: string) {
  const prepared = await readPreparedRuntimeDependencies(nodeCache);
  const { arch, triple } = androidTargets[abi];
  const worker = {
    platform: 'android', arch, nodeVersion: process.versions.node, nativeAbi: process.versions.modules,
  };

  if (process.platform !== 'linux' || process.arch !== 'x64' || worker.nativeAbi !== prepared.abi) {
    throw new Error('Для сборки Android нужен Linux x64. ABI генератора SEA и worker Node должны совпадать.');
  }

  const ndk = path.join(toolchain, 'android-ndk-r28c');
  const sysroot = path.join(ndk, 'toolchains/llvm/prebuilt/linux-x86_64');
  const ndkBin = path.join(sysroot, 'bin');
  const nodeDist = path.join(toolchain, 'out', abi);
  const node = path.join(nodeDist, 'libnode.so');
  const headers = path.resolve(path.dirname(prepared.node), '../include/node');

  await assertUntracked(path.join(out, 'libdeepseek.so'));
  await verifyAndroidElf(node, abi, ndkBin);

  await withWorkDirectory(path.dirname(out), async (work) => {
    const generation = path.join(work, 'generation');
    const staging = path.join(work, 'result');
    const binary = path.join(staging, 'libdeepseek.so');

    await run(prepared.node, [paths.scripts.runtime, '--vendor-dir', paths.vendorDir,
      '--runtime-deps-dir', prepared.directory, '--output-dir', generation], { maxBuffer: 16 * 1024 * 1024 });
    await prepareAndroidGeneration({
      generation, work, abi, ndk, ndkBin, headers, nodeAbi: worker.nativeAbi,
    });
    await copyFile(path.join(nodeDist, 'LICENSE'), path.join(work, 'LICENSE'));
    await bundleBinaryEntries(work);

    const { artifact } = await readWorkerArtifact(generation, worker);
    const nodeSha256 = await sha256File(node);
    const base = await packBinaryGeneration(work, { artifact, directory: generation, worker, nodeSha256 },
      node, prepared.node);
    const manifest = await sealBinaryPayload(work, base);

    await writeFile(path.join(work, 'manifest.json'), manifestBytes(manifest));
    await writeFile(path.join(work, 'package-id'), manifest.packageId);
    await writeFile(path.join(work, 'sea-config.json'), JSON.stringify(seaConfig({
      'manifest.json': 'manifest.json', 'package-id': 'package-id', 'payload.zip': 'payload.zip',
    })));
    await run(process.execPath, ['--experimental-sea-config', 'sea-config.json'], { cwd: work });

    await mkdir(staging);
    await copyFile(node, binary);
    await injectSea({ target: `android-${arch}`, work, node: process.execPath,
      postject: path.join(paths.root, 'node_modules/postject/dist/cli.js'), executable: binary,
      fuse: SEA_FUSE, run });

    if (abi === 'arm64-v8a') {
      await alignAndroidSea(binary);
    }

    await verifyAndroidElf(binary, abi, ndkBin, path.join(work, 'sea-prep.blob'));

    const metadata = 'libdeepseek.so.runtime-info.json';
    const assets = ['libdeepseek.so', 'libnode.so', 'libc++_shared.so', 'NDK-NOTICE.txt', metadata];

    await chmod(binary, 0o755);
    await copyFile(node, path.join(staging, 'libnode.so'));
    await copyFile(path.join(sysroot, `sysroot/usr/lib/${triple}/libc++_shared.so`),
      path.join(staging, 'libc++_shared.so'));
    await copyFile(path.join(ndk, 'NOTICE.toolchain'), path.join(staging, 'NDK-NOTICE.txt'));
    await writeFile(path.join(staging, metadata),
      JSON.stringify(decodeDeepSeekRuntimeInfo(manifest), null, 2) + '\n');

    const checksums = await Promise.all(assets.map(async (asset) =>
      `${await sha256File(path.join(staging, asset))}  ${asset}\n`));

    await writeFile(path.join(staging, 'SHA256SUMS'), checksums.join(''));
    await rename(staging, out);
    process.stdout.write(`Собран Android ${abi}: ${out}\n`);
  });
}

const [abi, toolchain, nodeCache, out] = process.argv.slice(2);

if ((abi !== 'arm64-v8a' && abi !== 'x86_64')
  || !toolchain || !nodeCache || !out || process.argv.length !== 6) {
  throw new Error('Использование: buildAndroid.mts <ABI> <toolchain> <node-cache-dir> <out-dir>');
}

const result = buildAndroid(abi, path.resolve(toolchain), path.resolve(nodeCache), path.resolve(out));

await result.catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n${error.stdout ?? ''}${error.stderr ?? ''}`);
  process.exitCode = 1;
});

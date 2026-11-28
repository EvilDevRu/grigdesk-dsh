import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { makeReadOnlyTree } from '../lib/node/files.ts';
import { sha256, sha256File } from '../lib/node/hash.ts';
import { downloadFile } from '../lib/node/seaBuild.ts';
import { hashRuntimePayload } from './buildRuntime.mts';
import { writeDeepSeekLicenseInventory } from './deepseekBuildLicenses.ts';
import { deepSeekPackagePaths } from './paths.ts';

export const androidTargets = {
  'arm64-v8a': { arch: 'arm64', triple: 'aarch64-linux-android' },
  x86_64: { arch: 'x64', triple: 'x86_64-linux-android' },
} as const;

export type AndroidAbi = keyof typeof androidTargets;

const run = promisify(execFile);
const root = deepSeekPackagePaths().root;

/**
 * Проверяет точный контекст собранного upstream перед изменением Bionic-пути.
 * При смене версии Harness старое преобразование останавливает сборку.
 */
async function replaceOnce(file: string, before: string, after: string, prefix = ''): Promise<void> {
  const source = await readFile(file, 'utf8');

  if (source.split(before).length !== 2) {
    throw new Error(`Изменился контекст Android-порта: ${path.basename(file)}: ${before}`);
  }

  await writeFile(file, prefix + source.replace(before, after));
}

/**
 * Сохраняет атомарную публикацию нового журнала и миграции в sandbox Android.
 * Оба пути используют одну обёртку Bionic с прежним контрактом EEXIST.
 */
async function patchJournal(generation: string): Promise<void> {
  const directory = path.join(generation, 'packages/session/session-persistence-jsonl/lib');
  const helper = 'grigdeskAndroidPublish.mjs';
  const prefix = `import { publishNewFileAndroid } from ${JSON.stringify(`./${helper}`)};\n`;
  const entry = path.join(directory, 'index.js');

  await copyFile(path.join(root, 'build/android/publishJournal.mjs'), path.join(directory, helper));
  await replaceOnce(entry, 'await link(tmp, finalPath);',
    'await publishNewFileAndroid(tmp, finalPath);', prefix);
  await replaceOnce(entry, 'await internals.fs.link(staged, currentPath);',
    'await publishNewFileAndroid(staged, currentPath);');
}

/**
 * Npm на Linux пропускает пакеты чужой архитектуры. Для Android sharp использует WASM.
 * Архивы и их integrity берутся из того же lock, что и основное поколение.
 */
async function installSharpWasm(work: string, generation: string): Promise<void> {
  const file = path.join(deepSeekPackagePaths().runtimeDependenciesDir, 'package-lock.json');
  const { packages } = JSON.parse(await readFile(file, 'utf8'));

  for (const name of ['@img/sharp-wasm32', '@emnapi/runtime']) {
    const relative = `node_modules/${name}`;
    const { resolved, integrity } = packages[relative];
    const archive = path.join(work, `${path.basename(name)}.tgz`);

    await downloadFile(resolved, archive);

    const digest = createHash('sha512').update(await readFile(archive)).digest('base64');

    if (`sha512-${digest}` !== integrity) {
      throw new Error(`Контрольная сумма ${name} не совпала с npm lock`);
    }

    const output = path.join(generation, relative);

    await mkdir(output, { recursive: true });
    await run('tar', ['-xzf', archive, '--strip-components=1', '-C', output]);
  }
}

/**
 * Пересобирает flock и node-pty из тех же исходников, что попали в generation.
 * Flock остаётся отдельным пакетом Node-API для соответствующей архитектуры Bionic.
 */
async function buildAndroidAddons(generation: string, abi: AndroidAbi, ndkBin: string, headers: string) {
  const { arch, triple } = androidTargets[abi];
  const target = `android-${arch}`;
  const modules = path.join(generation, 'node_modules');
  const addonName = `node-addon-system-${target}`;
  const addon = path.join(generation, `native/system/packages/${target}`);
  const pty = path.join(modules, 'node-pty', 'prebuilds', target, 'pty.node');
  const c = path.join(ndkBin, `${triple}30-clang`);
  const cxx = `${c}++`;
  const flags = ['-O2', '-fPIC', '-fvisibility=hidden', '-DNAPI_VERSION=8', '-I', headers, '-shared'];
  const entry = path.join(generation, 'native/system/packages/entry');

  await mkdir(path.join(addon, 'bin'), { recursive: true });
  await mkdir(path.dirname(pty), { recursive: true });
  await run(c, [...flags, '-std=c11', '-o', path.join(addon, 'bin/system.node'),
    path.join(entry, 'src/flock.c')]);
  await run(cxx, [...flags, '-std=c++17', '-DNAPI_CPP_EXCEPTIONS', '-Wl,-z,undefs',
    '-I', path.join(modules, 'node-addon-api'), '-o', pty, path.join(modules, 'node-pty/src/unix/pty.cc')]);

  const { version, license } = JSON.parse(await readFile(path.join(entry, 'package.json'), 'utf8'));

  await writeFile(path.join(addon, 'package.json'), JSON.stringify({
    name: `@deepseek-ai/${addonName}`, version, license, os: ['android'], cpu: [arch],
  }));
  await copyFile(path.join(generation, 'native/system/LICENSE'), path.join(addon, 'LICENSE'));
  const link = path.join(modules, '@deepseek-ai', addonName);

  await symlink(path.relative(path.dirname(link), addon), link, 'dir');
  await replaceOnce(path.join(entry, 'lib/flock.js'), "platform !== 'linux' && platform !== 'darwin'",
    "platform !== 'linux' && platform !== 'darwin' && platform !== 'android'");
}

/**
 * Собирает Koffi его собственным CMake-входом и сохраняет результат по пути загрузчика.
 * Каталог CMake остаётся во временной копии и не попадает в ZIP Harness.
 */
async function buildAndroidKoffi(generation: string, work: string, abi: AndroidAbi, ndk: string): Promise<void> {
  const koffi = path.join(generation, 'node_modules/koffi');
  const triplet = `android_${androidTargets[abi].arch}`;

  await run(process.execPath, ['cnoke.cjs', 'build', '-P', '.', '-D', 'src/koffi', '-t', triplet,
    '-d', `CMAKE_TOOLCHAIN_FILE=${path.join(ndk, 'build/cmake/android.toolchain.cmake')}`,
    '-d', `ANDROID_ABI=${abi}`, '-d', 'ANDROID_PLATFORM=android-30',
    '-d', 'CMAKE_SHARED_LINKER_FLAGS=-Wl,-z,undefs', '--release'], {
    cwd: koffi, maxBuffer: 16 * 1024 * 1024,
  });

  const build = path.join(koffi, 'build');
  const scratch = path.join(work, 'koffi-build');
  const output = path.join(build, 'koffi', triplet);

  await rename(build, scratch);
  await mkdir(output, { recursive: true });
  await copyFile(path.join(scratch, 'koffi', triplet, 'koffi.node'), path.join(output, 'koffi.node'));
}

/**
 * Фиксирует Android-поколение после сборки всех нативных файлов и лицензий.
 * Общая композиция GLM остаётся единой между целями, buildId сверяет bytes Android.
 */
export async function prepareAndroidGeneration(options: {
  generation: string;
  work: string;
  abi: AndroidAbi;
  ndk: string;
  ndkBin: string;
  headers: string;
  nodeAbi: string;
}): Promise<void> {
  const { generation, work, abi, ndk, ndkBin, headers, nodeAbi } = options;

  await buildAndroidAddons(generation, abi, ndkBin, headers);
  await buildAndroidKoffi(generation, work, abi, ndk);
  await installSharpWasm(work, generation);
  await patchJournal(generation);

  const { packages } = JSON.parse(await readFile(path.join(generation, 'composition.json'), 'utf8'));

  packages.push({ root: `native/system/packages/android-${androidTargets[abi].arch}` });
  await rm(path.join(generation, 'licenses'), { recursive: true });
  await writeDeepSeekLicenseInventory(generation, packages);

  const file = path.join(generation, 'runtime.json');
  const { buildId: _, ...runtime } = JSON.parse(await readFile(file, 'utf8'));

  Object.assign(runtime.inputIdentity, {
    platform: 'android', arch: androidTargets[abi].arch, nativeAbi: nodeAbi,
    nativeToolchain: await sha256File(path.join(ndk, 'source.properties')),
  });
  await rm(file);
  await makeReadOnlyTree(generation);
  runtime.payload = await hashRuntimePayload(generation);

  const buildId = sha256(JSON.stringify({ inputIdentity: runtime.inputIdentity, payload: runtime.payload }));

  runtime.runtimeVersion = `${runtime.source.version}.grigdesk.b${buildId.slice(0, 16)}`;
  await writeFile(file, JSON.stringify({ ...runtime, buildId }, null, 2) + '\n', { mode: 0o444 });
}

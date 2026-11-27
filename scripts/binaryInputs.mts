import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256File } from '../lib/node/hash.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const lib = [
  'lib/chat/deepSeekBinary.ts',
  'lib/core/canonicalJson.ts',
  'lib/core/contractDecoders.ts',
  'lib/glm/contract.ts',
  'lib/node/nodeRuntime.ts',
  'lib/node/deepSeekArtifact.ts',
  'lib/node/directoryLock.ts',
  'lib/node/files.ts',
  'lib/node/glmCompatibility.ts',
  'lib/node/hash.ts',
  'lib/node/networkFamily.ts',
  'lib/node/payloadArchive.ts',
  'lib/node/payloadCache.ts',
  'lib/node/seaBuild.ts',
  'lib/runtime/dataHome.ts',
  'lib/runtime/nodeVersion.ts',
];
const scripts = [
  'binaryInputs.mts', 'buildBinary.mts', 'buildPayload.mts', 'buildSteps.mts',
  'packagePayload.mts', 'prepareRuntimeDeps.mts',
];

/**
 * Перечисляются собственные source-файлы без node_modules и upstream-снимка.
 * Относительные имена и сортировка исключают случайный путь приватной build fixture.
 */
async function sourceFiles(relative: string): Promise<string[]> {
  const result: string[] = [];

  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const file = `${relative}/${entry.name}`;

    if (entry.isDirectory()) {
      result.push(...await sourceFiles(file));
    } else if (entry.isFile() && /\.(?:ts|mjs)$/u.test(entry.name)) {
      result.push(file);
    }
  }

  return result;
}

/**
 * Отпечаток пакета включает только его builder/resources и реально используемые
 * общие примитивы. Generation хранит собственную полную identity; smoke-стек,
 * CLI и тесты в поставку не входят и отпечаток не меняют.
 */
export async function binaryPackageInputs(): Promise<Record<string, string>> {
  const files = [
    ...lib,
    ...scripts.map((name) => `scripts/${name}`),
    ...await sourceFiles('src'),
    'package.json',
    'package-lock.json',
    'build/node-runtime.json',
    'build/node-runtime-linux-arm64.json',
    'build/node-runtime-darwin-arm64.json',
    'compatibility/glm.json',
  ].sort();
  const entries = await Promise.all(files.map(async (name) => [
    name, await sha256File(path.join(root, name)),
  ]));

  return Object.fromEntries(entries);
}

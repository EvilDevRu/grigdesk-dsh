import os from 'node:os';
import path from 'node:path';
import { getRawAsset } from 'node:sea';

import { decodeDeepSeekRuntimeInfo } from '../../lib/chat/deepSeekBinary.ts';
import { sha256 } from '../../lib/node/hash.ts';
import { launcherFailure, parseLauncherArgs } from './args.ts';
import { applyCredentials } from './credentials.ts';
import { chatHelp, parseChatOptions } from './chatProfile.ts';
import { materializePayload, resolveExtractionCache } from './extract.ts';
import { runLogin } from './login.ts';
import { runTerminalChat } from './terminalChat.ts';
import { runLauncherWorker } from './worker.ts';

/**
 * Assets защищаются полным packageId, а metadata-команды не вычисляют HOME и cache.
 * Runtime-info возвращает публичный контракт без многомегабайтного внутреннего индекса.
 */
async function main(): Promise<void> {
  const args = parseLauncherArgs(process.argv.slice(2));
  const bytes = Buffer.from(getRawAsset('manifest.json'));
  const packageId = Buffer.from(getRawAsset('package-id')).toString('utf8');

  if (sha256(bytes) !== packageId) {
    throw new Error('Identity поставки изменилась');
  }

  const manifest = { ...JSON.parse(bytes.toString('utf8')), packageId };
  const info = decodeDeepSeekRuntimeInfo(manifest);

  if (args.expectedPackageId !== null && args.expectedPackageId !== info.packageId) {
    throw new Error('Identity поставки изменилась');
  }

  if (args.mode === 'runtime-info') {
    process.stdout.write(`${JSON.stringify(info)}\n`);

    return;
  }

  if (args.mode === 'version') {
    process.stdout.write(`${info.upstreamVersion}\n`);

    return;
  }

  if (args.mode === 'help') {
    process.stdout.write('DeepSeek Harness для GrigDesk\n'
      + 'chat [--help] — интерактивный чат в терминале\n'
      + 'login [deepseek|glm|qwen] [--status] | logout [подключение|--all] — ключи в ~/.deepseek\n'
      + '--runtime-info --json | --verify --json | -V | --license\n'
      + '--cache-dir <абсолютный путь> --expect-package-id <SHA256> [аргументы Harness]\n');

    return;
  }

  if (args.mode === 'license') {
    process.stdout.write(Buffer.from(getRawAsset('NODE-LICENSE')).toString('utf8'));
    process.stdout.write('\nПолный набор notices Harness встроен в generation/licenses/index.json.\n');

    return;
  }

  // Ключи чата: окружение терминала → ~/.deepseek/credentials.json (login) → .env GrigDesk.
  // Явные переменные не перекрываются; дальше профиль читает их как раньше.
  if (args.mode === 'run' && ['login', 'logout'].includes(args.harnessArgs[0] ?? '')) {
    const [command, ...rest] = args.harnessArgs;

    try {
      process.exitCode = await runLogin(command === 'logout' ? ['logout', ...rest] : rest, {
        stdin: process.stdin, stdout: process.stdout, env: process.env,
      });
    } catch (error) {
      process.stderr.write(`${(error as Error).message}\n`);
      process.exitCode = 2;
    }

    return;
  }

  if (args.mode === 'run' && (args.harnessArgs[0] === 'chat'
    || args.harnessArgs.length === 0 && process.stdin.isTTY && process.stdout.isTTY)) {
    try {
      const options = parseChatOptions(args.harnessArgs.slice(1));

      if (options.help) {
        process.stdout.write(`${chatHelp}\n`);
      } else {
        // Дочерний launcher получает только allowlist окружения профиля и не видит GRIGDESK_HOME,
        // поэтому путь распаковки считает родитель — тот же, что и у обычного run-режима.
        const inherited = [
          '--expect-package-id', info.packageId,
          '--cache-dir', resolveExtractionCache(args.cacheDir ?? undefined, {
            env: process.env, home: os.homedir(),
          }),
        ];

        await applyCredentials(process.env);
        process.exitCode = await runTerminalChat(options, inherited);
      }
    } catch (error) {
      process.stderr.write(`${(error as Error).message}\n`);
      process.exitCode = 2;
    }

    return;
  }

  const asset = getRawAsset('payload.zip');
  const directory = await materializePayload({
    cacheDir: resolveExtractionCache(args.cacheDir ?? undefined, { env: process.env, home: os.homedir() }),
    packageId: info.packageId,
    fullVerify: args.mode === 'verify',
    payload: manifest.payload,
    archive: function* () {
      for (let offset = 0; offset < asset.byteLength; offset += 65536) {
        yield new Uint8Array(asset, offset, Math.min(65536, asset.byteLength - offset));
      }
    },
  });
  const result = await runLauncherWorker({
    directory,
    entry: path.join(directory, args.mode === 'verify' ? 'worker-verify.mjs' : 'generation/entry.mjs'),
    args: args.mode === 'verify' ? [directory] : args.harnessArgs,
    capture: args.mode === 'verify',
  });

  if (args.mode === 'verify') {
    if (result.code !== 0 || result.stderr !== '') {
      // Результат worker остаётся на объекте ошибки: трассировка ниже печатает его
      // только по явному флагу, обычный вывод launcher по-прежнему скрывает сырые детали.
      throw Object.assign(new Error('Worker отказал в проверке'), { worker: result });
    }

    const verified = JSON.parse(result.stdout);

    if (verified.buildId !== info.buildId || verified.workerNode?.version !== info.workerNode.version
      || verified.workerNode?.abi !== info.workerNode.abi || verified.glmPlugin !== true) {
      throw new Error('Worker не подтвердил metadata поставки');
    }

    process.stdout.write(`${JSON.stringify({
      ...info,
      verified: true,
      glmPlugin: true,
    })}\n`);
  }

  process.exitCode = result.code;
}

/**
 * Диагностика включается только переменной сборки/CI: stdout и stderr пользователя
 * и его окружение в обычный вывод не попадают, как и раньше. Режим `--runtime-info`
 * остаётся чистым и окружение не читает даже при отказе.
 */
function writeLauncherTrace(error: unknown, runtimeInfoOnly: boolean): void {
  if (runtimeInfoOnly || process.env.GRIGDESK_DSH_LAUNCHER_TRACE !== '1') {
    return;
  }

  const trace = error as Error & { worker?: { code: number | null; stdout: string; stderr: string } };

  process.stderr.write(`launcher trace: ${trace.stack ?? String(trace)}\n`);

  if (trace.worker) {
    process.stderr.write(`launcher worker code=${trace.worker.code}\nstdout:\n${trace.worker.stdout}\n`
      + `stderr:\n${trace.worker.stderr}\n`);
  }
}

void main().catch((error: unknown) => {
  const metadata = process.argv.slice(2).some((arg) => arg === '--runtime-info' || arg === '--verify');
  const result = launcherFailure(error, metadata);
  const runtimeInfoOnly = process.argv.slice(2).includes('--runtime-info');

  writeLauncherTrace(error, runtimeInfoOnly);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
});

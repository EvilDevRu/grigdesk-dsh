import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import net from 'node:net';
import { setTimeout as pause } from 'node:timers/promises';

import { DshWebClient } from './client.ts';

export interface DshWebStartOptions {
  binary: string;
  packageId: string;
  cacheDir: string;
  overlayPath: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
}

export interface DshWebProcess {
  client: DshWebClient;
  pid: number | undefined;
  stop(): Promise<void>;
}

const START_TIMEOUT_MS = 20_000;
const URL_PATTERN = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?[^\s]+)/u;
const OUTPUT_TAIL_BYTES = 16_384;

async function unusedPort(): Promise<number> {
  const server = net.createServer();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const port = (server.address() as net.AddressInfo).port;

  await new Promise<void>((resolve) => server.close(() => resolve()));

  return port;
}

function groupGone(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);

    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/**
 * SIGTERM адресован launcher, который пересылает его worker и подтверждает disposal;
 * по истечении 6 с своя process group получает SIGKILL, ещё 2 с ждём фактического выхода.
 * Останавливается только группа, созданная нашим detached spawn.
 */
async function stopChild(child: ChildProcess, pgid: number | undefined): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  try {
    child.kill('SIGTERM');
  } catch {
    // Уже завершён: ожидание ниже подтверждает фактический выход.
  }

  const exited = async (timeoutMs: number) => {
    const deadline = performance.now() + timeoutMs;

    do {
      if (child.exitCode !== null || child.signalCode !== null) {
        return true;
      }

      await pause(20);
    } while (performance.now() < deadline);

    return child.exitCode !== null || child.signalCode !== null;
  };

  if (!await exited(6_000)) {
    if (pgid && !groupGone(pgid)) {
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch {
        // Группа исчезла между проверкой и сигналом.
      }
    }

    await exited(2_000);
  }
}

/**
 * Хвост вывода процесса нужен только для причины отказа запуска; одноразовый токен
 * входа из строки `dsh web:` в диагностику не попадает.
 */
function diagnosticsTail(output: string): string {
  return output
    .split('\n')
    .filter((line) => !line.includes('dsh web:'))
    .join('\n')
    .slice(-4_000)
    .trim();
}

/**
 * Запускает автономный ELF на собственном loopback-порту без публикации токена в журнал:
 * launcher сверяет packageId, распаковывает payload в cacheDir и читает overlay профиля.
 * URL из stdout/stderr ещё не означает готовность — cookie выдаёт сам процесс, поэтому
 * клиент создаётся после обмена. Таймаут, abort и ранний выход останавливают процесс.
 */
export async function startDshWeb(options: DshWebStartOptions): Promise<DshWebProcess> {
  const port = await unusedPort();
  const args = [
    '--expect-package-id', options.packageId,
    '--cache-dir', options.cacheDir,
    '--profile', 'web',
    '--patch', options.overlayPath,
    '--host', '127.0.0.1',
    '--port', String(port),
    '--no-open',
  ];
  const child = spawn(options.binary, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const pgid = child.pid;
  let output = '';
  let outputBytes = 0;
  let resolved = false;
  let resolveUrl!: (url: string) => void;
  let rejectUrl!: (error: Error) => void;
  const url = new Promise<string>((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });

  const accept = (chunk: Buffer | string) => {
    outputBytes += Buffer.byteLength(chunk);

    if (outputBytes > 2_097_152) {
      rejectUrl(new Error('DSH web превысил предел вывода при запуске'));

      return;
    }

    output = `${output}${String(chunk)}`.slice(-OUTPUT_TAIL_BYTES);
    const match = output.match(URL_PATTERN);

    if (match && !resolved) {
      resolved = true;
      resolveUrl(match[1]!);
    }
  };

  child.stdout?.on('data', accept);
  child.stderr?.on('data', accept);

  const startupAbort = new AbortController();

  const startupFailed = (error: Error) => {
    startupAbort.abort(error);

    if (!resolved) {
      rejectUrl(error);
    }
  };

  child.once('error', (error) => startupFailed(new Error(`Не удалось запустить ELF: ${error.message}`)));
  child.once('exit', (code, signal) => startupFailed(new Error([
    `DSH web завершился до запуска (код ${code ?? 'нет'}, сигнал ${signal ?? 'нет'})`,
    diagnosticsTail(output),
  ].join('\n'))));

  const stop = () => stopChild(child, pgid);
  let startupTimer: ReturnType<typeof setTimeout> | undefined;

  try {
    const authenticatedUrl = await Promise.race([
      url,
      new Promise<string>((_, reject) => {
        startupTimer = setTimeout(
          () => reject(new Error(`Таймаут запуска DSH web\n${diagnosticsTail(output)}`)),
          options.timeoutMs ?? START_TIMEOUT_MS,
        );
      }),
    ]);

    clearTimeout(startupTimer);

    const client = await DshWebClient.authenticate(authenticatedUrl, startupAbort.signal);

    child.stdout?.off('data', accept);
    child.stderr?.off('data', accept);
    child.stdout?.resume();
    child.stderr?.resume();

    return { client, pid: child.pid, stop };
  } catch (error) {
    clearTimeout(startupTimer);
    await stop().catch(() => {});

    throw error;
  }
}

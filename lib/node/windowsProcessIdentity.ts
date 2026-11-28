import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
let factory: string | undefined;

/**
 * В автономной поставке фабрики нет. Штатный PowerShell берётся из SystemRoot,
 * а отсутствие PID определяется отдельно от ошибок чтения времени запуска.
 */
function systemProcessProbe(pid: number): { command: string; args: string[] } | undefined {
  const root = process.env.SystemRoot;

  if (!root || !path.isAbsolute(root)) {
    return undefined;
  }

  return {
    command: path.join(root, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; `
      + 'if (!$p) { exit 3 }; try { $t = $p.StartTime; if (!$t) { exit 1 }; '
      + '[Console]::WriteLine($t.ToUniversalTime().Ticks) } catch { exit 1 }'],
  };
}

/** Сервер передаёт путь уже выбранной фабрики.
 * Общий код блокировок не ищет программу по PATH.
 */
export function configureWindowsProcessIdentity(file: string): void {
  if (!path.isAbsolute(file)) {
    throw new Error('windows_process_helper_invalid');
  }

  factory = file;
}

/** Различает отсутствие процесса и невозможность проверить владельца.
 * При недоступном helper блокировка сохраняет статус «неизвестно».
 */
export async function readWindowsProcessStart(pid: number): Promise<{
  starttime?: string;
  dead: boolean;
}> {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0xffffffff) {
    return { dead: false };
  }

  const probe = factory
    ? { command: factory, args: ['_windows-starttime', String(pid)] }
    : systemProcessProbe(pid);

  if (!probe) {
    return { dead: false };
  }

  try {
    const { stdout } = await run(probe.command, probe.args, {
      timeout: 5000,
      maxBuffer: 1024,
      windowsHide: true,
    });
    const starttime = stdout.trim();

    return /^\d+$/u.test(starttime) ? { starttime, dead: false } : { dead: false };
  } catch (error) {
    return { dead: (error as { code?: number }).code === 3 };
  }
}

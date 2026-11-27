import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { screenFrame } from './cliScreen.mts';
import type { ScreenRow } from './cliScreen.mts';
import { terminalSession } from './cliTerminal.mts';

interface Progress {
  stages: string[];
  current: number;
}

/**
 * Этапы публикуются из фактического порядка выполнения. При ошибке следующий этап
 * не начинается, а явная команда без экрана ведёт обычный журнал.
 */
export async function runSteps(steps: readonly (readonly [string, () => Promise<void>])[]): Promise<void> {
  const stages = steps.map(([label]) => label);

  for (const [current, [, run]] of steps.entries()) {
    if (process.connected) {
      process.send?.({ stages, current } satisfies Progress);
    }

    await run();
  }
}

/**
 * Сборка и проверка показывают долю законченных стадий. Для команды без стадий
 * движется индикатор активности, а 100 % появляются только после успешного выхода.
 */
function progressBar(width: number, tick: number, percent?: number): string {
  const size = Math.min(30, width - 6);

  if (size < 4) {
    return percent === undefined ? '◐' : `${percent}%`;
  }

  if (percent === undefined) {
    const head = tick % (size - 2);

    return '░'.repeat(head) + '███' + '░'.repeat(size - head - 3);
  }

  const filled = Math.floor(size * percent / 100);

  return `${'█'.repeat(filled)}${'░'.repeat(size - filled)}  ${percent}%`;
}

/**
 * Временный журнал принимает весь вывод дочернего процесса. Для экрана читаем
 * небольшой хвост по абсолютной позиции, не двигая указатель записи процесса.
 */
async function logPreview(log: FileHandle): Promise<string> {
  const { size } = await log.stat();
  const bytes = Buffer.alloc(Math.min(size, 4096));
  const { bytesRead } = await log.read(bytes, 0, bytes.length, size - bytes.length);

  return bytes.subarray(0, bytesRead).toString('utf8').trimEnd().split(/[\n\r]/u).at(-1) ?? '';
}

/**
 * Дочерний CLI выполняет обычную команду. Общий журнал переживает перерисовки,
 * а сигнал прерывания уходит только группе этого запуска.
 */
export async function runCliAction(entry: string, args: string[], title: string): Promise<number> {
  const directory = await mkdtemp(path.join(tmpdir(), 'grigdesk-dsh-ctl-'));
  const file = path.join(directory, 'output.log');
  let finished = 1;

  try {
    const log = await open(file, 'w+', 0o600);

    try {
      finished = await terminalSession(true, async (terminal) => {
        let progress: Progress | undefined;
        let preview = '';
        let tick = 0;
        let result: number | undefined;
        const started = performance.now();
        const child = fork(entry, args, { detached: true, stdio: ['ignore', log.fd, log.fd, 'ipc'] });

        /**
         * Сигнал группе получают и CLI, и его скрипты, включая сторож тестов.
         * Сторож сам завершает тестовые процессы из своей группы.
         */
        const cancel = () => {
          if (!child.pid) {
            return;
          }

          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
              child.kill('SIGTERM');
            }
          }
        };

        terminal.signal.addEventListener('abort', cancel, { once: true });
        child.on('message', (event: Progress) => {
          progress = event;
          terminal.redraw();
        });

        terminal.draw(() => {
          const frame = screenFrame(title);
          const elapsed = Math.floor((performance.now() - started) / 1000);
          const time = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
          const percent = result === 0 ? 100 : progress
            ? Math.floor(100 * progress.current / progress.stages.length) : undefined;
          const tone = result === undefined ? 'accent' : result === 0 ? 'success' : 'error';
          const status = terminal.signal.aborted ? 'Прерывание' : result === undefined
            ? 'Выполняется' : result === 0 ? 'Готово' : `Ошибка · код ${result}`;
          const body: ScreenRow[] = [
            { text: `${progressBar(frame.width, tick, percent)}  ${time}`, tone },
            { text: status, tone },
          ];
          const footer: ScreenRow[] = [{ text: 'Ctrl+C Прервать', tone: 'muted' }];
          const tail: ScreenRow[] = preview ? [{ text: `› ${preview}`, tone: 'muted' }] : [];
          const count = Math.max(0, frame.capacity - body.length - footer.length - tail.length);

          if (progress && count > 0) {
            const { stages, current } = progress;
            const first = Math.min(Math.max(0, current - count + 1), Math.max(0, stages.length - count));
            const spinner = ['◐', '◓', '◑', '◒'][tick % 4];

            body.push(...stages.slice(first, first + count).map((label, offset): ScreenRow => {
              const index = first + offset;

              if (index < current || result === 0) {
                return { text: `✓ ${label}`, tone: 'success' };
              }

              if (index === current) {
                return { text: `${result === undefined ? spinner : '✗'} ${label}`, tone };
              }

              return { text: `○ ${label}`, tone: 'muted' };
            }));
          }

          return frame.render([...body, ...tail], footer);
        });

        let reading: Promise<void> | undefined;
        const timer = setInterval(() => {
          reading ??= logPreview(log).then((line) => {
            preview = line;
            tick++;
            terminal.redraw();
          }).catch(() => undefined).finally(() => {
            reading = undefined;
          });
        }, 180);

        try {
          const [code, signal] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
          const exitCode = terminal.signal.aborted ? terminal.signal.reason as number
            : code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
          result = exitCode;
          terminal.redraw();

          return exitCode;
        } finally {
          clearInterval(timer);
          terminal.signal.removeEventListener('abort', cancel);
          await reading;
        }
      });
    } finally {
      await log.close();
    }

    for await (const chunk of createReadStream(file)) {
      if (!process.stdout.write(chunk)) {
        await once(process.stdout, 'drain');
      }
    }

    const status = finished === 0 ? 'Готово · 100%' : finished === 130 || finished === 143
      ? 'Прервано' : `Ошибка · код ${finished}`;
    process.stdout.write(`\n${title} · ${status}\n`);

    return finished;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

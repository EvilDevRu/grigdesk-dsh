import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

type RecordValue = Record<string, unknown>;

export interface AcpPeer {
  request(method: string, params: RecordValue, timeout?: number): Promise<RecordValue>;
  notify(method: string, params: RecordValue): void;
  close(): Promise<void>;
}

interface Pending {
  resolve(result: RecordValue): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
}

export function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}

/**
 * Соединение владеет одним дочерним launcher. Stdout отведён ACP, stderr хранится
 * для диагностики. Отказ транспорта завершает все запросы одним результатом.
 */
export function openChatAcp(options: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  update(params: RecordValue): void;
  approve(params: RecordValue): Promise<RecordValue>;
  question?(params: RecordValue): Promise<RecordValue>;
  child?(params: RecordValue): void;
}): AcpPeer {
  const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env });
  const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map<number, Pending>();
  let nextId = 0;
  let stderr = '';
  let error: Error | undefined;
  let closing: Promise<void> | undefined;

  /**
   * После ошибки записи, разбора или выхода worker запросы не остаются подвешенными.
   * Таймеры каждого запроса освобождаются вместе с записью в таблице.
   */
  function fail(reason: Error): void {
    error ??= reason;

    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }

    pending.clear();
  }

  const closed = new Promise<void>((resolve) => {
    child.once('close', (code, signal) => {
      const detail = stderr.trim();
      const summary = `Процесс Harness завершился (${code ?? signal ?? 'неизвестно'}).`;
      fail(new Error(detail ? `${summary}\n${detail}` : summary));
      resolve();
    });
  });

  child.on('error', fail);
  child.stdin.on('error', fail);
  output.on('error', fail);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (part: string) => {
    stderr = (stderr + part).slice(-4096);
  });

  /**
   * Сериализуем ровно одну строку JSON-RPC. После закрытия ответы на обратные
   * запросы больше не пишутся в принудительно закрытый stdin.
   */
  function send(message: RecordValue): void {
    if (!error && !child.stdin.destroyed && !child.stdin.writableEnded) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    }
  }

  output.on('line', (line) => {
    let message: RecordValue;

    try {
      message = record(JSON.parse(line));
    } catch {
      fail(new Error('Harness вернул строку вне протокола ACP.'));
      return;
    }

    if (message.method === 'session/update' && message.id === undefined) {
      options.update(record(message.params));
    } else if (message.method === 'session/request_permission' && message.id !== undefined) {
      void options.approve(record(message.params)).then((result) => {
        send({ id: message.id, result });
      }, () => {
        send({ id: message.id, result: { outcome: { outcome: 'cancelled' } } });
      });
    } else if (message.method === '_grigdesk/terminal/question' && message.id !== undefined
      && options.question) {
      void options.question(record(message.params)).then((result) => {
        send({ id: message.id, result });
      }, () => {
        send({ id: message.id, error: { code: -32000, message: 'Ответ отменён.' } });
      });
    } else if (message.method === '_grigdesk/terminal/child' && message.id === undefined) {
      options.child?.(record(message.params));
    } else if (typeof message.method === 'string' && message.id !== undefined) {
      send({ id: message.id, error: { code: -32601, message: 'Метод ACP не поддерживается.' } });
    } else if (typeof message.id === 'number') {
      const entry = pending.get(message.id);

      if (!entry) {
        return;
      }

      pending.delete(message.id);
      clearTimeout(entry.timer);

      if (message.error) {
        entry.reject(new Error(String(record(message.error).message ?? 'Ошибка Harness.')));
      } else {
        entry.resolve(record(message.result));
      }
    }
  });

  return {
    request: (method, params, timeout = 30000) => new Promise((resolve, reject) => {
      if (error || child.stdin.destroyed || child.stdin.writableEnded) {
        reject(error ?? new Error('Соединение с Harness закрыто.'));
        return;
      }

      const id = ++nextId;
      const timer = timeout > 0 ? setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Harness не ответил на ${method} за ${timeout / 1000} с.`));
      }, timeout) : undefined;

      pending.set(id, { resolve, reject, timer });
      send({ id, method, params });
    }),
    notify: (method, params) => send({ method, params }),
    close: () => closing ??= (async () => {
      const terminate = setTimeout(() => child.kill('SIGTERM'), 2000);
      const kill = setTimeout(() => child.kill('SIGKILL'), 7000);

      child.stdin.end();

      try {
        await closed;
      } finally {
        clearTimeout(terminate);
        clearTimeout(kill);
        output.close();
      }
    })(),
  };
}

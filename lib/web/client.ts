import { randomUUID } from 'node:crypto';

const MAX_RPC_RESPONSE_BYTES = 32 * 1024 * 1024;

type RpcResult = {
  type?: string;
  rpcId?: string;
  result?: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } };
};

export class DshWebError extends Error {
  readonly code: string;
  readonly uncertain: boolean;

  constructor(message: string, code: string, uncertain = false) {
    super(message);
    this.code = code;
    this.uncertain = uncertain;
  }
}

/**
 * HTTP-RPC клиент штатного профиля DSH web. Cookie получается только от URL
 * запущенного нами процесса и никогда не выходит за loopback этого запуска.
 */
export class DshWebClient {
  readonly baseUrl: string;
  readonly cookie: string;

  private constructor(baseUrl: string, cookie: string) {
    this.baseUrl = baseUrl;
    this.cookie = cookie;
  }

  /**
   * Cookie извлекается только из loopback-адреса принадлежащего нам процесса:
   * GET авторизованного URL отвечает 303 и выдаёт cookie. Чужой хост отклоняется.
   */
  static async authenticate(authenticatedUrl: string, signal?: AbortSignal): Promise<DshWebClient> {
    const url = new URL(authenticatedUrl);

    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
      throw new Error('DSH web должен слушать только локальный адрес');
    }

    const timeout = AbortSignal.timeout(10_000);
    const response = await fetch(url, {
      redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];

    if (response.status !== 303 || !cookie) {
      throw new Error(`DSH web не выдал cookie: HTTP ${response.status}`);
    }

    return new DshWebClient(url.origin, cookie);
  }

  /**
   * Тело ответа накапливается порциями с собственным пределом 32 МиБ по байтам.
   * Общий сигнал запроса отменяет и зависший read; при любом исходе reader освобождается.
   */
  private async readRpcJson(response: Response, signal: AbortSignal): Promise<unknown> {
    if (!response.body) {
      throw new Error('Тело RPC-ответа отсутствует');
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;

    const abort = () => {
      void reader.cancel(signal.reason).catch(() => {});
    };

    signal.addEventListener('abort', abort, { once: true });

    try {
      signal.throwIfAborted();

      for (;;) {
        const { value, done } = await reader.read();

        signal.throwIfAborted();

        if (done) {
          break;
        }

        bytes += value.byteLength;

        if (bytes > MAX_RPC_RESPONSE_BYTES) {
          throw new Error('RPC-ответ превысил предел объёма');
        }

        chunks.push(value);
      }

      return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks, bytes)));
    } finally {
      signal.removeEventListener('abort', abort);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  /**
   * Ответ сверяется по rpcId и штатному envelope до извлечения результата.
   * Один потоковый читатель ограничивает объём и срок ответа независимо от внешнего signal.
   */
  async rpc(
    method: string, args: Record<string, unknown> = {}, timeoutMs = 30_000, signal?: AbortSignal,
  ): Promise<unknown> {
    const rpcId = randomUUID();
    const timeout = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;

    try {
      response = await fetch(`${this.baseUrl}/api/${method}`, {
        method: 'POST',
        headers: { cookie: this.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
        signal: requestSignal,
      });
    } catch (error) {
      throw new DshWebError(String((error as Error)?.message || error), 'dsh_transport_unknown', true);
    }

    if (!response.ok) {
      throw new DshWebError(`DSH web HTTP ${response.status}`, 'dsh_http_error', true);
    }

    let frame: RpcResult;

    try {
      frame = await this.readRpcJson(response, requestSignal) as RpcResult;
    } catch {
      throw new DshWebError('DSH web вернул повреждённый RPC-ответ', 'dsh_bad_response', true);
    }

    if (frame.type !== 'server-response' || frame.rpcId !== rpcId || !frame.result) {
      throw new DshWebError('DSH web вернул неверный RPC-ответ', 'dsh_bad_response', true);
    }

    if (!frame.result.ok) {
      throw new DshWebError(
        String(frame.result.error?.message || 'DSH web отклонил запрос'),
        String(frame.result.error?.code || 'dsh_rpc_error'),
      );
    }

    return frame.result.value;
  }

  /**
   * Созданная сессия подтверждается тем же envelope и идентификатором.
   * Явный sessionId означает resume: ответ с другим идентификатором считается отказом.
   */
  async createSession(cwd: string, sessionId?: string | null, signal?: AbortSignal): Promise<string> {
    const value = await this.rpc('session/create', {
      request: { cwd, ...(sessionId ? { sessionId } : {}) },
    }, 30_000, signal) as { sessionId?: unknown };
    const id = String(value?.sessionId || '');

    if (!id || (sessionId && id !== sessionId)) {
      throw new DshWebError('DSH web не подтвердил сессию', 'dsh_session_invalid');
    }

    return id;
  }

  /**
   * Web-RPC выбора модели с effort и обратным чтением через snapshot follow.
   * Неподдерживаемаемый выбор отказывает кодом DSH, а не тихо меняет модель.
   */
  async selectModel(
    sessionId: string, provider: string, model: string, effort?: string, signal?: AbortSignal,
  ): Promise<void> {
    await this.rpc('session/selectModel', {
      request: { sessionId, provider, model, ...(effort ? { reasoningEffort: effort } : {}) },
    }, 30_000, signal);
  }

  /**
   * Отмена prompt не означает, что внешний вендор гарантированно не получил уже принятый текст.
   * Режим queue ставит ход в очередь сессии, steer — вставляет в идущий Agent loop.
   */
  async prompt(
    sessionId: string, text: string, requestId: string, mode: 'queue' | 'steer', signal?: AbortSignal,
  ): Promise<{ accepted: true }> {
    return await this.rpc('session/prompt', {
      request: {
        requestId,
        sessionId,
        mode,
        content: [{ type: 'text', text }],
      },
    }, 30_000, signal) as { accepted: true };
  }

  async cancel(sessionId: string): Promise<void> {
    await this.rpc('session/cancel', { request: { sessionId } }, 5_000);
  }

  /** Ответ на событие $events: подтверждение инструмента или ответ на вопрос агента. */
  async answerEvent(
    clientId: string, eventId: string, outcome: { kind: string; value?: unknown },
  ): Promise<void> {
    await this.rpc('$events/result', { clientId, eventId, outcome }, 30_000);
  }
}

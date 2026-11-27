import { randomUUID } from 'node:crypto';

import type { DshWebClient } from './client.ts';

export interface DshWireFrame {
  type: string;
  [key: string]: unknown;
}

type ItemListener = (item: DshWireFrame) => void;

/**
 * Один открытый поток DSH: подписка на endpoint через remote.mux.
 * Слушателей может быть несколько (ходы одной сессии меняются, поток живёт дольше),
 * поэтому `subscribe` возвращает отписку, а закрытие потока сообщает каждый слушатель.
 */
export interface DshEventSource {
  readonly ready: Promise<void>;
  subscribe(listener: ItemListener): () => void;
  close(): void;
}

export interface DshStreamOptions {
  client: DshWebClient;
  endpoint: string;
  args?: Record<string, unknown>;
  onClose?: (error: Error) => void;
}

interface WireFrame {
  type?: unknown;
  streamId?: unknown;
  value?: unknown;
  error?: { message?: unknown } | null;
}

// Глобальный WebSocket Node (undici) принимает init с headers, но @types/node этого поля
// не объявляет: cookie авторизации передаётся через структурно описанный конструктор.
interface WebSocketWithHeaders {
  new(url: URL, init: { headers: Record<string, string> }): WebSocket;
}

/**
 * Открывает WebSocket `/api/remote.mux` с cookie этого запуска глобальным WebSocket Node 22+
 * без пакета ws. Первый кадр item подтверждает готовность; error/end/закрытие сокета
 * сообщаются слушателям как ошибка. Внешний сокет закрывается только через close().
 */
export function openDshStream(options: DshStreamOptions): DshEventSource {
  const streamId = randomUUID();
  const wsUrl = new URL('/api/remote.mux', options.client.baseUrl);

  wsUrl.protocol = 'ws:';

  const listeners = new Set<ItemListener>();
  let closed = false;
  let settled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  // Отказ до первого ожидания не должен стать unhandled rejection: await в ходе увидит ту же ошибку.
  ready.catch(() => {});

  const socket = new (WebSocket as unknown as WebSocketWithHeaders)(wsUrl, {
    headers: { Cookie: options.client.cookie },
  });

  /**
   * Ошибка потока до готовности отменяет ожидание ready, после готовности — доходит
   * каждому слушателю и закрывает сокет, чтобы подписки не висели на мёртвом соединении.
   */
  const fail = (error: Error) => {
    if (!settled) {
      settled = true;
      rejectReady(error);
    }

    if (!closed) {
      closed = true;
      options.onClose?.(error);
      socket.close();
    }
  };

  socket.addEventListener('open', () => {
    const payload = { args: options.args ?? {} };
    const open = { type: 'open', streamId, endpoint: options.endpoint, payload };

    socket.send(JSON.stringify(open));
  });

  socket.addEventListener('message', (event: MessageEvent<unknown>) => {
    let frame: WireFrame;

    try {
      frame = JSON.parse(String(event.data)) as WireFrame;
    } catch {
      fail(new Error('DSH web прислал неверный кадр'));

      return;
    }

    if (frame.streamId !== streamId) {
      return;
    }

    if (frame.type === 'error') {
      fail(new Error(String(frame.error?.message || 'DSH web закрыл поток с ошибкой')));

      return;
    }

    if (frame.type === 'end') {
      fail(new Error('DSH web закрыл поток до завершения подписки'));

      return;
    }

    if (frame.type !== 'item' || !frame.value || typeof frame.value !== 'object') {
      return;
    }

    if (!settled) {
      settled = true;
      resolveReady();
    }

    for (const listener of [...listeners]) {
      listener(frame.value as DshWireFrame);
    }
  });

  socket.addEventListener('error', () => fail(new Error('WebSocket DSH завершился с ошибкой')));
  socket.addEventListener('close', () => fail(new Error('WebSocket DSH закрылся')));

  return {
    ready,
    subscribe(listener: ItemListener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      if (!closed) {
        closed = true;
        listeners.clear();
        socket.close();
      }
    },
  };
}

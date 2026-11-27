import { randomUUID } from 'node:crypto';

import type { DshWebClient } from './client.ts';
import type { DshEventSource, DshWireFrame } from './events.ts';

export type GlmTurnReason = 'completed' | 'auth' | 'quota' | 'delivery' | 'blocked' | 'aborted';

export interface GlmTurnResult {
  ok: boolean;
  reason: GlmTurnReason;
  replyText: string;
  detail: string;
  events: Record<string, unknown>[];
}

export interface GlmTurnOptions {
  client: DshWebClient;
  events: { follow: DshEventSource; remote: DshEventSource };
  sessionId: string;
  text: string;
  timeoutMs?: number;
  onEvent?: (item: DshWireFrame) => void;
}

const DEFAULT_TURN_TIMEOUT_MS = 180_000;
const MAX_SAVED_EVENTS = 2_000;

// Бизнес-коды Z.ai: доступ к модели закрыт планом или ключом.
const ACCESS_CODES = new Set(['1309', '1311', '1313', '1314', '1315']);
// Окно использования исчерпано, хотя Harness может назвать это RATE_LIMIT.
const USAGE_CODES = new Set(['1308', '1310', '1316', '1317', '1318', '1319', '1320', '1321']);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export type GlmModelErrorKind = Exclude<GlmTurnReason, 'completed' | 'blocked' | 'aborted'>;

/**
 * Классифицирует отказ модели из turn/end.reason.error по коду Harness и бизнес-коду Z.ai
 * из текста: AUTH и коды доступа означают проблему ключа или плана, QUOTA, коды окна и 1113 —
 * исчерпанную квоту, остальное — сбой доставки, который повтор может исправить.
 */
export function classifyGlmTurnError(failure: Record<string, unknown>): GlmModelErrorKind {
  const harnessKind = String(failure.code || '');
  const providerCode = /"code"\s*:\s*"?(\d+)"?\s*[,}]/u.exec(String(failure.message || ''))?.[1] ?? '';

  if (harnessKind === 'AUTH' || ACCESS_CODES.has(providerCode)) {
    return 'auth';
  }

  if (harnessKind === 'QUOTA' || USAGE_CODES.has(providerCode) || providerCode === '1113') {
    return 'quota';
  }

  return 'delivery';
}

/**
 * Один ход сессии GLM: prompt ставится в очередь, события follow читаются до turn/end,
 * а запросы подтверждения инструмента закрываются сами — smoke работает в одноразовом
 * приватном home, поэтому автоматическое «allowed-once» не расширяет ничьи права.
 * Ответ собирается из дельт и завершённых блоков; turn/end учитывается только после
 * turn/start этого хода, чтобы поздние события прежнего хода не закрыли новый.
 */
export async function runGlmTurn(options: GlmTurnOptions): Promise<GlmTurnResult> {
  const saved: Record<string, unknown>[] = [];
  const drafts = new Map<string, string>();
  const completed = new Map<string, string>();
  let messageReply = '';
  let turnStarted = false;
  let clientId = '';
  let settled = false;
  let resolveEnd!: (result: GlmTurnResult) => void;
  let rejectEnd!: (error: Error) => void;
  const ended = new Promise<GlmTurnResult>((resolve, reject) => {
    resolveEnd = resolve;
    rejectEnd = reject;
  });

  const save = (item: DshWireFrame) => {
    if (saved.length < MAX_SAVED_EVENTS) {
      saved.push(item);
    }

    options.onEvent?.(item);
  };

  /**
   * Текст ответа: дельты копятся черновиком по id блока, block-end и assistant/message
   * фиксируют завершённый текст, который поздние дельты уже не меняют.
   */
  const collectReply = (item: DshWireFrame) => {
    if (item.type === 'assistant-stream') {
      const frame = record(item.frame);

      if (frame.type !== 'chunk') {
        return;
      }

      const chunk = record(frame.chunk);
      const id = `${String(frame.attemptId || '')}-${String(chunk.index ?? '0')}`;

      if (chunk.type === 'text-delta') {
        drafts.set(id, `${drafts.get(id) || ''}${String(chunk.text || '')}`);
      } else if (chunk.type === 'block-end') {
        const text = String(record(chunk.block).text || drafts.get(id) || '');

        if (text) {
          completed.set(id, text);
        }
      }

      return;
    }

    if (item.type === 'event' && record(item.event).type === 'assistant/message') {
      const data = record(record(item.event).data);
      const stream = Array.isArray(data.stream) ? data.stream : [];
      let text = '';

      for (const entry of stream) {
        const row = record(entry);

        if (row.type === 'text-chunks' && Array.isArray(row.texts)) {
          text += row.texts.map(String).join('');
        } else if (row.type === 'chunk' && record(row.chunk).type === 'text-delta') {
          text += String(record(row.chunk).text || '');
        }
      }

      if (text) {
        messageReply = text;
      }
    }
  };

  const finish = (result: GlmTurnResult) => {
    if (!settled) {
      settled = true;
      resolveEnd(result);
    }
  };

  const unsubscribeRemote = options.events.remote.subscribe((item) => {
    save(item);

    if (item.type === 'ready') {
      clientId = String(item.clientId || '');

      return;
    }

    if (item.type !== 'waterfall') {
      return;
    }

    const eventId = String(item.eventId || '');

    if (item.event === 'approval/request') {
      void options.client.answerEvent(clientId, eventId, { kind: 'result', value: 'allowed-once' })
        .catch(() => {});
    } else if (item.event === 'user-questions/request') {
      void options.client.answerEvent(clientId, eventId, { kind: 'result', value: { answers: [] } })
        .catch(() => {});
    }
  });

  const unsubscribeFollow = options.events.follow.subscribe((item) => {
    save(item);
    collectReply(item);

    if (item.type !== 'event') {
      return;
    }

    const event = record(item.event);
    const data = record(event.data);

    if (event.type === 'turn/start') {
      turnStarted = true;
    }

    if (event.type !== 'turn/end' || !turnStarted) {
      return;
    }

    const reason = record(data.reason);
    const kind = String(reason.kind || '');
    const lastCompleted = [...completed.values()].at(-1) || '';
    const lastDraft = [...drafts.values()].at(-1) || '';
    const replyText = lastCompleted || messageReply || lastDraft;

    if (kind === 'completed') {
      finish({ ok: true, reason: 'completed', replyText, detail: '', events: saved });

      return;
    }

    if (kind === 'blocked') {
      finish({
        ok: false,
        reason: 'blocked',
        replyText,
        detail: 'Ход заблокирован политикой Harness',
        events: saved,
      });

      return;
    }

    if (kind === 'error') {
      const failure = record(reason.error);
      const message = String(failure.message || 'Ошибка модели GLM');

      finish({
        ok: false,
        reason: classifyGlmTurnError(failure),
        replyText,
        detail: message,
        events: saved,
      });

      return;
    }

    finish({
      ok: false,
      reason: 'aborted',
      replyText,
      detail: `Ход прерван: ${kind || 'неизвестно'}`,
      events: saved,
    });
  });

  try {
    await options.events.follow.ready;
    await options.events.remote.ready;

    await options.client.prompt(options.sessionId, options.text, randomUUID(), 'queue');

    const timeout = options.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    const timer = setTimeout(() => {
      void options.client.cancel(options.sessionId).catch(() => {});
      finish({
        ok: false,
        reason: 'aborted',
        replyText: [...completed.values()].at(-1) || messageReply,
        detail: `Таймаут хода ${timeout} мс`,
        events: saved,
      });
    }, timeout);

    try {
      return await ended;
    } finally {
      clearTimeout(timer);
    }
  } finally {
    unsubscribeFollow();
    unsubscribeRemote();
  }
}

// Приватный stdio-мост связывает ACP SDK с исходным settings controller.
// Он не регистрирует инструменты модели и не дублирует проверку схемы или CAS.

import { RequestError } from '@agentclientprotocol/sdk';

export const name = 'grigdesk-acp-settings';
export const inject = ['settingsController', 'settings'];

/**
 * SDK сохраняет бизнес-причину controller через штатный RequestError.
 * Этот ответ остаётся приватным stdio-протоколом; stack и credentials не добавляются.
 */
async function delegate(operation) {
  try {
    return await operation();
  } catch (error) {
    throw RequestError.internalError({ kind: error.code || 'settings/internal' }, error.message);
  }
}

/**
 * Parser ограничивает только RPC envelope; значения проверяет upstream controller.
 * SDK отвергает неверные params до вызова метода и не выводит их в stdout.
 */
function parameters(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Некорректный запрос private settings');
  }

  return value;
}

/**
 * Сервис захватывается при injection и остаётся тем же владельцем namespaces.
 * Обе операции доступны host-клиенту до любой рабочей session/prompt.
 */
export function apply(ctx) {
  const controller = ctx.settingsController;

  ctx.provide('grigdeskAcpSettingsBridge', {
    capabilities: { 'grigdesk.settings': { contract: 1 } },
    configure(app, owner) {
      if (process.env.GRIGDESK_DSH_TERMINAL_CHAT === '1') {
        configureTerminal(ctx, app, owner);
      }

      app.onRequest('_grigdesk/settings/describe', parameters, () =>
        delegate(() => controller.describeWhenReady()));
      app.onRequest('_grigdesk/settings/mutate', parameters, async ({ params }) => {
        if (
          typeof params.ns !== 'string' || !Array.isArray(params.ops) ||
          !Number.isSafeInteger(params.expectedRevision)
        ) {
          throw new Error('Некорректный запрос private settings mutation');
        }

        return delegate(() => controller.mutate(params.ns, params.ops, params.expectedRevision));
      });
    },
  });
}

/**
 * Расширение интерактивной консоли адресует только сессии текущего ACP.
 * Ответы детей и команды используют штатные lifecycle и журнал Harness.
 */
function configureTerminal(ctx, app, owner) {
  /**
   * Root проверяется через ACP owner, а принадлежность ребёнка — реестром DSH.
   * Произвольно указанный идентификатор сессии не получает канал консоли.
   */
  function rootFor(agent) {
    if (!agent || owner.agent(agent.session.id) === agent) {
      return agent;
    }

    try {
      const root = ctx.get('subagents')?.rootOf(agent);

      return root && owner.agent(root.session.id) === root ? root : undefined;
    } catch {
      return undefined;
    }
  }

  const planTools = new Set([
    'read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch', 'skill',
    'get_goal', 'ask_user_question', 'exit_plan_mode',
  ]);

  /**
   * Один фильтр используется в схеме и registry. Состояние режима принадлежит
   * журналу DSH и сохраняется при продолжении терминальной сессии.
   */
  function terminalToolAllowed(tool, agent) {
    const plan = agent?.session.ownEvents().findLast((event) => event.type === 'plan/mode');

    if (plan?.data.active === true && !planTools.has(tool)) {
      return false;
    }

    return !tool.startsWith('schedule_') || Boolean(agent && owner.agent(agent.session.id) === agent);
  }

  ctx.provide('grigdeskGlmToolVisible', terminalToolAllowed);
  ctx.provide('grigdeskAllowChildQuestions', (agent) => rootFor(agent) !== undefined);
  ctx.provide('grigdeskScheduleSessionOnly', true);

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!terminalToolAllowed(exec.name, exec.agent)) {
      return { kind: 'deny', reason: 'Вызов выходит за права терминальной сессии.' };
    }

    if (['schedule_create', 'schedule_edit'].includes(exec.name)
      && (owner.agent(exec.agent?.session.id) !== exec.agent
        || exec.arguments?.target !== undefined && exec.arguments.target !== 'this_session')) {
      return { kind: 'deny', reason: 'Терминальное расписание запускается в открытой основной сессии.' };
    }
    if (['schedule_edit', 'schedule_view'].includes(exec.name)) {
      const task = await ctx.get('schedule')?.view({ id: exec.arguments?.id });

      if (task?.target?.kind !== 'session' || task.target.sessionId !== exec.agent.session.id) {
        return { kind: 'deny', reason: 'Расписание не принадлежит текущей сессии.' };
      }
    }

    return next();
  }, { global: true });

  app.onRequest('_grigdesk/terminal/ready', parameters, ({ params }) => {
    if (typeof params.sessionId !== 'string' || !owner.agent(params.sessionId)) {
      throw RequestError.invalidParams();
    }

    ctx.get('schedule')?.notifySessionAvailable();

    return {};
  });

  app.onRequest('_grigdesk/terminal/command', parameters, async ({ params, signal }) => {
    const agent = typeof params.sessionId === 'string' && owner.agent(params.sessionId);
    const commands = ctx.get('commands');

    if (!agent || !commands || typeof params.line !== 'string' || !/^\/(plan|goal)(?:\s|$)/u.test(params.line)) {
      throw RequestError.invalidParams();
    }

    return delegate(async () => {
      const execution = await commands.execute(agent, params.line, [], signal);

      return execution?.result ?? { kind: 'error', text: 'Команда недоступна в этой сессии.' };
    });
  });

  ctx.on('user-questions/request', (request, next) => {
    const root = rootFor(request.agent);

    if (!root) {
      return next();
    }

    return owner.client().request('_grigdesk/terminal/question', {
      sessionId: root.session.id,
      questions: request.questions,
    }, { signal: request.signal });
  }, { global: true });

  ctx.on('schedule/resolve-agent', (sessionId, next) => {
    const agent = owner.agent(sessionId);

    return agent ? Promise.resolve(agent) : next();
  }, { global: true });

  ctx.on('session/event', (session, event) => {
    const agent = ctx.get('agents')?.get(session.id);
    const root = rootFor(agent);

    if (!root || agent === root || session.header.origin !== 'subagent'
      || event.seq < session.inheritedEventCount || event.type !== 'turn/end') {
      return;
    }

    const events = session.ownEvents();
    const final = events.findLast((item) =>
      item.type === 'assistant/message' && item.data.turn === event.data.turn);
    const blocks = final?.data.message.content ?? [];
    const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('');
    const reason = event.data.reason;

    void owner.client().notify('_grigdesk/terminal/child', {
      sessionId: root.session.id,
      name: ctx.get('subagents')?.namesOf(agent).self ?? 'Субагент',
      text: reason.kind === 'error' ? reason.error.message : text,
      status: reason.kind,
    }).catch(() => {});
  }, { global: true });
}

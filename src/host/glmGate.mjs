import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';

import { GLM_GATE_REVISION, glmGateHash, parseGlmGateProof } from './glmGateProtocol.mjs';

export const name = 'grigdesk-glm-gate';
export const inject = ['tools', 'agents', 'shell', 'sessionProjections', 'approval', 'llm'];

/**
 * Native gate принадлежит GLM-процессу и проверяет все registry executions.
 * Окончательный guard не зависит от порядка разрешающих pre-execute listeners.
 */
export async function apply(ctx, config) {
  if (!config || typeof config.command !== 'string' || !config.command
    || typeof config.launchId !== 'string' || !config.launchId
    || typeof config.policyFile !== 'string' || !config.policyFile) {
    throw new Error('Не задана обязательная конфигурация native gate GLM');
  }

  const document = JSON.parse(readFileSync(config.policyFile, 'utf8'));
  const projectPrefix = document.projectMcp ? `mcp__${document.projectMcp}__` : '';
  const isProjectTool = (tool) => projectPrefix && tool.startsWith(projectPrefix);

  const planning = new WeakSet();
  const planTools = new Set([
    'read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch', 'skill',
    'get_goal', 'ask_user_question', 'exit_plan_mode',
  ]);
  const visible = new Set(config.visibleTools ?? []);
  const work = new Set(config.workToolNames ?? []);
  const allowedFor = (tool, agent) => {
    const child = agent.session.header.origin === 'subagent';

    if (planning.has(agent.session) && !planTools.has(tool)) {
      return false;
    }

    if (child && ['create_goal', 'update_goal', 'exit_plan_mode', 'workflow', 'ralph'].includes(tool)) {
      return false;
    }

    if (tool === 'structured_output') {
      return visible.has(tool) && lineage.get(agent.session)?.workflow === true;
    }

    return visible.has(tool) || work.has(tool) || !child && Boolean(isProjectTool(tool));
  };
  const policyHash = glmGateHash(document);
  const preflight = { launchId: config.launchId, policyHash };
  const preflightProcess = await ctx.shell.execute(ctx.shell.resolve({
    command: config.command,
    stdin: JSON.stringify({ preflight }),
    workdir: process.cwd(),
    signal: AbortSignal.timeout(30_000),
    timeoutMs: 30_000,
  }));
  const check = await preflightProcess.result();

  if (check.exitCode !== 0 || check.stdout.text !== JSON.stringify({ ready: true, ...preflight })) {
    throw new Error('Helper native gate GLM не готов');
  }

  if (Array.isArray(config.visibleTools)) {
    ctx.provide('grigdeskGlmToolVisible', allowedFor);
  }

  const active = new AsyncLocalStorage();
  const proofs = new WeakMap();
  const projectGrants = new WeakSet();
  const lineage = new WeakMap();
  const ready = new WeakSet();
  let fatal = false;

  /**
   * Ошибка enforcement закрывает все новые действия процесса немедленно.
   * Типизированный журнал даёт серверу причину остановить принадлежащее ему дерево.
   */
  function broken(agent) {
    if (fatal) {
      return;
    }

    fatal = true;
    agent?.session.append('grigdesk/glm-policy-error', {
      launchId: config.launchId,
      code: 'glm_policy_gate_failed',
    });

    for (const root of ctx.agents.list()) {
      if (root.session.header.origin === 'subagent') {
        continue;
      }

      if (root !== agent) {
        root.session.append('grigdesk/glm-policy-error', {
          launchId: config.launchId,
          code: 'glm_policy_gate_failed',
        });
      }

      root.cancel({ kind: 'parent' });
    }
  }

  /**
   * Descriptor может прийти из setup раньше agent/created.
   * Только оба события одной Session доказывают связь с исходным вызовом.
   */
  function lineageOf(session) {
    let child = lineage.get(session);

    if (!child) {
      child = { announced: false };
      lineage.set(session, child);
    }

    return child;
  }

  /**
   * Публикует родительскую связь один раз, даже если append синхронно вызывает observers.
   * Отменённый или ещё не созданный ребёнок остаётся без подтверждённой связи.
   */
  function announceIfReady(session) {
    const child = lineage.get(session);

    if (!child?.descriptor || !child.link || !ready.has(session) || child.announced || fatal
      || child.descriptor.mode !== child.link.mode) {
      return;
    }

    child.announced = true;
    child.parent.append('grigdesk/glm-delegation', child.link);
  }

  /**
   * Identity берётся из registry execution и текущей проекции хода.
   * В аргументы helper не подмешиваются произвольные поля модели с идентификаторами.
   */
  function bindingOf(exec) {
    if (!exec.agent || !ready.has(exec.agent.session)) {
      throw new Error('Вызов GLM без зарегистрированного владельца');
    }

    return {
      format: 1,
      consumer: 'chat',
      launchId: config.launchId,
      policyHash,
      sessionId: exec.agent.session.id,
      agentId: exec.agent.id,
      turn: ctx.sessionProjections.stateOf(exec.agent.session, 'turnBoundary').lastTurn,
      callId: exec.callId,
      name: exec.name,
      sha256: glmGateHash(exec.arguments),
    };
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      if (fatal) {
        return { kind: 'deny', reason: 'Проверка политики GLM остановлена' };
      }

      const binding = bindingOf(exec);
      const process = await ctx.shell.execute(ctx.shell.resolve({
        command: config.command,
        stdin: JSON.stringify({ binding, arguments: exec.arguments }),
        workdir: exec.agent.session.header.cwd,
        signal: exec.signal,
        timeoutMs: 30_000,
      }));
      const result = await process.result();

      if (result.exitCode !== 0 || exec.signal.aborted) {
        throw new Error('Helper GLM не подтвердил вызов');
      }

      const verdict = parseGlmGateProof(result.stdout.text, binding);
      const child = exec.agent.session.header.origin === 'subagent';
      const restricted = !allowedFor(exec.name, exec.agent)
        || child && exec.arguments?.sandbox_permissions !== undefined;
      const proof = verdict.decision === 'allow' && restricted
        ? { ...verdict, decision: 'deny', reason: 'Вызов выходит за права агента GLM' }
        : verdict;

      proofs.set(exec, proof);
      exec.agent.session.append('grigdesk/glm-policy', proof);

      if (proof.decision === 'deny') {
        return { kind: 'deny', reason: proof.reason };
      }

      if (isProjectTool(exec.name)) {
        if (!ctx.approval || ctx.agents.get(exec.agent.id) !== exec.agent) {
          return { kind: 'deny', reason: 'Проектный MCP требует решения человека в основном чате' };
        }

        const approval = await ctx.approval.request({
          agent: exec.agent,
          toolName: exec.name,
          callId: exec.callId,
          reason: 'Вызов проектного MCP',
          signal: exec.signal,
        });

        if (approval !== 'allowed-once' || exec.signal.aborted) {
          return { kind: 'deny', reason: 'Вызов проектного MCP не подтверждён' };
        }

        parseGlmGateProof(JSON.stringify(proof), bindingOf(exec));
        projectGrants.add(exec);
      }

      return next();
    } catch {
      if (!exec.signal.aborted) {
        broken(exec.agent);
      }

      return { kind: 'deny', reason: 'Не получено подтверждение политики GLM' };
    }
  }, { global: true });

  ctx.tools.guard((exec) => {
    const proof = proofs.get(exec);

    try {
      if (fatal || exec.signal.aborted || !proof || proof.decision !== 'allow') {
        throw new Error('Нет действующего подтверждения GLM');
      }

      parseGlmGateProof(JSON.stringify(proof), bindingOf(exec));

      if (isProjectTool(exec.name) && !projectGrants.has(exec)) {
        return 'Вызов проектного MCP требует разового подтверждения';
      }

      return undefined;
    } catch {
      if (!exec.signal.aborted) {
        broken(exec.agent);
      }

      return 'Окончательная проверка GLM запретила вызов';
    }
  });

  ctx.on('tools/execute', (exec, next) => active.run({ exec, proof: proofs.get(exec) }, next), { global: true });
  ctx.on('tools/result', (exec) => proofs.delete(exec), { global: true });

  ctx.on('agent/created', ({ agent }) => {
    try {
      const { exec, proof } = active.getStore() ?? {};
      const child = agent.session.header.origin === 'subagent';

      if (child) {
        const resumed = exec?.name === 'send_message';
        const workflow = ['workflow', 'ralph'].includes(exec?.name);
        const mode = resumed || workflow || exec?.arguments?.run_in_background === true
          ? 'continuable' : 'one-shot';

        if (!proof || proof.decision !== 'allow' || !workflow && exec.signal.aborted
          || !['subagent', 'subagent_fork', 'send_message', 'workflow', 'ralph'].includes(exec.name)
          || agent.session.header.parentSession !== exec.agent.session.id) {
          throw new Error('Создание ребёнка без вызова делегирования');
        }

        const link = {
          version: 1,
          launchId: config.launchId,
          parentSessionId: exec.agent.session.id,
          parentTurn: proof.turn,
          parentCallId: exec.callId,
          childSessionId: agent.session.id,
          childAgentId: agent.id,
          mode,
        };

        const state = lineageOf(agent.session);

        if (state.link) {
          throw new Error('Повторное создание ребёнка GLM');
        }

        state.link = link;
        state.workflow = workflow;
        state.parent = exec.agent.session;
        if (resumed) {
          state.descriptor = agent.session.ownEvents().find((event) =>
            event.type === 'subagent/descriptor' && event.data.mode === 'continuable')?.data;
        }
      }

      const plan = agent.session.ownEvents().findLast((event) => event.type === 'plan/mode');

      if (plan?.data.active === true) {
        planning.add(agent.session);
      }

      ready.add(agent.session);
      agent.session.append('grigdesk/glm-ready', {
        revision: GLM_GATE_REVISION,
        launchId: config.launchId,
        policyHash,
        sessionId: agent.session.id,
        agentId: agent.id,
      });
      announceIfReady(agent.session);
    } catch {
      broken(agent);
    }
  }, { global: true });

  ctx.on('session/event', (session, event) => {
    if (event.type === 'plan/mode') {
      if (event.data.active) {
        planning.add(session);
      } else {
        planning.delete(session);
      }
    }

    if (session.header.origin !== 'subagent' || event.type !== 'subagent/descriptor'
      || event.seq < session.inheritedEventCount) {
      return;
    }

    try {
      const child = lineageOf(session);

      if (child.descriptor || child.link && event.data.mode !== child.link.mode) {
        throw new Error('Некорректный descriptor ребёнка GLM');
      }

      child.descriptor = event.data;
      announceIfReady(session);
    } catch {
      broken();
    }
  }, { global: true });

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (fatal || !ready.has(agent.session)
      || agent.session.header.origin === 'subagent' && !lineage.get(agent.session)?.announced) {
      broken(agent);

      return { kind: 'reject' };
    }

    if (lineage.get(agent.session)?.workflow) {
      const route = agent.model.current();
      const models = route.provider === 'zai' ? await ctx.llm.listModels('zai') : [];

      if (!models.some(({ id }) => id === route.model)) {
        return { kind: 'reject' };
      }
    }

    return next();
  }, { global: true, prepend: true });

  ctx.provide('grigdeskAllowChildQuestions', (agent) => {
    const { exec, proof } = active.getStore() ?? {};

    return !fatal && proof?.decision === 'allow' && proof.name === 'ask_user_question'
      && exec.agent === agent && !exec.signal.aborted && lineage.get(agent.session)?.announced === true;
  });

  ctx.on('user-questions/request', (request, next) => {
    const { exec, proof } = active.getStore() ?? {};

    if (fatal || !proof || proof.decision !== 'allow'
      || !['ask_user_question', 'exit_plan_mode'].includes(proof.name)
      || request.agent !== exec.agent || exec.signal.aborted) {
      throw new Error('Вопрос GLM без подтверждённого execution');
    }

    request.grigdeskGlm = proof;

    return next();
  }, { global: true, prepend: true });
}

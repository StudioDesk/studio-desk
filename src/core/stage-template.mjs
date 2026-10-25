// Stage templates (MP-015 G3d): one task record moves through ordered stages declared as
// data on its task definition, for example draft → independent review. The first stage is
// the task's own kind; each later stage is its own execution view (kind, role, tier, limits)
// that consumes the accepted result of the stage before it, on the same task. A stage may send
// its task back to an earlier stage when a field of its JSON result says so. The registry
// turns a definition's `stageTemplate` into the generic stage hooks, so any pack, and any
// fan-out child, can be staged without pack code. When every stage is accepted, the task's
// accepted result is the `result` stage's (the first by default), which is what its task
// type declares it produces; the later stages stay recorded in its stage history.
import fs from 'node:fs';
import { hash } from './contracts.mjs';
import { TIERS } from './execution.mjs';
import { artifactPath } from './artifacts.mjs';
import { assertProject, recordProject } from './projects.mjs';
import { projectOrganization } from './project-organization.mjs';
import { staff, isRoleId } from './staffing.mjs';

const VERSION = 'stage-state-v1';
const KEY = /^[a-z][a-z0-9-]{0,39}$/;
const FINISHED = ['done', 'denied', 'cancelled', 'failed'];

// Checks a template against the registered task types; `kindOf` returns a definition or null.
export function validateStageTemplate(owner, template, kindOf) {
  const stages = template?.stages;
  if (!template || typeof template !== 'object' || !Array.isArray(stages) || stages.length < 2 || stages.length > 6)
    throw new Error(`${owner.kind}: a stage template lists 2 to 6 stages.`);
  if (owner.stages) throw new Error(`${owner.kind}: declare either stage hooks or a stage template, not both.`);
  if (Object.keys(template).some(field => !['stages', 'result'].includes(field)))
    throw new Error(`${owner.kind}: a stage template has stages and an optional result stage.`);
  const keys = new Set(),
    kinds = new Set([owner.kind]);
  stages.forEach((stage, index) => {
    const allowed = ['key', 'label', 'kind', 'role', 'tier', 'maxSeconds', 'maxAttempts', 'sendBack'];
    if (!stage || typeof stage !== 'object' || Object.keys(stage).some(field => !allowed.includes(field)))
      throw new Error(`${owner.kind}: stages support only ${allowed.join(', ')}.`);
    if (!KEY.test(stage.key || '') || keys.has(stage.key))
      throw new Error(`${owner.kind}: stage keys are unique lowercase names.`);
    if (
      stage.label !== undefined &&
      (typeof stage.label !== 'string' || !stage.label.trim() || stage.label.length > 80)
    )
      throw new Error(`${owner.kind}: a stage label is short text.`);
    if (index === 0) {
      if (Object.keys(stage).some(field => !['key', 'label'].includes(field)))
        throw new Error(`${owner.kind}: the first stage is the task itself; it names only a key and label.`);
    } else {
      const definition = kindOf(stage.kind);
      if (!definition) throw new Error(`${owner.kind}: stage ${stage.key} names an unregistered kind.`);
      // A stage view is recognized by its kind, so every stage runs a different kind.
      if (kinds.has(stage.kind)) throw new Error(`${owner.kind}: each stage runs a different kind.`);
      kinds.add(stage.kind);
      if (stage.role !== undefined && !isRoleId(stage.role))
        throw new Error(`${owner.kind}: a stage role is a role ID.`);
      if (stage.tier !== undefined && !TIERS.includes(stage.tier))
        throw new Error(`${owner.kind}: a stage tier is one of ${TIERS.join(', ')}.`);
      if (
        stage.maxSeconds !== undefined &&
        (!Number.isInteger(stage.maxSeconds) || stage.maxSeconds < 5 || stage.maxSeconds > 3600)
      )
        throw new Error(`${owner.kind}: a stage time limit is 5 to 3600 seconds.`);
      if (
        stage.maxAttempts !== undefined &&
        (!Number.isInteger(stage.maxAttempts) || stage.maxAttempts < 1 || stage.maxAttempts > 3)
      )
        throw new Error(`${owner.kind}: a stage allows 1 to 3 attempts.`);
      // Typed ports: a stage consumes only what the stage before it produces.
      const previous = index === 1 ? owner : kindOf(stages[index - 1].kind);
      const missing = (definition.consumes || []).filter(format => !(previous.produces || []).includes(format));
      if (missing.length)
        throw new Error(
          `${owner.kind}: stage ${stage.key} consumes ${missing.join(', ')}, which the stage before it does not produce.`,
        );
    }
    if (stage.sendBack !== undefined) {
      const rule = stage.sendBack;
      if (
        index === 0 ||
        !rule ||
        typeof rule !== 'object' ||
        Object.keys(rule).some(field => !['to', 'artifact', 'field', 'equals'].includes(field)) ||
        !keys.has(rule.to) ||
        typeof rule.artifact !== 'string' ||
        !/^[a-zA-Z0-9_.-]{1,80}\.json$/.test(rule.artifact) ||
        typeof rule.field !== 'string' ||
        !/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(rule.field) ||
        !Array.isArray(rule.equals) ||
        !rule.equals.length ||
        rule.equals.some(value => !['string', 'number', 'boolean'].includes(typeof value))
      )
        throw new Error(
          `${owner.kind}: stage ${stage.key} sends back to an earlier stage when a field of one of its JSON artifacts equals a listed value.`,
        );
    }
    keys.add(stage.key);
  });
  if (template.result !== undefined) {
    const index = stages.findIndex(stage => stage.key === template.result),
      produced = index > 0 ? kindOf(stages[index].kind).produces || [] : owner.produces || [];
    if (index < 0) throw new Error(`${owner.kind}: the result names one of its stages.`);
    // The task's accepted result must carry what its task type says it produces.
    if ((owner.produces || []).some(format => !produced.includes(format)))
      throw new Error(`${owner.kind}: the result stage must produce what ${owner.kind} produces.`);
  }
  return template;
}

// Generic stage hooks for a validated template.
export function templateStages(ownerKind, template) {
  const stages = template.stages,
    position = key =>
      Math.max(
        0,
        stages.findIndex(stage => stage.key === key),
      ),
    kindAt = index => (index === 0 ? ownerKind : stages[index].kind),
    label = stage => stage.label || stage.key,
    fresh = () => ({
      version: VERSION,
      current: stages[0].key,
      enteredAt: null,
      staffed: {},
      outputs: {},
      history: [],
    });

  // The exact accepted result of an earlier stage of the same task, with its bytes checked; with no
  // kind, an accepted result of another task in `project` that the task's first stage was given.
  function reference(store, taskId, attemptId, kind, project) {
    const attempt = attemptId && store.attempt(attemptId),
      task = store.task(taskId);
    if (
      !attempt ||
      attempt.taskId !== taskId ||
      attempt.status !== 'accepted' ||
      attempt.result?.outcome !== 'completed' ||
      (kind && (attempt.assignment?.kind || task.kind) !== kind)
    )
      throw new Error(
        kind
          ? 'Select the exact accepted result of the stage before this one.'
          : `An input the work was given (${taskId}) is no longer an accepted result. Run the work again on its current inputs.`,
      );
    assertProject(store, attempt, project ?? recordProject(task));
    for (const item of attempt.artifacts)
      if (hash(fs.readFileSync(artifactPath(store, attempt, item.path))) !== item.hash)
        throw new Error('Accepted input was modified after acceptance.');
    return {
      taskId,
      attemptId,
      summary: attempt.result.summary,
      artifacts: attempt.artifacts.map(({ path, kind, hash }) => ({ path, kind, hash })),
    };
  }
  function sentBack(store, attempt, rule) {
    const item = attempt.artifacts.find(item => item.path === rule.artifact);
    if (!item) return false;
    let value;
    try {
      value = JSON.parse(fs.readFileSync(artifactPath(store, attempt, item.path), 'utf8'))?.[rule.field];
    } catch {
      return false;
    }
    return rule.equals.includes(value);
  }
  const hooks = {
    view(task) {
      const state = task.stageState,
        index = state ? position(state.current) : 0;
      if (index === 0) return task;
      const stage = stages[index],
        staffed = state.staffed[stage.key] || {};
      return {
        ...task,
        kind: stage.kind,
        workerId: staffed.workerId,
        team: staffed.team,
        teamId: staffed.teamId,
        staffing: staffed.staffing,
        dependencies: [task.id],
        acceptedInputs: [],
        resources: [],
        execution: {},
        tier: stage.tier,
        maxSeconds: stage.maxSeconds ?? task.maxSeconds,
        maxAttempts: stage.maxAttempts ?? task.maxAttempts,
        direction: state.direction || '',
      };
    },
    // Attempts of the current stage since the task entered it.
    attempts(store, task) {
      const state = task.stageState,
        index = state ? position(state.current) : 0;
      return store
        .attempts(task.id)
        .filter(
          attempt =>
            (attempt.assignment?.kind || ownerKind) === kindAt(index) &&
            (index === 0 || !state.enteredAt || attempt.startedAt >= state.enteredAt),
        );
    },
    progress(task) {
      // Records that finished before the template applied keep their history as it was.
      if (task.kind !== ownerKind || task.stageState || FINISHED.includes(task.status)) return;
      task.stageState = fresh();
    },
    // The accepted result of the stage before, then the accepted inputs the task's first stage was
    // given, each checked again, so a review can judge the work against what it was built from. A
    // controller transform's file is left out: it is derived from inputs that are staged themselves.
    inputs(store, view) {
      const state = view.stageState,
        index = position(state.current),
        previous = stages[index - 1],
        first = state.outputs[stages[0].key]?.attemptId,
        given = (first && store.attempt(first)?.inputReferences) || [],
        project = recordProject(store.task(view.id));
      return [
        reference(store, view.id, state.outputs[previous.key]?.attemptId, kindAt(index - 1)),
        ...given
          .filter(ref => ref.attemptId && ref.taskId !== view.id)
          .map(ref => reference(store, ref.taskId, ref.attemptId, null, project)),
      ];
    },
    // Runs inside the acceptance transaction: advance, send back, or finish.
    accepted(store, registries, task, attempt) {
      if (task.kind !== ownerKind) return;
      task.stageState ||= fresh();
      const state = task.stageState,
        index = position(state.current),
        stage = stages[index],
        now = new Date().toISOString();
      if ((attempt.assignment?.kind || ownerKind) !== kindAt(index))
        throw new Error('The accepted attempt does not belong to the current stage.');
      if (stage.sendBack && sentBack(store, attempt, stage.sendBack)) {
        const target = stages[position(stage.sendBack.to)],
          note = `${label(stage)} sent this back: ${attempt.result.summary}`.slice(0, 2000);
        state.history.push({
          key: stage.key,
          attemptId: attempt.id,
          workerId: attempt.workerId,
          at: now,
          outcome: 'sent-back',
        });
        Object.assign(state, { current: target.key, enteredAt: now, direction: position(target.key) ? note : '' });
        if (position(target.key) === 0)
          task.direction = `${task.direction ? task.direction + '\n\n' : ''}${note}`.slice(-24000);
        // The earlier stage runs again when the director starts it; until then it waits with
        // the reason (a director wait, which the queue does not re-evaluate).
        Object.assign(task, {
          status: 'blocked',
          queued: false,
          controllerWait: false,
          reason: `${note.slice(0, 600)} Start it to run ${label(target)} again.`,
        });
        store.putTask(task);
        return;
      }
      state.history.push({
        key: stage.key,
        attemptId: attempt.id,
        workerId: attempt.workerId,
        at: now,
        outcome: 'accepted',
      });
      state.outputs[stage.key] = { attemptId: attempt.id };
      if (index === stages.length - 1) {
        state.complete = now;
        task.acceptedAttemptId = state.outputs[template.result || stages[0].key].attemptId;
        store.putTask(task);
        return;
      }
      // Staff the next stage now. If no one can run it, acceptance is refused with the reason,
      // so the task never waits half-advanced; assign the role and accept again.
      const next = stages[index + 1],
        definition = registries.workflows.get(next.kind),
        { worker, staffing } = staff(projectOrganization(store, recordProject(task)), registries, {
          kind: next.kind,
          role: next.role,
          exclude: definition.distinctFromInputs ? [attempt.workerId] : [],
        });
      state.staffed[next.key] = {
        workerId: worker.id,
        team: worker.team,
        teamId: worker.teamId,
        ...(staffing ? { staffing } : {}),
      };
      Object.assign(state, { current: next.key, enteredAt: now, direction: '' });
      Object.assign(task, { status: 'ready', queued: true, controllerWait: true, reason: '' });
      store.putTask(task);
    },
    // A later stage's findings rewind the task (for example an autonomy retry). When the stage's own
    // send-back already rewound it, there is nothing more to rewind and the retry runs that stage.
    retry(task) {
      const state = task.stageState;
      if (state?.history.at(-1)?.outcome === 'sent-back') return true;
      if (!state || position(state.current) === 0) return false;
      const target = stages[position(state.current)].sendBack?.to || stages[0].key;
      Object.assign(state, { current: target, enteredAt: new Date().toISOString(), direction: '' });
      return true;
    },
    clear: task => delete task.stageState,
    // A later stage keeps its own direction; the first stage uses the task's.
    direction(task, text) {
      const state = task.stageState;
      if (!state || position(state.current) === 0) return false;
      state.direction = text;
      return true;
    },
  };
  return Object.freeze(hooks);
}

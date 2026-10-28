// Applies a project's autonomy policy (core/autonomy.mjs) to controller events.
// Everything here goes through the same functions the director's routes use,
// so validation, provenance and resource ownership are unchanged. Anything the
// policy does not allow, or anything that fails, is left for the director with
// an 'autonomy_attention' event.
import { randomUUID } from 'node:crypto';
import { recordProject } from './projects.mjs';
import { acceptAttempt } from './acceptance.mjs';
import { approveWork } from './proposals.mjs';
import { materializeWorkflow } from './workflows.mjs';
import { expandRun, runIdOf } from './graph.mjs';
import { autonomyPolicy, kindMode, evaluateAttempt, cycleRunsToday, recordCycleRun } from './autonomy.mjs';
import { sendWaitingIdea } from './idea-intake.mjs';
import { compareVersions, parseVersion, projectMilestones } from '../connectors/source-milestones.mjs';
import { projectLine } from '../connectors/source-lines.mjs';
import { mergeSourceStory, sourceStoryIntegrated } from '../connectors/source-changes.mjs';
import { approveCarry, carryWaits, nextCarry, runCarry } from '../connectors/source-carries.mjs';
import { notesAccepted, runRelease } from '../connectors/source-releases.mjs';
import { answerableInAutoMode, answerQuestion, waitingQuestion } from './questions.mjs';
import { attemptPermissions } from './agent-permissions.mjs';

const INTEGRATION = 'autonomy-integration';
const RESTART = 'planned-restart';
const RESTART_WINDOW_MS = 10 * 60 * 1000;
const bounded = (text, max = 24000) => (text.length > max ? text.slice(0, max - 1) + '…' : text);
const stays = pending => (pending.paused === false ? '' : '; dispatch stays paused');

export class Autonomy {
  // options.integrate(runtime, task, attemptId, reviewHash) performs a reviewed integration.
  // options.restart() relaunches the controller; without it a restart is only requested.
  constructor(runner, options = {}) {
    this.runner = runner;
    this.store = runner.store;
    this.integrate = options.integrate;
    this.restart = options.restart;
    this.resumeAfterPlannedRestart();
    // An integration that was waiting when the controller stopped starts once the controller is running, unless
    // it closed first.
    setImmediate(() => {
      if (!this.runner.closing && this.store.db.isOpen) {
        this.tryIntegration();
        this.tryCarries();
        this.tryReleases();
      }
    });
  }
  policy(task) {
    return autonomyPolicy(this.store, recordProject(task));
  }
  attention(task, reason) {
    task = this.store.task(task.id);
    task.autonomyNote = reason;
    this.store.putTask(task);
    this.store.event('autonomy_attention', task.id, null, `Waiting for the director: ${reason}`, recordProject(task));
  }
  // Queued work waits behind the director's pause of its project, and says so; their resume starts it.
  queue(tasks) {
    if (!tasks.length) return;
    const projectId = recordProject(tasks[0]);
    this.store.tx(() => {
      for (const task of tasks) {
        task.queued = true;
        this.store.putTask(task);
      }
      if (!this.store.project(projectId).dispatchPaused) this.runner.enablePipeline(projectId);
    });
    if (this.store.project(projectId).dispatchPaused) this.runner.refreshReadiness();
    this.runner.schedule();
  }

  // Called after an attempt stops (review, failed, blocked or cancelled).
  settled(taskId) {
    if (this.runner.closing) return;
    let task = this.store.task(taskId);
    if (task.status === 'blocked') {
      this.answerInAutoMode(task);
      task = this.store.task(taskId);
    }
    const policy = this.policy(task);
    if (policy.enabled)
      try {
        if (task.status === 'review') this.reviewed(task, policy);
        else if (task.status === 'failed') this.retry(task, task.reason || 'The attempt failed.', policy);
        else if (task.status === 'blocked') this.scopeRequested(task, policy);
      } catch (error) {
        this.attention(task, error.message);
      }
    this.tryIntegration();
    this.tryCarries();
    this.tryReleases();
    this.sendWaiting(recordProject(task));
  }
  reviewed(task, policy) {
    const attempt = this.store.attempt(task.lastAttemptId),
      view = this.runner.registries.workflows.stageView(task),
      verdict = evaluateAttempt(this.store, this.runner.registries, view, attempt),
      mode = kindMode(policy, view.kind),
      by = reason => ({ type: 'policy', revision: policy.revision, reason });
    if (verdict.ok) {
      // A release's notes are the director's to approve: accepting them tags the release (1.1 step 5).
      if (mode.accept !== 'auto' || task.releaseOf) return;
      acceptAttempt(this.store, this.runner.registries, task, by(verdict.reason));
      this.accepted(task.id);
    } else if (verdict.retryUpstream && mode.accept === 'auto') {
      acceptAttempt(this.store, this.runner.registries, task, by(`Recorded as evidence. ${verdict.reason}`));
      this.retryUpstream(this.store.task(task.id), verdict.retryUpstream, policy);
    } else if (verdict.retry) this.retry(task, verdict.reason, policy);
    else this.attention(task, verdict.reason);
  }

  // Called after any acceptance (director or policy): approve and queue proposals the policy allows.
  accepted(taskId) {
    const task = this.store.task(taskId),
      policy = this.policy(task);
    // A task that is ready and queued again right after acceptance advanced to its next
    // stage. That is controller scheduling, never work approval; the normal queue still
    // owns slots, resources and dispatch gates.
    if (task.status === 'ready' && task.queued) {
      const org = this.store.organization();
      org.pipelineEnabled = true;
      this.store.setOrganization(org);
    }
    // Accepted release notes release their milestone (1.1 step 5), when the project's source is free.
    if (task.releaseOf && task.status === 'done') {
      try {
        notesAccepted(this.store, task);
      } catch (error) {
        this.attention(task, `The release could not start: ${error.message}`);
      }
      this.tryReleases();
    }
    // The task type acts on its accepted result first (a breakdown's stories go to their releases, 1.1 step 2b), so
    // the policy approves only what stays.
    const after = this.runner.registries.workflows.get(task.kind).afterAccept;
    if (after && task.status === 'done')
      try {
        after({ store: this.store, runtime: this.runner, task: this.store.task(taskId) });
      } catch (error) {
        this.attention(task, `The accepted result could not be routed: ${error.message}`);
      }
    if (policy.enabled) {
      const approved = [];
      for (const id of task.proposedTaskIds || []) {
        const proposed = this.store.task(id);
        if (proposed.status !== 'backlog' || proposed.approval?.status !== 'pending') continue;
        if (kindMode(policy, proposed.kind).approve !== 'auto') {
          this.attention(proposed, `Approve or deny proposed work ${proposed.id}: ${proposed.title}`);
          continue;
        }
        try {
          approveWork(this.store, this.runner.registries, proposed, {
            type: 'policy',
            revision: policy.revision,
            reason: 'Task type is approved automatically for this project.',
          });
          approved.push(this.store.task(id));
        } catch (error) {
          this.attention(proposed, error.message);
        }
      }
      this.queue(approved);
      this.integrateAccepted(this.store.task(taskId), policy);
    }
    this.sendWaiting(recordProject(task));
    this.runner.schedule();
  }

  // A task type with an integration step says when its accepted result is ready to integrate (for a
  // source story, when its current independent review passed, MP-023). With the type's integrate
  // mode automatic, the policy requests the integration the director's approval would, recorded as
  // its decision with the review it acted on. Verification, formatting and the full suite still
  // decide, anything that stops waits for the director, and the policy never integrates over a review.
  integrateAccepted(task, policy) {
    const operation = this.runner.registries.workflows.get(task.kind).autonomy?.integration;
    if (!operation || kindMode(policy, task.kind).integrate !== 'auto') return;
    const ready = operation.ready({ store: this.store, task });
    if (!ready) return;
    try {
      this.requestIntegration(task, ready.attemptId, ready.reviewHash, {
        by: { type: 'policy', revision: policy.revision, reason: `${operation.label}: ${ready.reason}` },
      });
    } catch (error) {
      this.attention(task, `The policy could not request integration; approve it yourself. ${error.message}`);
    }
  }

  // Called after the director approves work: with autonomy enabled, approval also queues it.
  approved(taskId) {
    const task = this.store.task(taskId);
    if (this.policy(task).enabled && task.status === 'ready' && !task.queued) this.queue([task]);
  }

  retry(task, reason, policy) {
    // Each stage has its own retry budget and direction: a later stage retrying its own result does
    // not spend the retry that sends the work back, nor write into the earlier stage's direction.
    const workflows = this.runner.registries.workflows,
      view = workflows.stageView(task),
      own = view.kind === task.kind,
      used = (own ? task.autoRetries : task.stageRetries?.[view.kind]) || 0;
    if (used >= policy.retries) return this.attention(task, reason);
    if (workflows.stageAttempts(this.store, task).length >= view.maxAttempts)
      return this.attention(task, `Attempt limit reached. ${reason}`);
    if (task.status === 'review') {
      const attempt = this.store.attempt(task.lastAttemptId);
      attempt.status = 'revision_requested';
      attempt.revisionRequestedBy = {
        type: 'policy',
        revision: policy.revision,
        at: new Date().toISOString(),
        reason: bounded(reason),
      };
      this.store.updateAttempt(attempt);
    }
    // Name the failing tests and their errors, not only the counts (HANDOFF known issue 12).
    const failing = (this.store.attempt(task.lastAttemptId)?.failedTests || [])
      .map(test => `- ${test.name}${test.file ? ` (${test.file})` : ''}${test.error ? `: ${test.error}` : ''}`)
      .join('\n');
    workflows.direct(
      task,
      bounded(
        `${view.direction ? view.direction + '\n\n' : ''}Automatic retry ${used + 1}: the previous attempt did not pass. ${reason}${failing ? `\nFailing tests:\n${failing}` : ''}`,
      ),
    );
    if (own) task.autoRetries = used + 1;
    else task.stageRetries = { ...task.stageRetries, [view.kind]: used + 1 };
    Object.assign(task, { status: 'ready', reason: '', controllerWait: false });
    delete task.autonomyNote;
    workflows.stageProgress(this.store, task);
    this.store.event('autonomy_retry', task.id, task.lastAttemptId, `Automatic retry: ${reason}`, recordProject(task));
    this.queue([task]);
  }

  // An attempt stopped as blocked and recorded a scopeRequest: it asks for a wider scope (for a source
  // story, the files its editor needs, MP-021). When the task type's scope mode is automatic, the
  // policy approves it within the task's attempt limit, through the task type's own operation and the
  // director's checks; the task's later stages, such as an independent review, still judge the result.
  // Otherwise, or when the operation refuses, the request waits for the director.
  // A question the agent marked as a choice inside its story, in work that runs in auto mode, goes ahead on the
  // agent's own recommendation, recorded as auto mode's answer (1.2 step 2). Auto mode is the work's own setting,
  // not the project's policy; every other question waits for the director.
  answerInAutoMode(task) {
    const attempt = waitingQuestion(this.store, task);
    if (!attempt || !answerableInAutoMode(attempt)) return;
    if (attemptPermissions(this.store.organization(), task).mode !== 'auto') return;
    try {
      answerQuestion(
        this.store,
        this.runner.registries,
        task,
        { attemptId: attempt.id, option: attempt.question.recommended },
        { type: 'auto-mode', at: new Date().toISOString() },
      );
      this.queue([this.store.task(task.id)]);
    } catch (error) {
      this.attention(task, `Auto mode could not answer the question: ${error.message}`);
    }
  }

  scopeRequested(task, policy) {
    const workflows = this.runner.registries.workflows,
      operation = workflows.get(task.kind).autonomy?.scopeRequest,
      attempt = task.lastAttemptId && this.store.attempt(task.lastAttemptId);
    if (!operation || attempt?.status !== 'blocked' || !attempt.scopeRequest?.reason) return;
    if (kindMode(policy, task.kind).scope !== 'auto') return;
    if (workflows.stageAttempts(this.store, task).length >= workflows.stageView(task).maxAttempts)
      return this.attention(task, 'Attempt limit reached; approve or change the requested scope yourself.');
    // The operation returns nothing when the request was already answered.
    const applied = operation.apply({
      store: this.store,
      registries: this.runner.registries,
      runtime: this.runner,
      task,
      attempt,
      by: { type: 'policy', revision: policy.revision, reason: `${operation.label}: approved automatically.` },
    });
    if (applied) this.queue([this.store.task(task.id)]);
  }

  // A downstream review rejected an accepted result: redo the approved source task once.
  retryUpstream(task, { taskId, reason }, policy) {
    const source = this.store.task(taskId);
    // A later stage of the same task sent its work back: the stage hook rewinds it.
    const stages = this.runner.registries.workflows.stagesOf(source);
    if (source.id === task.id && stages?.retry) {
      if ((source.autoRetries || 0) >= policy.retries)
        return this.attention(source, `Retry limit reached for ${source.id}. ${reason}`);
      if (stages.retry(source)) return this.retry(source, `Independent review requested changes. ${reason}`, policy);
    }
    if (policy.retries < 1 || source.retryOf)
      return this.attention(task, `Retry limit reached for ${source.id}. ${reason}`);
    const now = new Date().toISOString(),
      clone = structuredClone(source);
    for (const field of ['acceptedAttemptId', 'proposedTaskIds', 'sprintId', 'autonomyNote', 'autoRetries'])
      delete clone[field];
    this.runner.registries.workflows.stagesOf(clone)?.clear?.(clone);
    Object.assign(clone, {
      id: 'T-' + randomUUID().slice(0, 8),
      retryOf: source.id,
      status: 'ready',
      reason: '',
      queued: false,
      lastAttemptId: null,
      createdAt: now,
      direction: bounded(
        `Automatic retry of ${source.id}: an independent review (${task.id}) requested changes. Address these findings:\n${reason}`,
      ),
      approval: {
        status: 'approved',
        decidedAt: now,
        by: { type: 'policy', revision: policy.revision, reason: `Automatic retry of approved work ${source.id}.` },
      },
    });
    // The retry joins its source's run as the next revision.
    this.store.tx(() => {
      expandRun(this.store, runIdOf(source), {
        reason: `Automatic retry of ${source.id} after review ${task.id}.`,
        source: task.id,
        tasks: [clone],
      });
      this.store.putTask(clone);
    });
    this.store.event(
      'autonomy_retry',
      clone.id,
      null,
      `Automatic retry of ${source.id} after review ${task.id}.`,
      recordProject(task),
    );
    this.queue([clone]);
  }

  // The director, or the policy (integrateAccepted), approves integration. A self-hosted controller
  // replaces its own modules, so it pauses dispatch, integrates once nothing is running and
  // restarts. Otherwise the integration waits only for its own resources and other work continues.
  // options.override ({ reason }) is the director's decision to integrate over a review (MP-019);
  // autonomy itself never passes one. options.by records who approved: the director unless the
  // policy says otherwise.
  requestIntegration(task, attemptId, reviewHash, options = {}) {
    if (!this.integrate) throw new Error('This controller has no integration operation.');
    const by = options.by || { type: 'director' };
    if (by.type === 'policy' && options.override) throw new Error('Only the director integrates over a review.');
    try {
      task = this.runner.integration.target(this.store, task, attemptId, reviewHash, options);
      if (!this.policy(task).enabled)
        return this.integrate(this.runner, task, attemptId, reviewHash, undefined, { ...options, by });
    } catch (error) {
      this.runner.integration.failed(this.runner, task, error.message);
      throw error;
    }
    if (this.store.setting(INTEGRATION)) throw new Error('An integration is already waiting.');
    // Only integrating the controller's own source replaces its running modules.
    const org = this.store.organization(),
      paused = !!this.runner.integration.pauses(task);
    this.store.putSetting(INTEGRATION, {
      taskId: task.id,
      attemptId,
      reviewHash,
      projectId: recordProject(task),
      requestedAt: new Date().toISOString(),
      paused,
      previousPaused: !!org.paused,
      by,
      ...(options.override ? { override: options.override } : {}),
    });
    if (paused) {
      org.paused = true;
      this.store.setOrganization(org);
    }
    const requested = this.store.task(task.id);
    requested.reason = '';
    delete requested.autonomyNote;
    this.store.putTask(requested);
    this.runner.integration.requested(this.runner, task);
    const approved =
      by.type === 'policy'
        ? `Autonomy policy revision ${by.revision} approved integration (${by.reason}).`
        : 'Director approved integration.';
    this.store.event(
      'integration_requested',
      task.id,
      attemptId,
      paused
        ? `${approved} New dispatch is paused; the controller integrates when running work finishes, then restarts.`
        : `${approved} The controller integrates as soon as the source is free; other work continues.`,
      recordProject(task),
    );
    return this.tryIntegration() || { state: 'waiting' };
  }
  pendingIntegration() {
    return this.store.setting(INTEGRATION);
  }
  tryIntegration() {
    const pending = this.store.setting(INTEGRATION);
    if (!pending || this.runner.closing) return null;
    // Requests recorded before integration by merge have no paused field; they paused.
    const busy =
      pending.paused === false
        ? this.store
            .leases()
            .some(lease => this.runner.integration.resources(this.store.task(pending.taskId)).includes(lease.resource))
        : this.runner.active.size || this.store.leases().length;
    if (busy) return { state: 'waiting' };
    this.store.putSetting(INTEGRATION, null);
    const task = this.store.task(pending.taskId);
    try {
      // Source integration formats and tests before writing, so it may settle later.
      const result = this.integrate(
        this.runner,
        task,
        pending.attemptId,
        pending.reviewHash,
        settled => this.integrationSettled(task, pending, settled),
        // Requests recorded before the policy could integrate were the director's.
        { ...(pending.override ? { override: pending.override } : {}), by: pending.by || { type: 'director' } },
      );
      if (result?.state !== 'verifying') this.integrationSettled(task, pending, result);
      return result;
    } catch (error) {
      this.runner.integration.failed(this.runner, task, error.message);
      this.attention(task, `Integration did not complete${stays(pending)}. ${error.message}`);
      return { state: 'failed', error: error.message };
    }
  }
  // A settled integration frees the source, so an integration requested meanwhile starts now: nothing else may
  // run to start it (October 24, when item 27's waited behind item 28's with no attempt left to settle).
  integrationSettled(task, pending, result) {
    if (this.runner.closing) return;
    if (result?.state !== 'integrated') {
      // A conflict with work integrated meanwhile, or tests that fail only merged onto it, is merged onto the current
      // source once, by the policy (1.1 step 3; October 27); a second one, or anything else, waits for the director.
      if (!this.mergeConflict(task, pending, result))
        this.attention(task, `Integration did not complete${stays(pending)}. ${result?.error || result?.state}`);
      this.tryIntegration();
      this.tryCarries();
      this.tryReleases();
      return;
    }
    const integrated = this.store.task(task.id);
    integrated.reason = '';
    delete integrated.autonomyNote;
    this.store.putTask(integrated);
    if (pending.paused !== false) {
      const org = this.store.organization();
      org.paused = pending.previousPaused;
      this.store.setOrganization(org);
    }
    const plan = { resumeProjects: [pending.projectId], cycleProjects: [pending.projectId] };
    // Requests recorded before integration by merge paused, and so replaced the controller's modules.
    if (pending.paused !== false && this.runner.selfHosted) {
      this.requestRestart({ reason: `Load source integrated from ${task.id}.`, ...plan });
      return;
    }
    // A separate development copy changed; the running controller continues. Another project's
    // repository is not the controller's source, so there is nothing to promote.
    if (this.runner.integration.controllerSource?.(task) ?? true)
      this.store.event(
        'source_ready_to_promote',
        task.id,
        null,
        `Integrated from ${task.id} into the development copy. Promote it to load it into the running controller.`,
        pending.projectId,
      );
    this.resumePlan(plan, `Integrated from ${task.id}; the pipeline continues without a restart.`);
    this.tryIntegration();
    this.tryCarries();
    this.tryReleases();
    this.sendWaiting(pending.projectId);
  }

  // Carries waiting their turn (1.1 step 4): the policy approves a carry when it integrates after a passing review,
  // as it would the integration, and an approved carry runs once no integration or carry runs, none is waiting and
  // the project's source is free. One at a time, oldest story first. A fix the director brings back is approved with
  // the action, and a carry of a brought-back idea waits for the story before it on its line.
  tryCarries() {
    if (
      this.runner.closing ||
      !this.store.db.isOpen ||
      this.runner.sourceIntegrationRun ||
      this.store.setting(INTEGRATION)
    )
      return;
    for (const story of this.store.tasks()) {
      if (story.kind !== 'studio-development:change' || story.status !== 'done' || !story.sourceStage?.review) continue;
      let review;
      try {
        review = this.store.attempt(story.sourceStage.review.attemptId);
      } catch {
        continue;
      }
      const carry = nextCarry(review);
      if (carry?.state !== 'waiting' || carryWaits(this.store, carry)) continue;
      if (!carry.approvedBy) {
        const policy = this.policy(story);
        if (!policy.enabled || kindMode(policy, story.kind).integrate !== 'auto') continue;
        approveCarry(this.store, story, carry.line, {
          type: 'policy',
          revision: policy.revision,
          reason: 'Carried as integration is: after a passing review.',
        });
      }
      try {
        runCarry(this.runner, story, result => this.carrySettled(story, result));
        return;
      } catch (error) {
        if (error.busy) return;
        this.attention(story, `The carry to ${carry.line} could not start: ${error.message}`);
      }
    }
  }
  carrySettled(story, result) {
    if (this.runner.closing) return;
    if (result?.state === 'merging') this.queue([this.store.task(result.storyId)]);
    else if (['rejected', 'needs-reconciliation'].includes(result?.state))
      this.attention(story, `Carrying the fix to ${result.line} did not complete. ${result.error}`);
    this.tryIntegration();
    this.tryCarries();
    this.tryReleases();
  }

  // Releases whose notes the director accepted (1.1 step 5) run once no integration, carry or release runs or waits
  // and their project's source is free, one at a time.
  tryReleases() {
    if (
      this.runner.closing ||
      !this.store.db.isOpen ||
      this.runner.sourceIntegrationRun ||
      this.store.setting(INTEGRATION)
    )
      return;
    for (const project of this.store.projects())
      for (const milestone of projectMilestones(this.store, project.id)) {
        if (milestone.state !== 'open' || milestone.release?.state !== 'ready') continue;
        try {
          runRelease(this.runner, project.id, milestone.id, result =>
            this.releaseSettled(project.id, milestone, result),
          );
          return;
        } catch (error) {
          if (error.busy) return;
          this.attention(
            this.store.task(milestone.release.notesTaskId),
            `The release could not start: ${error.message}`,
          );
        }
      }
  }
  releaseSettled(projectId, milestone, result) {
    if (this.runner.closing) return;
    if (['rejected', 'needs-reconciliation'].includes(result?.state))
      this.attention(
        this.store.task(milestone.release.notesTaskId),
        `The release of ${milestone.version} did not complete. ${result.error}`,
      );
    this.tryIntegration();
    this.tryCarries();
    this.tryReleases();
  }

  // A story whose integration stopped on a conflict, or failed its tests merged onto work that landed since it was
  // tested (October 27), goes back to its editor with its change merged onto the current source, once per story (the
  // director, October 25), when the project's policy is on. Returns whether it did.
  mergeConflict(task, pending, result) {
    const story = this.store.task(task.id),
      policy = this.policy(story),
      conflicted = !!result?.verification?.conflicts?.length;
    if (!policy.enabled || !(conflicted || result?.verification?.landedSince) || (story.sourceStage?.merges || 0) >= 1)
      return false;
    try {
      mergeSourceStory(this.store, this.runner.registries, story, { type: 'policy', revision: policy.revision });
    } catch (error) {
      this.attention(
        story,
        `Integration stopped ${conflicted ? 'on a conflict' : 'on tests that fail with work that landed since'}, and the change could not be merged onto the current source: ${error.message}`,
      );
      return true;
    }
    // A pause the integration took stays, as it does when an integration stops; the merge then waits for the resume.
    this.queue([this.store.task(story.id)]);
    return true;
  }

  requestRestart(marker) {
    this.store.putSetting(RESTART, { ...marker, requestedAt: new Date().toISOString() });
    if (this.restart) {
      this.store.event('restart_planned', null, null, `Controller restarting: ${marker.reason}`);
      setImmediate(() => this.restart());
    } else
      this.store.event(
        'restart_required',
        null,
        null,
        `Restart the controller to continue: ${marker.reason} (it was not launched through the supervisor).`,
      );
  }
  restartRequired() {
    return this.store.setting(RESTART);
  }

  // A planned restart resumes the projects it paused and may start the next cycle.
  // A manual restart after "restart required" completes the same plan.
  // Any interrupted attempt means the restart was not clean, so nothing resumes.
  resumeAfterPlannedRestart() {
    const marker = this.store.setting(RESTART);
    if (!marker) return;
    this.store.putSetting(RESTART, null);
    const fresh = Date.now() - Date.parse(marker.requestedAt) < RESTART_WINDOW_MS,
      clean = !this.store.allAttempts().some(a => a.status === 'interrupted' && !a.reconciledAt);
    if (!fresh || !clean) {
      this.store.event('restart_planned', null, null, 'Planned restart found stale or interrupted work; not resuming.');
      return;
    }
    this.resumePlan(marker, `Planned restart complete: ${marker.reason}`);
  }
  // Only the pause the controller made for itself at restart is lifted. A pause the director chose,
  // or one recorded before restart pauses were marked, holds until they resume the project.
  resumePlan(plan, message) {
    for (const projectId of plan.resumeProjects || []) {
      const project = this.store.project(projectId);
      if (!project.restartPaused) continue;
      project.dispatchPaused = false;
      delete project.restartPaused;
      this.store.putProject(project);
    }
    const org = this.store.organization();
    org.pipelineEnabled = this.store.tasks().some(task => task.queued);
    this.store.setOrganization(org);
    this.store.event('restart_planned', null, null, message);
    // Unless the controller closed first, as a test's teardown can in between (seen on a Mac).
    setImmediate(() => {
      if (this.runner.closing || !this.store.db.isOpen) return;
      for (const projectId of plan.cycleProjects || []) this.startCycle(projectId);
      this.runner.schedule();
    });
  }

  startCycle(projectId) {
    const policy = autonomyPolicy(this.store, projectId),
      cycle = policy.cycle;
    if (!policy.enabled || !cycle.enabled || !cycle.workflowId) return null;
    if (cycleRunsToday(this.store, projectId) >= cycle.maxPerDay) {
      this.store.event(
        'autonomy_attention',
        null,
        null,
        `Daily cycle cap (${cycle.maxPerDay}) reached; start the next run manually or raise the cap.`,
        projectId,
      );
      return null;
    }
    const workflow = this.store.workflow(cycle.workflowId),
      { runId, tasks, run } = materializeWorkflow(this.store, this.runner.registries, workflow);
    // In a project the director paused, the run is queued and counted but waits for their resume.
    const paused = !!this.store.project(projectId).dispatchPaused;
    this.store.tx(() => {
      tasks.forEach(task => this.store.putTask({ ...task, queued: true }));
      this.store.putRun(run);
      recordCycleRun(this.store, projectId);
      if (!paused) this.runner.enablePipeline(projectId);
    });
    if (paused) this.runner.refreshReadiness();
    this.store.event(
      'workflow_started',
      tasks[0].id,
      null,
      `Autonomy policy revision ${policy.revision} started the next cycle: ${workflow.name}.`,
      projectId,
    );
    this.runner.schedule();
    return runId;
  }

  // Sends a milestone's next waiting idea when the project's policy says so and its line is free (1.1 step 2a): one
  // idea per line, in the order of the milestones' versions and then the order the ideas were written. A line is free
  // when nothing on it is open: every task of every idea on it accepted, denied, cancelled or closed, and every story
  // integrated or closed. An idea that cannot be sent goes back and waits for the director.
  sendWaiting(projectId) {
    if (this.runner.closing || !projectId) return;
    const policy = autonomyPolicy(this.store, projectId);
    if (!policy.enabled || !policy.sendWaiting) return;
    const lines = new Set(),
      milestones = projectMilestones(this.store, projectId)
        .filter(milestone => milestone.state === 'open' && milestone.waiting.length)
        .sort((a, b) => compareVersions(parseVersion(a.version), parseVersion(b.version)));
    for (const milestone of milestones) {
      const line = projectLine(this.store, projectId, milestone.line ?? undefined);
      if (lines.has(line) || this.lineBusy(projectId, line)) continue;
      lines.add(line);
      try {
        sendWaitingIdea(
          this.store,
          this.runner.registries,
          this.runner,
          projectId,
          milestone.id,
          milestone.waiting[0].id,
          {
            type: 'policy',
            revision: policy.revision,
          },
        );
      } catch (error) {
        this.store.event(
          'autonomy_attention',
          null,
          null,
          `Waiting for the director: the next idea waiting in milestone ${milestone.version} could not be sent. ${error.message}`,
          projectId,
        );
      }
    }
  }
  lineBusy(projectId, line) {
    return this.store.tasks().some(task => {
      if (recordProject(task) !== projectId) return false;
      const on = projectLine(this.store, projectId, task.release?.line ?? this.store.run(runIdOf(task))?.line);
      if (on !== line) return false;
      if (task.kind === 'studio-development:change' && task.status === 'done')
        return !['integrated', 'closed'].includes(task.sourceStage?.current) && !sourceStoryIntegrated(task);
      return !['done', 'denied', 'cancelled'].includes(task.status);
    });
  }
}

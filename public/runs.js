// Run stories: a plain-language, read-only account of each workflow run, built only from the
// task and attempt records the dashboard already receives. Loaded before app.js.
(() => {
  const time = value => (value ? Date.parse(value) || 0 : 0);
  const firstLine = text => String(text || '').split('\n')[0];
  const sentence = text => firstLine(text).replace(/\.+$/, '');
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // A reset time on the local clock ("10:25 PM"), with its date when not today, worded as the controller's events.
  const resetClock = value => {
    const at = new Date(value),
      hour = at.getHours(),
      clock = `${hour % 12 || 12}:${String(at.getMinutes()).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
    return at.toDateString() === new Date().toDateString()
      ? clock
      : `${clock} on ${monthNames[at.getMonth()]} ${at.getDate()}`;
  };
  // The CLI an execution view runs on: its task's execution setting, else its employee's. Holds are keyed by it.
  const executionProvider = (view, state) =>
    view.execution?.provider || (state.workers || []).find(w => w.id === view.workerId)?.provider;
  // A CLI's recorded subscription hold (state.quota) and the reset time its usage-limit message named
  // (state.quotaResets), when one was readable.
  function usageHold(state, provider) {
    if (!provider || !state.quota?.[provider]) return null;
    const adapter = state.adapters?.[provider],
      reset = state.quotaResets?.[provider];
    return {
      provider,
      label: adapter?.quotaLabel || adapter?.name || provider,
      resetAt: Number.isFinite(Date.parse(reset)) ? reset : null,
    };
  }
  // Steps that share a timestamp read in this order.
  const order = { start: 0, finish: 1, revise: 2, accept: 3, retry: 4, propose: 5, approve: 6, deny: 7, integrate: 8 };
  // Work is proposed when its source task finishes, but it runs on the source's accepted result,
  // so it can be approved only after that acceptance. Returns the source it is waiting for
  // while that source can still be accepted.
  const awaitedSource = (task, find) => {
    const reference = task.approval?.status === 'pending' && task.proposalReference,
      source = reference && find(reference.taskId);
    return source && !['done', 'failed', 'cancelled', 'denied'].includes(source.status) ? source : null;
  };

  // source-story-stages-v1 is additive task metadata. Attempts remain separate,
  // immutable records under the same task ID, with the execution kind in assignment.
  const sourceStage = task =>
    task.kind === 'studio-development:change' && task.sourceStage?.version === 'source-story-stages-v1'
      ? task.sourceStage
      : null;
  const phaseLabel = phase =>
    ({ implementing: 'Implementing', 'candidate-review': 'Candidate review', integration: 'Integration' })[phase] ||
    phase;
  function sourceProgress(task, attempts, pending) {
    const stage = sourceStage(task);
    if (!stage || ['backlog', 'denied'].includes(task.status)) return null;
    const review = attempts.find(item => item.id === stage.review?.attemptId && item.taskId === task.id),
      journal = review?.sourceIntegration,
      integrationState = journal?.state || stage.integration?.state,
      approved = pending?.taskId === task.id,
      busy = approved || ['verifying', 'preparing', 'prepared', 'applying', 'committing'].includes(integrationState);
    const label = busy
      ? approved
        ? 'Integration approved'
        : 'Integrating'
      : stage.current === 'integrated'
        ? 'Integrated'
        : ['failed', 'blocked'].includes(stage.current)
          ? `${phaseLabel(stage.phase)} · ${stage.current}`
          : stage.current === 'waiting-for-integration'
            ? 'Waiting for integration'
            : phaseLabel(stage.phase);
    return {
      stage,
      review,
      journal,
      busy,
      label,
      reason: stage.reason || journal?.error || task.reason || '',
      status:
        stage.current === 'integrated'
          ? 'done'
          : busy
            ? 'running'
            : stage.current === 'failed'
              ? 'failed'
              : stage.current === 'blocked'
                ? 'blocked'
                : task.status === 'review'
                  ? 'review'
                  : 'running',
    };
  }
  // Presentation eligibility mirrors the serialized controller references. The
  // protected endpoint still validates bytes, baseline, reservations and dispatch.
  function integrationReview(task, attempts, pending, tasks = []) {
    const stage = sourceStage(task);
    // Legacy reviews are separate tasks. Resolve their current accepted candidate,
    // then use the same identity/check predicates as a staged source story.
    if (!stage) {
      if (task.kind !== 'studio-development:change-review' || task.closed || pending || task.status !== 'done')
        return null;
      const review = attempts.find(a => a.taskId === task.id && a.id === task.acceptedAttemptId),
        source = review?.candidateReview,
        owner = tasks.find(t => t.id === source?.taskId),
        candidate = attempts.find(a => a.id === source?.attemptId && a.taskId === owner?.id),
        item = review?.artifacts?.find(a => a.kind === 'source-change-review');
      if (
        !review ||
        !candidate ||
        !owner ||
        !source ||
        !item ||
        owner.closed ||
        review.workerId !== task.workerId ||
        candidate.workerId !== owner.workerId ||
        owner.kind !== 'studio-development:change' ||
        owner.status !== 'done' ||
        owner.acceptedAttemptId !== candidate.id ||
        owner.lastAttemptId !== candidate.id ||
        task.lastAttemptId !== review.id ||
        task.dependencies?.length !== 1 ||
        task.dependencies[0] !== owner.id
      )
        return null;
      const projected = {
        ...task,
        kind: 'studio-development:change',
        sourceStage: {
          version: 'source-story-stages-v1',
          phase: 'candidate-review',
          current: 'waiting-for-integration',
          review: {
            taskId: task.id,
            attemptId: review.id,
            workerId: review.workerId,
            path: item.path,
            hash: item.hash,
            verdict: review.candidateReviewVerdict,
          },
          candidate: { ...source, workerId: candidate.workerId },
        },
      };
      // The two task IDs differ only in the legacy layout. Preserve the recorded
      // input identity; never edit the records to make them look like a story.
      const candidateView = { ...candidate, taskId: task.id },
        reviewView = {
          ...review,
          candidateReview: { ...source, taskId: task.id },
          inputReferences: (review.inputReferences || []).map(input =>
            input.taskId === owner.id ? { ...input, taskId: task.id } : input,
          ),
        };
      projected.sourceStage.candidate.taskId = task.id;
      return integrationReview(projected, [candidateView, reviewView], pending) ? review : null;
    }
    if (task.closed) return null;
    const progress = sourceProgress(task, attempts, pending),
      ref = stage.review,
      pin = stage.candidate;
    if (
      task.status !== 'done' ||
      !ref ||
      !pin ||
      ref.verdict !== 'pass' ||
      task.acceptedAttemptId !== ref.attemptId ||
      task.lastAttemptId !== ref.attemptId ||
      !['waiting-for-integration', 'failed', 'blocked'].includes(stage.current) ||
      !['candidate-review', 'integration'].includes(stage.phase) ||
      progress.busy ||
      pending ||
      (progress.journal && !['rejected', 'abandoned'].includes(progress.journal.state)) ||
      (stage.integration && !['rejected', 'abandoned'].includes(stage.integration.state))
    )
      return null;
    const review = progress.review,
      candidate = attempts.find(item => item.id === pin.attemptId),
      item = review?.artifacts?.find(
        item => item.path === ref.path && item.hash === ref.hash && item.kind === 'source-change-review',
      ),
      manifest = candidate?.artifacts?.find(
        item => item.path === pin.path && item.hash === pin.hash && item.kind === 'source-change',
      ),
      source = review?.candidateReview;
    if (
      !review ||
      !candidate ||
      !item ||
      !manifest ||
      ref.taskId !== task.id ||
      pin.taskId !== task.id ||
      candidate.taskId !== task.id ||
      review.status !== 'accepted' ||
      candidate.status !== 'accepted' ||
      review.assignment?.kind !== 'studio-development:change-review' ||
      candidate.assignment?.kind !== 'studio-development:change' ||
      review.result?.outcome !== 'completed' ||
      candidate.result?.outcome !== 'completed' ||
      review.candidateReviewVerdict !== 'pass' ||
      !source?.passed ||
      review.workerId !== ref.workerId ||
      candidate.workerId !== pin.workerId ||
      review.workerId === candidate.workerId ||
      source.taskId !== task.id ||
      source.attemptId !== pin.attemptId ||
      source.path !== pin.path ||
      source.hash !== pin.hash ||
      source.candidateHash !== pin.candidateHash ||
      candidate.sourceCandidate?.sourceHash !== pin.candidateHash ||
      [review, candidate].some(a =>
        [...(a.result?.checks || []), ...(a.controllerChecks || [])].some(c => c.status === 'fail'),
      ) ||
      !review.inputReferences?.some(
        input =>
          input.taskId === task.id &&
          input.attemptId === pin.attemptId &&
          // Recorded inputs are job-relative copies, so match the manifest by kind and hash.
          input.artifacts?.some(item => item.kind === 'source-change' && item.hash === pin.hash),
      )
    )
      return null;
    return review;
  }

  // A run is every task its workflow created, plus work later proposed from those tasks
  // or retried from them, followed transitively.
  function runMembership(tasks) {
    const runOf = new Map();
    for (const task of tasks) {
      const runId = task.workflowReference?.runId || task.runReference?.runId;
      if (runId) runOf.set(task.id, runId);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of tasks) {
        if (runOf.has(task.id)) continue;
        const parent = runOf.get(task.retryOf) || runOf.get(task.proposalReference?.taskId);
        if (parent) {
          runOf.set(task.id, parent);
          changed = true;
        }
      }
    }
    return runOf;
  }

  function actorName(by) {
    if (by?.type === 'policy') return 'Autonomy';
    if (by?.type === 'controller') return 'The controller';
    return 'You';
  }

  // The delivery mode (workspace or text) an attempt recorded when it started. Older records,
  // and attempts that recorded a blank default, name none; current settings are never consulted.
  // Steps the controller or the Simulator runs start no model CLI (the controller lists them),
  // so they have no delivery mode, although their recorded configuration copies the employee's.
  function deliveryMode(attempt, modelFree) {
    if (modelFree.has(attempt.provider)) return '';
    return attempt.configuration?.mode || 'mode not recorded';
  }

  function attemptOutcome(attempt) {
    const checks = [...(attempt.result?.checks || []), ...(attempt.controllerChecks || [])],
      failedChecks = [...new Set(checks.filter(check => check.status === 'fail').map(check => check.name))],
      tests = (attempt.failedTests || []).map(test => `${test.file ? test.file + ': ' : ''}${test.name}`),
      verdict = attempt.candidateReviewVerdict || attempt.reviewVerdict,
      summary = attempt.result?.summary || '';
    if (attempt.status === 'cancelled') return { tone: 'muted', text: 'was cancelled.', detail: summary };
    if (['failed', 'blocked', 'quarantined', 'interrupted'].includes(attempt.status))
      return { tone: 'bad', text: `stopped: ${sentence(attempt.error || summary) || attempt.status}.`, tests };
    if (verdict === 'needs-work') return { tone: 'bad', text: 'reviewed it: needs work.', detail: summary, tests };
    if (verdict === 'pass') return { tone: 'ok', text: 'reviewed it: pass.', detail: summary, tests };
    if (failedChecks.length)
      return { tone: 'bad', text: `finished, but checks failed (${failedChecks.join(', ')}).`, detail: summary, tests };
    return { tone: 'ok', text: 'finished.', detail: summary, tests };
  }

  function steps(tasks, attempts, workers, kinds, modelFree) {
    const items = [],
      byId = new Map(tasks.map(task => [task.id, task])),
      who = task => workers.get(task.workerId)?.displayName || task.workerId,
      label = task => `${(kinds[task.kind]?.cardLabel || kinds[task.kind]?.label || 'task').toLowerCase()} ${task.id}`;
    const add = (at, kind, tone, text, extra = {}) =>
      (at || extra.execution) &&
      items.push({ at: at || null, kind, tone, text: text[0].toUpperCase() + text.slice(1), ...extra });
    for (const task of tasks) {
      // A stage template (G3d) sending its task back to an earlier stage.
      const stageLabels = new Map((kinds[task.kind]?.stageTemplate || []).map(stage => [stage.key, stage.label]));
      for (const entry of task.stageState?.history || [])
        if (entry.outcome === 'sent-back')
          add(
            entry.at,
            'revise',
            'warn',
            `The ${stageLabels.get(entry.key) || entry.key} stage sent ${label(task)} back.`,
            {
              taskId: task.id,
              attemptId: entry.attemptId,
            },
          );
      if (task.retryOf)
        add(task.createdAt, 'retry', 'warn', `Autonomy retried ${task.retryOf} as a new ${label(task)}.`, {
          taskId: task.id,
          detail: task.title,
        });
      else if (task.proposalReference) {
        const source = byId.get(task.proposalReference.taskId),
          producing = attempts.find(attempt => attempt.id === task.proposalReference.attemptId);
        add(
          producing?.finishedAt || task.createdAt,
          'propose',
          'info',
          `${source ? who(source) : 'A previous step'} proposed a ${label(task)} for ${who(task)}.`,
          { taskId: task.id, detail: task.title },
        );
      }
      const approval = task.approval;
      if (approval?.decidedAt && approval.status === 'approved')
        add(approval.decidedAt, 'approve', 'ok', `${actorName(approval.by)} approved ${label(task)}.`, {
          taskId: task.id,
        });
      if (approval?.decidedAt && approval.status === 'denied')
        add(
          approval.decidedAt,
          'deny',
          'muted',
          approval.by?.type === 'controller'
            ? `${label(task)} was retired: a newer attempt replaced the work it was for.`
            : `You ${approval.workflowStep ? 'closed' : 'denied'} ${label(task)}.`,
          { taskId: task.id, detail: approval.reason },
        );
      if (task.closed)
        add(task.closed.at, 'deny', 'muted', `You closed ${label(task)} without taking it further.`, {
          taskId: task.id,
          detail: task.closed.reason,
        });
    }
    for (const attempt of attempts) {
      const task = byId.get(attempt.taskId);
      if (!task) continue;
      const execution = {
          ...task,
          kind: attempt.assignment?.kind || task.kind,
          workerId: attempt.workerId || task.workerId,
        },
        stage = sourceStage(task),
        stageName = execution.kind === 'studio-development:change-review' ? 'candidate review' : 'implementation';
      const number = attempts.filter(item => item.taskId === task.id).indexOf(attempt) + 1,
        executionDetail = {
          attemptId: attempt.id,
          label: `${stage ? stageName : kinds[execution.kind]?.cardLabel || kinds[execution.kind]?.label || 'Execution'} · attempt ${number}`,
        },
        mode = deliveryMode(attempt, modelFree),
        tagged = text => (mode ? `${text} [${mode}]` : text);
      if (
        stage &&
        execution.kind === 'studio-development:change' &&
        attempts.some(
          previous =>
            previous.taskId === task.id &&
            previous.candidateReviewVerdict === 'needs-work' &&
            time(previous.finishedAt) <= time(attempt.startedAt),
        )
      )
        add(
          attempt.startedAt,
          'retry',
          'warn',
          `Implementation retried on source story ${task.id} after independent review requested changes.`,
          { taskId: task.id, attemptId: attempt.id },
        );
      add(
        attempt.startedAt,
        'start',
        'info',
        tagged(
          `${who(execution)} started ${stage ? `${stageName} for source story ${task.id}` : label(execution)}${number > 1 ? ` (attempt ${number})` : ''}.`,
        ),
        {
          taskId: task.id,
          attemptId: attempt.id,
          ...(['running', 'stopping'].includes(attempt.status) ? { execution: executionDetail } : {}),
        },
      );
      if (['running', 'stopping'].includes(attempt.status)) continue;
      const outcome = attemptOutcome(attempt);
      add(
        attempt.finishedAt || attempt.startedAt,
        'finish',
        outcome.tone,
        tagged(`${who(execution)} ${outcome.text}`),
        {
          taskId: task.id,
          attemptId: attempt.id,
          execution: executionDetail,
          detail: outcome.detail,
          tests: outcome.tests,
        },
      );
      if (attempt.revisionRequestedBy)
        add(
          attempt.revisionRequestedBy.at,
          'revise',
          'warn',
          `${actorName(attempt.revisionRequestedBy)} sent ${stage ? `${stageName} for source story ${task.id}` : label(execution)} back for another attempt.`,
          { taskId: task.id, detail: firstLine(attempt.revisionRequestedBy.reason) },
        );
      else if (attempt.status === 'revision_requested')
        add(attempt.finishedAt, 'revise', 'warn', `${label(task)} was sent back for another attempt.`, {
          taskId: task.id,
        });
      if (attempt.acceptedAt)
        add(
          attempt.acceptedAt,
          'accept',
          'ok',
          `${actorName(attempt.acceptedBy)} accepted the result of ${stage ? `${stageName} for source story ${task.id}` : label(task)}.`,
          { taskId: task.id, detail: attempt.acceptedBy?.reason },
        );
      const journal = attempt.sourceIntegration;
      if (journal) {
        add(
          journal.startedAt,
          'integrate',
          'info',
          journal.method === 'merge'
            ? 'Integration started: merging the change onto the current source, then formatting and testing it.'
            : 'Integration started: formatting and testing the change on a copy.',
          {
            taskId: task.id,
            attemptId: attempt.id,
          },
        );
        if (journal.state === 'integrated')
          add(
            journal.finishedAt,
            'integrate',
            'ok',
            `Integrated${journal.repository?.commit ? ` as commit ${journal.repository.commit.slice(0, 7)}` : ''}.`,
            { taskId: task.id, attemptId: attempt.id },
          );
        else if (['rejected', 'abandoned', 'needs-reconciliation', 'restored'].includes(journal.state))
          add(
            journal.finishedAt || journal.startedAt,
            'integrate',
            'bad',
            `Integration ${journal.state.replace('-', ' ')}.`,
            {
              taskId: task.id,
              attemptId: attempt.id,
              detail: journal.error,
            },
          );
      }
    }
    return items.sort((a, b) => time(a.at) - time(b.at) || order[a.kind] - order[b.kind]);
  }

  // Select evidence for the execution view, not a historical stage or the attempt
  // a user happens to be inspecting. Missing current evidence stays missing.
  function taskExecution(task, state) {
    const stage = sourceStage(task),
      template = state.taskKinds?.[task.kind]?.stageTemplate || [],
      step = template.find(s => s.key === task.stageState?.current),
      later = step && step.key !== template[0]?.key,
      review = stage && ['candidate-review', 'integration'].includes(stage.phase),
      view = review
        ? {
            ...task,
            ...stage.reviewTask,
            kind: 'studio-development:change-review',
            dependencies: [task.id],
            execution: {},
            resources: stage.reviewTask?.resources || [],
          }
        : later
          ? {
              ...task,
              ...step,
              ...task.stageState.staffed?.[step.key],
              dependencies: [task.id],
              execution: {},
              resources: [],
            }
          : task,
      attempts = (state.attempts || [])
        .filter(a => a.taskId === task.id)
        .slice()
        .sort((a, b) => time(a.startedAt) - time(b.startedAt)),
      current = attempts.filter(
        a =>
          (a.assignment?.kind || task.kind) === view.kind &&
          (!review || a.candidateReview?.attemptId === stage.candidate?.attemptId) &&
          (!task.stageState || step || a.assignment?.stageState?.current === task.stageState.current) &&
          (!later || !task.stageState.enteredAt || a.startedAt >= task.stageState.enteredAt),
      ),
      latest = task.lastAttemptId ? current.find(a => a.id === task.lastAttemptId) : current.at(-1);
    return {
      view,
      attempts,
      current,
      latest:
        latest?.reconciledAt && ['interrupted', 'quarantined', 'uncertain'].includes(latest.status) ? null : latest,
    };
  }

  function timeoutReason(attempt, reason = '') {
    if (
      !attempt?.stopContext?.timedOut &&
      attempt?.stopContext?.reason !== 'time-limit' &&
      !/time limit|timed out|timeout/i.test(attempt?.error || reason)
    )
      return '';
    const activity = attempt?.stopContext?.activity,
      names = {
        test: 'running tests',
        'source.edit': 'editing the approved files',
        'candidate.commit': 'recording the candidate commit',
        install: 'installing the packages',
        'candidate.tests': 'running candidate tests',
        'source.tests': 'running source checks',
        'source.snapshot': 'copying the source snapshot',
        'result.validation': 'validating the result',
      };
    return activity && activity !== 'unknown' && activity !== 'attempt'
      ? `The time limit was reached while ${names[activity] || activity}.`
      : 'The time limit was reached. The activity at that moment was not recorded.';
  }

  function explanationDetails(attempt, journal) {
    const checks = [
        ...(attempt?.result?.checks || []),
        ...(attempt?.controllerChecks || []),
        ...(journal?.verification?.checks || []),
      ],
      tests = [
        ...(attempt?.failedTests || []),
        ...(attempt?.testEvidence?.failedTests || []),
        ...(attempt?.stopContext?.testEvidence?.failedTests || []),
        ...(journal?.verification?.failedTests || []),
      ],
      findings = attempt?.candidateReviewFindings || attempt?.reviewFindings || [],
      findingText = item =>
        typeof item === 'string'
          ? item
          : [item.severity, item.summary || item.message, item.path || item.file].filter(Boolean).join(': ');
    return [
      ...new Set(
        [
          ...checks.filter(c => c.status === 'fail').map(c => `${c.name}${c.evidence ? ': ' + c.evidence : ''}`),
          ...tests.map(t => `${t.file ? t.file + ': ' : ''}${t.name}`),
          ...findings.map(findingText),
          timeoutReason(attempt),
          attempt?.error,
          ...(attempt?.result?.issues || []),
          journal?.error,
          journal?.verification?.error,
        ].filter(Boolean),
      ),
    ];
  }

  // One read-only account of the current stop/wait. Text is deliberately unescaped:
  // callers render it as text. This helper grants no eligibility or controller action.
  function taskExplanation(task, state = {}) {
    const { view, attempts, current, latest: attempt } = taskExecution(task, state),
      stage = sourceStage(task),
      all = state.attempts || [],
      pending = state.autonomy?.pendingIntegration,
      policy = state.autonomy?.policy || {},
      mode = policy.enabled ? policy.kinds?.[view.kind] || {} : {},
      review = stage
        ? ['candidate-review', 'integration'].includes(stage.phase) &&
          attempts.find(
            a => a.id === stage.review?.attemptId && a.candidateReview?.attemptId === stage.candidate?.attemptId,
          )
        : attempt,
      currentReview = review && review.id === task.acceptedAttemptId && review.id === task.lastAttemptId,
      journal = currentReview ? review.sourceIntegration : null,
      stageJournal =
        stage?.integration && review && stage.integration.attemptId === review.id ? stage.integration : null,
      integrationState = journal?.state || stageJournal?.state,
      details = explanationDetails(attempt, journal),
      result = (kind, reason, next, action = null, extra = []) => ({
        kind,
        reason,
        details: [...new Set([...details, ...extra].filter(Boolean))],
        next,
        action,
        requiresDirector: !!action,
        attemptId: attempt?.id || null,
      }),
      passive = (kind, reason, next, extra) => result(kind, reason, `Nothing is needed from you. ${next}`, null, extra),
      reason = stage?.reason || task.reason || '',
      failed = [...(attempt?.result?.checks || []), ...(attempt?.controllerChecks || [])].filter(
        c => c.status === 'fail',
      ),
      verdict = attempt?.candidateReviewVerdict || attempt?.reviewVerdict,
      limit = view.maxAttempts,
      // Later template stages may override limits without exposing them in compact
      // state. Only use a measured assignment limit or an explicit controller note.
      knownLimit = task.stageState && view.kind !== task.kind ? attempt?.assignment?.maxAttempts : limit,
      fixed = view.kind === 'unreal-integration' || state.taskKinds?.[view.kind]?.fixedAttemptLimit === true,
      // As in the controller, an attempt a provider's usage limit stopped, or one the controller's stop interrupted
      // and the director reconciled, doesn't count, except under a fixed limit.
      exhausted =
        Number.isInteger(knownLimit) &&
        current.filter(a => fixed || (!a.subscriptionHold && !(a.status === 'interrupted' && a.reconciledAt))).length >=
          knownLimit,
      note =
        task.approval?.status === 'approved' &&
        /approve or deny proposed work|work approval is required/i.test(task.autonomyNote || '')
          ? ''
          : task.autonomyNote || '',
      limitNote = /attempt limit|\d+-attempt limit/i.test(reason || note),
      fixedLimit = fixed && (exhausted || limitNote),
      retryUsed = (view.kind === task.kind ? task.autoRetries : task.stageRetries?.[view.kind]) || 0;

    // Journals and unsettled processes are facts; stale attention is not a recovery
    // authority. An older interrupted stage still owns its reservations until reconciled.
    const unsettled = attempts.find(
      a => ['interrupted', 'quarantined', 'uncertain'].includes(a.status) && !a.reconciledAt,
    );
    if (unsettled)
      return {
        ...result(
          'interrupted',
          unsettled.status === 'quarantined'
            ? 'The process stop could not be confirmed; its reservations are retained.'
            : 'The controller stopped while this attempt was running, so how far it got is not known.',
          'Use Reconcile interrupted attempt. It checks that nothing of the attempt is still running, keeps what it saved for the next attempt and releases what it held; then start the work again.' +
            (fixed ? '' : ' An interrupted attempt does not use up one of the attempts allowed.'),
          'Reconcile interrupted attempt',
          [unsettled.error],
        ),
        attemptId: unsettled.id,
      };
    if (
      integrationState === 'needs-reconciliation' ||
      (integrationState &&
        ![
          'waiting',
          'verifying',
          'preparing',
          'prepared',
          'applying',
          'committing',
          'integrated',
          'rejected',
          'abandoned',
          'restored',
        ].includes(integrationState))
    )
      return result(
        'integration-uncertain',
        'Source integration stopped before its outcome was recorded.',
        'Use Reconcile source integration before another write. It checks the repository: a change that reached the branch is recorded as integrated, and one that did not is set aside so you can integrate it again.',
        'Reconcile source integration',
      );
    if (task.closed || task.status === 'denied')
      return {
        ...passive(
          task.closed ? 'closed' : 'denied',
          task.closed ? 'This assignment was closed.' : 'This work was denied.',
          'No further work is queued for this assignment.',
        ),
        details: [],
      };
    if (integrationState === 'integrated' || stage?.current === 'integrated')
      return {
        ...passive('integrated', 'The reviewed change was integrated.', 'This assignment is complete.'),
        details: [],
      };
    if (pending?.taskId === task.id && (!pending.attemptId || pending.attemptId === review?.id))
      return passive(
        'integration-pending',
        'Source integration has already been approved.',
        pending.paused !== false
          ? 'The controller waits for active work to finish, integrates, then restarts.'
          : 'The controller integrates when the source resources are free.',
      );
    if (['waiting', 'verifying', 'preparing', 'prepared', 'applying', 'committing'].includes(integrationState))
      return passive(
        'integration-running',
        'The controller is integrating the approved change.',
        'It will finish verification and record the integration outcome. If interrupted, reconcile the journal before another write.',
      );

    const integrable = integrationReview(task, all, pending, state.tasks || []);
    if (integrable) {
      const stopped = !!journal || !!stageJournal,
        refused =
          (stage?.phase === 'integration' && stage.current === 'failed') ||
          !!reason ||
          /could not request integration|approve it yourself/i.test(note),
        automatic =
          !!stage &&
          policy.enabled &&
          policy.kinds?.[task.kind]?.integrate === 'auto' &&
          !stopped &&
          !refused &&
          !integrable.candidateReviewFindings?.length,
        error = journal?.error || journal?.verification?.error || reason,
        phase = journal?.verification?.phaseId,
        approvalAction =
          !stage && !policy.enabled
            ? stopped || refused
              ? 'Integrate again'
              : 'Integrate reviewed source'
            : stopped || refused
              ? 'Approve integration again'
              : 'Approve integration';
      if (automatic)
        return passive(
          'integration-auto',
          'The current independent review passed.',
          'The controller requests integration automatically, waits for resources, then formats and verifies the change.',
        );
      let kind = 'integration-approval',
        why = 'The current independent review passed and awaits integration approval.',
        recovery = `Use ${approvalAction} to request controller-owned integration.`;
      if (stopped || refused) {
        kind = 'integration-stopped';
        why = 'The last integration did not complete.';
        recovery = `Inspect the recorded failure and resolve it before using ${approvalAction}.`;
        if (/conflict|could not be merged/i.test(error)) {
          kind = 'integration-conflict';
          why = 'The candidate conflicts with the current source.';
          recovery =
            'Request a fresh candidate on the current source and a new independent review before approving integration.';
        } else if (phase === 'integration.format' || /formatter/i.test(error)) {
          kind = 'integration-formatter';
          why = 'Integration stopped while formatting the reviewed files.';
          recovery = `Resolve the formatter failure or request a corrected candidate, then use ${approvalAction}.`;
        } else if (
          journal?.verification?.passed !== true &&
          (phase === 'integration.verification' || journal?.verification?.passed === false)
        ) {
          kind = 'integration-tests';
          why = 'The integrated candidate did not pass verification tests.';
          recovery = `Inspect the failing tests and request a corrected candidate when needed, then use ${approvalAction}.`;
        } else if (/branch|local edits|local changes|working tree|moved|tip|fast.forward/i.test(error)) {
          kind = 'integration-source-moved';
          why = 'The source branch or local edits changed before integration could finish.';
          recovery = `Inspect the branch and preserve local edits. Resolve the source mismatch before using ${approvalAction}.`;
        }
      }
      return result(kind, why, recovery, approvalAction, [error]);
    }
    if (task.status === 'done') {
      if (stage?.current === 'failed' && stage.review?.verdict === 'needs-work' && currentReview)
        return result(
          'review-findings',
          'The independent review requested changes.',
          'Use Send back to implementation; the next attempt receives the review findings. You may also close without integrating.',
          'Send back to implementation',
          explanationDetails(review),
        );
      if (stage && stage.current !== 'integrated')
        return result(
          'integration-ineligible',
          'The recorded evidence does not identify an eligible current passing candidate review.',
          'Inspect the candidate and review identities; obtain valid current evidence before approving integration.',
          'Inspect stage',
          [reason],
        );
      if (task.kind === 'studio-development:change-review') {
        // An accepted review from before stories had stages: its findings are recorded, and nothing waits
        // on the director, so new work from them is optional (v1.0 item 17).
        if (verdict === 'needs-work')
          return passive(
            'review-findings',
            'The independent review requested changes.',
            'If you still want this change, create newly scoped work from its findings.',
          );
        return result(
          'integration-ineligible',
          'The accepted review does not identify an eligible current passing candidate.',
          'Inspect the accepted candidate and review identities before requesting integration.',
          'Inspect stage',
        );
      }
      if (task.kind === 'review' && ['revise', 'blocked'].includes(verdict))
        return result(
          'review-findings',
          'The accepted review identified work that needs repairs.',
          task.repairPlanTaskId
            ? 'Use View repair plan to inspect the linked repair work.'
            : 'Use Plan repairs from findings to scope the next work from the accepted evidence.',
          task.repairPlanTaskId ? 'View repair plan' : 'Plan repairs from findings',
          [attempt?.result?.summary],
        );
      return {
        ...passive(
          'accepted',
          'The result was accepted.',
          'Dependent work can proceed when its other prerequisites and resources are ready.',
        ),
        details: [],
      };
    }
    if (task.status === 'stopping')
      return passive(
        'stopping',
        timeoutReason(attempt, reason)
          ? `${timeoutReason(attempt, reason)} The process has not yet confirmed it stopped.`
          : 'Cancellation was requested; the process has not yet confirmed it stopped.',
        'The controller waits for process termination before releasing reservations.',
      );
    if (task.status === 'running')
      return passive(
        'running',
        'This assignment is running.',
        'The controller records the result when the current attempt stops.',
      );

    const byId = new Map((state.tasks || []).map(t => [t.id, t])),
      upstream = awaitedSource(task, id => byId.get(id));
    if (upstream)
      return passive(
        'prerequisite-acceptance',
        `This proposed work needs the accepted result of ${upstream.id}.`,
        'Accept that prerequisite first. Work approval becomes available afterward.',
      );
    if (task.approval?.status === 'pending' && task.status === 'backlog') {
      if (task.approval.gate)
        return result(
          'gate-approval',
          'This workflow reached a director decision gate.',
          'Use Approve work to continue, or Deny work to stop this branch.',
          'Approve work',
          [task.approval.reason],
        );
      if (mode.approve === 'auto')
        return passive(
          'work-auto',
          'This proposed work is awaiting automatic approval.',
          'The controller approves and queues it when its accepted inputs are available.',
        );
      return result(
        'work-approval',
        'This proposed work needs approval before it can run.',
        'Use Approve work to queue the approved assignment, or Deny work to stop it.',
        'Approve work',
      );
    }

    // Acceptance does not start another attempt. In particular, a successful
    // fixed-limit attempt must remain available for acceptance after using its budget.
    const success =
      task.status === 'review' &&
      attempt?.status === 'review' &&
      attempt.result?.outcome === 'completed' &&
      !failed.length &&
      !['needs-work', 'revise', 'blocked'].includes(verdict);
    if (success) {
      if (mode.accept === 'auto')
        return passive(
          'result-auto',
          'The completed result is awaiting automatic acceptance.',
          'The controller accepts the validated result and makes its next stage or dependent work eligible.',
        );
      const action = task.kind === 'plan' ? 'Accept planning result' : 'Accept result';
      return result(
        'result-approval',
        'The completed result is ready for acceptance.',
        `Use ${action} to accept this result, or close without accepting.`,
        action,
      );
    }
    if (
      task.status === 'review' &&
      attempt?.status === 'review' &&
      attempt.result?.outcome === 'completed' &&
      view.kind === 'studio-development:change-review' &&
      verdict === 'needs-work'
    ) {
      if (mode.accept === 'auto')
        return passive(
          'review-auto',
          'The independent review requested changes.',
          'The controller records this review as evidence and applies its bounded send-back policy. It stops for your decision if the retry allowance is used.',
        );
      return result(
        'review-result',
        'The independent review requested changes.',
        stage
          ? 'Use Accept result to record the findings, then Send back to implementation to repair the candidate.'
          : 'Use Accept result to record the findings, then scope corrected work from this review.',
        'Accept result',
      );
    }

    const scope = attempt?.scopeRequest,
      scopeAnswered = (task.scopeEdits || []).some(
        edit =>
          edit.requestAttemptId === attempt?.id ||
          edit.attemptId === attempt?.id ||
          (edit.at && edit.at >= attempt?.finishedAt),
      );
    if (scope && !scopeAnswered && task.status === 'blocked' && attempt.status === 'blocked') {
      const paths = [...(scope.files || []), ...(scope.newFiles || []), ...(scope.deleteFiles || [])];
      if (mode.scope === 'auto' && !exhausted && !scope.problem && !note)
        return passive(
          'scope-auto',
          'The employee requested a change to the approved files.',
          'The controller checks the file request and queues another attempt if it is valid and within the attempt limit.',
          [scope.reason, ...paths],
        );
      return result(
        'scope-request',
        'The employee needs files outside the approved scope.',
        "Use Edit this story's files to review the exact paths and send the approved scope back to implementation.",
        "Edit this story's files",
        [scope.reason, scope.problem, ...paths],
      );
    }
    // Claude Code refused commands the employee tried, and it stopped (v1.0 item 22). The policy never
    // approves commands; the refused ones are listed as written so the director can approve each, or a
    // shorter prefix of it.
    const refused = (attempt?.commandDenials || []).filter(denial => denial.tool === 'Bash' && denial.command),
      commandsAnswered = (task.commandApprovals || []).some(item => item.attemptId === attempt?.id);
    if (refused.length && !commandsAnswered && task.status === 'blocked' && attempt.status === 'blocked')
      return {
        ...result(
          'command-request',
          'The employee stopped after Claude Code refused commands it tried to run.',
          'If the work needs them, use Allow commands to approve them, or a shorter start of each, for every Claude employee, and the work starts again from what it left. Otherwise read its reason, then use Start assignment or Close.',
          'Allow commands',
          [
            attempt.result?.summary,
            ...refused.map(denial => `Refused: ${denial.command}${denial.reason ? ` (${denial.reason})` : ''}`),
          ],
        ),
        commands: [...new Set(refused.map(denial => denial.command))],
      };
    if (fixedLimit && ['ready', 'blocked', 'failed', 'cancelled', 'review'].includes(task.status))
      return result(
        'fixed-limit',
        'This assignment used its fixed attempt limit.',
        'Create a newly scoped assignment to continue. Another attempt cannot be started on this assignment.',
        'Create assignment',
      );

    const retryable =
      (task.status === 'failed' || (task.status === 'review' && failed.length)) &&
      policy.enabled &&
      retryUsed < (policy.retries || 0) &&
      !exhausted &&
      !limitNote &&
      !note;
    if (retryable)
      return passive(
        'retry-auto',
        timeoutReason(attempt, reason)
          ? `${timeoutReason(attempt, reason)} An automatic retry is available.`
          : 'The current attempt did not pass; an automatic retry is available.',
        'The controller queues the bounded retry and starts it when prerequisites and resources are available.',
      );

    const timeout = timeoutReason(attempt, reason),
      stopped = ['failed', 'cancelled'].includes(task.status) || (task.status === 'blocked' && !task.controllerWait),
      retryNext = task.status === 'review' ? 'Request revision' : 'Start assignment';
    if (timeout && stopped) {
      return result(
        'timeout',
        timeout,
        'Inspect the recorded progress, narrow the work if needed, then use Start assignment.',
        'Start assignment',
      );
    }
    if (task.status === 'cancelled')
      return result(
        'cancelled',
        'The attempt was cancelled and stopped.',
        'Use Start assignment to try the work again, or Close to stop taking it further.',
        'Start assignment',
      );
    if (
      stopped &&
      /outside.*scope|out.of.scope|unapproved.*path|unapproved.*file|exceed.*approved file scope/i.test(
        reason || attempt?.error || '',
      )
    )
      return result(
        'outside-scope',
        'The returned files exceed the approved scope.',
        task.kind === 'studio-development:change'
          ? "Inspect the offending path and use Edit this story's files if that path is needed, then send the work back to implementation."
          : 'Inspect the offending path and correct the staged output before using Start assignment.',
        task.kind === 'studio-development:change' ? "Edit this story's files" : 'Start assignment',
        [reason],
      );
    const retryLimit = policy.enabled && (policy.retries || 0) > 0 && retryUsed >= policy.retries,
      retryAllowance = retryLimit ? 'The automatic retry allowance is used. ' : '';
    if (failed.length && ['review', 'failed', 'blocked'].includes(task.status))
      return result(
        'failed-checks',
        `The attempt did not pass: ${failed.map(c => c.name).join(', ')}.`,
        exhausted || limitNote
          ? `Automatic attempts are exhausted. Use ${retryNext}${task.status === 'review' ? ', then Start assignment' : ''} for an explicit director attempt-limit override, or close this work.`
          : `${retryAllowance}Inspect the failing checks and tests, then use ${retryNext} to repair the work.`,
        retryNext,
      );
    if (task.status === 'review' && ['needs-work', 'revise', 'blocked'].includes(verdict))
      return result(
        'review-findings',
        'The review requested changes.',
        'Inspect the findings and use Request revision to send the result back.',
        'Request revision',
      );

    // Only current controller reasons diagnose dispatch; approval notes on already
    // approved legacy rows are deliberately ignored rather than rewritten.
    const blocker =
        reason ||
        (['failed', 'blocked'].includes(task.status) &&
        !task.controllerWait &&
        !/approve or deny proposed work|work approval is required/i.test(note)
          ? note
          : ''),
      provider = executionProvider(view, state),
      employee = (state.workers || []).find(w => w.id === view.workerId),
      hold = usageHold(state, provider),
      holdReason = /subscription hold|usage limit to reset/i.test(blocker);
    // Work on a held CLI only waits. A hold whose CLI named its reset time clears itself; one with no known
    // reset is listed once for its CLI in Needs you (holdItems), not once for each task waiting on it. As in
    // the controller, a deliberate hold on the assignment comes first. The controller's reason names a hold
    // when none is recorded under this CLI's name here; a recorded hold cleared since can leave the old
    // reason behind, and the record wins.
    if ((hold || (holdReason && state.quota?.[provider] === undefined)) && !task.hold) {
      const adapter = state.adapters?.[provider],
        label = hold?.label || adapter?.quotaLabel || adapter?.name || provider || 'CLI',
        clears = hold ? !!hold.resetAt : /usage limit to reset/i.test(blocker);
      return passive(
        'subscription-wait',
        hold?.resetAt
          ? `Waiting for the ${label} usage limit to reset at ${resetClock(hold.resetAt)}. It clears itself.`
          : clears
            ? `${sentence(blocker)}. It clears itself.`
            : `Waiting for the ${label} usage limit, which has no known reset time. Its hold is listed once in Needs you.`,
        task.queued
          ? `The controller starts it once the hold ${clears ? 'clears' : 'is cleared'}.`
          : clears
            ? 'Start assignment queues it to start once the hold clears.'
            : 'Once the hold is cleared, use Start assignment to run it.',
        [holdReason ? '' : blocker],
      );
    }
    if (/subscription|login|quota/i.test(blocker))
      return result(
        'subscription',
        'The configured CLI subscription is not ready to run this work.',
        'Check the CLI subscription login or clear its recorded hold when usable, then use Start assignment.',
        'Check subscription',
        [blocker],
      );
    if (attempt?.subscriptionHold && ['blocked', 'failed'].includes(task.status) && !task.hold && !fixedLimit)
      return result(
        'subscription-cleared',
        'The CLI’s usage limit stopped the last attempt, and its hold has been cleared.',
        fixed
          ? 'Use Start assignment to run it again. Under this task type’s fixed limit, the stopped attempt still counts.'
          : 'Use Start assignment to run it again. The stopped attempt doesn’t count toward the attempt limit.',
        'Start assignment',
        [blocker],
      );
    if (task.hold)
      return result(
        'hold',
        'This assignment is deliberately on hold.',
        'Release the hold before using Start assignment.',
        'Release hold',
      );
    if (state.paused)
      return result(
        'dispatch-paused',
        'Studio dispatch is paused.',
        'Use Resume dispatch so queued work can start when eligible.',
        'Resume dispatch',
      );
    if (employee?.paused || (employee?.paused === undefined && /employee dispatch is paused/i.test(blocker)))
      return result(
        'employee-paused',
        'Dispatch is paused for the assigned employee.',
        'Open the employee execution settings and clear Pause new assignments for this employee.',
        'Save future-run settings',
      );
    // The controller's stop for tests whose sandbox isn't set up is fixed in Settings → Candidate tests, not in
    // the employee's settings. Every other sandbox or isolation stop is the employee's configuration.
    if (/run in the built-in sandbox, and it isn't set up/.test(blocker))
      return result(
        'test-sandbox',
        'This can’t start because its tests run in the built-in sandbox, which isn’t set up on this computer. The employee and its execution settings are fine.',
        'Set up the sandbox under Settings → Candidate tests, or choose No sandbox there.',
        'Candidate tests',
      );
    if (
      /adapter|capability|configuration|execution settings|isolation|sandbox|ownership|separation of duties|not installed|not available|not configured/i.test(
        blocker,
      ) ||
      employee?.enabled === false ||
      state.taskKinds?.[view.kind]?.available === false ||
      state.adapters?.[provider]?.available === false
    )
      return result(
        'configuration',
        'The current employee or execution configuration cannot run this assignment.',
        'Inspect the recorded blocker and correct the employee or task execution settings before starting it.',
        'Execution settings',
        [blocker],
      );

    const unmet = (view.dependencies || []).filter(id => {
      if (id === task.id && (stage || task.stageState)) return false;
      const dep = byId.get(id),
        milestone = task.waitsFor?.[id] || 'accepted';
      if (!dep || dep.status !== 'done') return true;
      if (milestone === 'accepted') return false;
      if (milestone === 'integrated')
        return !(
          dep.sourceStage?.current === 'integrated' ||
          all.some(
            a => a.taskId === id && a.id === dep.acceptedAttemptId && a.sourceIntegration?.state === 'integrated',
          )
        );
      return true;
    });
    if (unmet.length) {
      const waitingFor = unmet.map(id => `${id} to be ${task.waitsFor?.[id] || 'accepted'}`).join(', '),
        stoppedDeps = unmet.filter(
          id => ['failed', 'cancelled', 'denied'].includes(byId.get(id)?.status) || byId.get(id)?.closed,
        );
      return task.queued
        ? passive(
            'prerequisite-wait',
            `This assignment waits for ${waitingFor}.`,
            'The controller starts it after those milestones and the other dispatch conditions are met.',
            stoppedDeps.length
              ? [`Inspect prerequisite ${stoppedDeps.join(', ')}; supported recovery or replacement may be needed.`]
              : [],
          )
        : result(
            'prerequisite-wait',
            `This assignment waits for ${waitingFor}.`,
            'Use Start assignment to queue it. The controller starts it when the prerequisites and resources are ready.',
            'Start assignment',
          );
    }
    const resources = new Set([
        'employee:' + view.workerId,
        ...(view.resources || []),
        ...(state.taskKinds?.[view.kind]?.requiredResources || []),
      ]),
      lease = (state.leases || []).find(l => resources.has(l.resource)),
      busyEmployee = all.find(
        a =>
          a.workerId === view.workerId &&
          a.taskId !== task.id &&
          (['running', 'stopping', 'quarantined'].includes(a.status) ||
            (a.status === 'interrupted' && !a.reconciledAt)),
      ),
      slot =
        /studio execution slot/i.test(blocker) ||
        (Number.isInteger(state.maxParallel) &&
          all.filter(
            a =>
              ['running', 'stopping', 'quarantined'].includes(a.status) ||
              (a.status === 'interrupted' && !a.reconciledAt),
          ).length >= state.maxParallel),
      wait = lease || busyEmployee || slot || /^Waiting for /i.test(blocker);
    if (wait) {
      const kind =
          lease?.resource.startsWith('employee:') || busyEmployee
            ? 'employee-wait'
            : slot && !lease
              ? 'slot-wait'
              : 'resource-wait',
        // An agent held elsewhere is named, not its reservation (found in the README-only fresh install).
        agent = lease?.resource.startsWith('employee:') && lease.resource.slice('employee:'.length),
        why = agent
          ? `This assignment waits for ${(state.workers || []).find(worker => worker.id === agent)?.displayName || agent}, who is working on other work.`
          : lease
            ? `This assignment waits for ${lease.resource} to be released.`
            : busyEmployee
              ? 'The assigned employee is working on another assignment.'
              : slot
                ? 'This assignment waits for a studio execution slot.'
                : blocker,
        provenance = lease ? [`${lease.resource} is held by ${lease.attemptId}.`] : [];
      return task.queued
        ? passive(
            kind,
            why,
            'The controller starts it when the reservation or slot is free and other prerequisites are met.',
            provenance,
          )
        : result(
            kind,
            why,
            'Use Start assignment to queue it; the controller starts it when the reservation or slot is free.',
            'Start assignment',
            provenance,
          );
    }
    if ((exhausted || limitNote) && !task.directorStart)
      return result(
        'attempt-limit',
        'Automatic execution reached this assignment’s attempt limit.',
        'Use Start assignment for an explicit director attempt-limit override, or close this work.',
        'Start assignment',
      );
    if (task.status === 'blocked' && attempt?.result?.outcome === 'blocked')
      return result(
        'blocked-result',
        'The employee could not complete the assignment with the available inputs or access.',
        'Resolve the reported missing input or dependency, then use Start assignment, or close the work.',
        'Start assignment',
        [attempt.result.summary, blocker],
      );
    if (task.status === 'failed')
      return result(
        retryLimit ? 'retry-limit' : 'invalid-output',
        retryLimit
          ? 'The attempt failed and its automatic retry allowance is used.'
          : 'The attempt stopped without a validated completed result.',
        'Inspect the validation detail, correct the output or scope, then use Start assignment.',
        'Start assignment',
        [blocker],
      );
    // Other work whose independent review asked for changes: a later stage sent it back, and it runs again when
    // the director starts it. It did not stop on a blocker.
    const stageHistory = task.stageState?.history || [];
    if (task.status === 'blocked' && stageHistory[stageHistory.length - 1]?.outcome === 'sent-back')
      return result(
        'sent-back',
        'The independent review asked for changes, so the work goes back to be done again.',
        "Use Start assignment to run the work again with the review's findings, or close the work.",
        'Start assignment',
        [blocker],
      );
    if (task.status === 'blocked' && blocker)
      return result(
        'blocked',
        'The assignment is stopped by a recorded blocker.',
        'Resolve the supporting blocker, then use Start assignment.',
        'Start assignment',
        [blocker],
      );
    if (task.queued) {
      if (state.pipelineEnabled === false)
        return result(
          'pipeline-paused',
          'The project pipeline is paused.',
          'Use Resume pipeline to dispatch queued work when eligible.',
          'Resume pipeline',
        );
      const retry = attempt?.status === 'revision_requested' || retryUsed;
      return passive(
        retry ? 'retry-queued' : 'queued',
        retry ? 'Another attempt is queued for the current stage.' : 'This assignment is queued.',
        'The controller starts it when its prerequisites, employee and resources are available.',
      );
    }
    if (task.status === 'review')
      return result(
        'result-unavailable',
        'The current attempt has no validated completed result ready for acceptance.',
        'Inspect the current attempt and its validation evidence before making a result decision.',
        'Inspect stage',
      );
    return result(
      'ready',
      'This assignment is ready to be queued.',
      'Use Start assignment; the controller starts it when dispatch conditions are met.',
      'Start assignment',
    );
  }

  // Share the task's current explanation with full compact-state dependency,
  // reservation and policy context, including facts outside this run.
  // Callers may supply the task presenter for legacy control compatibility.
  function needsYou(state, tasks = state.tasks || [], explain = taskExplanation) {
    const resolved = new Set(['running', 'accepted', 'closed', 'denied', 'integrated']),
      byId = new Map((state.tasks || []).map(task => [task.id, task]));
    return tasks.flatMap(task => {
      const explanation = explain(task, state);
      if (resolved.has(explanation.kind)) return [];
      const unstarted = !(state.attempts || []).some(a => a.taskId === task.id),
        cleanup =
          unstarted &&
          explanation.kind === 'prerequisite-wait' &&
          (task.dependencies || []).some(id => {
            const prerequisite = byId.get(id);
            return prerequisite?.closed || ['failed', 'cancelled', 'denied'].includes(prerequisite?.status);
          });
      return [
        {
          ...explanation,
          taskId: task.id,
          text: explanation.reason,
          cleanup,
          canClose: unstarted && (cleanup || (task.status === 'backlog' && task.approval?.status === 'pending')),
        },
      ];
    });
  }
  // One item for each held CLI, however many tasks wait on it, with the tasks whose current explanation
  // waits on that hold. A hold whose CLI named its reset time clears itself; only one with no known
  // reset needs the director, to clear it once the CLI is usable.
  function holdItems(state, explain = taskExplanation) {
    const held = Object.keys(state.quota || {}).filter(key => state.quota[key]);
    if (!held.length) return [];
    const waiting = new Map(held.map(key => [key, []]));
    for (const task of state.tasks || [])
      if (explain(task, state).kind === 'subscription-wait')
        waiting.get(executionProvider(taskExecution(task, state).view, state))?.push(task.id);
    return held.map(key => {
      const { label, resetAt } = usageHold(state, key),
        resetTime = resetAt ? resetClock(resetAt) : null;
      return {
        kind: 'subscription-hold',
        provider: key,
        label,
        resetAt,
        resetTime,
        taskIds: waiting.get(key),
        reason: resetAt
          ? `The ${label} usage limit resets at ${resetTime}, and its hold clears itself then.`
          : `The ${label} usage limit has no known reset time, so its hold stays until you clear it.`,
        next: resetAt
          ? 'Nothing is needed from you. Queued work waiting on it starts once the hold clears.'
          : `Clear the hold once the ${label} CLI is usable again. Queued work then starts; stopped work needs Start assignment.`,
        action: resetAt ? null : 'Clear hold',
        requiresDirector: !resetAt,
      };
    });
  }
  // Every commit a run's integrations made, in the order they finished.
  function committed(journals) {
    const commits = [
      ...new Set(
        journals
          .filter(journal => journal?.state === 'integrated' && journal.repository?.commit)
          .sort((a, b) => time(a.finishedAt) - time(b.finishedAt))
          .map(journal => journal.repository.commit.slice(0, 7)),
      ),
    ];
    if (!commits.length) return 'The change was committed.';
    if (commits.length === 1) return `The change was committed as ${commits[0]}.`;
    return `The changes were committed as ${commits.slice(0, -1).join(', ')} and ${commits.at(-1)}.`;
  }

  function outcome(tasks, attempts, waiting, pending) {
    const decisions = waiting.filter(item => item.requiresDirector),
      progress = tasks
        .filter(task => !task.closed && !['denied', 'cancelled'].includes(task.status))
        .map(task => sourceProgress(task, attempts, pending))
        .filter(Boolean),
      unfinished = progress.filter(item => item.stage.current !== 'integrated');
    if (tasks.every(task => task.closed))
      return { tone: 'muted', label: 'Closed', text: 'All work was closed without taking it further.' };
    if (
      !attempts.some(attempt => attempt.acceptedAt) &&
      tasks.every(task => ['denied', 'cancelled'].includes(task.status))
    )
      return { tone: 'muted', label: 'Cancelled', text: 'Cancelled before it produced anything.' };
    if (unfinished.some(item => item.busy))
      return { tone: 'busy', label: 'In progress', text: 'Integration is approved or running.' };
    if (unfinished.length) {
      if (decisions.length)
        return {
          tone: 'wait',
          label: 'Needs you',
          text: `${decisions.length} item${decisions.length === 1 ? '' : 's'} waiting for you.`,
        };
      return { tone: 'busy', label: 'In progress', text: `${unfinished[0].label}.` };
    }
    if (progress.length && progress.every(item => item.stage.current === 'integrated'))
      return { tone: 'ok', label: 'Integrated', text: committed(progress.map(item => item.journal)) };
    const integrated = attempts.find(attempt => attempt.sourceIntegration?.state === 'integrated'),
      active =
        tasks.some(task => ['running', 'stopping'].includes(task.status) || (task.queued && task.status === 'ready')) ||
        attempts.some(attempt => attempt.sourceIntegration?.state === 'verifying'),
      stopped = tasks
        .filter(task => task.autonomyNote && ['failed', 'blocked'].includes(task.status) && !task.controllerWait)
        .sort((a, b) => time(b.createdAt) - time(a.createdAt))[0];
    if (integrated)
      return {
        tone: 'ok',
        label: 'Integrated',
        text: committed(attempts.map(attempt => attempt.sourceIntegration)),
      };
    if (active) return { tone: 'busy', label: 'In progress', text: 'Work is running now.' };
    if (
      stopped &&
      tasks.every(task => ['failed', 'cancelled', 'denied', 'done'].includes(task.status)) &&
      waiting.length &&
      waiting.every(item => item.requiresDirector)
    )
      return { tone: 'bad', label: 'Stopped', text: waiting[0].reason };
    if (decisions.length)
      return {
        tone: 'wait',
        label: 'Needs you',
        text: `${decisions.length} item${decisions.length === 1 ? '' : 's'} waiting for you.`,
      };
    // Accepted reviews that asked for changes leave nothing waiting; new work from their findings is optional
    // (v1.0 item 17). Any other wait keeps the run in progress.
    if (waiting.length && waiting.every(item => !item.requiresDirector && item.kind === 'review-findings'))
      return {
        tone: 'muted',
        label: 'Finished',
        text: "Ended without integrating because the review asked for changes. If you still want the change, start new work from the review's findings.",
      };
    if (waiting.some(item => !item.requiresDirector))
      return { tone: 'busy', label: 'In progress', text: 'The controller is waiting; nothing is needed from you.' };
    if (stopped && !['done', 'denied', 'cancelled'].includes(stopped.status))
      return { tone: 'bad', label: 'Stopped', text: sentence(stopped.autonomyNote).split('. ')[0] + '.' };
    if (tasks.every(task => ['done', 'denied', 'cancelled'].includes(task.status)))
      return { tone: 'muted', label: 'Finished', text: 'Nothing is waiting.' };
    return { tone: 'muted', label: 'Idle', text: 'Nothing is running and nothing is waiting for you.' };
  }

  // A run is named after the work it proposed, else its brief, else its workflow. Proposals
  // that were retired, denied or closed name it only when nothing else was proposed.
  function runTitle(members, brief, workflowName) {
    const roots = new Set(members.filter(task => task.workflowReference).map(task => task.id)),
      proposed = members
        .filter(task => !task.retryOf && roots.has(task.proposalReference?.taskId))
        .sort((a, b) => time(a.createdAt) - time(b.createdAt)),
      current = proposed.filter(task => task.status !== 'denied'),
      named = current.length ? current : proposed.slice(0, 1);
    if (named.length) return named.length === 1 ? named[0].title : `${named[0].title} (and ${named.length - 1} more)`;
    const line = sentence(brief);
    return line ? (line.length > 80 ? line.slice(0, 79) + '…' : line) : workflowName;
  }

  const statusLabel = status =>
    ({
      backlog: 'Planned',
      ready: 'Ready',
      blocked: 'Waiting',
      running: 'Working',
      stopping: 'Stopping',
      review: 'Review',
      done: 'Accepted',
      failed: 'Failed',
      cancelled: 'Cancelled',
      denied: 'Denied',
    })[status] || status;
  // A run's recorded graph (MP-015 G2) in stages: each node follows the nodes it waits for.
  function graphStages(record, tasks, workers) {
    const byId = new Map(tasks.map(task => [task.id, task])),
      nodes = new Map(record.nodes.map(node => [node.taskId, node])),
      depth = new Map();
    const depthOf = id => {
      if (depth.has(id)) return depth.get(id);
      depth.set(id, 0);
      const upstream = (nodes.get(id)?.dependencies || []).filter(dependency => nodes.has(dependency));
      const value = upstream.length ? 1 + Math.max(...upstream.map(depthOf)) : 0;
      depth.set(id, value);
      return value;
    };
    const stages = [];
    for (const node of record.nodes) {
      const index = depthOf(node.taskId),
        task = byId.get(node.taskId),
        workerId = task?.workerId || node.workerId;
      (stages[index] ||= []).push({
        taskId: node.taskId,
        title: task?.title || node.title,
        kind: node.kind,
        status: task ? (task.closed ? 'Closed' : statusLabel(task.status)) : 'Not recorded',
        worker: workers.get(workerId)?.displayName || workerId || '',
        revision: node.revision,
      });
    }
    return {
      revisions: record.revisions.length,
      envelope: record.envelope || null,
      legacy: !!record.legacy,
      stages: stages.filter(Boolean),
    };
  }

  function buildRunStories(state, explain = taskExplanation) {
    const tasks = state.tasks || [],
      attempts = [...(state.attempts || [])].sort((a, b) => time(a.startedAt) - time(b.startedAt)),
      workers = new Map((state.workers || []).map(worker => [worker.id, worker])),
      kinds = state.taskKinds || {},
      modelFree = new Set(state.modelFreeProviders || []),
      runOf = runMembership(tasks),
      records = new Map((state.runs || []).map(record => [record.id, record])),
      runs = new Map();
    for (const task of tasks) {
      const id = runOf.get(task.id);
      if (!id) continue;
      if (!runs.has(id)) runs.set(id, []);
      runs.get(id).push(task);
    }
    return [...runs.entries()]
      .map(([id, members]) => {
        const root = members
            .filter(task => task.workflowReference?.runId === id)
            .sort((a, b) => time(a.createdAt) - time(b.createdAt))[0],
          ids = new Set(members.map(task => task.id)),
          own = attempts.filter(attempt => ids.has(attempt.taskId)),
          waiting = needsYou(state, members, explain),
          record = records.get(id),
          startedAt = record?.createdAt || root?.createdAt || members[0].createdAt,
          brief = record?.brief || root?.workflowReference.brief || '',
          name = record?.workflow?.name || root?.workflowReference.name || 'Workflow run';
        return {
          id,
          name,
          title: runTitle(members, brief, name),
          brief,
          directorInputs: record?.directorInputs || root?.directorInputs || [],
          graph: record ? graphStages(record, members, workers) : null,
          ...(record?.archive ? { archive: record.archive } : {}),
          startedAt,
          taskIds: members.map(task => task.id),
          steps: [
            {
              at: startedAt,
              kind: 'start',
              tone: 'info',
              text: brief ? 'Run started with the brief above.' : 'Run started.',
            },
            ...steps(members, own, workers, kinds, modelFree),
          ],
          needsYou: waiting,
          outcome: outcome(members, own, waiting, state.autonomy?.pendingIntegration),
        };
      })
      .sort((a, b) => time(b.startedAt) - time(a.startedAt));
  }

  globalThis.StudioRuns = Object.freeze({
    buildRunStories,
    runMembership,
    awaitedSource,
    sourceStage,
    sourceProgress,
    integrationReview,
    taskExplanation,
    needsYou,
    holdItems,
  });
})();

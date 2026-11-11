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

  // What a story whose plan the code moved past says when its note records no reason of its own.
  const outdatedReason =
    'The code moved on since this story was planned. Close it and send its remaining work as a new idea.';
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
  // Only a waiting request for this same story refuses it; a story behind another
  // story's request keeps its review and waits its turn.
  function integrationReview(task, attempts, pending, tasks = []) {
    return integrationCheck(task, attempts, pending, tasks).review || null;
  }
  // The same checks, returning the review or the first one that fails in the director's words: no file, record ID
  // or internal kind, so the catch-all for a finished story can say what is missing or doesn't match.
  function integrationCheck(task, attempts, pending, tasks = []) {
    const stage = sourceStage(task),
      own = pending?.taskId === task.id,
      first = checks => ({ missing: checks.find(([failed]) => failed)?.[1] || '' }),
      running = 'An integration of this story is already under way.';
    // Legacy reviews are separate tasks. Resolve their current accepted candidate,
    // then use the same identity/check predicates as a staged source story.
    if (!stage) {
      // Cheap refusals first, so the record lookups below run only for a finished review.
      const early = first([
        [task.kind !== 'studio-development:change-review', 'This work is not a review of a change.'],
        [task.closed, 'The review was closed.'],
        [own, running],
        [task.status !== 'done', 'The review is not finished.'],
      ]);
      if (early.missing) return early;
      const review = attempts.find(a => a.taskId === task.id && a.id === task.acceptedAttemptId),
        source = review?.candidateReview,
        owner = tasks.find(t => t.id === source?.taskId),
        candidate = attempts.find(a => a.id === source?.attemptId && a.taskId === owner?.id),
        item = review?.artifacts?.find(a => a.kind === 'source-change-review'),
        refused = first([
          [!review, 'The accepted review is not in the records.'],
          [!source, 'The review does not record which change it checked.'],
          [!owner, 'The story whose change it checked is not in the records.'],
          [!candidate, 'The change it checked is not in the records.'],
          [!item, "The review's report is not in the records."],
          [owner?.closed, 'The story whose change it checked was closed.'],
          [
            review?.workerId !== task.workerId || candidate?.workerId !== owner?.workerId,
            'The agent recorded for the review or the change is not the one who did it.',
          ],
          [owner?.kind !== 'studio-development:change', 'The work it checked is not a change to the source.'],
          [owner?.status !== 'done', 'The change it checked is not finished.'],
          [
            owner?.acceptedAttemptId !== candidate?.id || owner?.lastAttemptId !== candidate?.id,
            "The change it checked is no longer that story's current one.",
          ],
          [task.lastAttemptId !== review?.id, "The review's latest attempt is not its accepted one."],
          [
            task.dependencies?.length !== 1 || task.dependencies?.[0] !== owner?.id,
            'The review does not follow only the change it checked.',
          ],
        ]);
      if (refused.missing) return refused;
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
      const projectedCheck = integrationCheck(projected, [candidateView, reviewView], pending);
      return projectedCheck.review ? { review } : projectedCheck;
    }
    if (task.closed) return { missing: 'The story is closed.' };
    const progress = sourceProgress(task, attempts, pending),
      ref = stage.review,
      pin = stage.candidate,
      refused = first([
        [task.status !== 'done', 'The story is not finished.'],
        [!ref, 'No passing review is recorded for the story.'],
        [!pin, 'The change the review checked is not recorded.'],
        [ref?.verdict !== 'pass', "The story's recorded review did not pass the change."],
        [task.acceptedAttemptId !== ref?.attemptId, "The story's accepted result is not its passing review."],
        [task.lastAttemptId !== ref?.attemptId, "The story's latest attempt is not the one whose review passed."],
        [
          !['waiting-for-integration', 'failed', 'blocked'].includes(stage.current) ||
            !['candidate-review', 'integration'].includes(stage.phase),
          'The story is not at the point where it waits for integration.',
        ],
        [
          progress.busy ||
            own ||
            (progress.journal && !['rejected', 'abandoned'].includes(progress.journal.state)) ||
            (stage.integration && !['rejected', 'abandoned'].includes(stage.integration.state)),
          running,
        ],
      ]);
    if (refused.missing) return refused;
    const review = progress.review,
      candidate = attempts.find(item => item.id === pin.attemptId),
      item = review?.artifacts?.find(
        item => item.path === ref.path && item.hash === ref.hash && item.kind === 'source-change-review',
      ),
      manifest = candidate?.artifacts?.find(
        item => item.path === pin.path && item.hash === pin.hash && item.kind === 'source-change',
      ),
      source = review?.candidateReview,
      failed = a => [...(a?.result?.checks || []), ...(a?.controllerChecks || [])].some(c => c.status === 'fail'),
      checked = first([
        [!review, 'The passing review is not in the records.'],
        [!candidate, 'The reviewed change is not in the records.'],
        [!item, "The review's report does not match the one recorded for the story."],
        [!manifest, 'The reviewed change does not match the change recorded for the story.'],
        [
          ref.taskId !== task.id || pin.taskId !== task.id || candidate?.taskId !== task.id,
          'The review or the change belongs to another story.',
        ],
        [review?.status !== 'accepted', 'The review was not accepted.'],
        [candidate?.status !== 'accepted', 'The change was not accepted.'],
        [review?.assignment?.kind !== 'studio-development:change-review', 'The review was not a review of a change.'],
        [candidate?.assignment?.kind !== 'studio-development:change', 'The change was not a change to the source.'],
        [review?.result?.outcome !== 'completed', 'The review did not complete.'],
        [candidate?.result?.outcome !== 'completed', 'The change did not complete.'],
        [review?.candidateReviewVerdict !== 'pass' || !source?.passed, 'The review did not pass the change.'],
        [
          review?.workerId !== ref.workerId || candidate?.workerId !== pin.workerId,
          'The agent recorded for the review or the change is not the one who did it.',
        ],
        [review?.workerId === candidate?.workerId, 'The reviewer is the same agent as the editor.'],
        [
          source?.taskId !== task.id ||
            source?.attemptId !== pin.attemptId ||
            source?.path !== pin.path ||
            source?.hash !== pin.hash ||
            source?.candidateHash !== pin.candidateHash,
          "The review checked a different change than the story's current one.",
        ],
        [
          candidate?.sourceCandidate?.sourceHash !== pin.candidateHash,
          "The story's current change is not the one its editor built and tested.",
        ],
        [failed(candidate), "The change's own checks failed."],
        [failed(review), "The review's own checks failed."],
        [
          !review?.inputReferences?.some(
            input =>
              input.taskId === task.id &&
              input.attemptId === pin.attemptId &&
              // Recorded inputs are job-relative copies, so match the manifest by kind and hash.
              input.artifacts?.some(item => item.kind === 'source-change' && item.hash === pin.hash),
          ),
          "The review's inputs do not include the change.",
        ],
      ]);
    return checked.missing ? checked : { review };
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

  // The recorded wait for the computer's one full test suite at a time, on an attempt or an integration's journal.
  const turnWait = record =>
    typeof record?.testTurn?.reason === 'string' && record.testTurn.reason.trim() ? record.testTurn.reason : '';

  // The attempt whose question still waits for an answer, as in the controller (src/core/questions.mjs
  // waitingQuestion): the blocked task's latest attempt, blocked with a question it asked, which no answer names.
  // A question that could not be read has no ask, so it never waits.
  function waitingQuestion(task, attempts) {
    if (task.status !== 'blocked' || !task.lastAttemptId) return null;
    const asking = attempts.find(a => a.id === task.lastAttemptId);
    if (asking?.status !== 'blocked' || !asking.question?.ask) return null;
    return (task.answers || []).some(answer => answer.attemptId === asking.id) ? null : asking;
  }
  // Whether auto mode may answer it for the director (src/core/questions.mjs answerableInAutoMode): a choice the agent
  // marked as inside its story, touching none of the kinds kept for the director, with a recommendation, from an
  // attempt that asked for no files.
  const answerableInAutoMode = attempt =>
    attempt.question.choice === 'inside-story' &&
    !(attempt.question.topics || []).length &&
    Number.isInteger(attempt.question.recommended) &&
    !attempt.scopeRequest;

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
      // As in the controller, an attempt a provider's usage limit stopped, one the controller's stop interrupted
      // and the director reconciled, or one that stopped to ask a question, doesn't count, except under a fixed limit.
      exhausted =
        Number.isInteger(knownLimit) &&
        current.filter(
          a => fixed || (!a.subscriptionHold && !(a.status === 'interrupted' && a.reconciledAt) && !a.question?.ask),
        ).length >= knownLimit,
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
        // While its verification waits for the computer's test turn, the journal names whose suite runs.
        turnWait(journal) || 'The controller is integrating the approved change.',
        'It will finish verification and record the integration outcome. If interrupted, reconcile the journal before another write.',
      );

    const integrable = integrationReview(task, all, pending, state.tasks || []);
    if (integrable) {
      const stopped = !!journal || !!stageJournal,
        // The policy's earlier note that an integration was already waiting is no refusal: the controller still
        // takes the story in its turn (src/core/autonomy-runtime.mjs integrateWaiting).
        turnNote = /An integration is already waiting\.$/.test(note),
        refused =
          (stage?.phase === 'integration' && stage.current === 'failed') ||
          !!reason ||
          (!turnNote && /could not request integration|approve it yourself/i.test(note)),
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
      // Another story holds the studio's one integration request. While it waits, the controller refuses a second
      // request (src/core/autonomy-runtime.mjs requestIntegration), so a story the policy would integrate, or one
      // never tried that needs the director's approval, waits its turn without a call for the director.
      const ahead = pending?.taskId && pending.taskId !== task.id ? pending : null;
      if (ahead && (automatic || (policy.enabled && !stopped && !refused))) {
        const title = (state.tasks || []).find(item => item.id === ahead.taskId)?.title;
        return passive(
          'integration-queued',
          `Waiting to integrate behind “${title || ahead.taskId}”.`,
          automatic
            ? 'The studio integrates it when its turn comes.'
            : 'Once that story starts integrating, this one is ready for your approval.',
        );
      }
      if (automatic)
        return passive(
          'integration-auto',
          'The current independent review passed.',
          'The controller requests integration automatically, waits for resources, then formats and verifies the change.',
        );
      let kind = 'integration-approval',
        why = 'The current independent review passed and awaits integration approval.',
        recovery = `Use ${approvalAction} to request controller-owned integration.`,
        action = approvalAction;
      if (stopped || refused) {
        // The controller's own messages name the line (src/connectors/source-integration.mjs fastForward,
        // src/connectors/source-lines.mjs moveLine); the journal's recorded line comes first.
        const text = error || '',
          moved = text.match(/(\S+) moved during verification/),
          here = text.match(/(\S+) was checked out in the project's folder during verification/),
          elsewhere = text.match(/(\S+) is checked out in (.+?)(?:\. Studio desk moves\b|\.?$)/),
          line = journal?.repository?.branch || (here || elsewhere || moved)?.[1],
          conflicts = journal?.verification?.conflicts || [];
        kind = 'integration-stopped';
        why = 'The last integration did not complete.';
        recovery = `What stopped it is in the details. Once that is resolved, use ${approvalAction}.`;
        if (/conflict|could not be merged/i.test(text) || conflicts.length) {
          kind = 'integration-conflict';
          why = 'The change could not be combined with the current source.';
          if (journal?.state === 'rejected' && conflicts.length) {
            // The controller sends it back to its editor merged onto the current source (mergeSourceStory).
            action = 'Merge onto the current source';
            recovery = `Use ${action} so its editor combines the change with the current source; it is then tested and reviewed again.`;
          } else
            recovery = `Ask for a fresh candidate on the current source and a new independent review, then use ${approvalAction}.`;
        } else if (here || elsewhere) {
          kind = 'integration-line-checked-out';
          why = here
            ? `“${line}” was checked out in the project's folder while the change was being tested.`
            : `“${line}” was checked out in another folder, ${elsewhere[2]}, while the change was being tested.`;
          recovery = here
            ? `Use ${approvalAction} to merge the change onto “${line}” there.`
            : `Check out another branch in ${elsewhere[2]}, then use ${approvalAction}. Studio desk moves a line only in the project's folder or where nothing has it checked out.`;
        } else if (moved) {
          kind = 'integration-line-moved';
          why = `“${line}” moved while the change was being tested.`;
          recovery = `Use ${approvalAction}; it merges the change onto the line as it is now.`;
        } else if (phase === 'integration.format' || /formatter/i.test(text)) {
          kind = 'integration-formatter';
          why = 'Integration stopped while formatting the reviewed files.';
          recovery = `Fix the formatter failure in the details or ask for a corrected candidate, then use ${approvalAction}.`;
        } else if (journal?.verification?.landedSince) {
          // It passed its own tests and fails only merged onto work that landed after it was tested (October 27).
          kind = 'integration-landed';
          why = 'The change passed its own tests but fails together with work that landed after it was tested.';
          action = 'Merge onto the current source';
          recovery = `Use ${action} so its editor makes the change work with what landed. Integrating again fails the same way while the source stays as it is.`;
        } else if (
          journal?.verification?.passed !== true &&
          (phase === 'integration.verification' || journal?.verification?.passed === false)
        ) {
          kind = 'integration-tests';
          why = 'The formatted change failed a test when it was tested on the line.';
          recovery = `Use ${approvalAction} to test it again, or send it back if the failure is the change's own. The failing tests are in the details.`;
        } else if (/branch|local edits|local changes|working tree|moved|tip|fast.forward/i.test(text)) {
          kind = 'integration-source-moved';
          why = 'The line or the development copy changed before the integration could finish.';
          recovery = `If the development copy has local edits, commit or stash them, then use ${approvalAction}. It merges the change onto the line as it is now.`;
        }
        // Another story holds the studio's one integration request; with the policy on the controller takes no
        // second one until that story starts integrating (src/core/autonomy-runtime.mjs requestIntegration). The
        // story stays the director's call. Merge onto the current source is not held by that request.
        if (ahead && policy.enabled) {
          const title = (state.tasks || []).find(item => item.id === ahead.taskId)?.title || ahead.taskId;
          recovery +=
            action === approvalAction
              ? ` ${approvalAction} is accepted once “${title}” starts integrating.`
              : ` ${action} does not wait for “${title}”, which holds the integration request; ${approvalAction} is accepted once it starts integrating.`;
        }
      }
      return result(kind, why, recovery, action, [error]);
    }
    // A source story whose plan the code moved past (sourceStage.outdated, noted when the controller refused its Start
    // or an edit of its files for that reason): neither starting it again nor editing its files can work, so it reads
    // the recorded plain reason, not the refusal naming files, and asks the director to send its work as a new idea.
    if (stage?.outdated && !['running', 'stopping'].includes(task.status))
      return {
        ...result(
          'outdated',
          (typeof stage.outdated.reason === 'string' && stage.outdated.reason.trim()) || outdatedReason,
          'Use Close and send as a new idea. Its remaining work gets fresh checks and a new plan, and the story closes once the new idea is taken in.',
          'Close and send as a new idea',
        ),
        details: [],
      };
    if (task.status === 'done') {
      if (stage?.current === 'failed' && stage.review?.verdict === 'needs-work' && currentReview)
        return result(
          'review-findings',
          'The independent review requested changes.',
          'Use Send back to implementation; the next attempt receives the review findings. You may also close without integrating.',
          'Send back to implementation',
          explanationDetails(review),
        );
      // Evidence that is really missing or doesn't match: say which, and offer what the story page has. A finished
      // story that will not be integrated may be closed (decisionState's closable).
      const missing = () =>
        integrationCheck(task, all, pending, state.tasks || []).missing ||
        "The records do not show a passing review of the story's current change.";
      if (stage && stage.current !== 'integrated')
        return result(
          'integration-ineligible',
          missing(),
          'It can be integrated only once a passing review of its current change is recorded. If you no longer want it, use Close without integrating.',
          'Close without integrating',
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
        // The older layout offers no close; the story page shows the review and what it recorded.
        return result(
          'integration-ineligible',
          missing(),
          'Open the story to see the review. The change can be integrated only once an accepted passing review records the change it checked, as that change stands now.',
          'Open the story',
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
    // A running attempt waiting for the computer's test turn (core/test-turn.mjs) only waits, as its record says.
    if (task.status === 'running' && turnWait(attempt))
      return passive(
        'test-turn-wait',
        turnWait(attempt),
        'The controller runs its tests once that suite finishes. The wait does not count toward its time limit.',
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

    // An agent stopped to ask the director a question (1.2 step 2). With the work's own auto mode on, auto mode
    // answers a choice inside the story with the agent's recommendation; every other question waits for the director.
    const asking = waitingQuestion(task, attempts);
    if (asking) {
      const { ask, why, options = [], recommended } = asking.question,
        workerId = asking.workerId || view.workerId,
        agent = (state.workers || []).find(w => w.id === workerId)?.displayName || workerId || 'The agent',
        exchange = { details: [ask, why].filter(Boolean), attemptId: asking.id },
        pick = options[recommended]?.label;
      if (task.autoMode === true && answerableInAutoMode(asking))
        return {
          ...passive(
            'question-auto',
            `${agent} asked a question that auto mode answers.`,
            `Auto mode answers with the agent's recommendation${pick ? `, “${pick}”,` : ''} and the work continues from its saved work.`,
          ),
          ...exchange,
        };
      return {
        ...result(
          'question',
          `${agent} asked you a question.`,
          `Use Answer to answer it with one of its options, your own words, or both. ${agent} continues from the saved work with your answer.`,
          'Answer',
        ),
        ...exchange,
      };
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
    // Failed checks are the director's call only while the work is stopped or in review. Work the controller holds in
    // a queue (a story waiting its turn on its line after an approved file request, say) is a wait, below.
    if (failed.length && (stopped || task.status === 'review'))
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
    // When an attempt stops, the controller records its own error, or its blocked result, as the reason, and a
    // change story's error ends with advice that mentions sandboxes. Only a reason the controller recorded when
    // it refused to start the work describes the configuration; a failed attempt reads as failed below.
    const attemptText = [
        attempt?.error,
        attempt?.result?.summary,
        ...(attempt?.result?.issues || []),
        attempt?.result?.issues?.join(' '),
      ].filter(Boolean),
      refusal = !(task.status === 'failed' && attempt?.status === 'failed') && !attemptText.includes(blocker);
    if (
      (refusal &&
        /adapter|capability|configuration|execution settings|isolation|sandbox|ownership|separation of duties|not installed|not available|not configured/i.test(
          blocker,
        )) ||
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
    // A restart holds the project's queue until the director resumes it (the Runner's constructor marks the project
    // restartPaused). Queued work whose own prerequisites are met waits only for that, before any slot, resource or
    // integration it would wait for next, as the controller orders it (refreshReadiness). The project's one resume
    // call lists it (resumeItems), so it is no call of its own; its page keeps Resume pipeline (the kind). A project
    // the director paused keeps its words below.
    if (
      task.queued &&
      state.project?.restartPaused &&
      state.pipelineEnabled === false &&
      (task.status === 'ready' || task.controllerWait) &&
      (!blocker || /^Waiting for the project to resume/i.test(blocker)) &&
      !((exhausted || limitNote) && !task.directorStart)
    )
      return result(
        'pipeline-paused',
        'Waits only for this project to be resumed.',
        'It starts by itself once you resume the project, here or from Your calls.',
      );
    // The work's own resources: an agent at work elsewhere is no reason to wait, since it runs several attempts at
    // once (MP-033).
    const resources = new Set([...(view.resources || []), ...(state.taskKinds?.[view.kind]?.requiredResources || [])]),
      lease = (state.leases || []).find(l => resources.has(l.resource)),
      slot =
        /studio execution slot/i.test(blocker) ||
        (Number.isInteger(state.maxParallel) &&
          all.filter(
            a =>
              ['running', 'stopping', 'quarantined'].includes(a.status) ||
              (a.status === 'interrupted' && !a.reconciledAt),
          ).length >= state.maxParallel),
      wait = lease || slot || /^Waiting for /i.test(blocker);
    if (wait) {
      // The controller's own words for the wait come first ("Waiting for T-… to be integrated: source stories on
      // main run two at a time."); a reservation's name only when it gave none.
      const kind = slot && !lease ? 'slot-wait' : 'resource-wait',
        why = /^Waiting for /i.test(blocker)
          ? blocker
          : lease
            ? `This assignment waits for ${lease.resource} to be released.`
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
        attempt?.status === 'failed'
          ? 'The last attempt failed, and automatic execution reached this assignment’s attempt limit.'
          : 'Automatic execution reached this assignment’s attempt limit.',
        'Use Start assignment for an explicit director attempt-limit override, or close this work.',
        'Start assignment',
      );
    if (task.status === 'blocked' && attempt?.result?.outcome === 'blocked')
      return result(
        'blocked-result',
        'The employee could not complete the assignment with the available inputs or access.',
        'Resolve the reported missing input or dependency, then use Start assignment, or close the work.',
        'Start assignment',
        [
          attempt.result.summary,
          blocker,
          // A question.json the controller could not read is no question; the agent's stop says why.
          attempt.question?.problem && `The agent's question could not be read: ${attempt.question.problem}`,
        ],
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
    // A running attempt's wait for the test turn is running work, never the director's.
    const resolved = new Set(['running', 'test-turn-wait', 'accepted', 'closed', 'denied', 'integrated']),
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
  // One item for the project while a restart holds its queue (state.project.restartPaused), with the queued work that
  // waits only for the director to resume it (taskExplanation's restart wait). A project the director paused has none:
  // its queued work keeps its own calls.
  function resumeItems(state, explain = taskExplanation) {
    if (!state.project?.restartPaused) return [];
    const taskIds = (state.tasks || [])
      .filter(task => {
        const explanation = explain(task, state);
        return explanation.kind === 'pipeline-paused' && !explanation.requiresDirector;
      })
      .map(task => task.id);
    return [
      {
        kind: 'project-resume',
        projectId: state.project.id,
        taskIds,
        reason:
          "The controller restarted, so this project's work is held until you have looked at what the restart interrupted.",
        next: 'Resume the project when you are ready; queued stories, carries and releases then go on by themselves.',
        action: 'Resume this project',
        requiresDirector: true,
      },
    ];
  }
  // The attempt a task records under the name given, from this project's summaries.
  const recordedAttempt = (state, task, id = task.lastAttemptId) =>
    (state.attempts || []).find(
      attempt =>
        attempt.id === id &&
        attempt.taskId === task.id &&
        (!attempt.projectId || attempt.projectId === state.project.id),
    );
  // The words of the integration action a passing review in the older two-task layout offers: approving it under the
  // house rules or on a staged story, integrating it otherwise, and again after an integration that did not complete.
  function integrationAction(state, task, attempt) {
    const retry =
      ['rejected', 'abandoned'].includes(attempt.sourceIntegration?.state ?? '') ||
      (task.sourceStage?.phase === 'integration' && task.sourceStage.current === 'failed') ||
      !!(task.sourceStage?.reason || task.reason) ||
      /could not request integration|approve it yourself/i.test(String(task.autonomyNote ?? ''));
    if (state.autonomy?.policy?.enabled || task.sourceStage)
      return retry ? 'Approve integration again' : 'Approve integration';
    return retry ? 'Integrate again' : 'Integrate reviewed source';
  }
  // The director's explanation of a task (the dashboard's explain): the shared taskExplanation, with a denied task's
  // reason as its detail, plus a passing review in the older two-task layout that waits for integration.
  function directorExplanation(task, state) {
    const explanation = taskExplanation(task, state),
      accepted = recordedAttempt(state, task, task.acceptedAttemptId),
      journal = accepted?.sourceIntegration;
    if (explanation.kind === 'denied' && task.reason) return { ...explanation, details: [String(task.reason)] };
    if (
      !task.sourceStage &&
      !task.closed &&
      task.kind === 'studio-development:change-review' &&
      task.status === 'done' &&
      accepted &&
      (!journal || ['rejected', 'abandoned'].includes(journal.state ?? '')) &&
      accepted.candidateReviewVerdict === 'pass'
    ) {
      const action = integrationAction(state, task, accepted);
      return {
        ...explanation,
        kind: journal ? 'integration-stopped' : 'integration-approval',
        reason: journal
          ? 'The last integration did not complete.'
          : 'The current independent review passed and awaits integration approval.',
        next: journal
          ? `Inspect the recorded failure and resolve it before using ${action}.`
          : `Use ${action} to request controller-owned integration.`,
        action,
        requiresDirector: true,
      };
    }
    return explanation;
  }
  // What Today lists as the project's calls, from the run stories given (each told by buildRunStories): each run's
  // items, its unstarted steps waiting on stopped work as one cleanup, then work outside any run, then each CLI's
  // usage hold with no known reset, once, then the project's resume while a restart holds it, with the work waiting
  // only for that. Items whose requiresDirector is false only wait; the controller's list of
  // what needs the director now (src/core/director-calls.mjs) keeps the others.
  function needsYouItems(state, runs) {
    const runOf = runMembership(state.tasks || []),
      seen = new Set(),
      items = [];
    for (const run of runs) {
      const rows = run.needsYou.filter(item => !seen.has(item.taskId));
      rows.forEach(item => seen.add(item.taskId));
      const cleanup = rows.filter(item => item.cleanup);
      rows.filter(item => !item.cleanup).forEach(item => items.push({ ...item, run }));
      if (cleanup.length)
        items.push({
          run,
          members: cleanup,
          taskIds: cleanup.map(item => item.taskId),
          requiresDirector: cleanup.some(item => item.requiresDirector),
        });
    }
    const standalone = (state.tasks || []).filter(task => !runOf.has(task.id) && !seen.has(task.id));
    items.push(...needsYou(state, standalone, directorExplanation));
    items.push(...holdItems(state, directorExplanation).filter(hold => hold.requiresDirector));
    items.push(...resumeItems(state, directorExplanation));
    return items;
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

  // How a run stands: its words (label, text) and tone for the page, and beside them a fixed state the pages decide
  // from, so rewording a label changes no behavior: closed, cancelled, in-progress, needs-you, integrated, stopped,
  // finished or idle.
  function outcome(tasks, attempts, waiting, pending) {
    const decisions = waiting.filter(item => item.requiresDirector),
      progress = tasks
        .filter(task => !task.closed && !['denied', 'cancelled'].includes(task.status))
        .map(task => sourceProgress(task, attempts, pending))
        .filter(Boolean),
      unfinished = progress.filter(item => item.stage.current !== 'integrated');
    if (tasks.every(task => task.closed))
      return {
        state: 'closed',
        tone: 'muted',
        label: 'Closed',
        text: 'All work was closed without taking it further.',
      };
    if (
      !attempts.some(attempt => attempt.acceptedAt) &&
      tasks.every(task => ['denied', 'cancelled'].includes(task.status))
    )
      return { state: 'cancelled', tone: 'muted', label: 'Cancelled', text: 'Cancelled before it produced anything.' };
    if (unfinished.some(item => item.busy))
      return { state: 'in-progress', tone: 'busy', label: 'In progress', text: 'Integration is approved or running.' };
    if (unfinished.length) {
      if (decisions.length)
        return {
          state: 'needs-you',
          tone: 'wait',
          label: 'Needs you',
          text: `${decisions.length} item${decisions.length === 1 ? '' : 's'} waiting for you.`,
        };
      return { state: 'in-progress', tone: 'busy', label: 'In progress', text: `${unfinished[0].label}.` };
    }
    if (progress.length && progress.every(item => item.stage.current === 'integrated'))
      return {
        state: 'integrated',
        tone: 'ok',
        label: 'Integrated',
        text: committed(progress.map(item => item.journal)),
      };
    const integrated = attempts.find(attempt => attempt.sourceIntegration?.state === 'integrated'),
      active =
        tasks.some(task => ['running', 'stopping'].includes(task.status) || (task.queued && task.status === 'ready')) ||
        attempts.some(attempt => attempt.sourceIntegration?.state === 'verifying'),
      stopped = tasks
        .filter(task => task.autonomyNote && ['failed', 'blocked'].includes(task.status) && !task.controllerWait)
        .sort((a, b) => time(b.createdAt) - time(a.createdAt))[0];
    if (integrated)
      return {
        state: 'integrated',
        tone: 'ok',
        label: 'Integrated',
        text: committed(attempts.map(attempt => attempt.sourceIntegration)),
      };
    if (active) return { state: 'in-progress', tone: 'busy', label: 'In progress', text: 'Work is running now.' };
    if (
      stopped &&
      tasks.every(task => ['failed', 'cancelled', 'denied', 'done'].includes(task.status)) &&
      waiting.length &&
      waiting.every(item => item.requiresDirector)
    )
      return { state: 'stopped', tone: 'bad', label: 'Stopped', text: waiting[0].reason };
    if (decisions.length)
      return {
        state: 'needs-you',
        tone: 'wait',
        label: 'Needs you',
        text: `${decisions.length} item${decisions.length === 1 ? '' : 's'} waiting for you.`,
      };
    // Accepted reviews that asked for changes leave nothing waiting; new work from their findings is optional
    // (v1.0 item 17). Any other wait keeps the run in progress.
    if (waiting.length && waiting.every(item => !item.requiresDirector && item.kind === 'review-findings'))
      return {
        state: 'finished',
        tone: 'muted',
        label: 'Finished',
        text: "Ended without integrating because the review asked for changes. If you still want the change, start new work from the review's findings.",
      };
    if (waiting.some(item => !item.requiresDirector))
      return {
        state: 'in-progress',
        tone: 'busy',
        label: 'In progress',
        text: 'The controller is waiting; nothing is needed from you.',
      };
    if (stopped && !['done', 'denied', 'cancelled'].includes(stopped.status))
      return {
        state: 'stopped',
        tone: 'bad',
        label: 'Stopped',
        text: sentence(stopped.autonomyNote).split('. ')[0] + '.',
      };
    if (tasks.every(task => ['done', 'denied', 'cancelled'].includes(task.status)))
      return { state: 'finished', tone: 'muted', label: 'Finished', text: 'Nothing is waiting.' };
    return { state: 'idle', tone: 'muted', label: 'Idle', text: 'Nothing is running and nothing is waiting for you.' };
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
    resumeItems,
    integrationAction,
    directorExplanation,
    needsYouItems,
  });
})();

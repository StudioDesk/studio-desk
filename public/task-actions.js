// The story page's task actions as shared rules: what the director may do about one task now, in the page's order,
// each with the words on its button, the route it is sent to and the body fields that route takes (src/server.mjs's
// task commands). They are the conditions of the story page (dashboard/src/decisions.ts decisionState and
// dashboard/src/task-decisions.tsx TaskDecisions, with the question card's Answer and a command request's Allow
// commands), written once more so the controller can run them too; the page keeps its own until it reads these. Where
// they differ from the page, they say so: a story whose plan the code moved past (sourceStage.outdated) offers Close and
// send as a new idea in place of Start assignment and Allow and continue, and a file request that carries a problem
// offers no Allow and continue; and where the page offers what the controller would refuse, these leave it out: Start
// on held work, Reconcile source integration while that integration runs, and Send back where the review's stage does
// not return the story (after its interrupted integration was reconciled, for one). The page follows in its own story.
// Accept over a failed check… and Resume dispatch are offered as the page offers them. Each action keeps its emphasis
// (primary, default or quiet) and whether it is a closing action, which the page lists behind More actions.
// Nothing here sends anything or reads the page. Loaded after runs.js, whose rules (globalThis.StudioRuns) it reads.
(() => {
  const unsettledStates = ['interrupted', 'quarantined', 'uncertain'];
  const busyJournal = ['verifying', 'preparing', 'prepared', 'applying', 'committing', 'needs-reconciliation'];
  const order = { primary: 0, default: 1, quiet: 2 };
  const rules = () => globalThis.StudioRuns;
  const kindOf = attempt => attempt?.assignment?.kind;
  const active = task => task.status === 'running' || task.status === 'stopping';
  const artifact = (attempt, test) => attempt?.artifacts?.find(test);
  // The checks a result's own report failed, each named once, as the controller's acceptAttempt finds them
  // (task-decisions.tsx failedChecks).
  const failedChecks = attempt => [
    ...new Set((attempt?.result?.checks ?? []).filter(check => check.status === 'fail').map(check => check.name)),
  ];
  // The attempt a task records under the name given, from this project's records (studio-runs.ts recordedAttempt).
  const recordedAttempt = (state, task, id = task.lastAttemptId) =>
    state.attempts.find(
      attempt =>
        attempt.id === id &&
        attempt.taskId === task.id &&
        (!attempt.projectId || attempt.projectId === state.project.id),
    );
  // How the dashboard names an agent (names.ts workerName).
  const workerName = (state, id) =>
    state?.workers?.find(worker => worker.id === id)?.displayName ??
    state?.employeeDirectory?.find(worker => worker.id === id)?.displayName ??
    id ??
    'Unassigned';
  // The story's editor, as the page names it in Send back (story.ts storyPeople).
  const editorName = (task, state) => {
    const stage = task.sourceStage ?? {},
      attempts = state.attempts.filter(attempt => attempt.taskId === task.id),
      find = id => attempts.find(attempt => attempt.id === id),
      builds = attempts.filter(attempt => kindOf(attempt) !== 'studio-development:change-review'),
      latest = find(task.lastAttemptId),
      build = latest && kindOf(latest) !== 'studio-development:change-review' ? latest : builds.at(-1),
      past = !!stage.phase && stage.phase !== 'implementing',
      candidate = past ? find(stage.candidate?.attemptId) : undefined;
    return workerName(state, candidate?.workerId ?? build?.workerId ?? task.workerId);
  };
  // The question the latest attempt stopped to ask while no recorded answer names it (questions.ts waitingQuestion).
  const waitingQuestion = (task, attempts) => {
    if (task.status !== 'blocked' || !task.lastAttemptId) return null;
    const asking = attempts.find(attempt => attempt.id === task.lastAttemptId && attempt.taskId === task.id);
    if (asking?.status !== 'blocked' || !asking.question?.ask) return null;
    const answers = Array.isArray(task.answers) ? task.answers : [];
    return answers.some(answer => answer.attemptId === asking.id) ? null : asking;
  };
  // The attempts a story has used of the ones it may (story.ts attemptsUsed and countsTowardLimit): the count the
  // controller served with the task (its attemptCount, counted as the scheduler counts them before it starts the work),
  // so the actions offered here and the page agree on past-the-limit. A record served without one is counted as
  // before: only an attempt the work itself ended (its endCause), or for a record from before endCause, not one a
  // usage limit stopped, one interrupted by the controller's stop and reconciled, nor one that asked a question.
  const countsTowardLimit = attempt =>
    attempt.endCause?.cause
      ? attempt.endCause.cause === 'work'
      : !attempt.subscriptionHold &&
        !(attempt.status === 'interrupted' && attempt.reconciledAt) &&
        !attempt.question?.ask;
  const attemptsUsed = (task, attempts) => {
    const served = task.attemptCount;
    if (served && Number.isInteger(served.used))
      return {
        used: served.used,
        allowed: served.allowed ?? task.maxAttempts ?? 0,
        limited: served.allowed !== undefined,
      };
    return { ...counted(task, attempts), limited: task.maxAttempts !== undefined };
  };
  const counted = (task, attempts) => ({
    used: attempts.filter(
      attempt =>
        countsTowardLimit(attempt) &&
        (task.stageState
          ? (kindOf(attempt) ?? task.kind) === task.kind
          : kindOf(attempt) !== 'studio-development:change-review'),
    ).length,
    allowed: task.maxAttempts ?? 0,
  });
  // Whether integrating now would be a retry (studio-runs.ts integrationAction: its label says "again").
  const integratesAgain = (task, attempt) =>
    ['rejected', 'abandoned'].includes(attempt.sourceIntegration?.state ?? '') ||
    (task.sourceStage?.phase === 'integration' && task.sourceStage.current === 'failed') ||
    !!(task.sourceStage?.reason || task.reason) ||
    /could not request integration|approve it yourself/i.test(String(task.autonomyNote ?? ''));
  // Which way the controller lets the director send a source story back over its accepted review, as its workflow
  // stage's returnable (src/connectors/source-changes.mjs sourceStoryReturnable, which sendBackWork asks) decides:
  // 'findings' for a review that asked for changes, 'checks' for a passing review whose own checks failed, 'passed'
  // for a passing review whose integration is neither approved nor under way (the story still waits for it outside
  // the integration phase, or its integration stopped), and null otherwise. A passing review's integration journal
  // (`journal`, the review attempt's) must be absent, rejected or abandoned. A passing story whose interrupted
  // integration was reconciled waits for integration in the integration phase, which none of these is, so it is not
  // sent back.
  const returnableAs = (task, journal) => {
    const stage = task.sourceStage,
      review = stage?.review;
    if (
      task.kind !== 'studio-development:change' ||
      task.status !== 'done' ||
      !review ||
      task.acceptedAttemptId !== review.attemptId
    )
      return null;
    if (review.verdict === 'pass') {
      if (journal && !['rejected', 'abandoned'].includes(journal.state ?? '')) return null;
      if (stage.current === 'failed' && stage.phase === 'candidate-review') return 'checks';
      const open = stage.current === 'waiting-for-integration' && stage.phase !== 'integration',
        stopped = stage.current === 'failed' && stage.phase === 'integration';
      return open || stopped ? 'passed' : null;
    }
    // A review that asked for changes goes back once any merge recorded over it is settled as stopped: from a failed
    // stage, or from waiting for integration once that merge was reconciled as stopped before it landed.
    if (review.verdict !== 'needs-work') return null;
    if (journal && !['rejected', 'abandoned'].includes(journal.state ?? '')) return null;
    return stage.current === 'failed' || (journal && stage.current === 'waiting-for-integration') ? 'findings' : null;
  };
  // A source story sent back over its accepted review with the review's findings or failed checks (decisions.ts
  // reviewReturnable), where the controller's own check allows it.
  const reviewReturnable = (task, journal) => ['findings', 'checks'].includes(returnableAs(task, journal) ?? '');
  // The paths a story may change: the director's latest edit, or its brief's path lines (decisions.ts storyPaths).
  const storyPaths = task => {
    const edit = (task.scopeEdits ?? []).at(-1);
    if (edit) return { files: edit.files, newFiles: edit.newFiles, deleteFiles: edit.deleteFiles };
    const line = label =>
      (
        String(task.brief ?? '')
          .split('\n')
          .find(text => text.startsWith(label + ': ')) ?? ''
      )
        .slice(label.length + 2)
        .split(', ')
        .filter(Boolean);
    return { files: line('Files'), newFiles: line('New files'), deleteFiles: line('Delete') };
  };
  // A blocked editor's usable file request, and the paths approving it as asked gives the story (decisions.ts
  // fileRequest). A request that carries a problem is one the controller found it would refuse as asked (the check of
  // a file request, src/connectors/source-changes.mjs), so it is not usable.
  const fileRequest = (task, state) => {
    const latest = state.attempts.find(attempt => attempt.id === task.lastAttemptId),
      edits = task.scopeEdits ?? [],
      scope = latest?.scopeRequest,
      requested =
        task.status === 'blocked' &&
        latest?.status === 'blocked' &&
        kindOf(latest) === 'studio-development:change' &&
        scope &&
        !edits.some(edit => edit.at >= String(latest.finishedAt ?? ''))
          ? latest
          : null,
      request = requested && scope?.reason && !scope.problem ? scope : null,
      current = storyPaths(task),
      join = (one, other) => [...new Set([...(one ?? []), ...(other ?? [])])],
      worked = state.attempts.some(
        attempt =>
          attempt.taskId === task.id &&
          kindOf(attempt) === 'studio-development:change' &&
          attempt.artifacts?.some(item => item.kind === 'source-file' && item.path.startsWith('changes/')),
      );
    return {
      requested,
      request,
      worked,
      offered: {
        files: join(current.files, request?.files),
        newFiles: join(current.newFiles, request?.newFiles),
        deleteFiles: join(current.deleteFiles, request?.deleteFiles),
      },
    };
  };

  // The page's conditions (decisions.ts decisionState), apart from `returnable`, which follows the controller's own
  // check (returnableAs above) rather than the page's.
  function decisionState(task, state) {
    const attempts = state.attempts.filter(attempt => attempt.taskId === task.id),
      live = active(task),
      // The kinds the decisions read (fixed-limit, the two pauses, command-request) are the shared explanation's;
      // the page's own wrapper (studio-runs.ts explain) changes only a finished review's kind, which offers none of them.
      explanation = rules().taskExplanation(task, state),
      progress = rules().sourceProgress(task, state.attempts, state.autonomy?.pendingIntegration),
      latest = recordedAttempt(state, task),
      current = recordedAttempt(
        state,
        task,
        task.status === 'done' ? task.acceptedAttemptId || task.lastAttemptId : task.lastAttemptId,
      ),
      approval = task.approval,
      awaited = rules().awaitedSource(task, id => state.tasks.find(item => item.id === id)),
      closed = !!task.closed;
    const unsettled = attempts.some(attempt => unsettledStates.includes(attempt.status) && !attempt.reconciledAt);
    const closable =
      !live &&
      !closed &&
      attempts.length > 0 &&
      !['denied', 'backlog'].includes(task.status) &&
      !unsettled &&
      (task.status !== 'done' ||
        (!!progress &&
          progress.stage.current !== 'integrated' &&
          !progress.busy &&
          (!progress.journal || ['rejected', 'abandoned'].includes(progress.journal.state ?? ''))));
    const review =
      task.status === 'done' && current?.id === task.acceptedAttemptId
        ? task.kind === 'studio-development:change-review' ||
          (progress && current?.assignment && current.assignment.kind === 'studio-development:change-review')
          ? current
          : undefined
        : undefined;
    const journal = review?.sourceIntegration,
      reviewItem = artifact(review, item => item.kind === 'source-change-review'),
      integrable =
        !!review &&
        (progress
          ? rules().integrationReview(task, state.attempts, state.autonomy?.pendingIntegration, state.tasks)?.id ===
            review.id
          : (!journal || ['rejected', 'abandoned'].includes(journal.state ?? '')) &&
            review.candidateReviewVerdict === 'pass');
    const stage = task.sourceStage,
      returnable = reviewReturnable(task, journal),
      landed = journal?.verification?.landedSince,
      mergeable =
        journal?.state === 'rejected' &&
        stage?.current === 'failed' &&
        (!!journal.verification?.conflicts?.length || !!landed);
    const plan =
        task.kind === 'plan' ? artifact(latest, item => item.path === 'plan.json' && item.kind === 'plan') : undefined,
      proposal =
        state.taskKinds?.[task.kind]?.proposesWork &&
        !task.proposedTaskIds?.length &&
        !task.materializedTaskIds &&
        ['review', 'done'].includes(task.status)
          ? artifact(current, item => ['source-review', 'plan'].includes(item.kind ?? ''))
          : undefined;
    return {
      attempts,
      live,
      explanation,
      latest,
      current,
      approval,
      awaited,
      closed,
      unsettled,
      closable,
      review,
      journal,
      reviewItem,
      integrable,
      stage,
      returnable,
      mergeable,
      plan,
      proposal,
    };
  }

  // A body field: its name, whether the route needs it, what kind of value it is, and the value the page sends
  // from the records when it sends one.
  const field = (name, required, kind, value) => ({ name, required, kind, ...(value === undefined ? {} : { value }) });

  // The actions the story page offers on a task now, in the page's order: the question card's Answer, a command
  // request's Allow commands, the decisions row (primary first, as the page orders it), the closing actions behind
  // More actions, then Bring back to each older line. `reads.bringBack` is the controller's answer to the task's
  // bring-back read (GET /api/tasks/<id>/bring-back), whose lines the page offers; without it, a landed story offers
  // one Bring back whose line is one that read names. Try it, Edit the file list and the page's menu and links are the
  // page's own: they open something rather than ask for one recorded step.
  function taskActions(task, state, reads = {}) {
    const projectId = state.project?.id,
      id = encodeURIComponent(task.id),
      project = field('projectId', true, 'id', projectId),
      {
        attempts,
        live,
        explanation,
        latest,
        current,
        approval,
        awaited,
        closed,
        unsettled,
        closable,
        review,
        journal,
        reviewItem,
        integrable,
        stage,
        returnable,
        mergeable,
        plan,
        proposal,
      } = decisionState(task, state),
      editor = editorName(task, state),
      files = fileRequest(task, state),
      asking = waitingQuestion(task, state.attempts),
      { used, allowed, limited } = attemptsUsed(task, attempts),
      pastLimit = limited && used >= allowed,
      // The code moved past the story's plan (src/connectors/source-changes.mjs noteOutdated): the controller refuses
      // its Start and any edit of its files, and only a new idea carries its work on. Close and send as a new idea takes
      // what Close takes, and a story that never started, as Deny does (src/core/idea-intake.mjs sendStoryAsIdea).
      outdated = task.kind === 'studio-development:change' && !!task.sourceStage?.outdated,
      neverStarted =
        approval?.status === 'approved' &&
        !attempts.length &&
        !['running', 'stopping', 'review', 'done', 'denied', 'backlog'].includes(task.status),
      sendable = outdated && !closed && task.status !== 'denied' && (closable || neverStarted),
      integrationRun = state.runtime?.integrationRun ?? null;
    const step = (route, fields = [], method = 'POST') => ({
      method,
      path: `/api/tasks/${id}/${route}`,
      fields: [project, ...fields],
    });
    const actions = [];
    const offer = (key, label, emphasis, request, closing = false) =>
      actions.push({ key, label, emphasis, closing, ...request });
    const deny = () => step('deny-work', [field('reason', false, 'note')]);
    if (approval?.status === 'pending' && !awaited) {
      offer('approve', 'Approve work', 'primary', step('approve-work'));
      offer('deny-Deny work', 'Deny work', 'default', deny());
    }
    if (awaited) offer('deny-Deny work', 'Deny work', 'default', deny());
    if (approval?.status === 'approved' && !task.lastAttemptId)
      offer('deny-Withdraw approval and deny', 'Withdraw approval and deny', 'default', deny());
    if (!approval && !task.lastAttemptId && ['ready', 'blocked'].includes(task.status))
      offer('deny-Close this step', 'Close this step', 'quiet', deny(), true);
    if (files.request && files.requested && !outdated)
      offer(
        'allow-files',
        'Allow and continue',
        'primary',
        step('edit-scope', [
          field('files', true, 'list', files.offered.files),
          field('newFiles', true, 'list', files.offered.newFiles),
          field('deleteFiles', true, 'list', files.offered.deleteFiles),
          field('reason', true, 'reason', files.request.reason),
          field('keepWork', false, 'boolean', files.worked),
          field('request', false, 'id', files.requested.id),
          field('note', false, 'note'),
        ]),
      );
    if (sendable)
      offer(
        'send-as-idea',
        'Close and send as a new idea',
        'primary',
        step('send-as-idea', [field('idea', false, 'text')]),
      );
    // Start is left out while the task is held (the scheduler refuses held work; Release hold below is offered
    // instead), and while a story records that the source moved past its plan (outdated above: Close and send as a new
    // idea is offered instead).
    if (
      !live &&
      !closed &&
      !unsettled &&
      !task.hold &&
      !outdated &&
      explanation.kind !== 'fixed-limit' &&
      ['ready', 'blocked', 'failed', 'cancelled'].includes(task.status)
    )
      // Past its attempt limit, the page asks for a note for the next attempt, sent as its direction.
      offer(
        pastLimit ? 'start-past-limit' : 'start',
        'Start assignment',
        approval?.status === 'pending' || files.request || asking ? 'default' : 'primary',
        step('start', [field('direction', false, 'note')]),
      );
    if (task.hold && !live && !closed && !['done', 'denied'].includes(task.status))
      offer('hold', 'Release hold', 'default', {
        method: 'PATCH',
        path: `/api/tasks/${id}`,
        fields: [project, field('hold', true, 'boolean', false)],
      });
    // Resume dispatch is the studio's own switch, not a task's: it turns dispatch back on for every project.
    if (explanation.kind === 'dispatch-paused')
      offer('dispatch', 'Resume dispatch', 'default', {
        method: 'POST',
        path: '/api/control',
        fields: [field('paused', true, 'boolean', false)],
      });
    if (explanation.kind === 'pipeline-paused')
      offer('pipeline', 'Resume pipeline', 'default', {
        method: 'POST',
        path: '/api/pipeline',
        fields: [project, field('action', true, 'text', 'resume')],
      });
    if (live) offer('cancel', 'Request cancellation', 'default', step('cancel'));
    if (task.status === 'review' && latest) {
      if (plan)
        offer(
          'accept',
          'Accept planning result',
          'primary',
          step('accept-proposal', [
            field('attemptId', true, 'id', latest.id),
            field('proposalHash', true, 'hash', plan.hash),
          ]),
        );
      else {
        // A result whose own checks failed is accepted over them with the director's reason, as the controller
        // requires, unless its task type accepts failed checks plainly. A type whose step contract takes no acceptance
        // over a failed check keeps the plain Accept (task-decisions.tsx). The type is the one the attempt ran as.
        const type = state.taskKinds?.[kindOf(latest) ?? task.kind],
          over = failedChecks(latest).length > 0 && !type?.acceptsFailedChecks && type?.acceptOver !== false;
        if (over)
          offer(
            'accept',
            'Accept over a failed check…',
            'primary',
            step('accept', [field('overReason', true, 'reason')]),
          );
        // A reason accepts it over a failed check, where the step's contract allows it.
        else offer('accept', 'Accept result', 'primary', step('accept', [field('overReason', false, 'reason')]));
      }
      if (task.kind !== 'unreal-integration')
        offer('revise', 'Request revision', 'default', step('revise', [field('direction', true, 'note')]));
    }
    if (unsettled) offer('reconcile', 'Reconcile interrupted attempt', 'primary', step('reconcile'));
    // An uncertain integration is reconciled once the controller's own integration run is no longer it
    // (runtime.integrationRun, the journal ID of the integration running now): reconciling refuses a running one.
    if (journal?.state && busyJournal.includes(journal.state) && !(journal.id && journal.id === integrationRun))
      offer('restore', 'Reconcile source integration', 'default', step('restore-source'));
    if (integrable && review && reviewItem)
      offer(
        'integrate',
        integratesAgain(task, review) ? 'Integrate again' : 'Integrate',
        mergeable ? 'default' : 'primary',
        step('integrate-source', [
          field('attemptId', true, 'id', review.id),
          field('reviewHash', true, 'hash', reviewItem.hash),
          field('overrideReason', false, 'reason'),
        ]),
      );
    if (mergeable) offer('merge', 'Merge onto the current source', 'primary', step('merge-source'));
    const carry = review?.sourceCarries?.find(item => !['carried', 'skipped'].includes(item.state));
    if (
      carry &&
      (['rejected', 'needs-reconciliation'].includes(carry.state) || (carry.state === 'waiting' && !carry.approved))
    ) {
      const again = carry.state === 'waiting' ? '' : ' again';
      offer(
        'carry',
        carry.back ? `Bring back to ${carry.line}${again}` : `Carry to ${carry.line}${again}`,
        'primary',
        step('carry', [field('line', true, 'text', carry.line)]),
      );
    }
    if (carry && ['waiting', 'rejected'].includes(carry.state))
      offer(
        'carry-skip',
        `Not needed on ${carry.line}…`,
        'default',
        step('carry-skip', [field('line', true, 'text', carry.line), field('reason', true, 'reason')]),
      );
    const backable = bringBackable(task, state);
    // A review that passed may be overruled; the director's note is needed only when the review noted nothing.
    const passNotes = review?.candidateReviewNotes?.length ?? 0;
    // Only where the controller's own check sends a passing review back (returnableAs: not, for example, once an
    // interrupted integration was reconciled and the story waits in the integration phase).
    if (integrable && stage?.review?.verdict === 'pass' && returnableAs(task, journal) === 'passed')
      offer(
        'send-back-passed',
        `Send back to ${editor}`,
        'default',
        step('send-back', [field('note', !passNotes, 'note')]),
      );
    if (returnable && stage?.review) {
      offer('send-back', `Send back to ${editor}`, 'primary', step('send-back', [field('note', false, 'note')]));
      offer(
        'over',
        'Integrate over the review',
        'default',
        step('integrate-source', [
          field('attemptId', true, 'id', stage.review.attemptId),
          field('reviewHash', true, 'hash', stage.review.hash),
          field('overrideReason', true, 'reason'),
        ]),
      );
    }
    if (proposal && current)
      offer(
        'propose',
        'Show proposed tasks in Planned',
        'default',
        step('propose-work', [
          field('attemptId', true, 'id', current.id),
          field('proposalHash', true, 'hash', proposal.hash),
        ]),
      );
    if (closable)
      offer(
        'close',
        task.status === 'done'
          ? 'Close without integrating'
          : task.status === 'review'
            ? 'Close without accepting'
            : 'Close',
        'quiet',
        step('close', [field('reason', false, 'reason')]),
        true,
      );
    // The decisions keep their row, primary first; the closing actions follow, as the More actions menu lists them.
    const row = actions.filter(action => !action.closing).sort((a, b) => order[a.emphasis] - order[b.emphasis]),
      closing = actions.filter(action => action.closing);
    const before = [];
    // The question card above "Where it stands" answers the question, and a command request's form allows them.
    if (asking)
      before.push({
        key: 'answer',
        label: `Send to ${workerName(state, asking.workerId ?? task.workerId)}`,
        emphasis: 'primary',
        closing: false,
        ...step('answer', [
          field('attemptId', true, 'id', asking.id),
          field('option', false, 'number'),
          field('text', false, 'text'),
          field('autoMode', false, 'boolean'),
        ]),
      });
    if (explanation.kind === 'command-request')
      before.push({
        key: 'allow-commands',
        label: 'Allow commands',
        emphasis: 'primary',
        closing: false,
        ...step('allow-commands', [
          field('attemptId', true, 'id', explanation.attemptId),
          field('commands', true, 'list', explanation.commands ?? []),
        ]),
      });
    const after = [];
    if (backable) {
      const lines = reads.bringBack?.lines;
      if (Array.isArray(lines))
        lines
          .filter(target => 'through' in target)
          .forEach(target =>
            after.push({
              key: `bring-back-${target.line}`,
              label: `Bring back to ${target.line}`,
              emphasis: 'default',
              closing: false,
              ...step('bring-back', [field('line', true, 'text', target.line)]),
            }),
          );
      else
        after.push({
          key: 'bring-back',
          label: 'Bring back',
          emphasis: 'default',
          closing: false,
          ...step('bring-back', [field('line', true, 'text')]),
        });
    }
    return [...before, ...row, ...closing, ...after];
  }

  // Whether the task is a source story that landed, whose page offers Bring back to each older line it can go back to
  // (the bring-back read, GET /api/tasks/<id>/bring-back, names them): a story, not a carry, whose accepted review's
  // integration landed.
  function bringBackable(task, state) {
    const journal = decisionState(task, state).journal;
    return task.kind === 'studio-development:change' && !task.carryOf && journal?.state === 'integrated';
  }

  globalThis.StudioTaskActions = Object.freeze({ taskActions, bringBackable });
})();

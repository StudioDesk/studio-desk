// Dashboard reads are an allowlisted projection of attempt data, never of an
// attempt expanded with its immutable instruction snapshot. Detail APIs/export
// retain the complete records. Keep this contract aligned with board previews,
// StudioRuns (including integrationReview), and task decision controls.
const fields = (value, names) =>
  Object.fromEntries(names.filter(name => value?.[name] !== undefined).map(name => [name, value[name]]));
const references = value => (value || []).map(item => fields(item, ['path', 'kind', 'hash']));
const checks = value => (value || []).map(item => fields(item, ['name', 'status', 'evidence']));
const decision = value => fields(value, ['type', 'at', 'reason', 'revision']);
const shortText = (value, limit = 300) =>
  typeof value === 'string'
    ? value.slice(0, limit)
    : value === null || ['boolean', 'number', 'undefined'].includes(typeof value)
      ? value
      : null;
const failedNames = value =>
  (Array.isArray(value) ? value : []).slice(0, 20).map(item => ({
    name: shortText(item.name),
    file: shortText(item.file),
  }));
const totals = value =>
  value === null ? null : fields(value, ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']);
function testEvidence(value) {
  const result = fields(value, ['tapDurationMs']);
  if (value?.totals !== undefined) result.totals = totals(value.totals);
  if (value?.failedTests) result.failedTests = failedNames(value.failedTests);
  return result;
}
function stopContext(value) {
  const result = fields(value, [
    'reason',
    'timedOut',
    'requestedAt',
    'taskKind',
    'stage',
    'activity',
    'phaseId',
    'occurrenceId',
    'phaseFinished',
  ]);
  for (const key of Object.keys(result)) result[key] = shortText(result[key]);
  if (value.testEvidence) result.testEvidence = testEvidence(value.testEvidence);
  return result;
}
// The work an attempt continued from, or why it started fresh: a general work attempt's
// continueFrom or a code story's sourceChange.continueFrom. Paths without their hashes, at
// most the 30 files a work result may return, with the rest counted; a code story's skipped
// paths are left out, and the paths its fresh start names join the reason as in freshStartText.
function continuation(value) {
  const files = Array.isArray(value.files) ? value.files : [],
    result = {
      attemptId: shortText(value.attemptId),
      files: files.slice(0, 30).map(item => ({ path: shortText(item?.path) })),
    };
  if (files.length > 30) result.filesOmitted = files.length - 30;
  if (value.fresh) {
    const paths = Array.isArray(value.fresh.paths) && value.fresh.paths.length ? value.fresh.paths : null;
    result.fresh = {
      reason: shortText(paths ? `${value.fresh.reason} (${paths.join(', ')})` : value.fresh.reason, 1000),
    };
  }
  return result;
}

export function dashboardAttempt(data, timing, openPhase = null) {
  const summary = fields(data, [
    'id',
    'projectId',
    'taskId',
    'workerId',
    'provider',
    'requestedModel',
    'reportedModel',
    'requestedEffort',
    'requestedTier',
    'sessionId',
    'status',
    'startedAt',
    'finishedAt',
    'acceptedAt',
    'reconciledAt',
    'error',
    'subscriptionHold',
    'subscriptionReset',
    'reviewVerdict',
    'candidateReviewVerdict',
    'candidateReviewFindings',
    'candidateReviewNotes',
    // Other work's independent review, so its verdict reads as it ended rather than as a pass.
    'workReviewVerdict',
    'workReviewFindings',
    'workReviewNotes',
  ]);
  summary.artifacts = references(data.artifacts);
  if (data.assignment) {
    summary.assignment = fields(data.assignment, ['kind', 'stage']);
    if (data.assignment.stageState) summary.assignment.stageState = fields(data.assignment.stageState, ['current']);
    if (data.assignment.sourceStage)
      summary.assignment.sourceStage = fields(data.assignment.sourceStage, ['current', 'phase']);
  }
  if (data.configuration) {
    // Its mode, the CLI that ran (a code editor's attempt is recorded under its wrapping adapter) and where a
    // candidate's tests ran, for the story page (v1.0 item 23).
    summary.configuration = fields(data.configuration, ['mode', 'provider', 'testSandbox']);
    // What a Claude employee ran with (v1.0 item 22): its permission mode and the approved commands.
    if (data.configuration.permissions)
      summary.configuration.permissions = fields(data.configuration.permissions, ['mode', 'autoFrom', 'commands']);
  }
  if (data.result) {
    summary.result = fields(data.result, ['outcome', 'summary', 'issues']);
    summary.result.checks = checks(data.result.checks);
  }
  if (data.controllerChecks) summary.controllerChecks = checks(data.controllerChecks);
  if (data.failedTests) summary.failedTests = failedNames(data.failedTests);
  if (data.testEvidence) summary.testEvidence = testEvidence(data.testEvidence);
  if (data.stopContext) summary.stopContext = stopContext(data.stopContext);
  const continued = data.continueFrom || data.sourceChange?.continueFrom;
  if (continued) summary.continueFrom = continuation(continued);
  if (data.acceptedBy) summary.acceptedBy = decision(data.acceptedBy);
  if (data.revisionRequestedBy) summary.revisionRequestedBy = decision(data.revisionRequestedBy);
  // Input bodies/summaries are duplicated elsewhere. These identities are needed
  // by reviewed-input previews and the current-candidate integration action.
  if (data.inputReferences)
    summary.inputReferences = data.inputReferences.map(input => ({
      ...fields(input, ['taskId', 'attemptId']),
      artifacts: references(input.artifacts),
    }));
  if (data.candidateReview)
    summary.candidateReview = fields(data.candidateReview, [
      'taskId',
      'attemptId',
      'path',
      'hash',
      'candidateHash',
      'passed',
    ]);
  if (data.sourceCandidate) summary.sourceCandidate = fields(data.sourceCandidate, ['sourceHash', 'diffStat']);
  if (data.commandDenials)
    summary.commandDenials = data.commandDenials.map(denial => fields(denial, ['tool', 'command', 'reason']));
  if (data.scopeRequest)
    summary.scopeRequest = fields(data.scopeRequest, ['files', 'newFiles', 'deleteFiles', 'reason', 'problem']);
  if (data.plan) summary.plan = { tasks: (data.plan.tasks || []).map(task => fields(task, ['title'])) };
  if (data.integration) summary.integration = fields(data.integration, ['state']);
  if (data.sourceIntegration) {
    const journal = data.sourceIntegration;
    summary.sourceIntegration = fields(journal, [
      'id',
      'state',
      'method',
      'reviewTaskId',
      'reviewAttemptId',
      'phaseOccurrenceId',
      'startedAt',
      'finishedAt',
      'error',
    ]);
    if (journal.approvedBy) summary.sourceIntegration.approvedBy = decision(journal.approvedBy);
    if (journal.repository) summary.sourceIntegration.repository = fields(journal.repository, ['commit', 'branch']);
    if (journal.verification) {
      const verification = journal.verification;
      summary.sourceIntegration.verification = {
        ...fields(verification, [
          'passed',
          'phaseId',
          'timedOut',
          'exitCode',
          'signal',
          'startedAt',
          'finishedAt',
          'fixture',
        ]),
        ...testEvidence(verification),
        ...(verification.error ? { error: shortText(verification.error, 1000) } : {}),
        ...(verification.checks
          ? {
              checks: verification.checks.slice(0, 20).map(item => ({
                name: shortText(item.name),
                status: item.status,
                evidence: shortText(item.evidence, 1000),
              })),
            }
          : {}),
      };
    }
  }
  summary.executionTiming = executionTiming(data, timing || []);
  // While the attempt works, Today shows its latest message and what it is doing (v1.0 items 21 and 23); a
  // finished attempt carries neither, so the state does not grow with history.
  if (['running', 'stopping'].includes(data.status)) {
    if (data.lastSay) summary.lastSay = { text: shortText(data.lastSay.text, 280), at: shortText(data.lastSay.at, 40) };
    summary.openPhase = openPhase;
  }
  return summary;
}

// A phase row the attempt recorded about itself, by attemptPhases' ownership rules in the browser.
const ownPhase = row =>
  row.schemaVersion === 'source-phase-v1' &&
  row.attemptId === row.attempt_id &&
  row.taskId === row.task_id &&
  !!row.occurrenceId &&
  ['start', 'finish'].includes(row.boundary);
// The query supplies the enclosing execution observations, without phase detail bodies, and a working
// attempt's inner phases, which only dashboardOpenPhases reads. Apply the same ownership and occurrence rules
// as attemptPhases in the browser; nested phases and later integration must never inflate execution time.
export function dashboardTimings(rows) {
  const attempts = new Map();
  for (const row of rows) {
    if (!ownPhase(row) || (row.phaseId ?? 'attempt') !== 'attempt') continue;
    const owner = JSON.stringify([row.attemptId, row.taskId]);
    if (!attempts.has(owner)) attempts.set(owner, new Map());
    const occurrences = attempts.get(owner),
      key = JSON.stringify([row.occurrenceId, row.integrationOccurrenceId]);
    if (!occurrences.has(key)) occurrences.set(key, {});
    occurrences.get(key)[row.boundary] = row;
  }
  return new Map([...attempts].map(([owner, occurrences]) => [owner, [...occurrences.values()]]));
}

// A working attempt's innermost open phase ('test' inside 'source.edit' inside 'attempt'): the latest start
// among its phases with no finish, by attemptPhases' ownership and occurrence rules; none once the attempt phase
// has finished. Integration phases run after a review attempt finishes, never while it works.
export function dashboardOpenPhases(rows) {
  const attempts = new Map();
  for (const row of rows) {
    if (!ownPhase(row) || !row.phaseId || row.phaseId.startsWith('integration.')) continue;
    const owner = JSON.stringify([row.attemptId, row.taskId]);
    if (!attempts.has(owner)) attempts.set(owner, new Map());
    const occurrences = attempts.get(owner),
      key = JSON.stringify([row.occurrenceId, row.phaseId, row.integrationOccurrenceId]);
    if (!occurrences.has(key)) occurrences.set(key, { phaseId: row.phaseId });
    occurrences.get(key)[row.boundary] = row;
  }
  const open = new Map();
  for (const [owner, occurrences] of attempts) {
    const phases = [...occurrences.values()];
    if (phases.some(phase => phase.phaseId === 'attempt' && phase.finish)) continue;
    const inner = phases
      .filter(phase => phase.start && !phase.finish)
      .reduce((latest, phase) => (!latest || phase.start.timestamp >= latest.start.timestamp ? phase : latest), null);
    if (inner) open.set(owner, inner.phaseId);
  }
  return open;
}

function executionTiming(attempt, phases) {
  const terminal = phases.find(phase => phase.finish),
    timestamp = value => (value ? Date.parse(value) : NaN),
    between = (start, finish) => {
      const duration = timestamp(finish) - timestamp(start);
      return Number.isFinite(duration) && duration >= 0 ? duration : null;
    };
  let durationMs = null;
  if (terminal) {
    const measured = terminal.finish.durationMs;
    durationMs =
      Number.isFinite(measured) && measured >= 0
        ? measured
        : between(terminal.start?.timestamp, terminal.finish.timestamp);
  }
  durationMs ??= between(attempt.startedAt, attempt.finishedAt);
  return {
    durationMs,
    activeStart:
      !terminal && !attempt.finishedAt && ['running', 'stopping'].includes(attempt.status)
        ? phases.find(phase => phase.start)?.start.timestamp || attempt.startedAt || null
        : null,
    completionUnconfirmed: !!terminal?.finish.timing,
  };
}

// Carrying a fix forward (1.1 step 4, Decision MP-028). A fix integrated on an older release line is applied to each
// newer maintained line in order, each from the commit the line before it got: in its own worktree with git
// cherry-pick, as integration applies a candidate, formatted and tested with that line's tests, committed with the
// commit it came from named, and the line moved as integration moves it. Carries run one at a time with integrations
// and hold the project's source resources while they run.
//
// A carry is approved as integration is: by the policy when it integrates after a passing review, otherwise by the
// director, who can also mark a line Not needed. A carry git applies cleanly needs no review, since the change was
// reviewed. One that conflicts becomes a carry story on its line: the fix merged onto that line for its editor to
// resolve (step 3), reviewed and integrated, after which the chain continues from its commit. Each fix is carried as
// its own commit rather than by merging the older line, so a conflicted carry resolved by an agent is never carried
// again.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { commitIntegration, integrationTrailer, statusPaths, verifyIntegration } from './source-integration.mjs';
import { testsSentence } from './source-checks.mjs';
import { removeSourceWorktree, createSourceWorktree, sourceWorktreeRoot, worktreeName } from './source-worktrees.mjs';
import { lineReached, lineRepository, moveLine, projectLines } from './source-lines.mjs';
import { sourceResources } from './source-projects.mjs';
import { profileOf } from './source-profile.mjs';
import { jobDirectory, recordProject } from '../core/projects.mjs';
import { expandRun, runIdOf } from '../core/graph.mjs';

const settled = ['carried', 'skipped'];

// The newer maintained lines after a line, in order.
export function newerLines(store, projectId, line) {
  const lines = projectLines(store.project(projectId)),
    at = lines.findIndex(item => item.branch === line);
  return at < 0
    ? []
    : lines
        .slice(at + 1)
        .filter(item => item.state === 'maintained')
        .map(item => item.branch);
}
// The review attempt whose integration a story's carries follow.
export function carryReview(store, story) {
  const review = story.sourceStage?.review && store.attempt(story.sourceStage.review.attemptId);
  if (review?.sourceIntegration?.state !== 'integrated' || !review.sourceCarries?.length)
    throw new Error('This story has no fix to carry forward.');
  return review;
}
// The carry whose turn it is: the first neither carried nor skipped.
export const nextCarry = review => (review.sourceCarries || []).find(carry => !settled.includes(carry.state));
// What a carry applies: the commit the line before it got, or the fix's own integration.
function carryFrom(review, carry) {
  const before = review.sourceCarries
    .slice(0, review.sourceCarries.indexOf(carry))
    .filter(item => item.state === 'carried')
    .at(-1);
  return before
    ? { commit: before.commit, line: before.line }
    : { commit: review.sourceIntegration.commit, line: review.sourceIntegration.repository.branch };
}

// Called when a story integrates: the carries its fix needs, each waiting for approval. A carry story's integration
// continues the chain of the story it carries instead.
export function planCarries(store, story, reviewId, journal) {
  if (story.carryOf) return carryStoryIntegrated(store, story, journal);
  const projectId = recordProject(story),
    lines = newerLines(store, projectId, journal.repository.branch);
  if (!lines.length) return;
  const review = store.attempt(reviewId);
  review.sourceCarries = lines.map((line, index) => ({
    id: `source-carry:${review.id}:${index}`,
    line,
    state: 'waiting',
  }));
  store.updateAttempt(review);
  store.event(
    'carry_planned',
    story.id,
    review.id,
    `The fix is to be carried forward to ${lines.join(', then ')}.`,
    projectId,
  );
}
// A carry story integrated on its line: the carry it stood for is done with its commit, and the chain goes on.
function carryStoryIntegrated(store, story, journal) {
  const review = store.attempt(story.carryOf.reviewAttemptId),
    carry = review.sourceCarries?.find(item => item.id === story.carryOf.carryId);
  if (!carry || carry.state === 'carried') return;
  Object.assign(carry, { state: 'carried', commit: journal.commit, finishedAt: new Date().toISOString() });
  store.updateAttempt(review);
  store.event(
    'carry_done',
    story.carryOf.storyId,
    review.id,
    `Carried the fix to ${carry.line} through ${story.id}, whose editor resolved the conflicts, as commit ${journal.commit.slice(0, 7)}.`,
    recordProject(story),
  );
}

const turn = (store, story, line) => {
  const review = carryReview(store, story),
    carry = nextCarry(review);
  if (!carry) throw new Error('This fix has been carried to every newer line.');
  if (line !== undefined && carry.line !== line) throw new Error(`The next carry of this fix is to ${carry.line}.`);
  return { review, carry };
};
// Approves the next carry, or approves it again after it stopped. Stopped part-way on the checked-out branch, it needs
// the folder's changed files restored first.
export function approveCarry(store, story, line, by = { type: 'director' }) {
  return store.tx(() => {
    const { review, carry } = turn(store, story, line);
    if (!['waiting', 'rejected', 'needs-reconciliation'].includes(carry.state))
      throw new Error(
        `The carry to ${carry.line} is ${carry.state === 'merging' ? `a story of its own, ${carry.storyId}` : carry.state}.`,
      );
    if (carry.state === 'needs-reconciliation') {
      const edited = statusPaths(
        review.sourceIntegration.root,
        (carry.changes || []).map(item => item.path),
      );
      if (edited.length)
        throw new Error(`Restore or commit ${edited.join(', ')} in the project's folder, then carry the fix again.`);
    }
    if (carry.state !== 'waiting')
      carry.previous = { state: carry.state, error: carry.error, finishedAt: carry.finishedAt };
    Object.assign(carry, { state: 'waiting', approvedBy: by, approvedAt: new Date().toISOString() });
    delete carry.error;
    store.updateAttempt(review);
    return structuredClone(carry);
  });
}
// Not needed on <line>: the next carry is skipped with the director's reason, and the chain goes on.
export function skipCarry(store, story, line, reason, by = { type: 'director' }) {
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 2000)
    throw new Error('Say why the fix is not needed there, in at most 2000 characters.');
  return store.tx(() => {
    const { review, carry } = turn(store, story, line);
    if (!['waiting', 'rejected'].includes(carry.state))
      throw new Error(
        `The carry to ${carry.line} is ${carry.state === 'merging' ? `a story of its own, ${carry.storyId}; close it first` : carry.state}.`,
      );
    Object.assign(carry, {
      state: 'skipped',
      reason: reason.trim(),
      skippedBy: by,
      finishedAt: new Date().toISOString(),
    });
    store.updateAttempt(review);
    store.event(
      'carry_skipped',
      story.id,
      review.id,
      `Not needed on ${carry.line}: ${reason.trim()}`,
      recordProject(story),
    );
    return structuredClone(carry);
  });
}

// Starts the next approved carry of a story. Refused (busy) while an integration or carry runs or the project's source
// is held, so the caller tries again when they settle.
export function runCarry(runtime, story, onSettled = () => {}) {
  const store = runtime.store,
    projectId = recordProject(story),
    review = carryReview(store, story),
    carry = nextCarry(review);
  if (carry?.state !== 'waiting' || !carry.approvedBy) throw new Error('No approved carry is waiting.');
  const resources = sourceResources(store, story);
  if (runtime.sourceIntegrationRun || store.leases().some(lease => resources.includes(lease.resource)))
    throw Object.assign(new Error('The project’s source is busy; the carry starts when it is free.'), { busy: true });
  const integration = review.sourceIntegration,
    root = integration.root,
    from = carryFrom(review, carry),
    repository = lineRepository(root, carry.line),
    index = review.sourceCarries.indexOf(carry);
  if (runtime.selfHosted && root === runtime.sourceChangeRoot && repository.live !== false)
    throw new Error(`${carry.line} is the branch this controller runs from; carry the fix to it by hand.`);
  Object.assign(carry, {
    state: 'verifying',
    phaseOccurrenceId: randomUUID(),
    reviewAttemptId: review.id,
    reviewTaskId: review.taskId,
    candidateAttemptId: integration.candidateAttemptId,
    root,
    fromLine: from.line,
    fromCommit: from.commit,
    candidateCommit: from.commit,
    changes: integration.changes,
    repository,
    worktree: path.join(sourceWorktreeRoot(runtime), `c-${worktreeName(review.id)}-${index}`),
    startedAt: new Date().toISOString(),
  });
  store.tx(() => {
    store.claim(resources, carry.id);
    store.updateAttempt(review);
  });
  store.event(
    'carry_verifying',
    story.id,
    review.id,
    `Carrying the fix from ${from.line} (${from.commit.slice(0, 7)}) to ${carry.line} at ${repository.head.slice(0, 7)} in its own worktree, then formatting and testing it there; ${carry.line} is unchanged until it passes.`,
    projectId,
  );
  const promise = finishCarry(runtime, story, review.id, carry.id)
    .catch(error => {
      const current = store.attempt(review.id),
        journal = current.sourceCarries.find(item => item.id === carry.id);
      Object.assign(journal, { state: 'needs-reconciliation', error: error.message });
      store.updateAttempt(current);
      return structuredClone(journal);
    })
    .then(result => {
      if (runtime.sourceIntegrationRun?.id === carry.id) runtime.sourceIntegrationRun = null;
      if (!runtime.closing) onSettled(result);
      return result;
    });
  runtime.sourceIntegrationRun = { id: carry.id, promise };
  return structuredClone(carry);
}

function carryMessage(store, story, journal) {
  const { totals, formatter, fixture } = journal.verification,
    by = journal.approvedBy;
  return [
    `Carry “${story.title}” to ${journal.line}`,
    '',
    `Carried by Studio desk from ${journal.fromLine} (cherry picked from commit ${journal.fromCommit}), ${
      by.type === 'policy' ? `approved by autonomy policy revision ${by.revision}` : 'approved by the director'
    }.`,
    formatter === 'none'
      ? `Verification: no formatter in the source profile; ${testsSentence(totals)} on ${journal.line}${fixture ? ' (protocol fixture)' : ''}.`
      : `Verification: ${formatter} on changed files; ${testsSentence(totals)} on ${journal.line}${fixture ? ' (protocol fixture)' : ''}.`,
    '',
    integrationTrailer(journal),
    '',
  ].join('\n');
}

async function finishCarry(runtime, story, reviewId, carryId) {
  const store = runtime.store,
    projectId = recordProject(story),
    review = store.attempt(reviewId),
    journal = review.sourceCarries.find(item => item.id === carryId),
    index = review.sourceCarries.indexOf(journal),
    root = journal.root,
    candidate = store.attempt(journal.candidateAttemptId),
    profile = profileOf(candidate.sourceCandidate),
    directory = path.join(jobDirectory(store, review), `carry-${index}`);
  const close = (state, fields = {}) => {
      Object.assign(journal, fields, { state, finishedAt: new Date().toISOString() });
      store.tx(() => {
        store.updateAttempt(review);
        store.release(journal.id);
      });
      return structuredClone(journal);
    },
    discard = () => {
      try {
        removeSourceWorktree(root, journal.worktree);
      } catch {}
    };
  let verification;
  try {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });
    if (fs.existsSync(journal.worktree)) removeSourceWorktree(root, journal.worktree);
    createSourceWorktree(
      root,
      path.dirname(journal.worktree),
      path.basename(journal.worktree),
      journal.repository.head,
      profile,
    );
    verification = await verifyIntegration(runtime, journal, directory, candidate.configuration, profile);
  } catch (error) {
    verification = { passed: false, error: error.message };
  }
  // A shutdown stops verification; the controller's next start reconciles the carry.
  if (runtime.closing) return structuredClone(journal);
  journal.verification = verification;
  if (!verification.passed) {
    discard();
    if (verification.conflicts?.length) return conflictedCarry(runtime, story, review, journal, close);
    const reason =
      verification.error ||
      (verification.totals
        ? `${verification.totals.pass}/${verification.totals.tests} tests passed on ${journal.line}.`
        : 'The test run did not report complete totals.');
    const result = close('rejected', { error: reason });
    store.event(
      'carry_rejected',
      story.id,
      review.id,
      `The carry to ${journal.line} stopped before changing it: ${reason}`,
      projectId,
    );
    return result;
  }
  try {
    journal.commit = commitIntegration(
      journal.worktree,
      journal.changes.map(item => item.path),
      carryMessage(store, story, journal),
      directory,
    );
  } catch (error) {
    discard();
    return close('rejected', { error: error.message });
  }
  // From here the line may move, so an interruption is reconciled from git history.
  journal.state = 'committing';
  store.updateAttempt(review);
  try {
    moveLine(root, journal);
    if (!lineReached(root, journal))
      throw Object.assign(new Error(`${journal.line} did not reach the carried commit.`), { partial: true });
  } catch (error) {
    if (error.partial) {
      Object.assign(journal, { state: 'needs-reconciliation', error: error.message });
      store.updateAttempt(review);
      return structuredClone(journal);
    }
    discard();
    return close('rejected', { error: error.message });
  }
  const result = close('carried');
  discard();
  store.event(
    'carry_done',
    story.id,
    review.id,
    `Carried the fix to ${journal.line} as commit ${journal.commit.slice(0, 7)}, applied from ${journal.fromLine}, formatted and tested.`,
    projectId,
  );
  return result;
}

// A carry git could not apply cleanly becomes a carry story on its line: the fix merged onto that line for its editor
// to resolve the marked parts (step 3), then its tests, an independent review and integration onto that line.
function conflictedCarry(runtime, story, review, journal, close) {
  const store = runtime.store,
    conflicts = journal.verification.conflicts,
    id = 'T-' + randomUUID().slice(0, 8),
    at = new Date().toISOString(),
    {
      id: original,
      lastAttemptId,
      acceptedAttemptId,
      sourceStage,
      reason,
      autonomyNote,
      release,
      closed,
      movedTo,
      releasesRouted,
      runReference,
      workflowReference,
      ...rest
    } = store.task(story.id);
  const carried = {
    ...rest,
    id,
    title: `Carry to ${journal.line}: ${story.title}`.slice(0, 160),
    status: 'ready',
    queued: false,
    reason: '',
    approval: { ...story.approval, status: 'approved', decidedAt: at, by: journal.approvedBy },
    // The line the carry story works on, in place of its checks' (src/connectors/source-lines.mjs).
    release: { line: journal.line, by: { type: 'carry', storyId: original }, at },
    carryOf: {
      storyId: original,
      reviewAttemptId: review.id,
      carryId: journal.id,
      line: journal.line,
      fromCommit: journal.fromCommit,
    },
    direction: `Carry the fix of ${original} (“${story.title}”), already reviewed and integrated on ${journal.fromLine}, to ${journal.line}. Git could not apply it there cleanly: the files under changes/ hold it merged onto ${journal.line}, and ${conflicts.join(', ')} hold conflict markers between ${journal.line} (<<<<<<<) and the fix (>>>>>>>). Resolve each conflict so the fix works on ${journal.line}, remove every marker, and keep the rest of the change. Its tests and an independent review follow.`,
  };
  expandRun(store, runIdOf(story), {
    reason: `Carry ${original} to ${journal.line}, whose editor resolves the conflicts.`,
    source: original,
    tasks: [carried],
  });
  runtime.putTask(carried);
  const saved = store.task(id);
  Object.assign(saved.sourceStage, {
    merge: {
      candidateAttemptId: journal.candidateAttemptId,
      candidateCommit: journal.fromCommit,
      files: journal.changes.filter(item => item.afterHash !== null).map(item => item.path),
      conflicts: [...conflicts],
      at,
      by: journal.approvedBy,
    },
    merges: 1,
  });
  store.putTask(saved);
  const result = close('merging', { storyId: id, error: journal.verification.error });
  store.event(
    'carry_merging',
    original,
    review.id,
    `The fix conflicts with ${journal.line} in ${conflicts.join(', ')}; ${id} carries it there, its editor resolving the conflicts, then its tests and an independent review.`,
    recordProject(story),
  );
  return result;
}

// Carries the controller's stop cut off: verification never writes the line, so the carry waits again with its
// approval; one that was moving the line is carried if the line reached its commit, waits again when the line is not
// checked out (its move is one compare-and-swap), and otherwise needs the director.
export function interruptedCarries(runtime) {
  const store = runtime.store;
  for (const review of store.allAttempts()) {
    let changed = false;
    for (const carry of review.sourceCarries || []) {
      if (!['verifying', 'committing'].includes(carry.state)) continue;
      changed = true;
      store.release(carry.id);
      const was = carry.state;
      if (was === 'committing' && carry.commit && lineReached(carry.root, carry)) carry.state = 'carried';
      else if (was === 'verifying' || carry.repository?.live === false) carry.state = 'waiting';
      else
        Object.assign(carry, {
          state: 'needs-reconciliation',
          error: 'The controller stopped while this carry moved its line.',
        });
      carry.interrupted = was;
      store.event(
        'carry_interrupted',
        review.taskId,
        review.id,
        carry.state === 'carried'
          ? `Reconciled: the carry to ${carry.line} had reached it as commit ${carry.commit.slice(0, 7)}.`
          : carry.state === 'waiting'
            ? `The carry to ${carry.line} was stopped when the controller stopped (during ${was}); it waits to run again.`
            : `The carry to ${carry.line} stopped part-way when the controller stopped; inspect the project's folder, then carry the fix again.`,
      );
    }
    if (changed) store.updateAttempt(review);
  }
}

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
//
// Bringing a fix back (1.1, added October 27) goes the other way, and only at the director's word: a fix that landed
// on a newer line is applied to the older line the director picks and to every maintained line between, newest first,
// each from the commit the line before it got, as a carry is, and with the same tests, conflicts and reconciliation.
// A line that already has the fix is passed over: the one it landed on, one it was carried or brought back to, and
// one whose history holds its commit or the same change under another. Its chain is recorded with the story's carries,
// marked `back`, and is never carried forward again, since the lines newer than the older one already have it.
// Bringing back an idea brings back each of its stories in the order they landed, each line's carry waiting for the
// story before it.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  commitIntegration,
  git,
  integrationTrailer,
  landed,
  statusPaths,
  verifyIntegration,
} from './source-integration.mjs';
import { testsSentence } from './source-checks.mjs';
import { removeSourceWorktree, createSourceWorktree, sourceWorktreeRoot, worktreeName } from './source-worktrees.mjs';
import { lineReached, lineRepository, moveLine, projectLines } from './source-lines.mjs';
import { sourceResources } from './source-projects.mjs';
import { profileOf } from './source-profile.mjs';
import { jobDirectory, recordProject } from '../core/projects.mjs';
import { expandRun, runIdOf } from '../core/graph.mjs';
import { runMembership } from '../core/project-records.mjs';
import { holdsTestTurn, testRunEnded, testTurnResource } from '../core/test-turn.mjs';

const settled = ['carried', 'skipped'],
  storyKind = 'studio-development:change';

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
// A carry a brought-back fix waits for: the same line's carry of the story before it in its idea, or of a story it
// builds on, while that one is neither carried nor skipped.
export function carryWaits(store, carry) {
  for (const { reviewAttemptId, carryId } of carry.after || []) {
    let before;
    try {
      before = store.attempt(reviewAttemptId).sourceCarries?.find(item => item.id === carryId);
    } catch {
      continue;
    }
    if (before && !settled.includes(before.state)) return before;
  }
  return null;
}
// What a carry applies: the commit the line before it in its chain got, or the fix's own integration. A brought-back
// fix's chain is its own, so it starts from where the fix landed whatever was carried forward from there.
function carryFrom(review, carry) {
  const before = review.sourceCarries
    .slice(0, review.sourceCarries.indexOf(carry))
    .filter(item => item.state === 'carried' && item.back === carry.back)
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
    `${carry.back ? 'Brought the fix back' : 'Carried the fix'} to ${carry.line} through ${story.id}, whose editor resolved the conflicts, as commit ${journal.commit.slice(0, 7)}.`,
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

// The maintained lines older than a line, newest first: the order a fix is brought back in.
export function olderLines(store, projectId, line) {
  const lines = projectLines(store.project(projectId)),
    at = lines.findIndex(item => item.branch === line);
  return at < 0
    ? []
    : lines
        .slice(0, at)
        .filter(item => item.state === 'maintained')
        .map(item => item.branch)
        .reverse();
}
// A story's review whose change integrated on a line, or null.
function landedReview(store, task) {
  if (task.kind !== storyKind || !task.sourceStage?.review?.attemptId) return null;
  try {
    const review = store.attempt(task.sourceStage.review.attemptId);
    return review.sourceIntegration?.state === 'integrated' && review.sourceIntegration.repository?.branch
      ? review
      : null;
  } catch {
    return null;
  }
}
// Whether a line has a story's fix: it landed there or was carried or brought back there, or the line's history holds
// its commit, or the same change under another commit (git cherry), as a fix copied by hand would be.
function lineHas(review, line) {
  const { root, commit, repository } = review.sourceIntegration,
    ref = `refs/heads/${line}`;
  if (repository.branch === line) return true;
  if ((review.sourceCarries || []).some(carry => carry.line === line && carry.state === 'carried')) return true;
  if (landed(root, commit, ref)) return true;
  try {
    return git(root, ['cherry', ref, commit, `${commit}~1`]).startsWith('-');
  } catch {
    return false;
  }
}
// How bringing a story's fix back to a line would go: the lines it is applied to, newest first, and the carries they
// wait for, or why it can't (`has` when the line already has it). A story it builds on must have its fix on each of
// those lines, be on its way there, or be brought back ahead of it by the same idea (`ahead`).
function backChain(store, task, line, ahead) {
  const review = landedReview(store, task);
  if (!review) return { reason: 'Only a story whose change landed on a line can be brought back.' };
  if (task.carryOf)
    return {
      reason: `This story carries the fix of ${task.carryOf.storyId} to ${task.carryOf.line}; bring ${task.carryOf.storyId} back instead.`,
    };
  const from = review.sourceIntegration.repository.branch,
    older = olderLines(store, recordProject(task), from);
  if (!older.includes(line)) return { reason: `${line} is not a maintained line older than ${from}, where it landed.` };
  const open = nextCarry(review);
  if (open) return { reason: `Its ${open.back ? 'bringing back' : 'carry'} to ${open.line} has not finished.` };
  const lines = older.slice(0, older.indexOf(line) + 1).filter(item => !lineHas(review, item));
  if (!lines.includes(line)) return { has: true, reason: `${line} already has it.` };
  const waits = [];
  for (const id of task.dependencies || []) {
    let prerequisite;
    try {
      prerequisite = store.task(id);
    } catch {
      continue;
    }
    const its = landedReview(store, prerequisite);
    if (!its || ahead.has(id)) continue;
    for (const item of lines) {
      if (lineHas(its, item)) continue;
      const coming = (its.sourceCarries || []).find(
        carry => carry.back && carry.line === item && !settled.includes(carry.state),
      );
      if (!coming)
        return {
          reason: `It builds on ${id} (“${prerequisite.title}”), which ${item} does not have: bring back their idea, or ${id} first.`,
        };
      waits.push({ line: item, reviewAttemptId: its.id, carryId: coming.id, storyId: id });
    }
  }
  return { review, lines, waits };
}
// The carries bringing these stories back to a line adds, in order. Each line's carry waits for the one before it on
// that line, so an idea's fixes reach each line in the order they landed. For an idea, a story the line already has
// is passed over; anything else that stops one stops them all.
function planBringBack(store, tasks, line, { idea = false } = {}) {
  const plans = [],
    ahead = new Set(),
    latest = new Map();
  for (const task of tasks) {
    const chain = backChain(store, task, line, ahead);
    if (chain.reason) {
      if (idea && chain.has) continue;
      throw new Error(idea ? `${task.id} (“${task.title}”): ${chain.reason}` : chain.reason);
    }
    const base = chain.review.sourceCarries?.length ?? 0,
      back = `source-carry:${chain.review.id}:${base}`;
    const entries = chain.lines.map((item, index) => {
      const id = `source-carry:${chain.review.id}:${base + index}`,
        after = [latest.get(item), ...chain.waits.filter(wait => wait.line === item)]
          .filter(Boolean)
          .map(({ reviewAttemptId, carryId, storyId }) => ({ reviewAttemptId, carryId, storyId }));
      latest.set(item, { reviewAttemptId: chain.review.id, carryId: id, storyId: task.id });
      return { id, line: item, state: 'waiting', back, ...(after.length ? { after } : {}) };
    });
    ahead.add(task.id);
    plans.push({ task, review: chain.review, entries });
  }
  return plans;
}
function applyBringBack(store, plans, by) {
  const at = new Date().toISOString();
  for (const { task, review, entries } of plans) {
    review.sourceCarries = [
      ...(review.sourceCarries || []),
      ...entries.map(entry => ({ ...entry, approvedBy: by, approvedAt: at })),
    ];
    store.updateAttempt(review);
    const waits = [...new Set(entries.flatMap(entry => (entry.after || []).map(item => item.storyId)))];
    store.event(
      'bring_back_planned',
      task.id,
      review.id,
      `The director brings the fix back to ${entries.map(entry => entry.line).join(', then ')}${
        waits.length ? `, after ${waits.join(' and ')}` : ''
      }.`,
      recordProject(task),
    );
  }
  return plans.map(({ task, entries }) => ({ storyId: task.id, lines: entries.map(entry => entry.line) }));
}
const targetOf = (line, plan) => {
  try {
    const plans = plan();
    return plans.length
      ? { line, through: [...new Set(plans.flatMap(item => item.entries.map(entry => entry.line)))] }
      : { line, reason: `${line} already has every story of this idea.` };
  } catch (error) {
    return { line, reason: error.message };
  }
};

// Bring back to <line> on a story: the director's alone, never the policy's. It runs as carries do, one at a time
// when the project's source is free.
export function bringBack(store, task, line, by = { type: 'director' }) {
  if (typeof line !== 'string' || !line) throw new Error('Name the line to bring the fix back to.');
  return store.tx(() => applyBringBack(store, planBringBack(store, [task], line), by)[0]);
}
// Where a story's page offers Bring back to <line>: each maintained line older than the one it landed on, with the
// lines it would reach, or why it can't go there.
export function bringBackTargets(store, task) {
  const review = landedReview(store, task);
  if (!review) return { lines: [], reason: 'Only a story whose change landed on a line can be brought back.' };
  return {
    lines: olderLines(store, recordProject(task), review.sourceIntegration.repository.branch).map(line =>
      targetOf(line, () => planBringBack(store, [task], line)),
    ),
  };
}
// The stories bringing back an idea takes, in the order they landed: every source story of the idea that landed,
// once each has landed or been closed. A carry story goes with the fix it carries.
function ideaStories(store, projectId, runId) {
  const tasks = store.tasks().filter(task => recordProject(task) === projectId),
    runOf = runMembership(tasks),
    stories = tasks.filter(task => runOf.get(task.id) === runId && task.kind === storyKind && !task.carryOf);
  if (!stories.length) throw new Error('This idea has no stories that change the source.');
  const open = stories.find(
    task => !landedReview(store, task) && !task.closed && !['denied', 'cancelled'].includes(task.status),
  );
  if (open)
    throw new Error(`${open.id} (“${open.title}”) has not landed yet; bring the idea back once every story has.`);
  const landedAt = task => landedReview(store, task)?.sourceIntegration.finishedAt ?? '',
    landedStories = stories.filter(task => landedReview(store, task));
  if (!landedStories.length) throw new Error('None of this idea’s stories landed on a line.');
  return landedStories.sort((a, b) => landedAt(a).localeCompare(landedAt(b)));
}
// Bring the idea back to <line>: each of its stories, in the order they landed.
export function bringBackIdea(store, projectId, runId, line, by = { type: 'director' }) {
  if (typeof line !== 'string' || !line) throw new Error('Name the line to bring the idea back to.');
  return store.tx(() => {
    const plans = planBringBack(store, ideaStories(store, projectId, runId), line, { idea: true });
    if (!plans.length) throw new Error(`${line} already has every story of this idea.`);
    return applyBringBack(store, plans, by);
  });
}
// Where an idea's page offers Bring the idea back to <line>, as bringBackTargets does for a story.
export function ideaBringBackTargets(store, projectId, runId) {
  let stories;
  try {
    stories = ideaStories(store, projectId, runId);
  } catch (error) {
    return { lines: [], reason: error.message };
  }
  const lines = new Set(
    stories.flatMap(task =>
      olderLines(store, projectId, landedReview(store, task).sourceIntegration.repository.branch),
    ),
  );
  return {
    lines: [...lines].map(line => targetOf(line, () => planBringBack(store, stories, line, { idea: true }))),
  };
}

// Starts the next approved carry of a story. Refused (busy) while an integration or carry runs, the project's source
// is held or the carry still holds a lease of its own (the test turn its stopped run kept, keepStoppedTurn, which its
// new run would wait on), so the caller tries again when they settle.
export function runCarry(runtime, story, onSettled = () => {}) {
  const store = runtime.store,
    projectId = recordProject(story),
    review = carryReview(store, story),
    carry = nextCarry(review);
  if (carry?.state !== 'waiting' || !carry.approvedBy) throw new Error('No approved carry is waiting.');
  const waiting = carryWaits(store, carry);
  if (waiting)
    throw new Error(
      `The carry to ${carry.line} waits for ${carry.after.find(item => item.carryId === waiting.id).storyId}'s.`,
    );
  const resources = sourceResources(store, story);
  if (
    runtime.sourceIntegrationRun ||
    store.leases().some(lease => resources.includes(lease.resource) || lease.attemptId === carry.id)
  )
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
    `${carry.back ? 'Bringing the fix back' : 'Carrying the fix'} from ${from.line} (${from.commit.slice(0, 7)}) to ${carry.line} at ${repository.head.slice(0, 7)} in its own worktree, then formatting and testing it there; ${carry.line} is unchanged until it passes.`,
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
    journal.back ? `Bring “${story.title}” back to ${journal.line}` : `Carry “${story.title}” to ${journal.line}`,
    '',
    `${journal.back ? 'Brought back' : 'Carried'} by Studio desk from ${journal.fromLine} (cherry picked from commit ${journal.fromCommit}), ${
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
      `${journal.back ? 'Bringing the fix back' : 'The carry'} to ${journal.line} stopped before changing it: ${reason}`,
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
    `${journal.back ? 'Brought the fix back' : 'Carried the fix'} to ${journal.line} as commit ${journal.commit.slice(0, 7)}, applied from ${journal.fromLine}, formatted and tested.`,
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
      releasesRouted,
      runReference,
      workflowReference,
      ...rest
    } = store.task(story.id);
  const carried = {
    ...rest,
    id,
    title: `${journal.back ? 'Bring back to' : 'Carry to'} ${journal.line}: ${story.title}`.slice(0, 160),
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
      ...(journal.back ? { back: true } : {}),
    },
    direction: `${journal.back ? 'Bring' : 'Carry'} the fix of ${original} (“${story.title}”), already reviewed and integrated on ${journal.fromLine}, ${journal.back ? 'back ' : ''}to ${journal.line}. Git could not apply it there cleanly: the files under changes/ hold it merged onto ${journal.line}, and ${conflicts.join(', ')} hold conflict markers between ${journal.line} (<<<<<<<) and the fix (>>>>>>>). Resolve each conflict so the fix works on ${journal.line}, remove every marker, and keep the rest of the change. Its tests and an independent review follow.`,
  };
  expandRun(store, runIdOf(story), {
    reason: `${journal.back ? 'Bring' : 'Carry'} ${original} ${journal.back ? 'back ' : ''}to ${journal.line}, whose editor resolves the conflicts.`,
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
    `The fix conflicts with ${journal.line} in ${conflicts.join(', ')}; ${id} ${journal.back ? 'brings it back' : 'carries it'} there, its editor resolving the conflicts, then its tests and an independent review.`,
    recordProject(story),
  );
  return result;
}

// A carry or release the controller's stop put back to wait holds its project's queue, as the restart holds a
// project's queued work (Runner): the project is paused with the restart's mark, so the work waits for the director's
// Resume and then runs again on its own, once. A pause the director chose stays theirs and is not marked. The project
// is remembered on the runtime, so a planned restart does not lift this hold (Autonomy.resumePlan).
export function holdInterrupted(runtime, projectId, what) {
  const store = runtime.store,
    project = store.project(projectId);
  (runtime.interruptedHolds ||= new Set()).add(projectId);
  if (project.dispatchPaused) return;
  project.dispatchPaused = true;
  project.restartPaused = true;
  store.putProject(project);
  store.event(
    'pipeline_paused',
    null,
    null,
    `Controller restarted while a ${what} was running. The project is held; the ${what} runs again on its own when you resume it.`,
    projectId,
  );
}

// The computer's test turn a carry or release held when the controller stopped (journal: its carry or release record).
// Its other leases are released as before. Every other full suite waits for the turn, so it is given back now when the
// test run the journal recorded under it (testProcess, source-integration.mjs) is confirmed gone, by the identity an
// interrupted integration's turn is checked with (testRunEnded, core/test-turn.mjs), or when it recorded none, since
// then nothing it started is running. Otherwise the turn is kept, with its recorded process, and remembered on the
// runtime (runtime.keptTurns: its owner's ID, with the check that gives it back once that run has ended), which the
// controller checks whenever it tries carries and releases and on a timer while one is kept (Autonomy.freeEndedTurns);
// until then the carry or release does not start again (runCarry, runRelease: busy). A journal that kept the turn
// through an earlier start (running: false) is found again the same way; it holds no other lease of its own.
// event: [taskId, attemptId] of its test_turn event; locate(): the journal as now stored, with save(), or null.
const checked = "Only the run's own process was checked; processes it started are not tracked yet and may outlive it.";
export function keepStoppedTurn(
  runtime,
  journal,
  { what, event: [taskId, attemptId], projectId, locate, running = true },
) {
  const store = runtime.store;
  if (!holdsTestTurn(store, journal.id)) {
    if (running) store.release(journal.id);
    return;
  }
  if (running)
    for (const lease of store.leases())
      if (lease.attemptId === journal.id && lease.resource !== testTurnResource)
        store.releaseResource(lease.resource, journal.id);
  const recorded = journal.testProcess,
    freed = text => store.event('test_turn', taskId, attemptId, `The test turn was freed: ${text}`, projectId);
  if (!recorded?.pid || testRunEnded(journal)) {
    delete journal.testProcess;
    store.releaseResource(testTurnResource, journal.id);
    freed(
      recorded?.pid
        ? `the ${what}'s test run that held it had ended when the controller started again. ${checked}`
        : `the ${what} had started no test run under it when the controller stopped, so nothing it started still runs.`,
    );
    return;
  }
  (runtime.keptTurns ||= new Map()).set(journal.id, () => {
    if (!holdsTestTurn(store, journal.id)) return true;
    if (!testRunEnded({ testProcess: recorded })) return false;
    store.tx(() => {
      const now = locate();
      if (now?.journal.testProcess) {
        delete now.journal.testProcess;
        now.save();
      }
      store.releaseResource(testTurnResource, journal.id);
      freed(`the ${what}'s test run that held it has ended. ${checked}`);
    });
    return true;
  });
}
// Carries the controller's stop cut off: verification never writes the line, so the carry waits again with its
// approval, holding its project until the director resumes it; one that was moving the line is carried if the line
// reached its commit, waits again when the line is not checked out (its move is one compare-and-swap), and otherwise
// needs the director. The test turn one held is kept while the test run it started may still go on (keepStoppedTurn).
export function interruptedCarries(runtime) {
  const store = runtime.store;
  for (const review of store.allAttempts()) {
    let changed = false;
    for (const carry of review.sourceCarries || []) {
      const turn = running =>
        keepStoppedTurn(runtime, carry, {
          what: 'carry',
          event: [review.taskId, review.id],
          projectId: recordProject(review),
          running,
          locate: () => {
            const now = store.attempt(review.id),
              journal = now.sourceCarries?.find(item => item.id === carry.id);
            return journal && { journal, save: () => store.updateAttempt(now) };
          },
        });
      if (!['verifying', 'committing'].includes(carry.state)) {
        // One that kept the turn through an earlier start.
        if (carry.testProcess && holdsTestTurn(store, carry.id)) {
          changed = true;
          turn(false);
        }
        continue;
      }
      changed = true;
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
            ? `The carry to ${carry.line} was stopped when the controller stopped (during ${was}); it runs again on its own when the project is resumed.`
            : `The carry to ${carry.line} stopped part-way when the controller stopped; inspect the project's folder, then carry the fix again.`,
        recordProject(review),
      );
      turn(true);
      if (carry.state === 'waiting') holdInterrupted(runtime, recordProject(review), 'carry');
    }
    if (changed) store.updateAttempt(review);
  }
}

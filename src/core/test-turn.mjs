// The computer's turns (October 28, 2026). A full test suite takes most of a computer for minutes, so the controller
// runs one at a time, whichever project it belongs to: an idea's checks and a story's candidate tests take the test
// turn just before their test process starts and give it back when it ends. A story's visual check (1.2 step 8)
// starts its project's app and photographs it; two at once could meet at one address, and one would photograph the
// other's app, so the visual check has a turn of its own (October 29, when a project's stories began to build two at
// a time). An editor's own run of the whole suite on its edits takes the test turn too (waitForTurn, November 2);
// its runs of named test files, editors, reviewers and installs take none. A turn is a persisted lease on one resource, claimed through the
// store as every other reservation is, so a restart keeps it held until an interrupted holder is reconciled. Waiters
// queue in memory, first come, first served, one queue for each turn, and are tried again whenever leases change;
// there is no polling. A waiting attempt's record says what it waits for (`testTurn`, whichever turn it is).
export const testTurnResource = 'computer:test-suite',
  visualTurnResource = 'computer:visual-check';

// Each store's waiters for each turn: one store per controller, shared by every project.
const queues = new WeakMap();

function queueOf(store, resource) {
  let turns = queues.get(store);
  if (!turns) {
    turns = new Map();
    queues.set(store, turns);
    store.watchLeases(() => {
      for (const [held, queue] of turns) retry(store, held, queue);
    });
  }
  if (!turns.has(resource)) turns.set(resource, { waiting: [], retry: null });
  return turns.get(resource);
}

// A lease change may come inside a transaction, so the queue is tried once it has settled.
function retry(store, resource, queue) {
  if (!queue.waiting.length || queue.retry) return;
  queue.retry = setImmediate(() => {
    queue.retry = null;
    serve(store, resource, queue);
  });
}

// The conflict when the turn is held, else null with the turn now the owner's.
function claim(store, resource, owner) {
  try {
    store.claim([resource], owner);
    return null;
  } catch (error) {
    if (error.conflict) return error.conflict;
    throw error;
  }
}

// Calls start once the attempt holds the turn: at once when it is free and nobody waits for it, otherwise after the
// waiters ahead of it have had theirs. A run with a time limit (entry.timer) has it stop while it waits and start
// again, whole (limitMs), with the turn, so waiting never counts against it.
export function takeTurn(runtime, entry, { resource, limitMs, start }) {
  const store = runtime.store,
    waiter = { runtime, entry, limitMs, start, timed: !!entry.timer };
  if (!queues.get(store)?.get(resource)?.waiting.length && !claim(store, resource, entry.attempt.id))
    return begin(waiter);
  wait(store, resource, queueOf(store, resource), waiter);
}
export const takeTestTurn = (runtime, entry, options) =>
  takeTurn(runtime, entry, { ...options, resource: testTurnResource });

// Gives the turn back while the owner keeps its other reservations. Finishing an attempt releases it with the rest.
export function releaseTurn(store, resource, owner) {
  store.releaseResource(resource, owner);
}
export const releaseTestTurn = (store, owner) => releaseTurn(store, testTurnResource, owner);

// Whom a waiter waits for: the holder, or the first waiter when the turn has just come free.
function conflictFor(store, resource, queue) {
  const lease = store.leases().find(item => item.resource === resource);
  return store.resourceConflict(resource, lease?.attemptId ?? queue.waiting[0].entry.attempt.id);
}

function wait(store, resource, queue, waiter) {
  const { entry } = waiter;
  entry.cleanup.push(() => leave(store, resource, queue, waiter));
  // No process runs while it waits, so a stop finishes the attempt at once (Runner.stop), and its limit waits too.
  clearTimeout(entry.timer);
  entry.timer = null;
  entry.child = null;
  entry.attempt.pid = null;
  enqueue(store, resource, queue, waiter);
}

// Joins the queue, and records what the waiter waits for with one event.
function enqueue(store, resource, queue, waiter) {
  const a = waiter.entry.attempt,
    conflict = conflictFor(store, resource, queue);
  queue.waiting.push(waiter);
  a.testTurn = { reason: conflict.reason, since: new Date().toISOString(), holder: conflict.ownerAttemptId };
  store.updateAttempt(a);
  store.event('test_turn', a.taskId, a.id, conflict.reason);
  retry(store, resource, queue);
}

// An editor's own run of the whole suite (connectors/employee-tests.mjs) waits in the same queue while its editor
// keeps running: the editor's process, pid and time limit are left as they are, and a wait that ends without the
// turn finishes nothing. Resolves { taken, waitedMs } once the attempt holds the turn, which the caller gives back
// (releaseTurn), or once it has left the queue without it: at boundMs, with what it waited for ({ bounded, reason,
// holder }); when signal aborts (the request closing, the editor stopping); or when the attempt finishes.
export function waitForTurn(runtime, entry, { resource = testTurnResource, boundMs = Infinity, signal } = {}) {
  const store = runtime.store,
    began = Date.now();
  if (signal?.aborted) return Promise.resolve({ taken: false, waitedMs: 0 });
  if (!queues.get(store)?.get(resource)?.waiting.length && !claim(store, resource, entry.attempt.id))
    return Promise.resolve({ taken: true, waitedMs: 0 });
  const queue = queueOf(store, resource);
  return new Promise(resolve => {
    let timer = null,
      done = false;
    const settle = (taken, details = {}) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        resolve({ taken, waitedMs: Date.now() - began, ...details });
      },
      waiter = { runtime, entry, take: () => settle(true), drop: () => cancel() },
      cancel = () => {
        if (done) return;
        leave(store, resource, queue, waiter);
        settle(false);
      };
    signal?.addEventListener('abort', cancel, { once: true });
    if (Number.isFinite(boundMs))
      timer = setTimeout(() => {
        if (done) return;
        const { reason = null, holder = null } = entry.attempt.testTurn || {};
        leave(store, resource, queue, waiter);
        settle(false, { bounded: true, reason, holder });
      }, boundMs);
    enqueue(store, resource, queue, waiter);
  });
}
export const waitForTestTurn = (runtime, entry, options) =>
  waitForTurn(runtime, entry, { ...options, resource: testTurnResource });

// A waiter that finished without the turn (stopped or cancelled) leaves the queue and its record.
function leave(store, resource, queue, waiter) {
  const index = queue.waiting.indexOf(waiter);
  if (index >= 0) queue.waiting.splice(index, 1);
  const a = waiter.entry.attempt;
  if (a.testTurn) {
    delete a.testTurn;
    store.updateAttempt(a);
  }
  retry(store, resource, queue);
}

function serve(store, resource, queue) {
  while (queue.waiting.length) {
    const waiter = queue.waiting[0],
      { runtime, entry } = waiter;
    if (entry.cancelled || runtime.active.get(entry.attempt.id) !== entry) {
      queue.waiting.shift();
      waiter.drop?.();
      continue;
    }
    let conflict;
    try {
      conflict = claim(store, resource, entry.attempt.id);
    } catch {
      return; // The store closed with the controller.
    }
    if (conflict) {
      // Each waiter's record names the current holder; its wait and event stay as they began.
      for (const { entry } of queue.waiting) {
        const turn = entry.attempt.testTurn;
        if (!turn || turn.holder === conflict.ownerAttemptId) continue;
        Object.assign(turn, { reason: conflict.reason, holder: conflict.ownerAttemptId });
        store.updateAttempt(entry.attempt);
      }
      return;
    }
    queue.waiting.shift();
    begin(waiter);
  }
}

function begin({ runtime, entry, limitMs, start, timed, take }) {
  const a = entry.attempt;
  if (a.testTurn) {
    delete a.testTurn;
    runtime.store.updateAttempt(a);
  }
  if (take) return take();
  if (timed) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timedOut = true;
      runtime.stop(a.id);
    }, limitMs);
  }
  try {
    start();
  } catch (error) {
    runtime.finish(entry, null, error.message);
  }
}

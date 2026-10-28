// The computer's turn for full test suites (October 28, 2026). A full suite takes most of a computer for minutes, so
// the controller runs one at a time, whichever project it belongs to: an idea's checks and a story's candidate tests
// take the turn just before their test process starts and give it back when it ends. Editors, reviewers and installs
// take none. The turn is a persisted lease on one resource, claimed through the store as every other reservation is,
// so a restart keeps it held until an interrupted holder is reconciled. Waiters queue in memory, first come, first
// served, and are tried again whenever leases change; there is no polling.
export const testTurnResource = 'computer:test-suite';

// Each store's waiters: one store per controller, shared by every project.
const queues = new WeakMap();

function queueOf(store) {
  let queue = queues.get(store);
  if (!queue) {
    queue = { waiting: [], retry: null };
    queues.set(store, queue);
    store.watchLeases(() => retry(store, queue));
  }
  return queue;
}

// A lease change may come inside a transaction, so the queue is tried once it has settled.
function retry(store, queue) {
  if (!queue.waiting.length || queue.retry) return;
  queue.retry = setImmediate(() => {
    queue.retry = null;
    serve(store, queue);
  });
}

// The conflict when the turn is held, else null with the turn now the owner's.
function claim(store, owner) {
  try {
    store.claim([testTurnResource], owner);
    return null;
  } catch (error) {
    if (error.conflict) return error.conflict;
    throw error;
  }
}

// Calls start once the attempt holds the turn: at once when it is free and nobody waits for it, otherwise after the
// waiters ahead of it have had theirs. A run with a time limit (entry.timer) has it stop while it waits and start
// again, whole (limitMs), with the turn, so waiting never counts against it.
export function takeTestTurn(runtime, entry, { limitMs, start }) {
  const store = runtime.store,
    waiter = { runtime, entry, limitMs, start, timed: !!entry.timer };
  if (!queues.get(store)?.waiting.length && !claim(store, entry.attempt.id)) return begin(waiter);
  wait(store, queueOf(store), waiter);
}

// Gives the turn back while the owner keeps its other reservations. Finishing an attempt releases it with the rest.
export function releaseTestTurn(store, owner) {
  store.releaseResource(testTurnResource, owner);
}

// Whom a waiter waits for: the holder, or the first waiter when the turn has just come free.
function conflictFor(store, queue) {
  const lease = store.leases().find(item => item.resource === testTurnResource);
  return store.resourceConflict(testTurnResource, lease?.attemptId ?? queue.waiting[0].entry.attempt.id);
}

function wait(store, queue, waiter) {
  const { entry } = waiter,
    a = entry.attempt,
    conflict = conflictFor(store, queue);
  queue.waiting.push(waiter);
  entry.cleanup.push(() => leave(store, queue, waiter));
  // No process runs while it waits, so a stop finishes the attempt at once (Runner.stop), and its limit waits too.
  clearTimeout(entry.timer);
  entry.timer = null;
  entry.child = null;
  a.pid = null;
  a.testTurn = { reason: conflict.reason, since: new Date().toISOString(), holder: conflict.ownerAttemptId };
  store.updateAttempt(a);
  store.event('test_turn', a.taskId, a.id, conflict.reason);
  retry(store, queue);
}

// A waiter that finished without the turn (stopped or cancelled) leaves the queue and its record.
function leave(store, queue, waiter) {
  const index = queue.waiting.indexOf(waiter);
  if (index >= 0) queue.waiting.splice(index, 1);
  const a = waiter.entry.attempt;
  if (a.testTurn) {
    delete a.testTurn;
    store.updateAttempt(a);
  }
  retry(store, queue);
}

function serve(store, queue) {
  while (queue.waiting.length) {
    const waiter = queue.waiting[0],
      { runtime, entry } = waiter;
    if (entry.cancelled || runtime.active.get(entry.attempt.id) !== entry) {
      queue.waiting.shift();
      continue;
    }
    let conflict;
    try {
      conflict = claim(store, entry.attempt.id);
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

function begin({ runtime, entry, limitMs, start, timed }) {
  const a = entry.attempt;
  if (a.testTurn) {
    delete a.testTurn;
    runtime.store.updateAttempt(a);
  }
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

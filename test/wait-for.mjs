// Shared test waits: poll a condition until it holds or a generous time limit passes, measured by
// elapsed time rather than a count of polls, and say what was expected when it never comes. Not a
// test file, so the test command does not run it.

// Generous for a loaded test sandbox, and below the suite's 120-second per-test bound.
export const waitLimit = 60000;

// Resolves with the check's first truthy value; a check may be async. A check that throws ends the
// wait at once. When the limit runs out, the error names the label and, when given, detail()
// describes the state at that moment.
export async function waitFor(check, label, { limit = waitLimit, interval = 15, detail } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start >= limit)
      throw new Error(`Timed out after ${limit} ms waiting for ${label}${detail ? `; ${detail()}` : ''}.`);
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

// A task's status and reason, and its last attempt's ID and status when there is one.
export function describeTask(task, attempt) {
  return (
    `task ${task.id} is ${task.status} (${task.reason ? `reason: ${task.reason}` : 'no reason recorded'})` +
    (attempt ? `, its last attempt ${attempt.id} is ${attempt.status}` : ', with no attempt')
  );
}

// Waits until store.task(id).status equals status and returns the task's last attempt.
export async function waitForTask(store, id, status, options = {}) {
  const task = await waitFor(
    () => {
      const task = store.task(id);
      return task.status === status && task;
    },
    `task ${id} to be ${status}`,
    {
      ...options,
      detail: () => {
        const task = store.task(id);
        return describeTask(task, task.lastAttemptId ? store.attempt(task.lastAttemptId) : null);
      },
    },
  );
  return store.attempt(task.lastAttemptId);
}

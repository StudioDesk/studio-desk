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

// How many of an attempt's last log lines a timeout repeats, and the longest each may be.
const logLines = 10,
  logLineLength = 300;

// A task's status and reason, and its last attempt's ID and status when there is one. When that
// attempt recorded an error, its error follows in brackets unless the task's reason already says
// it, with the end of its log: the last few 'log' rows among the attempt's events (oldest first,
// as store.events returns them), each on a line of its own and shortened. A test's temporary
// studio is gone once it fails, so this is the only record of why the attempt stopped. No error,
// no events or no log rows add nothing.
export function describeTask(task, attempt, events = []) {
  const said = `task ${task.id} is ${task.status} (${task.reason ? `reason: ${task.reason}` : 'no reason recorded'})`;
  if (!attempt) return `${said}, with no attempt`;
  const log = attempt.error
      ? events
          .filter(event => event.kind === 'log')
          .slice(-logLines)
          .map(event => {
            const line = String(event.message).replace(/\s+/g, ' ').trim();
            return line.length > logLineLength ? `${line.slice(0, logLineLength)}...` : line;
          })
      : [],
    notes = [
      ...(attempt.error && attempt.error !== task.reason ? [`error: ${attempt.error}`] : []),
      ...(log.length ? [`its log ends:${log.map(line => `\n  ${line}`).join('')}`] : []),
    ];
  return `${said}, its last attempt ${attempt.id} is ${attempt.status}${notes.length ? ` (${notes.join('; ')})` : ''}`;
}

// Waits until store.task(id).status equals status and returns the task's last attempt. A task that
// fails meanwhile is still waited for, since autonomy may start another attempt; when the limit runs
// out, the error describes the task (describeTask), with its last attempt's log read from
// store.events(attemptId) when the store offers events and that attempt recorded an error.
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
        const task = store.task(id),
          attempt = task.lastAttemptId ? store.attempt(task.lastAttemptId) : null;
        return describeTask(
          task,
          attempt,
          attempt?.error && typeof store.events === 'function' ? store.events(attempt.id) : [],
        );
      },
    },
  );
  return store.attempt(task.lastAttemptId);
}

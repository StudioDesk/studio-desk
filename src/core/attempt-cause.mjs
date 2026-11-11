// Why an attempt ended (its endCause, recorded when it finishes): the work itself, the studio's environment (the
// controller stopping, a test sandbox that could not start, or a test outside the story known to fail at random), a
// provider's usage limit, or a question the agent stopped to ask. Only the work's own endings use up a story's
// automatic attempts (registry.mjs countsTowardLimit); the rest stay on record. An attempt recorded before endCause existed is classified by the rules that counted it then.
import { jobStartFailed } from '../adapters/process-job.mjs';
import { recordProject } from './projects.mjs';

export const attemptCauses = Object.freeze(['work', 'environment', 'usage-limit', 'question']);
// What in the environment ended it: the controller stopping, a test sandbox that could not start, or a test outside the
// story that is known to fail at random (randomTestFailures).
export const environmentDetails = Object.freeze(['controller-stop', 'sandbox', 'random-test']);

export function endCause(cause, detail = null) {
  if (!attemptCauses.includes(cause)) throw new Error(`Unknown attempt end cause: ${cause}.`);
  if (cause === 'environment' ? !environmentDetails.includes(detail) : detail !== null)
    throw new Error(`Invalid detail for attempt end cause ${cause}: ${detail}.`);
  return detail ? { cause, detail } : { cause };
}
export const workCause = () => endCause('work');
export const controllerStopCause = () => endCause('environment', 'controller-stop');
export const sandboxCause = () => endCause('environment', 'sandbox');
export const randomTestCause = () => endCause('environment', 'random-test');

// The cause Runner.finish records. A usage-limit hold and a question name themselves; an attempt the controller's own
// shutdown cancelled (not one the director or its time limit had already stopped) ended with the controller; an
// adapter may name an environment cause it observed (the source change's test sandbox). Everything else is the work's.
export function finishedCause({ attempt, cancelled = false, timedOut = false, shutdown = false, observed = null }) {
  if (attempt.subscriptionHold) return endCause('usage-limit');
  if (attempt.question?.ask) return endCause('question');
  if (timedOut) return workCause();
  if (cancelled && shutdown) return controllerStopCause();
  if (observed && !cancelled) return endCause(observed.cause, observed.detail ?? null);
  return workCause();
}

// The cause on record, or for an attempt recorded before endCause the one its fields imply: a usage-limit hold, an
// interruption the director reconciled, or a question. Everything else, an unreconciled interruption included, was
// the work's as far as the old rules counted.
export function recordedCause(attempt) {
  if (attempt.endCause?.cause) return attempt.endCause;
  if (attempt.subscriptionHold) return { cause: 'usage-limit' };
  if (attempt.status === 'interrupted' && attempt.reconciledAt)
    return { cause: 'environment', detail: 'controller-stop' };
  if (attempt.question?.ask) return { cause: 'question' };
  return { cause: 'work' };
}

// Whether the work's own ending used up one of its automatic attempts.
export const causeCounts = attempt => recordedCause(attempt).cause === 'work';

// The cause in plain words, for a retrying agent's history.
export function causeText(attempt) {
  const { cause, detail } = recordedCause(attempt);
  if (cause === 'usage-limit') return 'a usage limit stopped it; not counted';
  if (cause === 'question') return 'it stopped to ask the director a question; not counted';
  if (cause === 'environment')
    return detail === 'sandbox'
      ? "the candidate's test sandbox could not start, so no tests ran; not counted"
      : detail === 'random-test'
        ? 'a test outside this story that has failed on other stories failed again; not counted'
        : 'the controller stopped; not counted';
  return 'the work itself; counted toward the attempt limit';
}

// What the built-in sandbox runner writes when the sandbox, or the test command inside it, never started
// (src/adapters/built-in-sandbox-run.mjs and built-in-sandbox-launch.mjs).
const sandboxStartMessages = [/The sandbox runtime did not start:/, /The test command did not start in the sandbox:/];

// Whether a TAP stream reported any test: a test line, or totals naming one.
const reportedTests = stdout => /^\s*(?:not )?ok \d+/m.test(stdout) || /^# tests [1-9]/m.test(stdout);

// Whether a candidate test run never started because its sandbox could not: no test was reported, and either the job
// wrapper's start-failure exit or the built-in sandbox runner's own start failure ended it. Any other run that reported
// no test, such as a check before the tests that failed, is the candidate's.
export function sandboxNeverStarted({ exitCode, stdout = '', stderr = '' }) {
  if (reportedTests(stdout)) return false;
  if (exitCode === jobStartFailed) return true;
  return exitCode !== 0 && sandboxStartMessages.some(message => message.test(stderr));
}

// A failed test names only its file's name (connectors/source-checks.mjs failedTests), so a story's files are compared
// by name: its approved files, the files it creates and the files it deletes. A test file of the same name in another
// folder counts as the story's own, which only ever keeps the cause the work's.
const fileName = file => String(file).split(/[\/]+/).at(-1);
const storyFileNames = attempt => {
  const scope = attempt?.sourceChange;
  if (!scope) return null;
  return new Set(
    [...(scope.allowedFiles || []), ...(scope.newFiles || []), ...(scope.deleteFiles || [])].map(fileName),
  );
};
// The failed test reader keeps at most this many failures; a run that reached it may have failed more than it names.
const namedFailureLimit = 20;

// The failed tests of a story's negative candidate that make it the environment's (environment/random-test), or null
// when it stays the work's. Every failed test must lie in a file outside the story's files and be known to fail at
// random: the same test (file and name) is among the failed tests an earlier attempt of a different story in the same
// project recorded, in a file outside that story's files too. A failed build, a failure in one of the story's own
// files, a test never seen failing elsewhere, a skipped or todo test, or no named failure at all keeps it the work's.
// The earlier records are read from the attempts that name the failed tests (store.attemptsNaming).
export function randomTestFailures(store, attempt, { failed = [], totals = {}, buildFailed = false, signal = null }) {
  const own = storyFileNames(attempt);
  if (!own || buildFailed || signal || totals.skipped || totals.todo) return null;
  if (!failed.length || failed.length >= namedFailureLimit) return null;
  if (!failed.every(item => item.file && item.name && !own.has(fileName(item.file)))) return null;
  const projectId = recordProject(attempt),
    elsewhere = store
      .attemptsNaming([...new Set(failed.map(item => item.name))])
      .filter(
        other =>
          other.id !== attempt.id &&
          other.taskId !== attempt.taskId &&
          recordProject(other) === projectId &&
          Array.isArray(other.failedTests) &&
          storyFileNames(other),
      );
  const known = item =>
    elsewhere.some(other => {
      const theirs = storyFileNames(other);
      return (
        !theirs.has(fileName(item.file)) &&
        other.failedTests.some(seen => seen?.name === item.name && seen?.file === item.file)
      );
    });
  return failed.every(known) ? failed : null;
}

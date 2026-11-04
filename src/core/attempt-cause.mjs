// Why an attempt ended (its endCause, recorded when it finishes): the work itself, the studio's environment (the
// controller stopping, or a test sandbox that could not start), a provider's usage limit, or a question the agent
// stopped to ask. Only the work's own endings use up a story's automatic attempts (registry.mjs countsTowardLimit);
// the rest stay on record. An attempt recorded before endCause existed is classified by the rules that counted it then.
import { jobStartFailed } from '../adapters/process-job.mjs';

export const attemptCauses = Object.freeze(['work', 'environment', 'usage-limit', 'question']);
// What in the environment ended it.
export const environmentDetails = Object.freeze(['controller-stop', 'sandbox']);

export function endCause(cause, detail = null) {
  if (!attemptCauses.includes(cause)) throw new Error(`Unknown attempt end cause: ${cause}.`);
  if (cause === 'environment' ? !environmentDetails.includes(detail) : detail !== null)
    throw new Error(`Invalid detail for attempt end cause ${cause}: ${detail}.`);
  return detail ? { cause, detail } : { cause };
}
export const workCause = () => endCause('work');
export const controllerStopCause = () => endCause('environment', 'controller-stop');
export const sandboxCause = () => endCause('environment', 'sandbox');

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

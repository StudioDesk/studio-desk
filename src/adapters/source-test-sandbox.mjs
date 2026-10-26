import { builtInSandboxCommand, builtInSandboxVersion } from './built-in-sandbox.mjs';

// Where candidate tests and integration verification run (v1.0 item 20): in the built-in sandbox (1.0.1,
// built-in-sandbox.mjs) or, by the director's explicit choice, directly on this computer with the director's
// own access. Each attempt records the choice. Before 1.0.1 they could also run in the Codex CLI sandbox, which
// candidate tests no longer use (the director, October 25); an attempt recorded before the choice existed used it.
export const testSandboxes = ['built-in', 'none'];
export const testSandboxOf = configuration => configuration?.testSandbox || 'codex';
// Where the next attempt's tests run: the built-in sandbox, unless the director chose none. A choice of the
// Codex sandbox saved before 1.0.1 now means the built-in one. Attempts record the result, so a change here
// never alters what an earlier attempt ran with.
export const chosenTestSandbox = organization => (organization?.testSandbox === 'none' ? 'none' : 'built-in');
// Where an attempt's tests run now: one recorded under the Codex sandbox has them run again in the built-in one.
const runsIn = configuration => (testSandboxOf(configuration) === 'none' ? 'none' : 'built-in');
export const candidateTestCommand = (plan, configuration) =>
  runsIn(configuration) === 'none' ? structuredClone(plan.command) : builtInSandboxCommand(plan);
// How a check's evidence names where the tests ran, so the dashboard shows it.
export const sandboxLabel = configuration =>
  runsIn(configuration) === 'none' ? 'without a sandbox' : 'in the built-in sandbox';
export const sandboxRecord = configuration =>
  runsIn(configuration) === 'none'
    ? { provider: 'none', network: 'unrestricted' }
    : { provider: 'sandbox-runtime', version: builtInSandboxVersion, network: 'loopback-tests' };
// The record of a candidate tested in the Codex sandbox before 1.0.1, which stays valid for its review.
export const codexSandboxRecord = configuration => ({
  provider: 'codex',
  implementation: configuration?.windowsSandbox || 'platform default',
  profile: 'studio-source-tests',
  network: 'loopback-tests',
});

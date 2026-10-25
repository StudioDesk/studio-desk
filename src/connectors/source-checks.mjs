// Trusted, controller-owned operation. Run the installed Node test runner on a
// copied source tree; assignments cannot supply commands, paths or environment.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash } from '../core/contracts.mjs';
import { studioDeskProfile, profileOf, recordedProfile, snapshotPaths, isTestFile } from './source-profile.mjs';

export const studioSourceRoot = fileURLToPath(new URL('../../', import.meta.url));
// Every path a Studio desk snapshot covers; other profiles list theirs (snapshotPaths).
export const sourcePaths = Object.freeze(snapshotPaths(studioDeskProfile));
// The largest single file a Studio desk snapshot, and so a candidate, may hold.
export const maxSourceFileBytes = studioDeskProfile.limits.fileBytes;
// A git checkout has no empty folders, but a snapshot expects every allowlisted one.
export function ensureSourceDirectories(root, profile = studioDeskProfile) {
  for (const directory of profile.directories) fs.mkdirSync(path.join(root, directory), { recursive: true });
}
export const sourceChecksConnector = Object.freeze({
  id: 'local-source-checks',
  version: 'source-checks-v1',
  operation: 'node-tests',
  operationVersion: 'node-tests-v1',
  resource: 'source:studio-desk-tests',
});
// The fixed Node test command that intake checks, candidates and integration verification run.
// Each test may run for at most sourceTestTimeoutMs, and the runner exits once every test has
// finished, so a hung test, or a test file whose process never exits, ends the suite with a report
// (the test counts as cancelled and names its timeout) instead of holding the attempt to its time
// limit (MP-016 slice 4 step (b), known issue 15). The slowest test took about 21 s locally and
// 11 s in the candidate sandbox on October 20, 2026. A hang outside any test is not bounded.
export const sourceTestTimeoutMs = 120 * 1000;
export const sourceTestArgs = (tests, timeoutMs = sourceTestTimeoutMs) => [
  '--test',
  '--test-reporter=tap',
  `--test-timeout=${timeoutMs}`,
  '--test-force-exit',
  ...tests,
];

export function sourcePlan(root = studioSourceRoot, profile = studioDeskProfile) {
  root = fs.realpathSync(root);
  const manifest = [],
    { limits } = profile;
  let total = 0;
  const visit = relative => {
    const target = path.join(root, relative),
      stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error('Source snapshots do not follow symbolic links.');
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(target).sort()) visit(relative + '/' + name);
      return;
    }
    if (!stat.isFile() || manifest.length >= limits.files) throw new Error('Source snapshot exceeds its file limits.');
    // The per-file limit bounds what a story may edit and a review reads in a diff. A file of a type no
    // story edits (a photo) is only copied, which the total bounds.
    if (stat.size > limits.fileBytes && profile.extensions.includes(path.extname(relative).slice(1).toLowerCase()))
      throw new Error(
        `${relative} is larger than the ${Math.round(limits.fileBytes / 1024)} KB a file a story may edit can be.`,
      );
    total += stat.size;
    if (total > limits.totalBytes)
      throw new Error(`Source snapshot exceeds ${Math.round(limits.totalBytes / 1024 / 1024)} MB.`);
    manifest.push({ path: relative, bytes: stat.size, hash: hash(fs.readFileSync(target)) });
  };
  for (const item of snapshotPaths(profile)) {
    // Git keeps no empty folders, so a profile folder without files yet (a new tests folder) has nothing to measure.
    if (profile.directories.includes(item) && !fs.existsSync(path.join(root, item))) continue;
    visit(item);
  }
  manifest.sort((a, b) => a.path.localeCompare(b.path));
  const tests = manifest.filter(item => isTestFile(item.path, profile)).map(item => item.path);
  // Studio desk always has tests. Another repository may have none yet: the runner then gets the
  // profile's own pattern, which matches nothing, so no tests run (with no file arguments the
  // runner would search the whole copy) and the report says so.
  if (!tests.length && profile.id === studioDeskProfile.id) throw new Error('No registered source tests were found.');
  return {
    connector: sourceChecksConnector,
    root,
    files: manifest,
    sourceHash: hash(JSON.stringify(manifest)),
    nodeVersion: process.version,
    command: {
      executable: process.execPath,
      args: sourceTestArgs(tests.length ? tests : [`${profile.tests.directory}/*${profile.tests.suffix}`]),
    },
    ...recordedProfile(profile),
  };
}
export function copySource(plan, destination) {
  // Re-resolve the recorded profile's allowlist before copying. No persisted/task-provided
  // manifest can introduce runtime records or an external source path.
  const profile = profileOf(plan);
  if (JSON.stringify(sourcePlan(plan.root, profile)) !== JSON.stringify(plan))
    throw new Error('Source changed after its attempt snapshot. Start a newly scoped attempt.');
  fs.mkdirSync(destination, { recursive: true });
  ensureSourceDirectories(destination, profile);
  for (const item of plan.files) {
    const bytes = fs.readFileSync(path.join(plan.root, item.path));
    if (hash(bytes) !== item.hash) throw new Error('Source changed while copying.');
    const target = path.join(destination, item.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { flag: 'wx' });
  }
}
export function verifyCopy(plan, destination) {
  for (const item of plan.files)
    if (hash(fs.readFileSync(path.join(destination, item.path))) !== item.hash)
      throw new Error('A source test changed the copied source.');
  if (JSON.stringify(sourcePlan(destination, profileOf(plan)).files) !== JSON.stringify(plan.files))
    throw new Error('A source test added or removed copied source files.');
}
export function testTotals(log) {
  const values = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...log.matchAll(new RegExp('^# ' + key + ' (\\d+)\\r?$', 'gm'))];
    if (!matches.length) throw new Error('The test runner did not emit complete TAP totals.');
    values[key] = Number(matches.at(-1)[1]);
  }
  // Zero tests is a repository without tests yet (sourcePlan); Studio desk's runs always name test files,
  // and the runner counts a file that fails to load as a failed test.
  if (values.pass + values.fail + values.cancelled + values.skipped + values.todo !== values.tests)
    throw new Error('Test totals are inconsistent.');
  return values;
}
// Partial/cancelled process output may have no final summary. Never invent zero totals.
export function testPhaseEvidence(log) {
  let totals = null;
  try {
    totals = testTotals(log);
  } catch {}
  const durations = [...log.matchAll(/^# duration_ms (\d+(?:\.\d+)?)\r?$/gm)];
  return {
    totals,
    tapDurationMs: durations.length ? Number(durations.at(-1)[1]) : null,
    failedTests: failedTests(log),
  };
}
// Names of failed top-level tests, with their file and, when the TAP diagnostics carry one,
// the start of their error, for the director's run story and automatic retries.
export function failedTests(log) {
  const lines = log.split(/\r?\n/),
    failed = [];
  lines.forEach((line, index) => {
    const match = /^not ok \d+ - (.+)$/.exec(line);
    if (!match || failed.length >= 20) return;
    let file = '',
      error = '';
    for (let next = index + 1; next < lines.length && next < index + 80 && lines[next] !== '  ...'; next++) {
      if (/^(?:(?:not ok|ok) \d+ - |# Subtest:)/.test(lines[next])) break;
      const location = /^ {2}location: '(.+?):\d+:\d+'$/.exec(lines[next]);
      if (location)
        file = location[1]
          .split(/[\\/]+/)
          .at(-1)
          .slice(0, 300);
      const inline = /^ {2}error: (?!\|)(.+)$/.exec(lines[next]);
      if (inline && !error) error = inline[1].replace(/^'(.*)'$/, '$1');
      if (/^ {2}error: \|/.test(lines[next]) && !error) {
        const block = [];
        for (let more = next + 1; more < lines.length && /^ {4}/.test(lines[more]) && block.length < 8; more++)
          block.push(lines[more].trim());
        error = block.filter(Boolean).join(' ');
      }
    }
    failed.push({ name: match[1].trim().slice(0, 300), file, ...(error ? { error: error.slice(0, 600) } : {}) });
  });
  return failed;
}
// The context documents the profile names, which the breakdown and reviews read.
export function sourceContext(plan, destination) {
  const recorded = relative => {
    const item = plan.files.find(item => item.path === relative);
    if (!item) throw new Error(`The context document ${relative} is not in the measured source.`);
    return item.hash;
  };
  const documents = profileOf(plan).contextFiles.map(relative => ({
    path: relative,
    hash: recorded(relative),
    text: fs.readFileSync(path.join(destination, relative), 'utf8'),
  }));
  return { schemaVersion: 'source-context-v1', sourceHash: plan.sourceHash, documents };
}
// Checks since MP-016 slice 4 measure a commit, which their report names.
const reportSource = plan => ({
  root: plan.root,
  ...(plan.base ? { commit: plan.base.commit } : {}),
  hash: plan.sourceHash,
  files: plan.files,
});
export function validateCheckReport(report, plan, execution, stdout, stderr) {
  const totals = testTotals(stdout),
    passed =
      execution.exitCode === 0 &&
      !execution.signal &&
      !totals.fail &&
      !totals.cancelled &&
      !totals.skipped &&
      !totals.todo;
  const expected = {
    schemaVersion: 'source-check-report-v1',
    connector: plan.connector,
    source: reportSource(plan),
    nodeVersion: plan.nodeVersion,
    command: plan.command,
    execution,
    totals,
    ...(report.failedTests !== undefined ? { failedTests: failedTests(stdout) } : {}),
    passed,
    stdoutHash: hash(stdout),
    stderrHash: hash(stderr),
    unperformedChecks: ['Browser layout', 'Installed model quality', 'Engine integration', 'Playtest'],
  };
  if (JSON.stringify(report) !== JSON.stringify(expected))
    throw new Error('Source check report does not match its recorded execution and logs.');
  return expected;
}
// How measured totals read in summaries: a repository without tests says so rather than "0/0 passed".
export const testsSentence = totals =>
  totals.tests ? `${totals.pass}/${totals.tests} tests passed` : 'no tests ran (the repository has none yet)';
export function checkReport(plan, execution, stdout, stderr) {
  const totals = testTotals(stdout);
  return {
    schemaVersion: 'source-check-report-v1',
    connector: plan.connector,
    source: reportSource(plan),
    nodeVersion: plan.nodeVersion,
    command: plan.command,
    execution,
    totals,
    failedTests: failedTests(stdout),
    passed:
      execution.exitCode === 0 &&
      !execution.signal &&
      !totals.fail &&
      !totals.cancelled &&
      !totals.skipped &&
      !totals.todo,
    stdoutHash: hash(stdout),
    stderrHash: hash(stderr),
    unperformedChecks: ['Browser layout', 'Installed model quality', 'Engine integration', 'Playtest'],
  };
}

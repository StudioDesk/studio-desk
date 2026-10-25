// A project's build command (1.1, MP-028). A repository's settings can name a build or type-check command, which runs
// before the tests on every candidate, integration, carry forward and Release, wrapped in the same test sandbox, so a
// change that breaks the build goes back to its editor before review. The build must leave the files the settings
// cover as they were: its output goes to a folder they leave out.
import path from 'node:path';
import { npmCli } from './package-installs.mjs';

export const buildTimeoutMs = 15 * 60 * 1000;
// How much of a build's output a candidate keeps, from the end, where a failure explains itself.
export const buildOutputBytes = 192 * 1024;

// The process a profile's build runs as, or null when the profile builds nothing. npm, npx and node run with the
// Node.js that runs the controller, as the install and the formatter do, so no shell is needed to find them on
// Windows; any other program runs by its name from the PATH.
export function buildCommand(profile) {
  if (!profile?.build) return null;
  const [program, ...args] = profile.build,
    purpose = 'the build cannot run';
  if (program === 'node') return { executable: process.execPath, args };
  if (program === 'npm') return { executable: process.execPath, args: [npmCli(purpose), ...args] };
  if (program === 'npx')
    return { executable: process.execPath, args: [path.join(path.dirname(npmCli(purpose)), 'npx-cli.js'), ...args] };
  return { executable: program, args };
}

// How the build command reads in evidence: as the settings wrote it.
export const buildText = profile => profile.build.join(' ');

// The last lines of a build's output, for a check's evidence and the editor's next try.
export const buildTail = (output, lines = 15) =>
  String(output || '')
    .trim()
    .split(/\r?\n/)
    .slice(-lines)
    .join('\n')
    .slice(-1500);

export const buildPassed = execution => execution.exitCode === 0 && !execution.signal && !execution.timedOut;

export const changedByBuild =
  'The build changed files the repository settings cover. A build must write its output to a folder they leave out.';

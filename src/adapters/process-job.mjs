// An attempt's process tree kept together on Windows (C-07, November 2026): a command started through
// src/adapters/windows-job.ps1 runs inside a job of its own, so whatever it starts, detached or orphaned, ends with it:
// when its main process ends (what it left running is ended and counted, the director's rule 2), when the wrapper is
// ended, and when the controller ends. Try's Run keeps what it started until Stop (`keep`). Elsewhere, and on a
// computer where PowerShell cannot run the wrapper (a managed machine's Constrained Language Mode, say), commands start
// as before, and the controller says so once.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const windowsJobScript = fileURLToPath(new URL('./windows-job.ps1', import.meta.url));
// Windows PowerShell by its full path, never whatever a PATH would find first.
export const windowsPowerShell = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);
// The exit code the wrapper uses when it could not start the command at all.
export const jobStartFailed = 9901;

// One argument quoted as Windows programs read their command line (the C runtime's rules, as Node quotes them).
export function quoteWindowsArgument(argument) {
  const text = String(argument);
  if (text === '') return '""';
  if (!/[\s"]/.test(text)) return text;
  let quoted = '"',
    backslashes = 0;
  for (const character of text) {
    if (character === '\\') backslashes++;
    else if (character === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      quoted += '\\'.repeat(backslashes) + character;
      backslashes = 0;
    }
  }
  return quoted + '\\'.repeat(backslashes * 2) + '"';
}
export const windowsCommandLine = (file, args) => [file, ...args].map(quoteWindowsArgument).join(' ');

// How to start a command inside a job of its own: the wrapper, with the command line and its options passed in the
// environment (PowerShell's own argument parsing changes embedded quotes), or the command as it is.
export function jobbedCommand(file, args, environment, { report = '', keep = false, enabled = true } = {}) {
  if (!enabled) return { file, args, environment };
  return {
    file: windowsPowerShell,
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', windowsJobScript],
    environment: {
      ...environment,
      STUDIO_JOB_COMMAND_LINE: windowsCommandLine(file, args),
      STUDIO_JOB_REPORT: report,
      STUDIO_JOB_KEEP: keep ? '1' : '',
    },
  };
}

// What the wrapper reported about a finished command: its exit code and how many processes it left running.
export function readJobReport(file) {
  try {
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Number.isInteger(report.exitCode) && Number.isInteger(report.leftovers) ? report : null;
  } catch {
    return null;
  } finally {
    fs.rmSync(file, { force: true });
  }
}

// Whether this computer runs the wrapper: once, by running a command that exits with a known code through it.
export function processJobsWork({ platform = process.platform, run = spawnSync } = {}) {
  if (platform !== 'win32') return false;
  const command = jobbedCommand(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'exit 37'], process.env);
  const result = run(command.file, command.args, {
    env: command.environment,
    windowsHide: true,
    timeout: 30000,
    stdio: 'ignore',
  });
  return result.status === 37;
}

export const processJobsMissing =
  "Windows PowerShell could not run Studio desk's job wrapper here, so an attempt's processes are not kept together: " +
  'anything an agent or a test starts detached can outlive the attempt. Check that PowerShell runs scripts with ' +
  '-ExecutionPolicy Bypass for this account.';

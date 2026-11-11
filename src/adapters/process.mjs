import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

// A process is known by its ID and by when it started. An operating system hands a freed ID to a later process (Windows
// does so quickly), so an ID alone cannot tell a recorded process from a later one that now has its ID. A record that
// holds when its process started (an ISO time taken right after the spawn returns, so the recorded process started at
// or before it) is checked against the start time of whatever holds the ID now; a record without one keeps the ID-only
// answer it always had.

// How much later than the recorded time the process holding the ID may have started and still be the recorded one: the
// record is taken after the spawn returns, and the slack absorbs clock granularity (whole seconds in macOS's ps and in
// Linux's boot time).
export const startTimeSlackMs = 2000;
const queryTimeoutMs = 15000;
const validPid = pid => Number.isInteger(pid) && pid > 0;

// Windows PowerShell by its full path, never whatever a PATH would find first (as src/adapters/process-job.mjs).
const windowsPowerShell = () =>
  path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
// Get-Process first (quick); its StartTime can be refused for another account's process, which CIM still reads. Prints
// the start in milliseconds since 1970, 'gone' or 'unknown'. The ID is checked as a positive integer before it is
// written into the script, which travels encoded as one argument.
const windowsStartScript = pid => `$ErrorActionPreference = 'Stop'
$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if (-not $p) { 'gone'; exit 0 }
$t = $null
try { $t = $p.StartTime } catch { $t = $null }
if (-not $t) {
  $c = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=${pid}'
  if (-not $c) { 'gone'; exit 0 }
  $t = $c.CreationDate
}
if ($t) { ([DateTimeOffset]$t).ToUnixTimeMilliseconds() } else { 'unknown' }`;

let linuxTicks = null;
// Clock ticks per second of /proc/<pid>/stat's start time (USER_HZ: 100 on mainstream Linux when getconf is missing).
function linuxClockTicks(run) {
  if (linuxTicks) return linuxTicks;
  let ticks = NaN;
  try {
    const result = run('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: queryTimeoutMs });
    if (result.status === 0) ticks = Number(String(result.stdout || '').trim());
  } catch {
    // Fall back to 100 below.
  }
  return (linuxTicks = Number.isInteger(ticks) && ticks > 0 ? ticks : 100);
}

// When the process that now holds an ID started, from the operating system: a Date, 'gone' (no process has the ID) or
// 'unknown' (the query could not run or could not read it). Every query is an argument array, never a shell string.
// `platform`, `run` (spawnSync) and `readFile` are replaceable so each system's reader can be checked on any computer.
export function readProcessStartTime(
  pid,
  { platform = process.platform, run = spawnSync, readFile = fs.readFileSync } = {},
) {
  if (!validPid(pid)) return 'unknown';
  try {
    if (platform === 'win32') {
      const script = Buffer.from(windowsStartScript(pid), 'utf16le').toString('base64');
      const result = run(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', script], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: queryTimeoutMs,
      });
      if (result.status !== 0) return 'unknown';
      const text = String(result.stdout || '').trim();
      if (text === 'gone') return 'gone';
      return /^\d+$/.test(text) ? new Date(Number(text)) : 'unknown';
    }
    if (platform === 'linux' || platform === 'android') {
      let stat;
      try {
        stat = String(readFile(`/proc/${pid}/stat`, 'utf8'));
      } catch (error) {
        return error.code === 'ENOENT' || error.code === 'ESRCH' ? 'gone' : 'unknown';
      }
      // The command name (field 2) may hold spaces and parentheses: the fields after its last ')' start at field 3, so
      // the start time, field 22, is the 20th of them, in clock ticks since boot.
      const fields = stat
        .slice(stat.lastIndexOf(')') + 1)
        .trim()
        .split(/\s+/);
      const ticks = Number(fields[19]);
      const boot = Number(/^btime\s+(\d+)\s*$/m.exec(String(readFile('/proc/stat', 'utf8')))?.[1]);
      if (!fields[19] || !Number.isFinite(ticks) || !Number.isFinite(boot) || !boot) return 'unknown';
      return new Date(boot * 1000 + Math.round((ticks * 1000) / linuxClockTicks(run)));
    }
    if (platform === 'darwin') {
      const result = run('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: queryTimeoutMs,
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      });
      const text = String(result.stdout || '').trim();
      // ps answers 1 with nothing printed when no process has the ID.
      if (result.status === 1 && !text) return 'gone';
      if (result.status !== 0 || !text) return 'unknown';
      const at = new Date(text.replace(/\s+/g, ' '));
      return Number.isNaN(at.getTime()) ? 'unknown' : at;
    }
  } catch {
    return 'unknown';
  }
  return 'unknown';
}

// The start time reader the checks below use, replaceable in tests (t.mock.method(processStartTimes, 'read', ...)) so
// they never depend on another account's processes.
export const processStartTimes = { read: pid => readProcessStartTime(pid) };

function recordedStart(startedAt) {
  if (startedAt === undefined || startedAt === null || startedAt === '') return null;
  const at = startedAt instanceof Date ? startedAt.getTime() : Date.parse(startedAt);
  return Number.isFinite(at) ? at : null;
}

// Whether the process recorded as `pid`, started at `startedAt`, is over. `target` is what signal 0 goes to: the ID, or
// on macOS and Linux the negated ID of the process group it leads. With `group`, a group that still answers while its
// leader is gone is still the recorded group, since an ID cannot be handed to a new process while a group with that ID
// exists.
//
// Assumption: Studio desk records only processes it started itself, under its own account. So when a start time was
// recorded and this account may not look at the ID (EPERM), the ID belongs to another account's process unless the
// operating system shows it started no later than the record allows; when its start time cannot be read, it counts as
// ended. Without a recorded start time the answer stays the ID-only one it always was: only "no such process" counts as
// gone, and EPERM counts as running.
function recordedEnded(pid, target, startedAt, group, read) {
  if (!pid) return true;
  let refused = false;
  try {
    process.kill(target, 0);
  } catch (e) {
    // Gone without asking the operating system anything more, so the usual close and finish paths stay as quick.
    if (e.code === 'ESRCH') return true;
    refused = e.code === 'EPERM';
  }
  const recorded = recordedStart(startedAt);
  if (recorded === null) return false;
  const now = read(pid);
  const at = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : NaN;
  if (Number.isFinite(at)) return at > recorded + startTimeSlackMs;
  // 'gone': a single process ended after it answered; a group that still answers is the recorded group unless it
  // belongs to another account. 'unknown': a process this account may signal stays running, as before.
  if (now === 'gone') return refused || !group;
  return refused;
}

// Whether one process is over, the single-process check every caller shares: no ID, no process with the ID, or a start
// time was recorded and the process holding the ID now started more than startTimeSlackMs after it (an ID this account
// may not look at: see the assumption above). `readStartTime` replaces the operating system's reader.
export function processEnded(pid, startedAt, { readStartTime = processStartTimes.read } = {}) {
  return recordedEnded(pid, pid, startedAt, false, readStartTime);
}

// Whether an attempt's process is still running: on macOS and Linux the process group it leads, on Windows the process
// itself. a.pidStartedAt (an ISO time) is the attempt's own start time when it recorded one; with it, a leader ID that
// now belongs to a later process is not live. a.processJobEndedAt is recorded only when a controller starts again on an
// attempt the previous one left running in a job of its own (a.processJob, src/adapters/process-job.mjs, Runner's
// constructor): that job ended with the controller that held its only handle, so nothing of the attempt runs, and its
// ID, which Windows may have handed to another program since, is neither signalled nor looked up.
export function live(a) {
  if (a.processJobEndedAt) return false;
  const windows = process.platform === 'win32';
  return !recordedEnded(a.pid, windows ? a.pid : -a.pid, a.pidStartedAt, !windows, processStartTimes.read);
}
// Strips API-key and alternate-provider variables so a CLI can only use its subscription
// login. `safeMode` (Claude text mode) also turns off the CLI's own customizations.
export function subscriptionEnvironment(provider = 'codex', { safeMode = true } = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      /API_KEY$/i.test(key) ||
      ['OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID', 'CODEX_ACCESS_TOKEN'].includes(key.toUpperCase()) ||
      (provider === 'claude' && (/^ANTHROPIC_/i.test(key) || (/^CLAUDE/i.test(key) && key !== 'CLAUDE_CONFIG_DIR')))
    )
      delete env[key];
  if (provider === 'claude')
    Object.assign(env, {
      ...(safeMode ? { CLAUDE_CODE_SAFE_MODE: '1' } : {}),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      DO_NOT_TRACK: '1',
      MAX_STRUCTURED_OUTPUT_RETRIES: '1',
    });
  return env;
}
export function command(binary, args) {
  return binary.endsWith('.js') || binary.endsWith('.mjs') ? [process.execPath, [binary, ...args]] : [binary, args];
}

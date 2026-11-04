import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { command, subscriptionEnvironment, live } from './process.mjs';
import { jobStartFailed, jobbedCommand, processJobsMissing, processJobsWork, readJobReport } from './process-job.mjs';
import { usageReset, reportedReset } from '../core/usage-reset.mjs';
import { flushSay } from '../core/attempt-trace.mjs';

export function runNative(
  entry,
  binary,
  args,
  prompt,
  readResult,
  {
    cwd = entry.output,
    environment = subscriptionEnvironment(entry.attempt.provider),
    resultOnFailure = false,
    onComplete,
  } = {},
) {
  const { attempt: a, output } = entry;
  const [bin, argv] = command(binary, args);
  // On Windows the CLI runs in a job of its own, so whatever it starts ends with it: what its main process leaves
  // running is ended and counted when it exits, and the whole tree ends with the controller (C-07). Asked of this
  // computer once; where the wrapper cannot run, the CLI starts as before and the attempt's log says so.
  if (this.processJobs === undefined) this.processJobs = processJobsWork();
  if (process.platform === 'win32' && !this.processJobs && !this.processJobsWarned) {
    this.processJobsWarned = true;
    this.store.event('log', a.taskId, a.id, `controller: ${processJobsMissing}`);
  }
  const report = this.processJobs
      ? path.join(entry.job || output, `process-job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
      : '',
    started = jobbedCommand(bin, argv, environment, { report, enabled: !!this.processJobs });
  const child = spawn(started.file, started.args, {
    cwd,
    env: started.environment,
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  entry.child = child;
  a.pid = child.pid || null;
  // When it started, so a later process that is handed the same ID is not taken for it (adapters/process.mjs, live()):
  // taken right after the spawn returns, so the process started at or before it.
  if (a.pid) a.pidStartedAt = new Date().toISOString();
  else delete a.pidStartedAt;
  // Whether that process holds the whole tree: in a job, it ending, or the controller ending, ends everything the CLI
  // started, so after a restart a recorded process that is gone means nothing of the attempt still runs.
  if (this.processJobs) a.processJob = true;
  else delete a.processJob;
  this.store.updateAttempt(a);
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
  for (const channel of ['stdout', 'stderr']) {
    child[channel].setEncoding('utf8');
    child[channel].on('data', chunk => this.parseOutput(entry, channel, chunk));
  }
  child.on('error', err => {
    entry.spawnError = err.message;
  });
  child.on('close', (code, signal) => {
    // Shutdown let go of a process it could not confirm stopped (Runner.abandon); its store is closed and
    // its reservations wait for reconciliation, so this close records nothing.
    if (entry.abandoned) return;
    for (const ch of ['stdout', 'stderr']) if (entry.buffers[ch]) this.recordLine(entry, ch, entry.buffers[ch]);
    // What the CLI's main process left running was ended before the wrapper exited (the director's rule 2); the
    // attempt records how many, so nothing of it still runs when its reservations are released.
    const job = report ? readJobReport(report) : null;
    if (job?.leftovers) {
      a.leftoverProcesses = (a.leftoverProcesses || 0) + job.leftovers;
      this.store.updateAttempt(a);
      this.store.event(
        'log',
        a.taskId,
        a.id,
        `controller: The CLI's main process ended and left ${job.leftovers} process${job.leftovers === 1 ? '' : 'es'} running; ${job.leftovers === 1 ? 'it was' : 'they were'} ended.`,
      );
    }
    if (report && !job && code === jobStartFailed && !entry.cancelled)
      entry.spawnError ??= 'The CLI could not be started in its job (src/adapters/windows-job.ps1). See recorded logs.';
    // On macOS and Linux the CLI's whole process group was signalled with it, and its other members may still be ending
    // when the main process closes. Under load that took long enough for a stopped attempt to be quarantined as if
    // something of it still ran (found in the 1.2 release proof on Linux, November 4, 2026). So a group still live at
    // the close is looked at again for a moment first. Nothing is released while it waits, and a group that keeps
    // running is still quarantined.
    const settle = () => {
      if (entry.abandoned) return;
      if (live(a)) {
        clearTimeout(entry.timer);
        const { status, finishedAt, requeue } = a;
        // The attempt, its task and the event are saved in one step; a failure leaves both as they were. The task is
        // written to the store directly, as before (not through the runner's stage view mapping).
        try {
          this.store.tx(() => {
            const t = this.store.task(a.taskId);
            a.status = 'quarantined';
            a.finishedAt = new Date().toISOString();
            // As at a restart: queued work leaves the queue until Reconcile puts it back (Runner.holdQueue).
            this.holdQueue(a, t);
            this.store.updateAttempt(a);
            t.status = 'blocked';
            t.reason = 'CLI exited but its process group is still live. Reservations retained until reconciliation.';
            this.store.putTask(t);
            this.store.event('quarantined', a.taskId, a.id, t.reason);
          });
        } catch (failure) {
          a.status = status;
          if (finishedAt === undefined) delete a.finishedAt;
          else a.finishedAt = finishedAt;
          if (requeue === undefined) delete a.requeue;
          else a.requeue = requeue;
          throw failure;
        }
        this.active.delete(a.id);
        return;
      }
      let result = null,
        error = entry.spawnError || entry.nativeError,
        // A failure the CLI reported: one it wrote (nativeFailure), or a failing exit with no other error.
        reported = !!error && error === entry.reportedFailure;
      if (!entry.cancelled && !error && (code === 0 || resultOnFailure)) {
        try {
          result = readResult(code, signal);
        } catch (err) {
          error = `CLI result rejected: ${err.message}`;
        }
      } else if (!entry.cancelled && !error) {
        error = `CLI exited with code ${code}. See recorded logs.`;
        reported = true;
      }
      // A limit reported as reached makes that failure the usage limit, whichever the CLI reported first,
      // unless the attempt reported a sign-in, login or permission failure (nativeFailure).
      if (reported && !entry.quota && limitHolds(entry)) this.nativeFailure(entry, error);
      // Continue only after the process/group is confirmed stopped. Keep the
      // attempt's original time budget and resource reservations between phases.
      entry.buffers = {};
      if (onComplete && !entry.cancelled && !error) {
        try {
          onComplete(result, code, signal);
        } catch (err) {
          this.finish(entry, null, err.message);
        }
      } else this.finish(entry, result, error);
    };
    if (process.platform !== 'win32' && live(a)) waitForGroup(() => live(a), entry, settle);
    else settle();
  });
}

// How long a stopped CLI's process group may take to empty after its main process closes, and how often it is looked
// at in the meantime. `isLive` answers whether the group still runs; `then` decides once it has emptied, the wait has
// run out, or shutdown let go of the attempt.
export const groupSettleMs = 3000;
export const groupSettleStepMs = 100;
export function waitForGroup(isLive, entry, then, until = Date.now() + groupSettleMs) {
  if (entry.abandoned || !isLive() || Date.now() >= until) return then();
  setTimeout(() => waitForGroup(isLive, entry, then, until), groupSettleStepMs);
}
// How much of an attempt's output becomes activity rows, how much its activity file keeps, and the
// longest single line held in memory. Volume never stops the work; the time limit bounds it. A Claude
// stream (a thinking event a second and whole tool results) passed the old 2 MB stop in 11 minutes
// (v1.0 tally row 7).
export const activityRowBytes = 2 * 1024 * 1024,
  activityFileBytes = 64 * 1024 * 1024,
  outputLineBytes = 8 * 1024 * 1024;
export function parseOutput(entry, channel, text) {
  const buffered = (entry.buffers[channel] || '') + text;
  const lines = buffered.split('\n');
  entry.buffers[channel] = lines.pop();
  for (const line of lines) this.recordLine(entry, channel, line);
  if (entry.buffers[channel].length > outputLineBytes && !entry.nativeError) {
    entry.nativeError = `The CLI wrote a single output line over ${outputLineBytes / 1024 / 1024} MB, which the controller does not hold.`;
    if (!entry.cancelled) this.stop(entry.attempt.id);
  }
}
// Every line goes to the attempt's activity file, the full record of what the CLI wrote, up to its own
// ceiling; only the first activityRowBytes also become activity rows the dashboard reads.
function keepActivity(entry, channel, line) {
  const bytes = Buffer.byteLength(line);
  if (entry.job && !entry.activityFileFull) {
    const file = path.join(entry.job, 'activity.jsonl'),
      record = JSON.stringify({ time: new Date().toISOString(), channel, line }) + '\n';
    entry.activityFileBytes = (entry.activityFileBytes || 0) + Buffer.byteLength(record);
    if (entry.activityFileBytes > activityFileBytes) {
      entry.activityFileFull = true;
      fs.appendFileSync(
        file,
        JSON.stringify({
          time: new Date().toISOString(),
          channel: 'controller',
          line: `The activity file stopped at ${activityFileBytes / 1024 / 1024} MB; the attempt continued.`,
        }) + '\n',
      );
    } else fs.appendFileSync(file, record);
  }
  entry.activityRowBytes = (entry.activityRowBytes || 0) + bytes;
  if (entry.activityRowBytes <= activityRowBytes) return true;
  if (!entry.activityRowsFull) {
    entry.activityRowsFull = true;
    this.store.event(
      'log',
      entry.attempt.taskId,
      entry.attempt.id,
      `controller: The activity log stopped recording at ${activityRowBytes / 1024 / 1024} MB; the attempt continues, and its full output is in its activity file.`,
    );
  }
  return false;
}
export function recordLine(entry, channel, line) {
  if (!line.trim()) return;
  const a = entry.attempt;
  if (channel === 'stdout') {
    try {
      const data = JSON.parse(line);
      entry.adapter.recordEvent?.(this, entry, data);
      // The latest message the adapter noted, for Today's speech bubble, at most once every 10 seconds.
      flushSay.call(this, entry);
      // The model the CLI reports, written once when it changes; no task's readiness depends on it (C-19).
      if (typeof data.model === 'string' && a.reportedModel !== data.model) {
        a.reportedModel = data.model;
        this.store.updateAttempt(a, { trace: true });
      }
      if (data.type === 'error' || data.type === 'turn.failed')
        this.nativeFailure(entry, data.message || data.error?.message || 'CLI reported a failure.');
      if (data.item?.type === 'mcp_tool_call') {
        entry.nativeError = 'An unexpected MCP tool call was observed. This adapter does not grant editor tools.';
        this.stop(a.id);
      }
    } catch {}
  }
  if (keepActivity.call(this, entry, channel, line)) this.store.event('log', a.taskId, a.id, `${channel}: ${line}`);
}
// Whether the CLI reported a limit as reached during the attempt (claude.mjs keeps each such report's
// reset time in reportedResets, readable or not; Codex records none) and so makes its failures the usage
// limit: never once the attempt reported a sign-in, login or permission failure, which the director decides.
const limitHolds = entry => !!entry.reportedResets?.length && !entry.accessFailure;
// A failure the CLI reported. It is a usage limit when its wording says so or, whatever its wording,
// when the CLI reported a reached limit; the close handler decides a failure reported before that report.
export function nativeFailure(entry, message) {
  entry.nativeError = entry.reportedFailure = String(message);
  // The attempt keeps that it reported such a failure, whichever came first, it or the reached limit,
  // and whatever a later failure says.
  if (/permission|authentication|sign.in|log.in|unauthorized|invalid.api.key/i.test(message))
    entry.needsDecision = entry.accessFailure = true;
  if (limitHolds(entry) || /usage limit|rate.limit|quota|limit reached|hit your limit/i.test(message)) {
    entry.quota = entry.quotaKey || entry.adapter.subscriptionProvider || entry.attempt.provider;
    // A reset time the CLI reported for a reached limit (the latest, when several limits were reached)
    // comes before one read from the message; the same rule checks both.
    const now = new Date(),
      reported = (entry.reportedResets || [])
        .map(seconds => reportedReset(seconds, now))
        .filter(Boolean)
        .sort()
        .at(-1);
    entry.quotaReset = reported || usageReset(message, now);
    const org = this.store.organization();
    org.quota[entry.quota] = true;
    // When the CLI names its reset time, and whether its report or its message named it (beside the
    // time, so org.quotaResets keeps its strings); an unknown time never keeps an earlier hold's.
    org.quotaResets ||= {};
    org.quotaResetSources ||= {};
    if (entry.quotaReset) {
      org.quotaResets[entry.quota] = entry.quotaReset;
      org.quotaResetSources[entry.quota] = reported ? 'report' : 'message';
    } else {
      delete org.quotaResets[entry.quota];
      delete org.quotaResetSources[entry.quota];
    }
    this.store.setOrganization(org);
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { command, subscriptionEnvironment, live } from './process.mjs';
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
  const child = spawn(bin, argv, {
    cwd,
    env: environment,
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  entry.child = child;
  a.pid = child.pid || null;
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
    if (live(a)) {
      clearTimeout(entry.timer);
      a.status = 'quarantined';
      a.finishedAt = new Date().toISOString();
      this.store.updateAttempt(a);
      const t = this.store.task(a.taskId);
      t.status = 'blocked';
      t.reason = 'CLI exited but its process group is still live. Reservations retained until reconciliation.';
      this.store.putTask(t);
      this.active.delete(a.id);
      this.store.event('quarantined', a.taskId, a.id, t.reason);
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
  });
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
      if (typeof data.model === 'string') {
        a.reportedModel = data.model;
        this.store.updateAttempt(a);
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

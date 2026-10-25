// An attempt's trace (v1.0 item 21): what its CLI did, step by step, as facts the dashboard words itself. Each
// adapter turns one line of its CLI's output into steps (`traceEvent(trace, data, at)`); this module reads the
// attempt's activity file, the full record of what the CLI wrote (native-process.mjs), bounds the steps and
// their output, and adds the controller's own records: phases and the handoff. The activity rows cut each line
// at 6,000 characters, so an attempt recorded before the activity file existed is read from them with the lines
// they cut counted as unread. Thinking is when and for how long, never its text: both CLIs keep it private.
import fs from 'node:fs';
import path from 'node:path';
import { jobDirectory } from './projects.mjs';

export const TRACE_SCHEMA = 'attempt-trace-v1';
// Each output keeps this many characters from each end; all outputs together share the budget, after which a
// step keeps its facts and drops its output. Past the step limit the first and last steps are kept.
export const traceLimits = {
  outputEnd: 1536,
  outputBudget: 1.5 * 1024 * 1024,
  headSteps: 750,
  tailSteps: 750,
  say: 8000,
  command: 4000,
  detail: 2000,
  reason: 1000,
};
const kinds = ['say', 'think', 'shell', 'read', 'search', 'edit', 'blocked', 'error', 'tool'];

export class AttemptTrace {
  constructor(job) {
    this.job = job;
    this.seq = 0;
    this.head = [];
    this.tail = [];
    this.omitted = null;
    this.omittedKinds = {};
    this.lines = 0;
    this.unreadLines = 0;
    this.activityCut = false;
    this.outputChars = 0;
    this.outputOmitted = false;
    this.thinkTokens = 0;
    this.pendingThinkTokens = 0;
    this.setup = null;
    this.usage = {};
    // An adapter's calls still waiting for their results, by the CLI's own ID.
    this.calls = new Map();
  }
  step(at, kind, facts = {}) {
    const step = { seq: this.seq++, at: at || null, kind, ...facts };
    if (this.head.length < traceLimits.headSteps) this.head.push(step);
    else {
      this.tail.push(step);
      if (this.tail.length > traceLimits.tailSteps) {
        const dropped = this.tail.shift();
        this.omitted ??= { afterSeq: this.head.at(-1).seq, count: 0 };
        this.omitted.count++;
        this.omittedKinds[dropped.kind] = (this.omittedKinds[dropped.kind] || 0) + 1;
      }
    }
    return step;
  }
  // A call's step becomes another kind once its result says what happened (a refusal, an error).
  retype(step, kind, facts) {
    for (const key of Object.keys(step)) if (key !== 'seq' && key !== 'at') delete step[key];
    return Object.assign(step, { kind, ...facts });
  }
  call(id, record) {
    if (typeof id !== 'string') return;
    this.calls.set(id, record);
    if (this.calls.size > 500) this.calls.delete(this.calls.keys().next().value);
  }
  text(value, limit) {
    if (value === undefined || value === null) return null;
    const text = typeof value === 'string' ? value : String(value);
    return text.length > limit ? text.slice(0, limit) : text;
  }
  say(value) {
    const text = String(value ?? '');
    return text.length > traceLimits.say ? { text: text.slice(0, traceLimits.say), cut: true } : { text };
  }
  output(value) {
    if (value === undefined || value === null) return null;
    const text = typeof value === 'string' ? value : JSON.stringify(value),
      end = traceLimits.outputEnd,
      cut = text.length > end * 2,
      kept = cut ? end * 2 : text.length;
    if (this.outputChars + kept > traceLimits.outputBudget) {
      this.outputOmitted = true;
      return null;
    }
    this.outputChars += kept;
    return {
      head: cut ? text.slice(0, end) : text,
      tail: cut ? text.slice(-end) : '',
      bytes: Buffer.byteLength(text),
      cut,
    };
  }
  // A path inside the attempt's job folder, relative to it with forward slashes; any other path as given.
  path(value) {
    if (typeof value !== 'string' || !value) return null;
    const relative = path.relative(this.job, path.resolve(this.job, value));
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
      ? relative.split(path.sep).join('/')
      : value.slice(0, traceLimits.detail);
  }
  // Claude Code estimates a thinking block's tokens as it goes, a running total that starts again with each
  // block, before the block itself arrives. The block's step takes the latest total, so a block whose line is
  // missing never adds to the next one's; the attempt's total adds every increase.
  thinking(delta, estimate) {
    if (Number.isFinite(delta) && delta > 0) this.thinkTokens += delta;
    if (Number.isFinite(estimate) && estimate >= 0) this.pendingThinkTokens = estimate;
  }
  // The estimate for the thinking block that just arrived.
  takeThinking() {
    const tokens = this.pendingThinkTokens;
    this.pendingThinkTokens = 0;
    return tokens || null;
  }
  // A usage window as the CLI reports it, in percent: the first report in the attempt and the latest.
  window(name, utilization, resetsAt) {
    if (typeof name !== 'string' || !Number.isFinite(utilization)) return;
    const percent = Math.round(utilization * 1000) / 10,
      windows = (this.usage.windows ||= {}),
      reset = Number.isFinite(resetsAt) ? new Date(resetsAt * 1000).toISOString() : null;
    windows[name] = { before: windows[name]?.before ?? percent, after: percent, resetsAt: reset };
  }
  tokens(values, { add = false } = {}) {
    const tokens = (this.usage.tokens ||= {});
    for (const [name, value] of Object.entries(values))
      if (Number.isFinite(value)) tokens[name] = (add ? tokens[name] || 0 : 0) + value;
  }
  counts() {
    const counts = Object.fromEntries(kinds.map(kind => [kind, this.omittedKinds[kind] || 0]));
    for (const step of [...this.head, ...this.tail]) if (step.kind in counts) counts[step.kind]++;
    return { ...counts, thinkTokens: this.thinkTokens };
  }
  snapshot(attempt, { after, source, phases }) {
    const steps = [...this.head, ...this.tail];
    return {
      schemaVersion: TRACE_SCHEMA,
      attemptId: attempt.id,
      taskId: attempt.taskId,
      provider: attempt.provider ?? null,
      model: attempt.reportedModel || attempt.requestedModel || null,
      effort: attempt.requestedEffort || attempt.configuration?.effort || null,
      status: attempt.status ?? null,
      startedAt: attempt.startedAt ?? null,
      finishedAt: attempt.finishedAt ?? null,
      durationMs: attemptDuration(attempt, phases),
      source,
      lines: this.lines,
      unreadLines: this.unreadLines,
      activityCut: this.activityCut,
      setup: this.setup,
      usage: this.usage,
      counts: this.counts(),
      steps: after === undefined ? steps : steps.filter(step => step.seq > after),
      omitted: this.omitted && { ...this.omitted },
      outputOmitted: this.outputOmitted,
      phases,
      handoff: handoff(attempt),
    };
  }
}

function attemptDuration(attempt, phases) {
  const finished = phases.find(phase => phase.phaseId === 'attempt' && phase.boundary === 'finish');
  if (Number.isFinite(finished?.durationMs)) return finished.durationMs;
  const duration = Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

function handoff(attempt) {
  const result = attempt.result;
  if (!result || typeof result !== 'object') return null;
  const text = value => (typeof value === 'string' ? value.slice(0, traceLimits.reason) : null);
  return {
    at: attempt.finishedAt ?? null,
    outcome: text(result.outcome),
    summary: text(result.summary),
    handoff: text(result.handoff),
  };
}

function tracePhases(store, attempt) {
  return store.phaseEvents(attempt.id).flatMap(event => {
    const p = event.payload;
    if (p?.schemaVersion !== 'source-phase-v1' || !['start', 'finish'].includes(p.boundary)) return [];
    return [
      {
        at: p.timestamp || event.time,
        phaseId: p.phaseId,
        boundary: p.boundary,
        outcome: p.outcome ?? null,
        durationMs: Number.isFinite(p.durationMs) ? p.durationMs : null,
      },
    ];
  });
}

function readRecord(trace, adapter, text) {
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    trace.unreadLines++;
    return;
  }
  trace.lines++;
  if (record.channel === 'controller') trace.activityCut = true;
  if (record.channel !== 'stdout' || !adapter?.traceEvent) return;
  readLine(trace, adapter, record.line, record.time);
}

function readLine(trace, adapter, line, at) {
  let data;
  try {
    data = JSON.parse(line);
  } catch {
    trace.unreadLines++;
    return;
  }
  if (data && typeof data === 'object') adapter.traceEvent(trace, data, at);
}

// Reads the activity file from where the last read stopped, a chunk at a time and without blocking the
// controller, consuming only complete lines: a line still being written is read next time.
async function readActivity(cached, adapter, file, size) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    let rest = Buffer.alloc(0),
      position = cached.offset;
    while (position < size) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - position), position);
      if (!bytesRead) break;
      position += bytesRead;
      let data = Buffer.concat([rest, chunk.subarray(0, bytesRead)]),
        newline;
      while ((newline = data.indexOf(10)) !== -1) {
        const text = data.subarray(0, newline).toString('utf8');
        cached.offset += newline + 1;
        if (text.trim()) readRecord(cached.trace, adapter, text);
        data = data.subarray(newline + 1);
      }
      rest = Buffer.from(data);
    }
  } finally {
    await handle.close();
  }
}

// An attempt recorded before the activity file: its activity rows, page by page.
function readRows(store, trace, adapter, attemptId) {
  let page = store.attemptEventPage(attemptId);
  for (;;) {
    for (const event of page.events) {
      const message = String(event.message || '');
      if (event.kind !== 'log') continue;
      if (message.startsWith('controller: ')) trace.activityCut = true;
      const match = /^(stdout|stderr): /.exec(message);
      if (!match) continue;
      trace.lines++;
      if (match[1] === 'stdout' && adapter?.traceEvent)
        readLine(trace, adapter, message.slice(match[0].length), event.time);
    }
    if (page.nextCursor === null) return;
    page = store.attemptEventPage(attemptId, { after: page.nextCursor, snapshot: page.snapshot });
  }
}

// Each traced attempt's parse state, newest use last: a running attempt's trace reads only what its CLI wrote
// since the last request, and a finished one is read once.
const cache = new Map(),
  reads = new Map(),
  cacheSize = 6;

async function updateTrace(store, attempt, adapter) {
  const job = jobDirectory(store, attempt),
    file = path.join(job, 'activity.jsonl');
  let cached = cache.get(attempt.id);
  cache.delete(attempt.id);
  const stat = await fs.promises.stat(file).catch(() => null);
  if (stat) {
    if (cached?.source !== 'activity-file' || stat.size < cached.offset)
      cached = { source: 'activity-file', trace: new AttemptTrace(job), offset: 0 };
    if (stat.size > cached.offset) await readActivity(cached, adapter, file, stat.size);
  } else if (!(cached?.source !== 'activity-file' && cached?.finished)) {
    cached = { source: 'log-rows', trace: new AttemptTrace(job) };
    readRows(store, cached.trace, adapter, attempt.id);
    if (cached.trace.lines === 0) cached.source = 'none';
    cached.finished = !['running', 'stopping'].includes(attempt.status);
  }
  cache.set(attempt.id, cached);
  while (cache.size > cacheSize) cache.delete(cache.keys().next().value);
  return cached;
}

export async function attemptTrace(store, attempt, adapter, { after } = {}) {
  // One read at a time per attempt: a request that arrives during one waits for it, then reads what is left.
  while (reads.has(attempt.id)) await reads.get(attempt.id).catch(() => {});
  const read = updateTrace(store, attempt, adapter);
  reads.set(attempt.id, read);
  let cached;
  try {
    cached = await read;
  } finally {
    reads.delete(attempt.id);
  }
  return cached.trace.snapshot(attempt, { after, source: cached.source, phases: tracePhases(store, attempt) });
}

// Today's speech bubble (v1.0 item 21): the running attempt's latest message, at most 280 characters, written
// to its record at most once every 10 seconds; a message held back goes out with the next line its CLI writes
// after that. No timer writes it: a write after the attempt finished would replace its final record.
export const sayLimits = { text: 280, floorMs: 10000 };
export function noteSay(entry, text, at = new Date().toISOString()) {
  if (typeof text !== 'string' || !text.trim()) return;
  entry.pendingSay = { text: text.trim().slice(0, sayLimits.text), at };
}
export function flushSay(entry, now = Date.now()) {
  if (!entry.pendingSay || now - (entry.sayWrittenAt ?? -Infinity) < sayLimits.floorMs) return false;
  entry.attempt.lastSay = entry.pendingSay;
  entry.pendingSay = null;
  entry.sayWrittenAt = now;
  this.store.updateAttempt(entry.attempt);
  return true;
}

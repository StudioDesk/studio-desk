// How the controller itself is doing (C-18, November 2, 2026): the event loop's delay, how long scheduler passes and
// requests take, memory, and how big the records are, read at GET /api/health/load. MP-034's first slice takes this
// baseline before several reviewers add tasks and attempts, so a load is measured before and after a change instead
// of probed by hand. Durations keep the most recent thousand of each kind; counts run since the controller started.
import fs from 'node:fs';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const kept = 1000;
const tenth = value => Math.round(value * 10) / 10;
// The most recent durations of one kind, in milliseconds.
function series() {
  const values = [];
  let count = 0;
  return {
    add(ms) {
      count++;
      values.push(ms);
      if (values.length > kept) values.shift();
    },
    summary() {
      if (!values.length) return { count, p50: null, p95: null, p99: null, max: null };
      const sorted = [...values].sort((a, b) => a - b),
        at = share => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))];
      return { count, p50: tenth(at(0.5)), p95: tenth(at(0.95)), p99: tenth(at(0.99)), max: tenth(sorted.at(-1)) };
    },
  };
}

export function createLoadMeasures() {
  const loop = monitorEventLoopDelay({ resolution: 20 }),
    started = Date.now(),
    passes = series(),
    requests = series();
  loop.enable();
  const megabytes = bytes => tenth(bytes / 1048576),
    size = file => {
      try {
        return fs.statSync(file).size;
      } catch {
        return 0;
      }
    },
    // The histogram counts nanoseconds.
    delay = nanoseconds => tenth(nanoseconds / 1e6);
  return {
    pass: ms => passes.add(ms),
    request: ms => requests.add(ms),
    snapshot(store) {
      const count = sql => store.db.prepare(sql).get().n,
        database = path.join(store.directory, 'studio.sqlite'),
        memory = process.memoryUsage();
      return {
        since: new Date(started).toISOString(),
        uptimeSeconds: Math.round((Date.now() - started) / 1000),
        memoryMB: { rss: megabytes(memory.rss), heapUsed: megabytes(memory.heapUsed) },
        eventLoopDelayMs: {
          p50: delay(loop.percentile(50)),
          p95: delay(loop.percentile(95)),
          p99: delay(loop.percentile(99)),
          max: delay(loop.max),
        },
        schedulerPassMs: passes.summary(),
        requestMs: requests.summary(),
        records: {
          tasks: count('SELECT COUNT(*) AS n FROM tasks'),
          attempts: count('SELECT COUNT(*) AS n FROM attempts'),
          // The newest event's sequence: every event recorded, without counting the table.
          events: count('SELECT COALESCE(MAX(seq), 0) AS n FROM events'),
        },
        databaseMB: { file: megabytes(size(database)), wal: megabytes(size(database + '-wal')) },
      };
    },
    close: () => loop.disable(),
  };
}

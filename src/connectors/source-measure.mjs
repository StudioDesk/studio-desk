// A dispatch pass's source measurements in a process of its own, as a story's setup (source-setup.mjs) and an
// editor's test copy (test-copy.mjs) are made: before the pass checks the waiting source stories, each line their scope
// checks read is measured here (lineMeasurement, src/connectors/source-lines.mjs), its plan hashing the whole source,
// which takes seconds on a large repository that the controller would otherwise spend not answering. The pass then
// reuses these measurements (measuringPass) and hashes nothing on the controller's thread. The controller sends the
// request on stdin; the process prints each line's measurement as JSON. This file is also that process.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lineMeasurement } from './source-lines.mjs';
import { profileOf } from './source-profile.mjs';

const self = fileURLToPath(import.meta.url),
  measureTimeoutMs = 2 * 60 * 1000;

// Each requested line's measurement, in order: { root, line, profile (none for Studio desk's first revision, as a
// record keeps it), ignored: lists of new files }, with the working-copy folder and the commit measurements the
// controller already keeps (`known`).
export function measureLines({ lines, parent, known = [] }) {
  return lines.map(item =>
    lineMeasurement(item.root, item.line ?? undefined, profileOf(item), parent, { ignored: item.ignored, known }),
  );
}

// Measures in its own process and resolves the measurements. `holder.sourceMeasuring` is that process while it runs,
// so the controller's close ends it; past its time limit it is ended too.
export function measureSources(request, holder = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [self], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    holder.sourceMeasuring = child;
    let out = '',
      errors = '',
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, measureTimeoutMs);
    const done = () => {
      clearTimeout(timer);
      if (holder.sourceMeasuring === child) holder.sourceMeasuring = null;
    };
    child.stdout.setEncoding('utf8').on('data', chunk => (out += chunk));
    child.stderr.setEncoding('utf8').on('data', chunk => (errors = (errors + chunk).slice(-4000)));
    child.on('error', error => {
      done();
      reject(error);
    });
    child.on('close', code => {
      done();
      if (timedOut) return reject(new Error('Measuring the source ran past its time limit.'));
      if (code !== 0) return reject(new Error(errors.trim().split('\n').at(-1) || 'Measuring the source stopped.'));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error('Measuring the source returned no measurement.'));
      }
    });
    // A process ended before it read its request (the controller closing) closes its input; close reports the end.
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
  });
}

// A trusted model-free test seam, never exposed by HTTP (the runner's sourceMeasureHold): a test holds the measuring
// process here, once it has measured and before it answers, until it removes the file named, so a line can move after
// it was measured. It writes <file>.held once it holds there.
function holdWhile(file) {
  if (file && fs.existsSync(file)) fs.writeFileSync(file + '.held', '');
  while (file && fs.existsSync(file)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}

if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  let request = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => (request += chunk));
  process.stdin.on('end', () => {
    try {
      const parsed = JSON.parse(request);
      const measured = measureLines(parsed);
      holdWhile(parsed.hold);
      process.stdout.write(JSON.stringify(measured));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  });
}

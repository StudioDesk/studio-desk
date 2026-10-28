// The whole record of a test run the controller measured (test-output-full.txt), opened read-only for the
// dashboard. The checks before a breakdown and a story's candidate tests write it to the attempt's output folder,
// and a story's merge to integration/ in its review attempt's job folder; testOutput writes every byte as it
// arrives. It is not an artifact, so it is not hash-verified: this reads the file as recorded, and reviews still
// read only the bounded text. The path is fixed from the attempt's identity and one of two folder names; no
// request parameter becomes a path.
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { jobDirectory } from '../core/projects.mjs';
import { failedTestReader, testOutput, testPhaseEvidence, testRecordLimit } from './source-checks.mjs';

export const testRecordRuns = Object.freeze({ attempt: 'output', merge: 'integration' });
// What testOutput appends when a record reaches testRecordLimit; nothing is recorded after it.
const limitNote = Buffer.from('\n# The record stops here, at its 64 MB limit.\n'),
  recordBytes = testRecordLimit + limitNote.length;
const refuse = (message, status) => Object.assign(new Error(message), { status });
// The checks and source-change adapters register test-output.txt when they measured a run.
const measured = attempt =>
  attempt.artifacts?.some(item => item.kind === 'test-log' && item.path === 'test-output.txt');

function testRecordRun(value) {
  const run = value ?? 'attempt';
  if (!Object.hasOwn(testRecordRuns, run)) throw refuse('run must be attempt or merge.', 400);
  return run;
}
// A stream of the run's record, or null when the run kept none (it ran before records were kept, or the merge
// stopped before its tests).
function openTestRecord(store, attempt, run) {
  if (run === 'attempt' && !measured(attempt)) throw refuse('This attempt ran no measured tests.', 404);
  if (run === 'merge' && !attempt.sourceIntegration) throw refuse('This attempt has no recorded merge.', 404);
  const job = jobDirectory(store, attempt),
    file = path.join(job, testRecordRuns[run], 'test-output-full.txt');
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile()) throw new Error('The whole record is not a plain file.');
  if (!fs.realpathSync(file).startsWith(fs.realpathSync(job) + path.sep))
    throw new Error('The whole record is outside its job folder.');
  const fd = fs.openSync(file, 'r');
  try {
    // The file opened is the one checked, not one put in its place since.
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino)
      throw new Error('The whole record changed while it was opened.');
    if (opened.size > recordBytes) throw new Error('The whole record is larger than the controller records.');
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
  // Never more than a record holds, even if the file grows while it is read.
  return fs.createReadStream(file, { fd, end: recordBytes - 1 });
}

// The record's size, failed tests and totals, read once a chunk at a time: the failed tests through
// failedTestReader and the totals from testOutput's bounded text, which keeps the totals lines past its limit.
// totals is null when the run stopped before reporting them; limited, when the record stops at its 64 MB limit.
export async function testRecordSummary(store, attempt, value) {
  const run = testRecordRun(value),
    stream = openTestRecord(store, attempt, run);
  if (!stream) return { recorded: false, run };
  const reader = failedTestReader(),
    output = testOutput(),
    decoder = new StringDecoder('utf8');
  let bytes = 0,
    tail = Buffer.alloc(0);
  const read = text => {
    reader.push(text);
    output.add(text);
  };
  for await (const chunk of stream) {
    bytes += chunk.length;
    tail = Buffer.concat([tail, chunk.subarray(-limitNote.length)]).subarray(-limitNote.length);
    read(decoder.write(chunk));
  }
  read(decoder.end());
  return {
    recorded: true,
    run,
    bytes,
    limited: tail.equals(limitNote),
    totals: testPhaseEvidence(output.text()).totals,
    failedTests: reader.finish(),
  };
}

// The record's bytes, or null when the run kept none.
export function testRecordStream(store, attempt, value) {
  return openTestRecord(store, attempt, testRecordRun(value));
}

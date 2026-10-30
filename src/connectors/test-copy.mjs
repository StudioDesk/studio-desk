// The copy an editor's own test run uses (employee-tests.mjs), made in a process of its own as a story's setup is
// (source-setup.mjs): the folder emptied, the story's source copied from the attempt's worktree and checked against
// its snapshot, and the staged edits applied. Hashing and copying a large repository take seconds, which the
// controller would otherwise spend not answering (October 29: two-second stalls each time an editor ran its tests).
// The controller sends the request on stdin; the process prints the copy's plan as JSON. This file is also that
// process.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copySource, sourcePlan } from './source-checks.mjs';
import { profileOf } from './source-profile.mjs';

const self = fileURLToPath(import.meta.url),
  copyTimeoutMs = 5 * 60 * 1000;

// The copy itself: approved files and new files as they are under changes/, deleted files removed unless the editor
// kept them. Only plain files are read. Returns the copy's plan.
export function composeTestCopy({
  source,
  worktree,
  output,
  directory,
  allowedFiles,
  newFiles = [],
  deleteFiles = [],
}) {
  fs.rmSync(directory, { recursive: true, force: true });
  copySource({ ...source, root: worktree }, directory);
  for (const file of [...allowedFiles, ...newFiles, ...deleteFiles]) {
    const staged = path.join(output, 'changes', file),
      target = path.join(directory, file);
    let stat = null;
    try {
      stat = fs.lstatSync(staged);
    } catch {}
    if (stat && !stat.isFile()) throw new Error(`changes/${file} is not a plain file.`);
    if (stat) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(staged, target);
    } else if (deleteFiles.includes(file)) fs.rmSync(target, { force: true });
  }
  return sourcePlan(directory, profileOf(source));
}

// Makes the copy in its own process and resolves its plan. `holder.copying` is that process while it runs, so the
// editor stopping ends it; past its time limit it is ended too.
export function makeTestCopy(request, holder = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [self], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    holder.copying = child;
    let out = '',
      errors = '',
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, copyTimeoutMs);
    child.stdout.setEncoding('utf8').on('data', chunk => (out += chunk));
    child.stderr.setEncoding('utf8').on('data', chunk => (errors = (errors + chunk).slice(-4000)));
    child.on('error', error => {
      clearTimeout(timer);
      holder.copying = null;
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      holder.copying = null;
      if (timedOut) return reject(new Error('Copying the source for the tests ran past its time limit.'));
      if (code !== 0)
        return reject(new Error(errors.trim().split('\n').at(-1) || 'Copying the source for the tests stopped.'));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error('Copying the source for the tests returned no plan.'));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  let request = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => (request += chunk));
  process.stdin.on('end', () => {
    try {
      process.stdout.write(JSON.stringify(composeTestCopy(JSON.parse(request))));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  });
}

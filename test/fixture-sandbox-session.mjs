// Model-free child runner. Filesystem barriers keep races and crash boundaries under the test's control.
import fs from 'node:fs';
import path from 'node:path';
import { denyBuiltInSandboxData, dataDenyDone, takeBuiltInSandboxSession } from '../src/adapters/built-in-sandbox.mjs';
const [folder, text] = process.argv.slice(2),
  options = JSON.parse(text);
const send = (event, detail) => process.send?.({ event, ...(detail ? { detail } : {}) });
function barrier(phase) {
  send(phase);
  const resume = path.join(folder, `${process.pid}-${phase}.go`);
  while (!fs.existsSync(resume)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  fs.rmSync(resume, { force: true });
}
let paused = false;
const pause = phase => {
  if (!paused && options.pause === phase) {
    paused = true;
    barrier(phase);
  }
};
const mkdir = fs.mkdirSync,
  write = fs.writeFileSync,
  rename = fs.renameSync,
  remove = fs.rmSync;
fs.mkdirSync = function (file, ...args) {
  const result = mkdir.call(this, file, ...args),
    name = path.basename(String(file));
  if (name.startsWith('.sandbox-session-owner-')) pause('ownership');
  if (/^\d+$/.test(name) && path.basename(path.dirname(String(file))).startsWith('.sandbox-session-owner-'))
    pause('ticket');
  return result;
};
fs.writeFileSync = function (file, ...args) {
  if (path.basename(String(file)) === 'publication') {
    // A live publisher may be paused with incomplete private bytes, before the atomic shared publication.
    write.call(this, file, '{"pid":');
    pause('publication');
    if (options.failPublication) throw new Error('injected publisher failure');
  }
  return write.call(this, file, ...args);
};
fs.renameSync = function (from, to) {
  const result = rename.call(this, from, to);
  if (path.basename(String(from)) === 'publication') pause('published');
  return result;
};
fs.rmSync = function (file, ...args) {
  const name = path.basename(String(file));
  // The run's own release meets a file a scanner keeps holding.
  if (options.failRelease && /^slot-\d+\.lock$/.test(name))
    throw Object.assign(new Error('EPERM: operation not permitted, unlink'), { code: 'EPERM' });
  if (name.startsWith('.sandbox-session-owner-') && !name.startsWith(`.sandbox-session-owner-${process.pid}-`))
    pause('recovery');
  return remove.call(this, file, ...args);
};
try {
  if (options.mode === 'data') {
    const run = (program, args) => {
      if (args[1] !== '/deny')
        return {
          status: 0,
          stdout: fs.existsSync(path.join(folder, 'root-protected')) ? 'sandbox-runtime-users:(OI)(CI)(DENY)(RD)' : '',
        };
      send(fs.existsSync(path.join(folder, dataDenyDone)) ? 'old-mark-present' : 'old-mark-absent');
      fs.writeFileSync(path.join(folder, 'root-protected'), '');
      pause('data-deny');
      if (options.failDeny) return { status: 5, stderr: 'partial propagation' };
      fs.writeFileSync(path.join(folder, 'descendants-protected'), '');
      return { status: 0 };
    };
    denyBuiltInSandboxData(folder, {
      profile: path.join(folder, 'elsewhere'),
      run,
      readStartTime: () => new Date(0),
      timeoutMs: options.waitBoundMs ?? 2000,
      waitMs: 5,
    });
    send('completed');
    process.on('message', () => process.exit(0));
  } else {
    const release = await takeBuiltInSandboxSession(folder, {
      slots: options.slots ?? 4,
      waitMs: 10,
      waitBoundMs: options.waitBoundMs ?? 2000,
      readStartTime: () => new Date(0),
      alive: pid => {
        if (pid === 987654321) {
          pause('stale');
          return false;
        }
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          return error.code !== 'ESRCH';
        }
      },
      onWait: () => send('waiting'),
    });
    send('claimed');
    process.on('message', message => {
      if (message === 'release') {
        send('releasing');
        // As the runner's finish does: give the session back, then end with the run's own exit code.
        release();
        process.exit(options.exitCode ?? 0);
      }
    });
  }
} catch (error) {
  send('exhausted', error.message);
  process.on('message', () => process.exit(0));
}

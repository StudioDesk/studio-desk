// The built-in sandbox (1.0.1): Anthropic's sandbox runtime, run as a program of its own, where candidate tests
// and an idea's checks run once it is set up on this computer. Model-free: the sandbox itself is never started
// here; its setup and status are fakes, and the commands are checked as recorded.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { realPath } from '../src/core/real-path.mjs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { fork, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setup } from './source-story-setup.mjs';
import {
  builtInSandbox,
  builtInSandboxCommand,
  builtInSandboxCommandLine,
  builtInSandboxDataFolder,
  builtInSandboxDataSecrets,
  builtInSandboxEnvironment,
  builtInSandboxRunArguments,
  builtInSandboxRunUsage,
  builtInSandboxRunner,
  builtInSandboxRuntimeEnvironment,
  builtInSandboxSecrets,
  builtInSandboxSessionWaitMs,
  builtInSandboxSessionWaitBudget,
  builtInSandboxSettings,
  builtInSandboxState,
  builtInSandboxVersion,
  dataDenyDone,
  dataDenyLock,
  dataDenyTimeoutMs,
  denyBuiltInSandboxData,
  denyBuiltInSandboxDataFolders,
  denyBuiltInSandboxSecrets,
  readBuiltInSandboxStatus,
  takeBuiltInSandboxSession,
} from '../src/adapters/built-in-sandbox.mjs';
import { checkSeconds } from '../src/packs/studio-development/index.mjs';
import { repositoryTestSeconds } from '../src/connectors/source-projects.mjs';
import { testTimeoutMs } from '../src/connectors/source-integration.mjs';
import { runBuiltInSandbox } from '../src/adapters/built-in-sandbox-run.mjs';

const sessionFixture = fileURLToPath(new URL('./fixture-sandbox-session.mjs', import.meta.url));
function sessionChild(t, folder, options = {}) {
  const child = fork(sessionFixture, [folder, JSON.stringify(options)], { silent: true, windowsHide: true });
  const messages = [];
  let errors = '';
  child.stderr.on('data', chunk => (errors += chunk));
  child.on('message', message => messages.push(message));
  const closed = new Promise(resolve => child.once('close', resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  });
  return {
    child,
    messages,
    closed,
    resume: phase => fs.writeFileSync(path.join(folder, `${child.pid}-${phase}.go`), ''),
    async event(...names) {
      const until = Date.now() + 10000;
      while (Date.now() < until) {
        const found = messages.find(message => names.includes(message.event));
        if (found) return found;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Fixture ended: ${errors}`);
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      throw new Error(`Fixture did not report ${names}: ${JSON.stringify(messages)} ${errors}`);
    },
  };
}

test('RF-005: three independent stale reapers cannot admit more than four active holders', async t => {
  const folder = sessionFolder(t);
  for (let slot = 0; slot < 3; slot++) writeSlot(folder, slot, process.pid, new Date().toISOString());
  writeSlot(folder, 3, 987654321, new Date().toISOString());
  const contenders = Array.from({ length: 3 }, () => sessionChild(t, folder, { pause: 'stale', waitBoundMs: 1800 }));
  const reported = (contender, event) => contender.messages.some(message => message.event === event);
  // Before the fix all three reach the same stale observation. With serialization the first holds the ownership while
  // it looks, so the others cannot reach it.
  for (const until = Date.now() + 10000; !contenders.some(contender => reported(contender, 'stale')); )
    if (Date.now() > until) assert.fail('no contender reached the stale slot');
    else await new Promise(resolve => setTimeout(resolve, 5));
  await new Promise(resolve => setTimeout(resolve, 150));
  const observed = contenders.filter(contender => reported(contender, 'stale'));
  // Resume their reclamation in the review's order.
  for (const contender of observed) contender.resume('stale');
  for (const contender of contenders) {
    const result = await contender.event('claimed', 'exhausted');
    if (result.event === 'exhausted') assert.match(result.detail, /stayed in use/);
  }
  const admitted = contenders.filter(contender => contender.messages.some(message => message.event === 'claimed'));
  assert.equal(3 + admitted.length, 4, 'measure running claimants, not the four on-disk filenames');
});

test('RF-013: abandoned empty and truncated slot publications recover bounded capacity', async t => {
  for (const text of ['', '{"pid":'])
    await t.test(JSON.stringify(text), async t => {
      const folder = sessionFolder(t);
      fs.writeFileSync(path.join(folder, 'slot-0.lock'), text);
      const release = await takeBuiltInSandboxSession(folder, { slots: 1, waitMs: 5, waitBoundMs: 150 });
      assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'slot-0.lock'), 'utf8')).pid, process.pid);
      release();
    });
});

test('UL-001: unchanged slot bytes do not hide PID reuse after a genuine first observation', async t => {
  const folder = sessionFolder(t),
    since = '2026-11-01T08:00:00.000Z';
  writeSlot(folder, 0, process.pid, since);
  const original = fs.readFileSync(path.join(folder, 'slot-0.lock'), 'utf8');
  let reads = 0;
  // A start time is read again at most every identityRecheck (30 s on a real run), here 20 ms.
  const release = await takeBuiltInSandboxSession(folder, {
    slots: 1,
    waitMs: 5,
    waitBoundMs: 300,
    identityRecheck: 20,
    readStartTime: () => {
      assert.equal(fs.readFileSync(path.join(folder, 'slot-0.lock'), 'utf8'), original);
      return new Date(Date.parse(since) + (++reads === 1 ? -60000 : 60000));
    },
  });
  assert.ok(reads >= 2, 'revalidate identity even after the original holder was genuine');
  release();
});

test('RF-001: a previous completion mark cannot certify partial or failed ACL propagation', t => {
  const folder = sessionFolder(t),
    done = path.join(folder, dataDenyDone);
  fs.writeFileSync(done, 'old completed propagation');
  let root = false,
    descendants = false,
    missingBeforeDeny = false,
    contenderSucceeded = false;
  const options = {
    profile: path.join(folder, 'elsewhere'),
    waitMs: 1,
    timeoutMs: 25,
    readStartTime: () => new Date(0),
  };
  const run = (program, args) => {
    if (args[1] !== '/deny') return { status: 0, stdout: root ? 'sandbox-runtime-users:(OI)(CI)(DENY)(RD)' : '' };
    missingBeforeDeny = !fs.existsSync(done);
    root = true;
    try {
      denyBuiltInSandboxData(folder, { ...options, run });
      contenderSucceeded = true;
    } catch {}
    return { status: 5, stderr: 'propagation failed with descendants unprotected' };
  };
  assert.throws(() => denyBuiltInSandboxData(folder, { ...options, run }), /propagation failed/);
  assert.equal(missingBeforeDeny, true, 'invalidate old completion before the first ACL mutation');
  assert.equal(contenderSucceeded, false, 'a second invocation must wait for descendants');
  assert.equal(descendants, false);
  assert.equal(fs.existsSync(done), false);
  assert.throws(() => denyBuiltInSandboxData(folder, { ...options, run }), /propagation failed/);
  const timeout = (program, args) =>
    args[1] === '/deny' ? { status: null, error: new Error('propagation timed out') } : run(program, args);
  assert.throws(() => denyBuiltInSandboxData(folder, { ...options, run: timeout }), /timed out/);
  assert.equal(fs.existsSync(done), false);
  let writes = 0;
  const success = (program, args) => {
    if (args[1] === '/deny') {
      writes++;
      descendants = true;
      return { status: 0 };
    }
    return run(program, args);
  };
  assert.equal(denyBuiltInSandboxData(folder, { ...options, run: success }), folder);
  assert.equal(descendants, true);
  assert.equal(fs.existsSync(done), true);
  assert.equal(denyBuiltInSandboxData(folder, { ...options, run: success }), folder);
  assert.equal(writes, 1, 'completed propagation retains the inexpensive root-only check');
});

test('RF-006: a data repair lock is reclaimed when its answering PID belongs to a later process', t => {
  const folder = sessionFolder(t);
  fs.writeFileSync(
    path.join(folder, dataDenyLock),
    JSON.stringify({ pid: process.pid, since: '2026-11-01T08:00:00Z' }),
  );
  const fake = fakeAccessList();
  assert.equal(
    denyBuiltInSandboxData(folder, {
      run: fake.run,
      profile: path.join(folder, 'elsewhere'),
      waitMs: 1,
      timeoutMs: 30,
      readStartTime: () => new Date('2026-11-02T08:00:00Z'),
    }),
    folder,
  );
  assert.ok(fs.existsSync(path.join(folder, dataDenyDone)));
});

test('RF-001: a killed ACL writer and its waiter cannot certify a partially protected tree on restart', async t => {
  const folder = sessionFolder(t),
    done = path.join(folder, dataDenyDone);
  fs.writeFileSync(done, 'old mark');
  const writer = sessionChild(t, folder, { mode: 'data', pause: 'data-deny' });
  await writer.event('data-deny');
  assert.ok(writer.messages.some(message => message.event === 'old-mark-absent'));
  assert.equal(fs.existsSync(done), false);
  assert.equal(fs.existsSync(path.join(folder, 'descendants-protected')), false);
  const waiter = sessionChild(t, folder, { mode: 'data', waitBoundMs: 100 });
  assert.match((await waiter.event('exhausted')).detail, /held its lock too long/);
  assert.equal(
    waiter.messages.some(message => message.event === 'completed'),
    false,
  );
  writer.child.kill();
  await writer.closed;
  const restart = sessionChild(t, folder, { mode: 'data', failDeny: true });
  assert.match((await restart.event('exhausted')).detail, /partial propagation/);
  assert.equal(fs.existsSync(done), false, 'the protected root alone never certifies the interrupted tree');
  const success = sessionChild(t, folder, { mode: 'data' });
  await success.event('completed');
  assert.equal(fs.existsSync(done), true);
  assert.equal(fs.existsSync(path.join(folder, 'descendants-protected')), true);
});

test('data lock identity keeps legacy, genuine and unreadable live owners safe', t => {
  const folder = sessionFolder(t),
    lock = path.join(folder, dataDenyLock),
    since = '2026-11-01T08:00:00Z';
  const checkHeld = (record, readStartTime) => {
    const text = JSON.stringify(record);
    fs.writeFileSync(lock, text);
    assert.throws(
      () =>
        denyBuiltInSandboxData(folder, {
          profile: path.join(folder, 'elsewhere'),
          run: fakeAccessList().run,
          readStartTime,
          timeoutMs: 15,
          waitMs: 1,
        }),
      /held its lock too long/,
    );
    assert.equal(fs.readFileSync(lock, 'utf8'), text);
  };
  checkHeld({ pid: process.pid }, () => assert.fail('legacy identity must remain ID-only'));
  checkHeld({ pid: process.pid, since }, () => new Date('2026-11-01T07:59:59Z'));
  checkHeld({ pid: process.pid, since }, () => 'unknown');
  const kill = process.kill;
  t.mock.method(process, 'kill', (pid, signal) => {
    if (pid === 123456789) throw Object.assign(new Error('access refused'), { code: 'EPERM' });
    return kill(pid, signal);
  });
  checkHeld({ pid: 123456789 }, () => assert.fail('legacy EPERM is not death'));
  fs.writeFileSync(lock, JSON.stringify({ pid: 123456789, since }));
  assert.equal(
    denyBuiltInSandboxData(folder, {
      profile: path.join(folder, 'elsewhere'),
      run: fakeAccessList().run,
      readStartTime: () => 'unknown',
    }),
    folder,
    'recorded timestamp and unreadable EPERM follow the shared identity policy',
  );
});

test('a displaced data repair cannot publish completion or release a replacement owner with the same PID', t => {
  const folder = sessionFolder(t),
    lock = path.join(folder, dataDenyLock);
  const replacement = JSON.stringify({ pid: process.pid, since: new Date().toISOString(), token: 'replacement-owner' });
  const run = (program, args) => {
    assert.equal(args[1], '/deny');
    // Model a lost owner resuming after a replacement has already taken its recorded lock.
    fs.writeFileSync(lock, replacement);
    return { status: 0 };
  };
  assert.throws(
    () => denyBuiltInSandboxData(folder, { profile: path.join(folder, 'elsewhere'), run }),
    /lost its ownership/,
  );
  assert.equal(fs.readFileSync(lock, 'utf8'), replacement);
  assert.equal(fs.existsSync(path.join(folder, dataDenyDone)), false);
});

test('an old session release cannot remove a replacement claim with the same PID', async t => {
  const folder = sessionFolder(t);
  const old = await takeBuiltInSandboxSession(folder, { slots: 1 });
  const replacement = await takeBuiltInSandboxSession(folder, { slots: 1, alive: () => false });
  const before = fs.readFileSync(path.join(folder, 'slot-0.lock'), 'utf8');
  old();
  assert.equal(fs.readFileSync(path.join(folder, 'slot-0.lock'), 'utf8'), before);
  replacement();
  assert.deepEqual(fs.readdirSync(folder), []);
});

test('legacy session identity and unreadable start times retain the shared liveness policy', async t => {
  const folder = sessionFolder(t),
    file = path.join(folder, 'slot-0.lock');
  for (const since of [undefined, 'not a time', new Date().toISOString()]) {
    writeSlot(folder, 0, process.pid, since);
    const before = fs.readFileSync(file, 'utf8');
    await assert.rejects(
      takeBuiltInSandboxSession(folder, {
        slots: 1,
        waitMs: 1,
        waitBoundMs: 15,
        readStartTime: () => {
          assert.ok(since && since !== 'not a time', 'legacy records need no start-time query');
          return 'unknown';
        },
      }),
      /stayed in use/,
    );
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
});

test('RF-013: live incomplete publishers retain ownership; killing them at each boundary recovers capacity', async t => {
  for (const phase of ['ownership', 'ticket', 'publication', 'published'])
    await t.test(phase, async t => {
      const folder = sessionFolder(t),
        writer = sessionChild(t, folder, { slots: 1, pause: phase });
      await writer.event(phase);
      const waiter = sessionChild(t, folder, { slots: 1, waitBoundMs: 100 });
      // The writer keeps the ownership while it is paused, so the waiter says it never got its turn to look.
      assert.match((await waiter.event('exhausted')).detail, /^Other runs were taking or giving back .* for its turn/);
      assert.equal(
        waiter.messages.some(message => message.event === 'claimed'),
        false,
        'live writer cannot be stolen',
      );
      assert.equal(
        waiter.messages.some(message => message.event === 'waiting'),
        false,
        'no slot was seen in use',
      );
      writer.child.kill();
      await writer.closed;
      const restart = sessionChild(t, folder, { slots: 1 });
      await restart.event('claimed');
      assert.equal(fs.readdirSync(folder).filter(name => name.startsWith('.sandbox-session-owner-')).length, 0);
      restart.child.send('release');
      await restart.closed;
      assert.deepEqual(fs.readdirSync(folder), []);
    });
});

test('RF-013: a failed publisher and an interrupted recovery owner leave no permanent recovery lock', async t => {
  const folder = sessionFolder(t),
    failed = sessionChild(t, folder, { slots: 1, failPublication: true });
  assert.match((await failed.event('exhausted')).detail, /injected publisher failure/);
  assert.deepEqual(fs.readdirSync(folder), [], 'throwing publication cleans private bytes and ownership');
  const abandoned = sessionChild(t, folder, { slots: 1, pause: 'ownership' });
  await abandoned.event('ownership');
  abandoned.child.kill();
  await abandoned.closed;
  const recovery = sessionChild(t, folder, { slots: 1, pause: 'recovery' });
  await recovery.event('recovery');
  recovery.child.kill();
  await recovery.closed;
  const restart = sessionChild(t, folder, { slots: 1 });
  await restart.event('claimed');
  restart.child.send('release');
  await restart.closed;
  assert.deepEqual(fs.readdirSync(folder), []);
});

test('session release waits for an independent live publisher before touching the shared slot', async t => {
  const folder = sessionFolder(t),
    first = sessionChild(t, folder, { slots: 1, waitBoundMs: 5000 });
  await first.event('claimed');
  const before = fs.readFileSync(path.join(folder, 'slot-0.lock'), 'utf8');
  const second = sessionChild(t, folder, { slots: 1, pause: 'ownership', waitBoundMs: 5000 });
  await second.event('ownership');
  first.child.send('release');
  await first.event('releasing');
  assert.equal(
    fs.readFileSync(path.join(folder, 'slot-0.lock'), 'utf8'),
    before,
    'release must enter ownership before deleting',
  );
  second.resume('ownership');
  assert.equal(await first.closed, 0, 'the original holder releases normally, rather than being reaped after a crash');
  await second.event('claimed');
  second.child.send('release');
  assert.equal(await second.closed, 0);
  assert.deepEqual(fs.readdirSync(folder), []);
});

// A virus scanner briefly holding a just-written file refuses its rename or removal with EPERM on Windows.
const scannerRefusal = () => Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });

test('a rename a scanner refuses once still takes the session and still records completed data protection', async t => {
  const folder = sessionFolder(t),
    rename = fs.renameSync,
    refused = [];
  t.mock.method(fs, 'renameSync', (from, to) => {
    const name = path.basename(String(from));
    if (!refused.includes(name)) {
      refused.push(name);
      throw scannerRefusal();
    }
    return rename(from, to);
  });
  const release = await takeBuiltInSandboxSession(folder, { slots: 1, waitMs: 5, waitBoundMs: 2000 });
  assert.deepEqual(refused, ['publication']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'slot-0.lock'), 'utf8')).pid, process.pid);
  release();
  assert.deepEqual(fs.readdirSync(folder), []);
  const data = sessionFolder(t);
  assert.equal(
    denyBuiltInSandboxData(data, { profile: path.join(data, 'elsewhere'), run: fakeAccessList().run }),
    data,
  );
  assert.deepEqual(refused, ['publication', 'completion']);
  assert.ok(fs.existsSync(path.join(data, dataDenyDone)));
});

test('a peer a scanner holds is still there: the run defers rather than failing', async t => {
  const folder = sessionFolder(t),
    peer = `.sandbox-session-owner-${process.pid}-${Date.now()}-${randomUUID()}`,
    readdir = fs.readdirSync;
  fs.mkdirSync(path.join(folder, peer));
  t.mock.method(fs, 'readdirSync', (file, ...args) => {
    if (path.basename(String(file)) === peer) throw scannerRefusal();
    return readdir(file, ...args);
  });
  const waits = [];
  await assert.rejects(
    takeBuiltInSandboxSession(folder, { slots: 1, waitMs: 5, waitBoundMs: 60, onWait: slots => waits.push(slots) }),
    /Other runs were taking or giving back this computer's built-in sandbox sessions the whole time/,
  );
  assert.deepEqual(waits, [], 'a busy turn is not every slot in use');
  assert.deepEqual(readdir(folder), [peer]);
});

test("giving a session back never throws, within its own bound, so a run's exit code is unchanged", async t => {
  const folder = sessionFolder(t),
    file = path.join(folder, 'slot-0.lock');
  // In this process: a slot a scanner keeps holding, then an ownership another live run keeps past the release's bound.
  const release = await takeBuiltInSandboxSession(folder, { slots: 1, waitBoundMs: 1, releaseBoundMs: 50 });
  const claim = fs.readFileSync(file, 'utf8'),
    remove = fs.rmSync;
  t.mock.method(fs, 'rmSync', (target, ...args) => {
    if (target === file) throw scannerRefusal();
    return remove(target, ...args);
  });
  assert.doesNotThrow(release);
  assert.equal(fs.readFileSync(file, 'utf8'), claim);
  fs.rmSync.mock.restore();
  const busy = path.join(folder, `.sandbox-session-owner-${process.pid}-${Date.now()}-${randomUUID()}`);
  fs.mkdirSync(path.join(busy, '1'), { recursive: true });
  const begun = Date.now();
  assert.doesNotThrow(release);
  assert.ok(Date.now() - begun < 1000, 'its own bound, not the acquisition wait');
  assert.equal(fs.readFileSync(file, 'utf8'), claim);
  fs.rmSync(busy, { recursive: true });
  release();
  assert.deepEqual(fs.readdirSync(folder), []);
  // In a run's own process, as the runner's finish gives the session back and then exits with the run's code.
  const run = sessionChild(t, folder, { slots: 1, failRelease: true, exitCode: 7 });
  await run.event('claimed');
  run.child.send('release');
  assert.equal(await run.closed, 7, 'a failed give-back keeps the run’s own exit code');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, run.child.pid);
  // The slot left behind records the ended run, so the next run takes it.
  const next = await takeBuiltInSandboxSession(folder, { slots: 1, waitMs: 5, waitBoundMs: 2000 });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid);
  next();
});

test('a wait reads a live holder’s start time at most every 30 seconds, and a young owner’s not at all', async t => {
  const folder = sessionFolder(t),
    since = new Date(Date.now() - 60000).toISOString();
  for (let slot = 0; slot < 4; slot++)
    writeSlot(folder, slot, process.pid, new Date(Date.parse(since) + slot).toISOString());
  let reads = 0;
  const readStartTime = () => (reads++, new Date(Date.parse(since) - 60000));
  // Four sessions busy: a waiter passing every 5 ms reads each holder's start time once, rather than on every pass.
  await assert.rejects(
    takeBuiltInSandboxSession(folder, { waitMs: 5, waitBoundMs: 300, readStartTime }),
    /All 4 of this computer's built-in sandbox sessions stayed in use/,
  );
  assert.equal(reads, 4);
  for (let slot = 0; slot < 4; slot++) fs.rmSync(path.join(folder, `slot-${slot}.lock`));
  // A live ownership entry a few seconds old is asked by its ID alone; an older one by its start time, once a wait.
  for (const [age, expected] of [
    [0, 0],
    [60000, 1],
  ]) {
    reads = 0;
    const owner = path.join(folder, `.sandbox-session-owner-${process.pid}-${Date.now() - age}-${randomUUID()}`);
    fs.mkdirSync(path.join(owner, '1'), { recursive: true });
    await assert.rejects(
      takeBuiltInSandboxSession(folder, {
        waitMs: 5,
        waitBoundMs: 150,
        readStartTime: () => (reads++, new Date(Date.now() - 120000)),
      }),
      /for its turn/,
    );
    assert.equal(reads, expected, `an owner ${age} ms old`);
    fs.rmSync(owner, { recursive: true });
  }
  assert.deepEqual(fs.readdirSync(folder), []);
});

test("the computer's built-in sandbox sessions are taken in turn, an ended holder's slot freed, and a waiter told once", async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-sessions-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const live = new Set([101, 102, 103]),
    take = (pid, extra = {}) =>
      takeBuiltInSandboxSession(folder, { slots: 2, pid, alive: holder => live.has(holder), waitMs: 20, ...extra });
  const first = await take(101),
    second = await take(102);
  assert.deepEqual(fs.readdirSync(folder).sort(), ['slot-0.lock', 'slot-1.lock']);
  // A third waits while both are taken, is told so once, and takes the slot given back.
  const waits = [];
  let third = null;
  const taking = take(103, { onWait: slots => waits.push(slots) }).then(release => (third = release));
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(third, null, 'still waiting');
  assert.deepEqual(waits, [2]);
  first();
  await taking;
  assert.equal(typeof third, 'function');
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'slot-0.lock'), 'utf8')).pid, 103);
  // Giving back is a holder's own: an old release leaves the slot's new holder alone.
  first();
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'slot-0.lock'), 'utf8')).pid, 103);
  // A holder that ended without giving back (stopped hard) frees its slot.
  live.delete(102);
  const fourth = await take(104);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'slot-1.lock'), 'utf8')).pid, 104);
  second();
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'slot-1.lock'), 'utf8')).pid, 104);
  third();
  fourth();
  assert.deepEqual(fs.readdirSync(folder), []);
});

// A slot as a run writes it: its holder's ID and when it took the slot, after the holder started.
const writeSlot = (folder, slot, pid, since) =>
  fs.writeFileSync(path.join(folder, `slot-${slot}.lock`), JSON.stringify({ pid, since }));
const sessionFolder = t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-sessions-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
};

test('a slot whose ID now belongs to a process started after the slot was taken is freed for the next run', async t => {
  const folder = sessionFolder(t),
    since = '2026-11-01T08:00:00.000Z',
    asked = [];
  // This test's own process is alive and answers its ID, but the start time read says it started a day after the slot.
  writeSlot(folder, 0, process.pid, since);
  const release = await takeBuiltInSandboxSession(folder, {
    slots: 1,
    pid: 4242,
    waitMs: 10,
    waitBoundMs: 2000,
    readStartTime: holder => (asked.push(holder), new Date('2026-11-02T08:00:00.000Z')),
  });
  assert.deepEqual(asked, [process.pid]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'slot-0.lock'), 'utf8')).pid, 4242);
  release();
  assert.deepEqual(fs.readdirSync(folder), []);
});

test('a slot whose live holder started before the slot was taken stays taken, its identity revalidated', async t => {
  const folder = sessionFolder(t),
    since = new Date().toISOString();
  let reads = 0;
  writeSlot(folder, 0, process.pid, since);
  let taken = null;
  const taking = takeBuiltInSandboxSession(folder, {
    slots: 1,
    pid: 4243,
    waitMs: 10,
    waitBoundMs: 5000,
    identityRecheck: 20,
    readStartTime: () => (reads++, new Date(Date.parse(since) - 60000)),
  }).then(release => (taken = release));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(taken, null, 'still waiting');
  assert.ok(reads > 1, 'identity asked again across several passes');
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'slot-0.lock'), 'utf8')).pid, process.pid);
  // The holder gives its slot back, and the waiter takes it.
  fs.rmSync(path.join(folder, 'slot-0.lock'));
  await taking;
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'slot-0.lock'), 'utf8')).pid, 4243);
  taken();
});

test('a run that finds every session held by runs still going stops after its wait bound, saying so, and changes no slot', async t => {
  const folder = sessionFolder(t),
    since = new Date().toISOString(),
    slotFiles = () => fs.readdirSync(folder).map(name => [name, fs.readFileSync(path.join(folder, name), 'utf8')]);
  writeSlot(folder, 0, process.pid, since);
  writeSlot(folder, 1, process.pid, new Date(Date.parse(since) + 1).toISOString());
  const before = slotFiles(),
    waits = [];
  let reads = 0;
  const begun = Date.now();
  await assert.rejects(
    takeBuiltInSandboxSession(folder, {
      slots: 2,
      pid: 4244,
      waitMs: 10,
      waitBoundMs: 120,
      identityRecheck: 20,
      onWait: slots => waits.push(slots),
      readStartTime: () => (reads++, new Date(Date.parse(since) - 60000)),
    }),
    error =>
      /^All 2 of this computer's built-in sandbox sessions stayed in use by runs still going, so this run stopped after waiting [\d.]+ seconds? for one\.$/.test(
        error.message,
      ),
  );
  assert.ok(Date.now() - begun >= 120, 'waited out its bound');
  assert.ok(reads > 2, 'each holder revalidated across passes');
  assert.deepEqual(waits, [2]);
  assert.deepEqual(slotFiles(), before);
});

test('the standard workflow and repository retain 600-second budgets and candidate/integration tests cover the default wait', () => {
  assert.equal(checkSeconds, 600);
  assert.equal(repositoryTestSeconds, 600);
  for (const limit of [checkSeconds * 1000, repositoryTestSeconds * 1000, testTimeoutMs])
    assert.ok(builtInSandboxSessionWaitMs * 2 <= limit);
  assert.equal(builtInSandboxSessionWaitBudget(undefined), builtInSandboxSessionWaitMs);
});

test('the runner exhausts occupied sessions and cleans up before its deadline, charging elapsed setup', async t => {
  const folder = sessionFolder(t),
    since = new Date().toISOString();
  for (let slot = 0; slot < 4; slot++) writeSlot(folder, slot, process.pid, since);
  const before = fs.readdirSync(folder).map(name => fs.readFileSync(path.join(folder, name), 'utf8')),
    messages = [],
    begun = Date.now(),
    deadlineMs = begun + 2000;
  let runDirectory,
    acquisitionAt,
    bound,
    cleaned = false;
  const code = await runBuiltInSandbox(['--root', folder, '--deadline-ms', String(deadlineMs), '--', 'node'], {
    platform: 'win32',
    // Model 1.5 seconds spent in setup without a slow test. The remaining real wait is about 250 ms.
    now: () => Date.now() + 1500,
    prepareWindows: (root, node, launcher, directory) => {
      runDirectory = directory;
    },
    takeSession: (ignored, options) => {
      acquisitionAt = Date.now() + 1500;
      bound = options.waitBoundMs;
      return takeBuiltInSandboxSession(folder, { ...options, alive: () => true, waitMs: 5 });
    },
    runSync: (program, args) => {
      assert.deepEqual(args, ['acl', 'forget', folder]);
      cleaned = true;
    },
    run: () => assert.fail('Busy sessions must not start the installed sandbox.'),
    log: message => messages.push(message),
  });
  assert.equal(code, 1);
  assert.ok(bound > 0 && bound <= (deadlineMs - acquisitionAt) / 2 + 1);
  assert.ok(bound <= 250, 'setup consumed the enclosing allowance');
  assert.ok(Date.now() + 1500 < deadlineMs, 'exhaustion and cleanup precede the enclosing deadline');
  assert.ok(cleaned);
  assert.equal(fs.existsSync(runDirectory), false);
  assert.equal(messages.filter(message => message.startsWith('Waiting for')).length, 1);
  assert.match(messages.at(-1), /All 4 .*sessions stayed in use by runs still going/);
  assert.deepEqual(
    fs.readdirSync(folder).map(name => fs.readFileSync(path.join(folder, name), 'utf8')),
    before,
  );
});

test('an exhausted allowance never acquires a session or starts a runtime, and normal completion releases its session', async t => {
  const root = sessionFolder(t);
  for (const expired of [true, false]) {
    let now = 1000,
      directory,
      released = false,
      forgotten = false;
    const messages = [],
      code = await runBuiltInSandbox(
        ['--root', root, '--deadline-ms', '1500', '--', 'node', '--deadline-ms', 'owned-by-command'],
        {
          platform: 'win32',
          now: () => now,
          prepareWindows: (root, node, launcher, runDirectory) => {
            directory = runDirectory;
            if (expired) now = 1500;
          },
          takeSession: async (folder, options) => {
            assert.equal(expired, false);
            assert.equal(options.waitBoundMs, 250);
            return () => {
              released = true;
            };
          },
          run: (executable, args) => {
            assert.equal(expired, false);
            const instructions = fs.readdirSync(directory).find(name => name.startsWith('run-'));
            assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, instructions), 'utf8')).args, [
              '--deadline-ms',
              'owned-by-command',
            ]);
            const child = new EventEmitter();
            setImmediate(() => child.emit('close', 0));
            return child;
          },
          runSync: () => {
            forgotten = true;
          },
          log: message => messages.push(message),
        },
      );
    assert.equal(code, expired ? 1 : 0);
    assert.equal(released, !expired);
    assert.ok(forgotten);
    assert.equal(fs.existsSync(directory), false);
    if (expired) assert.match(messages.at(-1), /allowance was exhausted/);
  }
});

test("before a Windows run the director's key and launch link above the copy are denied to the sandbox group, or the run stops", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-secrets-')),
    root = path.join(directory, 'data', 'projects', 'p', 'jobs', 'a', 'copy');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(root, { recursive: true });
  assert.deepEqual(builtInSandboxSecrets(root), [], 'a data folder without a key has nothing to deny');
  const key = path.join(directory, 'data', 'director-key');
  fs.writeFileSync(key, 'a'.repeat(64));
  assert.deepEqual(builtInSandboxSecrets(root), [key]);
  // The launch link beside it sets the director's session cookie, so it is denied as the key is.
  const launch = path.join(directory, 'data', 'launch-url');
  fs.writeFileSync(launch, 'http://127.0.0.1:4317/launch/' + 'c'.repeat(48));
  assert.deepEqual(builtInSandboxSecrets(root), [key, launch]);
  fs.rmSync(launch);
  const calls = [];
  denyBuiltInSandboxSecrets([key], (program, args) => (calls.push([program, args]), { status: 0 }));
  assert.deepEqual(calls, [['icacls', [key, '/deny', 'sandbox-runtime-users:(R)']]]);
  assert.throws(
    () => denyBuiltInSandboxSecrets([key], () => ({ status: 5, stderr: 'Access is denied.' })),
    /could not be kept from the director's sign-in file .*Access is denied/,
  );
  // The tools' keys are a folder: its entry reaches every key in it.
  const toolKeys = path.join(directory, 'data', 'tool-keys');
  fs.mkdirSync(toolKeys);
  assert.deepEqual(builtInSandboxSecrets(root), [key, toolKeys]);
  calls.length = 0;
  denyBuiltInSandboxSecrets([key, toolKeys], (program, args) => (calls.push([program, args]), { status: 0 }));
  assert.deepEqual(calls, [
    ['icacls', [key, '/deny', 'sandbox-runtime-users:(R)']],
    ['icacls', [toolKeys, '/deny', 'sandbox-runtime-users:(OI)(CI)(R)']],
  ]);
});

test('before a Windows run the rest of the data folder is denied to the sandbox group, its copy let back in by its grant', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-data-')),
    data = path.join(directory, 'data'),
    root = path.join(data, 'projects', 'p', 'jobs', 'a', 'copy');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(root, { recursive: true });
  assert.equal(builtInSandboxDataFolder(root), null, 'a copy outside any data folder has none to deny');
  const { calls, run } = fakeAccessList(),
    outside = { run, profile: path.join(directory, 'home') };
  assert.equal(denyBuiltInSandboxData(null, outside), null);
  assert.deepEqual(calls, []);
  fs.writeFileSync(path.join(data, 'director-key'), 'a'.repeat(64));
  assert.equal(builtInSandboxDataFolder(root), data);
  // Reading what anything in it holds, its own listing included; looking at a folder stays allowed, as Node looks at
  // each folder on the way to the copy. Set once, with as long as Windows takes to write it to everything in the folder.
  assert.equal(denyBuiltInSandboxData(data, outside), data);
  assert.deepEqual(calls, [['icacls', [data, '/deny', 'sandbox-runtime-users:(OI)(CI)(RD)'], dataDenyTimeoutMs]]);
  assert.ok(fs.existsSync(path.join(data, dataDenyDone)), 'the finished writing is recorded');
  assert.ok(!fs.existsSync(path.join(data, dataDenyLock)), 'and the lock given back');
  // After that a run reads only the folder's own list, which is quick (November 3: every run failed at 30 seconds).
  calls.length = 0;
  assert.equal(denyBuiltInSandboxData(data, outside), data);
  assert.deepEqual(calls, [['icacls', [data], 30000]]);
  // A writing cut short leaves the folder's own entry without the record, and is done again.
  fs.rmSync(path.join(data, dataDenyDone));
  calls.length = 0;
  assert.equal(denyBuiltInSandboxData(data, outside), data);
  assert.deepEqual(
    calls.map(([, args]) => args[1] ?? 'read'),
    ['/deny'],
  );
  // Inside the director's profile nothing is read or set: the profile's permissions keep the sandbox account out.
  calls.length = 0;
  assert.equal(denyBuiltInSandboxData(data, { run, profile: directory }), null);
  assert.equal(
    denyBuiltInSandboxData(data, { run, profile: data.toUpperCase() }),
    null,
    'the profile itself, in any case',
  );
  assert.deepEqual(calls, []);
  // A failure stops the run, records nothing and gives the lock back.
  fs.rmSync(path.join(data, dataDenyDone));
  assert.throws(
    () => denyBuiltInSandboxData(data, { ...outside, run: () => ({ status: 5, stderr: 'Access is denied.' }) }),
    /could not be kept from the data folder .*Access is denied/,
  );
  assert.ok(!fs.existsSync(path.join(data, dataDenyDone)) && !fs.existsSync(path.join(data, dataDenyLock)));
});

// A fake icacls: the folder's own list holds the data deny once it has been set, or from a given read on.
function fakeAccessList({ deniedFromRead = Infinity } = {}) {
  const calls = [];
  let set = false,
    reads = 0;
  const run = (program, args, options) => {
    calls.push([program, args, options.timeout]);
    if (args[1] === '/deny') set = true;
    else reads++;
    const entry = set || reads >= deniedFromRead ? 'PC\\sandbox-runtime-users:(OI)(CI)(DENY)(RD)\n ' : '';
    return { status: 0, stdout: `${args[0]} ${entry}BUILTIN\\Administrators:(I)(OI)(CI)(F)\n` };
  };
  return { calls, run };
}

test("a Windows run that finds another writing the data folder's deny waits for it, takes over an ended run's lock, and stops when it is held too long", t => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-data-lock-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const lock = path.join(data, dataDenyLock),
    profile = path.join(data, '..', 'elsewhere'),
    holdLock = pid => fs.writeFileSync(lock, JSON.stringify({ pid }));
  // A live run holds the lock, and its writing finishes while this one waits: nothing is set twice.
  holdLock(process.pid);
  fs.writeFileSync(path.join(data, dataDenyDone), 'x');
  let fake = fakeAccessList({ deniedFromRead: 3 });
  assert.equal(denyBuiltInSandboxData(data, { run: fake.run, profile, waitMs: 5 }), data);
  assert.deepEqual(
    fake.calls.map(([, args]) => args[1] ?? 'read'),
    ['read', 'read', 'read'],
  );
  assert.ok(fs.existsSync(lock), "the other run's lock is left to it");
  // A lock left by a run that ended is taken over.
  fs.rmSync(path.join(data, dataDenyDone));
  holdLock(spawnSync(process.execPath, ['-e', '']).pid);
  fake = fakeAccessList();
  assert.equal(denyBuiltInSandboxData(data, { run: fake.run, profile, waitMs: 5 }), data);
  assert.deepEqual(
    fake.calls.map(([, args]) => args[1] ?? 'read'),
    ['/deny'],
  );
  assert.ok(!fs.existsSync(lock));
  // A live lock held past the time limit stops the run rather than leaving the folder readable.
  fs.rmSync(path.join(data, dataDenyDone));
  holdLock(process.pid);
  assert.throws(
    () => denyBuiltInSandboxData(data, { run: fakeAccessList().run, profile, timeoutMs: 30, waitMs: 5 }),
    /could not be kept from the data folder .*held its lock too long/,
  );
});

const claudeFixture = fileURLToPath(new URL('./fixture-claude.mjs', import.meta.url)),
  plan = { root: '/candidate', command: { executable: process.execPath, args: ['--test', 'test/a.test.mjs'] } };
// A fake for the controller's view of the sandbox: its state and a setup that finishes when told to.
function fakeSandbox(state) {
  const sandbox = {
    state,
    setups: 0,
    finish: null,
    status: () => ({ state: sandbox.state }),
    setup(done) {
      if (!['not-set-up', 'outdated'].includes(sandbox.state)) return false;
      sandbox.setups++;
      sandbox.finish = next => {
        sandbox.state = next;
        done({ state: next });
      };
      return true;
    },
  };
  return sandbox;
}

test('its tests run through its runner, which gets the folder they may write and the plan’s command', () => {
  // test-sandbox.test.mjs covers which attempts run here and what they record.
  assert.deepEqual(builtInSandboxCommand(plan), {
    executable: process.execPath,
    args: [builtInSandboxRunner, '--root', '/candidate', '--', process.execPath, '--test', 'test/a.test.mjs'],
  });
  // The controller's own data folder, which the run is kept from wherever the copy is, goes after the copy.
  assert.deepEqual(builtInSandboxCommand({ ...plan, data: '/data' }), {
    executable: process.execPath,
    args: [
      builtInSandboxRunner,
      '--root',
      '/candidate',
      '--data',
      '/data',
      '--',
      process.execPath,
      '--test',
      'test/a.test.mjs',
    ],
  });
});

test('the runner reads its arguments with or without the data folder, and refuses any other list with its usage line', () => {
  assert.deepEqual(builtInSandboxRunArguments(['--root', '/c', '--data', '/d', '--', 'node', '--test', 'a.mjs']), {
    root: '/c',
    data: '/d',
    executable: 'node',
    args: ['--test', 'a.mjs'],
  });
  // A command recorded on an attempt before the data folder was named keeps running.
  assert.deepEqual(builtInSandboxRunArguments(['--root', '/c', '--', 'node']), {
    root: '/c',
    data: null,
    executable: 'node',
    args: [],
  });
  // An argument after the separator is the command's own, however it looks.
  assert.deepEqual(builtInSandboxRunArguments(['--root', '/c', '--', 'node', '--data', '/x']).args, ['--data', '/x']);
  for (const malformed of [
    [],
    ['--root'],
    ['--root', '/c'],
    ['--root', '/c', '--'],
    ['--root', '--', 'node'],
    ['--data', '/d', '--root', '/c', '--', 'node'],
    ['--root', '/c', '--data', '--', 'node'],
    ['--root', '/c', '--data', '/d', '--'],
    ['--root', '/c', '--data', '/d', 'node'],
    ['--root', '/c', '--other', '/d', '--', 'node'],
    ['--root', '/c', '--data', '/d', '--data', '/e', '--', 'node'],
  ])
    assert.equal(builtInSandboxRunArguments(malformed), null, malformed.join(' '));
  // The runner itself stops there, before it prepares or starts anything.
  const refused = spawnSync(process.execPath, [builtInSandboxRunner, '--root', '/c', '--data', '--', 'node'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(refused.status, 2);
  assert.equal(refused.stderr.trim(), builtInSandboxRunUsage);
});

test('the optional deadline round trips and rejects malformed bounds without consuming command arguments', () => {
  for (const data of [undefined, '/data']) {
    const command = builtInSandboxCommand({ ...plan, data, deadlineMs: 1700000000000 }),
      parsed = builtInSandboxRunArguments(command.args.slice(1));
    assert.equal(parsed.deadlineMs, 1700000000000);
    assert.deepEqual(parsed.args, plan.command.args);
  }
  for (const value of [
    '',
    '0',
    '-1',
    'NaN',
    'Infinity',
    '-Infinity',
    '1.5',
    '1e3',
    ' 5 ',
    'five',
    '9007199254740992',
    '--',
  ])
    assert.equal(builtInSandboxRunArguments(['--root', '/c', '--deadline-ms', value, '--', 'node']), null, value);
  assert.equal(
    builtInSandboxRunArguments(['--root', '/c', '--deadline-ms', '5', '--deadline-ms', '6', '--', 'node']),
    null,
  );
  assert.deepEqual(builtInSandboxRunArguments(['--root', '/c', '--', 'node', '--deadline-ms', '-1']).args, [
    '--deadline-ms',
    '-1',
  ]);
});

test('a legacy runner command without an allowance still uses the default session wait', async t => {
  let consumed;
  const code = await runBuiltInSandbox(['--root', sessionFolder(t), '--', 'node'], {
    platform: 'win32',
    prepareWindows: () => {},
    runSync: () => {},
    log: () => {},
    takeSession: async (folder, options) => {
      consumed = options.waitBoundMs;
      throw new Error('Model-free acquisition boundary');
    },
    run: () => assert.fail('The installed sandbox must never start.'),
  });
  assert.equal(code, 1);
  assert.equal(consumed, builtInSandboxSessionWaitMs);
});

test("on macOS and Linux the controller's named data folder and its secrets are denied wherever the copy is", t => {
  const directory = realPath(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-named-data-'))),
    root = path.join(directory, 'source', '.studio-verify', 'wt', 'v-1'),
    data = path.join(directory, 'moved-data'),
    home = path.join(directory, 'home');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(root, { recursive: true });
  const run = {
      root,
      nodeDirectory: path.join(directory, 'node'),
      launcherDirectory: path.join(directory, 'adapters'),
      runDirectory: path.join(directory, 'run'),
      helper: path.join(directory, 'srt-win.exe'),
      seccomp: path.join(directory, 'seccomp'),
      temporary: path.join(directory, 'run', 'tmp'),
      platform: 'linux',
      home,
    },
    today = builtInSandboxSettings(run);
  // A named folder that is not there (a source whose controller never ran) changes nothing.
  assert.deepEqual(builtInSandboxSettings({ ...run, data }), today);
  fs.mkdirSync(data);
  const key = path.join(data, 'director-key'),
    launch = path.join(data, 'launch-url');
  fs.writeFileSync(key, 'a'.repeat(64));
  fs.writeFileSync(launch, 'http://127.0.0.1:4317/launch/' + 'c'.repeat(48));
  assert.deepEqual(builtInSandboxDataSecrets(data), [key, launch]);
  assert.equal(builtInSandboxDataFolder(root), null, 'the copy is outside the data folder');
  const named = builtInSandboxSettings({ ...run, data });
  assert.deepEqual(named.filesystem.denyRead, [home, data, key, launch]);
  assert.ok(named.filesystem.allowRead.includes(root), 'the copy is still read');
  assert.deepEqual(named.filesystem.allowRead, today.filesystem.allowRead);
  assert.deepEqual(named.filesystem.allowWrite, [root, run.temporary]);
  // Without a named folder the settings are as they were.
  assert.deepEqual(builtInSandboxSettings(run).filesystem.denyRead, [home]);
  // A copy inside the named folder names it once, and keeps its own grants.
  const inside = path.join(data, 'projects', 'p', 'jobs', 'a', 'copy');
  fs.mkdirSync(inside, { recursive: true });
  const within = builtInSandboxSettings({ ...run, root: inside, data });
  assert.deepEqual(within.filesystem.denyRead, [home, data, key, launch]);
  assert.equal(within.filesystem.allowRead[0], inside);
  assert.deepEqual(within.filesystem.allowWrite, [inside, run.temporary]);
  // Windows' account is kept out before the run instead (below); its settings list nothing to deny.
  assert.deepEqual(builtInSandboxSettings({ ...run, data, platform: 'win32' }).filesystem.denyRead, []);
});

test("before a Windows run the controller's named data folder and its secrets are denied wherever the copy is, the folder not in the profile", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-named-data-')),
    root = path.join(directory, 'source', '.studio-verify', 'wt', 'v-1'),
    data = path.join(directory, 'data'),
    profile = path.join(directory, 'home');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(data);
  const key = path.join(data, 'director-key'),
    launch = path.join(data, 'launch-url');
  fs.writeFileSync(key, 'a'.repeat(64));
  fs.writeFileSync(launch, 'http://127.0.0.1:4317/launch/' + 'c'.repeat(48));
  const prepare = (copy, named, home = profile) => {
    const { calls, run } = fakeAccessList();
    const result = denyBuiltInSandboxDataFolders(copy, named, { run, profile: home });
    return { result, calls: calls.map(([program, args]) => [program, args]) };
  };
  // Without a named folder, a copy outside any data folder has nothing to deny, as before.
  assert.deepEqual(prepare(root, null).calls, []);
  // Named, its key and launch link are denied and then the folder itself.
  let prepared = prepare(root, data);
  assert.deepEqual(prepared.calls, [
    ['icacls', [key, '/deny', 'sandbox-runtime-users:(R)']],
    ['icacls', [launch, '/deny', 'sandbox-runtime-users:(R)']],
    ['icacls', [data, '/deny', 'sandbox-runtime-users:(OI)(CI)(RD)']],
  ]);
  assert.deepEqual(prepared.result, { secrets: [key, launch], folders: [data] });
  // Inside the director's profile the folder gets no deny (the profile keeps the sandbox account out); its secrets
  // are denied as those above a copy always were.
  fs.rmSync(path.join(data, dataDenyDone));
  prepared = prepare(root, data, directory);
  assert.deepEqual(prepared.calls, [
    ['icacls', [key, '/deny', 'sandbox-runtime-users:(R)']],
    ['icacls', [launch, '/deny', 'sandbox-runtime-users:(R)']],
  ]);
  assert.deepEqual(prepared.result, { secrets: [key, launch], folders: [null] });
  // A copy inside the named folder has it denied once, as without the name.
  const inside = path.join(data, 'projects', 'p', 'jobs', 'a', 'copy');
  fs.mkdirSync(inside, { recursive: true });
  const before = prepare(inside, null).calls;
  assert.deepEqual(
    before.map(([, args]) => args[0]),
    [key, launch, data],
  );
  fs.rmSync(path.join(data, dataDenyDone));
  assert.deepEqual(prepare(inside, data).calls, before);
  // A named folder that is not there changes nothing.
  assert.deepEqual(prepare(root, path.join(directory, 'missing')).calls, []);
});

test("the runtime's status reads as not set up, out of date or ready", () => {
  // As the runtime's helper printed it on a computer where it had never been set up (October 25).
  const fresh = {
    user: {
      cred_present: false,
      marker_version: null,
      setup_version: 3,
      user: { exists: false, name: 'srt-sandbox' },
    },
    wfp: { state: 'cannot-read' },
  };
  assert.deepEqual(builtInSandboxState(fresh), { state: 'not-set-up' });
  const installed = structuredClone(fresh);
  Object.assign(installed.user, { cred_present: true, marker_version: 3 });
  installed.user.user.exists = true;
  assert.deepEqual(builtInSandboxState(installed), { state: 'ready' });
  installed.user.marker_version = 2;
  assert.deepEqual(builtInSandboxState(installed), { state: 'outdated' }, 'Set up by another release.');
  assert.deepEqual(builtInSandboxState(undefined), { state: 'not-set-up' });
});

test('the status is read from the runtime’s helper, and a copy without the packages says so', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-built-in-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const files = { cli: path.join(directory, 'cli.js'), srtWin: path.join(directory, 'srt-win.exe') },
    windows = { platform: 'win32' };
  assert.deepEqual(readBuiltInSandboxStatus(files, undefined, windows), { state: 'missing' });
  for (const file of Object.values(files)) fs.writeFileSync(file, '');
  const calls = [];
  const reply = stdout => (binary, args) => (calls.push([binary, args]), { stdout, stderr: '' });
  const ready = { user: { cred_present: true, marker_version: 3, setup_version: 3, user: { exists: true } } };
  assert.deepEqual(readBuiltInSandboxStatus(files, reply(JSON.stringify(ready)), windows), { state: 'ready' });
  assert.deepEqual(calls[0], [files.srtWin, ['status']]);
  assert.equal(readBuiltInSandboxStatus(files, reply('not json'), windows).state, 'not-set-up');
  assert.deepEqual(readBuiltInSandboxStatus(files, undefined, { platform: 'freebsd' }), { state: 'unsupported' });
});

test('macOS needs nothing set up, and Linux names the packages it needs and how to install them', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-built-in-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const files = { cli: path.join(directory, 'cli.js'), srtWin: path.join(directory, 'srt-win.exe') },
    finds = programs => program => (programs.includes(program) ? `/usr/bin/${program}` : null),
    noHelper = () => assert.fail('Only Windows asks the helper.');
  // macOS's sandbox is part of the system, so a copy with the packages is ready.
  const mac = { platform: 'darwin', find: finds(['sandbox-exec']) };
  assert.deepEqual(readBuiltInSandboxStatus(files, noHelper, mac), { state: 'missing' }, 'npm ci first.');
  fs.writeFileSync(files.cli, '');
  assert.deepEqual(readBuiltInSandboxStatus(files, noHelper, mac), { state: 'ready' });
  // Linux: the programs it lacks, by package, installed by the first package manager found.
  const linux = (programs, environment = {}) =>
    readBuiltInSandboxStatus(files, noHelper, { platform: 'linux', find: finds(programs), environment });
  assert.deepEqual(linux(['bwrap', 'socat', 'rg']), { state: 'ready' });
  assert.deepEqual(linux(['bwrap', 'apt-get']), {
    state: 'not-set-up',
    needs: ['socat', 'ripgrep'],
    command: 'sudo apt-get install -y socat ripgrep',
    prompt: false,
  });
  assert.equal(linux(['pacman']).command, 'sudo pacman -S --needed --noconfirm bubblewrap socat ripgrep');
  assert.equal(linux(['dnf', 'pkexec']).prompt, false, 'pkexec shows its prompt only in a desktop session.');
  assert.equal(linux(['dnf', 'pkexec'], { XDG_CURRENT_DESKTOP: 'GNOME' }).prompt, true);
  assert.deepEqual(linux(['pkexec'], { XDG_CURRENT_DESKTOP: 'GNOME' }), {
    state: 'not-set-up',
    needs: ['bubblewrap', 'socat', 'ripgrep'],
    command: null,
    prompt: false,
  });
});

test('on Linux the setup installs through pkexec, and packages installed in a terminal are found next time', async () => {
  let programs = ['bwrap', 'apt-get', 'pkexec'];
  const find = program => (programs.includes(program) ? `/usr/bin/${program}` : null),
    read = () =>
      readBuiltInSandboxStatus({ cli: builtInSandboxRunner }, undefined, {
        platform: 'linux',
        find,
        environment: { XDG_CURRENT_DESKTOP: 'KDE' },
      }),
    started = [];
  const run = (executable, args) => {
    started.push([executable, ...args]);
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    setImmediate(() => {
      child.stderr.emit('data', 'Request dismissed\n');
      child.emit('close', 126);
    });
    return child;
  };
  const sandbox = builtInSandbox({ cli: builtInSandboxRunner }, { read, find, run });
  const finished = await new Promise(resolve => assert.equal(sandbox.setup(resolve), true));
  assert.deepEqual(started, [['pkexec', '/usr/bin/apt-get', 'install', '-y', 'socat', 'ripgrep']]);
  assert.equal(finished.state, 'not-set-up');
  assert.deepEqual(sandbox.status().setup, { state: 'failed', exitCode: 126, output: 'Request dismissed' });
  // Installed from a terminal instead: the next read finds them, and the failed setup is forgotten.
  programs = [...programs, 'socat', 'rg'];
  assert.deepEqual(sandbox.status(), { state: 'ready' });
  assert.equal(sandbox.setup(), false, 'Ready.');
  // Without a desktop prompt there is nothing to start; the director runs the command.
  programs = ['bwrap'];
  const headless = builtInSandbox(
    {},
    { read: () => readBuiltInSandboxStatus({ cli: builtInSandboxRunner }, undefined, { platform: 'linux', find }) },
  );
  assert.equal(headless.status().prompt, false);
  assert.equal(headless.setup(), false);
});

test('a run writes only the copy it tests, reads the packages above it, and reaches only this computer', t => {
  const directory = realPath(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-built-in-'))),
    root = path.join(directory, 'data', 'wt', 'v-1');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(directory, 'data', 'node_modules'));
  const run = {
    root,
    nodeDirectory: path.join(directory, 'node'),
    launcherDirectory: path.join(directory, 'adapters'),
    runDirectory: path.join(directory, 'run'),
    helper: 'C:\\ProgramData\\Studio desk\\sandbox\\srt-win.exe',
    seccomp: path.join(directory, 'sandbox-runtime', 'vendor', 'seccomp'),
    temporary: path.join(directory, 'run', 'tmp'),
  };
  const settings = builtInSandboxSettings({ ...run, platform: 'win32' });
  assert.deepEqual(settings.network, { allowedDomains: [], deniedDomains: [], allowLocalBinding: true });
  assert.deepEqual(settings.filesystem.allowWrite, [root]);
  assert.deepEqual(settings.filesystem.allowRead.slice(0, 3), [
    path.join(directory, 'node'),
    path.join(directory, 'adapters'),
    path.join(directory, 'run'),
  ]);
  assert.ok(settings.filesystem.allowRead.includes(path.join(directory, 'data', 'node_modules')));
  assert.equal(settings.filesystem.allowRead.includes(path.join(root, 'node_modules')), false);
  assert.deepEqual(settings.windows, { srtWin: { path: run.helper } });
  // macOS and Linux run as the director's own account: the home folder is denied, and what a run uses is let
  // back in, the copy and the runtime's seccomp helper among it; the run's own temporary folder is writable too.
  const home = path.join(directory, 'home'),
    posix = builtInSandboxSettings({ ...run, platform: 'linux', home });
  assert.deepEqual(posix.network, settings.network);
  assert.deepEqual(posix.filesystem.denyRead, [home]);
  // The data folder above the copy (C-40) and the director's key in it (C-01) are denied there by name, so a data
  // folder kept outside the home folder still hides them, the copy and its packages let back in below; Windows'
  // account reads nothing in the profile it is not given.
  const data = path.join(directory, 'data'),
    key = path.join(data, 'director-key');
  fs.writeFileSync(key, 'a'.repeat(64));
  assert.deepEqual(builtInSandboxSettings({ ...run, platform: 'linux', home }).filesystem.denyRead, [home, data, key]);
  const launch = path.join(directory, 'data', 'launch-url');
  fs.writeFileSync(launch, 'http://127.0.0.1:4317/launch/' + 'c'.repeat(48));
  assert.deepEqual(builtInSandboxSettings({ ...run, platform: 'linux', home }).filesystem.denyRead, [
    home,
    data,
    key,
    launch,
  ]);
  fs.rmSync(launch);
  assert.deepEqual(builtInSandboxSettings({ ...run, platform: 'win32' }).filesystem.denyRead, []);
  fs.rmSync(key);
  assert.deepEqual(posix.filesystem.allowRead, [root, ...settings.filesystem.allowRead, run.seccomp]);
  assert.deepEqual(posix.filesystem.allowWrite, [root, run.temporary]);
  assert.equal(posix.windows, undefined);
  // The repositories tests make write their .git/config there; the runtime refuses every .git/hooks regardless.
  assert.equal(posix.filesystem.allowGitConfig, true);
  assert.equal(settings.filesystem.allowGitConfig, undefined, 'Windows is unchanged.');
  // A Node.js install of its own (nvm's, under the home folder) keeps npm in <install>/lib/node_modules/npm beside
  // its bin: that one folder is let back in, once it is there, so npm and npx run.
  const npm = path.join(directory, 'lib', 'node_modules', 'npm');
  fs.mkdirSync(npm, { recursive: true });
  assert.equal(builtInSandboxSettings({ ...run, platform: 'linux', home }).filesystem.allowRead.at(-1), npm);
  assert.equal(builtInSandboxSettings({ ...run, platform: 'win32' }).filesystem.allowRead.includes(npm), false);
  // The command line quotes each path for the shell the runtime starts; the test command is not on it.
  assert.equal(
    builtInSandboxCommandLine('C:\\Program Files\\node\\node.exe', 'C:\\a b\\launch.mjs', 'C:\\t\\run.json', 'win32'),
    '"C:\\Program Files\\node\\node.exe" "C:\\a b\\launch.mjs" "C:\\t\\run.json"',
  );
  assert.equal(
    builtInSandboxCommandLine('/usr/bin/node', "/home/a b/it's/launch.mjs", '/tmp/$run.json', 'linux'),
    `'/usr/bin/node' '/home/a b/it'\\''s/launch.mjs' '/tmp/$run.json'`,
  );
  // Only the controller's variables for the tests go in; nothing else from its environment, which may hold sign-ins.
  const environment = { STUDIO_MODEL_FREE_LEAF_FIXTURES: '1', GH_TOKEN: 'secret', PATH: '/bin', HOME: '/home/a' };
  assert.deepEqual(builtInSandboxEnvironment(environment), { STUDIO_MODEL_FREE_LEAF_FIXTURES: '1' });
  // On macOS and Linux the runtime passes its environment on, so it starts with only the basics.
  assert.deepEqual(builtInSandboxRuntimeEnvironment(environment), { PATH: '/bin', HOME: '/home/a' });
});

test('the director sets up the built-in sandbox from Settings, one setup at a time', async t => {
  const sandbox = fakeSandbox('not-set-up'),
    c = await setup(t, 'pass', undefined, { builtInSandbox: sandbox }),
    projectId = c.app.store.projects()[0].id,
    read = async route => (await fetch(c.origin + route, { headers: { 'X-Studio-Token': c.token } })).json();
  assert.deepEqual((await read(`/api/projects/${projectId}/shell`)).builtInSandbox, { state: 'not-set-up' });
  assert.deepEqual(
    (await read('/api/templates')).builtInSandbox,
    { state: 'not-set-up' },
    'The first run reads it too.',
  );
  assert.equal((await c.request('/api/built-in-sandbox', { setting: true })).status, 400);
  assert.equal((await c.request('/api/built-in-sandbox', {})).status, 200);
  assert.equal(sandbox.setups, 1);
  sandbox.finish('ready');
  assert.match(
    c.app.store
      .events()
      .filter(event => event.kind === 'control')
      .at(-1).message,
    /is set up/,
  );
  assert.equal((await c.request('/api/built-in-sandbox', {})).status, 409, 'Set up already.');
  // Ready, it is where the next tests run unless the director chose; the director may choose it.
  assert.equal((await read(`/api/projects/${projectId}/shell`)).testSandbox, 'built-in');
  assert.equal((await c.request('/api/control', { testSandbox: 'none' })).status, 200);
  assert.equal((await c.request('/api/control', { testSandbox: 'built-in' })).status, 200);
  assert.equal(c.app.store.organization().testSandbox, 'built-in');
  assert.match(
    c.app.store
      .events()
      .filter(event => event.kind === 'control')
      .at(-1).message,
    /built-in sandbox/,
  );
});

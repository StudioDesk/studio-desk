// The controller's git reads take no optional lock (--no-optional-locks, src/git.mjs): a dispatch pass's measuring
// process (src/connectors/source-measure.mjs) asks git for the checked-out folder's status, and a status that refreshed
// the index held index.lock meanwhile, so a commit the director made there at that moment failed with "Unable to
// create '.git/index.lock': File exists" (GitHub's run on November 9: test/outdated-stories.test.mjs on Linux and
// test/source-changes.test.mjs on Windows).
//
// The measuring process's own hold (sourceMeasureHold) waits once it has measured, when no git runs, so the race is
// held here at the git call itself, model-free. git status refreshes the index before it takes index.lock and holds the
// lock while it compares, which is when it asks each submodule for its own status. The fixture's folder holds a
// repository of its own whose file goes through a clean filter (which git runs on the controller's calls as on the
// director's); the filter waits whenever a git call in the measuring process compares that file, and the file's time is
// in the future, so every such call compares it. While each call waits, the test commits in the folder with its own git.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { waitFor } from './wait-for.mjs';
import { measureSources } from '../src/connectors/source-measure.mjs';

// The clean filter: inside the measuring process (its environment names the hold folder) it records each call as
// held-<n> and passes the file through once go-<n> or release is there; for any other git it passes the file at once.
const filter = `const fs = require('node:fs'), path = require('node:path');
const folder = process.env.STUDIO_TEST_GIT_HOLD;
const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', () => {
  if (folder && fs.existsSync(folder)) {
    let n = 0;
    for (;; n++)
      try {
        fs.writeFileSync(path.join(folder, 'held-' + n), '', { flag: 'wx' });
        break;
      } catch {}
    const go = path.join(folder, 'go-' + n), release = path.join(folder, 'release'), until = Date.now() + 90000;
    while (!fs.existsSync(go) && !fs.existsSync(release) && Date.now() < until)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  process.stdout.write(Buffer.concat(chunks));
});
`;

// The checked-out folder, with a repository of its own at src/sub (a gitlink) whose held.txt goes through the filter.
function repository(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'git-optional-locks-')),
    root = path.join(directory, 'repository'),
    sub = path.join(root, 'src', 'sub'),
    hold = path.join(directory, 'hold'),
    parent = path.join(directory, 'worktrees'),
    script = path.join(directory, 'filter.cjs');
  fs.mkdirSync(sub, { recursive: true });
  fs.mkdirSync(parent);
  fs.writeFileSync(script, filter);
  const own = (args, cwd = root) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result;
  };
  const slashes = file => file.replaceAll('\\', '/');
  for (const folder of [sub, root]) {
    own(['init', '-q', '-b', 'main'], folder);
    own(['config', 'user.name', 'Test'], folder);
    own(['config', 'user.email', 'test@example.com'], folder);
  }
  own(['config', 'filter.hold.clean', `"${slashes(process.execPath)}" "${slashes(script)}"`], sub);
  own(['config', 'filter.hold.required', 'true'], sub);
  fs.writeFileSync(path.join(sub, '.gitattributes'), 'held.txt filter=hold\n');
  fs.writeFileSync(path.join(sub, 'held.txt'), 'held\n');
  own(['add', '.'], sub);
  own(['commit', '-q', '-m', 'Inner'], sub);
  fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
  own(['add', '.']);
  own(['commit', '-q', '-m', 'First']);
  // A time after the inner index's own: the inner status git runs for the outer one compares the file's content.
  const later = new Date('2100-01-01T00:00:00Z');
  fs.utimesSync(path.join(sub, 'held.txt'), later, later);
  return { directory, root, hold, parent, own };
}

test("a commit in the checked-out folder succeeds while the measuring process's git calls are held, and no index.lock is left", async t => {
  const r = repository(t),
    lock = path.join(r.root, '.git', 'index.lock');
  fs.mkdirSync(r.hold);
  let finished = false,
    measuring;
  t.after(async () => {
    fs.writeFileSync(path.join(r.hold, 'release'), '');
    await measuring?.catch(() => {});
    fs.rmSync(r.directory, { recursive: true, force: true });
  });
  // Only the measuring process's git runs the filter's hold: it inherits this environment when it starts.
  process.env.STUDIO_TEST_GIT_HOLD = r.hold;
  try {
    measuring = measureSources({ lines: [{ root: r.root }], parent: r.parent });
  } finally {
    delete process.env.STUDIO_TEST_GIT_HOLD;
  }
  measuring.then(
    () => (finished = true),
    () => (finished = true),
  );
  let held = 0;
  for (;;) {
    const marker = path.join(r.hold, `held-${held}`);
    await waitFor(() => finished || fs.existsSync(marker), `the measuring process's git call ${held} to be held`);
    if (!fs.existsSync(marker)) break;
    const commit = spawnSync('git', ['commit', '-q', '--allow-empty', '-m', `Director's commit ${held}`], {
      cwd: r.root,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(
      commit.status,
      0,
      `The director's commit succeeds while the measuring process's git call ${held} is held: ${commit.stderr}`,
    );
    assert.ok(!fs.existsSync(lock), `No index.lock is left after commit ${held}.`);
    fs.writeFileSync(path.join(r.hold, `go-${held}`), '');
    held++;
  }
  const measured = await measuring;
  assert.equal(measured.length, 1, 'The measuring process answered its line.');
  // The checked-out folder's status (lineTip, and the story base's clean-tree checks) compared the held file.
  assert.ok(held >= 2, `The measuring process's git calls were held ${held} times.`);
  assert.equal(r.own(['rev-list', '--count', 'HEAD']).stdout.trim(), String(held + 1));
  assert.ok(!fs.existsSync(lock), 'No index.lock is left behind.');
});

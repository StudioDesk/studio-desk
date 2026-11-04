// A stopped CLI's process group may still be ending when its main process closes (macOS and Linux). The controller
// looks at it again for a moment before quarantining the attempt (src/adapters/native-process.mjs, waitForGroup).
// Found in the 1.2 release proof on Linux, November 4, 2026: under load, a stopped attempt was quarantined in 4 of 10
// runs. Model-free: the group's liveness is a stand-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSettleMs, groupSettleStepMs, waitForGroup } from '../src/adapters/native-process.mjs';

const settled = (isLive, entry = {}) =>
  new Promise(resolve => {
    const started = Date.now();
    waitForGroup(isLive, entry, () => resolve({ ms: Date.now() - started, live: isLive() }));
  });

test('a group that empties a moment after its main process closes is not taken for one still running', async () => {
  let checks = 0;
  const { ms, live } = await settled(() => ++checks < 4);
  assert.equal(live, false, 'the decision is made once the group has emptied');
  assert.ok(ms >= 2 * groupSettleStepMs && ms < groupSettleMs, `decided after ${ms} ms`);
});

test('a group already empty at the close is decided at once', async () => {
  const { ms } = await settled(() => false);
  assert.ok(ms < groupSettleStepMs, `decided after ${ms} ms`);
});

test('a group that keeps running is still decided once the wait runs out, so it is quarantined', async () => {
  const { ms, live } = await settled(() => true);
  assert.equal(live, true);
  assert.ok(ms >= groupSettleMs - groupSettleStepMs, `decided after ${ms} ms`);
});

test('shutdown letting go of the attempt ends the wait at once', async () => {
  const entry = {};
  let checks = 0;
  const done = settled(() => {
    if (++checks === 2) entry.abandoned = true;
    return true;
  }, entry);
  const { ms } = await done;
  assert.ok(ms < groupSettleMs / 2, `decided after ${ms} ms`);
});

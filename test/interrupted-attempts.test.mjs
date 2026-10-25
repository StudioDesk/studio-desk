// The recovery drill (v1.0 criterion 3): an attempt the controller's own stop interrupted, once the director has
// reconciled it, says nothing about the work, so like one a usage limit stopped it leaves the attempts a stage had.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegistries } from '../src/registry.mjs';
import { countsTowardLimit } from '../src/core/registry.mjs';

test('a reconciled interruption does not count toward an attempt limit, except a fixed one', () => {
  const { workflows } = createRegistries(),
    reconciled = { id: 'attempt-reconciled', status: 'interrupted', reconciledAt: '2026-10-24T09:10:00.000Z' },
    unsettled = { id: 'attempt-unsettled', status: 'interrupted' },
    failed = { id: 'attempt-failed', status: 'failed' },
    store = {
      task: id => ({ id, kind: 'layout' }),
      attempts: () => [reconciled, unsettled, failed],
    };
  // One not yet reconciled still counts: its task cannot start again until it is.
  assert.deepEqual(workflows.stageAttempts(store, { id: 'T-1', kind: 'layout' }), [unsettled, failed]);
  store.task = id => ({ id, kind: 'unreal-integration' });
  assert.deepEqual(workflows.stageAttempts(store, { id: 'T-1', kind: 'unreal-integration' }), [
    reconciled,
    unsettled,
    failed,
  ]);
  assert.equal(countsTowardLimit({ status: 'blocked', subscriptionHold: 'claude' }), false);
  assert.equal(countsTowardLimit({ status: 'failed', reconciledAt: '2026-10-24T09:10:00.000Z' }), true);
});

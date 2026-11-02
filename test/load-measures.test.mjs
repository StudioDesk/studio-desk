// The controller's own measures (C-18, November 2, 2026): GET /api/health/load answers the event loop's delay, the
// scheduler passes' and requests' times, memory, the records' counts and the database's size, so a load is measured
// before and after a change. MP-034's first slice takes its baseline from it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './studio-setup.mjs';

const read = async (c, route) => {
  const response = await fetch(c.origin + route);
  return { status: response.status, body: await response.json() };
};

test("the controller's measures count scheduler passes, requests and records, and read nothing it must not", async t => {
  const c = await setup(t),
    { store, runner } = c.app;
  const before = await read(c, '/api/health/load');
  assert.equal(before.status, 200);
  const { body } = before;
  assert.ok(Date.parse(body.since) <= Date.now());
  for (const key of ['p50', 'p95', 'p99', 'max']) assert.equal(typeof body.eventLoopDelayMs[key], 'number', key);
  assert.ok(body.memoryMB.rss > 0 && body.memoryMB.heapUsed > 0);
  assert.equal(body.records.tasks, store.tasks().length);
  // In megabytes to a tenth, as the database file has it on disk.
  const bytes = fs.statSync(path.join(store.directory, 'studio.sqlite')).size;
  assert.equal(body.databaseMB.file, Math.round((bytes / 1048576) * 10) / 10);
  // A scheduler pass is timed whether or not it starts anything.
  const org = store.organization();
  org.pipelineEnabled = true;
  store.setOrganization(org);
  runner.dispatchQueued();
  const after = (await read(c, '/api/health/load')).body;
  assert.equal(after.schedulerPassMs.count, body.schedulerPassMs.count + 1);
  assert.equal(typeof after.schedulerPassMs.p95, 'number');
  // The first read is counted once its answer has gone; the change stream is never counted.
  assert.ok(after.requestMs.count >= body.requestMs.count + 1);
  assert.equal(typeof after.requestMs.max, 'number');
});

test('the measures need the director, as every read does', async t => {
  const c = await setup(t);
  const response = await fetch(c.origin + '/api/health/load', { directorKey: false });
  assert.equal(response.status, 401);
});

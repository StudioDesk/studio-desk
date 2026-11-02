// A planned story says in plain words what it does and why (November 1, 2026): the director's pages show that, not
// only the brief written for the agent that builds it, which named files, functions and test plans.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBreakdown } from '../src/connectors/source-changes.mjs';
import { saveProjectOrganization } from '../src/core/project-organization.mjs';
import { developmentOrganization } from '../src/organizations/studio-development/project.mjs';
import { setup } from './source-story-setup.mjs';

const plain = 'Checks the workflow fixture keeps its comment, so the next change starts from a known place.';

test("a planned story's summary reaches its page, and a story planned without one shows none", async t => {
  const c = await setup(t),
    store = c.app.store;
  saveProjectOrganization(
    store,
    c.app.runner.registries,
    'project-legacy',
    developmentOrganization(store.organization()),
  );
  store.putProject({ ...store.project('project-legacy'), dispatchPaused: true });
  const { ids } = await c.breakdown([
    { files: ['src/core/workflows.mjs'], dependencies: [], summary: plain },
    { files: ['src/core/projects.mjs'], dependencies: [] },
  ]);
  const page = async id => (await (await fetch(`${c.origin}/api/tasks/${id}?projectId=project-legacy`)).json()).task;
  assert.equal((await page(ids[0])).summary, plain);
  assert.equal((await page(ids[1])).summary, undefined);
});

test('a story summary is optional plain text of at most 400 characters', async t => {
  const c = await setup(t),
    { data, planning } = await c.breakdown();
  const check = summary => () =>
    validateBreakdown(
      { ...data, stories: [{ ...data.stories[0], summary }, data.stories[1]] },
      planning.sourceBreakdown,
    );
  assert.doesNotThrow(check(plain));
  assert.throws(check('x'.repeat(401)), /summary must contain bounded/);
  assert.throws(check(''), /summary must contain bounded/);
});

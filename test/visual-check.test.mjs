// The visual check (1.2 step 8): a story names its pages, a passing candidate whose project checks them is captured by a
// measured step in the built-in sandbox, its images join the candidate for the reviewer, the review describes each one
// for a pass, and with no browser the check is recorded as not run. The suite never starts a browser: a model-free
// stand-in takes the capture's place, and the capture itself was checked by hand against Edge.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup } from './source-story-setup.mjs';
import { reviewedImages, reviewVisualProblems, validateStoryPages } from '../src/connectors/story-pages.mjs';
import {
  findBrowser,
  imageName,
  setStoryPages,
  stepScript,
  storyPages,
  validateVisualSettings,
  visualPlan,
} from '../src/connectors/visual-check.mjs';

const capture = fileURLToPath(new URL('./fixture-visual-capture.mjs', import.meta.url));

test('a story names its pages: a name, a path on the app, and steps that click, type or wait', () => {
  assert.deepEqual(
    validateStoryPages([
      { name: ' Board ', path: '/p/x/board' },
      {
        name: 'Saved story',
        path: '/new',
        steps: [{ type: 'Visual check', into: 'Story name' }, { click: 'Save' }, { wait: 'Saved' }],
      },
    ]),
    [
      { name: 'Board', path: '/p/x/board', steps: [] },
      {
        name: 'Saved story',
        path: '/new',
        steps: [{ type: 'Visual check', into: 'Story name' }, { click: 'Save' }, { wait: 'Saved' }],
      },
    ],
  );
  for (const [pages, problem] of [
    [{}, /a list of at most 10 pages/],
    [Array.from({ length: 11 }, (_, i) => ({ name: `P${i}`, path: '/' })), /at most 10 pages/],
    [[{ name: 'A', path: 'board' }], /starting with \//],
    [[{ name: 'A', path: '//example.com/' }], /starting with \//],
    [[{ name: 'A', path: '/a b' }], /starting with \//],
    [
      [
        { name: 'A', path: '/' },
        { name: 'a', path: '/b' },
      ],
      /repeats the name/,
    ],
    [[{ name: 'A', path: '/', steps: [{ click: 'x', wait: 'y' }] }], /step 1 must be one of/],
    [[{ name: 'A', path: '/', steps: [{ type: 'x' }] }], /step 1 must be one of/],
    [[{ name: 'A', path: '/', steps: [{ eval: 'alert(1)' }] }], /step 1 must be one of/],
    [[{ name: 'A', path: '/', url: 'http://x' }], /unknown field, url/],
  ])
    assert.throws(() => validateStoryPages(pages), problem);
  // Each image is named by its page's place, a slug of its name, its width and theme.
  assert.equal(imageName(1, { name: 'Saved story!' }, 390, 'dark'), 'visual/02-saved-story-390-dark.png');
  // A step's script names what it looks for by its text, as data, never as code.
  assert.match(stepScript({ click: "Save'); alert(1); ('" }), /"Save'\); alert\(1\); \('"/);
});

test('the settings take widths, themes and an optional browser, and the browser is found where Edge or Chrome install', () => {
  assert.deepEqual(validateVisualSettings({ enabled: true }), {
    enabled: true,
    widths: [1440, 390],
    themes: ['light', 'dark'],
    browser: null,
  });
  for (const [settings, problem] of [
    [{ enabled: 'yes' }, /enabled must be true or false/],
    [{ widths: [100] }, /widths must be one to three/],
    [{ widths: [1440, 1440] }, /widths must be one to three distinct/],
    [{ themes: ['sepia'] }, /themes must name light, dark or both/],
    [{ browser: 'msedge.exe' }, /absolute path/],
    [{ pages: [] }, /unknown field pages/],
  ])
    assert.throws(() => validateVisualSettings(settings), problem);
  const edge = path.join('C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
  assert.equal(
    findBrowser(null, {
      platform: 'win32',
      environment: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
      exists: file => file === edge,
    }),
    edge,
  );
  assert.equal(
    findBrowser(null, { platform: 'darwin', exists: file => file.includes('Google Chrome') }),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  );
  assert.equal(findBrowser(null, { platform: 'linux', exists: () => false }), null);
  assert.equal(findBrowser('/opt/brave/brave', { exists: file => file === '/opt/brave/brave' }), '/opt/brave/brave');
});

// A studio whose project checks its pages, with a story that names two and a start command, and the capture's stand-in.
async function checking(t, { browser = 'C:/fixture/msedge.exe', pages = true } = {}) {
  const c = await setup(t),
    { store, runner } = c.app,
    project = store.project('project-legacy');
  project.visualCheck = validateVisualSettings({ enabled: true, widths: [1440, 390], themes: ['light'] });
  project.trying = { start: ['node', 'serve.mjs'] };
  store.putProject(project);
  runner.visualBrowser = browser;
  runner.tryLetsPortsThrough = true;
  runner.visualCaptureCommand = { executable: process.execPath, args: [capture] };
  if (pages)
    setStoryPages(store, store.task(c.taskId), [
      { name: 'Board', path: '/' },
      { name: 'Settings', path: '/settings', steps: [{ click: 'Repository' }] },
    ]);
  return c;
}

test('a passing candidate whose story names pages is captured in the sandbox, and its images join the candidate for the reviewer', async t => {
  const c = await checking(t),
    store = c.app.store;
  await c.start();
  const a = await c.wait(c.taskId);
  const images = a.artifacts.filter(item => item.kind === 'visual-capture').map(item => item.path);
  assert.deepEqual(images, [
    'visual/01-board-1440-light.png',
    'visual/01-board-390-light.png',
    'visual/02-settings-1440-light.png',
    'visual/02-settings-390-light.png',
  ]);
  assert.ok(a.artifacts.some(item => item.path === 'visual-check.json' && item.kind === 'visual-check'));
  const check = a.result.checks.find(item => item.name === 'Visual check');
  assert.equal(check.status, 'pass');
  assert.match(check.evidence, /^4 images with msedge\.exe at http:\/\/127\.0\.0\.1:5999\/\.$/);
  // The capture ran on the candidate's own copy, with the start command wrapped in the built-in sandbox.
  const plan = JSON.parse(fs.readFileSync(path.join(a.outputFolder, '..', 'visual-plan-seen.json'), 'utf8'));
  assert.equal(plan.place, 'built-in');
  assert.ok(plan.command.args.some(arg => arg.endsWith('built-in-sandbox-run.mjs')));
  assert.deepEqual(plan.command.args.slice(-1), ['serve.mjs']);
  assert.equal(plan.root, a.sourceWorktree.path);
  assert.equal(plan.browser, 'C:/fixture/msedge.exe');
  assert.deepEqual(
    plan.pages.map(page => page.name),
    ['Board', 'Settings'],
  );
  assert.ok(store.events().some(event => event.kind === 'visual_check' && event.attempt_id === a.id));
  assert.ok(store.phaseEvents(a.id).some(event => event.payload.phaseId === 'visual'));
});

test('with no browser found the check is recorded as not run with the note, and the candidate goes on to review', async t => {
  const c = await checking(t, { browser: null });
  await c.start();
  const a = await c.wait(c.taskId);
  assert.equal(a.artifacts.filter(item => item.kind === 'visual-capture').length, 0);
  const record = JSON.parse(fs.readFileSync(path.join(a.outputFolder, 'visual-check.json'), 'utf8'));
  assert.equal(record.state, 'not-run');
  assert.equal(record.reason, 'no browser found');
  assert.match(record.note, /Installing Microsoft Edge or Google Chrome lets the reviewer see the pages/);
  const check = a.result.checks.find(item => item.name === 'Visual check');
  assert.equal(check.status, 'not-run');
  assert.match(check.evidence, /did not run: no browser found\. Installing Microsoft Edge/);
});

test("a story without pages, or a project with the check off, is not captured; the director's pages replace the plan's", async t => {
  const c = await checking(t, { pages: false }),
    store = c.app.store;
  assert.equal(visualPlan(store, store.task(c.taskId), c.app.runner), null, 'No pages, nothing to capture.');
  // While the check is on, a breakdown is told to give pages to each story that changes what a page shows.
  const breakdownLayers = () =>
    c.app.runner.registries.workflows
      .get('studio-development:breakdown')
      .instructions({
        org: { workers: [] },
        task: { projectId: 'project-legacy', dependencies: ['checked-task'] },
        store,
      })
      .layers.map(layer => layer.title);
  assert.ok(breakdownLayers().includes('Pages to capture'));
  // The pages route, and the plan reading the director's. Before a change the dashboard reads none of the director's.
  const pagesRead = async () =>
    (await fetch(`${c.origin}/api/tasks/${c.taskId}/pages?projectId=project-legacy`)).json();
  assert.deepEqual(await pagesRead(), { pages: [], changed: false, editable: true, reason: null });
  const changed = await c.request(`/api/tasks/${c.taskId}/pages`, {
    projectId: 'project-legacy',
    pages: [{ name: 'Board', path: '/' }],
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  assert.deepEqual(storyPages(store, store.task(c.taskId)), [{ name: 'Board', path: '/', steps: [] }]);
  assert.match(
    store.taskEvents(store.task(c.taskId)).at(-1).message,
    /changed this story's pages to check: Board \(\/\)/,
  );
  const refused = await c.request(`/api/tasks/${c.taskId}/pages`, {
    projectId: 'project-legacy',
    pages: [{ name: 'Board', path: 'board' }],
  });
  assert.equal(refused.status, 400);
  assert.deepEqual(await pagesRead(), {
    pages: [{ name: 'Board', path: '/', steps: [] }],
    changed: true,
    editable: true,
    reason: null,
  });
  // A closed story's pages read as fixed, with the reason the change gives.
  const story = store.task(c.taskId);
  store.putTask({ ...story, closed: true });
  assert.deepEqual(await pagesRead(), {
    pages: [{ name: 'Board', path: '/', steps: [] }],
    changed: true,
    editable: false,
    reason: 'This story is closed or integrated; its pages can no longer change.',
  });
  const closedChange = await c.request(`/api/tasks/${c.taskId}/pages`, { projectId: 'project-legacy', pages: [] });
  assert.equal(closedChange.status, 409);
  store.putTask(story);
  // The settings route and view: the browser found, and why it would not run here.
  const settings = await c.request('/api/projects/project-legacy/visual-check', {
    projectId: 'project-legacy',
    enabled: false,
  });
  assert.equal(settings.status, 200, JSON.stringify(settings.data));
  assert.equal(settings.data.settings.enabled, false);
  assert.equal(visualPlan(store, store.task(c.taskId), c.app.runner), null, 'The check is off.');
  assert.ok(!breakdownLayers().includes('Pages to capture'), 'With the check off the planner is told nothing new.');
  c.app.runner.tryLetsPortsThrough = false;
  const view = await (await fetch(`${c.origin}/api/projects/project-legacy/visual-check`)).json();
  assert.equal(view.browser, 'C:/fixture/msedge.exe');
  assert.match(view.blocked, /keeps an app's port inside it/);
});

test('a review describes every captured image for a pass, by the name the candidate gave it or its copy among the inputs', () => {
  const review = {
      inputReferences: [
        {
          artifacts: [
            { path: '../inputs/T-1/6-change.diff', kind: 'source-change-diff' },
            { path: '../inputs/T-1/12-01-board-1440-light.png', kind: 'visual-capture' },
            { path: '../inputs/T-1/13-01-board-390-light.png', kind: 'visual-capture' },
          ],
        },
      ],
    },
    images = reviewedImages(review),
    entry = (image, verdict = 'match') => ({ image, note: 'The board shows the new column.', verdict });
  assert.deepEqual(images, ['../inputs/T-1/12-01-board-1440-light.png', '../inputs/T-1/13-01-board-390-light.png']);
  assert.match(
    reviewVisualProblems({ verdict: 'pass' }, images)[0],
    /visual must describe each of the 2 captured images/,
  );
  assert.match(
    reviewVisualProblems(
      { verdict: 'pass', visual: [entry('../inputs/T-1/12-01-board-1440-light.png')] },
      images,
    ).join(),
    /a pass describes every captured image; missing: \.\.\/inputs\/T-1\/13-01-board-390-light\.png/,
  );
  assert.deepEqual(
    reviewVisualProblems(
      {
        verdict: 'pass',
        visual: [entry('../inputs/T-1/12-01-board-1440-light.png'), entry('visual/01-board-390-light.png')],
      },
      images,
    ),
    [],
  );
  // A review asking for changes need not describe every image, but what it describes must be well formed.
  assert.deepEqual(
    reviewVisualProblems(
      { verdict: 'needs-work', visual: [entry('visual/01-board-390-light.png', 'problem')] },
      images,
    ),
    [],
  );
  assert.match(
    reviewVisualProblems(
      { verdict: 'needs-work', visual: [{ image: 'elsewhere.png', note: 'x', verdict: 'fine' }] },
      images,
    ).join(),
    /each visual entry needs an image/,
  );
  assert.deepEqual(reviewVisualProblems({ verdict: 'pass' }, []), [], 'A candidate without images needs no visual.');
});

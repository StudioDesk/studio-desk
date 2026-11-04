// Every route the controller answers is listed (src/core/routes.mjs), and only a listed /api route is answered: GET
// /api/routes reads the table, every listed /api route reaches a handler, an unlisted one is refused before any
// handler runs, and every request the dashboard makes is a listed one, so no page can meet the guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from './model-free-studio.mjs';
import { closeAndRemove } from './fixture-cleanup.mjs';
import { match, routes } from '../src/core/routes.mjs';

const unknownCommand = 'Unknown controller route.',
  unknownRead = 'Unknown read route. Commands are sent with POST or PATCH.';

async function studio(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-routes-'));
  const app = createStudio({ directory, port: 0 });
  const origin = await app.start();
  t.after(() => closeAndRemove(app, directory));
  // The director's key on every request, and this start's request token, read from the page as a local tool would.
  const key = { 'x-studio-key': app.directorKey },
    page = await (await fetch(origin + '/', { headers: key })).text(),
    token = /name="studio-token" content="([0-9a-f]+)"/.exec(page)?.[1];
  assert.ok(token, 'The page carries the request token.');
  const call = async (method, route, body, headers = {}) => {
    const controller = new AbortController();
    const response = await fetch(origin + route, {
      method,
      signal: controller.signal,
      headers: {
        ...key,
        ...(method === 'GET' || method === 'HEAD'
          ? {}
          : { 'Content-Type': 'application/json', 'X-Studio-Token': token }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // The change stream stays open: its headers are its answer.
    if ((response.headers.get('content-type') || '').startsWith('text/event-stream')) {
      controller.abort();
      return { status: response.status, error: null };
    }
    const text = await response.text();
    let error = null;
    try {
      error = JSON.parse(text)?.error ?? null;
    } catch {}
    return { status: response.status, error };
  };
  return { app, origin, call };
}

const fellThrough = answer =>
  [404, 405].includes(answer.status) &&
  [unknownCommand, unknownRead, 'Commands are sent with POST or PATCH.'].includes(answer.error);

test('GET /api/routes answers the table: each route with its method, path, fields, access and summary, once', async t => {
  const { origin } = await studio(t);
  const answer = await fetch(origin + '/api/routes');
  assert.equal(answer.status, 200);
  const listed = (await answer.json()).routes;
  assert.deepEqual(listed, JSON.parse(JSON.stringify(routes)));
  assert.ok(Object.isFrozen(routes) && routes.every(Object.isFrozen), 'The table is frozen.');
  assert.ok(listed.length > 100, 'Every route is listed.');
  const seen = new Set();
  for (const route of listed) {
    const name = `${route.method} ${route.path}`;
    assert.ok(['GET', 'POST', 'PATCH'].includes(route.method), name);
    assert.match(route.path, /^\/(?:[\w.-]+|:[a-zA-Z]+|\*)?(?:\/(?:[\w.-]+|:[a-zA-Z]+|\*))*$/, name);
    assert.ok(Array.isArray(route.fields), name);
    for (const field of route.fields) {
      assert.equal(typeof field.name, 'string', name);
      assert.equal(typeof field.required, 'boolean', name);
    }
    assert.equal(new Set(route.fields.map(field => field.name)).size, route.fields.length, `${name}: fields once`);
    assert.ok(['director', 'attempt', 'anyone'].includes(route.access), name);
    assert.ok(['none', 'unless-keyed', 'attempt'].includes(route.token), name);
    assert.equal(typeof route.summary, 'string', name);
    assert.ok(route.summary.trim() && !route.summary.includes('\n'), `${name}: one plain line`);
    assert.ok(!seen.has(name), `${name} is listed once`);
    seen.add(name);
    const example = route.path.replace(/:[a-zA-Z]+/g, 'x').replace(/\/\*$/, '') || '/';
    assert.equal(match(route.method, example), routes[seen.size - 1], name);
  }
  // The table lists itself, and each command records who may call it and the keyed rule for its request token.
  assert.ok(seen.has('GET /api/routes'));
  for (const route of listed.filter(route => route.path.startsWith('/api/')))
    if (route.access === 'director')
      assert.equal(route.token, route.method === 'GET' ? 'none' : 'unless-keyed', `${route.method} ${route.path}`);
  assert.deepEqual(
    listed.filter(route => route.access === 'attempt').map(route => `${route.method} ${route.path} ${route.token}`),
    ['POST /api/attempts/:id/tests attempt'],
  );
  assert.deepEqual(
    listed.filter(route => route.access === 'anyone').map(route => route.path),
    ['/launch/:code', '/assets/:file'],
  );
  // Without the session or the key, the table is not read either.
  assert.equal((await fetch(origin + '/api/routes', { directorKey: false })).status, 401);
});

test("Close and send as a new idea is listed as a task's action, with its project and an optional idea", () => {
  const route = match('POST', '/api/tasks/T/send-as-idea');
  assert.ok(route, 'The step is listed.');
  assert.equal(route.path, '/api/tasks/:id/send-as-idea');
  assert.equal(route.summary, 'Closes a story whose plan is out of date and sends its remaining work as a new idea.');
  assert.deepEqual(
    route.fields.map(field => [field.name, field.required]),
    [
      ['projectId', true],
      ['idea', false],
    ],
  );
  assert.equal(route.access, 'director');
  assert.equal(route.token, 'unless-keyed');
});

test('every listed /api route reaches its handler', async t => {
  const { app, call } = await studio(t);
  // Nothing the probes queue starts: new dispatch is paused first.
  assert.equal((await call('POST', '/api/control', { paused: true })).status, 200);
  const projectId = app.store.projects()[0].id,
    taskId = app.store.tasks().find(task => task.projectId === projectId || !task.projectId)?.id;
  assert.ok(taskId, 'The studio has a task to send its actions to.');
  const fill = route =>
    route
      .replace(/^\/api\/projects\/:id/, `/api/projects/${projectId}`)
      .replace(/^\/api\/tasks\/:id/, `/api/tasks/${taskId}`)
      .replace(/:number|:revision/g, '1')
      .replace(/:[a-zA-Z]+/g, 'x');
  const listed = routes.filter(route => route.path.startsWith('/api/'));
  // Reads first, then commands: each with an empty body but its project and a field no route takes, which every
  // command that checks its fields refuses before it acts.
  for (const route of [...listed.filter(r => r.method === 'GET'), ...listed.filter(r => r.method !== 'GET')]) {
    const address = fill(route.path),
      answer =
        route.method === 'GET'
          ? await call('GET', `${address}?projectId=${encodeURIComponent(projectId)}`)
          : await call(route.method, address, { projectId, probe: true });
    assert.ok(
      !fellThrough(answer),
      `${route.method} ${route.path} reached no handler: ${answer.status} ${answer.error}`,
    );
  }
  // The attempt's own test run, without its attempt token, is refused by its own check.
  const tests = await call('POST', '/api/attempts/x/tests', {});
  assert.equal(tests.status, 403);
  assert.equal(tests.error, 'This attempt cannot run tests now.');
});

test('an unlisted /api route, or a listed path with a method it does not have, is refused before any handler', async t => {
  const { app, origin, call } = await studio(t);
  const taskId = app.store.tasks()[0].id,
    tasks = JSON.stringify(app.store.tasks()),
    paused = app.store.organization().paused;
  for (const [method, route] of [
    ['POST', '/api/no-such-command'],
    ['POST', `/api/tasks/${taskId}/no-such-action`],
    ['POST', `/api/tasks/${taskId}`],
    ['PATCH', '/api/control'],
    ['PATCH', `/api/tasks/${taskId}/start`],
    ['POST', '/api/projects/project-legacy/milestones/x/no-such-step'],
    ['POST', '/api/tasks//close'],
    ['POST', '/api/control/'],
  ]) {
    const answer = await call(method, route, { projectId: 'project-legacy', paused: !paused });
    assert.equal(answer.status, 404, `${method} ${route}`);
    assert.equal(answer.error, unknownCommand, `${method} ${route}`);
    assert.equal(match(method, route), null, `${method} ${route}`);
  }
  // No handler ran: the tasks and the studio's switches are as they were (a keyed command still leaves its line).
  assert.equal(JSON.stringify(app.store.tasks()), tasks, 'No refused route changed a task.');
  assert.equal(app.store.organization().paused, paused, 'PATCH /api/control changed nothing.');
  // Signed in by the session cookie, an unlisted command still needs the request token first.
  const tokenless = await fetch(origin + '/api/no-such-command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(tokenless.status, 403);
  // A read that names no read route, a command asked for with GET, and a listed read asked for with another method.
  for (const route of ['/api/no-such-read', '/api/control', '/api/projects/project-legacy/no-such-view']) {
    const answer = await call('GET', route);
    assert.equal(answer.status, 404, route);
    assert.equal(answer.error, unknownRead, route);
  }
  const posted = await call('POST', '/api/state', { projectId: 'project-legacy' });
  assert.equal(posted.status, 404);
  assert.equal(posted.error, unknownCommand);
  // A method neither reads nor commands use.
  const deleted = await fetch(origin + '/api/control', { method: 'DELETE' });
  assert.equal(deleted.status, 405);
  assert.equal(deleted.headers.get('allow'), 'POST, PATCH');
  // The agent test route opens only its own POST: any other request to its address, signed in or not, is refused.
  for (const directorKey of [true, false]) {
    const read = await fetch(origin + '/api/attempts/x/tests', { directorKey });
    assert.equal(read.status, 404);
    assert.equal((await read.json()).error, unknownRead);
  }
});

// Every request the dashboard makes, with its method: each URL its API module builds and each command a page sends
// (dashboard/src). P, T, A, R, W, E, S, M and I stand for the IDs a page fills in.
const dashboardRequests = [
  ...[
    '/api/projects',
    '/api/templates',
    '/api/events',
    '/api/changes',
    '/api/export',
    ...[
      'shell',
      'live',
      'runs',
      'settled',
      'people',
      'activity',
      'instructions',
      'try',
      'try/output',
      'visual-check',
      'artifacts',
      'work',
      'library',
      'snapshots',
      'releases',
      'runs/R',
      'runs/R/inputs/I',
      'runs/R/bring-back',
      'agents/W/told',
      'library/E/readers',
      'library/E/revisions/1',
      'snapshots/S/download',
    ].map(page => `/api/projects/P/${page}`),
    ...['', '/activity', '/pages', '/bring-back'].map(page => `/api/tasks/T${page}`),
    ...['', '/logs', '/logs/download', '/trace', '/artifact', '/test-runs/1', '/test-record', '/test-record/text'].map(
      page => `/api/attempts/A${page}`,
    ),
  ].map(route => ['GET', route]),
  ...[
    '/api/control',
    '/api/pipeline',
    '/api/preview',
    '/api/intake',
    '/api/folders',
    '/api/built-in-sandbox',
    '/api/studio-development',
    '/api/projects',
    '/api/projects/inspect-repository',
    '/api/projects/from-template',
    '/api/tasks/close',
    '/api/workers/W/look',
    ...['team', 'employee', 'company'].flatMap(scope =>
      ['draft', 'publish', 'discard'].map(action => `/api/instructions/${scope}/X/${action}`),
    ),
    ...[
      'agents',
      'agents/W/delete',
      'autonomy',
      'delete',
      'source',
      'source/inspect',
      'try-settings',
      'try/run',
      'try/stop',
      'try/open',
      'visual-check',
      'snapshots',
      'library',
      'library/E/revisions',
      'library/E/copy',
      'library/E/remove',
      'library/proposals/X/approve',
      'library/proposals/X/reject',
      'runs/R/archive',
      'runs/R/restore',
      'runs/R/bring-back',
      'lines',
      'version-lines',
      'milestones',
      ...['release', 'release/again', 'ship', 'push', 'ideas'].map(step => `milestones/M/${step}`),
      ...['order', 'move', 'send', 'remove'].map(step => `milestones/M/ideas/I/${step}`),
    ].map(page => `/api/projects/P/${page}`),
    ...[
      'approve-work',
      'deny-work',
      'start',
      'cancel',
      'accept',
      'accept-proposal',
      'propose-work',
      'revise',
      'replan',
      'reconcile',
      'restore-source',
      'integrate-source',
      'merge-source',
      'send-back',
      'carry',
      'carry-skip',
      'bring-back',
      'close',
      'project-owner',
      'allow-commands',
      'edit-scope',
      'answer',
      'change-answer',
      'try',
      'pages',
    ].map(action => `/api/tasks/T/${action}`),
  ].map(route => ['POST', route]),
  ...['/api/projects/P', '/api/projects/P/organization', '/api/projects/P/lines', '/api/projects/P/milestones'].map(
    route => ['PATCH', route],
  ),
  ...['/api/tasks/T', '/api/workers/W'].map(route => ['PATCH', route]),
];

// The paths the dashboard's sources write: every quoted or template string that starts with /api, each page a
// project path names (api.ts projectPath), and every template that starts with an address helper (a call to a name
// ending in Url or Path, such as `${runUrl(projectId, run.id)}/bring-back`), read as the address that helper's own
// definition builds; what a page fills in is `*` and the query is dropped. A template that starts with a helper the
// scan cannot resolve to an address is reported, so no request escapes the comparison with the list.
const hole = '\u0000',
  helperCall = /^\s*([A-Za-z_$][\w$]*(?:Url|Path))\(/;
// lead(i), when given, answers the address the call opening a template at i builds, or undefined for a plain hole.
function literalAt(source, start, lead) {
  const quote = source[start];
  let text = '',
    i = start + 1;
  while (i < source.length && source[i] !== quote) {
    if (source[i] === '\\') {
      text += source[i + 1];
      i += 2;
    } else if (quote === '`' && source[i] === '$' && source[i + 1] === '{') {
      const led = text === '' && lead ? lead(i + 2) : undefined;
      // Skip the interpolation, nested braces, strings and templates included.
      let depth = 1;
      i += 2;
      while (i < source.length && depth) {
        const c = source[i];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (c === "'" || c === '"' || c === '`') {
          i = literalAt(source, i).end;
          continue;
        }
        i++;
      }
      text += led ?? hole;
    } else text += source[i++];
  }
  return { text, end: i + 1 };
}
// Where a helper's value starts in its definition: `const name = '…'`, `const name = (…) => …` or
// `function name(…) { … return …`.
function helperBody(sources, name) {
  for (const [file, source] of sources) {
    const constant = new RegExp(`\\bconst\\s+${name}\\s*=\\s*`).exec(source);
    if (constant) {
      let i = constant.index + constant[0].length;
      if (/['"`]/.test(source[i])) return { file, source, at: i };
      const arrow = source.indexOf('=>', i);
      if (arrow < 0) return undefined;
      i = arrow + 2;
      while (/\s/.test(source[i])) i++;
      return { file, source, at: i };
    }
    const declared = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(source);
    if (declared) {
      const returned = /\breturn\s+/.exec(source.slice(declared.index));
      if (returned) return { file, source, at: declared.index + returned.index + returned[0].length };
    }
  }
  return undefined;
}
function addressReader(sources) {
  const shapes = new Map(),
    unresolved = [];
  // The address a helper's value builds: a string or template, or a call to another helper.
  const valueAt = (source, at) => {
    if (/['"`]/.test(source[at])) return literalAt(source, at, i => callAt(source, i)).text;
    return helperCall.test(source.slice(at, at + 120)) ? callAt(source, at) : undefined;
  };
  const shapeOf = name => {
    if (shapes.has(name)) return shapes.get(name);
    shapes.set(name, undefined);
    const body = helperBody(sources, name),
      shape = body && valueAt(body.source, body.at);
    shapes.set(name, shape);
    return shape;
  };
  // A call to an address helper at i. projectPath's page is its second argument, written where it is called.
  const callAt = (source, i) => {
    const called = helperCall.exec(source.slice(i, i + 120));
    if (!called) return undefined;
    const name = called[1];
    let shape;
    if (name === 'projectPath') {
      const prefix = shapeOf('projectPath');
      const page = /^\s*projectPath\(\s*[\w.]+\s*,\s*(['"`])/.exec(source.slice(i, i + 160));
      if (prefix?.endsWith('/' + hole))
        shape = prefix.slice(0, -1) + (page ? literalAt(source, i + page[0].length - 1).text : hole);
    } else shape = shapeOf(name);
    if (shape === undefined || !shape.startsWith('/api/')) unresolved.push(name);
    return shape;
  };
  return { callAt, unresolved };
}
function dashboardPaths() {
  const root = new URL('../dashboard/src/', import.meta.url),
    files = fs
      .readdirSync(root, { recursive: true })
      .map(String)
      .filter(file => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !/test-controller\.ts$/.test(file));
  const sources = new Map(
    files.map(file => [file, fs.readFileSync(new URL(file.replaceAll('\\', '/'), root), 'utf8')]),
  );
  const reader = addressReader(sources),
    found = new Map(),
    unresolved = [];
  for (const [file, source] of sources) {
    const add = text => {
      const shape = text
        .split('?')[0]
        .split('/')
        .map(part => (part.includes(hole) ? '*' : part))
        .join('/');
      if (!found.has(shape)) found.set(shape, file);
    };
    for (const hit of source.matchAll(/(['"`])\/api\b/g)) add(literalAt(source, hit.index).text);
    for (const hit of source.matchAll(/projectPath\(\s*[\w.]+\s*,\s*(['`])/g))
      add('/api/projects/' + hole + '/' + literalAt(source, hit.index + hit[0].length - 1).text);
    for (const hit of source.matchAll(/`\$\{\s*[A-Za-z_$][\w$]*(?:Url|Path)\(/g)) {
      const before = reader.unresolved.length,
        text = literalAt(source, hit.index, i => reader.callAt(source, i)).text;
      if (reader.unresolved.length > before) unresolved.push(`${file}: ${reader.unresolved.splice(before).join(', ')}`);
      else add(text);
    }
  }
  return { found, unresolved };
}

test('every request the dashboard makes is a listed route', () => {
  for (const [method, route] of dashboardRequests)
    assert.ok(match(method, route), `The dashboard's ${method} ${route} is not listed.`);
  // Each path written in the dashboard's sources is one of those requests, or begins one a page builds on it.
  const { found, unresolved } = dashboardPaths();
  assert.ok(found.size > 30, 'The dashboard sources were read.');
  assert.deepEqual(unresolved, [], 'Each address helper a dashboard template starts with is resolved to its path.');
  // Addresses built on a helper are followed to the helper's path, as the idea page's Bring back builds its own.
  for (const shape of [
    '/api/projects/*/runs/*/bring-back',
    '/api/projects/*/library/*/*',
    '/api/projects/*/library/proposals/*/*',
    '/api/projects/*/milestones/*',
    '/api/projects/*/try/*',
  ])
    assert.ok(found.has(shape), `The scan follows a helper-built address to ${shape}.`);
  for (const [shape, file] of found) {
    const parts = shape.split('/');
    const covered = dashboardRequests.some(([, route]) => {
      const named = route.split('/');
      return named.length >= parts.length && parts.every((part, i) => part === '*' || part === named[i]);
    });
    assert.ok(covered, `${file} sends ${shape}, which the list of dashboard requests does not name.`);
  }
});

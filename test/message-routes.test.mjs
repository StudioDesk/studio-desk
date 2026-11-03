// Posting to a chat and reading one a page at a time (team chat, November 2026): the two routes of the selected
// project under the request protection every command has, each refusal in its own sentence with nothing recorded,
// a channel read newest last with the seq a reader resumes from, and each message on its own project's change stream.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setup } from './studio-setup.mjs';
import { hash } from '../src/core/contracts.mjs';
import { jobDirectory } from '../src/core/projects.mjs';
import { recordMessage } from '../src/core/messages.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const waiting = { type: 'waiting', reason: 'Waiting for a reply.' };

async function addProject(c, name) {
  const created = await c.request('/api/projects', { name });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  return created.data.id;
}
// Work that handed back files, accepted as a finished story leaves it, or still in review.
function work(store, projectId, name, status = 'done') {
  const taskId = `T-${name}`,
    text = `# ${name}\n`,
    attempt = {
      id: `attempt-${name}`,
      taskId,
      projectId,
      workerId: 'W-01',
      status: status === 'done' ? 'accepted' : 'review',
      result: {
        taskId,
        outcome: 'completed',
        summary: 'Wrote it.',
        artifacts: [],
        checks: [],
        issues: [],
        handoff: '',
      },
      artifacts: [{ path: 'notes.md', kind: 'document', hash: hash(Buffer.from(text)) }],
    },
    output = path.join(jobDirectory(store, attempt), 'output');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'notes.md'), text);
  attempt.outputFolder = output;
  store.putTask({
    id: taskId,
    projectId,
    kind: 'general',
    title: `The ${name}`,
    status,
    ...(status === 'done' ? { acceptedAttemptId: attempt.id } : {}),
    lastAttemptId: attempt.id,
    dependencies: [],
  });
  store.insertAttempt(attempt, { text: 'Fixture', hash: 'fixture' });
  return { taskId, attemptId: attempt.id, path: 'notes.md' };
}

// Two projects, each with a run and accepted work, and a story of the first still in review.
async function chats(t) {
  const c = await setup(t),
    store = c.app.store,
    projectId = await addProject(c, 'Chat'),
    other = await addProject(c, 'Elsewhere'),
    runId = `run-${randomUUID()}`,
    foreignRunId = `run-${randomUUID()}`;
  store.putRun({ id: runId, projectId, createdAt: new Date().toISOString() });
  store.putRun({ id: foreignRunId, projectId: other, createdAt: new Date().toISOString() });
  return {
    ...c,
    store,
    projectId,
    other,
    runId,
    foreignRunId,
    story: work(store, projectId, 'story'),
    draft: work(store, projectId, 'draft', 'review'),
    foreign: work(store, other, 'foreign'),
  };
}
async function post(c, projectId, body, headers = { 'X-Studio-Token': c.token }, init = {}) {
  const response = await fetch(`${c.origin}/api/projects/${projectId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    ...init,
  });
  return { status: response.status, data: await response.json() };
}
async function read(c, projectId, query) {
  const response = await fetch(`${c.origin}/api/projects/${projectId}/messages?${query}`);
  return { status: response.status, data: await response.json() };
}
const messageCount = store => store.db.prepare('SELECT COUNT(*) AS count FROM messages').get().count;

// Reads one event stream as the browser's EventSource would, keeping each named event.
async function watch(t, origin, query) {
  const controller = new AbortController(),
    response = await fetch(origin + '/api/events' + query, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(),
    decoder = new TextDecoder(),
    events = [];
  let buffer = '';
  (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
          const fields = {};
          for (const line of buffer.slice(0, end).split('\n')) {
            if (line.startsWith(':')) continue;
            const colon = line.indexOf(':');
            fields[line.slice(0, colon)] = line.slice(colon + 1).trimStart();
          }
          buffer = buffer.slice(end + 2);
          if (fields.event) events.push({ event: fields.event, data: JSON.parse(fields.data) });
        }
      }
    } catch {
      // Aborted when the test closes the stream.
    }
  })();
  t.after(() => controller.abort());
  return {
    events,
    changes: () => events.filter(event => event.event === 'change').flatMap(event => event.data.changes ?? []),
  };
}

test("a post without the director's key or the request token is refused as every command is", async t => {
  const c = await chats(t),
    body = { projectId: c.projectId, channel: { type: 'project' }, text: 'Hello.' };
  const signedOut = await post(c, c.projectId, body, { 'X-Studio-Token': c.token }, { directorKey: false });
  assert.equal(signedOut.status, 401);
  const tokenless = await post(c, c.projectId, body, {});
  assert.equal(tokenless.status, 403);
  assert.match(tokenless.data.error, /X-Studio-Token header/);
  const stale = await post(c, c.projectId, body, { 'X-Studio-Token': 'f'.repeat(48) });
  assert.equal(stale.status, 403);
  assert.match(stale.data.error, /earlier start of the controller/);
  assert.equal(messageCount(c.store), 0, 'no refused post recorded anything');
  // The key alone is enough, as for any command a local tool sends.
  const keyed = await post(c, c.projectId, body, { 'x-studio-key': c.app.directorKey });
  assert.equal(keyed.status, 201, JSON.stringify(keyed.data));
});

test("a post to the project's chat, a run or a task answers with the message, its seq and its outcome", async t => {
  const c = await chats(t),
    sent = [];
  for (const channel of [{ type: 'project' }, { type: 'run', id: c.runId }, { type: 'task', id: c.story.taskId }]) {
    const posted = await post(c, c.projectId, { projectId: c.projectId, channel, text: '  Where does this stand?  ' });
    assert.equal(posted.status, 201, JSON.stringify(posted.data));
    assert.match(posted.data.id, /^msg-[0-9a-f-]{36}$/);
    assert.ok(Number.isSafeInteger(posted.data.seq) && posted.data.seq > 0);
    assert.equal(posted.data.projectId, c.projectId);
    assert.deepEqual(posted.data.channel, { type: channel.type, id: channel.id ?? null });
    assert.equal(posted.data.text, 'Where does this stand?');
    assert.deepEqual(posted.data.from, { type: 'director' });
    assert.deepEqual(posted.data.outcome, waiting);
    assert.deepEqual(c.store.message(posted.data.id), posted.data, 'the answer is the message as it is kept');
    sent.push(posted.data);
  }
  assert.ok(sent[0].seq < sent[1].seq && sent[1].seq < sent[2].seq);
  // A reply in the same channel and an attachment of accepted work are kept with it.
  const reply = await post(c, c.projectId, {
    projectId: c.projectId,
    channel: { type: 'task', id: c.story.taskId },
    text: 'See the notes.',
    replyTo: sent[2].id,
    attachments: [c.story],
  });
  assert.equal(reply.status, 201, JSON.stringify(reply.data));
  assert.equal(reply.data.replyTo, sent[2].id);
  assert.deepEqual(reply.data.attachments, [{ ...c.story, hash: hash(Buffer.from('# story\n')) }]);
  assert.deepEqual(reply.data.outcome, waiting);
});

test('each refusal of a post says why in its own sentence and records nothing', async t => {
  const c = await chats(t),
    channel = { type: 'project' },
    earlier = await post(c, c.projectId, { projectId: c.projectId, channel, text: 'An earlier message.' });
  assert.equal(earlier.status, 201);
  const base = { projectId: c.projectId, channel, text: 'Hello.' };
  const refusals = [
    [
      'an unknown field',
      { ...base, urgent: true },
      400,
      /^A message takes only projectId, channel, text, replyTo and attachments\.$/,
    ],
    [
      "another project's body",
      { ...base, projectId: c.other },
      400,
      /^Select this project before posting to its chat\.$/,
    ],
    ['no project in the body', { channel, text: 'Hello.' }, 400, /^Select this project before posting to its chat\.$/],
    [
      'a run of another project',
      { ...base, channel: { type: 'run', id: c.foreignRunId } },
      400,
      /^That run belongs to another project\.$/,
    ],
    [
      'a task of another project',
      { ...base, channel: { type: 'task', id: c.foreign.taskId } },
      400,
      /^That task belongs to another project\.$/,
    ],
    [
      'a reply to a message of another channel',
      { ...base, channel: { type: 'task', id: c.story.taskId }, replyTo: earlier.data.id },
      400,
      /^A reply stays in the channel of the message it answers\.$/,
    ],
    ['empty text', { ...base, text: '' }, 400, /^A message needs some text\.$/],
    ['8001 characters', { ...base, text: 'x'.repeat(8001) }, 400, /^A message holds at most 8000 characters\.$/],
    [
      'an attachment that is not accepted work',
      { ...base, attachments: [c.draft] },
      409,
      /^Only accepted work can be attached: that work is not accepted yet\.$/,
    ],
  ];
  const before = messageCount(c.store),
    sentences = new Set();
  for (const [label, body, status, sentence] of refusals) {
    const refused = await post(c, c.projectId, body);
    assert.equal(refused.status, status, `${label}: ${JSON.stringify(refused.data)}`);
    assert.match(refused.data.error, sentence, label);
    sentences.add(refused.data.error);
    assert.equal(messageCount(c.store), before, `${label} records nothing`);
  }
  // The two refusals of the body's project share one sentence; every other refusal has its own.
  assert.equal(sentences.size, refusals.length - 1);
  // 8000 characters is still a message.
  assert.equal((await post(c, c.projectId, { ...base, text: 'x'.repeat(8000) })).status, 201);
});

test('a chat reads a page at a time, newest last, back from a seq or on from one', async t => {
  const c = await chats(t),
    channel = { type: 'task', id: c.story.taskId },
    query = `channel=task:${c.story.taskId}`,
    sent = [];
  for (let i = 1; i <= 120; i++) {
    sent.push(recordMessage(c.store, c.projectId, { channel, text: `Note ${i}` }));
    // Messages of other chats between them are not part of this one.
    if (i % 40 === 0) recordMessage(c.store, c.projectId, { channel: { type: 'project' }, text: 'Elsewhere.' });
  }
  const seqs = messages => messages.map(message => message.seq);
  const first = await read(c, c.projectId, query);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.deepEqual(seqs(first.data.messages), seqs(sent.slice(70)));
  assert.equal(first.data.older, true);
  assert.equal(first.data.cursor, sent[119].seq);
  assert.equal(first.data.version, c.store.version);
  const second = await read(c, c.projectId, `${query}&before=${first.data.messages[0].seq}`);
  assert.deepEqual(seqs(second.data.messages), seqs(sent.slice(20, 70)));
  assert.equal(second.data.older, true);
  assert.equal(second.data.cursor, sent[69].seq);
  const last = await read(c, c.projectId, `${query}&before=${second.data.messages[0].seq}`);
  assert.deepEqual(seqs(last.data.messages), seqs(sent.slice(0, 20)));
  assert.equal(last.data.older, false);
  // A smaller page holds its limit.
  const small = await read(c, c.projectId, `${query}&limit=5`);
  assert.deepEqual(seqs(small.data.messages), seqs(sent.slice(115)));

  // After a seq: only newer messages, oldest first, and whether more wait beyond the limit.
  const resumed = await read(c, c.projectId, `${query}&after=${sent[99].seq}`);
  assert.equal(resumed.status, 200);
  assert.deepEqual(seqs(resumed.data.messages), seqs(sent.slice(100)));
  assert.equal(resumed.data.older, true);
  assert.equal(resumed.data.newer, false);
  assert.equal(resumed.data.cursor, sent[119].seq);
  const limited = await read(c, c.projectId, `${query}&after=${sent[99].seq}&limit=5`);
  assert.deepEqual(seqs(limited.data.messages), seqs(sent.slice(100, 105)));
  assert.equal(limited.data.newer, true);
  // Nothing new keeps the reader where it was.
  const caughtUp = await read(c, c.projectId, `${query}&after=${sent[119].seq}`);
  assert.deepEqual(caughtUp.data.messages, []);
  assert.equal(caughtUp.data.cursor, sent[119].seq);
  assert.equal(caughtUp.data.older, true);
  const fromStart = await read(c, c.projectId, `${query}&after=0&limit=3`);
  assert.deepEqual(seqs(fromStart.data.messages), seqs(sent.slice(0, 3)));
  assert.equal(fromStart.data.older, false);

  // A repeated or malformed before or after is refused, as an attempt's log refuses its paging.
  for (const name of ['before', 'after', 'limit'])
    for (const value of [`${name}=1&${name}=2`, `${name}=x`, `${name}=-1`, `${name}=1.5`, `${name}=`, `${name}=01`]) {
      const refused = await read(c, c.projectId, `${query}&${value}`);
      assert.equal(refused.status, 400, value);
      assert.equal(refused.data.error, `${name} must be a single nonnegative integer.`, value);
    }
  const both = await read(c, c.projectId, `${query}&before=5&after=1`);
  assert.equal(both.status, 400);
  assert.equal(both.data.error, 'Read a page before a message or after one, not both.');
  assert.equal((await read(c, c.projectId, `${query}&limit=0`)).status, 400);
  assert.equal((await read(c, c.projectId, `${query}&limit=201`)).status, 400);
  for (const wrong of ['', 'channel=team', 'channel=run:', `channel=project&channel=project`]) {
    const refused = await read(c, c.projectId, wrong);
    assert.equal(refused.status, 400, wrong);
    assert.equal(refused.data.error, 'channel must be project, run:<runId> or task:<taskId>, given once.', wrong);
  }
  // A chat of another project is refused in the words a post to it gets.
  for (const [wrong, sentence] of [
    [`channel=run:${c.foreignRunId}`, 'That run belongs to another project.'],
    [`channel=task:${c.foreign.taskId}`, 'That task belongs to another project.'],
  ]) {
    const refused = await read(c, c.projectId, wrong);
    assert.equal(refused.status, 400, wrong);
    assert.equal(refused.data.error, sentence, wrong);
  }
  assert.equal((await read(c, c.projectId, 'channel=task:T-missing')).status, 404);
  // The run's chat and the project's own read the same way.
  assert.deepEqual((await read(c, c.projectId, `channel=run:${c.runId}`)).data.messages, []);
  assert.equal((await read(c, c.projectId, 'channel=project')).data.messages.length, 3);
});

test("a posted message reaches its project's tabs as a change of type message, and no other project's tab", async t => {
  const c = await chats(t);
  // Let the change events of the setup's writes go out before the tabs open.
  await pause(300);
  const own = await watch(t, c.origin, `?projectId=${c.projectId}`),
    elsewhere = await watch(t, c.origin, `?projectId=${c.other}`);
  await c.until(
    () => [own, elsewhere].every(tab => tab.events.some(event => event.event === 'change')),
    'the connection change events',
  );
  const posted = await post(c, c.projectId, {
    projectId: c.projectId,
    channel: { type: 'task', id: c.story.taskId },
    text: 'Watch this.',
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  await c.until(() => own.changes().some(change => change.type === 'message'), 'the message change');
  assert.deepEqual(
    own
      .changes()
      .filter(change => change.type === 'message')
      .map(({ seq, ...change }) => change),
    [{ type: 'message', id: posted.data.id, projectId: c.projectId, channel: { type: 'task', id: c.story.taskId } }],
  );
  await pause(400);
  assert.deepEqual(
    elsewhere.changes().filter(change => change.type === 'message'),
    [],
    "another project's tab hears no message of this one",
  );
});

// Chat messages in their own table (team chat, November 2, 2026): a database from before them opens with every record
// as it was, a message reads back in its channel by its sequence, a page back or onward, each refusal says why in its
// own sentence and keeps nothing, @names name the project's agents in any case, attachments are accepted files checked
// by hash, the kept row holds no location on this computer, and deleting the project deletes its messages.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setup } from './studio-setup.mjs';
import { Store } from '../src/store.mjs';
import { hash } from '../src/core/contracts.mjs';
import { jobDirectory } from '../src/core/projects.mjs';
import { projectOrganization } from '../src/core/project-organization.mjs';
import { messageLimits, parseMentions, recordMessage, validateMessage } from '../src/core/messages.mjs';

async function addProject(c, name) {
  const created = await c.request('/api/projects', { name });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  return created.data.id;
}
// One of the project's own agents, made as the director makes one.
async function addAgent(c, projectId, displayName) {
  const config = (
    await fetch(`${c.origin}/api/state?projectId=${projectId}&mode=dashboard`).then(response => response.json())
  ).organizationConfiguration;
  const made = await c.request(`/api/projects/${projectId}/agents`, {
    projectId,
    expectedRevision: config.revision,
    displayName,
    jobTitle: 'Copywriter',
    teamId: config.teams[0].id,
    roles: ['copywriter'],
    provider: 'mock',
  });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  return made.data.worker.id;
}
// Work that handed back files, accepted as a finished story leaves it, with an earlier attempt that was not accepted.
function acceptedWork(store, projectId, name, files = { 'notes.md': '# Notes\n\nKeep it short.\n' }, status = 'done') {
  const taskId = `T-${name}`,
    attempt = {
      id: `attempt-${name}`,
      taskId,
      projectId,
      workerId: 'W-01',
      status: status === 'done' ? 'accepted' : 'review',
      result: {
        taskId,
        outcome: 'completed',
        summary: 'Wrote the notes.',
        artifacts: [],
        checks: [],
        issues: [],
        handoff: '',
      },
      artifacts: [],
    },
    earlier = { ...attempt, id: `attempt-${name}-earlier`, status: 'rejected' },
    output = path.join(jobDirectory(store, attempt), 'output');
  fs.mkdirSync(output, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(output, file), text);
    attempt.artifacts.push({ path: file, kind: 'document', hash: hash(Buffer.from(text)) });
  }
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
  store.insertAttempt(earlier, { text: 'Fixture', hash: 'fixture' });
  store.insertAttempt(attempt, { text: 'Fixture', hash: 'fixture' });
  return { taskId, attempt, earlier, output };
}
const messageCount = (store, projectId) =>
  store.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE project_id=?').get(projectId).count;
// The store's change notifications of messages while `during` runs.
function messageChanges(store, during) {
  const seen = [],
    notify = store.onChange;
  store.onChange = change => {
    if (change.type === 'message') seen.push(change);
    notify(change);
  };
  try {
    during();
  } finally {
    store.onChange = notify;
  }
  return seen;
}

test('a studio database from before messages opens with every record unchanged and gains an empty messages table', t => {
  const store = localStore(t),
    projectId = 'project-legacy';
  acceptedWork(store, projectId, 'before');
  store.event('note', null, null, 'Recorded before messages existed.', projectId);
  store.close();
  // A database from before this change: the same records, without the messages table or its lookup.
  const file = path.join(store.directory, 'studio.sqlite'),
    records = db =>
      Object.fromEntries(
        ['settings', 'tasks', 'attempts', 'events'].map(table => [
          table,
          db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        ]),
      ),
    old = new DatabaseSync(file);
  let before;
  try {
    old.exec('DROP INDEX messages_by_channel; DROP TABLE messages;');
    assert.equal(old.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'messages%'").get(), undefined);
    before = records(old);
  } finally {
    old.close();
  }
  for (const table of ['settings', 'tasks', 'attempts', 'events'])
    assert.ok(before[table].length, `the old database has ${table} to keep`);
  const reopened = new Store(store.directory, () => {
    assert.fail('Opening an existing database must not seed it again.');
  });
  try {
    assert.deepEqual(records(reopened.db), before);
    assert.equal(reopened.db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 0);
    assert.ok(
      reopened.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='messages_by_channel'").get(),
    );
    assert.deepEqual(reopened.messagePage(projectId, { type: 'project' }), { messages: [], older: false });
  } finally {
    reopened.close();
  }
});

test('a message reads back in its channel with its sequence, sender, text, mentions and attachments', async t => {
  const c = await setup(t),
    store = c.app.store,
    projectId = await addProject(c, 'Chat'),
    mara = projectOrganization(store, projectId).workers.find(worker => worker.displayName === 'Mara'),
    work = acceptedWork(store, projectId, 'notes'),
    story = { type: 'task', id: work.taskId };
  assert.ok(mara, "Mara is one of the project's agents");
  const first = recordMessage(store, projectId, {
    channel: story,
    text: '  @Mara, read the notes before you plan.  ',
    attachments: [{ taskId: work.taskId, attemptId: work.attempt.id, path: 'notes.md' }],
  });
  assert.match(first.id, /^msg-[0-9a-f-]{36}$/);
  assert.ok(Number.isSafeInteger(first.seq) && first.seq > 0);
  assert.equal(first.projectId, projectId);
  assert.deepEqual(first.channel, story);
  assert.deepEqual(first.from, { type: 'director' });
  assert.equal(first.text, '@Mara, read the notes before you plan.');
  assert.deepEqual(first.mentions, [mara.id]);
  assert.deepEqual(first.attachments, [
    {
      taskId: work.taskId,
      attemptId: work.attempt.id,
      path: 'notes.md',
      hash: hash(Buffer.from('# Notes\n\nKeep it short.\n')),
    },
  ]);
  assert.equal(first.replyTo, null);
  assert.equal(first.outcome, null);
  assert.ok(Number.isFinite(Date.parse(first.time)));
  assert.deepEqual(store.message(first.id), first);
  const reply = recordMessage(store, projectId, { channel: story, text: 'And keep it brief.', replyTo: first.id });
  assert.equal(reply.replyTo, first.id);
  assert.ok(reply.seq > first.seq);
  assert.deepEqual(store.messagesAfter(projectId, story, first.seq), { messages: [reply], newer: false });

  // The project's own channel, with a story's message between: sequences only grow, and a read after one returns
  // only the newer messages of that channel, in order.
  const channel = { type: 'project' },
    sent = [];
  for (let index = 1; index <= 7; index++) {
    sent.push(recordMessage(store, projectId, { channel, text: `Project note ${index}` }));
    if (index === 3) recordMessage(store, projectId, { channel: story, text: 'A story note between.' });
  }
  assert.deepEqual(
    sent.map(message => message.channel),
    sent.map(() => ({ type: 'project', id: null })),
  );
  for (let index = 1; index < sent.length; index++) assert.ok(sent[index].seq > sent[index - 1].seq);
  const after = store.messagesAfter(projectId, channel, sent[2].seq);
  assert.deepEqual(
    after.messages.map(message => message.text),
    ['Project note 4', 'Project note 5', 'Project note 6', 'Project note 7'],
  );
  assert.equal(after.newer, false);
  const resumed = store.messagesAfter(projectId, channel, sent[2].seq, { limit: 2 });
  assert.deepEqual(
    resumed.messages.map(message => message.seq),
    [sent[3].seq, sent[4].seq],
  );
  assert.equal(resumed.newer, true);

  // A page holds at most its limit, newest last, and says whether older ones exist; a read before its lowest
  // sequence returns the rest.
  const page = store.messagePage(projectId, channel, { limit: 3 });
  assert.deepEqual(
    page.messages.map(message => message.text),
    ['Project note 5', 'Project note 6', 'Project note 7'],
  );
  assert.equal(page.older, true);
  const rest = store.messagePage(projectId, channel, { before: page.messages[0].seq });
  assert.deepEqual(
    rest.messages.map(message => message.text),
    ['Project note 1', 'Project note 2', 'Project note 3', 'Project note 4'],
  );
  assert.equal(rest.older, false);
  const exact = store.messagePage(projectId, channel, { before: page.messages[0].seq, limit: 4 });
  assert.equal(exact.messages.length, 4);
  assert.equal(exact.older, false, 'no older message is left once the page reaches the first');
  assert.equal(store.messagePage(projectId, channel).messages.length, 7);
  assert.equal(messageLimits.page, 50);
  assert.throws(
    () => store.messagePage(projectId, channel, { limit: messageLimits.pageMax + 1 }),
    /limit must be an integer from 1 to 200/,
  );
  assert.equal(store.messagePage(projectId, channel, { limit: messageLimits.pageMax }).messages.length, 7);

  // A run's channel is its own.
  const runId = `run-${randomUUID()}`;
  store.putRun({ id: runId, projectId, createdAt: new Date().toISOString() });
  const run = recordMessage(store, projectId, { channel: { type: 'run', id: runId }, text: 'How is the run going?' });
  assert.deepEqual(run.channel, { type: 'run', id: runId });
  assert.deepEqual(store.messagePage(projectId, { type: 'run', id: runId }).messages, [run]);
});

test('each refusal says why in its own sentence and keeps nothing', async t => {
  const c = await setup(t),
    store = c.app.store,
    projectId = await addProject(c, 'Chat'),
    elsewhere = 'project-elsewhere';
  store.putProject({ id: elsewhere, name: 'Elsewhere' });
  const work = acceptedWork(store, projectId, 'notes', { 'notes.md': '# Notes\n', 'plan.md': '# Plan\n' }),
    unaccepted = acceptedWork(store, projectId, 'draft', { 'draft.md': '# Draft\n' }, 'review'),
    foreignRun = `run-${randomUUID()}`,
    foreign = acceptedWork(store, elsewhere, 'foreign');
  store.putRun({ id: foreignRun, projectId: elsewhere, createdAt: new Date().toISOString() });
  const channel = { type: 'project' },
    story = { type: 'task', id: work.taskId },
    earlier = recordMessage(store, projectId, { channel, text: 'An earlier message.' }),
    file = (fields = {}) => ({ taskId: work.taskId, attemptId: work.attempt.id, path: 'notes.md', ...fields });
  // The bytes of an accepted file changed after acceptance, in a work of its own.
  const changed = acceptedWork(store, projectId, 'changed', { 'changed.md': '# As accepted\n' });
  fs.writeFileSync(path.join(changed.output, 'changed.md'), '# Changed afterwards\n');
  const refusals = [
    ['an unknown field', { channel, text: 'Hello', urgent: true }, 400, /takes only a channel, its text/],
    [
      'a bad channel type',
      { channel: { type: 'team' }, text: 'Hello' },
      400,
      /channel is the project, a run or a task/,
    ],
    [
      "a run of another project's",
      { channel: { type: 'run', id: foreignRun }, text: 'Hello' },
      400,
      /That run belongs to another project/,
    ],
    [
      "a task of another project's",
      { channel: { type: 'task', id: foreign.taskId }, text: 'Hello' },
      400,
      /That task belongs to another project/,
    ],
    [
      'a reply to a message of another channel',
      { channel: story, text: 'Hello', replyTo: earlier.id },
      400,
      /A reply stays in the channel of the message it answers/,
    ],
    [
      'a reply to no message',
      { channel, text: 'Hello', replyTo: `msg-${randomUUID()}` },
      404,
      /The message you reply to was not found/,
    ],
    ['empty text', { channel, text: '' }, 400, /A message needs some text/],
    ['whitespace text', { channel, text: ' \n\t ' }, 400, /A message needs some text/],
    ['8001 characters', { channel, text: 'x'.repeat(8001) }, 400, /at most 8000 characters/],
    [
      'eleven attachments',
      { channel, text: 'Hello', attachments: Array.from({ length: 11 }, () => file()) },
      400,
      /at most 10 attachments/,
    ],
    [
      'an attachment of unaccepted work',
      {
        channel,
        text: 'Hello',
        attachments: [{ taskId: unaccepted.taskId, attemptId: unaccepted.attempt.id, path: 'draft.md' }],
      },
      409,
      /Only accepted work can be attached: that work is not accepted yet/,
    ],
    [
      'an attachment of an attempt that is not the accepted one',
      { channel, text: 'Hello', attachments: [file({ attemptId: work.earlier.id })] },
      409,
      /that attempt is not the one accepted/,
    ],
    [
      'an attachment of a path the attempt did not hand back',
      { channel, text: 'Hello', attachments: [file({ path: 'other.md' })] },
      404,
      /not one the accepted work handed back/,
    ],
    [
      'an attachment whose bytes changed after acceptance',
      {
        channel,
        text: 'Hello',
        attachments: [{ taskId: changed.taskId, attemptId: changed.attempt.id, path: 'changed.md' }],
      },
      409,
      /The attached file changed after it was accepted/,
    ],
  ];
  const kept = messageCount(store, projectId),
    sentences = [];
  for (const [what, fields, status, sentence] of refusals) {
    let refusal;
    const changes = messageChanges(store, () => {
      try {
        recordMessage(store, projectId, fields);
      } catch (error) {
        refusal = error;
      }
    });
    assert.ok(refusal, `${what} is refused`);
    assert.match(refusal.message, sentence, what);
    assert.match(refusal.message, /^[A-Z].*\.$/, `${what} is refused in a plain sentence`);
    assert.equal(refusal.status, status, what);
    assert.deepEqual(changes, [], `${what} notifies no change`);
    assert.equal(messageCount(store, projectId), kept, `${what} keeps nothing`);
    // Empty and whitespace text are one refusal: no text once trimmed.
    if (what !== 'whitespace text') sentences.push(refusal.message);
  }
  assert.equal(new Set(sentences).size, sentences.length, 'each refusal has its own sentence');
  assert.throws(() => validateMessage(store, projectId, { channel, text: 'x'.repeat(8001) }), /at most 8000/);
  // The bounds themselves are kept: 8000 characters after trimming, and ten attachments.
  const longest = recordMessage(store, projectId, { channel, text: `  ${'x'.repeat(8000)}  ` });
  assert.equal(longest.text.length, 8000);
  const ten = recordMessage(store, projectId, {
    channel,
    text: 'Ten files.',
    attachments: Array.from({ length: 10 }, (_, index) => file({ path: index % 2 ? 'plan.md' : 'notes.md' })),
  });
  assert.equal(ten.attachments.length, 10);
});

test("@names mention the project's agents in any case; other names and email addresses mention no one", async t => {
  const c = await setup(t),
    store = c.app.store,
    projectId = await addProject(c, 'Chat'),
    workers = projectOrganization(store, projectId).workers,
    mara = workers.find(worker => worker.displayName === 'Mara'),
    maraLee = await addAgent(c, projectId, 'Mara Lee'),
    channel = { type: 'project' },
    mentions = text => recordMessage(store, projectId, { channel, text });
  assert.ok(mara, "Mara is one of the project's agents");
  assert.deepEqual(mentions('@MARA, can you plan this?').mentions, [mara.id]);
  assert.deepEqual(mentions('@mara can you plan this?').mentions, [mara.id]);
  const nobody = mentions('Ask @Nobody about it.');
  assert.deepEqual(nobody.mentions, []);
  assert.equal(nobody.text, 'Ask @Nobody about it.');
  assert.deepEqual(mentions('Write to a@mara.com when it is done.').mentions, []);
  // The longest name first: '@Mara Lee' names Mara Lee, and each agent is named once, in the order first named.
  assert.deepEqual(mentions('@Mara Lee and @mara, then @MARA LEE again.').mentions, [maraLee, mara.id]);
});

test('mention names end at a word boundary and prefer the longest matching name', () => {
  const people = [
    { id: 'W-1', displayName: 'Mara' },
    { id: 'W-2', displayName: 'Mara Lee' },
  ];
  assert.deepEqual(parseMentions('@Mara.', people), ['W-1']);
  assert.deepEqual(parseMentions("(@mara) and @Mara's plan", people), ['W-1']);
  assert.deepEqual(parseMentions('@Marabou and @mara.com and me@Mara and @Mara-Lee', people), []);
  assert.deepEqual(parseMentions('no one here', people), []);
  assert.deepEqual(parseMentions('@MARA LEE, then @mara and @Nobody.', people), ['W-2', 'W-1']);
  assert.deepEqual(parseMentions('a@mara.com', people), []);
});

test('the kept row holds IDs, names and hashes only, and recording notifies one change of its project', async t => {
  const c = await setup(t),
    store = c.app.store,
    projectId = await addProject(c, 'Chat'),
    work = acceptedWork(store, projectId, 'notes'),
    story = { type: 'task', id: work.taskId };
  let message;
  const changes = messageChanges(store, () => {
    message = recordMessage(store, projectId, {
      channel: story,
      text: '@Mara, the notes are attached.',
      attachments: [{ taskId: work.taskId, attemptId: work.attempt.id, path: 'notes.md' }],
    });
  });
  assert.deepEqual(changes, [
    { seq: changes[0].seq, type: 'message', id: message.id, projectId, channel: { type: 'task', id: work.taskId } },
  ]);
  const row = store.db.prepare('SELECT * FROM messages WHERE id=?').get(message.id),
    stored = { ...row, data: JSON.parse(row.data) },
    strings = value =>
      typeof value === 'string'
        ? [value]
        : value && typeof value === 'object'
          ? Object.values(value).flatMap(strings)
          : [],
    keys = value =>
      value && typeof value === 'object' ? Object.entries(value).flatMap(([key, inner]) => [key, ...keys(inner)]) : [];
  assert.deepEqual(Object.keys(stored.data).sort(), ['attachments', 'from', 'mentions', 'outcome', 'text']);
  for (const value of strings(stored)) {
    assert.ok(!path.isAbsolute(value) && !/^[A-Za-z]:[\\/]/.test(value), `${value} is no location on this computer`);
    assert.ok(!value.includes(store.directory) && !value.includes(work.output), `${value} names no job folder`);
    assert.doesNotMatch(value, /(^|[\\/])jobs[\\/]|[\\/]output[\\/]/);
  }
  for (const key of keys(stored)) assert.doesNotMatch(key, /pid|process|session|folder|job|directory|cwd/i);
  assert.equal(row.channel_id, work.taskId);
  assert.equal(stored.data.attachments[0].path, 'notes.md');

  // Its recorded outcome changes later as a change of its own; its words stay.
  const decided = messageChanges(store, () => store.setMessageOutcome(message.id, { kind: 'note' }));
  assert.equal(decided.length, 1);
  assert.equal(decided[0].id, message.id);
  assert.equal(decided[0].projectId, projectId);
  assert.deepEqual(store.message(message.id), { ...message, outcome: { kind: 'note' } });
  assert.throws(() => store.setMessageOutcome(`msg-${randomUUID()}`, null), /Message not found/);
});

test("deleting the project deletes its messages and keeps another project's", async t => {
  const c = await setup(t),
    store = c.app.store,
    projectId = await addProject(c, 'Chat'),
    other = await addProject(c, 'Other'),
    work = acceptedWork(store, projectId, 'notes');
  recordMessage(store, projectId, { channel: { type: 'project' }, text: 'A project note.' });
  recordMessage(store, projectId, { channel: { type: 'task', id: work.taskId }, text: 'A story note.' });
  const kept = recordMessage(store, other, { channel: { type: 'project' }, text: 'Another project.' });
  assert.equal(messageCount(store, projectId), 2);
  const deleted = await c.request(`/api/projects/${projectId}/delete`, { projectId, name: 'Chat' });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
  assert.equal(messageCount(store, projectId), 0);
  assert.deepEqual(store.messagePage(other, { type: 'project' }).messages, [kept]);
});

// Direct store checks also run without HTTP: the channel's cursor and the validation boundary need no server.
function localStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-messages-')),
    store = new Store(directory);
  t.after(() => {
    if (store.db.isOpen) store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return store;
}

test('core channel paging uses fifty by default, caps at two hundred and isolates cursor gaps', t => {
  const store = localStore(t),
    projectId = 'project-legacy',
    channel = { type: 'project' },
    sent = [];
  store.putProject({ id: 'project-other', name: 'Other' });
  for (let index = 0; index < 120; index++) {
    sent.push(recordMessage(store, projectId, { channel, text: `Note ${index}` }));
    recordMessage(store, 'project-other', { channel, text: 'A gap in the sequence.' });
  }
  const newest = store.messagePage(projectId, channel),
    middle = store.messagePage(projectId, channel, { before: newest.messages[0].seq }),
    oldest = store.messagePage(projectId, channel, { before: middle.messages[0].seq });
  assert.deepEqual(newest, { messages: sent.slice(70), older: true });
  assert.deepEqual(middle, { messages: sent.slice(20, 70), older: true });
  assert.deepEqual(oldest, { messages: sent.slice(0, 20), older: false });
  assert.deepEqual(store.messagesAfter(projectId, channel), { messages: sent.slice(0, 50), newer: true });
  assert.deepEqual(store.messagesAfter(projectId, channel, sent[69].seq), { messages: sent.slice(70), newer: false });
  assert.deepEqual(store.messagePage(projectId, channel, { before: 0 }), { messages: [], older: false });
  assert.deepEqual(store.messagePage(projectId, channel, { limit: 200 }), { messages: sent, older: false });
  for (const limit of [0, -1, 201, 1.5, NaN, '50']) {
    assert.throws(() => store.messagePage(projectId, channel, { limit }), { status: 400 });
    assert.throws(() => store.messagesAfter(projectId, channel, 0, { limit }), { status: 400 });
  }
  for (const cursor of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => store.messagePage(projectId, channel, { before: cursor }), { status: 400 });
    assert.throws(() => store.messagesAfter(projectId, channel, cursor), { status: 400 });
  }
});

test('core message validation keeps accepted identities and refuses malformed metadata without recording a change', t => {
  const store = localStore(t),
    projectId = 'project-legacy',
    channel = { type: 'project' },
    work = acceptedWork(store, projectId, 'local'),
    fields = {
      channel,
      text: '@MARA, check this.',
      attachments: [{ taskId: work.taskId, attemptId: work.attempt.id, path: 'notes.md' }],
    },
    changes = [];
  store.onChange = change => changes.push(change);
  const sent = recordMessage(store, projectId, fields);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0], {
    seq: store.version,
    type: 'message',
    id: sent.id,
    projectId,
    channel: { type: 'project', id: null },
  });
  assert.deepEqual(store.message(sent.id), sent);
  assert.deepEqual(sent.from, { type: 'director' });
  assert.deepEqual(sent.mentions, [
    projectOrganization(store, projectId).workers.find(worker => worker.displayName === 'Mara').id,
  ]);
  assert.deepEqual(sent.attachments, [{ ...fields.attachments[0], hash: work.attempt.artifacts[0].hash }]);
  const count = messageCount(store, projectId);
  for (const invalid of [
    { ...fields, extra: true },
    { ...fields, channel: { type: 'project', job: work.output } },
    { ...fields, channel: { type: 'project', id: work.taskId } },
    { ...fields, attachments: null },
    { ...fields, attachments: {} },
    { ...fields, attachments: [{ ...fields.attachments[0], hash: 'forged' }] },
    { ...fields, replyTo: `msg-${randomUUID()}` },
  ])
    assert.throws(
      () => recordMessage(store, projectId, invalid),
      error => error.status >= 400 && /\.$/.test(error.message),
    );
  assert.throws(
    () =>
      recordMessage(store, projectId, fields, {
        type: 'agent',
        id: 'W-01',
        pid: 123,
        session: 'private',
        job: work.output,
      }),
    { status: 400 },
  );
  fs.writeFileSync(path.join(work.output, 'notes.md'), 'Changed after acceptance.');
  assert.throws(() => recordMessage(store, projectId, fields), /changed after it was accepted/);
  assert.equal(messageCount(store, projectId), count);
  assert.equal(changes.length, 1);
  const updated = store.setMessageOutcome(sent.id, { type: 'waiting', reason: 'Waiting for a reply.' });
  assert.deepEqual(updated, { ...sent, outcome: { type: 'waiting', reason: 'Waiting for a reply.' } });
  assert.equal(changes.length, 2);
  assert.deepEqual(changes[1], { ...changes[0], seq: store.version });
  store.putProject({ id: 'project-other', name: 'Other' });
  const kept = recordMessage(store, 'project-other', { channel, text: 'Keep this.' });
  store.tx(() => store.deleteProjectRecords(projectId, [work.taskId], [work.attempt.id, work.earlier.id]));
  assert.equal(store.message(sent.id), null);
  assert.deepEqual(store.messagePage('project-other', channel).messages, [kept]);
});

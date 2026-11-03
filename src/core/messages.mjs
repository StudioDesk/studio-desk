// Chat messages (team chat, November 2, 2026): what one message holds, checked before the store keeps it. A message
// goes to one channel of a project: the project's own, one of its runs or one of its tasks. It is from the director
// unless its caller says otherwise, its text names agents with @, and it may answer an earlier message of the same
// channel and point at files of accepted work, each checked by its hash. What it keeps are IDs, names and hashes: no
// location on this computer, process, session or job folder. A director's message that names the agent building a task,
// on that task's thread, takes the one action the task's state already allows, and one that names an idea's planner, in
// the idea's chat, plans again or revises the plan as a reply to the plan does (postMessage). No HTTP here: the routes
// call it.
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { acceptedReference, artifactPath } from './artifacts.mjs';
import { runIdOf } from './graph.mjs';
import { projectIdentity, recordProject } from './projects.mjs';
import { projectOrganization } from './project-organization.mjs';
import { directStart, replanWork, reviseWork, sendBackWork } from './proposals.mjs';

export const messageLimits = Object.freeze({
  textMin: 1,
  textMax: 8000,
  attachments: 10,
  page: 50,
  pageMax: 200,
});
export const messageChannelTypes = Object.freeze(['project', 'run', 'task']);

const fieldNames = ['channel', 'text', 'replyTo', 'attachments'],
  attachmentFields = ['taskId', 'attemptId', 'path'],
  messageIdentity = /^msg-[0-9a-f-]{36}$/,
  sha256 = bytes => createHash('sha256').update(bytes).digest('hex'),
  failure = (message, status = 400) => Object.assign(new Error(message), { status }),
  plainObject = value => !!value && typeof value === 'object' && !Array.isArray(value),
  // A letter, digit or underscore: what continues a word, so an @ after one is part of an address, not a mention.
  wordCharacter = /[\p{L}\p{N}_]/u;

// One of the project's channels as a message keeps it, or a plain refusal. Reading a channel checks it here too, so
// a channel of another project is refused in the same words whether a message is posted to it or it is read.
export function checkChannel(store, projectId, channel) {
  if (!plainObject(channel)) throw failure('A message names its channel: the project, a run or a task.');
  if (Object.keys(channel).some(key => !['type', 'id'].includes(key)))
    throw failure("A message's channel takes only its type and, for a run or a task, its ID.");
  if (!messageChannelTypes.includes(channel.type))
    throw failure("A message's channel is the project, a run or a task.");
  if (channel.type === 'project') {
    if (channel.id !== undefined && channel.id !== null) throw failure("The project's channel takes no ID.");
    return { type: 'project', id: null };
  }
  if (typeof channel.id !== 'string' || !channel.id.trim())
    throw failure(`A ${channel.type}'s channel names the ${channel.type}.`);
  if (channel.type === 'run') {
    const run = store.run(channel.id);
    if (!run) throw failure('That run was not found.', 404);
    if (recordProject(run) !== projectId) throw failure('That run belongs to another project.');
  } else {
    let task;
    try {
      task = store.task(channel.id);
    } catch {
      throw failure('That task was not found.', 404);
    }
    if (recordProject(task) !== projectId) throw failure('That task belongs to another project.');
  }
  return { type: channel.type, id: channel.id };
}

function checkReply(store, projectId, channel, replyTo) {
  if (replyTo === undefined || replyTo === null) return null;
  const earlier = typeof replyTo === 'string' && messageIdentity.test(replyTo) ? store.message(replyTo) : null;
  // A message of another project is not one this channel can see.
  if (!earlier || earlier.projectId !== projectId) throw failure('The message you reply to was not found.', 404);
  if (earlier.channel.type !== channel.type || earlier.channel.id !== channel.id)
    throw failure('A reply stays in the channel of the message it answers.');
  return earlier.id;
}

// One file of accepted work, checked the way the library checks one: the task's accepted attempt, a file that
// attempt handed back, and its bytes as they were accepted. It is kept by its recorded name and hash.
function checkAttachment(store, projectId, attachment) {
  if (
    !plainObject(attachment) ||
    Object.keys(attachment).length !== attachmentFields.length ||
    !attachmentFields.every(key => typeof attachment[key] === 'string' && attachment[key])
  )
    throw failure('An attachment names its task, its attempt and the path of the file, and nothing else.');
  let task;
  try {
    task = store.task(attachment.taskId);
  } catch {
    throw failure('An attachment names work that was not found.', 404);
  }
  if (recordProject(task) !== projectId) throw failure("An attachment's work belongs to another project.");
  if (task.status !== 'done' || !task.acceptedAttemptId)
    throw failure('Only accepted work can be attached: that work is not accepted yet.', 409);
  if (attachment.attemptId !== task.acceptedAttemptId)
    throw failure("Only the accepted attempt's files can be attached: that attempt is not the one accepted.", 409);
  let attempt;
  try {
    attempt = store.attempt(task.acceptedAttemptId);
  } catch {
    throw failure("The attachment's accepted attempt was not found.", 409);
  }
  const item = (attempt.artifacts || []).find(artifact => artifact.path === attachment.path);
  if (!item) throw failure('That file is not one the accepted work handed back.', 404);
  let bytes;
  try {
    bytes = fs.readFileSync(artifactPath(store, attempt, item.path));
  } catch {
    throw failure('The attached file is missing from the accepted work.', 409);
  }
  if (sha256(bytes) !== item.hash) throw failure('The attached file changed after it was accepted.', 409);
  try {
    acceptedReference(store, task.id, attempt.id, projectId);
  } catch {
    throw failure("Only accepted work can be attached: that work's accepted files no longer match their record.", 409);
  }
  return { taskId: task.id, attemptId: attempt.id, path: item.path, hash: item.hash };
}

// Checks a message's fields for one of the project's channels and returns them as they are kept, or throws an Error
// with a plain sentence and a status. Fields: { channel: { type, id? }, text, replyTo?, attachments? }.
export function validateMessage(store, projectId, fields) {
  try {
    store.project(projectIdentity(projectId));
  } catch {
    throw failure('Project not found.', 404);
  }
  if (!plainObject(fields)) throw failure('A message takes a channel and its text.');
  if (Object.keys(fields).some(key => !fieldNames.includes(key)))
    throw failure('A message takes only a channel, its text, the message it replies to and attachments.');
  const channel = checkChannel(store, projectId, fields.channel);
  if (typeof fields.text !== 'string') throw failure('A message needs some text.');
  const text = fields.text.trim();
  if (text.length < messageLimits.textMin) throw failure('A message needs some text.');
  if (text.length > messageLimits.textMax)
    throw failure(`A message holds at most ${messageLimits.textMax} characters.`);
  const replyTo = checkReply(store, projectId, channel, fields.replyTo),
    attachments = fields.attachments === undefined ? [] : fields.attachments;
  if (!Array.isArray(attachments)) throw failure("A message's attachments are a list of accepted files.");
  if (attachments.length > messageLimits.attachments)
    throw failure(`A message holds at most ${messageLimits.attachments} attachments.`);
  return {
    channel,
    text,
    replyTo,
    attachments: attachments.map(attachment => checkAttachment(store, projectId, attachment)),
  };
}

// The IDs of the agents a text names with @Name, in the order first named: each agent's display name matched in any
// case, the longest name first, ending at a word's end, so '@Mara,' and '@mara' name Mara and '@Mara Lee' names Mara
// Lee when the project has both. An @ inside a word (an email address) names no one, nor does a name no agent has.
export function parseMentions(text, workers = []) {
  if (typeof text !== 'string' || !text.includes('@')) return [];
  const names = workers
      .filter(worker => typeof worker?.id === 'string' && typeof worker.displayName === 'string')
      .map(worker => ({ id: worker.id, name: worker.displayName.trim() }))
      .filter(worker => worker.name)
      .map(worker => ({ ...worker, folded: worker.name.toLowerCase() }))
      .sort((a, b) => b.name.length - a.name.length),
    found = [];
  for (let at = text.indexOf('@'); at >= 0; at = text.indexOf('@', at + 1)) {
    const before = text[at - 1] ?? '';
    if (wordCharacter.test(before) || /[.+\-@]/.test(before)) continue;
    const named = names.find(worker => {
      if (text.slice(at + 1, at + 1 + worker.name.length).toLowerCase() !== worker.folded) return false;
      const next = text[at + 1 + worker.name.length] ?? '',
        after = text[at + 2 + worker.name.length] ?? '';
      // A name ends at a word's end: not inside a longer word, nor followed by '.name', '-name' or '@name'.
      return !wordCharacter.test(next) && !(/[.\-@]/.test(next) && wordCharacter.test(after));
    });
    if (named && !found.includes(named.id)) found.push(named.id);
  }
  return found;
}

// Checks and keeps a message from the director (or another sender the caller names, such as an agent by its ID),
// with the agents its text names. Returns the message as the store reads it back, with its sequence. The caller may
// record what the message led to with it (`outcome`, such as waiting for a reply), so it is kept in the same write.
export function recordMessage(store, projectId, fields, from = { type: 'director' }, { outcome = null } = {}) {
  return store.insertMessage(preparedMessage(store, projectId, fields, from, outcome));
}

// A message as the store keeps it, checked, or a plain refusal. Nothing is written.
function preparedMessage(store, projectId, fields, from, outcome) {
  if (outcome !== null && !plainObject(outcome)) throw new Error("A message's outcome is a record or none.");
  if (
    !plainObject(from) ||
    Object.keys(from).some(key => !['type', 'id', 'name', 'displayName'].includes(key)) ||
    typeof from.type !== 'string' ||
    !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(from.type) ||
    (from.id !== undefined && (typeof from.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(from.id))) ||
    ['name', 'displayName'].some(key => from[key] !== undefined && (typeof from[key] !== 'string' || !from[key].trim()))
  )
    throw failure('A message names who it is from.');
  const message = validateMessage(store, projectId, fields),
    workers = projectOrganization(store, projectId).workers || [];
  return {
    id: `msg-${randomUUID()}`,
    projectId,
    channel: message.channel,
    from,
    text: message.text,
    mentions: parseMentions(message.text, workers),
    attachments: message.attachments,
    replyTo: message.replyTo,
    time: new Date().toISOString(),
    outcome,
  };
}

const waiting = Object.freeze({ type: 'waiting', reason: 'Waiting for a reply.' });

// Which of the director's own actions a mention of a task's builder takes, by the task's state: send back work whose
// later stage returned it or passed (where its stages allow it), revise work awaiting review, or start stopped or ready
// work with the message as its direction. Anything else (running or stopping work, accepted work with nothing to send
// back, work waiting for the director's approval or closed) keeps the message as a note. Planned work is never
// approved by a mention, nor started before its approval. Work whose integration is approved and waiting to run is
// what Send back refuses (`refuseIntegration`), and the mention is refused in its words.
function mentionAction(store, registries, task, refuseIntegration) {
  if (task.approval && task.approval.status !== 'approved') return 'note';
  const stages = registries.workflows.stagesOf(task);
  if (stages?.returnable && stages.retry) {
    if (refuseIntegration?.(task)) return 'send-back';
    let returned;
    try {
      returned = stages.returnable(store, task);
    } catch {
      // Send back refuses it in the same words, and the message says so.
      returned = true;
    }
    if (returned) return 'send-back';
  }
  if (task.status === 'review') return 'revise';
  if (['ready', 'failed', 'cancelled', 'blocked'].includes(task.status)) return 'start';
  return 'note';
}

// The kinds of an idea's plan step: the ones the idea conversation reads.
export const planKinds = Object.freeze(['studio-development:breakdown', 'general:plan']);

// An idea's plan step: its run's task of a planning kind, or null.
export function planStepOf(store, projectId, runId) {
  return store.projectTasks(projectId).find(task => runIdOf(task) === runId && planKinds.includes(task.kind)) ?? null;
}

// The idea's planner as its conversation names it: the agent of the plan step's latest attempt, else the step's own.
export function plannerOf(store, plan) {
  const latest = store
    .attempts(plan.id)
    .sort((a, b) => Date.parse(String(a.startedAt ?? '')) - Date.parse(String(b.startedAt ?? '')))
    .at(-1);
  return latest?.workerId ?? plan.workerId ?? null;
}

const notNow = 'The plan cannot take a reply now.';

// Why a plan neither accepted nor waiting for review takes no reply: it is being written, it waits for an answer or a
// new start, its planning stopped, or it was closed.
function planRefusal(plan) {
  if (plan.closed || plan.status === 'denied') return `${notNow} It was closed.`;
  if (['backlog', 'ready', 'running', 'stopping'].includes(plan.status))
    return `${notNow} It is still being written; reply once it arrives.`;
  if (plan.status === 'blocked') return `${notNow} It waits for your answer, or for its planning to start again.`;
  if (['failed', 'cancelled'].includes(plan.status))
    return `${notNow} Its planning stopped; start it again from its page.`;
  return notNow;
}

// In an idea's chat (its run's channel), a message naming the idea's planner is the director's reply to the plan, as
// the idea conversation sends it: an accepted plan whose steps all wait is planned again with the message's text
// (replanWork, as Reply's replan route), a plan waiting for review is revised with it (reviseWork, as Reply's revise),
// and either is then queued as Start. A plan being written, waiting for an answer or with a step started takes no
// reply: the message is refused with a plain sentence and nothing changes. A message naming anyone else waits.
function plannerMention(store, registries, message, keep, queueStart) {
  const plan = planStepOf(store, message.projectId, message.channel.id),
    planner = plan && plannerOf(store, plan);
  if (!planner || !message.mentions.includes(planner)) return keep(waiting);
  const refused = reason => `${notNow} ${reason}`;
  if (plan.status === 'done' && !plan.closed)
    return actOn(
      store,
      keep,
      plan,
      queueStart,
      'replanned',
      record => replanWork(store, registries, plan, message.text, { record }),
      refused,
    );
  if (plan.status === 'review')
    return actOn(
      store,
      keep,
      plan,
      queueStart,
      'revised',
      record => reviseWork(store, registries, plan, message.text, { record }),
      refused,
    );
  return keep({ type: 'refused', reason: planRefusal(plan) });
}

// The director's message to one of the project's chats (team chat). Checked first: nothing runs for a message that
// fails its checks. In an idea's chat, a message naming the idea's planner replies to the plan (plannerMention) and is
// kept with { type: 'replanned' | 'revised', taskId, start }, or refused. On a task's thread, a message naming the task's builder (task.workerId) takes one action through
// the functions the director's buttons call, with the message's text as its note or direction, and is kept in that
// action's transaction with what it led to: { type: 'sent-back' | 'revised' | 'started', taskId }. The work is then
// queued as those buttons queue it (`queueStart`, the controller's queued Start), and the queue's answer is added as
// the outcome's `start`. Work the mention cannot act on keeps the message as a note ({ type: 'note', taskId,
// receivedBy: null }); an action that refuses (`refuseIntegration`, the controller's refusal of an approved
// integration, or the action's own checks) keeps it with { type: 'refused', reason } and changes nothing else. Any
// other message waits for a reply. Returns the message as the store reads it back.
export function postMessage(store, registries, projectId, fields, { queueStart, refuseIntegration } = {}) {
  const message = preparedMessage(store, projectId, fields, { type: 'director' }, waiting),
    keep = outcome => store.insertMessage({ ...message, outcome });
  if (message.channel.type === 'run') return plannerMention(store, registries, message, keep, queueStart);
  const task = message.channel.type === 'task' ? store.task(message.channel.id) : null;
  if (!task?.workerId || !message.mentions.includes(task.workerId)) return keep(waiting);
  const action = mentionAction(store, registries, task, refuseIntegration);
  if (action === 'note') return keep({ type: 'note', taskId: task.id, receivedBy: null });
  return actOn(
    store,
    keep,
    task,
    queueStart,
    action === 'send-back' ? 'sent-back' : action === 'revise' ? 'revised' : 'started',
    record => {
      if (action === 'send-back')
        sendBackWork(store, registries, task, message.text, {
          refuse: current => refuseIntegration?.(current),
          record,
        });
      else if (action === 'revise') reviseWork(store, registries, task, message.text, { record });
      else directStart(store, registries, task, message.text, { record });
    },
  );
}

// Takes an action that keeps the message in the action's own transaction (`record`) with { type, taskId }, then
// queues the work as the director's buttons queue it (`queueStart`) and adds the queue's answer as the outcome's
// `start`. An action that refuses keeps the message as refused, in `refused`'s words, and changes nothing else.
function actOn(store, keep, task, queueStart, type, act, refused = reason => reason) {
  let kept;
  try {
    act(() => (kept = keep({ type, taskId: task.id })));
  } catch (error) {
    if (kept) throw error;
    return keep({ type: 'refused', reason: refused(error.message) });
  }
  let start;
  try {
    start = queueStart(task.id);
  } catch (error) {
    // The action is recorded either way; Start can be pressed once the problem is resolved.
    start = { ok: false, reason: error.message };
  }
  return store.setMessageOutcome(kept.id, { ...kept.outcome, start });
}

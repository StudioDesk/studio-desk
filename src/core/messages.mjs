// Chat messages (team chat, November 2, 2026): what one message holds, checked before the store keeps it. A message
// goes to one channel of a project: the project's own, one of its runs or one of its tasks. It is from the director
// unless its caller says otherwise, its text names agents with @, and it may answer an earlier message of the same
// channel and point at files of accepted work, each checked by its hash. What it keeps are IDs, names and hashes: no
// location on this computer, process, session or job folder. This module records messages only; what a mention does
// comes later. No HTTP here: the routes call it.
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { acceptedReference, artifactPath } from './artifacts.mjs';
import { projectIdentity, recordProject } from './projects.mjs';
import { projectOrganization } from './project-organization.mjs';

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

function checkChannel(store, projectId, channel) {
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
// with the agents its text names. Returns the message as the store reads it back, with its sequence.
export function recordMessage(store, projectId, fields, from = { type: 'director' }) {
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
  return store.insertMessage({
    id: `msg-${randomUUID()}`,
    projectId,
    channel: message.channel,
    from,
    text: message.text,
    mentions: parseMentions(message.text, workers),
    attachments: message.attachments,
    replyTo: message.replyTo,
    time: new Date().toISOString(),
    outcome: null,
  });
}

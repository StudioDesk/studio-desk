// Why the controller last stopped (C-41, November 2026). On November 1 the live controller stopped with nothing in its
// window, and a graceful stop, an ended server and an ended supervisor all looked alike. Each start now writes a record
// of itself to the data folder, and each stop it can see completes the record with when and why: a signal, a planned
// restart, a start that failed, an uncaught error, an exit. The next start reports the record. A record with no stop
// means the process was ended from outside (Task Manager, taskkill, a closed window), crashed hard, or the computer
// stopped, which is itself the answer.
import fs from 'node:fs';
import path from 'node:path';

export const stopRecordName = 'last-exit.json';

const file = directory => path.join(directory, stopRecordName);

const read = directory => {
  try {
    const record = JSON.parse(fs.readFileSync(file(directory), 'utf8'));
    return record && typeof record === 'object' && typeof record.startedAt === 'string' ? record : null;
  } catch {
    return null;
  }
};
// Writing the record never stops a start or a stop.
const write = (directory, record) => {
  try {
    fs.writeFileSync(file(directory), JSON.stringify(record, null, 2) + '\n');
  } catch {}
};

export function uptimeText(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'an unknown time';
  const days = Math.floor(seconds / 86400),
    hours = Math.floor((seconds % 86400) / 3600),
    minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days} d ${hours} h`;
  if (hours) return `${hours} h ${minutes} min`;
  if (minutes) return `${minutes} min`;
  return `${Math.floor(seconds)} s`;
}

// What the previous run's record says, in a sentence, or null when there is none.
export function previousStop(directory) {
  const record = read(directory);
  if (!record) return null;
  if (!record.stoppedAt)
    return {
      record,
      recorded: false,
      text: `The previous controller (process ${record.pid}, started ${record.startedAt}) stopped without recording why: it was ended from outside, crashed hard, or the computer stopped.`,
    };
  return {
    record,
    recorded: true,
    text: `The previous controller stopped at ${record.stoppedAt} after ${uptimeText(record.uptimeSeconds)}: ${record.reason}.`,
  };
}

// This run's record: written at start, completed once at stop. Later stops of the same run change nothing.
export function stopRecorder(directory, { pid = process.pid, startedAt = new Date() } = {}) {
  const record = { pid, startedAt: startedAt.toISOString() };
  write(directory, record);
  let stopped = false;
  return {
    record,
    stop(reason, at = new Date()) {
      if (stopped) return false;
      stopped = true;
      Object.assign(record, {
        stoppedAt: at.toISOString(),
        uptimeSeconds: Math.round((at - startedAt) / 1000),
        reason: String(reason).slice(0, 500),
      });
      write(directory, record);
      return true;
    },
  };
}

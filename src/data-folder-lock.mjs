// The controller's claim on its data folder (November 2026). Until now a start decided who owned the folder from the
// owner record (the settings row 'controller-owner') by asking the operating system about the recorded process ID and
// when it began, so a program the system had handed an old controller's ID to could refuse a start, and only a guess
// let one through. The claim is now a lock the operating system holds for the controller's connection: an exclusive
// SQLite lock on a file of its own beside the studio's records, taken through the SQLite Node already includes. The
// system releases it however the controller ends (a close, a crash, Task Manager, a stopped computer), and while it is
// held no second controller starts. The studio's own database (studio.sqlite) is never the lock file; the lock file
// may stay in the folder after release, since only the held lock matters.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

export const dataFolderLockName = 'controller.lock';

const ownedMessage = 'Another controller owns this data folder. Stop it before starting another instance.';

// SQLite's answer when another connection holds the lock: SQLITE_BUSY, its extended codes included.
const busy = error => (error?.errcode & 0xff) === 5 || /database is locked/.test(error?.message ?? '');

// Takes the lock on `directory`'s lock file at once, with no busy wait, and answers the function that releases it,
// which is safe to call more than once. The folder must exist. A lock another controller holds refuses the start
// with the refusal the start has always given; any other error is thrown as it is.
export function takeDataFolderLock(directory) {
  const db = new DatabaseSync(path.join(path.resolve(directory), dataFolderLockName), { timeout: 0 });
  try {
    // In exclusive locking mode the connection keeps every lock it takes until it closes. No journal, so no file
    // appears beside the lock file; the empty transaction only takes the exclusive lock, which commit then keeps.
    db.exec('PRAGMA locking_mode=EXCLUSIVE');
    db.exec('PRAGMA journal_mode=OFF');
    db.exec('BEGIN EXCLUSIVE');
    db.exec('COMMIT');
  } catch (error) {
    db.close();
    if (busy(error)) throw Object.assign(new Error(ownedMessage), { status: 400 });
    throw error;
  }
  let open = true;
  return () => {
    if (!open) return;
    open = false;
    db.close();
  };
}

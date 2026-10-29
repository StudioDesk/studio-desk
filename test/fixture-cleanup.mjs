// Shared fixture cleanup: close a test's studio within a bound, then remove its folder, retrying while Windows
// still holds a file or a fixture process still runs in it. When it cannot, it says which folder and why
// instead of hanging the test until the suite's 120-second per-test bound. Not a test file, so the test
// command does not run it.
import fs from 'node:fs';

// Well under the suite's 120-second per-test bound: a close stops attempts within about five seconds, and the
// server's within two more.
export const closeLimit = 30000;
// What removal retries: a file still open or a process still running in the folder (Windows refuses with
// EBUSY or EPERM, and on Node 25 fs.rmSync's own maxRetries does not retry EPERM), or files still appearing.
const retried = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EMFILE', 'ENFILE']);

// Removes directory, retrying a refusal it can outlast for about attempts × delay ms; anything else, or a
// refusal that outlasts it, throws an error naming the folder and the reason.
export async function removeFolder(directory, { attempts = 40, delay = 250, remove = fs.rmSync } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      remove(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!retried.has(error.code) || attempt >= attempts) {
        const reason =
          error.code && !error.message.includes(error.code) ? `${error.code} ${error.message}` : error.message;
        throw new Error(
          `Could not remove the fixture folder ${directory} after ${attempt} attempt${attempt === 1 ? '' : 's'}: ${reason}`,
          { cause: error },
        );
      }
    }
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

// Closes app, waiting at most limit ms, and removes directory. The folder is removed even when the close fails
// or runs out of time; the error then names the folder and what went wrong.
export async function closeAndRemove(app, directory, { limit = closeLimit, ...removal } = {}) {
  let timer, closeError;
  try {
    await Promise.race([
      app.close(),
      new Promise((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`The studio in ${directory} did not close within ${limit} ms.`)),
          limit,
        );
      }),
    ]);
  } catch (error) {
    closeError = error;
  } finally {
    clearTimeout(timer);
  }
  try {
    await removeFolder(directory, removal);
  } catch (error) {
    if (!closeError) throw error;
    throw new Error(`${closeError.message} ${error.message}`, { cause: closeError });
  }
  if (closeError) throw closeError;
}

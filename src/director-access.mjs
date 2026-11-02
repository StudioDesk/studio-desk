// Who may use the controller (C-01, November 2026). Anything on this computer can reach its loopback address,
// a candidate's tests inside the built-in sandbox included (the sandbox lets every loopback port through, since
// test suites start servers), so a request token the dashboard page hands to anyone who asks is not enough. The
// director signs in once from the launch link the controller prints when it starts; the link sets a cookie that
// keeps that browser signed in, across restarts too, because the key behind it is kept in the data folder. Local
// tools that run as the director (a coordinating session's reads, the development scripts) send the key itself,
// which also lets their commands go without the page's request token: the token keeps another page in the
// director's browser from riding on the cookie, and no page can send the key header without knowing it.
// The key file and the launch link's file sit in the data folder, which the sandbox account cannot read on Windows
// inside the profile (the profile's own permissions); each run denies both files to the sandbox by name as well,
// for a data folder outside the profile or the home folder (C-40).
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const directorKeyName = 'director-key';
export const directorKeyFile = directory => path.join(directory, directorKeyName);
export const launchFileName = 'launch-url';
// The folder of the tools' keys (the tool key store keeps a key per tool there, sealed for the director's account).
export const toolKeysFolderName = 'tool-keys';
// What lets a program act as the director, or as a tool on the director's behalf: the key, this start's launch link,
// whose code sets the session cookie, and the tools' keys. Each is kept from every sandbox by name (C-40, C-42).
export const directorSecretNames = [directorKeyName, launchFileName, toolKeysFolderName];

const digest = text => createHash('sha256').update(text).digest('hex');
const wellFormed = key => /^[0-9a-f]{64}$/.test(key);

// The data folder's key, made the first time the folder is used. Deleting the file signs every browser out at the
// next start.
export function directorKey(directory) {
  const file = directorKeyFile(directory);
  try {
    const key = fs.readFileSync(file, 'utf8').trim();
    if (wellFormed(key)) return key;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const key = randomBytes(32).toString('hex');
  fs.rmSync(file, { force: true });
  try {
    fs.writeFileSync(file, key + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    // Another start made it a moment before.
    if (error.code !== 'EEXIST') throw error;
    const made = fs.readFileSync(file, 'utf8').trim();
    if (wellFormed(made)) return made;
    throw error;
  }
  return key;
}

// Compares in constant time; a value of another length is simply not the same.
export function sameSecret(given, expected) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(header, name) {
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

// One start's view of the key: the session cookie it sets and accepts, and this start's launch code. The cookie's
// name comes from the key, so controllers on other ports of the same address (a preview, the sample studio, a
// throwaway one), which share the browser's cookies, never take each other's.
export function directorAccess(key) {
  const session = digest('studio-desk-session:' + key),
    cookieName = 'studio_desk_' + digest('studio-desk-cookie:' + key).slice(0, 12),
    launchCode = randomBytes(24).toString('hex');
  return {
    cookieName,
    launchCode,
    sessionCookie: `${cookieName}=${session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=34560000`,
    // The key in its header, and nowhere else: a cookie, a query string or a body never stands for it.
    keyed: headers => sameSecret(headers['x-studio-key'], key),
    authenticated: headers =>
      sameSecret(headers['x-studio-key'], key) || sameSecret(cookieValue(headers.cookie, cookieName), session),
    launches: code => sameSecret(code, launchCode),
  };
}

export const signInMessage =
  "Open Studio desk from the link its window printed when it started (it begins with /launch/). That link signs this browser in; programs on this computer, such as an agent's tests, cannot. A local tool running as you sends the X-Studio-Key header.";
export const commandTokenMessage =
  "This command needs the dashboard's request token (X-Studio-Token) or, from a local tool, the director's key (X-Studio-Key). If the dashboard was open across a restart, reload it.";

export const signInPage = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Studio desk</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;color:#1d2433;background:#f7f8fa}@media (prefers-color-scheme:dark){body{color:#e6e9ef;background:#12151c}}code{font-size:.95em}</style><h1>Open Studio desk from its link</h1><p>When Studio desk starts, its window prints a link that begins with <code>/launch/</code>. Open that link once and this browser stays signed in, also after restarts.</p><p>The link keeps programs on this computer, such as an agent's tests, from acting as you.</p>`;

export const staleLaunchPage = signInPage.replace(
  '<h1>Open Studio desk from its link</h1>',
  '<h1>That link is from an earlier start</h1>',
);

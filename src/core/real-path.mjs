// One real spelling of a path (November 9, 2026). A folder can be written several ways: a link to it, macOS's /var
// for /private/var, a Windows short name such as RUNNER~1, or another letter case where the file system ignores case.
// fs.realpathSync follows links but keeps a short name and the case as given, so two spellings of one folder can
// compare as two folders. The native resolver answers the real spelling with short names expanded; every path the
// controller compares or records goes through realPath, so both sides of a comparison are spelled alike.
import fs from 'node:fs';
import path from 'node:path';

// The real spelling of an existing path. Sandboxes (Codex MXC) can refuse the native resolver; only then does it fall
// back to fs.realpathSync. A missing path throws, as both resolvers do.
export function realPath(value) {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return fs.realpathSync(value);
  }
}

// Whether two paths name one place: compared by their real spellings, ignoring case on Windows. A path that cannot
// be resolved (it does not exist) is compared as written, resolved to an absolute path.
export function samePath(a, b) {
  const spelling = value => {
    try {
      return path.resolve(realPath(value));
    } catch {
      return path.resolve(value);
    }
  };
  const first = spelling(a),
    second = spelling(b);
  return process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
}

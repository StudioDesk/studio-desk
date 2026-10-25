// The folders inside a folder, for the dashboard's folder browser (1.0 step 4). It reads names and stats
// only, never file contents, and spawns no git process: a folder holding a .git entry (a repository's
// folder, or a worktree's file) is marked as a repository.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// At most this many folders in one reply; `limited` says more were left out.
export const maxFolders = 1000;
const collator = new Intl.Collator(undefined, { sensitivity: 'base' });
const byName = (a, b) => collator.compare(a.name, b.name) || (a.name < b.name ? -1 : 1);

// Whether a folder opens and its first entry reads (an empty folder reads fine). A symbolic link or junction
// opens only when it leads to a folder; Windows opens protected junctions such as Application Data and
// Cookies but refuses to read them. The folder is closed again in every case.
function opens(folder) {
  let handle;
  try {
    handle = fs.opendirSync(folder);
    handle.readSync();
    return true;
  } catch {
    return false;
  } finally {
    try {
      handle?.closeSync();
    } catch {}
  }
}

// The real path of `folder` and its entries. A missing folder or a file is refused, or with `nearest` the
// folder above it is read instead, and the home folder once nothing along the path exists.
function read(folder, home, nearest) {
  let real, refusal;
  try {
    real = fs.realpathSync.native(folder);
    return { real, entries: fs.readdirSync(real, { withFileTypes: true }) };
  } catch (error) {
    if (real !== undefined && error.code !== 'ENOTDIR') throw new Error('The folder cannot be opened.');
    refusal = real === undefined ? 'The folder does not exist.' : 'Choose a folder, not a file.';
  }
  if (!nearest) throw new Error(refusal);
  const up = path.dirname(folder);
  return up === folder ? read(home, home, false) : read(up, home, true);
}

// Lists `target`, or the home folder without one. Returns { path, parent, trail, drives, folders, limited }:
// the real path listed, the folder one level up (null at a root), [{ name, path }] from the root down,
// the existing drive roots on Windows, and [{ name, path, repository }] for the folders inside, sorted
// by name ignoring case. Left out are files, dot entries, folders that cannot be opened and read, and on
// Windows a drive's own top-level folders whose names start with $ ($Recycle.Bin, $WinREAgent). With
// `nearest`, a path that does not exist or names a file lists the nearest existing folder above it instead
// of being refused, and the home folder when nothing along it exists; a relative path is refused either way.
export function listFolders(target, { platform = process.platform, home = os.homedir(), nearest = false } = {}) {
  if (target != null && (typeof target !== 'string' || !path.isAbsolute(target)))
    throw new Error('Choose an absolute folder path.');
  const { real, entries } = read(target ?? home, home, nearest),
    driveTop = platform === 'win32' && path.dirname(real) === real,
    trail = [];
  for (let current = real; ; current = path.dirname(current)) {
    const up = path.dirname(current);
    trail.unshift({ name: up === current ? current : path.basename(current), path: current });
    if (up === current) break;
  }
  const candidates = entries
      .filter(
        entry =>
          !entry.name.startsWith('.') &&
          !(driveTop && entry.name.startsWith('$')) &&
          (entry.isDirectory() || entry.isSymbolicLink()),
      )
      .sort(byName),
    folders = [];
  let limited = false;
  for (const entry of candidates) {
    const folder = path.join(real, entry.name);
    if (!opens(folder)) continue;
    if (folders.length === maxFolders) {
      limited = true;
      break;
    }
    folders.push({ name: entry.name, path: folder, repository: fs.existsSync(path.join(folder, '.git')) });
  }
  return {
    path: real,
    parent: trail.length > 1 ? trail.at(-2).path : null,
    trail,
    drives:
      platform === 'win32'
        ? [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map(letter => letter + ':\\').filter(root => fs.existsSync(root))
        : [],
    folders,
    limited,
  };
}

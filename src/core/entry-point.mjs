import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Whether the module whose import.meta this is was the program node started, however its folder was reached. Node
// gives a module its real path, while process.argv[1] keeps the path as typed, so through a junction or symbolic link
// the two differ. Node 24.2 and later answer with import.meta.main; on 24.0 and 24.1 both real paths are compared.
export function isEntryPoint(meta, argv = process.argv) {
  if (typeof meta.main === 'boolean') return meta.main;
  if (!argv[1]) return false;
  try {
    return fs.realpathSync.native(path.resolve(argv[1])) === fs.realpathSync.native(fileURLToPath(meta.url));
  } catch {
    return false;
  }
}

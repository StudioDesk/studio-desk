// The copy of a commit that npm run verify tests (scripts/verify.mjs), made where the pipeline makes its own, so a
// run by hand meets the same paths. Importing this module starts nothing.
import fs from 'node:fs';
import path from 'node:path';
// The runner first: the adapters reach each other through it.
import '../src/runner.mjs';
import { snapshotCommit } from '../src/adapters/source-snapshot.mjs';
import { sourcePlan } from '../src/connectors/source-checks.mjs';
import {
  createSourceWorktree,
  removeSourceWorktree,
  sourceWorktreeRoot,
  worktreeName,
} from '../src/connectors/source-worktrees.mjs';
import { realPath } from '../src/core/real-path.mjs';

// Makes the tested copy of `commit` from the source at `root` for an attempt `id` in verify's data folder `data`,
// as `as` ('candidate' or 'checks') runs, and returns { copy, plan, cleanup }; cleanup removes what it made.
export function makeTestedCopy({ root, data, id, commit, as, profile }) {
  if (as === 'checks') {
    // As an idea's checks do (src/adapters/source-checks.mjs): measure the commit in its own worktree, which is removed
    // again, and copy it to a plain folder in the worktrees' folder by its real spelling, at the same depth and name
    // length as a candidate's working copy. Only that folder is removed afterwards.
    const runtime = { store: { directory: data } };
    fs.mkdirSync(sourceWorktreeRoot(runtime), { recursive: true });
    const copy = path.join(realPath(sourceWorktreeRoot(runtime)), worktreeName(id));
    const plan = snapshotCommit(
      root,
      sourceWorktreeRoot(runtime),
      'c-' + worktreeName(id),
      { commit },
      copy,
      undefined,
      profile,
    );
    return { copy, plan, cleanup: () => fs.rmSync(copy, { recursive: true, force: true }) };
  }
  if (as !== 'candidate') throw new Error(`Unknown tested copy: ${as}.`);
  // A candidate and the check before merging test a worktree.
  const copy = createSourceWorktree(root, path.join(data, 'wt'), 'v-' + worktreeName(id), commit, profile);
  return { copy, plan: sourcePlan(copy, profile), cleanup: () => removeSourceWorktree(root, copy) };
}

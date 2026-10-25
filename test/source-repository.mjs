// A disposable git repository holding a copy of this source's snapshot, shared by the tests in one
// process. Source checks measure a commit in their own worktree (MP-016 slice 4), so tests point
// them here: they never add worktrees to the real repository, which candidate sandboxes cannot
// write to anyway.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sourcePlan, studioSourceRoot } from '../src/connectors/source-checks.mjs';
import { git } from '../src/connectors/source-integration.mjs';

let repository;
export function sourceRepository() {
  if (repository) return repository;
  // Short names keep worktree and fixture paths under Windows' 260-character limit.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-src-')),
    root = path.join(directory, 'r');
  for (const item of sourcePlan(studioSourceRoot).files) {
    const target = path.join(root, item.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(studioSourceRoot, item.path), target);
  }
  git(root, ['-c', 'init.defaultBranch=main', 'init', '--quiet']);
  git(root, ['config', 'user.name', 'Fixture director']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', 'Fixture source']);
  process.once('exit', () => fs.rmSync(directory, { recursive: true, force: true }));
  return (repository = fs.realpathSync(root));
}

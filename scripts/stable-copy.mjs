// A stable copy runs the controller; the development copy is what the pipeline
// and developers change. Promotion fast-forwards the stable copy to committed work.
import fs from 'node:fs';
import path from 'node:path';
import { git } from '../src/connectors/source-integration.mjs';

// Creates a git worktree on the "stable" branch with a studio.local.json that shares
// the development copy's records and points the pipeline at the development copy.
export function setupStable(development, target) {
  if (fs.existsSync(target)) throw new Error(`${target} already exists. Choose another folder or remove it first.`);
  if (!git(development, ['branch', '--list', 'stable'])) git(development, ['branch', 'stable', 'HEAD']);
  git(development, ['worktree', 'add', '--quiet', target, 'stable']);
  const configuration = {
    dataDirectory: path.join(development, 'data').replaceAll(path.sep, '/'),
    sourceRoot: development.replaceAll(path.sep, '/'),
  };
  fs.writeFileSync(path.join(target, 'studio.local.json'), JSON.stringify(configuration, null, 2) + '\n');
  return configuration;
}

// Fast-forwards the stable copy to `from`. Returns the promoted commits (one-line log).
export function promote(stable, from = 'main') {
  const branch = git(stable, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === from) throw new Error(`This copy is on ${from}; run promote in the stable copy.`);
  if (git(stable, ['status', '--porcelain', '--untracked-files=no']))
    throw new Error('The stable copy has uncommitted changes. It should only change through promote.');
  const before = git(stable, ['rev-parse', 'HEAD']);
  git(stable, ['merge', '--ff-only', '--quiet', from]);
  const after = git(stable, ['rev-parse', 'HEAD']);
  return { branch, commits: before === after ? '' : git(stable, ['log', '--oneline', `${before}..${after}`]) };
}

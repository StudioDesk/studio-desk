// The controller's own git calls (C-20 with C-06, November 2026). A repository can name code for git to run: hooks in
// .git/hooks or a configured hooks folder, an fsmonitor command, which git runs on reads such as status. None of it
// runs on the controller's calls, which run outside every sandbox: each call points git's hooks at /dev/null (on
// Windows too, where Git for Windows reads it as no folder at all) and turns fsmonitor off. Filters still apply, so a
// checkout writes the files a repository's line endings and Git LFS describe, as the director's own checkout does.
// The director's confirmed Push is the one call that runs as the director's own git, hooks included, since pre-push
// hooks and Git LFS uploads need them (src/connectors/source-releases.mjs).
import { spawnSync } from 'node:child_process';

// What every call but Push adds before its own arguments. Git for Windows stops at 260-character paths unless
// core.longpaths is set, and candidate copies sit deep inside job folders; other platforms ignore the setting.
export const controllerGitOptions = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.longpaths=true',
];

// Every pathspec is the exact path, never a glob or magic pattern: story paths may hold [ ] and ( ), so
// src/[A]GENTS.md must not match src/AGENTS.md. A folder still matches the files under it. check-ignore refuses any
// pathspec magic, --literal-pathspecs included, and --version takes no pathspecs.
const literalOptions = args => (['check-ignore', '--version'].includes(args[0]) ? [] : ['--literal-pathspecs']);

export const controllerGitArguments = (args, { literal = true } = {}) => [
  ...(literal ? literalOptions(args) : []),
  ...controllerGitOptions,
  ...args,
];

// Runs one git command for the controller and answers its output, trimmed unless raw is set (porcelain status lines
// may start with a space). An encoding of null answers the bytes. A command git refuses throws with git's own words.
export function runGit(
  cwd,
  args,
  { raw = false, input, env, encoding = 'utf8', literal = true, timeout = 30000, maxBuffer } = {},
) {
  const result = spawnSync('git', controllerGitArguments(args, { literal }), {
    cwd,
    input,
    encoding: encoding ?? undefined,
    windowsHide: true,
    timeout,
    ...(maxBuffer ? { maxBuffer } : {}),
    ...(env ? { env } : {}),
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `git ${args[0]} failed: ${(String(result.stderr || '') || result.error?.message || '').trim().slice(0, 500)}`,
    );
  if (encoding === null) return result.stdout;
  return raw ? result.stdout : result.stdout.trim();
}

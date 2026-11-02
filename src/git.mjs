// The controller's own git calls (C-20 with C-06, November 2026). A repository can name code for git to run: hooks in
// .git/hooks or a configured hooks folder, an fsmonitor command, which git runs on reads such as status. None of it
// runs on the controller's calls, which run outside every sandbox: each call points git's hooks at /dev/null (on
// Windows too, where Git for Windows reads it as no folder at all) and turns fsmonitor off. Filters still apply, so a
// checkout writes the files a repository's line endings and Git LFS describe, as the director's own checkout does.
// The director's confirmed Push is the one call that runs as the director's own git, hooks included, since pre-push
// hooks and Git LFS uploads need them (src/connectors/source-releases.mjs).
// runGit waits on the controller's one thread; runGitAsync does not, so a read that asks git many things (the
// Releases page) leaves the controller answering in the meantime. At most four git processes run at once for it.
import { execFile, spawnSync } from 'node:child_process';

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

// How many git processes the controller's asynchronous calls run at once (the director's D4, November 2); the rest
// wait their turn in order.
export const gitProcessesAtOnce = 4;
let running = 0;
const waiting = [];
const turn = () =>
  running < gitProcessesAtOnce ? (running++, Promise.resolve()) : new Promise(resolve => waiting.push(resolve));
const done = () => {
  const next = waiting.shift();
  if (next) next();
  else running--;
};

// runGit's answer without holding the controller's thread: the same options, apart from input, and the same refusal.
export async function runGitAsync(
  cwd,
  args,
  { raw = false, env, encoding = 'utf8', literal = true, timeout = 30000, maxBuffer = 64 * 1024 * 1024 } = {},
) {
  await turn();
  try {
    const stdout = await new Promise((resolve, reject) =>
      execFile(
        'git',
        controllerGitArguments(args, { literal }),
        { cwd, encoding: encoding ?? 'buffer', windowsHide: true, timeout, maxBuffer, ...(env ? { env } : {}) },
        (error, out, stderr) =>
          error
            ? reject(
                new Error(
                  `git ${args[0]} failed: ${(String(stderr || '') || error.message || '').trim().slice(0, 500)}`,
                ),
              )
            : resolve(out),
      ),
    );
    if (encoding === null) return stdout;
    return raw ? stdout : stdout.trim();
  } finally {
    done();
  }
}

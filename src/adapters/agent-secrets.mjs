// The director's secrets kept from the agents' own CLIs (C-42, November 2026, the director's "deny it per CLI"). An
// agent's CLI runs as the director, or in a sandbox of the CLI's own, and could read the director's key, the launch
// link or the tools' keys in the data folder, then write them into code whose tests reach the controller. Each CLI is
// kept from them in the way it can be:
// - Claude: deny rules for its file tools. They cover its built-in tools and the shell's file commands Claude Code
//   recognizes (cat, head, a < redirect), not a script that opens a file itself; an OS boundary for Claude agents is
//   C-08's.
// - Codex on Windows, in its elevated sandbox: the sandbox's own account group is denied each secret, an OS boundary.
//   Its MXC sandbox runs as the director and can be denied nothing (probed November 2), and on macOS and Linux Codex's
//   sandbox reads the whole disk; scripts/agent-secrets-probe.mjs reports where each holds.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { directorSecretNames } from '../director-access.mjs';

// The account group Codex's elevated Windows sandbox runs its commands in.
export const codexSandboxGroup = 'CodexSandboxUsers';

// The secrets a data folder holds now, as paths.
export const agentSecrets = directory =>
  directory ? directorSecretNames.map(name => path.join(directory, name)).filter(secret => fs.existsSync(secret)) : [];

const isFolder = secret => fs.statSync(secret, { throwIfNoEntry: false })?.isDirectory() ?? false;

// A path as Claude Code matches it: POSIX form, a Windows drive as /c/..., and glob characters taken literally.
export function claudePath(secret, platform = process.platform) {
  const posix =
    platform === 'win32'
      ? secret.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`).replaceAll('\\', '/')
      : secret;
  return posix.replace(/[*?[\]]/g, character => `\\${character}`);
}

// Claude's deny rules for the secrets: `//` anchors a rule at the filesystem's root; a folder's rule reaches what is in
// it. A Read deny also stops Edit and Write on the same path.
export const claudeSecretRules = (directory, platform = process.platform) =>
  agentSecrets(directory).map(secret => `Read(/${claudePath(secret, platform)}${isFolder(secret) ? '/**' : ''})`);

// Before a Codex attempt in its elevated Windows sandbox: each secret is denied to the sandbox's group (a folder's entry
// reaching everything in it). A secret that cannot be denied stops the attempt rather than leaving it readable.
export const denyCodexSecrets = (directory, run = spawnSync) => denyCodexPaths(agentSecrets(directory), run);
// The same for given paths: the sandbox check denies a stand-in secret this way (scripts/check-codex-sandbox.mjs).
export function denyCodexPaths(secrets, run = spawnSync) {
  for (const secret of secrets) {
    const result = run(
      'icacls',
      [secret, '/deny', `${codexSandboxGroup}:${isFolder(secret) ? '(OI)(CI)(R)' : '(R)'}`],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30000,
      },
    );
    if (result.status !== 0)
      throw new Error(
        `Codex's sandbox could not be kept from the director's secret (${secret}): ${(result.stderr || result.stdout || result.error?.message || '').trim().slice(0, 500)}`,
      );
  }
  return secrets;
}

// Whether Codex's elevated Windows sandbox is set up on this computer: Codex makes its account group the first time it
// is set up, with an administrator's approval.
export const codexElevatedReady = (run = spawnSync) =>
  run('net', ['localgroup', codexSandboxGroup], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).status === 0;

export const codexElevatedMissing =
  "Codex's elevated Windows sandbox isn't set up on this computer. Open a terminal as an administrator and run Codex " +
  'once with it: codex -c windows.sandbox="elevated" (newer versions also have codex sandbox setup --elevated). Then ' +
  'restart Studio desk. To use Codex in its MXC sandbox instead, set STUDIO_CODEX_WINDOWS_SANDBOX=mxc and restart; ' +
  "there Codex can read the director's key and the tools' keys.";
export const codexMxcWarning =
  "Codex runs in its MXC sandbox, which runs as you: it can read the director's key and the tools' keys in the data " +
  "folder. Codex's elevated sandbox, the default, is kept from them; unset STUDIO_CODEX_WINDOWS_SANDBOX to use it.";

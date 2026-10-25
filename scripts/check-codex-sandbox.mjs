// Model-free file-isolation check. Keep evidence outside the generally writable
// OS temporary directory so a sibling write is a meaningful boundary check.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { locateCodex, subscriptionEnvironment } from '../src/runner.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const insideText = 'STUDIO_INSIDE_OK\n',
  inputText = 'STUDIO_ACCEPTED_INPUT\n';

export function checkCodexSandbox({
  binary = locateCodex(),
  implementation = process.platform === 'win32' ? (process.env.STUDIO_CODEX_WINDOWS_SANDBOX ?? 'mxc') : undefined,
  parentDirectory = projectRoot,
  timeoutMs = 20000,
} = {}) {
  if (implementation !== undefined && !['elevated', 'mxc'].includes(implementation))
    throw new Error('Sandbox implementation must be elevated or mxc.');
  if (!binary) throw new Error('Codex CLI was not found.');
  const directory = fs.mkdtempSync(path.join(parentDirectory, '.studio-sandbox-'));
  const output = path.join(directory, 'output'),
    inputs = path.join(directory, 'inputs');
  fs.mkdirSync(output);
  fs.mkdirSync(inputs);
  const input = path.join(inputs, 'accepted.txt');
  fs.writeFileSync(input, inputText);
  const probe = path.join(output, 'probe.mjs');
  fs.writeFileSync(
    probe,
    `import fs from 'node:fs';
const denied = file => { try { fs.writeFileSync(file, 'UNAUTHORIZED_WRITE'); return false; } catch (err) { if (!['EACCES', 'EPERM', 'EROFS'].includes(err.code)) throw err; return true; } };
fs.writeFileSync('inside.txt', ${JSON.stringify(insideText)});
const inputReadable = fs.readFileSync('../inputs/accepted.txt', 'utf8') === ${JSON.stringify(inputText)};
const outsideWriteDenied = denied('../outside.txt');
const inputWriteDenied = denied('../inputs/accepted.txt');
console.log(JSON.stringify({insideWrite: true, inputReadable, outsideWriteDenied, inputWriteDenied}));
if (!inputReadable || !outsideWriteDenied || !inputWriteDenied) process.exitCode = 1;
`,
  );
  const args = ['sandbox', '--include-managed-config', '--permission-profile', ':workspace', '--cd', output];
  if (implementation) args.push('--config', `windows.sandbox="${implementation}"`);
  args.push('--', process.execPath, probe);
  const result = spawnSync(
    /\.m?js$/.test(binary) ? process.execPath : binary,
    /\.m?js$/.test(binary) ? [binary, ...args] : args,
    {
      cwd: output,
      env: subscriptionEnvironment(),
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 20000,
    },
  );
  let reported;
  try {
    reported = JSON.parse(result.stdout?.trim());
  } catch {}
  const matches = (file, text) => {
    try {
      return fs.readFileSync(file, 'utf8') === text;
    } catch {
      return false;
    }
  };
  const insideMatches = matches(path.join(output, 'inside.txt'), insideText);
  const outsideExists = fs.existsSync(path.join(directory, 'outside.txt'));
  const inputUnchanged = matches(input, inputText);
  const passed =
    !result.error &&
    result.status === 0 &&
    reported?.insideWrite === true &&
    reported.inputReadable === true &&
    reported.outsideWriteDenied === true &&
    reported.inputWriteDenied === true &&
    insideMatches &&
    !outsideExists &&
    inputUnchanged;
  return {
    passed,
    implementation: implementation || 'platform default',
    directory,
    exitCode: result.status,
    error: result.error?.code,
    reported,
    insideMatches,
    outsideExists,
    inputUnchanged,
    stdout: result.stdout?.trim(),
    stderr: result.stderr?.trim(),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3) throw new Error('Usage: node scripts/check-codex-sandbox.mjs [elevated|mxc]');
    const result = checkCodexSandbox({ implementation: process.argv[2] });
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

// Model-free sandbox protocol fixture; this does not verify native isolation.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const args = process.argv.slice(2),
  mode = process.env.STUDIO_SANDBOX_FIXTURE_CASE || 'pass';
if (
  args[0] !== 'sandbox' ||
  !args.includes('--include-managed-config') ||
  args[args.indexOf('--permission-profile') + 1] !== ':workspace' ||
  args[args.indexOf('--cd') + 1] !== process.cwd() ||
  process.env.OPENAI_API_KEY ||
  process.env.CODEX_API_KEY
)
  throw new Error('Unsafe or unexpected sandbox invocation.');
if (mode === 'timeout')
  await new Promise(() => {
    setInterval(() => {}, 1000);
  });
if (mode === 'failure') {
  console.error('Sandbox setup failed (fixture).');
  process.exit(1);
}
const write = fs.writeFileSync;
if (mode === 'misleading-report' || mode === 'invalid-report') {
  write('inside.txt', 'STUDIO_INSIDE_OK\n');
  if (mode === 'misleading-report') write('../outside.txt', 'unauthorized');
  console.log(
    mode === 'invalid-report'
      ? 'not JSON'
      : JSON.stringify({ insideWrite: true, inputReadable: true, outsideWriteDenied: true, inputWriteDenied: true }),
  );
} else {
  // Emulate expected denials for the probe code; all files are test fixtures.
  fs.writeFileSync = (file, ...rest) => {
    const target = path.resolve(file);
    if (target.startsWith(process.cwd() + path.sep)) {
      if (mode === 'missing-inside' && path.basename(target) === 'inside.txt') return;
      return write(file, ...rest);
    }
    if (
      (mode === 'outside-write' && path.basename(target) === 'outside.txt') ||
      (mode === 'input-write' && path.basename(target) === 'accepted.txt')
    )
      return write(file, ...rest);
    throw Object.assign(new Error('Fixture file denial'), { code: mode === 'wrong-error' ? 'ENOENT' : 'EACCES' });
  };
  await import(pathToFileURL(args.at(-1)).href);
}

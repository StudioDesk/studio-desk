// Runs inside the built-in sandbox (1.0.1): starts the test command from the run's instructions with the
// controller's variables for the tests, and exits as it does. Usage: node built-in-sandbox-launch.mjs <instructions>
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const run = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const child = spawn(run.executable, run.args, {
  cwd: run.cwd,
  env: { ...process.env, ...run.env },
  stdio: 'inherit',
  windowsHide: true,
});
child.on('error', error => {
  console.error(`The test command did not start in the sandbox: ${error.message}`);
  process.exit(1);
});
child.on('close', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

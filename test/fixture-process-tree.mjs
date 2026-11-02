// A process tree shaped like an agent's or a test run's, for test/process-job.test.mjs: the main process starts a
// detached sleeper that writes its PID to <folder>/sleeper.pid, prints a line, and exits with the code given, leaving
// the sleeper running. Run as `sleeper` it only writes its PID and sleeps.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [role, folder, code = '0'] = process.argv.slice(2);
if (role === 'sleeper') {
  fs.writeFileSync(path.join(folder, 'sleeper.pid'), String(process.pid));
  setTimeout(() => {}, 20000);
} else {
  spawn(process.execPath, [fileURLToPath(import.meta.url), 'sleeper', folder], {
    stdio: 'ignore',
    windowsHide: true,
    detached: true,
  }).unref();
  const until = Date.now() + 5000;
  while (!fs.existsSync(path.join(folder, 'sleeper.pid')) && Date.now() < until)
    await new Promise(r => setTimeout(r, 50));
  console.log('main done');
  process.exit(Number(code));
}

// Runs the controller and relaunches it after a planned restart (exit code 75),
// for example after reviewed source is integrated. Any other exit ends the
// supervisor. Repeated rapid restarts stop it so a broken change cannot loop.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildDashboard } from './build-dashboard.mjs';

const RESTART_CODE = 75,
  server = fileURLToPath(new URL('../src/server.mjs', import.meta.url)),
  recent = [];
let child,
  stopping = false;
function launch() {
  // The new dashboard is rebuilt when its sources changed (MP-026); the controller starts either way.
  try {
    buildDashboard();
  } catch (error) {
    console.error(`Dashboard build skipped: ${error.message}`);
  }
  child = spawn(process.execPath, [server], {
    stdio: 'inherit',
    env: { ...process.env, STUDIO_SUPERVISED: '1' },
  });
  child.on('exit', (code, signal) => {
    if (code !== RESTART_CODE || stopping) process.exit(code ?? (signal ? 1 : 0));
    const now = Date.now();
    recent.push(now);
    while (recent.length && now - recent[0] > 60_000) recent.shift();
    if (recent.length > 3) {
      console.error('Studio desk restarted more than 3 times in a minute; stopping. Check the controller output.');
      process.exit(1);
    }
    console.log('Studio desk: restarting to load updated source…');
    launch();
  });
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    stopping = true;
    child?.kill(signal);
  });
launch();

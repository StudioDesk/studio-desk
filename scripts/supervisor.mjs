// Runs the controller and relaunches it after a planned restart (exit code 75),
// for example after reviewed source is integrated. Any other exit ends the
// supervisor. Repeated rapid restarts stop it so a broken change cannot loop.
// Every exit of the controller is said in this window, with its code or signal, the time and how long it ran (C-41):
// a graceful stop, a crash and a controller ended from outside no longer look alike.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDashboard } from './build-dashboard.mjs';
import { uptimeText } from '../src/stop-record.mjs';

const RESTART_CODE = 75,
  server = fileURLToPath(new URL('../src/server.mjs', import.meta.url)),
  recent = [];
let child,
  stopping = false;

// The line the window shows when the controller exits.
export function exitLine(code, signal, startedAt, at = new Date()) {
  const how =
    code === RESTART_CODE
      ? 'for a planned restart'
      : signal
        ? `on the signal ${signal}`
        : code === 0
          ? 'normally (exit code 0)'
          : code === null
            ? 'with no exit code'
            : `with exit code ${code}`;
  return `Studio desk: the controller exited ${how} at ${at.toISOString()}, after ${uptimeText((at - startedAt) / 1000)}.`;
}

function launch() {
  // The new dashboard is rebuilt when its sources changed (MP-026); the controller starts either way.
  try {
    buildDashboard();
  } catch (error) {
    console.error(`Dashboard build skipped: ${error.message}`);
  }
  const startedAt = new Date();
  child = spawn(process.execPath, [server], {
    stdio: 'inherit',
    env: { ...process.env, STUDIO_SUPERVISED: '1' },
  });
  child.on('exit', (code, signal) => {
    console.log(exitLine(code, signal, startedAt));
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      if (!stopping) console.log(`Studio desk: the supervisor was asked to stop (${signal}); stopping the controller.`);
      stopping = true;
      child?.kill(signal);
    });
  launch();
}

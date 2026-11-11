// Runs the controller and relaunches it after a planned restart (exit code 75),
// for example after reviewed source is integrated. Any other exit ends the
// supervisor. Repeated rapid restarts stop it so a broken change cannot loop.
// Every exit of the controller is said in this window, with its code or signal, the time and how long it ran (C-41):
// a graceful stop, a crash and a controller ended from outside no longer look alike.
// On Windows the controller shares this window and receives its Ctrl+C itself, while ending it from here would end it
// outright, before it records why it stopped: so the supervisor waits for it to close and ends it only after a bound.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from '../src/core/entry-point.mjs';
import { buildDashboard } from './build-dashboard.mjs';

const RESTART_CODE = 75,
  server = fileURLToPath(new URL('../src/server.mjs', import.meta.url)),
  recent = [];
let child,
  stopping = false;

// How long the controller ran, as src/stop-record.mjs's uptimeText says it. Kept here, so the supervisor needs nothing
// from the controller's source, which a planned restart may be changing.
function ranFor(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'an unknown time';
  const days = Math.floor(seconds / 86400),
    hours = Math.floor((seconds % 86400) / 3600),
    minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days} d ${hours} h`;
  if (hours) return `${hours} h ${minutes} min`;
  if (minutes) return `${minutes} min`;
  return `${Math.floor(seconds)} s`;
}

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
  return `Studio desk: the controller exited ${how} at ${at.toISOString()}, after ${ranFor((at - startedAt) / 1000)}.`;
}

// What the supervisor does with the controller when it is asked to stop. On macOS and Linux the signal is forwarded, as
// the controller's own handler records the stop and closes. On Windows the controller has received the window's Ctrl+C
// itself and is closing, and ending it from here would end it at once: so the supervisor waits for it to exit and
// ends it only when it has not exited within the bound, saying so in the window. A repeated Ctrl+C while waiting starts
// no second wait. Answers what it did: 'forwarded', 'waiting', 'already waiting' or 'exited'.
const waiting = new WeakSet();
export function stopController(child, signal, { platform = process.platform, boundMs = 5000, log = console.log } = {}) {
  if (!child) return 'exited';
  if (platform !== 'win32') {
    child.kill(signal);
    return 'forwarded';
  }
  const running = () => child.exitCode === null && child.signalCode === null;
  if (!running()) return 'exited';
  if (waiting.has(child)) return 'already waiting';
  waiting.add(child);
  const bound = `${Math.round(boundMs / 100) / 10} s`;
  log(`Studio desk: waiting up to ${bound} for the controller to record its stop and close.`);
  const timer = setTimeout(() => {
    if (!running()) return;
    log(`Studio desk: the controller did not close within ${bound}; ending it.`);
    child.kill();
  }, boundMs);
  child.once('exit', () => clearTimeout(timer));
  return 'waiting';
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

if (isEntryPoint(import.meta)) {
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      if (!stopping) console.log(`Studio desk: the supervisor was asked to stop (${signal}); stopping the controller.`);
      stopping = true;
      stopController(child, signal);
    });
  launch();
}

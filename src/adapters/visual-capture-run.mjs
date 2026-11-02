// The visual check's capture (1.2 step 8), as a step's own process so the attempt's time limit, cancellation and log
// cover it. It starts the candidate with the project's start command (already wrapped for the built-in sandbox where
// the controller chose it), waits for the app to answer at its address, then drives the Chromium-based browser on this
// computer through its DevTools protocol with Node's own WebSocket, nothing installed: each page at each width and
// theme, its steps run in the page, a full-page image saved. It ends the app and the browser, and writes
// visual-check.json beside the images. A page that cannot be reached or a step that finds nothing is recorded with its
// image; only a crash here fails the step.
// Usage: node visual-capture-run.mjs <plan.json>
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addressIn, imageName, stepScript } from '../connectors/page-capture.mjs';

const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')),
  startedAt = new Date().toISOString(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  say = text => console.log(text);
const record = {
  schemaVersion: 'visual-check-v1',
  state: 'captured',
  browser: plan.browser,
  widths: plan.widths,
  themes: plan.themes,
  pages: plan.pages,
  address: plan.address || null,
  images: [],
  startedAt,
};
const write = () => {
  record.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(plan.out, 'visual-check.json'), JSON.stringify(record, null, 2));
};
const endTree = child => {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    child.kill('SIGKILL');
  } else
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
};

let app = null,
  browser = null,
  socket = null,
  profile = null;
try {
  fs.mkdirSync(path.join(plan.out, 'visual'), { recursive: true });
  // The candidate, with the start command as the project's settings name it.
  say(`> ${plan.start.join(' ')}${plan.place === 'built-in' ? ' (in the built-in sandbox)' : ''}`);
  let output = '',
    ended = null;
  app = spawn(plan.command.executable, plan.command.args, {
    cwd: plan.root,
    env: plan.environment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const read = data => {
    const text = String(data);
    if (output.length < 64 * 1024) output += text;
    process.stdout.write(text);
  };
  app.stdout.on('data', read);
  app.stderr.on('data', read);
  app.on('error', error => (ended = `the start command could not run: ${error.message}`));
  app.on('close', code => (ended ||= `the app ended before it answered (exit code ${code})`));
  // Its address: the settings', or the first one it prints; then the first answer from it.
  let address = plan.address,
    answered = false;
  for (const deadline = Date.now() + plan.startTimeoutMs; Date.now() < deadline && !answered && !ended; ) {
    address ||= addressIn(output);
    if (address)
      try {
        await fetch(address, { signal: AbortSignal.timeout(2000) });
        answered = true;
      } catch {}
    if (!answered) await sleep(500);
  }
  if (!answered) {
    record.state = 'failed';
    record.reason =
      ended ||
      (address
        ? `the app did not answer at ${address} within ${plan.startTimeoutMs / 1000} seconds`
        : `the app printed no address on this computer within ${plan.startTimeoutMs / 1000} seconds; name one in the project's settings`);
  } else {
    record.address = address;
    // The browser, headless, with a profile of its own; port 0 lets it choose, and it names the port in a file.
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-visual-'));
    browser = spawn(
      plan.browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        'about:blank',
      ],
      { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' },
    );
    let target;
    for (let i = 0; i < 75 && !target; i++) {
      await sleep(200);
      try {
        const port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
        target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page');
      } catch {}
    }
    if (!target) throw new Error('The browser did not start its DevTools protocol.');
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve);
      socket.addEventListener('error', () => reject(new Error('The browser refused its DevTools connection.')));
    });
    let id = 0;
    const pending = new Map(),
      loads = [];
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      } else if (message.method === 'Page.loadEventFired') loads.splice(0).forEach(resolve => resolve());
    });
    const send = (method, params = {}) =>
      new Promise(resolve => {
        pending.set(++id, resolve);
        socket.send(JSON.stringify({ id, method, params }));
      });
    await send('Page.enable');
    for (const [index, page] of plan.pages.entries())
      for (const theme of plan.themes)
        for (const width of plan.widths) {
          const name = imageName(index, page, width, theme),
            image = { path: name, page: page.name, pagePath: page.path, width, theme },
            mobile = width < 600;
          await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
          await send('Emulation.setDeviceMetricsOverride', {
            width,
            height: mobile ? 844 : 900,
            deviceScaleFactor: 1,
            mobile,
          });
          const loaded = new Promise(resolve => loads.push(resolve));
          const navigated = await send('Page.navigate', { url: new URL(page.path, address).href });
          if (navigated.result?.errorText) image.problem = `the page did not open: ${navigated.result.errorText}`;
          await Promise.race([loaded, sleep(10000)]);
          await sleep(plan.settleMs);
          // A page with no steps is pictured as it opens.
          for (const step of image.problem ? [] : (page.steps ?? [])) {
            const ran = await send('Runtime.evaluate', {
              expression: stepScript(step),
              awaitPromise: true,
              returnByValue: true,
            });
            const answer = ran.result?.result?.value;
            if (!answer?.ok) {
              image.problem =
                answer?.problem || `a step failed: ${JSON.stringify(ran.result?.exceptionDetails?.text || '')}`;
              break;
            }
            await sleep(plan.settleMs);
          }
          const metrics = await send('Page.getLayoutMetrics'),
            capture = async height =>
              send('Page.captureScreenshot', {
                format: 'png',
                captureBeyondViewport: true,
                clip: { x: 0, y: 0, width, height, scale: 1 },
              });
          let height = Math.min(4000, Math.max(1, Math.ceil(metrics.result?.cssContentSize?.height || 900))),
            shot = await capture(height);
          // The controller keeps files under 8 MB; a larger full page is taken again at the screen's height.
          if (shot.result?.data && (shot.result.data.length * 3) / 4 > 7.5 * 1024 * 1024) {
            height = mobile ? 844 : 900;
            shot = await capture(height);
            image.trimmed = 'the full page made an image over 7.5 MB, so only the first screen was kept';
          }
          if (shot.result?.data) {
            fs.writeFileSync(path.join(plan.out, name), Buffer.from(shot.result.data, 'base64'));
            image.height = height;
          } else image.problem ||= 'the browser returned no image';
          record.images.push(image);
          say(
            `${image.problem ? 'captured with a problem' : 'captured'}: ${name}${image.problem ? ` (${image.problem})` : ''}`,
          );
        }
  }
} catch (error) {
  record.state = 'failed';
  record.reason = error.message;
  say(`The capture stopped: ${error.message}`);
} finally {
  try {
    socket?.close();
  } catch {}
  endTree(browser);
  endTree(app);
  write();
  if (profile) setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 1000);
  setTimeout(() => process.exit(0), 1500);
}

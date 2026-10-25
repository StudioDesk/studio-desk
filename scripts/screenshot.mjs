// Development tool: screenshots of the local dashboard through a locally installed Chromium
// browser (Edge or Chrome) and its DevTools protocol. No dependency is installed.
// Usage: node scripts/screenshot.mjs <outDir> <url> <name:script> [<name:script> ...]
// Each script runs in the page before its screenshot, for example
//   board:document.querySelector('[data-view=board]').click()
// Scripts can click buttons, so only use navigation clicks against a live controller.
// Set STUDIO_BROWSER to the browser executable if it is not found.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [outDir, url, ...shots] = process.argv.slice(2);
const edge = [
  process.env.STUDIO_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(file => file && fs.existsSync(file));
if (!edge) throw new Error('No Chromium browser found. Set STUDIO_BROWSER.');
fs.mkdirSync(outDir, { recursive: true });
const port = 9300 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-screenshot-'));
const browser = spawn(
  edge,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--window-size=1440,1000',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try {
    target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(item => item.type === 'page');
  } catch {}
}
if (!target) throw new Error('Edge did not start.');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(resolve => socket.addEventListener('open', resolve));
let id = 0;
const pending = new Map();
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});
const send = (method, params = {}) =>
  new Promise(resolve => {
    pending.set(++id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
try {
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await sleep(2500);
  for (const shot of shots) {
    const split = shot.indexOf(':'),
      name = shot.slice(0, split),
      script = shot.slice(split + 1);
    if (script) {
      const result = await send('Runtime.evaluate', { expression: script, awaitPromise: true });
      if (result.result?.exceptionDetails)
        console.error(name, JSON.stringify(result.result.exceptionDetails).slice(0, 300));
      await sleep(1200);
    }
    const metrics = await send('Page.getLayoutMetrics');
    const height = Math.min(4000, Math.ceil(metrics.result.cssContentSize?.height || 1000));
    const image = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 1440, height, scale: 1 },
    });
    fs.writeFileSync(path.join(outDir, name + '.png'), Buffer.from(image.result.data, 'base64'));
    console.log('saved', name, height);
  }
} finally {
  socket.close();
  browser.kill();
  setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 1000);
}

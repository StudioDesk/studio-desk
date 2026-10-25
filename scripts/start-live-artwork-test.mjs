// Opt-in live subscription workflow. A managing agent must inspect and approve
// every proposal/result through the normal API. npm test never runs this file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudio } from '../src/server.mjs';
import { checkCodexSandbox } from './check-codex-sandbox.mjs';

if (process.argv.length !== 3 || process.argv[2] !== '--live')
  throw new Error(
    'This makes live subscription model requests. Usage after authorization: node scripts/start-live-artwork-test.mjs --live',
  );
const sandbox = checkCodexSandbox();
console.log(JSON.stringify({ sandboxPreflight: sandbox }));
if (!sandbox.passed) throw new Error('Native file isolation failed. No model work started.');

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = fs.mkdtempSync(path.join(root, '.studio-live-'));
const app = createStudio({ directory: path.join(directory, 'records'), port: 0 });
let closing = false,
  deadline;
async function close(reason) {
  if (closing) return;
  closing = true;
  clearTimeout(deadline);
  const before = app.store.state();
  fs.writeFileSync(path.join(directory, 'state-before-close.json'), JSON.stringify(before, null, 2));
  await app.close();
  process.stdin.pause();
  fs.writeFileSync(
    path.join(directory, 'closed.json'),
    JSON.stringify(
      {
        reason,
        time: new Date().toISOString(),
        activeBeforeClose: before.attempts.filter(a => ['running', 'stopping'].includes(a.status)).map(a => a.id),
        liveCliAttempts: before.attempts.filter(a => a.provider === 'codex').length,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ closed: true, reason, directory }));
}
try {
  // Configure only the disposable studio. Real project records are untouched.
  const org = app.store.organization();
  org.maxParallel = 1;
  for (const worker of org.workers) worker.enabled = ['W-01', 'W-05', 'W-07'].includes(worker.id);
  app.store.setOrganization(org);
  const origin = await app.start();
  const html = await (await fetch(origin)).text(),
    token = html.match(/name="studio-token" content="([^"]+)"/)[1];
  const api = async (url, data, method = 'POST') => {
    const res = await fetch(origin + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token },
      body: JSON.stringify(data),
    });
    const value = await res.json();
    if (!res.ok) throw new Error(value.error);
    return value;
  };
  for (const id of ['W-01', 'W-05', 'W-07'])
    await api('/api/workers/' + id, { provider: 'codex', model: '', expectedVersion: 1 }, 'PATCH');
  const publish = async (scope, id, text) => {
    const doc =
      scope === 'team'
        ? app.store.organization().instructions.teams[id]
        : app.store.organization().instructions.employees[id];
    await api(`/api/instructions/${scope}/${id}/draft`, { baseRevision: doc.revision, text });
    await api(`/api/instructions/${scope}/${id}/publish`, {
      baseRevision: doc.revision,
      text,
      note: 'Authorized minimal SVG artwork workflow test; disposable studio only.',
    });
  };
  await publish(
    'team',
    'art-assets',
    'Produce the approved small character artwork as a self-contained SVG text artifact in the private output folder. Use ordinary SVG shapes and paths; no scripts, external references, embedded raster images, foreignObject, fonts requiring downloads, network requests, Blender, GPU generation or game imports. Preserve accepted inputs. Include a short manifest with dimensions, palette, provenance and limits. This is vector artwork, not a game-ready 3D asset. Report browser rendering only if actually observed.',
  );
  await publish(
    'employee',
    'W-05',
    'Create the one approved player-character portrait in player-character.svg using the approved brief. Work only in the allocated output folder. This test grants file output only; Blender and image-generation tools are unavailable and unnecessary for SVG shapes. Return the artwork, a short artwork.json manifest, actual file/schema checks, and honest not-run labels for unperformed visual, engine and playtest checks. Do not approve your own output.',
  );
  const brief =
    'Create one small original player-character artwork: a friendly adult courier for a cozy exploration game, full-body three-quarter view, teal hooded coat, ochre satchel, simple boots, and one clearly visible hand-held lantern. Flat vector illustration with a readable silhouette and a transparent background. Deliver player-character.svg as self-contained UTF-8 SVG with width/height 512 and viewBox="0 0 512 512", plus artwork.json with title, dimensions, palette, provenance and limitations. No scripts, external links or assets, embedded raster images, foreignObject, network requests, Blender, game imports, or image-generation services. Only local file tools are available. Plan exactly two tasks: Jules (W-05) creates the artwork as kind general, then Morgan (W-07) independently reviews the exact accepted artwork as kind review. Each task gets at most 120 seconds per attempt and at most 2 attempts. Keep the plan under 480 total task-attempt seconds. The managing agent will inspect/render artifacts and explicitly approve each step on behalf of the user. If a reviewer has genuine findings, a bounded new repair plan may follow; do not invent problems. Mark any unperformed browser, engine or playtest checks not-run.';
  fs.writeFileSync(
    path.join(directory, 'scope.json'),
    JSON.stringify(
      {
        title: 'Player character artwork workflow',
        brief,
        provider: 'codex',
        workers: ['W-01', 'W-05', 'W-07'],
        sandboxEvidence: sandbox.directory,
        reviewPolicy:
          'Managing agent inspects actual outputs and makes explicit API decisions; no blind result acceptance.',
        overallWallSeconds: 900,
        originalDataUsed: false,
      },
      null,
      2,
    ),
  );
  const plan = await api('/api/plans', { title: 'Create a small player-character artwork', brief, workerId: 'W-01' });
  fs.writeFileSync(
    path.join(directory, 'connection.json'),
    JSON.stringify({ origin, directory, planTaskId: plan.id, controllerPid: process.pid }, null, 2),
  );
  console.log(
    JSON.stringify({
      origin,
      directory,
      planTaskId: plan.id,
      perAttemptSeconds: 120,
      proposedTaskBudgetSeconds: 480,
      overallWallSeconds: 900,
    }),
  );
  deadline = setTimeout(
    () =>
      close('Bounded 900-second test deadline').catch(error => {
        console.error(error.message);
        process.exitCode = 1;
      }),
    900000,
  );
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', data => {
    if (data.trim() === 'close')
      close('Managing agent completed the test').catch(error => {
        console.error(error.message);
        process.exitCode = 1;
      });
  });
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () =>
      close('Operator stop').catch(error => {
        console.error(error.message);
        process.exitCode = 1;
      }),
    );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
  await close('Setup failed');
}

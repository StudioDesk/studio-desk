// Opt-in subscription/model smoke check. npm test never runs this script.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from '../src/server.mjs';
import { checkCodexSandbox } from './check-codex-sandbox.mjs';

const provider = process.argv[2];
if (!['codex', 'claude'].includes(provider) || process.argv.length > 3)
  throw new Error('Usage: node scripts/verify-cli.mjs codex|claude');
// Never spend a model assignment on a Codex setup known to fail isolation.
if (provider === 'codex') {
  const sandbox = checkCodexSandbox();
  console.log(JSON.stringify({ sandboxPreflight: sandbox }, null, 2));
  if (!sandbox.passed) {
    console.error('Verification blocked: model-free sandbox file isolation did not pass. No model assignment started.');
    process.exit(1);
  }
}
const directory = fs.mkdtempSync(path.join(os.tmpdir(), `studio-live-${provider}-`));
const app = createStudio({ directory, port: 0 });
try {
  await app.start();
  const org = app.store.organization(),
    worker = org.workers.find(w => w.id === 'W-03');
  worker.provider = provider;
  worker.model = '';
  app.store.setOrganization(org);
  const task = {
    id: 'LIVE-001',
    title: 'Bounded subscription adapter check',
    brief:
      'Produce smoke.txt containing exactly STUDIO_SUBSCRIPTION_SMOKE_OK followed by a newline. No engine access or other work is requested.',
    acceptance:
      'The controller validates a completed result with the exact text artifact. Mark engine and playtest checks not-run.',
    kind: 'general',
    workerId: worker.id,
    team: worker.team,
    goalId: null,
    dependencies: [],
    resources: [],
    maxSeconds: 120,
    maxAttempts: 1,
    direction: '',
    status: 'ready',
    reason: '',
    hold: false,
    lastAttemptId: null,
    createdAt: new Date().toISOString(),
  };
  app.store.putTask(task);
  console.log(`Temporary records: ${directory}`);
  const { attemptId } = app.runner.start(task.id);
  console.log(`Started ${provider}: ${attemptId}; 120-second limit.`);
  const deadline = Date.now() + 130000;
  while (app.runner.active.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
  const attempt = app.store.attempt(attemptId);
  const artifact = attempt.artifacts.find(a => a.path === 'smoke.txt');
  const passed =
    attempt.status === 'review' &&
    attempt.result?.outcome === 'completed' &&
    artifact &&
    fs.readFileSync(path.join(attempt.outputFolder, artifact.path), 'utf8') === 'STUDIO_SUBSCRIPTION_SMOKE_OK\n' &&
    app.store.leases().length === 0;
  console.log(
    JSON.stringify(
      {
        passed: !!passed,
        status: attempt.status,
        error: attempt.error,
        sessionId: attempt.sessionId,
        reportedModel: attempt.reportedModel,
        windowsSandbox: attempt.configuration.windowsSandbox,
        instructionHash: attempt.instructions.hash,
        artifacts: attempt.artifacts,
        checks: attempt.result?.checks,
      },
      null,
      2,
    ),
  );
  if (!passed) {
    process.exitCode = 1;
    for (const event of app.store
      .events(attemptId)
      .filter(e => e.kind === 'log')
      .slice(-8))
      console.log(event.message);
  }
} catch (err) {
  console.error(`Verification blocked: ${err.message}`);
  process.exitCode = 1;
} finally {
  await app.close();
  console.log('Controller closed. Temporary evidence retained; project data/ was not used.');
}

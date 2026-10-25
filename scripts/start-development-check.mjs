// Opt-in real source-check evidence on disposable records. This script never
// accepts a result and never makes a model call. Acceptance belongs to the director.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudio } from '../src/server.mjs';

if (process.argv.length !== 3 || process.argv[2] !== '--temporary')
  throw new Error('Usage: node scripts/start-development-check.mjs --temporary');
const root = fileURLToPath(new URL('../', import.meta.url)),
  directory = fs.mkdtempSync(path.join(root, '.studio-development-'));
const app = createStudio({ directory: path.join(directory, 'records'), port: 0 });
let deadline,
  closed = false;
async function close() {
  if (closed) return;
  closed = true;
  clearTimeout(deadline);
  await app.close();
  process.stdin.pause();
  console.log(JSON.stringify({ closed: true, evidenceDirectory: directory }));
}
try {
  const origin = await app.start(),
    token = (await (await fetch(origin)).text()).match(/name="studio-token" content="([^"]+)"/)[1];
  const api = async (url, data = {}) => {
    const response = await fetch(origin + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token },
      body: JSON.stringify(data),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return result;
  };
  const { project, workflow } = await api('/api/studio-development');
  const run = await api(`/api/workflows/${workflow.id}/run`, {
    projectId: project.id,
    expectedVersion: workflow.version,
  });
  const connection = {
    origin,
    projectId: project.id,
    taskIds: run.taskIds,
    evidenceDirectory: directory,
    originalDataUsed: false,
  };
  fs.writeFileSync(path.join(directory, 'connection.json'), JSON.stringify(connection, null, 2));
  console.log(JSON.stringify(connection));
  const end = Date.now() + 190000;
  while (app.runner.active.size || !['review', 'failed', 'blocked'].includes(app.store.task(run.taskIds[0]).status)) {
    if (Date.now() > end) throw new Error('Source-check deadline reached.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const task = app.store.task(run.taskIds[0]),
    attempt = task.lastAttemptId && app.store.attempt(task.lastAttemptId);
  if (task.status !== 'review') throw new Error(task.reason || 'Source checks did not reach Review.');
  for (const item of attempt.artifacts)
    fs.copyFileSync(path.join(attempt.outputFolder, item.path), path.join(directory, item.path));
  fs.writeFileSync(
    path.join(directory, 'review-state.json'),
    JSON.stringify(
      {
        task,
        attempt,
        dependent: app.store.task(run.taskIds[1]),
        acceptance: 'Pending director review; no acceptance or Codex attempt performed.',
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      status: task.status,
      summary: attempt.result.summary,
      report: path.join(directory, 'check-report.json'),
      pendingAcceptance: true,
    }),
  );
  deadline = setTimeout(close, 600000);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', text => {
    if (text.trim() === 'close') close();
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, close);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
  await close();
}

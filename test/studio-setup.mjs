// Shared model-free controller fixture for the HTTP and dashboard tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudio } from './model-free-studio.mjs';
import { describeTask, waitFor } from './wait-for.mjs';

export const fixture = fileURLToPath(new URL('./fixture-cli.mjs', import.meta.url));
export const claudeFixture = fileURLToPath(new URL('./fixture-claude.mjs', import.meta.url));
export async function setup(t, native = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-test-'));
  const app = createStudio({
    directory: dir,
    port: 0,
    runnerOptions: native === 'claude' ? { claudeBinary: claudeFixture } : native ? { codexBinary: fixture } : {},
  });
  const origin = await app.start(),
    html = await (await fetch(origin)).text(),
    token = html.match(/name="studio-token" content="([^"]+)"/)[1];
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const request = async (url, body = {}, method = 'POST') => {
    const res = await fetch(origin + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };
  const state = () => fetch(origin + '/api/state').then(r => r.json());
  const wait = async id => {
    let seen;
    return waitFor(
      async () => {
        const s = await state(),
          task = s.tasks.find(t => t.id === id);
        seen = { task, attempt: s.attempts.find(a => a.id === task.lastAttemptId) };
        if (!['running', 'stopping'].includes(task.status)) return { s, ...seen };
      },
      `task ${id} to stop running`,
      { interval: 30, detail: () => describeTask(seen.task, seen.attempt) },
    );
  };
  const until = async (check, label) => {
    await waitFor(check, label);
  };
  return { app, dir, origin, token, request, state, wait, until };
}

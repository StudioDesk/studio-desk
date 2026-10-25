import fs from 'node:fs';
const seed = JSON.parse(fs.readFileSync(new URL('./profile.json', import.meta.url), 'utf8'));

export function gameOrganization() {
  const org = structuredClone(seed);
  delete org.tasks;
  delete org.events;
  org.schemaVersion = 1;
  org.paused = false;
  org.quota = { codex: false };
  org.maxParallel = 2;
  for (const doc of [
    org.instructions.company,
    ...Object.values(org.instructions.teams),
    ...Object.values(org.instructions.employees),
  ]) {
    doc.draft = null;
    doc.history[0].note = 'Initial studio instructions';
  }
  return org;
}

export const gameOrganizationPreset = { id: 'game-studio', version: 'game-studio-v1', create: gameOrganization };

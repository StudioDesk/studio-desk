// The samples a fresh install offers on No projects yet (v1.0 item 24, MP-027): small projects bundled with the
// app, never downloaded, each with its team and two suggested first ideas. Code is a git repository with tests;
// Writing is general work whose files go to its first idea. Their files live beside this module. The Code sample
// carries its own package.json: a sample in the default data folder sits inside the app, whose package.json makes
// .js files ES modules, and Node reads the nearest one.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const houseRules =
  'You approve the plan before any work starts. Work that passes its review goes in on its own.';

export const projectTemplates = Object.freeze([
  Object.freeze({
    id: 'code',
    kind: 'code',
    name: 'To-do list sample',
    description:
      'A small to-do list library with tests. Agents plan a change, make it in their own copy, run the tests and review it before it goes in.',
    files: Object.freeze(['README.md', 'package.json', 'src/todo.js', 'test/todo.test.js']),
    team: Object.freeze([
      Object.freeze({ agentId: 'W-01', role: 'Planner', does: 'plans', line: 'Turns your idea into stories' }),
      Object.freeze({ agentId: 'W-02', role: 'Engineer', does: 'builds', line: 'Makes the change in its own copy' }),
      Object.freeze({
        agentId: 'W-07',
        role: 'Reviewer',
        does: 'reviews',
        line: 'Checks the work and can send it back',
      }),
    ]),
    needsGit: true,
    suggestions: Object.freeze([
      'Add a way to mark every item on the list done at once, with a test that shows it works.',
      'Let items have a due date, and list overdue items first.',
    ]),
  }),
  Object.freeze({
    id: 'writing',
    kind: 'writing',
    name: 'Volunteer guide sample',
    description:
      'A short brief, notes and a style sheet. A planner splits up the job, a writer drafts it, and a reviewer can send it back before you read the result.',
    files: Object.freeze(['brief.md', 'notes.md', 'style.md']),
    team: Object.freeze([
      Object.freeze({ agentId: 'W-01', role: 'Planner', does: 'plans', line: 'Turns your idea into steps' }),
      Object.freeze({ agentId: 'W-09', role: 'Writer', does: 'writes', line: 'Drafts the piece and hands it on' }),
      Object.freeze({
        agentId: 'W-07',
        role: 'Reviewer',
        does: 'reviews',
        line: 'Checks the work and can send it back',
      }),
    ]),
    needsGit: false,
    suggestions: Object.freeze([
      'Turn the brief into a one-page welcome guide for new volunteers, friendly and under 400 words.',
      "Write a short email inviting last year's volunteers back, using the dates in the notes.",
    ]),
  }),
]);

export function projectTemplate(id) {
  const template = projectTemplates.find(item => item.id === id);
  if (!template) throw new Error('Choose the Code or the Writing sample.');
  return template;
}

// A sample's files as { path, bytes, data }, read from the app's own copy.
export function templateFiles(template) {
  return template.files.map(file => {
    const data = fs.readFileSync(path.join(here, template.id, ...file.split('/')));
    return { path: file, bytes: data.length, data };
  });
}

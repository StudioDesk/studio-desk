// Model-free Claude Code protocol fixture for general work. Never connects to a provider.
// It does what its assignment's direction says, one command per line:
//   write <path> <text>  writes <path> holding <text> and a newline, and returns it as a work file
//   delete <path>        removes <path> from the output folder (workspace delivery only)
//   fail-check           reports a failed check
//   block                returns outcome blocked
//   hang                 after writing, keeps running until the controller stops it (its time limit
//                        or a cancellation) and returns nothing
//   quota                after writing, reports a provider usage limit and exits, returning nothing
// The stop modes write in workspace delivery and say so on stdout ({"type":"fixture.work-written"}).
// With no write command it writes work.md from the title. Before doing anything it records the
// work it found, on disk (workspace delivery) or as editable files in its prompt (text delivery
// with --safe-mode), beside the job in ../fixture-general-work.json.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2),
  text = args.includes('--safe-mode'),
  emit = data => console.log(JSON.stringify(data));
if (args.includes('auth')) {
  emit({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' });
  process.exit(0);
}
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const job = JSON.parse(fs.readFileSync('../assignment.json', 'utf8')),
  agents = fs.readFileSync('AGENTS.md', 'utf8');
if (job.kind !== 'general:work' || (text ? !prompt.includes(agents) : !prompt.startsWith('Read AGENTS.md'))) {
  console.error('This fixture does delivered general work only.');
  process.exit(1);
}
// Text delivery lists the editable files as one JSON line after this marker.
const marker = 'Return only changed files:\n',
  editable =
    text && prompt.includes(marker)
      ? JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length).split('\n')[0])
      : [];
const walk = (directory, prefix = '') =>
  fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap(item =>
      item.isDirectory() ? walk(path.join(directory, item.name), prefix + item.name + '/') : [prefix + item.name],
    );
const found = text
  ? Object.fromEntries(editable.map(file => [file.path, file.content]))
  : Object.fromEntries(
      walk('.')
        .filter(file => file !== 'AGENTS.md')
        .map(file => [file, fs.readFileSync(file, 'utf8')]),
    );
fs.writeFileSync(
  '../fixture-general-work.json',
  JSON.stringify({ mode: text ? 'text' : 'workspace', found, editable: editable.map(file => file.path) }),
);

const lines = (job.direction || '').split('\n').map(line => line.trim()),
  writes = lines
    .map(line => /^write (\S+) (.*)$/.exec(line))
    .filter(Boolean)
    .map(([, file, content]) => ({ path: file, content: content + '\n' })),
  deletes = lines
    .map(line => /^delete (\S+)$/.exec(line))
    .filter(Boolean)
    .map(([, file]) => file),
  blocked = lines.includes('block'),
  failed = lines.includes('fail-check'),
  stop = ['hang', 'quota'].find(mode => lines.includes(mode));
if (!writes.length) writes.push({ path: 'work.md', content: `# ${job.title}\n` });
// Workspace delivery works on disk; text delivery returns the contents for the controller to stage.
if (!text) {
  for (const file of deletes) fs.rmSync(file, { force: true });
  for (const file of writes) {
    fs.mkdirSync(path.dirname(file.path), { recursive: true });
    fs.writeFileSync(file.path, file.content);
  }
}
const init = {
  type: 'system',
  subtype: 'init',
  session_id: 'fixture-general-work-session',
  model: 'fixture-general-work-model',
  tools: text ? [] : ['Bash', 'Read', 'Edit'],
  mcp_servers: [],
  plugins: [],
  apiKeySource: 'none',
};
// The work written above is all the controller can keep: no result follows a stop.
if (stop) {
  emit(init);
  emit({ type: 'fixture.work-written' });
  if (stop === 'quota') {
    // The usage limit form the native adapters recognize, as fixture-source-edit.mjs reports it.
    emit({ type: 'error', message: 'usage limit reached' });
    process.exit(1);
  }
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
const result = {
  taskId: job.id,
  outcome: blocked ? 'blocked' : 'completed',
  summary: `Fixture general work wrote ${writes.map(file => file.path).join(', ')}.`,
  artifacts: writes.map(file => ({ path: file.path, kind: 'work-file' })),
  checks: [
    failed
      ? { name: 'Fixture check', status: 'fail', evidence: 'The direction asked for a failed check.' }
      : { name: 'Fixture protocol', status: 'not-run', evidence: 'No provider was invoked.' },
  ],
  issues: blocked ? ['The direction asked the fixture to stop blocked.'] : [],
  handoff: 'Independent review required.',
};
emit(init);
emit({
  type: 'result',
  subtype: 'success',
  is_error: false,
  structured_output: text ? { result, files: writes } : result,
});

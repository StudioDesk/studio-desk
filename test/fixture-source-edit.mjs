// Model-free CLI protocol fixture. Never invokes Codex or a model.
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] === 'login') {
  console.log('Logged in using ChatGPT');
  process.exit(0);
}
const assignment = JSON.parse(fs.readFileSync('../assignment.json')),
  mode = assignment.direction || 'pass';
// 'quota-soon' stops like 'quota' at a limit that names its reset three seconds ahead, until a run
// continues from that stopped work (continueFrom); that run returns its work as 'pass' does.
const limit =
  mode === 'quota' || (mode === 'quota-soon' && !JSON.parse(fs.readFileSync('source-scope.json')).continueFrom);
// A long edit, otherwise like 'pass'.
if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 1500));
// Identifiable work survives even when no common result can be returned.
if ((limit || mode === 'hang') && assignment.kind === 'studio-development:change') {
  const scope = JSON.parse(fs.readFileSync('source-scope.json')),
    line = `\n// Retained ${mode} fixture work.\n`;
  // Carried work already holds the line (continueFrom); a continuation does not repeat it.
  for (const target of scope.allowedFiles)
    if (!fs.readFileSync('changes/' + target, 'utf8').includes(line)) fs.appendFileSync('changes/' + target, line);
  for (const target of scope.newFiles || []) fs.writeFileSync('changes/' + target, `// New ${mode} fixture work.\n`);
  console.log(JSON.stringify({ type: 'fixture.work-written' }));
}
if (limit) {
  const reset = mode === 'quota-soon' ? `|${Math.floor(Date.now() / 1000) + 3}` : '';
  console.log(JSON.stringify({ type: 'error', message: `usage limit reached${reset}` }));
  process.exit(1);
}
if (mode === 'hang') {
  setInterval(() => {}, 1000);
} else {
  let artifacts;
  if (assignment.kind === 'studio-development:change-review') {
    const inputs = path.resolve('../inputs', assignment.dependencies[0]);
    const manifestPath = fs.readdirSync(inputs).find(file => file.endsWith('-source-change.json'));
    const bytes = fs.readFileSync(path.join(inputs, manifestPath)),
      manifest = JSON.parse(bytes);
    const { createHash } = await import('node:crypto');
    const reference = assignment.acceptedInputs.find(ref => ref.taskId === assignment.dependencies[0]);
    const source = {
      taskId: reference.taskId,
      attemptId: reference.attemptId,
      path: 'source-change.json',
      hash: createHash('sha256').update(bytes).digest('hex'),
      candidateHash: manifest.candidateHash,
    };
    if (mode === 'wrong-review') source.candidateHash = 'wrong';
    // As a real review did on October 19: the input copy's path first, then, once the automatic
    // retry names the expected value, the right path and a needs-work verdict.
    const inputPathFirst = mode.startsWith('input-path-then-negative'),
      negative = mode === 'negative-review' || inputPathFirst;
    if (inputPathFirst && !mode.includes('source.path must be source-change.json'))
      source.path = `../inputs/${reference.taskId}/${manifestPath}`;
    // A review graded under contract v2 (MP-019): blocking findings and non-blocking notes.
    fs.writeFileSync(
      'source-change-review.json',
      JSON.stringify({
        schemaVersion: 'source-change-review-v2',
        source,
        verdict: negative ? 'needs-work' : 'pass',
        summary: 'Model-free candidate review fixture.',
        findings: negative ? ['Fixture requests more work.'] : [],
        notes: mode === 'pass-with-notes' ? ['Fixture note: a case this repository does not use.'] : [],
        unperformedChecks: ['Browser layout', 'Engine integration', 'Playtest'],
      }),
    );
    artifacts = [{ path: 'source-change-review.json', kind: 'source-change-review' }];
  } else {
    const scope = JSON.parse(fs.readFileSync('source-scope.json'));
    if (mode === 'input') fs.writeFileSync('../inputs/' + assignment.dependencies[0] + '/0-source-review.json', '{}');
    if (mode === 'instructions') fs.writeFileSync('AGENTS.md', 'Modified fixture instructions.');
    if (mode === 'escape') {
      fs.writeFileSync('outside.mjs', 'export const escaped = true;');
      artifacts = [{ path: 'outside.mjs', kind: 'source-file' }];
    } else {
      // A scope that only deletes files has nothing to edit; the controller deletes them.
      // 'next' edits the first approved file its carried work (continueFrom) did not change.
      const carried = new Set((scope.continueFrom?.files || []).map(item => item.path)),
        untouched = scope.allowedFiles.filter(file => mode === 'next' && !carried.has(file)),
        files = mode === 'multi' ? scope.allowedFiles : (untouched.length ? untouched : scope.allowedFiles).slice(0, 1),
        // About 225 KB of added lines, beyond the 192 KiB a candidate review reads.
        added = mode === 'large' ? Array.from({ length: 9000 }, (_, i) => `// Oversized line ${i}.\n`).join('') : '',
        line = '\n// Bounded fixture improvement.\n' + added;
      if (mode !== 'noop')
        for (const target of files)
          if (!fs.readFileSync('changes/' + target, 'utf8').includes(line))
            fs.appendFileSync('changes/' + target, line);
      artifacts = files.map(target => ({ path: 'changes/' + target, kind: 'source-file' }));
      // Every approved new file is created at changes/<path>.
      for (const target of mode === 'noop' ? [] : scope.newFiles || []) {
        fs.writeFileSync('changes/' + target, `export const created = ${JSON.stringify(target)};\n`);
        artifacts.push({ path: 'changes/' + target, kind: 'source-file' });
      }
      // A blocked editor names the paths it needs (MP-021); the direction carries the request.
      const requested = /^block-request (.+)$/s.exec(mode);
      if (requested) {
        fs.writeFileSync(
          'scope-request.json',
          JSON.stringify({ schemaVersion: 'source-scope-request-v1', ...JSON.parse(requested[1]) }),
        );
        artifacts.push({ path: 'scope-request.json', kind: 'source-scope-request' });
      }
    }
  }
  const result = {
    taskId: assignment.id,
    outcome: mode === 'block' || mode.startsWith('block-request ') ? 'blocked' : 'completed',
    summary: 'Model-free source-edit fixture.',
    artifacts,
    checks: [],
    issues: [],
    handoff: 'Inspect protocol fixture evidence.',
  };
  fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify(result));
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'source-edit-fixture-session' }));
}

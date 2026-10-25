// Process fixture. It never runs the source suite, Codex or a model.
const mode = process.argv[2];
// Slow tests that still pass.
if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 1500));
if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'malformed') console.log('No test totals');
else {
  if (mode === 'mutate') {
    const fs = await import('node:fs');
    fs.writeFileSync('README.md', 'Fixture changed copied source.');
  }
  console.log(
    'TAP version 13\n1..1\n' +
      (mode === 'fail' ? 'not ok' : 'ok') +
      ' 1 - process fixture\n# tests 1\n# pass ' +
      (mode === 'fail' ? 0 : 1) +
      '\n# fail ' +
      (mode === 'fail' ? 1 : 0) +
      '\n# cancelled 0\n# skipped 0\n# todo 0',
  );
  // Whether the copy under test carries the Claude fixture's edit (an employee's own test run).
  const fs = await import('node:fs');
  if (fs.existsSync('src/core/workflows.mjs'))
    console.log(`# edited: ${fs.readFileSync('src/core/workflows.mjs', 'utf8').includes('Claude fixture edit')}`);
  if (mode === 'fail') process.exitCode = 1;
}

// Process fixture. It never runs the source suite, Codex or a model.
const mode = process.argv[2];
// Slow tests that still pass.
if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 1500));
if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'malformed') console.log('No test totals');
// One failure first, with its location and a block error, then more passing output (over 200 KB) than an
// employee's test run keeps of it, then consistent totals.
else if (mode === 'early-failure') {
  const passing = Array.from(
    { length: 5000 },
    (_, index) => `ok ${index + 2} - keeps passing in a long run, ${index + 1} of 5000`,
  );
  console.log(
    [
      'TAP version 13',
      'not ok 1 - fails early in a long run',
      '  ---',
      '  duration_ms: 1.5',
      "  location: '/repository/test/early.test.mjs:3:1'",
      "  failureType: 'testCodeFailure'",
      '  error: |-',
      '    Expected values to be strictly equal:',
      '    ',
      "    'lost' !== 'kept'",
      "  code: 'ERR_ASSERTION'",
      '  ...',
      ...passing,
      '1..5001',
      '# tests 5001',
      '# pass 5000',
      '# fail 1',
      '# cancelled 0',
      '# skipped 0',
      '# todo 0',
    ].join('\n'),
  );
  process.exitCode = 1;
} else {
  const fs = await import('node:fs');
  if (mode === 'mutate') fs.writeFileSync('README.md', 'Fixture changed copied source.');
  // Two changes that pass alone and fail together: the fixture's edit of workflows.mjs and a line in projects.mjs.
  const holds = (file, text) => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(text),
    fail =
      mode === 'fail' ||
      (mode === 'together' &&
        holds('src/core/workflows.mjs', 'Bounded fixture improvement.') &&
        holds('src/core/projects.mjs', 'Fails with the improvement.'));
  console.log(
    'TAP version 13\n1..1\n' +
      (fail ? 'not ok' : 'ok') +
      ' 1 - process fixture\n# tests 1\n# pass ' +
      (fail ? 0 : 1) +
      '\n# fail ' +
      (fail ? 1 : 0) +
      '\n# cancelled 0\n# skipped 0\n# todo 0',
  );
  // Whether the copy under test carries the Claude fixture's edit (an employee's own test run).
  if (fs.existsSync('src/core/workflows.mjs'))
    console.log(`# edited: ${fs.readFileSync('src/core/workflows.mjs', 'utf8').includes('Claude fixture edit')}`);
  if (fail) process.exitCode = 1;
}

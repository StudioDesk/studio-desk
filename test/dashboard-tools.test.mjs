// The new dashboard's checks run inside the controller suite (Decision MP-026, v1.0 item 19b), so source
// checks, candidate tests and integration verification all typecheck, lint, test and build it with no
// change to the test command. The tools come from installed packages, found as Node finds them, in the
// nearest node_modules up from this copy: `npm ci` here, or the pipeline's install in its data folder. Every
// tool writes outside the snapshot's folders. When the dashboard's own tests fail, the failure names each
// failed test from Vitest's JSON report, written to a temporary folder: its file, its full name and the first
// line of its error, and each unhandled error the runner printed (such as a page's code still loading when a test
// file closes, which fails the run without failing a test): the file it originated in, the last test to run and its
// first line. At most 10 lines in all, with page dumps and stacks left out. Only when the run names neither does it
// show the end of the runner's output, as the other tools' failures do, with the runner's first error line on top.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Inside the candidate sandbox, temporary folders must live in the writable workspace.
import './model-free-studio.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
function tool(relative) {
  for (let directory = root; ; directory = path.dirname(directory)) {
    const file = path.join(directory, 'node_modules', ...relative.split('/'));
    if (fs.existsSync(file)) return file;
    if (path.dirname(directory) === directory) return null;
  }
}

// describe(output) builds the failure message from the tool's whole output; it runs only when the tool fails.
// Each tool's run is stopped after its time limit; the dashboard's own tests have the longest, which grows with them.
function run(
  name,
  script,
  args,
  describe = output => `The dashboard's ${name} failed:\n${tail(output)}`,
  limit = 110000,
) {
  const file = tool(script);
  if (!file)
    assert.fail(
      `The dashboard's ${name} is not installed: run \`npm ci\` in ${root} (the pipeline installs its own in its data folder).`,
    );
  const environment = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };
  // A nested runner would otherwise report into this test's own stream.
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [file, ...args], {
    cwd: root,
    env: environment,
    encoding: 'utf8',
    timeout: limit,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  // A run stopped for time says so, rather than reading as a failure with no report.
  if (result.error?.code === 'ETIMEDOUT')
    assert.fail(`The dashboard's ${name} ran past ${limit / 1000} seconds and were stopped:\n${output.slice(-1500)}`);
  assert.equal(result.status, 0, result.status === 0 ? undefined : describe(output || result.error?.message));
  return output;
}

// The end of a tool's output, as a failure shows it.
function tail(output) {
  return String(output ?? '').slice(-4000);
}

// The first non-empty line of an error, without colour codes, cut to about 160 characters.
function errorStart(text) {
  const line =
    String(text ?? '')
      .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
      .split(/\r?\n/)
      .map(part => part.trim())
      .find(Boolean) ?? '';
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

// One line per failure in Vitest's JSON report: each failed test as `<file> > <full name>: <error start>`, and a
// file that failed to load or collect, with no failed test, as `<file>: <message start>`. Files are named relative
// to base with forward slashes.
function failedTests(report, base) {
  const failures = [];
  for (const entry of Array.isArray(report?.testResults) ? report.testResults : []) {
    const file = path.relative(base, String(entry?.name ?? '')).replace(/\\/g, '/');
    const failed = (Array.isArray(entry?.assertionResults) ? entry.assertionResults : []).filter(
      item => item?.status === 'failed',
    );
    for (const item of failed) {
      const name = item.fullName || [...(item.ancestorTitles ?? []), item.title].filter(Boolean).join(' ');
      failures.push(`${file} > ${name}: ${errorStart(item.failureMessages?.[0])}`);
    }
    if (entry?.status === 'failed' && !failed.length) failures.push(`${file}: ${errorStart(entry.message)}`);
  }
  return failures;
}

function outputLines(output) {
  return String(output ?? '')
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .split(/\r?\n/);
}

// One line per error in the "Unhandled Errors" section Vitest prints when an error fails the run outside any test:
// `<file> > <last test to run>: <error start>`, leaving out what Vitest does not know. Each error follows a banner
// naming its type (`⎯⎯ Unhandled Rejection ⎯⎯`); the section ends with a bare divider. Vitest names files relative
// to its root (testsRoot, the dashboard folder); they are named here relative to base with forward slashes.
function unhandledErrors(output, base, testsRoot = path.join(base, 'dashboard')) {
  const banner = /^⎯+\s+(.+?)\s+⎯+$/;
  const errors = [];
  let inSection = false,
    current = null;
  for (const raw of outputLines(output)) {
    const line = raw.trim();
    if (!inSection) {
      inSection = banner.exec(line)?.[1] === 'Unhandled Errors';
      continue;
    }
    if (/^⎯+$/.test(line)) break;
    if (banner.test(line)) {
      current = { lines: [], file: null, test: null };
      errors.push(current);
      continue;
    }
    if (!current) continue;
    const origin = /^This error originated in "(.+)" test file\./.exec(line);
    const last = /^The last test to run before this error was "(.+)"\./.exec(line);
    if (origin) current.file ??= origin[1];
    else if (last) current.test ??= last[1];
    else current.lines.push(line);
  }
  return errors.map(error => {
    const file =
      error.file && path.relative(base, path.resolve(testsRoot, error.file.replace(/\\/g, '/'))).replace(/\\/g, '/');
    const where = [file, error.test].filter(Boolean).join(' > ');
    const start = errorStart(error.lines.join('\n')) || 'an unhandled error with no message';
    return where ? `${where}: ${start}` : start;
  });
}

// The first line of the runner's output that reads as an error (`TypeError: …`, `Error [CODE]: …`), cut as
// errorStart cuts it; '' when there is none.
function firstErrorLine(output) {
  return errorStart(outputLines(output).find(line => /^\s*[A-Za-z]*Error\b[^:]*:\s*\S/.test(line)));
}

function counted(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

// The failure message for a failed run: a header that counts them, then the report's failed tests and the output's
// unhandled errors, failed tests first, at most 10 lines with how many more; null when neither names any. The
// controller keeps an error's first 8 lines and 600 characters, so the first come first.
function testsFailure(report, base, output = '') {
  const failures = failedTests(report, base),
    unhandled = unhandledErrors(output, base),
    all = failures.concat(unhandled);
  if (!all.length) return null;
  const named = all.slice(0, 10);
  if (all.length > named.length) named.push(`and ${all.length - named.length} more`);
  const counts = [
    failures.length && counted(failures.length, 'failure', 'failures'),
    unhandled.length && counted(unhandled.length, 'unhandled error', 'unhandled errors'),
  ].filter(Boolean);
  return [`The dashboard's tests failed (${counts.join(' and ')}):`].concat(named).join('\n');
}

// The message for a failed run of the dashboard's tests: what testsFailure names, or else the end of the runner's
// output under a header naming its first error line when there is one (a worker that exited, for example).
function testsMessage(report, base, output) {
  const named = testsFailure(report, base, output);
  if (named) return named;
  const first = firstErrorLine(output);
  return `The dashboard's tests failed, and the runner left no report naming a failure${first ? ` (first error: ${first})` : ''}:\n${tail(output)}`;
}

function readReport(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

test('the dashboard typechecks', () => {
  run('typecheck', 'typescript/bin/tsc', ['--noEmit', '-p', 'tsconfig.json']);
});

test("the dashboard passes its lint rules, including React's rules of hooks", () => {
  run('lint', 'eslint/bin/eslint.js', ['--max-warnings', '0', 'dashboard']);
});

// On October 30 and November 1 the whole run took 83 to over 110 seconds as the dashboard grew and the computer was
// busy, past the 110 seconds every tool had; its limit is 300 seconds, inside the test's own.
test("the dashboard's own tests pass in a simulated page", { timeout: 320000 }, t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-dashboard-tests-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const report = path.join(folder, 'report.json');
  const output = run(
    'tests',
    'vitest/vitest.mjs',
    ['run', '--configLoader', 'native', '--reporter', 'dot', '--reporter', 'json', '--outputFile.json', report],
    printed => testsMessage(readReport(report), root, printed),
    300000,
  );
  assert.match(output, /Tests\s+\d+ passed/);
});

test('a failed dashboard test is named with its file, its full name and the first line of its error', () => {
  const file = name => path.join(root, 'dashboard', 'src', name);
  const notFound =
    'TestingLibraryElementError: Unable to find an element with the text: Start the story. This could be because the text is broken up by multiple elements. In this case, you can provide a function for your text matcher.';
  const report = {
    numTotalTests: 3,
    numPassedTests: 1,
    numFailedTests: 2,
    success: false,
    testResults: [
      {
        name: file('app.test.tsx'),
        status: 'passed',
        message: '',
        assertionResults: [
          {
            ancestorTitles: ['the app'],
            fullName: 'the app opens Today',
            title: 'opens Today',
            status: 'passed',
            failureMessages: [],
          },
        ],
      },
      {
        // Vitest names files with forward slashes on every system.
        name: file('board-page.test.tsx').replace(/\\/g, '/'),
        status: 'failed',
        message: '',
        assertionResults: [
          {
            ancestorTitles: ['the board'],
            fullName: 'the board starts a story',
            title: 'starts a story',
            status: 'failed',
            failureMessages: [
              [
                '',
                notFound,
                '',
                'Ignored nodes: comments, script, style',
                '<body>',
                '  <div>',
                '    <main class="sd-board" />',
                '  </div>',
                '</body>',
                '    at Object.getElementError (node_modules/@testing-library/dom/dist/config.js:37:19)',
                '    at dashboard/src/board-page.test.tsx:42:18',
              ].join('\n'),
            ],
          },
        ],
      },
      {
        name: file('attempt-record.test.tsx'),
        status: 'failed',
        message: '',
        assertionResults: [
          {
            ancestorTitles: ['an attempt record'],
            fullName: '',
            title: 'opens the saved output',
            status: 'failed',
            failureMessages: [
              "\u001b[31mAssertionError: expected 'Saved' to be 'Saved output'\u001b[39m\n\n- Expected\n+ Received\n\n    at dashboard/src/attempt-record.test.tsx:12:5",
            ],
          },
        ],
      },
      {
        name: file('story-page.test.tsx'),
        status: 'failed',
        message:
          'Failed to load url ./missing-page (resolved id: ./missing-page) in dashboard/src/story-page.test.tsx. Does the file exist?\n    at loadAndTransform (node_modules/vite/dist/node/chunks/dep.js:1:1)',
        assertionResults: [],
      },
    ],
  };
  const lines = failedTests(report, root);
  assert.equal(lines.length, 3, lines.join('\n'));
  assert.match(
    lines[0],
    /^dashboard\/src\/board-page\.test\.tsx > the board starts a story: TestingLibraryElementError: /,
  );
  const start = lines[0].slice('dashboard/src/board-page.test.tsx > the board starts a story: '.length);
  assert.ok(notFound.startsWith(start.slice(0, -1)) && start.endsWith('…'), start);
  assert.ok(start.length <= 160, `${start.length} characters`);
  assert.equal(
    lines[1],
    "dashboard/src/attempt-record.test.tsx > an attempt record opens the saved output: AssertionError: expected 'Saved' to be 'Saved output'",
  );
  assert.equal(
    lines[2],
    'dashboard/src/story-page.test.tsx: Failed to load url ./missing-page (resolved id: ./missing-page) in dashboard/src/story-page.test.tsx. Does the file exist?',
  );
  for (const line of lines)
    assert.doesNotMatch(line, /Ignored nodes|<body|\bat \S+:\d+|Expected|Received|\u001b|opens Today/);

  const message = testsFailure(report, root).split('\n');
  assert.deepEqual(message, ["The dashboard's tests failed (3 failures):", ...lines]);
  // A run whose report names no failure, or that left none, falls back to the end of the runner's output.
  assert.equal(testsFailure({ ...report, testResults: report.testResults.slice(0, 1) }, root), null);
  assert.equal(testsFailure(null, root), null);

  const many = {
    testResults: [
      {
        name: file('many.test.ts'),
        status: 'failed',
        message: '',
        assertionResults: Array.from({ length: 12 }, (_, index) => ({
          ancestorTitles: [],
          fullName: `case ${index + 1}`,
          title: `case ${index + 1}`,
          status: 'failed',
          failureMessages: [`Error: case ${index + 1} broke\n    at many.test.ts:${index + 1}:1`],
        })),
      },
    ],
  };
  const summary = testsFailure(many, root).split('\n');
  assert.equal(summary[0], "The dashboard's tests failed (12 failures):");
  assert.equal(summary.length, 12);
  assert.equal(summary[1], 'dashboard/src/many.test.ts > case 1: Error: case 1 broke');
  assert.equal(summary[10], 'dashboard/src/many.test.ts > case 10: Error: case 10 broke');
  assert.equal(summary[11], 'and 2 more');
});

// Sample output as Vitest prints it with colour off: its banners are runs of ⎯ around a title, and it names files
// relative to its root, the dashboard folder.
const rule = '⎯'.repeat(80);
const banner = title => `${'⎯'.repeat(30)} ${title} ${'⎯'.repeat(30)}`;
function unhandledSection(...errors) {
  return [
    '',
    banner('Unhandled Errors'),
    '',
    `Vitest caught ${errors.length} unhandled error${errors.length > 1 ? 's' : ''} during the test run.`,
    'This might cause false positive tests. Resolve unhandled errors to make sure your tests are not affected.',
    ...errors.flatMap(error => ['', ...error]),
    rule,
  ];
}
function unhandled({ type = 'Unhandled Rejection', start, file, test: name, more = [] }) {
  return [
    banner(type),
    start,
    ...more,
    file &&
      `This error originated in "${file}" test file. It doesn't mean the error was thrown inside the file itself, but while it was running.`,
    name &&
      `The last test to run before this error was "${name}". This means either:\n- the error was thrown while Vitest was running this test, or\n- the error was thrown after the test completed, and this was the most recent test at that point.`,
  ].filter(Boolean);
}
const teardown =
  "EnvironmentTeardownError: Cannot load '/src/story-page.tsx' imported from C:/studio/dashboard/src/routes.tsx after the environment was torn down. This is not a bug in Vitest.";
const summaryLines = [
  '',
  ' Test Files  14 passed (14)',
  '      Tests  152 passed (152)',
  '     Errors  1 error',
  '   Start at  10:42:07',
  '   Duration  48.31s',
];

test('an unhandled error in a dashboard test run is named with its file, the last test and its first line', () => {
  const output = [
    ' RUN  v4.0.0 C:/studio/dashboard',
    '',
    '··························································',
    ...unhandledSection(
      unhandled({
        start: teardown,
        more: [
          ' ❯ VitestModuleRunner.import node_modules/vitest/dist/chunks/moduleRunner.js:120:13',
          '',
          '<body>',
          '  <main class="sd-story" />',
          '</body>',
        ],
        file: 'src/app.test.tsx',
        test: 'the app > opens a story from the board',
      }),
    ),
    ...summaryLines,
  ].join('\n');
  const lines = unhandledErrors(output, root);
  assert.equal(lines.length, 1, lines.join('\n'));
  const prefix = 'dashboard/src/app.test.tsx > the app > opens a story from the board: ';
  assert.ok(lines[0].startsWith(`${prefix}EnvironmentTeardownError: Cannot load '/src/story-page.tsx'`), lines[0]);
  const start = lines[0].slice(prefix.length);
  assert.ok(teardown.startsWith(start.slice(0, -1)) && start.endsWith('…'), start);
  assert.ok(start.length <= 160, `${start.length} characters`);

  const message = testsMessage(null, root, output);
  assert.deepEqual(message.split('\n'), ["The dashboard's tests failed (1 unhandled error):", lines[0]]);
  assert.doesNotMatch(message, /❯|<body|sd-story|This error originated|This means either|Vitest caught|Test Files/);
  // Windows line endings and leftover colour codes read the same.
  assert.deepEqual(unhandledErrors(`\u001b[31m${output.replace(/\n/g, '\r\n')}\u001b[39m`, root), lines);
});

test('each unhandled error in a dashboard test run is named on its own line, with what Vitest knows of it', () => {
  const output = [
    ...unhandledSection(
      unhandled({ start: teardown, file: 'src/settings-page.test.tsx', test: 'settings saves the theme' }),
      unhandled({
        type: 'Unhandled Error',
        start: 'TypeError: Cannot read properties of undefined (reading "id")',
        more: ['    at Timeout._onTimeout (dashboard/src/board.tsx:40:12)'],
        file: 'src/board-page.test.tsx',
      }),
    ),
    ...summaryLines,
  ].join('\n');
  const lines = unhandledErrors(output, root);
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(
    lines[0],
    /^dashboard\/src\/settings-page\.test\.tsx > settings saves the theme: EnvironmentTeardownError: /,
  );
  assert.equal(
    lines[1],
    'dashboard/src/board-page.test.tsx: TypeError: Cannot read properties of undefined (reading "id")',
  );
  assert.deepEqual(testsFailure(null, root, output).split('\n'), [
    "The dashboard's tests failed (2 unhandled errors):",
    ...lines,
  ]);
  // An error Vitest could not place is named by its first line alone.
  assert.deepEqual(unhandledErrors(unhandledSection(unhandled({ start: 'Error: socket hang up' })).join('\n'), root), [
    'Error: socket hang up',
  ]);
});

test('a dashboard test run names its failed tests first, then its unhandled errors, at most 10 lines', () => {
  const report = {
    testResults: [
      {
        name: path.join(root, 'dashboard', 'src', 'story-page.test.tsx'),
        status: 'failed',
        message: '',
        assertionResults: [
          {
            ancestorTitles: ['the story page'],
            fullName: 'the story page shows its stages',
            title: 'shows its stages',
            status: 'failed',
            failureMessages: ['Error: Test timed out in 5000ms.\n    at story-page.test.tsx:9:3'],
          },
        ],
      },
    ],
  };
  const output = unhandledSection(
    unhandled({ start: teardown, file: 'src/app.test.tsx', test: 'the app opens Settings' }),
  ).join('\n');
  const both = testsFailure(report, root, output).split('\n');
  assert.equal(both.length, 3, both.join('\n'));
  assert.equal(both[0], "The dashboard's tests failed (1 failure and 1 unhandled error):");
  assert.equal(
    both[1],
    'dashboard/src/story-page.test.tsx > the story page shows its stages: Error: Test timed out in 5000ms.',
  );
  assert.match(both[2], /^dashboard\/src\/app\.test\.tsx > the app opens Settings: EnvironmentTeardownError: /);

  const many = unhandledSection(
    ...Array.from({ length: 12 }, (_, index) =>
      unhandled({ start: `Error: error ${index + 1}`, file: `src/page-${index + 1}.test.tsx` }),
    ),
  ).join('\n');
  const capped = testsFailure(report, root, many).split('\n');
  assert.equal(capped[0], "The dashboard's tests failed (1 failure and 12 unhandled errors):");
  assert.equal(capped.length, 12);
  assert.match(capped[1], /^dashboard\/src\/story-page\.test\.tsx > /);
  assert.equal(capped[2], 'dashboard/src/page-1.test.tsx: Error: error 1');
  assert.equal(capped[10], 'dashboard/src/page-9.test.tsx: Error: error 9');
  assert.equal(capped[11], 'and 3 more');
  // The controller keeps an error's first 8 lines and 600 characters; the header and first errors fit in them.
  assert.ok(capped.slice(0, 8).join('\n').length <= 600);
});

test('a dashboard test run that crashed naming no failure shows the end of its output', () => {
  const output = [
    ' RUN  v4.0.0 C:/studio/dashboard',
    '',
    '·······························',
    ...Array.from({ length: 200 }, (_, index) => `stdout | src/app.test.tsx > line ${index + 1} of a long log`),
  ].join('\n');
  assert.equal(unhandledErrors(output, root).length, 0);
  assert.equal(
    testsMessage(null, root, output),
    `The dashboard's tests failed, and the runner left no report naming a failure:\n${output.slice(-4000)}`,
  );
  // A report naming no failure reads the same.
  assert.equal(
    testsMessage({ testResults: [] }, root, output),
    `The dashboard's tests failed, and the runner left no report naming a failure:\n${output.slice(-4000)}`,
  );
  // A worker that exited leaves no section; the header names the runner's first error line.
  const exited = `${output}\n\nError: [vitest-pool]: Worker forks emitted error.\n    at EventEmitter.<anonymous> (node_modules/vitest/dist/chunks/cli-api.js:1:1)\nCaused by: Error: Worker exited unexpectedly`;
  assert.equal(
    testsMessage(null, root, exited),
    `The dashboard's tests failed, and the runner left no report naming a failure (first error: Error: [vitest-pool]: Worker forks emitted error.):\n${exited.slice(-4000)}`,
  );
});

test('the dashboard builds', t => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-dashboard-build-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  run('build', 'vite/bin/vite.js', [
    'build',
    '--configLoader',
    'native',
    '--outDir',
    out,
    '--emptyOutDir',
    '--logLevel',
    'warn',
  ]);
  const page = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.match(page, /name="studio-token" content="%STUDIO_TOKEN%"/, 'The controller fills in the request token.');
  // The page's security policy allows scripts from the controller only: every script names its file.
  assert.doesNotMatch(page, /<script(?![^>]*\ssrc=)[^>]*>/);
  assert.match(page, /<script src="\/theme\.js"><\/script>/);
  // Fonts and other files load from the controller only (default-src 'self'), so no stylesheet inlines one as a
  // data: URL. On October 22 a 2.9 KB font subset was inlined and the browser refused it on every page.
  const assets = path.join(out, 'assets'),
    styles = fs.readdirSync(assets).filter(name => name.endsWith('.css'));
  assert.ok(styles.length, 'The build has a stylesheet.');
  for (const name of styles)
    assert.doesNotMatch(fs.readFileSync(path.join(assets, name), 'utf8'), /url\(\s*['"]?data:/, name);
});

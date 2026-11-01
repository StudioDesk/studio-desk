// The new dashboard's checks run inside the controller suite (Decision MP-026, v1.0 item 19b), so source
// checks, candidate tests and integration verification all typecheck, lint, test and build it with no
// change to the test command. The tools come from installed packages, found as Node finds them, in the
// nearest node_modules up from this copy: `npm ci` here, or the pipeline's install in its data folder. Every
// tool writes outside the snapshot's folders. When the dashboard's own tests fail, the failure names each
// failed test from Vitest's JSON report, written to a temporary folder: its file, its full name and the first
// line of its error, at most 10 of them, with page dumps and stacks left out. Only when Vitest left no report
// naming one does it show the end of the runner's output, as the other tools' failures do.
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

// describe(tail) builds the failure message from the end of the tool's output; it runs only when the tool fails.
// Each tool's run is stopped after its time limit; the dashboard's own tests have the longest, which grows with them.
function run(name, script, args, describe = tail => `The dashboard's ${name} failed:\n${tail}`, limit = 110000) {
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
  assert.equal(
    result.status,
    0,
    result.status === 0 ? undefined : describe(output.slice(-4000) || result.error?.message),
  );
  return output;
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

// The failure message for a failed run: a header line, then the first 10 failures and how many more; null when
// the report names none. The controller keeps an error's first 8 lines and 600 characters, so the first come first.
function testsFailure(report, base) {
  const failures = failedTests(report, base);
  if (!failures.length) return null;
  const named = failures.slice(0, 10);
  if (failures.length > named.length) named.push(`and ${failures.length - named.length} more`);
  return [`The dashboard's tests failed (${failures.length} ${failures.length === 1 ? 'failure' : 'failures'}):`]
    .concat(named)
    .join('\n');
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
    tail =>
      testsFailure(readReport(report), root) ??
      `The dashboard's tests failed, and the runner left no report naming a failure:\n${tail}`,
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

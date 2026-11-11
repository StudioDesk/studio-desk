// Every folder spelling goes through the one shared lookup (src/core/real-path.mjs). A direct call to the plain or
// native resolver elsewhere can spell one folder two ways, so this guard reads the source, scripts and tests and names
// every such call by file and line. It only reads files: no processes, no studio.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const folders = ['src', 'scripts', 'test'];
// The helper itself is the one place that calls the resolvers.
const helper = 'src/core/real-path.mjs';
// A call on a line carrying this marker is a deliberate stub (a test asserting what a stubbed resolver answers).
const marker = '// real-path-guard: deliberate stub';
// The resolver's name is put together here so this file holds no direct call itself.
const resolver = ['fs', 'realpathSync'].join('.');
const direct = new RegExp(`\\b${resolver.replace('.', '\\.')}(?:\\.native)?\\s*\\(`);

// A line that is only a comment is prose about the resolver, never a call: it starts with //, with * (inside a block
// comment), or with /* and does not close the comment. Comments are not stripped from a line of code, since a string
// such as a glob can look like one and would hide a call after it, so a call in a trailing comment is still named.
const prose = line => /^\s*(\/\/|\*(?!\/))/.test(line) || (/^\s*\/\*/.test(line) && !line.includes('*/'));

// The 1-based line numbers of the direct calls in one file's text, given its path relative to the repository.
function directCalls(file, text) {
  if (file === helper) return [];
  const found = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!prose(line) && direct.test(line) && !line.includes(marker)) found.push(index + 1);
  });
  return found;
}

// Every .mjs and .js file under the folder, relative to the repository and spelled with forward slashes.
function sourceFiles(folder) {
  const files = [];
  const walk = relative => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const at = `${relative}/${entry.name}`;
      if (entry.isDirectory() && entry.name !== 'node_modules') walk(at);
      else if (entry.isFile() && /\.(mjs|js)$/.test(entry.name)) files.push(at);
    }
  };
  if (fs.existsSync(path.join(root, folder))) walk(folder);
  return files;
}

// One message naming every offending file and line.
function offenders(found) {
  if (!found.length) return '';
  return [
    `Look up a folder's real spelling through realPath in ${helper}, not by calling ${resolver} directly, or mark a deliberate stub with "${marker}":`,
    ...found.map(({ file, line }) => `  ${file}:${line}`),
  ].join('\n');
}

test('no file under src, scripts or test calls the resolver directly outside the shared lookup', () => {
  const found = [];
  for (const folder of folders)
    for (const file of sourceFiles(folder))
      for (const line of directCalls(file, fs.readFileSync(path.join(root, file), 'utf8'))) found.push({ file, line });
  assert.equal(found.length, 0, offenders(found));
});

const plainCall = `${resolver}(folder)`,
  nativeCall = `${resolver}.native(folder)`,
  spacedCall = `${resolver}.native  (folder)`;

test('an unmarked direct call is named by its line, plain, native or spaced before the parenthesis', () => {
  const text = ['const a = 1;', `const b = ${plainCall};`, `const c = ${nativeCall};`, `const d = ${spacedCall};`].join(
    '\n',
  );
  assert.deepEqual(directCalls('src/connectors/sample.mjs', text), [2, 3, 4]);
  assert.deepEqual(directCalls('scripts/sample.js', `\r\n\r\nreturn ${plainCall};\r\n`), [3]);
});

test('the same call with the marker passes, and only that line', () => {
  const text = [`assert.equal(${plainCall}, short); ${marker}`, `assert.equal(${nativeCall}, long);`].join('\n');
  assert.deepEqual(directCalls('test/sample.test.mjs', text), [2]);
  assert.deepEqual(directCalls('test/sample.test.mjs', `${nativeCall}; ${marker}`), []);
});

test('references that are not calls stay allowed', () => {
  const text = [
    `const native = ${resolver}.native;`,
    `const plain = ${resolver},`,
    `t.mock.method(${resolver}, 'native', (value, ...rest) => value);`,
    `t.mock.method(fs, 'realpathSync', value => value);`,
    `${resolver}.native = () => { throw new Error('refused'); };`,
    `// ${resolver} keeps a short name, and ${plainCall} would too.`,
    `/* ${plainCall}`,
    ` * ${plainCall} in a doc comment line`,
    ' */',
  ].join('\n');
  assert.deepEqual(directCalls('src/connectors/sample.mjs', text), []);
  assert.deepEqual(directCalls('src/sample.mjs', `/* note */ const g = ${plainCall};`), [1], 'Code after a comment.');
  assert.deepEqual(directCalls('src/sample.mjs', `const e = 1; // ${nativeCall}`), [1], 'A trailing comment is named.');
  assert.deepEqual(
    directCalls('src/sample.mjs', `const glob = 'tests/*.test.ts';\nconst h = ${plainCall};`),
    [2],
    'A glob in a string hides nothing.',
  );
  assert.deepEqual(
    directCalls('src/sample.mjs', `const u = 'file://x'; ${nativeCall};`),
    [1],
    'A URL is not a comment.',
  );
});

test('the shared lookup itself may call the resolvers', () => {
  const text = `try {\n  return ${nativeCall};\n} catch {\n  return ${plainCall};\n}`;
  assert.deepEqual(directCalls(helper, text), []);
  assert.deepEqual(directCalls('src/core/other.mjs', text), [2, 4]);
});

test('one message names every offending file and line, with forward slashes', () => {
  const message = offenders([
    { file: 'src/a.mjs', line: 3 },
    { file: 'test/b/c.test.mjs', line: 41 },
  ]);
  assert.match(message, /^ {2}src\/a\.mjs:3$/m);
  assert.match(message, /^ {2}test\/b\/c\.test\.mjs:41$/m);
  assert.equal(offenders([]), '');
});

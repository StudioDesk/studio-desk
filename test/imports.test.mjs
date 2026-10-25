import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

// A small text scanner for this repository's modules, not a JavaScript parser.
// Keep token kinds: a string containing "return" must not turn division into a regexp.
function tokensOf(source) {
  const tokens = [];
  let at = 0;
  const add = (kind, value) => tokens.push({ kind, value });
  const regexMayStart = () => {
    const previous = tokens.at(-1);
    return (
      !previous ||
      (previous.kind === 'word' &&
        /^(return|throw|case|delete|void|typeof|instanceof|in|of|yield|await|else|do)$/.test(previous.value)) ||
      (previous.kind === 'punctuation' && /^[({[=,:;!?&|+*%~^<>-]$/.test(previous.value))
    );
  };
  const quoted = quote => {
    let value = '';
    at++;
    while (at < source.length) {
      const char = source[at++];
      if (char === quote) break;
      if (char === '\\') {
        const escaped = source[at++];
        if (escaped === '\r' && source[at] === '\n') at++;
        else if (escaped !== '\n' && escaped !== '\r') value += { n: '\n', r: '\r', t: '\t' }[escaped] ?? escaped;
      } else value += char;
    }
    return value;
  };
  while (at < source.length) {
    const char = source[at];
    if (/\s/.test(char)) {
      at++;
    } else if (source.startsWith('//', at) || (at === 0 && source.startsWith('#!', at))) {
      while (at < source.length && !/[\r\n]/.test(source[at])) at++;
    } else if (source.startsWith('/*', at)) {
      const end = source.indexOf('*/', at + 2);
      at = end < 0 ? source.length : end + 2;
    } else if (char === '"' || char === "'") {
      add('string', quoted(char));
    } else if (char === '`') {
      // Template text commonly contains example module source in the tests.
      add('template', quoted(char));
    } else if (char === '/' && regexMayStart()) {
      let end = at + 1,
        inClass = false,
        closed = false;
      // A regexp cannot cross a physical line break. Never consume a later import
      // while looking for the end of a slash that was actually division.
      for (; end < source.length && !/[\r\n]/.test(source[end]); end++) {
        if (source[end] === '\\') {
          if (/[\r\n]/.test(source[end + 1] || '')) break;
          end++;
        } else if (source[end] === '[') inClass = true;
        else if (source[end] === ']') inClass = false;
        else if (source[end] === '/' && !inClass) {
          closed = true;
          break;
        }
      }
      if (closed) {
        at = end + 1;
        while (/[a-z]/i.test(source[at] || '')) at++;
        add('regexp', '');
      } else {
        add('punctuation', char);
        at++;
      }
    } else if (/[\w$]/.test(char)) {
      const start = at++;
      while (/[\w$]/.test(source[at] || '')) at++;
      add(/\d/.test(char) ? 'number' : 'word', source.slice(start, at));
    } else {
      add('punctuation', char);
      at++;
    }
  }
  return tokens;
}

function relativeSpecifiers(source) {
  const tokens = tokensOf(source),
    specifiers = [];
  const is = (token, kind, value) => token?.kind === kind && token.value === value;
  const record = token => {
    if (token?.kind === 'string' && /^(\.\/|\.\.\/)/.test(token.value)) specifiers.push(token.value);
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index],
      next = tokens[index + 1];
    if (token.kind !== 'word' || !['import', 'export'].includes(token.value)) continue;
    if (is(tokens[index - 1], 'punctuation', '.')) continue;
    if (token.value === 'import' && is(next, 'punctuation', '(')) {
      // Computed imports are outside this guard; only string-literal arguments.
      if ([')', ','].includes(tokens[index + 3]?.value)) record(tokens[index + 2]);
      continue;
    }
    if (token.value === 'import' && next?.kind === 'string') {
      record(next);
      continue;
    }
    if (token.value === 'export' && !['{', '*'].includes(next?.value)) continue;
    if (token.value === 'import' && next?.kind !== 'word' && !['{', '*'].includes(next?.value)) continue;
    let braces = 0;
    for (let cursor = index + 1; cursor < tokens.length; cursor++) {
      const current = tokens[cursor];
      // Keywords are legal names inside the named-specifier list. Only stop at
      // declaration boundaries outside its braces (including import/export/;).
      if (
        braces === 0 &&
        (is(current, 'punctuation', ';') || (current.kind === 'word' && ['import', 'export'].includes(current.value)))
      )
        break;
      if (is(current, 'punctuation', '{')) braces++;
      else if (is(current, 'punctuation', '}')) braces--;
      else if (braces === 0 && is(current, 'word', 'from') && tokens[cursor + 1]?.kind === 'string') {
        record(tokens[cursor + 1]);
        break;
      }
    }
  }
  return specifiers;
}

function moduleFiles(root) {
  const files = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(file);
    }
  };
  for (const directory of ['src', 'scripts', 'test']) visit(path.join(root, directory));
  return files.sort();
}

function missingTargets(root) {
  const missing = [];
  for (const file of moduleFiles(root)) {
    // Read text only: scripts and fixture bodies must never execute here.
    for (const specifier of relativeSpecifiers(fs.readFileSync(file, 'utf8'))) {
      const target = path.resolve(path.dirname(file), specifier);
      let exists = false;
      try {
        exists = fs.statSync(target).isFile();
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      }
      if (!exists) missing.push(`${path.relative(root, file).split(path.sep).join('/')}: missing ${specifier}`);
    }
  }
  return missing;
}

function assertTargetsExist(root) {
  const missing = missingTargets(root);
  assert.equal(missing.length, 0, `Missing relative module targets:\n${missing.join('\n')}`);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-imports-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const directory of ['src', 'scripts', 'test']) fs.mkdirSync(path.join(root, directory));
  return {
    root,
    write(file, text) {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    },
  };
}

test('repository relative module targets exist in src, scripts and test', () => {
  assertTargetsExist(repositoryRoot);
});

const declarations = [
  ['single-quoted static import', target => `import value from '${target}';`],
  ['double-quoted static import', target => `import value from "${target}";`],
  ['multiline named import', target => `import {\n value as alias,\n other\n} from\n'${target}';`],
  ['namespace import', target => `import * as values from '${target}';`],
  ['single-quoted export from', target => `export { value } from '${target}';`],
  ['double-quoted multiline export from', target => `export {\n value as alias\n} from\n"${target}";`],
  ['export star', target => `export * from '${target}';`],
  ['single-quoted dynamic import', target => `const value = import('${target}');`],
  ['double-quoted multiline dynamic import', target => `const value = import(\n"${target}"\n);`],
  ['side-effect import', target => `import '${target}';`],
  ['keyword-named import specifier', target => `import { export as value } from '${target}';`],
  ['keyword-named export specifier', target => `export { value as export } from '${target}';`],
];

for (const [name, declaration] of declarations) {
  test(`focused ${name}: existing passes; missing names referring file and exact specifier`, t => {
    const f = fixture(t),
      referring = 'scripts/nested/check.mjs';
    f.write('scripts/nested/existing.mjs', 'throw new Error("Scanned targets must never execute");');
    f.write(referring, declaration('./existing.mjs'));
    assert.doesNotThrow(() => assertTargetsExist(f.root));
    f.write(referring, declaration('./missing.mjs'));
    assert.deepEqual(missingTargets(f.root), [`${referring}: missing ./missing.mjs`]);
    assert.throws(
      () => assertTargetsExist(f.root),
      error => error.message.includes(referring) && error.message.includes('./missing.mjs'),
    );
  });
}

test('focused scan covers all three trees recursively, resolves parents and never executes bodies', t => {
  const f = fixture(t);
  f.write('src/shared.mjs', 'throw new Error("Do not execute the target");');
  f.write('src/nested/source.mjs', "import value from '../shared.mjs';\nthrow new Error('Do not execute');");
  f.write('scripts/nested/preflight.mjs', "export * from '../../src/shared.mjs';");
  f.write('test/nested/example.mjs', 'const module = import("../../src/shared.mjs");');
  f.write('scripts/ignored.js', "import value from './missing.mjs';");
  assert.deepEqual(
    moduleFiles(f.root)
      .map(file => path.relative(f.root, file).split(path.sep).join('/'))
      .sort(),
    ['scripts/nested/preflight.mjs', 'src/nested/source.mjs', 'src/shared.mjs', 'test/nested/example.mjs'],
  );
  assert.doesNotThrow(() => assertTargetsExist(f.root));
  f.write('scripts/cli-status.mjs', "import { locateClaude } from '../src/claude.mjs';");
  assert.deepEqual(missingTargets(f.root), ['scripts/cli-status.mjs: missing ../src/claude.mjs']);
});

test('focused comments, ordinary strings, template text, regexps and external specifiers are ignored', t => {
  const f = fixture(t);
  f.write(
    'src/examples.mjs',
    String.raw`
      // import value from './comment.mjs';
      /* export * from "./block-comment.mjs"; */
      const text = "import value from './ordinary-string.mjs'";
      const other = 'export * from "./other-string.mjs"';
      const template = ` +
      '`import("./template-text.mjs")`;' +
      String.raw`
      const pattern = /import value from ['"]\.\/regexp\.mjs['"]/;
      import fs from 'node:fs';
      export * from "some-package";
      const external = import('another-package');
      const computed = import('./computed-' + name);
      const meta = import.meta.url;
      object.import('./method-argument.mjs');
      throw new Error('This scanned body must not execute');
    `,
  );
  assert.doesNotThrow(() => assertTargetsExist(f.root));
});

test('focused division after keyword-valued strings does not hide a later missing import', t => {
  const f = fixture(t);
  for (const word of ['return', 'throw', 'case', 'delete', 'void', 'typeof', 'yield', 'await']) {
    for (const quote of ["'", '"']) {
      f.write(
        'scripts/division.mjs',
        `const quotient = ${quote}${word}${quote} / 2;\nimport value from './missing.mjs';`,
      );
      assert.deepEqual(missingTargets(f.root), ['scripts/division.mjs: missing ./missing.mjs']);
    }
  }
});

test('focused regexp line breaks do not consume subsequent declarations', t => {
  const f = fixture(t);
  for (const newline of ['\n', '\r\n']) {
    f.write(
      'scripts/regex-lines.mjs',
      `const pattern = /["']/;${newline}const quotient = "return" / 2;${newline}export * from './missing.mjs';`,
    );
    assert.deepEqual(missingTargets(f.root), ['scripts/regex-lines.mjs: missing ./missing.mjs']);
    // Exercise recovery from an ambiguous slash without swallowing the next line.
    f.write('scripts/regex-lines.mjs', `void /${newline}import value from './missing.mjs';`);
    assert.deepEqual(missingTargets(f.root), ['scripts/regex-lines.mjs: missing ./missing.mjs']);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// The shared reader executes alone, with no document, fetch or app scripts, so it can
// neither reach the DOM or network nor borrow the dashboard's shared scope.
const context = vm.createContext({ URL });
vm.runInContext(fs.readFileSync(new URL('../public/markdown-reader.js', import.meta.url), 'utf8'), context, {
  filename: 'markdown-reader.js',
});
const reader = context.StudioMarkdownReader;
const read = source => reader.markdown(source);
const isolated = () => {
  assert.ok(Object.isFrozen(reader));
  assert.equal(vm.runInContext('typeof fetch', context), 'undefined');
  assert.equal(vm.runInContext('typeof document', context), 'undefined');
};
const esc = value =>
  String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const readerText = html =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

test('reader renders the supported Markdown constructs with semantic, inert markup', () => {
  const source = [
      '# Title',
      '## Section',
      '### Three',
      '#### Four',
      '##### Five',
      '###### Six',
      '',
      'A paragraph with *emphasis*, _more_, **strong** and __bold__.',
      '',
      '- First',
      '- Second',
      '',
      '1. One',
      '2. Two',
      '',
      '> Quoted **words**',
      '',
      '`<img src=x onerror=alert(1)>`',
      '',
      '```html',
      '<script>literal()</script>',
      '# still code',
      '```',
      '',
      '| Name | Value |',
      '| --- | :---: |',
      '| **one** | `two` |',
    ].join('\n'),
    html = read(source);
  for (let level = 1; level <= 6; level++) assert.match(html, new RegExp(`<h${level}>.*</h${level}>`));
  assert.match(
    html,
    /<p>A paragraph with <em>emphasis<\/em>, <em>more<\/em>, <strong>strong<\/strong> and <strong>bold<\/strong>\.<\/p>/,
  );
  assert.match(html, /<ul><li>First<\/li><li>Second<\/li><\/ul>/);
  assert.match(html, /<ol><li>One<\/li><li>Two<\/li><\/ol>/);
  assert.match(html, /<blockquote><p>Quoted <strong>words<\/strong><\/p><\/blockquote>/);
  assert.match(html, /<code>&lt;img src=x onerror=alert\(1\)&gt;<\/code>/);
  assert.match(html, /<pre><code>&lt;script&gt;literal\(\)&lt;\/script&gt;\n# still code\n<\/code><\/pre>/);
  assert.match(
    html,
    /<table><thead><tr><th scope="col">Name<\/th><th scope="col">Value<\/th><\/tr><\/thead><tbody><tr><td><strong>one<\/strong><\/td><td><code>two<\/code><\/td><\/tr><\/tbody><\/table>/,
  );
  assert.doesNotMatch(html, /<(?:script|img|iframe)\b|<[^>]+\son\w+=|<[^>]+\sstyle=/);
  isolated();
});

test('reader keeps complete raw HTML regions literal, including non-void slash syntax and nesting', () => {
  const content = '# literal heading\n\n[fetch](https://remote.test/)\n**literal emphasis**';
  for (const source of [
    `<div/>\n${content}\n</div>`,
    `<div><div/>\n</div>\n${content}\n</div>`,
    `<DIV data-note="quoted >" />\n${content}\n</DIV>`,
    `<section/><section/>\n</section>\n${content}\n</section>`,
    `<script/>\n${content}\n</script>`,
    `<div>\n<!-- </div> -->\n${content}\n</div>`,
    `<div>\n<script>"</div>"</script>\n${content}\n</div>`,
    `<script>\n${content}\n</script>`,
    `<!--\n${content}\n-->`,
    `<iframe src="https://remote.test/">\n${content}\n</iframe>`,
  ]) {
    const html = read(source);
    assert.ok(readerText(html).includes(source), source);
    assert.ok(html.includes('# literal heading'), source);
    assert.ok(html.includes('[fetch](https://remote.test/)'), source);
    assert.ok(html.includes('**literal emphasis**'), source);
    assert.doesNotMatch(
      html,
      /<(?:h[1-6]|a|strong|div|script|iframe)\b[^>]*(?:href|src)|<h[1-6]>|<strong>|<a\s/,
      source,
    );
  }
  isolated();
  const outside = read('<div/>\n# inside\n</div>\n\n# Outside');
  assert.match(outside, /# inside/);
  assert.match(outside, /<h1>Outside<\/h1>/);
  const voidTag = read('<br/>\n\n# Outside');
  assert.match(voidTag, /&lt;br\/&gt;/);
  assert.match(voidTag, /<h1>Outside<\/h1>/);
});

test('reader escapes closing tags, attributes, literal embeds, and markup in code', () => {
  for (const source of [
    '</p></section><img src="https://remote.test/x" onerror="alert(1)">',
    '<div onclick="alert(1)">**not strong** [no](https://remote.test/)</div>',
    '<!-- multi-line\n\n# hidden heading\n[no](https://remote.test/)\n-->',
    '<script>\n\n# heading\n[no](https://remote.test/)\n</script>',
    '<object data="https://remote.test/file"><embed src="file:///local"></object>',
    '<style>body { background: url(https://remote.test/) }</style>',
  ]) {
    const html = read(source);
    assert.ok(readerText(html).includes(source), source);
    assert.doesNotMatch(html, /<(?:script|img|object|embed|style|a|h1|strong)\b|<[^>]+\son\w+=/, source);
  }
  const code = read('~~~\n</code><img onerror="x" src="https://remote.test/">\n~~~\n\n`</code><script>x</script>`');
  assert.match(code, /&lt;\/code&gt;&lt;img onerror=&quot;x&quot;/);
  assert.match(code, /<code>&lt;\/code&gt;&lt;script&gt;x&lt;\/script&gt;<\/code>/);
  assert.doesNotMatch(code, /<(?:script|img)\b|<[^>]+\son\w+=/);
  isolated();
});

test('reader only links explicit HTTP destinations and keeps their complete addresses visible', () => {
  for (const address of ['http://example.test/a', 'https://example.test/a?q=1&n=2', 'HTTPS://example.test/path']) {
    const html = read(`[Read](${address})`);
    assert.match(html, /<a href="https?:\/\/example\.test\/[^"\s]*" target="_blank" rel="noopener noreferrer">/);
    assert.ok(html.includes(`Read (${esc(address)})</a>`));
  }
  for (const address of [
    'javascript:alert(1)',
    'data:text/html,<script>x</script>',
    'file:///private.txt',
    '//remote.test/path',
    '/relative',
    'relative.md',
    '#fragment',
    'https:',
    'http://',
    'http:///bad',
    'https://[bad',
    'java\nscript:alert(1)',
    'java\tscript:alert(1)',
    'javascript&#58;alert(1)',
    'java%73cript:alert(1)',
    ' https://remote.test/',
    'https://remote.test/" onclick="x',
    'https:\\remote.test/',
  ]) {
    const source = `[Read](${address})`,
      html = read(source);
    assert.doesNotMatch(html, /<a\b|<script\b|<[^>]+\son\w+=/, source);
    // Raw HTML tokens inside a refused destination must also stay visible.
    assert.ok(readerText(html).includes(source), source);
    assert.ok(!html.includes('\u0000'), source);
  }
});

test('reader images stay literal and perform no content-directed requests', () => {
  const source = [
      '![remote](https://remote.test/image.png)',
      '![local](file:///private.png)',
      '![data](data:image/svg+xml,<svg onload="x"></svg>)',
      '<img src="https://remote.test/image.png">',
      '[![image](https://remote.test/image.png)](https://example.test/)',
    ].join('\n\n'),
    html = read(source);
  assert.match(html, /!\[remote\]\(https:\/\/remote\.test\/image\.png\)/);
  assert.doesNotMatch(html, /<(?:img|svg|iframe|object|embed)\b|<[^>]+\s(?:src|srcset)=/);
  isolated();
});

// The reader's own table wrapper is the only <div> it may emit.
const inert = (html, source) =>
  assert.doesNotMatch(
    html,
    /<(?:script|img|iframe)\b|<div\b(?! class="reader-table">)|<[^>]+\son\w+=|<[^>]+\sstyle=/i,
    source,
  );
const literalTag = tag => `<span class="reader-literal">${esc(tag)}</span>`;

test('reader shows a tag that is never closed as its own literal text and reads the Markdown after it', () => {
  const cases = [
    ['Use a <div> wrapper here.\n\n# After', `<p>Use a ${literalTag('<div>')} wrapper here.</p><h1>After</h1>`],
    [
      'It returns Promise<void> now.\n\n**done**',
      `<p>It returns Promise${literalTag('<void>')} now.</p><p><strong>done</strong></p>`,
    ],
    [
      'A Map<string> of names, *each* checked.',
      `<p>A Map${literalTag('<string>')} of names, <em>each</em> checked.</p>`,
    ],
    // Formerly kept literal to the end of the text.
    [
      '<div/>\n# literal heading\n\n[fetch](https://remote.test/)\n**literal emphasis**',
      `<p>${literalTag('<div/>')}</p><h1>literal heading</h1><p><a href="https://remote.test/" target="_blank" rel="noopener noreferrer">fetch (https://remote.test/)</a>\n<strong>literal emphasis</strong></p>`,
    ],
    // An unclosed tag before a closed region of the same name, and the reverse.
    ['<div><div></div>\n\n# Outside', `<p>${literalTag('<div>')}${literalTag('<div></div>')}</p><h1>Outside</h1>`],
    ['<div></div><div>\n# After', `<p>${literalTag('<div></div>')}${literalTag('<div>')}</p><h1>After</h1>`],
    ['<script><script>\n# After', `<p>${literalTag('<script>')}${literalTag('<script>')}</p><h1>After</h1>`],
  ];
  for (const [source, expected] of cases) {
    const html = read(source);
    assert.equal(html, expected, source);
    inert(html, source);
  }
  assert.equal(readerText(read('Use a <div> wrapper here.')), 'Use a <div> wrapper here.');
  assert.ok(
    read('It returns Promise<void> now.')
      .replace(/<[^>]*>/g, '')
      .includes('Promise&lt;void&gt; now.'),
  );
  // Only the opening tag, exactly as written including its attributes, is literal.
  for (const tag of [
    `<div class="note" data-limit='1 > 0'>`,
    '<section/>',
    '<script src="https://remote.test/x.js">',
    '<style>',
    '<plaintext>',
    '<iframe src="https://remote.test/">',
    '<DIV onclick="alert(1)" style="color: red">',
  ]) {
    const source = `${tag}\n# After **it**`,
      html = read(source);
    assert.equal(html, `<p>${literalTag(tag)}</p><h1>After <strong>it</strong></h1>`, source);
    assert.equal(readerText(html), `${tag}After it`, source);
    inert(html, source);
  }
  // Every unclosed tag in a long text is its own literal.
  const repeated = 'Promise<void> and Map<string>\n'.repeat(500),
    many = read(repeated);
  assert.equal(many.match(/<span class="reader-literal">/g).length, 1000);
  assert.equal(readerText(many), repeated.trimEnd());
  inert(many, 'repeated unclosed tags');
  isolated();
});

test('reader formats each Markdown block that follows an unclosed tag', () => {
  const blocks = [
    ['# Heading', /<h1>Heading<\/h1>/, 'Heading'],
    ['- item', /<ul><li>item<\/li><\/ul>/, 'item'],
    ['> quote', /<blockquote><p>quote<\/p><\/blockquote>/, 'quote'],
    [
      '| a | b |\n| --- | --- |\n| 1 | 2 |',
      /<table><thead><tr><th scope="col">a<\/th><th scope="col">b<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody><\/table>/,
      'ab12',
    ],
    ['```\ncode()\n```', /<pre><code>code\(\)\n<\/code><\/pre>/, 'code()\n'],
    ['*emphasis*', /<em>emphasis<\/em>/, '\nemphasis'],
  ];
  for (const tag of ['<div>', '<script>', '<div/>']) {
    for (const [block, formatted, shown] of blocks) {
      const source = `${tag}\n${block}`,
        html = read(source);
      assert.ok(html.startsWith(`<p>${literalTag(tag)}`), source);
      assert.match(html, formatted, source);
      // The tag as written, then the block's own text: nothing hidden and nothing added.
      assert.equal(readerText(html), tag + shown, source);
      inert(html, source);
    }
    const source = `${tag}\n${blocks.map(([block]) => block).join('\n\n')}`,
      html = read(source);
    for (const [, formatted] of blocks) assert.match(html, formatted, source);
    assert.ok(readerText(html).startsWith(tag), source);
    inert(html, source);
  }
});

test('reader escapes a tag head that never reaches its closing bracket as ordinary text', () => {
  for (const [source, expected] of [
    ['if a <b and c\n\n# Heading', '<p>if a &lt;b and c</p><h1>Heading</h1>'],
    ['<a title="unterminated\n\n**bold**', '<p>&lt;a title=&quot;unterminated</p><p><strong>bold</strong></p>'],
  ]) {
    const html = read(source);
    assert.equal(html, expected, source);
    assert.doesNotMatch(html, /reader-literal/, source);
    inert(html, source);
  }
});

test('reader still keeps closed regions, comments, code spans and fences literal', () => {
  const content = '# x\n**y** [a](https://remote.test/)';
  for (const source of [
    `<div>\n${content}\n</div>`,
    `<div><div/>\n</div>\n${content}\n</div>`,
    `<div><div></div>\n${content}\n</div>`,
    '<!-- # x -->',
    `<!-- ${content} -->`,
    '<!-- # x',
    `<!-- ${content}`,
    `<script>\n${content}\n</script>`,
    `<script><script>\n${content}\n</script>`,
  ]) {
    const html = read(source);
    assert.equal(html, `<p>${literalTag(source)}</p>`, source);
    assert.doesNotMatch(html, /<h[1-6]>|<strong>|<a\s/, source);
    inert(html, source);
  }
  for (const [source, expected] of [
    ['`<div>` and **more**', '<p><code>&lt;div&gt;</code> and <strong>more</strong></p>'],
    [
      '```\n<div>\n# not a heading\n```\n\n# After',
      '<pre><code>&lt;div&gt;\n# not a heading\n</code></pre><h1>After</h1>',
    ],
  ]) {
    const html = read(source);
    assert.equal(html, expected, source);
    inert(html, source);
  }
});

test('reader applies the unclosed rule to the visible part of a long document', () => {
  // The current dashboard reads its first 8000 characters until Show the rest.
  const source = `<div>\n# Shown\n${'a'.repeat(8000)}\n</div>`,
    part = read(source.slice(0, 8000)),
    whole = read(source);
  assert.ok(part.startsWith(`<p>${literalTag('<div>')}</p><h1>Shown</h1><p>a`));
  assert.equal(whole, `<p>${literalTag(source)}</p>`);
  inert(part, 'visible part');
  inert(whole, 'whole document');
});

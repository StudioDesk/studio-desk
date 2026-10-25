// Recorded text to inert block markup. No DOM, I/O, fetch or controller state.
// Like source-diff.js this standalone script exposes one frozen browser namespace,
// so it relies on nothing from the app scripts' shared scope.
(() => {
  const esc = value =>
    String(value ?? '').replace(
      /[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  // Source text is never handed to an HTML parser. Only these renderers create markup.
  const readerVoidTags = new Set('area base br col embed hr img input link meta param source track wbr'.split(' ')),
    readerRawTags = new Set('script style textarea title iframe xmp noembed noframes noscript plaintext'.split(' '));
  function readerTag(text, start) {
    const head = /^<(\/?)([a-z][\w:-]*)(?=[\s/>])/i.exec(text.slice(start));
    if (!head) return null;
    let quote = '';
    for (let i = start + head[0].length; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') return { name: head[2].toLowerCase(), closing: !!head[1], end: i + 1 };
    }
    // A head that never reaches its '>' is not a tag; its '<' is ordinary text.
    return null;
  }
  // ends records each opening tag's region end, shared across one read of the text.
  function readerRawEnd(text, start, ends) {
    if (ends.has(start)) return ends.get(start);
    if (text.startsWith('<!--', start)) {
      const end = text.indexOf('-->', start + 4);
      return end < 0 ? text.length : end + 3;
    }
    if (/^<[!?]/.test(text.slice(start))) {
      const end = text.indexOf('>', start + 2);
      return end < 0 ? text.length : end + 1;
    }
    const tag = readerTag(text, start);
    if (!tag) return start;
    // <plaintext> can never be closed, so like any unclosed element only its tag is literal.
    if (tag.closing || readerVoidTags.has(tag.name) || tag.name === 'plaintext') return tag.end;
    // In HTML, a trailing slash never closes a non-void element. This applies
    // equally to nested <div/> and to raw-text elements such as <script/>.
    // Same-name opening tags passed on the way share this scan: each closing tag
    // ends the innermost one (in raw text, every one), and any left open at the
    // end of the text is shown as just its tag, with the Markdown after it read.
    const rawText = readerRawTags.has(tag.name),
      open = [[start, tag.end]];
    let cursor = tag.end;
    while (open.length && cursor < text.length) {
      const next = text.indexOf('<', cursor);
      if (next < 0) break;
      if (!rawText && /^<[!?]/.test(text.slice(next))) {
        cursor = readerRawEnd(text, next, ends);
        continue;
      }
      const nested = readerTag(text, next);
      if (!nested) {
        cursor = next + 1;
        continue;
      }
      if (nested.name === tag.name) {
        if (!nested.closing) open.push([next, nested.end]);
        else if (rawText) for (const [opening] of open.splice(0)) ends.set(opening, nested.end);
        else ends.set(open.pop()[0], nested.end);
      } else if (!rawText && !nested.closing && readerRawTags.has(nested.name)) {
        cursor = readerRawEnd(text, next, ends);
        continue;
      }
      cursor = nested.end;
    }
    for (const [opening, end] of open) ends.set(opening, end);
    return ends.get(start);
  }
  function readerFence(text, start) {
    const opening = /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(text.slice(start));
    if (!opening) return null;
    const contentStart = start + opening[0].length,
      close = new RegExp('^ {0,3}' + opening[1][0] + '{' + opening[1].length + ',}[ \\t]*$', 'gm');
    close.lastIndex = contentStart;
    const match = close.exec(text);
    return { code: text.slice(contentStart, match?.index ?? text.length), end: match ? close.lastIndex : text.length };
  }
  function readerLink(destination) {
    if (
      !/^https?:\/\/[^/\s<>"'`\\\u0000-\u0020\u007f-\u009f][^\s<>"'`\\\u0000-\u0020\u007f-\u009f]*$/i.test(destination)
    )
      return null;
    try {
      const url = new URL(destination);
      return url.hostname && ['http:', 'https:'].includes(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  }
  function readerMarkdown(source) {
    const text = source.replace(/\r\n?/g, '\n'),
      literals = [],
      ends = new Map();
    // Choose a delimiter absent from the source, so recorded text cannot impersonate
    // an internal token. Protect whole HTML regions before identifying Markdown blocks.
    let marker = '\u0000reader';
    while (text.includes(marker)) marker += '\u0000';
    let protectedText = '';
    for (let i = 0; i < text.length; ) {
      const fence = (i === 0 || text[i - 1] === '\n') && readerFence(text, i);
      if (fence) {
        protectedText += text.slice(i, fence.end);
        i = fence.end;
        continue;
      }
      if (text[i] === '`') {
        const run = /^`+/.exec(text.slice(i))[0],
          end = text.indexOf(run, i + run.length);
        if (end >= 0) {
          protectedText += text.slice(i, end + run.length);
          i = end + run.length;
          continue;
        }
      }
      const end = text[i] === '<' ? readerRawEnd(text, i, ends) : i;
      if (end > i) {
        const index = literals.push(`<span class="reader-literal">${esc(text.slice(i, end))}</span>`) - 1;
        protectedText += marker + index + marker;
        i = end;
      } else protectedText += text[i++];
    }
    function inline(value, depth = 0) {
      if (depth > 24) return literal(value);
      let html = '';
      for (let i = 0; i < value.length; ) {
        if (value.startsWith(marker, i)) {
          const end = value.indexOf(marker, i + marker.length),
            index = value.slice(i + marker.length, end);
          html += literals[Number(index)];
          i = end + marker.length;
          continue;
        }
        if (value[i] === '\\' && i + 1 < value.length && /[\\`*_[\]{}()#+.!|>-]/.test(value[i + 1])) {
          html += esc(value[i + 1]);
          i += 2;
          continue;
        }
        if (value[i] === '`') {
          const run = /^`+/.exec(value.slice(i))[0],
            end = value.indexOf(run, i + run.length);
          if (end >= 0) {
            html += `<code>${literal(value.slice(i + run.length, end))}</code>`;
            i = end + run.length;
            continue;
          }
        }
        const image = value.startsWith('![', i),
          labelStart = image ? i + 1 : i;
        if (value[labelStart] === '[') {
          let labelEnd = labelStart + 1,
            brackets = 1;
          for (; labelEnd < value.length; labelEnd++) {
            if (value[labelEnd] === '\\') {
              labelEnd++;
              continue;
            }
            if (value[labelEnd] === '[') brackets++;
            if (value[labelEnd] === ']' && !--brackets) break;
          }
          if (!brackets && value[labelEnd + 1] === '(') {
            let end = labelEnd + 2,
              nesting = 1;
            while (end < value.length && nesting) {
              if (value[end] === '(') nesting++;
              if (value[end] === ')') nesting--;
              end++;
            }
            if (!nesting) {
              const destination = value.slice(labelEnd + 2, end - 1),
                url = image ? null : readerLink(destination);
              html += url
                ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${literal(value.slice(labelStart + 1, labelEnd))} (${esc(destination)})</a>`
                : literal(value.slice(i, end));
              i = end;
              continue;
            }
          }
        }
        const emphasis = /^(\*\*|__|\*|_)/.exec(value.slice(i));
        if (emphasis && !(emphasis[0][0] === '_' && /[\p{L}\p{N}]/u.test(value[i - 1] || ''))) {
          const mark = emphasis[0],
            end = value.indexOf(mark, i + mark.length);
          if (end > i + mark.length) {
            const tag = mark.length === 2 ? 'strong' : 'em';
            html += `<${tag}>${inline(value.slice(i + mark.length, end), depth + 1)}</${tag}>`;
            i = end + mark.length;
            continue;
          }
        }
        html += esc(value[i++]);
      }
      return html;
    }
    function literal(value) {
      const parts = value.split(marker);
      return parts.map((part, i) => (i % 2 ? literals[Number(part)] : esc(part))).join('');
    }
    const cells = line => {
        const parts = line.trim().split('|');
        if (!parts[0]) parts.shift();
        if (!parts.at(-1)) parts.pop();
        return parts.map(cell => cell.trim());
      },
      list = line => /^ {0,3}([-+*]|\d+[.)])[ \t]+(.*)$/.exec(line),
      table = (lines, i) =>
        lines[i]?.includes('|') &&
        lines[i + 1]?.includes('|') &&
        cells(lines[i + 1]).every(cell => /^:?-{3,}:?$/.test(cell)) &&
        cells(lines[i]).length === cells(lines[i + 1]).length;
    function blocks(value, depth = 0) {
      if (depth > 16) return `<pre>${literal(value)}</pre>`;
      const lines = value.split('\n');
      let html = '';
      for (let i = 0; i < lines.length; ) {
        if (!lines[i].trim()) {
          i++;
          continue;
        }
        const rest = /^ {0,3}(`{3,}|~{3,})/.test(lines[i]) ? lines.slice(i).join('\n') : '',
          fence = rest && readerFence(rest, 0),
          heading = /^ {0,3}(#{1,6})[ \t]+(.*)$/.exec(lines[i]);
        if (fence) {
          html += `<pre><code>${literal(fence.code)}</code></pre>`;
          i += rest.slice(0, fence.end).split('\n').length;
        } else if (heading) {
          const level = heading[1].length;
          html += `<h${level}>${inline(heading[2].replace(/[ \t]+#+[ \t]*$/, ''))}</h${level}>`;
          i++;
        } else if (/^ {0,3}>/.test(lines[i])) {
          const quote = [];
          while (i < lines.length && /^ {0,3}>/.test(lines[i])) quote.push(lines[i++].replace(/^ {0,3}> ?/, ''));
          html += `<blockquote>${blocks(quote.join('\n'), depth + 1)}</blockquote>`;
        } else if (list(lines[i])) {
          const first = list(lines[i]),
            ordered = /^\d/.test(first[1]),
            tag = ordered ? 'ol' : 'ul';
          html += `<${tag}${ordered && parseInt(first[1], 10) !== 1 ? ` start="${esc(parseInt(first[1], 10))}"` : ''}>`;
          while (i < lines.length) {
            const item = list(lines[i]);
            if (!item || /^\d/.test(item[1]) !== ordered) break;
            html += `<li>${inline(item[2])}</li>`;
            i++;
          }
          html += `</${tag}>`;
        } else if (table(lines, i)) {
          const headers = cells(lines[i]);
          html += `<div class="reader-table"><table><thead><tr>${headers.map(cell => `<th scope="col">${inline(cell)}</th>`).join('')}</tr></thead><tbody>`;
          i += 2;
          while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
            const row = cells(lines[i++]);
            html += `<tr>${headers.map((_, n) => `<td>${inline(row[n] || '')}</td>`).join('')}</tr>`;
          }
          html += '</tbody></table></div>';
        } else {
          const paragraph = [lines[i++]];
          while (
            i < lines.length &&
            lines[i].trim() &&
            !/^ {0,3}(#{1,6}[ \t]|>|`{3,}|~{3,})/.test(lines[i]) &&
            !list(lines[i]) &&
            !table(lines, i)
          )
            paragraph.push(lines[i++]);
          html += `<p>${inline(paragraph.join('\n'))}</p>`;
        }
      }
      return html;
    }
    return blocks(protectedText);
  }
  globalThis.StudioMarkdownReader = Object.freeze({ markdown: readerMarkdown });
})();

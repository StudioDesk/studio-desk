// What the visual check's capture process needs, with no imports, so the process starts quickly: the address an app
// printed, the name of each image, and the script each of a page's steps runs in the browser (1.2 steps 7 and 8).

// A local address the app printed: only this computer's, which Open may offer.
export const localAddress =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d{1,5})?(?:\/[^\s'"<>`]*)?/i;
const colors = /\x1b\[[0-9;?]*[A-Za-z]/g;

// The first address on this computer an app printed; 0.0.0.0 opens as localhost.
export function addressIn(text) {
  const found = localAddress.exec(String(text).replace(colors, ''))?.[0];
  return found ? found.replace('0.0.0.0', 'localhost').replace(/[.,;:)\]]+$/, '') : null;
}

// The name of one capture: its page's place in the list, a slug of its name, its width and theme.
export function imageName(index, page, width, theme) {
  const slug =
    page.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'page';
  return `visual/${String(index + 1).padStart(2, '0')}-${slug}-${width}-${theme}.png`;
}

// The script one step runs in the page: it finds what the step names by its visible text (a button, link or label
// for a click; a field by its label, placeholder or accessible name for typing) and answers { ok, problem }. Waiting
// polls for the text for up to ten seconds.
export function stepScript(step) {
  const helpers = `
    const seen = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const textOf = el => (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '').trim();
    const norm = text => text.replace(/\\s+/g, ' ').trim().toLowerCase();
  `;
  if (step.click !== undefined)
    return `(() => {${helpers}
      const want = norm(${JSON.stringify(step.click)});
      const all = [...document.querySelectorAll('button, a, [role=button], [role=tab], [role=link], [role=menuitem], summary, label, input[type=button], input[type=submit]')].filter(seen);
      const el = all.find(el => norm(textOf(el)) === want) || all.find(el => norm(textOf(el)).includes(want));
      if (!el) return { ok: false, problem: 'nothing to click shows ' + JSON.stringify(${JSON.stringify(step.click)}) };
      el.click();
      return { ok: true };
    })()`;
  if (step.type !== undefined)
    return `(() => {${helpers}
      const want = norm(${JSON.stringify(step.into)});
      const fields = [...document.querySelectorAll('input, textarea, [contenteditable=true]')].filter(seen);
      const named = el => [el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.name, el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')?.innerText, el.closest('label')?.innerText].filter(Boolean).map(norm);
      const el = fields.find(el => named(el).some(name => name === want)) || fields.find(el => named(el).some(name => name.includes(want)));
      if (!el) return { ok: false, problem: 'no field is labeled ' + JSON.stringify(${JSON.stringify(step.into)}) };
      el.focus();
      if (el.isContentEditable) el.textContent = ${JSON.stringify(step.type)};
      else {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
        setter ? setter.call(el, ${JSON.stringify(step.type)}) : (el.value = ${JSON.stringify(step.type)});
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    })()`;
  return `(async () => {${helpers}
    const want = norm(${JSON.stringify(step.wait)});
    for (let i = 0; i < 100; i++) {
      if (norm(document.body?.innerText || '').includes(want)) return { ok: true };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return { ok: false, problem: 'the page never showed ' + JSON.stringify(${JSON.stringify(step.wait)}) };
  })()`;
}

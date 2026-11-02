// Model-free stand-in for the visual check's capture process (src/adapters/visual-capture-run.mjs): it reads the plan
// the candidate step wrote, records it beside the output for the test to read, and writes one small image per page at
// each width and theme with the record the real capture leaves. It starts no app and no browser. It walks each page's
// steps as the real capture does but runs none, so a page that reaches it with no steps list fails here as it would
// there.
import fs from 'node:fs';
import path from 'node:path';
import { imageName } from '../src/connectors/page-capture.mjs';

const plan = JSON.parse(fs.readFileSync(process.argv.at(-1), 'utf8'));
fs.writeFileSync(path.join(plan.out, '..', 'visual-plan-seen.json'), JSON.stringify(plan));
// A one-pixel PNG.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
fs.mkdirSync(path.join(plan.out, 'visual'), { recursive: true });
const images = [];
let steps = 0;
for (const [index, page] of plan.pages.entries())
  for (const theme of plan.themes)
    for (const width of plan.widths) {
      const name = imageName(index, page, width, theme);
      for (const step of page.steps) if (step) steps++;
      fs.writeFileSync(path.join(plan.out, name), png);
      images.push({ path: name, page: page.name, pagePath: page.path, width, theme, height: 1 });
    }
fs.writeFileSync(
  path.join(plan.out, 'visual-check.json'),
  JSON.stringify({
    schemaVersion: 'visual-check-v1',
    state: 'captured',
    browser: plan.browser,
    widths: plan.widths,
    themes: plan.themes,
    pages: plan.pages,
    address: 'http://127.0.0.1:5999/',
    images,
  }),
);
console.log(`captured ${images.length} images, ${steps} steps walked but not run (model-free fixture)`);

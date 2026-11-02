// The visual check (1.2 step 8, decided October 28, 2026). An interface story names its own pages: each a name, a path
// and optional steps to reach a state (click a text, type into a field, wait for a text), proposed by the planner with
// the story and changeable by the director until the check runs; a change applies to the next check. When the story's
// candidate tests pass and its project turned the check on, the controller starts the candidate with the project's
// start command (Try it's, src/connectors/try-copy.mjs) inside the built-in sandbox where it lets a local port
// through, and drives the Chromium-based browser already on the computer through each page at each width and theme,
// with nothing installed (src/adapters/visual-capture-run.mjs). Taking the images is a measured step, not a model's:
// the reviewer only looks, and must describe every image for a pass. With no browser, or where the sandbox keeps the
// app's port inside, the check is recorded as not run and the review goes on without images.
//
// A project's settings are its record's `visualCheck` ({ enabled, widths, themes, browser }); a story's pages are the
// director's `task.pages` once changed, otherwise its proposal's `pages`.
import fs from 'node:fs';
import path from 'node:path';
import { recordProject } from '../core/projects.mjs';
import { proposedStory } from './source-changes.mjs';
import { boundedText as bounded, validateStoryPages } from './story-pages.mjs';
import { imageName, stepScript } from './page-capture.mjs';
import { projectSource } from './source-projects.mjs';
import { sandboxLetsPortsThrough, trySettings } from './try-copy.mjs';

export const defaultWidths = [1440, 390];
export const visualThemes = ['light', 'dark'];
export { imageName, stepScript, validateStoryPages };
// The note the settings and a story carry when no browser was found (the director, October 28).
export const browserNote =
  'Installing Microsoft Edge or Google Chrome lets the reviewer see the pages; nothing is downloaded for you.';

const failure = (message, status = 400) => Object.assign(new Error(message), { status });

// The pages a story's next check captures: the director's, once changed, otherwise those its proposal named, read
// through the same check as the director's so each page has its steps list ([] when it gave none). The proposal's
// stored bytes are left as they were.
export function storyPages(store, task) {
  if (task.pages) return task.pages;
  try {
    const pages = proposedStory(store, task)?.pages;
    return pages ? validateStoryPages(pages) : [];
  } catch {
    return [];
  }
}

// Why a story's pages can no longer change, or null while they can: only a code story has pages, and they change until
// it is closed or integrated. One rule for the change and for what the dashboard reads.
function pagesLocked(task) {
  if (task.kind !== 'studio-development:change')
    return { message: 'Only a code story has pages to check.', status: 400 };
  if (task.closed || task.status === 'denied' || task.sourceStage?.current === 'integrated')
    return { message: 'This story is closed or integrated; its pages can no longer change.', status: 409 };
  return null;
}

// A story's pages as the dashboard reads them: the pages its next check captures, whether they are the director's own,
// and whether they may still change, with the reason when not.
export function storyPagesView(store, task) {
  const locked = pagesLocked(task);
  return {
    pages: task.kind === 'studio-development:change' ? storyPages(store, task) : [],
    changed: !!task.pages,
    editable: !locked,
    reason: locked?.message ?? null,
  };
}

// The director changes a story's pages. Allowed until the story is closed or integrated; it applies to the next check.
export function setStoryPages(store, task, pages) {
  const locked = pagesLocked(task);
  if (locked) throw failure(locked.message, locked.status);
  task.pages = validateStoryPages(pages);
  store.putTask(task);
  store.event(
    'pages_changed',
    task.id,
    null,
    task.pages.length
      ? `The director changed this story's pages to check: ${task.pages.map(page => `${page.name} (${page.path})`).join(', ')}. The next check captures them.`
      : "The director removed this story's pages; its next candidate is not captured.",
  );
  return task.pages;
}

// A project's visual check settings, checked: on or off, one to three widths, the themes, and an optional browser.
export function validateVisualSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings))
    throw failure('The visual check settings must be an object.');
  const problems = [];
  for (const key of Object.keys(settings))
    if (!['enabled', 'widths', 'themes', 'browser'].includes(key)) problems.push(`unknown field ${key}`);
  const { enabled = false, widths = defaultWidths, themes = visualThemes, browser = null } = settings;
  if (typeof enabled !== 'boolean') problems.push('enabled must be true or false');
  if (
    !Array.isArray(widths) ||
    !widths.length ||
    widths.length > 3 ||
    new Set(widths).size !== widths.length ||
    !widths.every(width => Number.isInteger(width) && width >= 320 && width <= 2560)
  )
    problems.push('widths must be one to three distinct widths from 320 to 2560 pixels');
  if (
    !Array.isArray(themes) ||
    !themes.length ||
    new Set(themes).size !== themes.length ||
    !themes.every(theme => visualThemes.includes(theme))
  )
    problems.push('themes must name light, dark or both');
  if (browser !== null && (typeof browser !== 'string' || browser.length > 400 || !path.isAbsolute(browser)))
    problems.push("the browser must be the absolute path of a Chromium-based browser's program");
  if (problems.length) throw failure(`The visual check settings are not valid: ${problems.join('; ')}.`);
  return { enabled, widths: [...widths], themes: [...themes], browser };
}

export function visualSettings(store, projectId) {
  const saved = store.project(projectId).visualCheck || {};
  return {
    enabled: !!saved.enabled,
    widths: saved.widths || defaultWidths,
    themes: saved.themes || visualThemes,
    browser: saved.browser || null,
  };
}
export function saveVisualSettings(store, projectId, data, runtime) {
  if (!projectSource(store, projectId, runtime).root)
    throw failure('The visual check needs a project on a git repository.');
  const project = store.project(projectId);
  project.visualCheck = validateVisualSettings(data);
  store.putProject(project);
  return visualView(store, projectId, runtime);
}

// The Chromium-based browser the check drives: the one the settings name, otherwise Edge or Chrome where they install.
export function findBrowser(
  chosen = null,
  { platform = process.platform, exists = fs.existsSync, environment = process.env } = {},
) {
  const programFiles = [environment['ProgramFiles(x86)'], environment.ProgramFiles, environment.LOCALAPPDATA].filter(
    Boolean,
  );
  const candidates = chosen
    ? [chosen]
    : platform === 'win32'
      ? programFiles.flatMap(folder => [
          path.join(folder, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          path.join(folder, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ])
      : platform === 'darwin'
        ? [
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
          ]
        : ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find(file => exists(file)) || null;
}

// What the dashboard reads: the settings, the browser found and whether the check can run here. A runtime may name the
// browser it found (`visualBrowser`, null for none) and whether its sandbox lets a port through.
export function visualView(store, projectId, runtime) {
  const settings = visualSettings(store, projectId),
    start = trySettings(store, projectId, runtime).start,
    browser = runtime && 'visualBrowser' in runtime ? runtime.visualBrowser : findBrowser(settings.browser),
    letsThrough = runtime?.tryLetsPortsThrough ?? sandboxLetsPortsThrough();
  return {
    settings,
    browser,
    note: browser ? null : browserNote,
    // Why the check would not run now, or null.
    blocked: !start
      ? 'Name a start command under Trying a story yourself: the check starts the candidate with it.'
      : !letsThrough
        ? "The built-in sandbox here keeps an app's port inside it, so the check cannot reach the candidate."
        : null,
  };
}

// Whether a story's candidate is captured, and with what; null when the check is off or the story names no pages.
// `notRun` is set when it applies but cannot run here.
export function visualPlan(store, task, runtime) {
  const projectId = recordProject(task),
    settings = visualSettings(store, projectId),
    pages = storyPages(store, task);
  if (!settings.enabled || !pages.length) return null;
  const view = visualView(store, projectId, runtime),
    tryIt = trySettings(store, projectId, runtime);
  return {
    pages,
    widths: settings.widths,
    themes: settings.themes,
    browser: view.browser,
    start: tryIt.start,
    address: tryIt.address,
    notRun: !view.browser ? 'no browser found' : view.blocked,
  };
}

// The record a check leaves when it could not run, which the reviewer and the story read.
export const notRunRecord = (plan, reason) => ({
  schemaVersion: 'visual-check-v1',
  state: 'not-run',
  reason,
  ...(reason === 'no browser found' ? { note: browserNote } : {}),
  pages: plan.pages,
  widths: plan.widths,
  themes: plan.themes,
  browser: plan.browser,
  images: [],
});

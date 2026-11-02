// What the redesigned Artifacts page reads from a project's work (artifacts.ts): each file's readable name, kind and
// one line, the All, Documents N and Images N filter with the idea and agent choices, the counts of files and
// versions, each version's why, the records line's words for each kind of project and a visual check's row, from the
// records alone; and the work as it reaches the stand-in controller. Model-free.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { getJSON, workUrl, type ProjectWork, type WorkFile, type WorkPictures, type WorkVersion } from './api';
import {
  kindLabel,
  kindTone,
  matchingWork,
  openWord,
  picturesLine,
  readableName,
  readsInPlace,
  recordsWords,
  versionCount,
  versionWhy,
  workChoices,
  workCount,
  workKind,
  workLine,
  workRows,
  workShowChoices,
  workShows,
  type ArtifactRecords,
} from './artifacts';
import { fakeController, shellFixture, type Controller } from './test-controller';
import { when } from './today';

// Noon on October 30 in the computer's own time, so a date reads the same wherever the test runs.
const now = new Date(2026, 9, 30, 12);
const version = (n: number, extra: Partial<WorkVersion> = {}): WorkVersion => ({
  n,
  attemptId: `attempt-${n}`,
  workerId: 'W-1',
  hash: `hash-${n}`,
  at: `2026-10-2${n}T12:00:00Z`,
  current: false,
  why: null,
  ...extra,
});
const work = (taskId: string, path: string, extra: Partial<WorkFile> = {}): WorkFile => ({
  taskId,
  title: `Story ${taskId}`,
  runId: null,
  path,
  kind: 'work-file',
  hash: `hash-${taskId}`,
  attemptId: `attempt-${taskId}`,
  workerId: 'W-1',
  acceptedAt: '2026-10-21T12:00:00Z',
  libraryEntryId: null,
  versions: [version(1, { attemptId: `attempt-${taskId}`, current: true })],
  ...extra,
});

// Eli and Ada are in the project and Sam only in the company's directory; the records hold the launch idea's run and
// name a finished idea; other runs' ideas are not loaded.
const records: ArtifactRecords = {
  workers: [...shellFixture().workers, { id: 'W-2', displayName: 'Ada' }],
  employeeDirectory: [{ id: 'W-9', displayName: 'Sam' }],
  runs: [{ id: 'run-launch', brief: 'Make the launch page' }],
  ideas: [{ id: 'run-pricing', brief: 'Plan the pricing table', taskIds: ['T-price'] }],
};
const files = [
  work('T-copy', 'copy/launch-page.md', {
    runId: 'run-launch',
    workerId: 'W-2',
    acceptedAt: '2026-10-23T12:00:00Z',
    versions: [
      version(3, { attemptId: 'attempt-T-copy', workerId: 'W-2', current: true, why: 'Shorten the opening.' }),
      version(2, { workerId: 'W-2', why: null }),
      version(1, { workerId: 'W-2' }),
    ],
  }),
  work('T-hero', 'art/hero_banner.png', { runId: 'run-launch', workerId: 'W-2' }),
  work('T-price', 'pricing-table.csv', { runId: 'run-pricing', workerId: 'W-9' }),
  work('T-notes', 'NOTES', { runId: 'run-unloaded', title: 'Write the release notes' }),
];

let controller: Controller;
beforeEach(() => {
  controller = fakeController();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

test('a file reads by the last part of its name, without its extension, hyphens and underscores as spaces', () => {
  expect(readableName('copy/launch-page.md')).toBe('Launch page');
  expect(readableName('launch-page.md')).toBe('Launch page');
  expect(readableName('art/sketches/hero_banner--wide.png')).toBe('Hero banner wide');
  expect(readableName('docs\\pricing_table.v2.csv')).toBe('Pricing table.v2');
  expect(readableName('NOTES')).toBe('NOTES');
  expect(readableName('plans/roadmap')).toBe('Roadmap');
  expect(readableName('.gitignore')).toBe('.gitignore');
});

test('a picture the dashboard shows is an Image and every other file a Document', () => {
  expect(['art/hero.png', 'logo.SVG', 'photo.jpeg', 'shot.jpg', 'still.webp', 'loop.gif'].map(workKind)).toEqual(
    Array(6).fill('Image'),
  );
  expect(['copy/launch-page.md', 'pricing.csv', 'layout.json', 'NOTES', 'scene.blend'].map(workKind)).toEqual(
    Array(5).fill('Document'),
  );
});

test.each([
  ['copy/launch.MD', 'MD'],
  ['docs\\brand.Markdown', 'MD'],
  ['art/hero.PNG', 'PNG'],
  ['pictures/shop.JPEG', 'JPG'],
  ['shop.jpg', 'JPG'],
  ['docs/reference.PdF', 'PDF'],
  ['data/prices.CsV', 'CSV'],
  ['data/layout.JSON', 'JSON'],
  ['notes.txt', 'TXT'],
  ['settings.yml', 'YAML'],
  ['settings.yaml', 'YAML'],
  ['logo.svg', 'SVG'],
  ['index.htm', 'HTML'],
  ['src/main.js', 'JS'],
  ['src/main.ts', 'TS'],
  ['src/view.tsx', 'TSX'],
  ['archive.zip', 'ZIP'],
  ['NOTES', 'FILE'],
  ['folder.with.dots/README', 'FILE'],
  ['folder.with.dots\\README', 'FILE'],
  ['.gitignore', 'FILE'],
  ['notes.', 'FILE'],
  ['', 'FILE'],
])('the kind label for %s reads %s', (path, label) => {
  expect(kindLabel(path)).toBe(label);
});

test.each([
  ['docs/brand.MARKDOWN', 'documents'],
  ['notes.txt', 'documents'],
  ['docs/brief.docx', 'documents'],
  ['art/logo.SVG', 'pictures'],
  ['art/photo.jpeg', 'pictures'],
  ['docs/reference.PDF', 'pdfs'],
  ['data/prices.csv', 'data'],
  ['settings.yaml', 'data'],
  ['data/prices.xlsx', 'data'],
  ['src/main.tsx', 'code'],
  ['index.html', 'code'],
  ['archive.zip', 'other'],
  ['unknown.kind', 'other'],
  ['NOTES', 'other'],
])('the tile for %s uses the %s family', (path, tone) => {
  expect(kindTone(path)).toBe(tone);
});

test.each([
  'copy/launch.md',
  'docs/Brand.MARKDOWN',
  'notes.txt',
  'data/prices.csv',
  'data/layout.json',
  'settings.yaml',
  'settings.YML',
  'data/feed.xml',
  'index.html',
  'styles.css',
  'src/main.js',
  'src/main.mjs',
  'src/main.ts',
  'src/view.tsx',
  'art/hero.png',
  'photo.jpg',
  'photo.JPEG',
  'art/logo.SVG',
  'art/still.webp',
  'art/loop.gif',
])('%s reads in place and offers Open', path => {
  expect(readsInPlace(path)).toBe(true);
  expect(openWord(path)).toBe('Open');
});

test.each([
  'docs/reference.pdf',
  'docs/brief.DOCX',
  'data/prices.xlsx',
  'slides.pptx',
  'archive.zip',
  'scene.blend',
  'unknown.kind',
  'photo.avif',
  'photo.bmp',
  'NOTES',
  'folder.md/README',
  'folder.png\\README',
  '.gitignore',
  'notes.',
  '',
])('%s needs Download instead of reading in place', path => {
  expect(readsInPlace(path)).toBe(false);
  expect(openWord(path)).toBe('Download');
});

test("each row reads its agent, its idea's words or its step's title, quoted, and its latest date", () => {
  const rows = workRows(files, records);
  expect(rows.map(row => [row.name, row.kind])).toEqual([
    ['Launch page', 'Document'],
    ['Hero banner', 'Image'],
    ['Pricing table', 'Document'],
    ['NOTES', 'Document'],
  ]);
  // The latest of its versions' dates and its acceptance.
  expect(rows[0]!.at).toBe('2026-10-23T12:00:00Z');
  expect(workLine(rows[0]!, now)).toBe(`Ada · “Make the launch page” · ${when('2026-10-23T12:00:00Z', now)}`);
  // A finished idea the records name, by an agent only the company's directory holds.
  expect(workLine(rows[2]!, now)).toBe(`Sam · “Plan the pricing table” · ${when('2026-10-21T12:00:00Z', now)}`);
  // An idea the records do not hold reads as its step's title.
  expect(workLine(rows[3]!, now)).toBe(`Eli · “Write the release notes” · ${when('2026-10-21T12:00:00Z', now)}`);
  expect(rows[3]!.idea).toEqual({ value: 'task:T-notes', label: '“Write the release notes”' });
  // A file with no date reads without one, and an agent not recorded as Unassigned.
  const undated = workRows([work('T-x', 'x.md', { workerId: null, acceptedAt: null, versions: [] })], records)[0]!;
  expect(undated.at).toBeNull();
  expect(workLine(undated, now)).toBe('Unassigned · “Story T-x”');
});

test('All, Documents and Images, any idea and any agent, and a chosen idea or agent narrow the rows', () => {
  const rows = workRows(files, records),
    names = (filter: Parameters<typeof matchingWork>[1]) => matchingWork(rows, filter).map(row => row.name);
  expect(workShows.map(show => show.label)).toEqual(['All', 'Documents', 'Images']);
  // The choice's words count the work's own files of each kind.
  expect(workShowChoices(rows)).toEqual([
    { value: 'all', label: 'All' },
    { value: 'documents', label: 'Documents 3' },
    { value: 'images', label: 'Images 1' },
  ]);
  expect(workShowChoices([]).map(show => show.label)).toEqual(['All', 'Documents 0', 'Images 0']);
  expect(names({})).toEqual(['Launch page', 'Hero banner', 'Pricing table', 'NOTES']);
  expect(names({ show: 'all' })).toEqual(['Launch page', 'Hero banner', 'Pricing table', 'NOTES']);
  expect(names({ show: 'documents' })).toEqual(['Launch page', 'Pricing table', 'NOTES']);
  expect(names({ show: 'images' })).toEqual(['Hero banner']);

  // Ideas newest first, as the work lists them, each once; agents by name; each list starts with its any choice.
  const ideas = workChoices(rows, 'idea'),
    agents = workChoices(rows, 'agent');
  expect(ideas).toEqual([
    { value: '', label: 'Any idea' },
    { value: 'run:run-launch', label: '“Make the launch page”' },
    { value: 'run:run-pricing', label: '“Plan the pricing table”' },
    { value: 'task:T-notes', label: '“Write the release notes”' },
  ]);
  expect(agents).toEqual([
    { value: '', label: 'Any agent' },
    { value: 'agent:W-2', label: 'Ada' },
    { value: 'agent:W-1', label: 'Eli' },
    { value: 'agent:W-9', label: 'Sam' },
  ]);
  expect(names({ idea: ideas[0]!.value, agent: agents[0]!.value })).toHaveLength(4);
  expect(names({ idea: 'run:run-launch' })).toEqual(['Launch page', 'Hero banner']);
  expect(names({ idea: 'task:T-notes' })).toEqual(['NOTES']);
  expect(names({ agent: 'agent:W-9' })).toEqual(['Pricing table']);
  expect(names({ idea: 'run:run-launch', show: 'documents' })).toEqual(['Launch page']);
  expect(names({ idea: 'run:run-launch', agent: 'agent:W-9' })).toEqual([]);
});

test('the work counts its files and versions, and a file made more than once its versions', () => {
  expect(workCount(files)).toBe('4 files · 6 versions');
  expect(workCount(files.slice(1, 2))).toBe('1 file · 1 version');
  expect(workCount([])).toBe('0 files · 0 versions');
  expect(versionCount(files[0]!)).toBe('3 versions');
  expect(versionCount(files[1]!)).toBeNull();
});

test('the first version reads as the first, and a later one in its recorded words or plainly without them', () => {
  const [third, second, first] = files[0]!.versions;
  expect(versionWhy(first!)).toBe('The first version');
  expect(versionWhy(third!)).toBe('Shorten the opening.');
  expect(versionWhy(second!)).toBe('Nothing was recorded about why it was made.');
});

test("the records line counts a project's records in its own words, and none has no line", () => {
  expect(recordsWords({ count: 17, kinds: { plan: 9, review: 8 } }, false)).toEqual({
    title: '17 records of how the work was done',
    detail:
      'The plans, reviews and check results stay on each idea and story, where they explain the work. They are never listed here.',
  });
  expect(recordsWords({ count: 653, kinds: { 'source-file': 653 } }, true)).toEqual({
    title: '653 records of how the stories were built',
    detail:
      "Reviews, test results, plans and the copies of changed files stay on each story's Changes, Checks and Activity. They are never listed here.",
  });
  expect(recordsWords({ count: 1, kinds: { plan: 1 } }, false)?.title).toBe('1 record of how the work was done');
  expect(recordsWords({ count: 1, kinds: { review: 1 } }, true)?.title).toBe('1 record of how the stories were built');
  expect(recordsWords({ count: 0, kinds: {} }, false)).toBeNull();
  expect(recordsWords({ count: 0, kinds: {} }, true)).toBeNull();
});

test("a visual check's row reads its story's title quoted, its date and how many pictures it took", () => {
  // Taken on October 28 wherever the test runs, two days before the test's now.
  const pictures: WorkPictures = {
    taskId: 'T-board',
    title: 'Board cards show their stage',
    runId: 'run-board',
    attemptId: 'attempt-candidate',
    at: new Date(2026, 9, 28, 15, 30).toISOString(),
    images: [1, 2, 3, 4].map(n => ({ path: `visual/0${n}-board.png`, hash: `hash-${n}` })),
  };
  expect(picturesLine(pictures, now)).toBe('The visual check · “Board cards show their stage” · Oct 28 · 4 pictures');
  expect(picturesLine({ ...pictures, images: pictures.images.slice(0, 1) }, now)).toBe(
    'The visual check · “Board cards show their stage” · Oct 28 · 1 picture',
  );
});

test('the stand-in controller answers the work with its projectWork, none by default', async () => {
  expect(await getJSON<ProjectWork>(workUrl('project-x'))).toEqual({
    work: [],
    pictures: [],
    records: { count: 0, kinds: {} },
  });
  controller.projectWork = {
    work: files,
    pictures: [],
    records: { count: 17, kinds: { plan: 9, review: 8 } },
  };
  expect(await getJSON<ProjectWork>(workUrl('project-x'))).toEqual(controller.projectWork);
  expect(workUrl('project x')).toBe('/api/projects/project%20x/work');
  expect(controller.reads()).toEqual(['/api/projects/project-x/work', '/api/projects/project-x/work']);
});

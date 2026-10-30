// The Artifacts page's listing (1.2 step 6): each accepted file with what its row says, newest first, and the idea,
// agent and kind filters, built from the listing's own values. And the model the redesigned page reads from what the
// project's work made.
import type { Live, ProjectArtifact, ProjectWork, Shell, WorkFile, WorkPictures, WorkVersion } from './api';
import { fileKind, imageFile } from './files';
import { workerName } from './names';
import { quoted, when } from './today';

// The records the page holds: the shell's agents, and the live set's runs and the ideas it names.
export type ArtifactRecords =
  | (Pick<Shell, 'workers' | 'employeeDirectory'> & Partial<Pick<Live, 'runs' | 'ideas'>>)
  | null;

export const facets = ['idea', 'agent', 'kind'] as const;
export type Facet = (typeof facets)[number];
// One value a filter can take: what it matches, and its words.
export interface Choice {
  value: string;
  label: string;
}
export interface ArtifactRow extends Record<Facet, Choice> {
  key: string;
  file: ProjectArtifact;
}
// The value each filter is set to; none set shows every file.
export type ArtifactFilter = Partial<Record<Facet, string>>;

// What a file is, as the dashboard's file lists say it; a kind they have no words for reads as itself.
export function kindOf(file: ProjectArtifact) {
  const words = fileKind(file);
  if (words !== 'File' || !file.kind) return words;
  const kind = file.kind.replace(/[-_]+/g, ' ').trim();
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

// The idea's words when the records hold its run, or a finished idea they name.
function ideaWords(records: ArtifactRecords, runId: string | null) {
  if (!runId) return null;
  const run = records?.runs?.find(item => item.id === runId),
    brief = typeof run?.brief === 'string' ? run.brief : records?.ideas?.find(idea => idea.id === runId)?.brief;
  return brief?.trim() ? quoted(brief, 60) : null;
}

// Every file newest first, each with its kind, its agent's name and its idea: the idea's words when the records hold
// its run, otherwise its story's title, so files whose idea is not loaded are told apart by their stories.
export function artifactRows(files: ProjectArtifact[], records: ArtifactRecords): ArtifactRow[] {
  return [...files]
    .sort((a, b) => (b.acceptedAt ?? '').localeCompare(a.acceptedAt ?? ''))
    .map(file => {
      const kind = kindOf(file),
        words = ideaWords(records, file.runId);
      return {
        key: `${file.attemptId}/${file.path}`,
        file,
        kind: { value: kind, label: kind },
        agent: { value: `agent:${file.workerId ?? ''}`, label: workerName(records, file.workerId) },
        idea: words
          ? { value: `run:${file.runId}`, label: words }
          : { value: `task:${file.taskId}`, label: file.title },
      };
    });
}

// A filter's choices, each value the listing holds once: ideas newest first, as the listing has them, and agents and
// kinds by name.
export function choices<F extends string>(rows: Record<F, Choice>[], facet: F): Choice[] {
  const seen = new Map<string, Choice>();
  for (const row of rows) if (!seen.has(row[facet].value)) seen.set(row[facet].value, row[facet]);
  const list = [...seen.values()];
  return facet === 'idea' ? list : list.sort((a, b) => a.label.localeCompare(b.label));
}

export const matching = (rows: ArtifactRow[], filter: ArtifactFilter) =>
  rows.filter(row => facets.every(facet => !filter[facet] || row[facet].value === filter[facet]));

// What the redesigned page reads from what the project's work made (GET …/work): each file's readable name, its kind,
// its one line and its versions' words, the filters, and the words for the records and the visual checks' pictures.
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

// A file's name as a person would say it: the last part of its path without its extension, hyphens and underscores
// as spaces, first letter capital (copy/launch-page.md reads Launch page). A name that is only an extension, such as
// .gitignore, reads as itself.
export function readableName(path: string) {
  const file = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path,
    stem = file.replace(/\.[^.]*$/, '') || file,
    words = stem.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim() || file;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// A file is an Image when it is one of the pictures the dashboard shows (files.tsx imageFile), otherwise a Document.
export type WorkKind = 'Document' | 'Image';
export const workKind = (path: string): WorkKind => (imageFile(path) ? 'Image' : 'Document');

// The page's filter: every file, the documents or the images, and any idea and any agent unless one is chosen.
export type WorkShow = 'all' | 'documents' | 'images';
export const workShows: { value: WorkShow; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'documents', label: 'Documents' },
  { value: 'images', label: 'Images' },
];
export interface WorkFilter {
  show?: WorkShow;
  idea?: string;
  agent?: string;
}

export interface WorkRow {
  key: string;
  file: WorkFile;
  name: string;
  kind: WorkKind;
  agent: Choice;
  idea: Choice;
  // The latest date the file was made or accepted.
  at: string | null;
}

// Each file as the work lists it, newest first: its readable name and kind, its agent's name, and its idea's words when
// the records hold its run, otherwise its step's title, both quoted.
export function workRows(files: WorkFile[], records: ArtifactRecords): WorkRow[] {
  return files.map(file => {
    const words = ideaWords(records, file.runId),
      dates = [file.acceptedAt, ...file.versions.map(version => version.at)].filter((at): at is string => !!at);
    return {
      key: `${file.attemptId}/${file.path}`,
      file,
      name: readableName(file.path),
      kind: workKind(file.path),
      agent: { value: `agent:${file.workerId ?? ''}`, label: workerName(records, file.workerId ?? undefined) },
      idea: words
        ? { value: `run:${file.runId}`, label: words }
        : { value: `task:${file.taskId}`, label: quoted(file.title, 60) },
      at: dates.sort().at(-1) ?? null,
    };
  });
}

// A row's one line: "Ada · “Make the launch page” · Oct 20".
export const workLine = (row: WorkRow, now = new Date()) =>
  [row.agent.label, row.idea.label, when(row.at, now)].filter(Boolean).join(' · ');

// The idea and agent choices, each starting with any idea or any agent, which matches every row.
export const workChoices = (rows: WorkRow[], facet: 'idea' | 'agent'): Choice[] => [
  { value: '', label: facet === 'idea' ? 'Any idea' : 'Any agent' },
  ...choices(rows, facet),
];

const showsKind: Record<WorkShow, WorkKind | null> = { all: null, documents: 'Document', images: 'Image' };
export function matchingWork(rows: WorkRow[], filter: WorkFilter) {
  const kind = showsKind[filter.show ?? 'all'];
  return rows.filter(
    row =>
      (!kind || row.kind === kind) &&
      (!filter.idea || row.idea.value === filter.idea) &&
      (!filter.agent || row.agent.value === filter.agent),
  );
}

// "3 files · 5 versions".
export function workCount(files: Pick<WorkFile, 'versions'>[]) {
  const versions = files.reduce((sum, file) => sum + file.versions.length, 0);
  return `${plural(files.length, 'file')} · ${plural(versions, 'version')}`;
}

// "3 versions" on a file made more than once; a file made once has no words for it.
export const versionCount = (file: Pick<WorkFile, 'versions'>) =>
  file.versions.length > 1 ? plural(file.versions.length, 'version') : null;

// Why a version was made: the first is the first version; a later one in the words the records hold, or plainly that
// none were recorded.
export const versionWhy = (version: Pick<WorkVersion, 'n' | 'why'>) =>
  version.n === 1 ? 'The first version' : version.why?.trim() || 'Nothing was recorded about why it was made.';

// The line under the work: how many records of how it was done there are and where they stay, in a code project's
// words or any other project's; none has no line.
export function recordsSentence(records: ProjectWork['records'], code: boolean) {
  if (!records.count) return null;
  return code
    ? `${plural(records.count, 'record')} of how the stories were built. Reviews, test results, plans and the copies of changed files stay on each story's Changes, Checks and Activity. They are never listed here.`
    : `${plural(records.count, 'record')} of how the work was done. The plans, reviews and check results stay on each idea and story, where they explain the work. They are never listed here.`;
}

// A code story's visual check as its row reads: "The visual check · “the story's title” · Oct 20 · 4 pictures".
export const picturesLine = (pictures: WorkPictures, now = new Date()) =>
  ['The visual check', quoted(pictures.title, 60), when(pictures.at, now), plural(pictures.images.length, 'picture')]
    .filter(Boolean)
    .join(' · ');

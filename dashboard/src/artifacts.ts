// The Artifacts page's listing (1.2 step 6): each accepted file with what its row says, newest first, and the idea,
// agent and kind filters, built from the listing's own values.
import type { Live, ProjectArtifact, Shell } from './api';
import { fileKind } from './files';
import { workerName } from './names';
import { quoted } from './today';

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
export function choices(rows: ArtifactRow[], facet: Facet): Choice[] {
  const seen = new Map<string, Choice>();
  for (const row of rows) if (!seen.has(row[facet].value)) seen.set(row[facet].value, row[facet]);
  const list = [...seen.values()];
  return facet === 'idea' ? list : list.sort((a, b) => a.label.localeCompare(b.label));
}

export const matching = (rows: ArtifactRow[], filter: ArtifactFilter) =>
  rows.filter(row => facets.every(facet => !filter[facet] || row[facet].value === filter[facet]));

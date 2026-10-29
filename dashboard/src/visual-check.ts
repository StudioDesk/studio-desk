// The visual check (1.2 step 8) as the dashboard reads it: the project's settings view and the director's save, a
// story's pages and the director's change to them, the candidate's recorded visual-check.json and the review's note on
// each image, and the words a page shows for them. The controller owns the settings, the pages and the capture
// (src/connectors/visual-check.mjs, story-pages.mjs); only the director's save sends anything.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getJSON,
  send,
  storyPagesUrl,
  visualUrl,
  type AttemptSummary,
  type StoryPage,
  type StoryPagesView,
  type StoryPageStep,
  type VisualCheckRecord,
  type VisualImage,
  type VisualNote,
  type VisualSettings,
  type VisualView,
} from './api';
import { readArtifact } from './source-story';

// Under the project, so a reload of the project's records reads them again too. A recorded file never changes, so it
// is kept by its attempt, path and recorded hash.
export const visualKeys = {
  view: (projectId: string) => [projectId, 'visual', 'view'] as const,
  pages: (projectId: string, taskId: string) => [projectId, 'visual', 'pages', taskId] as const,
  recorded: (projectId: string, attemptId: string, path: string, hash: string) =>
    [projectId, 'visual', 'recorded', attemptId, path, hash] as const,
};

export function useVisualView(projectId: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: visualKeys.view(projectId),
    queryFn: ({ signal }) => getJSON<VisualView>(visualUrl(projectId), signal),
  });
}

// Saves the project's settings, only the fields the controller takes; whether it saved them or refused them (with its
// message on the Refusal it rejects with), the view is read again before the answer is handed back.
export function useSaveVisual(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ enabled, widths, themes, browser }: VisualSettings) =>
      send<VisualView>(visualUrl(projectId), { projectId, enabled, widths, themes, browser }),
    onSettled: () => client.invalidateQueries({ queryKey: visualKeys.view(projectId) }),
  });
}

export function useStoryPages(projectId: string, taskId: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: visualKeys.pages(projectId, taskId),
    queryFn: ({ signal }) => getJSON<StoryPagesView>(storyPagesUrl(projectId, taskId), signal),
  });
}

// The director's pages for a story's next check; saved or refused (a closed or integrated story's pages no longer
// change), the story's pages view is read again before the answer is handed back.
export function useSavePages(projectId: string, taskId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (pages: StoryPage[]) =>
      send<{ pages: StoryPage[] }>(`/api/tasks/${encodeURIComponent(taskId)}/pages`, { projectId, pages }),
    onSettled: () => client.invalidateQueries({ queryKey: visualKeys.pages(projectId, taskId) }),
  });
}

// A small recorded JSON file, read once through the hash-checking artifact route and refused past its limit, and only
// when the attempt's artifacts list it.
const recordLimit = 512 * 1024;
function useRecordedJson<T, R>(
  projectId: string,
  attempt: AttemptSummary | null | undefined,
  path: string,
  select: (data: T) => R,
) {
  const item = attempt?.artifacts?.find(file => file.path === path);
  return useQuery({
    enabled: !!attempt && !!item,
    queryKey: visualKeys.recorded(projectId, attempt?.id ?? '', path, item?.hash ?? ''),
    queryFn: async ({ signal }) =>
      JSON.parse(await readArtifact(projectId, attempt!.id, path, recordLimit, signal)) as T,
    select,
    retry: false,
    staleTime: Infinity,
  });
}

const asRecord = (record: VisualCheckRecord) => record;
// The review's `visual` entries, none when its report has none; an entry the page could not show is left out.
function visualNotes(report: { visual?: unknown } | null): VisualNote[] {
  const visual = report?.visual;
  return Array.isArray(visual)
    ? visual.filter(
        (item): item is VisualNote =>
          !!item &&
          typeof item.image === 'string' &&
          typeof item.note === 'string' &&
          ['match', 'problem'].includes(item.verdict),
      )
    : [];
}

// What the candidate attempt captured, or why nothing was: its recorded visual-check.json.
export function useVisualRecord(projectId: string, attempt: AttemptSummary | null | undefined) {
  return useRecordedJson(projectId, attempt, 'visual-check.json', asRecord);
}

// What the review said of each image: its source-change-review.json's `visual` array.
export function useVisualNotes(projectId: string, reviewAttempt: AttemptSummary | null | undefined) {
  return useRecordedJson(projectId, reviewAttempt, 'source-change-review.json', visualNotes);
}

// An image's own name, from its path in the candidate (visual/01-board-1440-light.png) or its copy among a review's
// inputs (../inputs/T-1/12-01-board-1440-light.png): the controller's rule (story-pages.mjs imageFile), as each check
// names its images uniquely.
export const imageKey = (path: string) => (path.split(/[\\/]/).pop() ?? '').replace(/^\d+-(?=\d{2}-)/, '');

// Each image's note from the review, by the image's path; an image the review did not describe has none. Where the
// review describes one image twice, its first note is kept.
export function notesByImage(images: readonly Pick<VisualImage, 'path'>[], notes: readonly VisualNote[]) {
  const byKey = new Map<string, VisualNote>();
  for (const note of notes) if (!byKey.has(imageKey(note.image))) byKey.set(imageKey(note.image), note);
  const matched = new Map<string, VisualNote>();
  for (const image of images) {
    const note = byKey.get(imageKey(image.path));
    if (note) matched.set(image.path, note);
  }
  return matched;
}

// The record's images by page, in the order of its pages (a page with no image has none), then by width and theme as
// the record lists them. An image of a page the record does not list follows, under its own page.
export interface PageImages {
  name: string;
  path: string;
  images: VisualImage[];
}
export function imagesByPage(record: VisualCheckRecord): PageImages[] {
  const groups = new Map<string, PageImages>(
    record.pages.map(page => [page.name, { name: page.name, path: page.path, images: [] }]),
  );
  for (const image of record.images) {
    if (!groups.has(image.page)) groups.set(image.page, { name: image.page, path: image.pagePath, images: [] });
    groups.get(image.page)!.images.push(image);
  }
  const place = (list: readonly unknown[], item: unknown) => {
    const index = list.indexOf(item);
    return index < 0 ? list.length : index;
  };
  const order = (a: VisualImage, b: VisualImage) =>
    place(record.widths, a.width) - place(record.widths, b.width) ||
    a.width - b.width ||
    place(record.themes, a.theme) - place(record.themes, b.theme);
  return [...groups.values()].map(group => ({ ...group, images: [...group.images].sort(order) }));
}

// A width as the capture takes it: a phone under 600 px, as the capture's own mobile rule, otherwise a desktop.
export const widthLabel = (width: number) => `${width < 600 ? 'Phone' : 'Desktop'} · ${width} px`;

// The browser the check drives, by its program: Edge, Chrome and Chromium as they install, otherwise the file's name.
export function browserName(path: string) {
  const file = path.split(/[\\/]/).pop() ?? path,
    program = file.replace(/\.exe$/i, '').toLowerCase();
  if (/^(msedge|microsoft[- ]edge)(-stable)?$/.test(program)) return 'Microsoft Edge';
  if (/^(chrome|google[- ]chrome)(-stable)?$/.test(program)) return 'Google Chrome';
  if (/^chromium(-browser)?$/.test(program)) return 'Chromium';
  return file;
}

// A step in words.
export function stepText(step: StoryPageStep) {
  if ('click' in step) return `Click “${step.click}”`;
  if ('type' in step) return `Type “${step.type}” into “${step.into}”`;
  return `Wait for “${step.wait}”`;
}

// The check applied but could not run because this computer has no browser it can drive.
export const noBrowser = (record: VisualCheckRecord | null | undefined) =>
  record?.state === 'not-run' && record.reason === 'no browser found';

// Whether a story shows its Pages tab: it names pages, its candidate recorded a check, or the project's check is on and
// its pages may still change, so the director can name some.
export function pagesTabShown({
  pagesView,
  visualView,
  record,
}: {
  pagesView: StoryPagesView | null | undefined;
  visualView: VisualView | null | undefined;
  record: VisualCheckRecord | null | undefined;
}) {
  return !!pagesView?.pages.length || !!record || (!!visualView?.settings.enabled && !!pagesView?.editable);
}

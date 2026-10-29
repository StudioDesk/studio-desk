// Trying a story yourself (1.2 step 7) as the dashboard reads it: the project's try view and its Run's output, the
// director's Try it, Run, Stop and Open folder, when a story offers Try it and what the try copy holds for a story.
// The controller owns the copy and its Run (src/connectors/try-copy.mjs); only the director's click sends anything.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getJSON, getText, send, tryOutputUrl, tryUrl, type Task, type TryView } from './api';
import { isCodeProject } from './frame';
import { storyPeople } from './story';
import type { StudioState } from './studio-runs';

// Under the project, so a reload of the project's records reads them again too.
export const tryKeys = {
  view: (projectId: string) => [projectId, 'try', 'view'] as const,
  output: (projectId: string) => [projectId, 'try', 'output'] as const,
};

// A running app prints its address, and ends or is stopped, on its own: read again this often while it runs.
const runningRead = 2000;

export function useTryView(projectId: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: tryKeys.view(projectId),
    queryFn: ({ signal }) => getJSON<TryView>(tryUrl(projectId), signal),
    refetchInterval: query => (query.state.data?.copy?.run?.state === 'running' ? runningRead : false),
  });
}

// The copy's last Run's output, read while the copy has a Run: again while it runs, and once more when it ends. A new
// Run starts with no output of the last one on screen.
export function useTryOutput(projectId: string, enabled = true) {
  const run = useTryView(projectId, enabled).data?.copy?.run ?? null;
  return useQuery({
    enabled: enabled && !!run,
    queryKey: [...tryKeys.output(projectId), run?.id ?? null, run?.state ?? null] as const,
    queryFn: ({ signal }) => getText(tryOutputUrl(projectId), signal),
    refetchInterval: run?.state === 'running' ? runningRead : false,
    placeholderData: (previous, last) => (last?.queryKey[3] === run?.id ? previous : undefined),
  });
}

// What the director asks of the copy: Try it moves it to a story's candidate (discarding the director's own edits
// there only when asked), Run starts the start command (confirming once to run outside the sandbox when asked),
// Stop ends it and Open folder opens the copy's folder.
export type TryRequest =
  | { action: 'try'; taskId: string; discard?: boolean }
  | { action: 'run'; confirmOutside?: boolean }
  | { action: 'stop' }
  | { action: 'open' };

const requestPath = (projectId: string, request: TryRequest) =>
  request.action === 'try'
    ? `/api/tasks/${encodeURIComponent(request.taskId)}/try`
    : `${tryUrl(projectId)}/${request.action}`;
const requestBody = (projectId: string, request: TryRequest) => ({
  projectId,
  ...(request.action === 'try' && request.discard ? { discard: true } : {}),
  ...(request.action === 'run' && request.confirmOutside ? { confirmOutside: true } : {}),
});

// Sends one request; whether the controller did it or refused it (a refusal's fields are on the Refusal it rejects
// with), the try view is read again before the answer is handed back.
export function useTryAction(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: TryRequest) =>
      send<Record<string, unknown>>(requestPath(projectId, request), requestBody(projectId, request)),
    onSettled: () => client.invalidateQueries({ queryKey: tryKeys.view(projectId) }),
  });
}

// Whether the story offers Try it, as the controller's tryStory accepts it: a code story on a project with a
// repository whose current candidate is an accepted attempt that completed, its tests passed.
export function tryOffered(task: Task, studio: StudioState) {
  if (task.kind !== 'studio-development:change' || !isCodeProject(studio)) return false;
  const { candidate } = storyPeople(task, studio);
  return candidate?.status === 'accepted' && candidate.result?.outcome === 'completed';
}

// What the try copy means for one story: not tried while it holds another story or nothing, in the copy (merged onto
// its line, or as built with the files that conflicted) while nothing runs, or running, with the address once known.
export type Tried =
  | { state: 'not-tried' }
  | { state: 'in-copy'; merged: boolean; branch: string; conflicts: string[] }
  | { state: 'running'; address: string | null };

export function triedState(view: TryView | null | undefined, taskId: string): Tried {
  const copy = view?.copy;
  if (!copy || copy.taskId !== taskId) return { state: 'not-tried' };
  if (copy.run?.state === 'running' && copy.run.taskId === taskId)
    return { state: 'running', address: copy.run.address ?? null };
  return { state: 'in-copy', merged: copy.merged, branch: copy.branch, conflicts: copy.conflicts };
}

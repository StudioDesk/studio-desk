// Today's New idea box (the canvas's idea box on Today, v1.0 item 23): the idea and up to ten reference files,
// checked here as the controller checks them, then sent as one request to the project's intake, with Auto mode
// only when the director changed it from the Settings. On a phone the box rises as a sheet from New idea. The
// draft stays in memory for its project, so leaving Today and coming back keeps it; nothing is stored in the
// browser.
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { send, type Shell } from './api';
import { IdeaBox, type IdeaBoxFile } from './design/idea-box';
import { added, drafts, encoded, fileSize, wording, type Draft, type IdeaIntake } from './idea-composer';
import { newIdeaHandled, onNewIdea } from './new-idea';
import { useToast } from './toast';

const narrow = () => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 860px)').matches;

// The agent who plans an idea and the one who checks the work, by role, for the box's hint.
function crew(shell: Shell) {
  const named = (roles: string[]) =>
    shell.workers.find(
      worker => worker.enabled !== false && (worker as { roles?: string[] }).roles?.some(role => roles.includes(role)),
    )?.displayName;
  return { planner: named(['product-owner', 'planner']), reviewer: named(['reviewer']) };
}

export function TodayIdea({
  projectId,
  shell,
  intake,
  accent,
  suggestions,
}: {
  projectId: string;
  shell: Shell;
  intake: IdeaIntake;
  accent: string;
  // A sample project's suggested first ideas, until it has one (first-run-guide.tsx).
  suggestions?: string[];
}) {
  const [draft, setDraft] = useState<Draft>(() => drafts.get(projectId) ?? { idea: '', files: [], error: '' }),
    [auto, setAuto] = useState<boolean | undefined>(),
    [sheet, setSheet] = useState(false),
    dialog = useRef<HTMLDialogElement>(null),
    navigate = useNavigate(),
    toast = useToast(),
    autoDefault = !!shell.agentPermissions?.auto,
    { planner, reviewer } = crew(shell),
    name = shell.project.name;
  useEffect(() => {
    drafts.set(projectId, draft);
  }, [projectId, draft]);
  // New idea from the frame: the cursor goes in the box, or on a phone the box rises as a sheet.
  useEffect(
    () =>
      onNewIdea(() => {
        newIdeaHandled();
        if (narrow()) setSheet(true);
        else
          requestAnimationFrame(() => {
            const box = document.getElementById('idea-text');
            box?.scrollIntoView({ block: 'center' });
            box?.focus();
          });
      }),
    [],
  );
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (sheet && !element.open) {
      if (typeof element.showModal === 'function') element.showModal();
      else element.setAttribute('open', '');
      document.getElementById('idea-text-sheet')?.focus();
    }
    if (!sheet && element.open) {
      if (typeof element.close === 'function') element.close();
      else element.removeAttribute('open');
    }
  }, [sheet]);
  const submit = useMutation({
    mutationFn: async () => {
      const idea = draft.idea.trim();
      if (!idea || draft.idea.length > 4000) throw new Error('Idea must be nonempty text of at most 4000 characters.');
      const files = await Promise.all(draft.files.map(encoded));
      const result = await send<{ runId?: string }>('/api/intake', {
        projectId,
        idea,
        ...(files.length ? { files } : {}),
        // Only a changed setting is sent; otherwise the idea's work follows the Settings.
        ...(auto !== undefined && auto !== autoDefault ? { autoMode: auto } : {}),
      });
      if (!result.runId) throw new Error('Intake did not confirm a run. Your draft and files are retained.');
      return result.runId;
    },
    onSuccess: runId => {
      draft.files.forEach(item => item.url && URL.revokeObjectURL(item.url));
      const empty = { idea: '', files: [], error: '' };
      drafts.set(projectId, empty);
      setDraft(empty);
      setAuto(undefined);
      setSheet(false);
      toast(wording[intake].queued);
      void navigate({ to: '/p/$projectId/runs/$runId', params: { projectId, runId } });
    },
    onError: error => setDraft(current => ({ ...current, error: error.message })),
  });
  const busy = submit.isPending;
  const files: IdeaBoxFile[] = draft.files.map(item => ({
    key: item.id,
    name: item.file.name,
    kind: (item.file.name.match(/\.([^.]+)$/)?.[1] ?? '').slice(0, 4).toUpperCase(),
    size: fileSize(item.file.size),
    image: item.mediaType.startsWith('image/'),
  }));
  const box = (textId: string, frame: 'card' | 'flush') => (
    <IdeaBox
      textId={textId}
      label={`New idea for ${name}`}
      placeholder={`Say what you want in plain words.${planner && reviewer ? ` ${planner} plans it, the team builds it, ${reviewer} checks it.` : ''}`}
      accent={accent}
      frame={frame}
      text={draft.idea}
      onText={idea => setDraft(current => ({ ...current, idea, error: '' }))}
      files={files}
      onFiles={(incoming, pasted) => {
        if (busy) return;
        try {
          const additions = added(draft, incoming, pasted);
          for (const item of additions)
            if (item.mediaType.startsWith('image/')) item.url = URL.createObjectURL(item.file);
          setDraft({ ...draft, files: [...draft.files, ...additions], error: '' });
        } catch (error) {
          setDraft({ ...draft, error: (error as Error).message });
        }
      }}
      onRemove={key => {
        const item = draft.files.find(file => file.id === key);
        if (busy || !item) return;
        if (item.url) URL.revokeObjectURL(item.url);
        setDraft({ ...draft, files: draft.files.filter(file => file !== item), error: '' });
      }}
      error={draft.error}
      suggestions={suggestions}
      settings={[
        {
          kind: 'toggle',
          label: 'Auto mode',
          on: auto ?? autoDefault,
          hint: "Claude agents run this idea's work in auto mode: Claude Code's own classifier decides which commands they run.",
          onChange: setAuto,
        },
      ]}
      sendLabel={`Send to ${name}`}
      busy={busy}
      onSend={() => submit.mutate()}
    />
  );
  return (
    <>
      <div className="sd-wide-only">{box('idea-text', 'card')}</div>
      <dialog
        ref={dialog}
        className="sd-sheet"
        aria-label={`New idea for ${name}`}
        onClose={() => setSheet(false)}
        onClick={event => event.target === dialog.current && setSheet(false)}
      >
        {sheet && box('idea-text-sheet', 'flush')}
      </dialog>
    </>
  );
}

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
import { nextRelease, ReleaseChip, releaseChoices, useReleases, type ReleaseChoice } from './release-chip';
import { useToast } from './toast';

const narrow = () => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 860px)').matches;

// Where a new idea lands (1.1 step 6): the director's pick, otherwise the current working release, the lowest open
// milestone on the newest line. Neither its words nor the planner pick one (MP-032). Only the pick is sent; the
// controller decides the rest again when the idea arrives, so the chip says what it will do.
function useLandsIn(projectId: string, source: boolean) {
  const releases = useReleases(projectId, source),
    available = !!releases.data?.available,
    [picked, setPicked] = useState<ReleaseChoice | null>(null),
    next = nextRelease(releases.data?.milestones ?? []),
    auto: ReleaseChoice = {
      id: 'auto',
      version: 'The next release',
      line: null,
      note: next ? `${next.version}, or whichever is next when you send it` : 'No milestone is open',
    },
    choices = [...releaseChoices(releases.data), auto],
    shown = picked
      ? { version: picked.version, line: picked.line, reason: 'your pick' }
      : next
        ? { version: next.version, line: null, reason: 'next release' }
        : null;
  return {
    picked,
    reset: () => setPicked(null),
    chip: (busy: boolean) =>
      available && shown ? (
        <ReleaseChip
          projectId={projectId}
          label="Release for this idea"
          version={shown.version}
          line={shown.line}
          reason={shown.reason}
          choices={choices}
          current={picked?.id ?? 'auto'}
          onPick={choice => setPicked(choice.id === 'auto' ? null : choice)}
          busy={busy}
          footer="Only you pick a release. Without your pick, the idea goes to the next release; the planner can only suggest another."
        />
      ) : null,
  };
}

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
  const lands = useLandsIn(projectId, intake === 'source');
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
        // Only the director's pick is sent; otherwise the controller reads the words or takes the next release.
        ...(lands.picked ? { milestone: lands.picked.id } : {}),
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
      lands.reset();
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
      release={lands.chip(busy)}
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

// Today's New idea box (the canvas's idea box on Today, v1.0 item 23): the idea and up to ten reference files,
// checked here as the controller checks them, then sent as one request to the project's intake, with Auto mode
// only when the director changed it from the Settings and with the library entries the director left out. On a phone
// the box rises as a sheet from New idea. The draft stays in memory for its project, so leaving Today and coming back
// keeps it; nothing is stored in the browser. The chat box (chat-panel.tsx) holds the same box with a draft of its own.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState } from 'react';
import { getJSON, libraryUrl, send, type LibraryEntry, type LibraryIndex, type Shell } from './api';
import { Icon } from './design/icons';
import { IdeaBox, type IdeaBoxFile } from './design/idea-box';
import { added, drafts, encoded, fileSize, wording, type Draft, type IdeaIntake } from './idea-composer';
import { newIdeaHandled, onNewIdea } from './new-idea';
import { nextRelease, ReleaseChip, releaseChoices, useReleases, type ReleaseChoice } from './release-chip';
import { useLiveStream, useStreamReady } from './stream-context';
import { useToast } from './toast';

const narrow = () => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 860px)').matches;

// The chat box's own text, apart from Today's.
export const chatIdeaText = 'chat-idea-text';

// The project's idea intake in the controller's order (src/server.mjs /api/intake): source checks and a breakdown
// first, then the planner; without either there is no box.
export function ideaIntake(kinds: string[]): IdeaIntake | null {
  return kinds.includes('studio-development:breakdown') ? 'source' : kinds.includes('general:plan') ? 'plan' : null;
}

// Today's draft also holds the library entries the director leaves out of this idea's work (1.2 step 6).
type TodayDraft = Draft & { leftOut?: string[] };
const emptyDraft = (): TodayDraft => ({ idea: '', files: [], error: '' });

// The project's library entries that later work follows (1.2 step 6): every current one goes with a new idea's work
// unless the director leaves it out here. Read on each visit to Today, and again when the controller records a library
// event, since an entry added, revised or removed while Today is open changes what goes.
function useLibrary(projectId: string) {
  const stream = useLiveStream(),
    client = useQueryClient(),
    { data } = useQuery({
      enabled: useStreamReady(),
      queryKey: [projectId, 'library'],
      queryFn: ({ signal }) => getJSON<LibraryIndex>(libraryUrl(projectId), signal),
      refetchOnMount: 'always',
    });
  useEffect(
    () =>
      stream.subscribe({
        changes: message => {
          if (message.changes?.some(change => change.type === 'event' && change.kind?.startsWith('library_')))
            void client.invalidateQueries({ queryKey: [projectId, 'library'] });
        },
      }),
    [stream, client, projectId],
  );
  return (data?.entries ?? []).filter(entry => !entry.removedAt);
}

const going = (count: number) =>
  count === 0
    ? 'No library files go with this work'
    : count === 1
      ? '1 library file goes with this work'
      : `${count} library files go with this work`;

// The line in the box: how many of the library's current entries go with this idea's work, and Leave some out, which
// lists them by name and purpose with a checkbox each. An entry the director clears stays out of the idea's work from
// its first step.
function LibraryLine({
  entries,
  leftOut,
  onLeftOut,
  busy,
}: {
  entries: LibraryEntry[];
  leftOut: string[];
  onLeftOut: (leftOut: string[]) => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false),
    id = useId(),
    row = { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 'var(--space-8)' } as const;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-8)' }}>
      <div style={{ ...row, alignItems: 'center' }}>
        <Icon name="folder" size={16} />
        <span className="sd-meta">{going(entries.filter(entry => !leftOut.includes(entry.id)).length)}</span>
        <button type="button" className="sd-link" aria-expanded={open} disabled={busy} onClick={() => setOpen(!open)}>
          Leave some out
        </button>
      </div>
      {open && (
        <fieldset
          disabled={busy}
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-8)', margin: 0, padding: 0, border: 0 }}
        >
          <legend className="sd-meta" style={{ padding: 0, marginBottom: 'var(--space-8)' }}>
            Checked files go with this idea&apos;s work. Clear one to leave it out.
          </legend>
          {entries.map(entry => (
            <span key={entry.id} style={row}>
              <label style={{ ...row, fontWeight: 600 }}>
                <input
                  type="checkbox"
                  checked={!leftOut.includes(entry.id)}
                  aria-describedby={`${id}-${entry.id}`}
                  onChange={event =>
                    onLeftOut(event.target.checked ? leftOut.filter(item => item !== entry.id) : [...leftOut, entry.id])
                  }
                />
                {entry.name}
              </label>
              <span id={`${id}-${entry.id}`} className="sd-meta">
                {entry.purpose}
              </span>
            </span>
          ))}
        </fieldset>
      )}
    </div>
  );
}

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
  place = 'today',
}: {
  projectId: string;
  shell: Shell;
  intake: IdeaIntake;
  accent: string;
  // A sample project's suggested first ideas, until it has one (first-run-guide.tsx).
  suggestions?: string[];
  // Where the box is: on Today, where New idea finds it and a phone raises it as a sheet, or in the chat box, flush
  // in its panel with a draft of its own and no sheet.
  place?: 'today' | 'panel';
}) {
  const panel = place === 'panel',
    // The chat box's draft is kept apart from Today's, so neither box overwrites the other.
    key = panel ? `${projectId}#chat` : projectId;
  const [draft, setDraft] = useState<TodayDraft>(() => drafts.get(key) ?? emptyDraft()),
    [auto, setAuto] = useState<boolean | undefined>(),
    [sheet, setSheet] = useState(false),
    dialog = useRef<HTMLDialogElement>(null),
    navigate = useNavigate(),
    toast = useToast(),
    autoDefault = !!shell.agentPermissions?.auto,
    { planner, reviewer } = crew(shell),
    name = shell.project.name;
  useEffect(() => {
    drafts.set(key, draft);
  }, [key, draft]);
  // New idea from the frame: the cursor goes in the box, or on a phone the box rises as a sheet. The chat box's own
  // box leaves New idea to the frame, which opens the panel.
  useEffect(() => {
    if (panel) return;
    return onNewIdea(() => {
      newIdeaHandled();
      if (narrow()) setSheet(true);
      else
        requestAnimationFrame(() => {
          const box = document.getElementById('idea-text');
          box?.scrollIntoView({ block: 'center' });
          box?.focus();
        });
    });
  }, [panel]);
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
  const lands = useLandsIn(projectId, intake === 'source'),
    library = useLibrary(projectId),
    // Only entries still in the library are left out, so the line and the request agree.
    leftOut = (draft.leftOut ?? []).filter(id => library.some(entry => entry.id === id));
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
        // Only the entries the director left out are sent; otherwise every current entry goes with the work.
        ...(leftOut.length ? { libraryLeftOut: leftOut } : {}),
      });
      if (!result.runId) throw new Error('Intake did not confirm a run. Your draft and files are retained.');
      return result.runId;
    },
    onSuccess: runId => {
      draft.files.forEach(item => item.url && URL.revokeObjectURL(item.url));
      const empty = emptyDraft();
      drafts.set(key, empty);
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
      library={
        library.length > 0 && (
          <LibraryLine
            entries={library}
            leftOut={leftOut}
            onLeftOut={ids => setDraft(current => ({ ...current, leftOut: ids, error: '' }))}
            busy={busy}
          />
        )
      }
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
  if (panel) return box(chatIdeaText, 'flush');
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

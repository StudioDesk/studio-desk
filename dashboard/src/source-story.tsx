// A source story's change and files on the story page (v1.0 item 23; the current dashboard's sourceStoryDetails
// and its diff viewer): the change read one file at a time from its recorded evidence, the story's file changes,
// and editing the story's files. public/source-diff.js, shared with the current dashboard, checks the evidence's
// hashes and slices it; recorded evidence never changes, so it is read once per candidate.
import '../../public/source-diff.js';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { send, type AttemptSummary, type Task } from './api';
import { fileRequest, type Paths, type ScopeEdit } from './decisions';
import { artifactUrl } from './files';
import { workerName } from './names';
import type { StudioState } from './studio-runs';
import { useToast } from './toast';

interface Artifact {
  path: string;
  kind?: string;
  hash: string;
}
interface Identity {
  projectId: string;
  taskId: string;
  attemptId: string;
  candidateHash: string;
  manifest: Artifact;
  diff: Artifact;
}
type Selection =
  | { status: 'unavailable'; reason: string }
  | {
      status: 'available';
      key: string;
      identity: Identity;
      review: { state: string; verdict?: string };
      historical: boolean;
      artifacts: Artifact[];
    };
interface Range {
  id: string;
  newStart: number;
}
interface DiffFile {
  path: string;
  operation: string;
  added: number | null;
  removed: number | null;
  evidence?: string;
  reason?: string;
  ranges: Range[];
}
interface DiffModel {
  status: string;
  reason?: string;
  files: DiffFile[];
}
interface Row {
  kind: string;
  oldLine?: number | null;
  newLine?: number | null;
  text: string;
  noFinalNewline?: boolean;
  complete?: boolean;
  id?: string;
  count?: number | null;
  newStart?: number;
}
type Cursor = unknown;
type Slice = { status: 'available'; rows: Row[]; nextCursor: Cursor | null } | { status: string; reason: string };
interface SliceOptions {
  cursor?: Cursor;
  rowBudget: number;
  textByteBudget: number;
}
interface SourceDiffModule {
  limits: { diffBytes: number; manifestBytes: number; afterBytes: number };
  selectCandidate(task: Task, attempts: AttemptSummary[], options?: { selectedAttemptId?: string }): Selection;
  parseDiff(input: { selection: Selection; manifestText: string; diffText: string }): Promise<DiffModel>;
  registerAfterText(
    model: DiffModel,
    path: string,
    after: { key: string; artifact: string; text: string },
  ): Promise<DiffModel>;
  fileSlice(model: DiffModel, path: string, options: SliceOptions): Slice;
  rangeSlice(model: DiffModel, path: string, rangeId: string, options: SliceOptions): Slice;
}
const diffs = (globalThis as unknown as { StudioSourceDiff: SourceDiffModule }).StudioSourceDiff;
const sliceBudget = { rowBudget: 100, textByteBudget: 12 * 1024 };

// A recorded file, refused past its limit while it arrives, before it is decoded or parsed. The route checks the
// registered hash; the shared helper checks it again against this candidate.
export async function readArtifact(
  projectId: string,
  attemptId: string,
  path: string,
  limit: number,
  signal?: AbortSignal,
) {
  const response = await fetch(artifactUrl(projectId, attemptId, path), { signal });
  if (!response.ok) throw new Error(`Recorded artifact request refused (${response.status}).`);
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).length > limit) throw new Error('Recorded artifact exceeds its limit.');
    return text;
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0,
    text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('Recorded artifact exceeds its limit.');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
}
const read = (identity: Identity, artifact: Artifact, limit: number, signal?: AbortSignal) =>
  readArtifact(identity.projectId, identity.attemptId, artifact.path, limit, signal);

const reviewLabels: Record<string, string> = {
  reviewed: 'Read by the independent review',
  'review-in-progress': 'Supplied to a running review',
  'review-evidence-unavailable': 'The exact review evidence is unavailable',
};
const operations: Record<string, string> = { add: 'New file', create: 'New file', delete: 'Deleted' };

// The candidate's change (the Changes tab): its files, then the chosen file's diff a hundred rows a slice;
// unchanged lines load from the candidate's registered staged file when asked for.
export function SourceDiff({
  task,
  studio,
  selectedAttemptId,
}: {
  task: Task;
  studio: StudioState;
  selectedAttemptId?: string;
}) {
  const projectId = studio.project.id,
    selection = diffs.selectCandidate({ ...task, projectId }, studio.attempts, { selectedAttemptId }),
    available = selection.status === 'available' ? selection : null;
  const model = useQuery({
    enabled: !!available,
    // Not named under the project: a reload of the project's records never reads unchanging evidence again.
    queryKey: ['source-diff', available?.key ?? ''],
    queryFn: async ({ signal }) => {
      if (!available) throw new Error('No candidate.');
      const [manifestText, diffText] = await Promise.all([
        read(available.identity, available.identity.manifest, diffs.limits.manifestBytes, signal),
        read(available.identity, available.identity.diff, diffs.limits.diffBytes, signal),
      ]);
      const parsed = await diffs.parseDiff({ selection: available, manifestText, diffText });
      if (!['available', 'incomplete'].includes(parsed.status)) throw new Error(parsed.reason);
      return parsed;
    },
    retry: false,
  });
  // The chosen file, and whether it opens on its first change or (stepping back into it) its last.
  const [chosen, setChosen] = useState<{ index: number; from: 'first' | 'last' }>({ index: 0, from: 'first' }),
    // Side by side gives the change the panel's whole width, with the files as a choice above it.
    [split, setSplit] = useState(false);
  if (!available) {
    const attempt = studio.attempts.find(item => item.id === (selectedAttemptId ?? task.lastAttemptId));
    const downloads = (attempt?.artifacts ?? []).filter(item => item.kind === 'source-change-diff');
    return (
      <div className="sd-tabpanel">
        <p role="status" style={{ margin: 0, color: 'var(--ink-2)' }}>
          {selection.status === 'unavailable' ? selection.reason : ''} The recorded attempts and downloads hold its
          history.
        </p>
        {attempt &&
          downloads.map(item => (
            <a
              key={item.path}
              className="sd-btn sd-btn--sm"
              style={{ alignSelf: 'flex-start' }}
              href={artifactUrl(projectId, attempt.id, item.path)}
              download
            >
              Download {item.path}
            </a>
          ))}
      </div>
    );
  }
  const identity = available.identity,
    download = (
      <a
        className="sd-meta"
        style={{ padding: '8px 12px' }}
        href={artifactUrl(identity.projectId, identity.attemptId, identity.diff.path)}
        download
      >
        Download change.diff
      </a>
    );
  if (model.isPending)
    return (
      <div className="sd-tabpanel">
        <p role="status" className="sd-meta" style={{ margin: 0 }}>
          Reading the recorded change…
        </p>
      </div>
    );
  if (model.error)
    return (
      <div className="sd-tabpanel">
        <p role="status" style={{ margin: 0, color: 'var(--ink-2)' }}>
          The change could not be read here: {model.error.message} The original download is still there.
        </p>
        {download}
      </div>
    );
  const files = model.data.files,
    at = Math.min(chosen.index, files.length - 1),
    file = files[at];
  return (
    <div className="sd-tabpanel sd-tabpanel--split">
      {split ? (
        <div className="sd-field" style={{ flex: '1 1 100%' }}>
          <label className="sd-field__label" htmlFor="diff-file">
            File
          </label>
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-8)', alignItems: 'center' }}>
            <select
              id="diff-file"
              className="sd-select sd-mono"
              style={{ flex: '1 1 260px', width: 'auto', fontSize: '13px' }}
              value={at}
              onChange={event => setChosen({ index: Number(event.target.value), from: 'first' })}
            >
              {files.map((item, index) => (
                <option key={item.path} value={index}>
                  {item.path}
                  {item.added === null ? '' : `  +${item.added} −${item.removed}`}
                </option>
              ))}
            </select>
            {download}
          </span>
        </div>
      ) : (
        <div className="sd-filelist" style={{ flex: '1 1 220px', maxWidth: '280px', minWidth: 0 }}>
          {files.map((item, index) => {
            const changed = (item.added ?? 0) + (item.removed ?? 0),
              share = changed ? ((item.added ?? 0) / changed) * 100 : 100;
            return (
              <button
                key={item.path}
                type="button"
                className="sd-filelist__file"
                aria-current={item === file ? 'true' : undefined}
                onClick={() => setChosen({ index, from: 'first' })}
              >
                <span className="sd-mono" style={{ fontSize: '13px', fontWeight: 600, overflowWrap: 'anywhere' }}>
                  {item.path}
                </span>
                {item.added === null ? (
                  <span className="sd-meta">Line counts unavailable</span>
                ) : (
                  <span style={{ display: 'flex', gap: 'var(--space-8)', alignItems: 'center' }}>
                    <span className="sd-meta" aria-label={`${item.added} added, ${item.removed} removed`}>
                      <b style={{ color: 'var(--add)' }}>+{item.added}</b>{' '}
                      <b style={{ color: 'var(--del)' }}>−{item.removed}</b>
                    </span>
                    <span className="sd-bar sd-bar--thin" style={{ flex: 1 }} aria-hidden="true">
                      <span className="sd-bar__part sd-bar__part--ok" style={{ width: `${share}%` }}></span>
                      <span className="sd-bar__part sd-bar__part--bad" style={{ width: `${100 - share}%` }}></span>
                    </span>
                  </span>
                )}
              </button>
            );
          })}
          {download}
        </div>
      )}
      {file && (
        <div
          style={{ flex: '3 1 340px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-10)' }}
        >
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 'var(--space-8)',
              justifyContent: 'space-between',
            }}
          >
            <span className="sd-mono" style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
              {file.path}
            </span>
            <span style={{ display: 'flex', gap: 'var(--space-6)', flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="sd-segmented" role="group" aria-label="Layout">
                <button type="button" aria-pressed={!split} onClick={() => setSplit(false)}>
                  Unified
                </button>
                <button type="button" aria-pressed={split} onClick={() => setSplit(true)}>
                  Side by side
                </button>
              </span>
              {operations[file.operation] && <span className="sd-chip">{operations[file.operation]}</span>}
              {available.historical && <span className="sd-chip">An earlier candidate</span>}
              <span className="sd-chip sd-chip--outline">
                {reviewLabels[available.review.state] ?? 'Waiting for its review'}
              </span>
            </span>
          </div>
          <DiffFileView
            key={`${file.path}#${chosen.from}`}
            model={model.data}
            file={file}
            selection={available}
            from={chosen.from}
            split={split}
            onPrevious={at > 0 ? () => setChosen({ index: at - 1, from: 'last' }) : undefined}
            onNext={at < files.length - 1 ? () => setChosen({ index: at + 1, from: 'first' }) : undefined}
          />
        </div>
      )}
    </div>
  );
}

// A file's changes, as the canvas reads a diff: each run of changed lines with the unchanged lines around it, and
// the fold of unchanged lines after it. The rows are every part of the file's slices, read in memory.
function changesOf(model: DiffModel, path: string) {
  const rows: Row[] = [];
  let cursor: Cursor | undefined;
  for (let part = 0; part < 1000; part++) {
    const slice = diffs.fileSlice(model, path, { cursor, ...sliceBudget });
    if (slice.status !== 'available' || !('rows' in slice)) return null;
    rows.push(...slice.rows);
    if (!slice.nextCursor) break;
    cursor = slice.nextCursor;
  }
  const changes: { rows: Row[]; after?: Row }[] = [];
  for (const row of rows) {
    if (row.kind === 'omitted') {
      const last = changes.at(-1);
      if (last && !last.after) last.after = row;
    } else if (!changes.length || changes.at(-1)!.after) changes.push({ rows: [row] });
    else changes.at(-1)!.rows.push(row);
  }
  return changes;
}

function DiffFileView({
  model,
  file,
  selection,
  from,
  split,
  onPrevious,
  onNext,
}: {
  model: DiffModel;
  file: DiffFile;
  selection: Extract<Selection, { status: 'available' }>;
  from: 'first' | 'last';
  split: boolean;
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  const changes = changesOf(model, file.path),
    [change, setChange] = useState(() => (from === 'last' && changes ? Math.max(0, changes.length - 1) : 0)),
    [range, setRange] = useState<number | null>(null),
    [cursor, setCursor] = useState<Cursor | undefined>(undefined),
    [previous, setPrevious] = useState<Cursor[]>([]);
  // Unchanged lines come from the candidate's registered staged file, read once when first asked for.
  const context = useQuery({
    enabled: range !== null,
    queryKey: ['source-diff-context', selection.key, file.path],
    queryFn: async ({ signal }) => {
      const artifact = selection.artifacts.find(
        item => item.path === `changes/${file.path}` && item.kind === 'source-file',
      );
      if (!artifact) throw new Error('Registered staged context is unavailable.');
      const text = await read(selection.identity, artifact, diffs.limits.afterBytes, signal);
      const expanded = await diffs.registerAfterText(model, file.path, {
        key: selection.key,
        artifact: artifact.path,
        text,
      });
      if (!['available', 'incomplete'].includes(expanded.status)) throw new Error(expanded.reason);
      return expanded;
    },
    retry: false,
  });
  const go = (next: { range?: number | null; cursor?: Cursor }) => {
    if ('range' in next) setRange(next.range ?? null);
    setCursor(next.cursor);
    setPrevious([]);
  };
  if (file.evidence === 'incomplete')
    return (
      <p style={{ margin: 0, color: 'var(--ink-2)' }} role="status">
        {file.reason}
      </p>
    );
  const back = (
    <button type="button" className="sd-btn sd-btn--sm" onClick={() => go({ range: null })}>
      Back to the changed lines
    </button>
  );
  if (range !== null && context.isPending)
    return (
      <p role="status" className="sd-meta" style={{ margin: 0 }}>
        Reading the unchanged lines… {back}
      </p>
    );
  if (range !== null && context.error)
    return (
      <p role="status" style={{ margin: 0, color: 'var(--ink-2)' }}>
        The unchanged lines could not be read: {context.error.message} {back}
      </p>
    );
  if (range === null && changes?.length) {
    const shown = changes[Math.min(change, changes.length - 1)]!,
      numbers = shown.rows.map(row => row.newLine ?? row.oldLine).filter((line): line is number => line != null),
      after = shown.after;
    return (
      <>
        <div
          className={`sd-code${split ? ' sd-code--split' : ''}`}
          role="region"
          aria-label={`Diff of ${file.path}`}
          tabIndex={0}
        >
          <div className="sd-code__line sd-code__line--hunk">
            <span className="sd-code__num"></span>
            <span className="sd-code__num"></span>
            <span></span>
            <span>
              @@ lines {numbers[0]} to {numbers.at(-1)} · {change + 1} of {changes.length}{' '}
              {changes.length === 1 ? 'change' : 'changes'} in this file
            </span>
          </div>
          {split
            ? pairs(shown.rows).map(([left, right], index) => <SplitRow key={index} left={left} right={right} />)
            : shown.rows.map((row, index) => <DiffRow key={index} row={row} />)}
          {after && (
            <div className="sd-code__line sd-code__line--hunk">
              <span className="sd-code__num"></span>
              <span className="sd-code__num"></span>
              <span></span>
              <span>
                <button
                  type="button"
                  className="sd-code__more"
                  onClick={() => go({ range: file.ranges.findIndex(item => item.id === after.id) })}
                >
                  {after.count ?? 'More'} unchanged {after.count === 1 ? 'line' : 'lines'} · show
                </button>
              </span>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-8)', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="sd-btn sd-btn--sm"
            disabled={change === 0 && !onPrevious}
            onClick={() => (change > 0 ? setChange(change - 1) : onPrevious?.())}
          >
            Previous change
          </button>
          <button
            type="button"
            className="sd-btn sd-btn--sm"
            disabled={change >= changes.length - 1 && !onNext}
            onClick={() => (change < changes.length - 1 ? setChange(change + 1) : onNext?.())}
          >
            Next change
          </button>
        </div>
      </>
    );
  }
  const source = range !== null && context.data ? context.data : model,
    chosen = range !== null ? source.files.find(item => item.path === file.path)?.ranges[range] : undefined,
    slice = chosen
      ? diffs.rangeSlice(source, file.path, chosen.id, { cursor, ...sliceBudget })
      : diffs.fileSlice(source, file.path, { cursor, ...sliceBudget });
  if (slice.status !== 'available' || !('rows' in slice))
    return (
      <p style={{ margin: 0, color: 'var(--ink-2)' }}>
        {'reason' in slice ? slice.reason : ''} {range !== null && back}
      </p>
    );
  const paged = cursor !== undefined || !!slice.nextCursor;
  return (
    <>
      {chosen && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-8)', alignItems: 'center' }}>
          <span className="sd-meta">Unchanged lines from line {chosen.newStart}.</span>
          {back}
        </div>
      )}
      <div className="sd-code" role="region" aria-label={`Diff of ${file.path}`} tabIndex={0}>
        {slice.rows.map((row, index) =>
          row.kind === 'omitted' ? (
            <div key={index} className="sd-code__line sd-code__line--hunk">
              <span className="sd-code__num"></span>
              <span className="sd-code__num"></span>
              <span></span>
              <span>
                <button
                  type="button"
                  className="sd-code__more"
                  onClick={() => go({ range: file.ranges.findIndex(item => item.id === row.id) })}
                >
                  {row.count ?? 'More'} unchanged {row.count === 1 ? 'line' : 'lines'} from line {row.newStart} · show
                </button>
              </span>
            </div>
          ) : (
            <DiffRow key={index} row={row} />
          ),
        )}
      </div>
      {paged && (
        <div style={{ display: 'flex', gap: 'var(--space-8)', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="sd-btn sd-btn--sm"
            disabled={!previous.length}
            onClick={() => {
              setCursor(previous.at(-1));
              setPrevious(previous.slice(0, -1));
            }}
          >
            Previous part
          </button>
          <button
            type="button"
            className="sd-btn sd-btn--sm"
            disabled={!slice.nextCursor}
            onClick={() => {
              setPrevious([...previous, cursor].slice(-256));
              setCursor(slice.nextCursor ?? undefined);
            }}
          >
            Next part
          </button>
          <button
            type="button"
            className="sd-btn sd-btn--sm sd-btn--ghost"
            disabled={cursor === undefined}
            onClick={() => go({ cursor: undefined })}
          >
            Back to the start
          </button>
        </div>
      )}
    </>
  );
}

// Side by side: unchanged lines on both sides, and each run of removed lines beside the added lines after it.
function pairs(rows: Row[]) {
  const out: [Row | undefined, Row | undefined][] = [];
  for (let index = 0; index < rows.length; ) {
    const row = rows[index]!;
    if (row.kind !== 'added' && row.kind !== 'removed') {
      out.push([row, row]);
      index++;
      continue;
    }
    const removed: Row[] = [],
      added: Row[] = [];
    while (index < rows.length && rows[index]!.kind === 'removed') removed.push(rows[index++]!);
    while (index < rows.length && rows[index]!.kind === 'added') added.push(rows[index++]!);
    for (let line = 0; line < Math.max(removed.length, added.length); line++) out.push([removed[line], added[line]]);
  }
  return out;
}

function SplitRow({ left, right }: { left?: Row; right?: Row }) {
  const half = (row: Row | undefined) =>
    !row
      ? 'sd-code__half sd-code__half--none'
      : `sd-code__half${row.kind === 'removed' ? ' sd-code__half--del' : row.kind === 'added' ? ' sd-code__half--add' : ''}`;
  return (
    <div className="sd-code__line">
      <span className="sd-code__num">{left?.oldLine ?? ''}</span>
      <span className={half(left)} aria-label={left?.kind === 'removed' ? `removed: ${left.text}` : undefined}>
        {left?.text ?? ''}
      </span>
      <span className="sd-code__num">{right?.newLine ?? ''}</span>
      <span className={half(right)} aria-label={right?.kind === 'added' ? `added: ${right.text}` : undefined}>
        {right?.text ?? ''}
      </span>
    </div>
  );
}

function DiffRow({ row }: { row: Row }) {
  return (
    <div
      className={`sd-code__line${row.kind === 'added' ? ' sd-code__line--add' : row.kind === 'removed' ? ' sd-code__line--del' : ''}`}
    >
      <span className="sd-code__num">{row.oldLine ?? ''}</span>
      <span className="sd-code__num">{row.newLine ?? ''}</span>
      <span className="sd-code__sign">{row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ''}</span>
      <span>
        {row.text}
        {row.noFinalNewline && <span className="sd-code__cm"> No newline at the end of the file</span>}
        {row.complete === false && <span className="sd-code__cm"> continues in the next part</span>}
      </span>
    </div>
  );
}

const listed = (paths: Paths) =>
  [
    paths.files.length ? `Files: ${paths.files.join(', ')}` : '',
    paths.newFiles.length ? `New files: ${paths.newFiles.join(', ')}` : '',
    paths.deleteFiles.length ? `Delete: ${paths.deleteFiles.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

const returnable = (task: Task) => {
  const stage = task.sourceStage as { current?: string; review?: { verdict?: string; attemptId?: string } } | null;
  return (
    task.status === 'done' &&
    stage?.current === 'failed' &&
    stage.review?.verdict === 'needs-work' &&
    task.acceptedAttemptId === stage.review.attemptId
  );
};

// Whether the director may change the story's files now (the current dashboard's sourceStoryDetails).
export function filesEditable(task: Task, studio: StudioState) {
  const stage = task.sourceStage as { phase?: string; current?: string } | null | undefined,
    approval = task.approval as { status?: string } | undefined,
    review = studio.attempts.find(
      attempt => attempt.id === (task.sourceStage as { review?: { attemptId?: string } } | null)?.review?.attemptId,
    ),
    journal = review?.sourceIntegration;
  return (
    task.kind === 'studio-development:change' &&
    approval?.status === 'approved' &&
    !!task.proposalReference &&
    !task.closed &&
    task.status !== 'denied' &&
    stage?.current !== 'integrated' &&
    (!journal || ['rejected', 'abandoned'].includes(journal.state ?? '')) &&
    (returnable(task) ||
      (stage?.phase !== 'candidate-review' &&
        ['ready', 'blocked', 'failed', 'cancelled', 'review'].includes(task.status)))
  );
}

// The director's changes to the story's files, newest last, with who asked and who approved.
export function FileChanges({ task, studio }: { task: Task; studio: StudioState }) {
  const edits = (task.scopeEdits as ScopeEdit[] | undefined) ?? [],
    stage = task.sourceStage as { continueFrom?: { attemptId?: string } } | null | undefined;
  if (!edits.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <span className="sd-eyebrow">Changes to its files</span>
      {edits.map((edit, index) => {
        const who = [
          edit.request ? `asked for by ${workerName(studio, edit.request.workerId)} in ${edit.request.attemptId}` : '',
          edit.by?.type === 'policy' ? `approved by house rules (revision ${edit.by.revision})` : '',
        ]
          .filter(Boolean)
          .join('; ');
        return (
          <div key={index} className="sd-row">
            <span className="sd-row__text">
              <span>{edit.reason}</span>
              <span className="sd-meta">
                {new Date(edit.at).toLocaleString()}
                {who && ` · ${who}`}
              </span>
              <span className="sd-meta">{listed(edit)}</span>
            </span>
          </div>
        );
      })}
      {stage?.continueFrom && (
        <span className="sd-meta">
          The next attempt continues from the work staged in {stage.continueFrom.attemptId}.
        </span>
      )}
    </div>
  );
}

// Changing a story's files sends it back to implementation; a blocked editor's file request is offered as its
// paths plus the ones it named, and approving it records which attempt asked (MP-021).
export function StoryEdit({ projectId, task, studio }: { projectId: string; task: Task; studio: StudioState }) {
  const toast = useToast(),
    { requested, request, scope, offered, worked, editor } = fileRequest(task, studio);
  const [fields, setFields] = useState({
      files: offered.files.join('\n'),
      newFiles: offered.newFiles.join('\n'),
      deleteFiles: offered.deleteFiles.join('\n'),
      reason: request?.reason ?? '',
      keepWork: true,
    }),
    set = (name: keyof typeof fields) => (event: { target: { value: string; checked?: boolean } }) =>
      setFields({ ...fields, [name]: name === 'keepWork' ? !!event.target.checked : event.target.value });
  const lines = (text: string) =>
    text
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
  const save = useMutation({
    mutationFn: () =>
      send<{ start?: { ok?: boolean; reason?: string }; continueFrom?: { files: string[] } }>(
        `/api/tasks/${encodeURIComponent(task.id)}/edit-scope`,
        {
          projectId,
          files: lines(fields.files),
          newFiles: lines(fields.newFiles),
          deleteFiles: lines(fields.deleteFiles),
          reason: fields.reason.trim(),
          keepWork: worked && fields.keepWork,
          ...(request && requested ? { request: requested.id } : {}),
        },
      ),
    onSuccess: edited => {
      const kept = edited.continueFrom?.files.length
        ? ` It continues from ${edited.continueFrom.files.length} staged file${edited.continueFrom.files.length === 1 ? '' : 's'}.`
        : '';
      toast(
        edited.start?.ok === false
          ? `Changed ${task.id}'s files.${kept} It did not start: ${edited.start.reason}`
          : `Changed ${task.id}'s files and sent it back to implementation.${kept}`,
      );
    },
    onError: failure => toast(failure.message),
  });
  const area = (name: 'files' | 'newFiles' | 'deleteFiles', label: string) => (
    <div className="sd-field">
      <label className="sd-field__label" htmlFor={`story-${name}`}>
        {label}
      </label>
      <textarea
        id={`story-${name}`}
        className="sd-textarea sd-mono"
        style={{ minHeight: 0, fontSize: '13px' }}
        rows={Math.max(2, lines(fields[name]).length + 1)}
        value={fields[name]}
        onChange={set(name)}
      />
    </div>
  );
  return (
    <>
      {request ? (
        <p style={{ margin: 0, color: 'var(--ink-2)' }}>
          {editor} stopped because the change needs paths the story does not have: {listed(request)}. {editor}'s reason:{' '}
          {request.reason} The form below adds them to the story's files with that reason. Check both and save to
          approve them, or change them first.
        </p>
      ) : requested ? (
        <p style={{ margin: 0, color: 'var(--ink-2)' }}>
          {editor} named paths it needs, but the request could not be used: {scope?.problem} Edit the files yourself
          below.
        </p>
      ) : null}
      <details className="sd-disclosure" open={['blocked', 'failed', 'cancelled'].includes(task.status)}>
        <summary>Edit this story's files</summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-14)' }}>
          <p className="sd-meta" style={{ margin: 0 }}>
            One path per line, under the folders the project's stories may change. The controller checks them as it does
            when a story starts, records your reason and sends the story back to implementation.
          </p>
          {area('files', 'Files to edit')}
          {area('newFiles', 'Files to create')}
          {area('deleteFiles', 'Files to delete')}
          <div className="sd-field">
            <label className="sd-field__label" htmlFor="story-reason">
              Why the files change (the next attempt reads this)
            </label>
            <textarea
              id="story-reason"
              className="sd-textarea"
              placeholder="For example: test/autonomy.test.mjs asserts the old wording"
              value={fields.reason}
              onChange={set('reason')}
            />
          </div>
          {worked && (
            <label style={{ display: 'flex', gap: 'var(--space-8)', alignItems: 'center' }}>
              <input type="checkbox" checked={fields.keepWork} onChange={set('keepWork')} /> Continue from the last
              attempt's staged work
            </label>
          )}
          <button
            type="button"
            className="sd-btn sd-btn--primary"
            style={{ alignSelf: 'flex-start' }}
            disabled={save.isPending}
            onClick={() => {
              if (!fields.reason.trim()) return toast('Say why the files change; the next attempt reads it.');
              save.mutate();
            }}
          >
            {request
              ? 'Approve these files and send back to implementation'
              : 'Save files and send back to implementation'}
          </button>
        </div>
      </details>
    </>
  );
}

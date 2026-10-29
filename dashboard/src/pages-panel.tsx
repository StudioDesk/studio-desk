// A code story's Pages tab (1.2 step 8), read from its pages view and the project's visual check view
// (visual-check.ts): the pages its next check captures, each with its path and its steps in words, whether they were
// planned with the story or changed by the director, and while they may still change, Add a page and Edit. The
// controller checks and saves the pages (src/connectors/story-pages.mjs) for the next check; only the director's Save
// or Remove this page sends anything.
import { Link } from '@tanstack/react-router';
import { useId, useState } from 'react';
import type { StoryPage, StoryPageStep, Task } from './api';
import { Dialog } from './design/dialog';
import { storyPeople } from './story';
import type { StudioState } from './studio-runs';
import { useToast } from './toast';
import { stepText, useSavePages, useStoryPages, useVisualView } from './visual-check';

// The most pages a story names, and steps a page takes, as the controller checks them (story-pages.mjs).
const maxPages = 10,
  maxSteps = 10;

// Each kind of step by its name, what its text field asks for and an example of it.
type StepKind = 'click' | 'type' | 'wait';
const stepKinds: Record<StepKind, { name: string; text: string; example: string }> = {
  click: { name: 'Click a text', text: 'the text to click', example: 'A button, link, tab or label' },
  type: { name: 'Type into a field', text: 'the text to type', example: 'The text' },
  wait: { name: 'Wait for a text', text: 'the text to wait for', example: 'A text the page shows' },
};
// A step as the form edits it: its kind, its text and, to type into a field, the field's label. Switching kinds keeps
// what was written; only the kind's own fields are sent.
interface StepDraft {
  id: number;
  kind: StepKind;
  text: string;
  into: string;
}
const draftOf = (step: StoryPageStep, id: number): StepDraft =>
  'click' in step
    ? { id, kind: 'click', text: step.click, into: '' }
    : 'type' in step
      ? { id, kind: 'type', text: step.type, into: step.into }
      : { id, kind: 'wait', text: step.wait, into: '' };
const stepOf = ({ kind, text, into }: StepDraft): StoryPageStep =>
  kind === 'type' ? { type: text, into } : kind === 'click' ? { click: text } : { wait: text };

const savedMessage = 'Saved. The next check captures these pages.';
const noneMessage = 'Saved. This story names no pages now, so its next candidate is not captured.';

// The page the dialog edits, by its place in the list, or a new one for Add a page.
type Editing = { index: number; page: StoryPage } | { index: null; page: null };

export function PagesPanel({ projectId, task, studio }: { projectId: string; task: Task; studio: StudioState }) {
  const view = useStoryPages(projectId, task.id),
    visual = useVisualView(projectId).data,
    save = useSavePages(projectId, task.id),
    toast = useToast(),
    { reviewer } = storyPeople(task, studio),
    [editing, setEditing] = useState<Editing | null>(null);
  const close = () => {
    save.reset();
    setEditing(null);
  };
  // The whole list goes with each change; saved, the dialog closes and the list reads again, and refused, the
  // controller's message stays beside the edits.
  const send = (pages: StoryPage[]) =>
    save.mutate(pages, {
      onSuccess: () => {
        setEditing(null);
        toast(pages.length ? savedMessage : noneMessage);
      },
    });
  if (view.error)
    return (
      <div className="sd-tabpanel">
        <p role="alert" style={{ margin: 0 }}>
          The story&apos;s pages could not be read: {view.error.message}
        </p>
      </div>
    );
  if (!view.data)
    return (
      <div className="sd-tabpanel">
        <p role="status" className="sd-meta" style={{ margin: 0 }}>
          Reading the story&apos;s pages…
        </p>
      </div>
    );
  const { pages, changed, editable, reason } = view.data;
  return (
    <div className="sd-tabpanel">
      {visual && !visual.settings.enabled && (
        <p style={{ margin: 0, color: 'var(--ink-2)' }}>
          The project&apos;s visual check is off, so nothing is captured until it is on in{' '}
          <Link className="sd-link" to="/p/$projectId/settings" params={{ projectId }} hash="visual-check">
            Settings → Visual check
          </Link>
          .
        </p>
      )}
      <section aria-labelledby="story-pages-title" style={{ display: 'flex', flexDirection: 'column' }}>
        <span className="sd-eyebrow" id="story-pages-title" style={{ marginBottom: 'var(--space-4)' }}>
          This story&apos;s pages
        </span>
        {pages.length ? (
          <>
            <span className="sd-meta" style={{ paddingBottom: 'var(--space-8)' }}>
              {changed ? 'Changed by you' : 'Planned with the story'}. The next check captures each one after the
              candidate&apos;s tests pass, and {reviewer} describes every image before the story can pass review.
            </span>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {pages.map((page, index) => (
                <li key={`${index}-${page.name}`} className="sd-row">
                  <div
                    style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)', flex: 1, minWidth: 0 }}
                  >
                    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-8)', alignItems: 'center' }}>
                      <b>{page.name}</b>
                      <span className="sd-file sd-file--path">{page.path}</span>
                    </span>
                    {page.steps?.length ? (
                      <ol aria-label={`Steps on ${page.name}`} style={{ margin: 0, paddingLeft: '20px' }}>
                        {page.steps.map((step, at) => (
                          <li key={at} style={{ color: 'var(--ink-2)' }}>
                            {stepText(step)}
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <span className="sd-meta">No steps: captured as it opens.</span>
                    )}
                  </div>
                  {editable && (
                    <button
                      type="button"
                      className="sd-btn sd-btn--sm sd-btn--ghost"
                      aria-label={`Edit ${page.name}`}
                      onClick={() => setEditing({ index, page })}
                    >
                      Edit
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <span style={{ color: 'var(--ink-2)' }}>
            This story names no pages{changed ? ' since you removed them' : ''}, so its next candidate is not captured.
          </span>
        )}
        {!editable ? (
          <span className="sd-meta" style={{ paddingTop: 'var(--space-8)' }}>
            {reason ?? 'These pages can no longer change.'}
          </span>
        ) : (
          pages.length < maxPages && (
            <div style={{ paddingTop: 'var(--space-10)' }}>
              <button
                type="button"
                className="sd-btn sd-btn--sm"
                onClick={() => setEditing({ index: null, page: null })}
              >
                Add a page
              </button>
            </div>
          )
        )}
      </section>
      {/* The pages' images: what the candidate's check captured, by page, with the reviewer's notes (the
          pages-images story), go here, below This story's pages. */}
      <Dialog
        open={!!editing}
        label={editing?.page ? `Edit ${editing.page.name}` : 'Add a page'}
        size="wide"
        busy={save.isPending}
        onClose={close}
      >
        {editing && (
          <PageForm
            page={editing.page}
            busy={save.isPending}
            problem={save.error?.message}
            onSave={page =>
              send(
                editing.index === null
                  ? [...pages, page]
                  : pages.map((item, at) => (at === editing.index ? page : item)),
              )
            }
            onRemove={editing.index === null ? undefined : () => send(pages.filter((_, at) => at !== editing.index))}
            onClose={close}
          />
        )}
      </Dialog>
    </div>
  );
}

// Each opening starts from the page as the list holds it, or empty for a new page. Each step is one of its three
// kinds in its own row; what is written is sent as it is, so the controller says what is missing or too long. A
// refusal stays beside the edits, so none are lost.
function PageForm({
  page,
  busy,
  problem,
  onSave,
  onRemove,
  onClose,
}: {
  page: StoryPage | null;
  busy: boolean;
  problem?: string;
  onSave: (page: StoryPage) => void;
  onRemove?: () => void;
  onClose: () => void;
}) {
  const field = useId(),
    [name, setName] = useState(page?.name ?? ''),
    [path, setPath] = useState(page?.path ?? ''),
    [steps, setSteps] = useState<StepDraft[]>(() => (page?.steps ?? []).map(draftOf)),
    title = page ? `Edit ${page.name}` : 'Add a page';
  const change = (id: number, fields: Partial<StepDraft>) =>
    setSteps(current => current.map(step => (step.id === id ? { ...step, ...fields } : step)));
  return (
    <form
      className="sd-dialog__form"
      onSubmit={event => {
        event.preventDefault();
        onSave({ name: name.trim(), path: path.trim(), steps: steps.map(stepOf) });
      }}
    >
      <h2 className="sd-dialog__title">{title}</h2>
      <p style={{ margin: 0, color: 'var(--ink-2)' }}>
        For the story&apos;s next check: it opens the page on the app&apos;s own address, takes its steps in order, then
        captures it.
      </p>
      <div className="sd-field">
        <label className="sd-field__label" htmlFor={`${field}-name`}>
          Name
        </label>
        <input
          id={`${field}-name`}
          className="sd-input"
          placeholder="Such as Settings"
          value={name}
          maxLength={80}
          disabled={busy}
          onChange={event => setName(event.target.value)}
        />
      </div>
      <div className="sd-field">
        <label className="sd-field__label" htmlFor={`${field}-path`}>
          Path
        </label>
        <input
          id={`${field}-path`}
          className="sd-input sd-mono"
          placeholder="/settings"
          value={path}
          disabled={busy}
          aria-describedby={`${field}-path-note`}
          onChange={event => setPath(event.target.value)}
        />
        <span id={`${field}-path-note`} className="sd-meta">
          On the app&apos;s own address, starting with /, such as / for its first page.
        </span>
      </div>
      <div className="sd-field">
        <span className="sd-field__label">Steps</span>
        {steps.map((step, index) => {
          const label = `Step ${index + 1}`;
          return (
            <span
              key={step.id}
              style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-6)', alignItems: 'center' }}
            >
              <select
                className="sd-select"
                aria-label={label}
                value={step.kind}
                disabled={busy}
                style={{ flex: 'none', width: 'auto' }}
                onChange={event => change(step.id, { kind: event.target.value as StepKind })}
              >
                {(Object.keys(stepKinds) as StepKind[]).map(kind => (
                  <option key={kind} value={kind}>
                    {stepKinds[kind].name}
                  </option>
                ))}
              </select>
              <input
                className="sd-input"
                aria-label={`${label}: ${stepKinds[step.kind].text}`}
                placeholder={stepKinds[step.kind].example}
                value={step.text}
                disabled={busy}
                style={{ flex: '1 1 160px', width: 'auto' }}
                onChange={event => change(step.id, { text: event.target.value })}
              />
              {step.kind === 'type' && (
                <input
                  className="sd-input"
                  aria-label={`${label}: the field's label`}
                  placeholder="The field's label"
                  value={step.into}
                  disabled={busy}
                  style={{ flex: '1 1 160px', width: 'auto' }}
                  onChange={event => change(step.id, { into: event.target.value })}
                />
              )}
              <button
                type="button"
                className="sd-btn sd-btn--sm sd-btn--ghost"
                aria-label={`Remove step ${index + 1}`}
                disabled={busy}
                onClick={() => setSteps(current => current.filter(item => item.id !== step.id))}
              >
                Remove
              </button>
            </span>
          );
        })}
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-8)', alignItems: 'center' }}>
          <button
            type="button"
            className="sd-btn sd-btn--sm"
            disabled={busy || steps.length >= maxSteps}
            onClick={() =>
              setSteps(current => [
                ...current,
                { id: Math.max(-1, ...current.map(step => step.id)) + 1, kind: 'click', text: '', into: '' },
              ])
            }
          >
            Add a step
          </button>
          <span className="sd-meta">Optional: to reach the state to capture, taken in order; up to {maxSteps}.</span>
        </span>
      </div>
      {problem && (
        <p role="alert" style={{ margin: 0, color: 'var(--bad)', fontWeight: 600 }}>
          {problem}
        </p>
      )}
      <div className="sd-dialog__actions">
        {onRemove && (
          <button
            type="button"
            className="sd-btn sd-btn--danger"
            disabled={busy}
            style={{ marginRight: 'auto' }}
            onClick={onRemove}
          >
            Remove this page
          </button>
        )}
        <button type="button" className="sd-btn sd-btn--ghost" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="sd-btn sd-btn--primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

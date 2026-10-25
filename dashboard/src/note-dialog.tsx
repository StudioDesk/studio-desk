// A short question over the page (the design system's Dialog): the reason for integrating over a review, or a
// note sent with a decision. The controller records what is written with the step it asks for.
import { useId, useState } from 'react';
import { Dialog } from './design/dialog';

interface Question {
  title: string;
  text: string;
  label: string;
  submit: string;
  required?: boolean;
}

export function NoteDialog({
  open,
  onClose,
  onSubmit,
  ...question
}: Question & {
  open: boolean;
  onClose: () => void;
  onSubmit: (note: string) => void;
}) {
  return (
    <Dialog open={open} label={question.title} onClose={onClose}>
      <Note {...question} onClose={onClose} onSubmit={onSubmit} />
    </Dialog>
  );
}

// Each question starts empty: a note written for one decision never carries into the next.
function Note({
  title,
  text,
  label,
  submit,
  required = false,
  onClose,
  onSubmit,
}: Question & { onClose: () => void; onSubmit: (note: string) => void }) {
  const [note, setNote] = useState(''),
    field = useId();
  return (
    <form
      className="sd-dialog__form"
      onSubmit={event => {
        event.preventDefault();
        if (note.trim() || !required) onSubmit(note.trim());
      }}
    >
      <h2 className="sd-dialog__title">{title}</h2>
      <p style={{ margin: 0, color: 'var(--ink-2)' }}>{text}</p>
      <div className="sd-field">
        <label className="sd-field__label" htmlFor={field}>
          {label}
        </label>
        <textarea
          id={field}
          className="sd-textarea"
          value={note}
          maxLength={2000}
          onChange={event => setNote(event.target.value)}
        />
      </div>
      <div className="sd-dialog__actions">
        <button type="button" className="sd-btn sd-btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="sd-btn sd-btn--primary" disabled={required && !note.trim()}>
          {submit}
        </button>
      </div>
    </form>
  );
}

// Integrating over an independent review that asked for changes needs the director's reason.
export const overReview = (reviewer: string) => ({
  title: `Integrate over ${reviewer}'s review?`,
  text: "The change's tests must still pass, and the full suite runs again. Your reason is recorded with the integration and in its commit.",
  label: 'Why integrate it anyway',
  submit: 'Integrate over the review',
  required: true,
});

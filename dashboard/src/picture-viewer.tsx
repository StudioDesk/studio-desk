// A visual check's picture over the Pages tab (pages-panel.tsx), named by its page, width and theme: the picture full
// size in an area that scrolls however tall its page is, the review's mark and note beside it, and what went wrong as
// it was taken. Previous and Next, and the Left and Right arrow keys while it is open, step through that page's
// pictures in the tab's order, past any whose file was not saved; Escape or its × leaves. It reads only the picture,
// through the recorded-file route, and sends nothing.
import { useEffect } from 'react';
import type { AttemptSummary, VisualImage, VisualNote, VisualTheme } from './api';
import { Modal } from './dialog';
import { Preview } from './files';
import { widthLabel } from './visual-check';

const themeNames: Record<VisualTheme, string> = { light: 'Light', dark: 'Dark' };
// A picture by its width and theme, such as 'Desktop · 1440 px · Light'.
export const pictureLabel = (image: VisualImage) =>
  `${widthLabel(image.width)} · ${themeNames[image.theme] ?? image.theme}`;
// A recorded reason as the end of a sentence, with one full stop.
export const stop = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);
// The picture's file among the attempt's, if it was saved.
export const savedFile = (attempt: AttemptSummary, image: VisualImage) =>
  attempt.artifacts?.find(file => file.path === image.path);

// The review's mark on a picture: Match or Problem, or nothing before the review describes it.
export function ReviewMark({ note }: { note?: VisualNote }) {
  if (!note) return null;
  return (
    <span className={`sd-chip sd-chip--${note.verdict === 'match' ? 'ok' : 'bad'}`}>
      <span className="sd-chip__dot"></span>
      {note.verdict === 'match' ? 'Match' : 'Problem'}
    </span>
  );
}

// The review's note on a picture, or that it has none yet, and what went wrong as it was taken: a step that found
// nothing or a page that did not open, or a page too long to keep whole.
export function ShotLines({ image, note }: { image: VisualImage; note?: VisualNote }) {
  return (
    <>
      {note ? <span>{note.note}</span> : <span className="sd-meta">The review has not described this image yet.</span>}
      {image.problem && <span style={{ color: 'var(--bad)' }}>Taken with a problem: {stop(image.problem)}</span>}
      {image.trimmed && (
        <span className="sd-meta">
          Trimmed: the whole page made too large an image, so only its first screen was kept.
        </span>
      )}
    </>
  );
}

export function PictureViewer({
  projectId,
  attempt,
  page,
  pictures,
  index,
  notes,
  onShow,
  onClose,
}: {
  projectId: string;
  attempt: AttemptSummary;
  /** The page's name. */
  page: string;
  /** The page's pictures in the tab's order: its desktop row, then its phone row, each light then dark. */
  pictures: VisualImage[];
  /** The picture shown, by its place among the page's pictures, or null while the viewer is closed. */
  index: number | null;
  notes: Map<string, VisualNote>;
  onShow: (index: number) => void;
  onClose: () => void;
}) {
  const picture = index === null ? undefined : pictures[index],
    item = picture && savedFile(attempt, picture),
    // The pictures stepping reaches, by their places among the page's: those whose file was saved.
    saved = pictures.flatMap((image, at) => (savedFile(attempt, image) ? [at] : [])),
    place = index === null ? -1 : saved.indexOf(index),
    previous = place > 0 ? saved[place - 1] : undefined,
    next = place >= 0 ? saved[place + 1] : undefined;
  // The arrow keys step while the viewer is open, and stop at the first and last pictures.
  useEffect(() => {
    if (index === null) return;
    const step = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const to = event.key === 'ArrowLeft' ? previous : event.key === 'ArrowRight' ? next : undefined;
      if (to === undefined) return;
      event.preventDefault();
      onShow(to);
    };
    window.addEventListener('keydown', step);
    return () => window.removeEventListener('keydown', step);
  }, [index, previous, next, onShow]);
  return (
    <Modal open={!!picture} onClose={onClose} title={picture ? `${page} · ${pictureLabel(picture)}` : ''}>
      {picture && (
        <>
          <div className="sd-shotview">
            <div className="sd-shotview__picture">
              {item ? (
                <Preview projectId={projectId} attemptId={attempt.id} item={item} />
              ) : (
                <span className="sd-picture__pending">No image was saved.</span>
              )}
            </div>
            <div className="sd-shotview__note">
              <ReviewMark note={notes.get(picture.path)} />
              <ShotLines image={picture} note={notes.get(picture.path)} />
            </div>
          </div>
          <div className="sd-dialog__actions sd-shotview__steps">
            {place >= 0 && (
              <span className="sd-meta" style={{ marginRight: 'auto' }}>
                {place + 1} of {saved.length}
              </span>
            )}
            <button
              type="button"
              className="sd-btn sd-btn--sm"
              disabled={previous === undefined}
              onClick={() => previous !== undefined && onShow(previous)}
            >
              Previous
            </button>
            <button
              type="button"
              className="sd-btn sd-btn--sm"
              disabled={next === undefined}
              onClick={() => next !== undefined && onShow(next)}
            >
              Next
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

// Create a project's folder browser (1.0 step 4): the folders inside a folder on this computer, as the controller
// lists them (POST /api/folders). It starts at the start folder it is given, or the nearest existing folder above
// it, and at the controller's home folder without one or when the controller refuses it. The director opens a
// folder by its drive (shown when there are several), the trail, Up one level or the list, and chooses the folder
// shown. Each folder shown takes the keyboard focus to its first folder inside, or to its entry in the trail when
// it holds none. Browsing changes and records nothing.
import { useMutation } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { send, type FolderListing } from './api';
import { Icon } from './design/icons';

const list = (body: { path?: string; nearest?: boolean }) => send<FolderListing>('/api/folders', body);

export function FolderBrowser({
  start,
  onChoose,
  onCancel,
}: {
  start?: string;
  /** The folder shown, with the folders the controller listed in it. */
  onChoose: (path: string, listing: FolderListing) => void;
  onCancel: () => void;
}) {
  // The last folder the controller listed, which stays while another opens or is refused. One folder opens at a
  // time: the buttons stay as they are meanwhile, and a click on one is ignored.
  const [shown, setShown] = useState<FolderListing>();
  const opening = useRef(false),
    firstInside = useRef<HTMLButtonElement>(null),
    current = useRef<HTMLButtonElement>(null);
  const { mutate, isPending, error } = useMutation({
    // Without a path, the first folder: the start folder or the nearest existing one above it, and the home folder
    // without a start folder or when the controller refuses it.
    mutationFn: (path?: string) =>
      path !== undefined
        ? list({ path })
        : start === undefined
          ? list({})
          : list({ path: start, nearest: true }).catch(() => list({})),
    onSuccess: listing => setShown(listing),
    onSettled: () => {
      opening.current = false;
    },
  });
  const open = useCallback(
    (path?: string) => {
      if (opening.current) return;
      opening.current = true;
      mutate(path);
    },
    [mutate],
  );
  useEffect(() => open(undefined), [open]);
  // Each folder shown takes the focus; a refused one shows nothing new and leaves the focus where it was.
  useEffect(() => {
    if (shown) (firstInside.current ?? current.current)?.focus();
  }, [shown]);
  return (
    <section className="sd-folders" aria-label="Browse folders">
      {shown && shown.drives.length > 1 && (
        <div className="sd-folders__drives" role="group" aria-label="Drives">
          {shown.drives.map(drive => (
            <button type="button" className="sd-btn sd-btn--sm" key={drive} onClick={() => open(drive)}>
              {drive}
            </button>
          ))}
        </div>
      )}
      {shown && (
        <>
          <div className="sd-folders__where">
            <nav aria-label="Folder path">
              <ol className="sd-folders__trail">
                {shown.trail.map((step, index) => (
                  <li key={step.path}>
                    <button
                      type="button"
                      ref={index === shown.trail.length - 1 ? current : undefined}
                      aria-current={index === shown.trail.length - 1 ? 'location' : undefined}
                      onClick={() => open(step.path)}
                    >
                      {step.name}
                    </button>
                  </li>
                ))}
              </ol>
            </nav>
            <button
              type="button"
              className="sd-btn sd-btn--sm sd-btn--ghost sd-btn--icon"
              title="Up one level"
              disabled={shown.parent === null}
              onClick={() => shown.parent !== null && open(shown.parent)}
            >
              <Icon name="up" size={18} weight={2.2} />
              <span className="sd-sr">Up one level</span>
            </button>
          </div>
          {shown.folders.length ? (
            <ul className="sd-folders__list" aria-label="Folders inside">
              {shown.folders.map((folder, index) => (
                <li key={folder.path}>
                  <button type="button" ref={index === 0 ? firstInside : undefined} onClick={() => open(folder.path)}>
                    <span className="sd-folders__name">{folder.name}</span>
                    {folder.repository && (
                      <>
                        {' '}
                        <span className="sd-chip">git repository</span>
                      </>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="sd-meta" style={{ margin: 0 }}>
              There are no folders inside this one.
            </p>
          )}
          {shown.limited && (
            <p className="sd-meta" style={{ margin: 0 }}>
              Only some of the folders inside are listed. Type or paste the path of a folder that is not.
            </p>
          )}
        </>
      )}
      {isPending && (
        <p role="status" className="sd-meta" style={{ margin: 0 }}>
          Opening the folder…
        </p>
      )}
      {error && (
        <p role="alert" style={{ margin: 0, color: 'var(--bad)' }}>
          {error.message}
        </p>
      )}
      <div className="sd-folders__actions">
        {/* While a folder opens, the folder shown is about to change, so choosing waits for it. */}
        <button
          type="button"
          className="sd-btn sd-btn--sm sd-btn--primary"
          disabled={!shown}
          onClick={() => shown && !opening.current && onChoose(shown.path, shown)}
        >
          Choose folder
        </button>
        <button type="button" className="sd-btn sd-btn--sm sd-btn--ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}

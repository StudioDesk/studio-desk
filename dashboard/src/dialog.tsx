// A dialog over the page, the design system's Dialog with its title and × in a head: a browser opens it as a modal;
// a page without modal dialogs (the test DOM) shows it in place. Closing it by Escape or its × tells the page, which
// owns whether it is open. While the page says it may not close (closable false, for example while a command it
// waits for runs), its × is disabled and it stays open however often Escape is pressed: the key and the cancel event
// it sends are refused, and since a browser lets a second Escape close a dialog whose cancel was refused, a close the
// page did not ask for shows it again without telling the page.
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Icon } from './design/icons';

// Shows the dialog unless it is shown already.
const show = (element: HTMLDialogElement) => {
  if (element.open) return;
  if (typeof element.showModal === 'function') element.showModal();
  else element.setAttribute('open', '');
};

export function Modal({
  open,
  onClose,
  title,
  closable = true,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  closable?: boolean;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open) show(element);
    else if (element.open) {
      if (typeof element.close === 'function') element.close();
      else element.removeAttribute('open');
    }
  }, [open]);
  // Escape is held back wherever the focus is: a field disabled while the dialog may not close leaves it outside.
  useEffect(() => {
    if (!open || closable) return;
    const hold = (event: KeyboardEvent) => {
      if (event.key === 'Escape') event.preventDefault();
    };
    window.addEventListener('keydown', hold, true);
    return () => window.removeEventListener('keydown', hold, true);
  }, [open, closable]);
  return (
    <dialog
      ref={dialog}
      className="sd-dialog sd-dialog--wide"
      aria-labelledby={titleId}
      onCancel={event => {
        if (!closable) event.preventDefault();
      }}
      onClose={event => {
        if (open && !closable) show(event.currentTarget);
        else onClose();
      }}
    >
      {open && (
        <div className="sd-dialog__form">
          <div className="sd-dialog__head">
            <h2 id={titleId} className="sd-dialog__title">
              {title}
            </h2>
            <button
              type="button"
              className="sd-btn sd-btn--ghost sd-btn--icon"
              aria-label="Close"
              disabled={!closable}
              onClick={onClose}
            >
              <Icon name="close" />
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}

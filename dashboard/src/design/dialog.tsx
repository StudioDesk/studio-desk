// The design system's Dialog: one question or form over the page, in a native modal dialog named by its title.
// Its content is mounted only while it is open, so a form inside starts from the records each time it opens rather
// than from what was typed last time. While it is busy, Escape does not close it.
import { useEffect, useRef, type ReactNode } from 'react';

export function Dialog({
  open,
  label,
  size,
  busy,
  onClose,
  children,
}: {
  open: boolean;
  /** The title the content shows, which names the dialog. */
  label: string;
  size?: 'wide' | 'face';
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      if (typeof element.showModal === 'function') element.showModal();
      else element.setAttribute('open', '');
    }
    if (!open && element.open) {
      if (typeof element.close === 'function') element.close();
      else element.removeAttribute('open');
    }
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className={`sd-dialog${size ? ` sd-dialog--${size}` : ''}`}
      aria-label={label}
      onClose={onClose}
      onCancel={event => {
        if (busy) event.preventDefault();
      }}
    >
      {open && children}
    </dialog>
  );
}

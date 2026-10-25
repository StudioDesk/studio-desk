// The one box for everything the director writes to the studio (the design system's IdeaBox, v1.0 item 23): the
// label with the project's dot, optional recipients and a help line, the text, the attached files, optional
// suggestions, then a bar with Files, the settings and the send button. It holds no draft of its own: the page
// that uses it owns the text, files and settings, checks the files and sends.
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from 'react';
import { Icon } from './icons';

export interface IdeaBoxFile {
  key: string | number;
  name: string;
  // A short type for the tile ("PNG", "MD"); images get the image tile.
  kind: string;
  size: string;
  image?: boolean;
}
export type IdeaBoxSetting =
  | { kind: 'toggle'; label: string; on: boolean; hint?: string; onChange: (on: boolean) => void }
  | { kind: 'choice'; label: string; value: string; options: string[]; onChange: (value: string) => void };

export function IdeaBox({
  textId,
  label,
  help,
  placeholder,
  accent,
  frame = 'card',
  rows = 2,
  text,
  onText,
  files = [],
  onFiles,
  onRemove,
  error,
  recipients = [],
  to,
  onTo,
  suggestions = [],
  suggestionsLabel,
  settings = [],
  sendLabel,
  secondaryLabel,
  onSecondary,
  note,
  busy = false,
  onSend,
}: {
  textId: string;
  label: string;
  help?: ReactNode;
  placeholder?: string;
  accent: string;
  frame?: 'card' | 'flush';
  rows?: number;
  text: string;
  onText: (text: string) => void;
  files?: IdeaBoxFile[];
  onFiles?: (files: File[], pasted: boolean) => void;
  onRemove?: (key: IdeaBoxFile['key']) => void;
  error?: string;
  recipients?: string[];
  to?: string;
  onTo?: (name: string) => void;
  suggestions?: string[];
  suggestionsLabel?: string;
  settings?: IdeaBoxSetting[];
  sendLabel: string;
  secondaryLabel?: string;
  onSecondary?: () => void;
  note?: ReactNode;
  busy?: boolean;
  onSend: () => void;
}) {
  const field = useRef<HTMLTextAreaElement>(null),
    picker = useRef<HTMLInputElement>(null),
    [dragging, setDragging] = useState(false),
    empty = !text.trim(),
    blocked = empty || busy;
  // The box grows with the text, up to a height where it scrolls. Empty, it keeps its rows.
  useEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = 'auto';
    if (text) element.style.height = `${Math.min(element.scrollHeight, 480)}px`;
  }, [text]);
  const drop = (event: DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    setDragging(false);
    if (onFiles && event.dataTransfer.files.length) onFiles(Array.from(event.dataTransfer.files), false);
  };
  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = Array.from(event.clipboardData.files);
    if (!onFiles || !pasted.length) return;
    event.preventDefault();
    onFiles(pasted, true);
  };
  return (
    <form
      className={`sd-ideabox${frame === 'flush' ? ' sd-ideabox--flush' : ''}${dragging ? ' sd-ideabox--dragging' : ''}`}
      aria-label={label}
      onSubmit={event => {
        event.preventDefault();
        if (!blocked) onSend();
      }}
      onDragOver={event => {
        if (!onFiles) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={drop}
    >
      <div className="sd-ideabox__head">
        <label className="sd-ideabox__label" htmlFor={textId}>
          <span className="sd-ideabox__dot" style={{ background: accent }}></span>
          <span>{label}</span>
        </label>
        {recipients.length > 0 && (
          <div className="sd-ideabox__to" role="radiogroup" aria-label="Send to">
            <span className="sd-meta">To</span>
            {recipients.map(name => (
              <button
                key={name}
                type="button"
                role="radio"
                className="sd-ideabox__recipient"
                aria-checked={name === (to ?? recipients[0])}
                onClick={() => onTo?.(name)}
              >
                {name}
              </button>
            ))}
          </div>
        )}
      </div>
      {help && <span className="sd-ideabox__help">{help}</span>}
      <textarea
        ref={field}
        id={textId}
        className="sd-ideabox__text"
        rows={rows}
        placeholder={placeholder}
        value={text}
        maxLength={4000}
        disabled={busy}
        onChange={event => onText(event.target.value)}
        onPaste={paste}
        onKeyDown={event => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            if (!blocked) onSend();
          }
        }}
      />
      {files.length > 0 && (
        <ul className="sd-ideabox__files" aria-label="Attached files">
          {files.map(item => (
            <li key={item.key} className="sd-ideabox__file">
              <span
                className={`sd-ideabox__filetile${item.image ? ' sd-ideabox__filetile--image' : ''}`}
                aria-hidden="true"
              >
                {item.kind}
              </span>
              <span className="sd-ideabox__filename">
                <b>{item.name}</b>
                <span>{item.size}</span>
              </span>
              <button
                type="button"
                className="sd-ideabox__remove"
                aria-label={`Remove ${item.name}`}
                disabled={busy}
                onClick={() => onRemove?.(item.key)}
              >
                <Icon name="close" size={16} weight={2.2} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="sd-ideabox__error" role="alert">
          {error}
        </p>
      )}
      {suggestions.length > 0 && (
        <div className="sd-ideabox__suggestions">
          {suggestionsLabel && <span className="sd-meta">{suggestionsLabel}</span>}
          <div>
            {suggestions.map(suggestion => (
              <button
                key={suggestion}
                type="button"
                className="sd-ideabox__suggest"
                onClick={() => {
                  onText(suggestion);
                  field.current?.focus();
                }}
              >
                <Icon name="spark" size={16} />
                <span>{suggestion}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="sd-ideabox__bar">
        {onFiles && (
          <>
            <button type="button" className="sd-ideabox__tool" disabled={busy} onClick={() => picker.current?.click()}>
              <Icon name="clip" size={18} />
              Files
            </button>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              accept=".png,.jpg,.jpeg,.webp,.gif,.json,.md,.markdown,.txt,.csv"
              onChange={event => {
                if (event.target.files?.length) onFiles(Array.from(event.target.files), false);
                event.target.value = '';
              }}
            />
          </>
        )}
        {settings.map(setting =>
          setting.kind === 'toggle' ? (
            <button
              key={setting.label}
              type="button"
              role="switch"
              className="sd-ideabox__tool"
              aria-checked={setting.on}
              title={setting.hint}
              disabled={busy}
              onClick={() => setting.onChange(!setting.on)}
            >
              <span className="sd-switch" aria-hidden="true"></span>
              {setting.label}
            </button>
          ) : (
            <label key={setting.label} className="sd-ideabox__tool">
              {setting.label}
              <select value={setting.value} disabled={busy} onChange={event => setting.onChange(event.target.value)}>
                {setting.options.map(option => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            </label>
          ),
        )}
        <div className="sd-ideabox__send">
          {!empty && <span className="sd-meta">Ctrl + Enter</span>}
          {/* The second choice needs no text: Create the project only makes it without an idea. */}
          {secondaryLabel && onSecondary && (
            <button
              type="button"
              className="sd-btn sd-btn--ghost sd-ideabox__sendbtn"
              disabled={busy}
              onClick={onSecondary}
            >
              {secondaryLabel}
            </button>
          )}
          <button type="submit" className="sd-btn sd-btn--primary sd-ideabox__sendbtn" disabled={blocked}>
            <span>{sendLabel}</span>
            <Icon name="arrow" size={16} weight={2.4} />
          </button>
        </div>
      </div>
      {note && <span className="sd-meta">{note}</span>}
    </form>
  );
}

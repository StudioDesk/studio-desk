// Each page's heading with the way back. The frame around the pages is in frame.tsx.
import { Link } from '@tanstack/react-router';
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';

// A page's head, as the board's: the way back (each step a link, then this page), the title with a line about it,
// and its tools.
export function Heading({
  crumbs = [],
  here,
  title,
  lead,
  tools,
}: {
  crumbs?: ReactNode[];
  here?: string;
  title: ReactNode;
  lead?: ReactNode;
  tools?: ReactNode;
}) {
  return (
    <>
      {crumbs.length > 0 && (
        <nav className="sd-crumbs" aria-label="You are here">
          {crumbs.map((crumb, index) => (
            <span key={index} style={{ display: 'contents' }}>
              {/* A step back is never the current page, though the router would mark Settings on the pages under it. */}
              {isValidElement(crumb) && crumb.type === Link
                ? cloneElement(crumb as ReactElement<{ activeOptions?: object }>, { activeOptions: { exact: true } })
                : crumb}
              <span aria-hidden="true">/</span>
            </span>
          ))}
          {here && <span aria-current="page">{here}</span>}
        </nav>
      )}
      <header className="sd-boardhead">
        <div className="sd-boardhead__text">
          <h1 className="sd-boardhead__title">{title}</h1>
          {lead && <p>{lead}</p>}
        </div>
        {tools && <div className="sd-boardhead__tools">{tools}</div>}
      </header>
    </>
  );
}

// A setting that is on or off: the design system's switch, named for what it turns on.
export function Toggle({
  label,
  on,
  disabled,
  onChange,
}: {
  label: string;
  on: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      className="sd-toggle"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
    />
  );
}

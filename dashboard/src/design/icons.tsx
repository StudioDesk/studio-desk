// The interface's icons, from the design: inline 24-unit stroke icons with round caps and joins, colored by
// currentColor. Every one is decoration; the control beside or around it carries the words.
import type { ReactNode } from 'react';

const paths = {
  today: (
    <>
      <path d="M3 13h5l2 3h4l2-3h5" />
      <path d="M5.5 5h13l2.5 8v6H3v-6z" />
    </>
  ),
  ideas: (
    <>
      <path d="M9 18h6M10 21h4" />
      <path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z" />
    </>
  ),
  board: (
    <>
      <rect x="3" y="4" width="5" height="16" rx="1.5" />
      <rect x="10" y="4" width="5" height="11" rx="1.5" />
      <rect x="17" y="4" width="4" height="7" rx="1.5" />
    </>
  ),
  agents: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M15.5 14.2c3 .2 5.5 2.6 5.5 5.8" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </>
  ),
  updown: <path d="M8 9l4-4 4 4M8 15l4 4 4-4" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  // A suggestion's mark in the idea box.
  spark: <path d="M12 5v14M5 12h14" />,
  clip: (
    <path d="M20 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9" />
  ),
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  // Ready to integrate: a branch joining the main line.
  merge: (
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="12" r="2" />
      <path d="M6 7v10M6 7c0 3 3 5 10 5" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
    </>
  ),
  // A step done or a check passed.
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  // A note that does not block.
  note: <path d="M4 5h16v11H9l-5 4z" />,
  // A check left to someone else.
  dash: <path d="M7 12h10" />,
  back: <path d="M15 6l-6 6 6 6" />,
  // Up one level, in Create a project's folder browser.
  up: <path d="M14 9l-5-5-5 5M20 20h-7a4 4 0 0 1-4-4V4" />,
  // An idea's journey: building, and shipped.
  build: <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-2.5z" />,
  flag: <path d="M5 21V4h11l-1.5 4L16 12H5" />,
  // What happened: a pause, a start, a stop and tests running.
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  play: <path d="M7 4v16l13-8z" />,
  alert: <path d="M12 7v6M12 17h.01" />,
  test: <path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3" />,
  // A trace's steps: a command, a file read, an edit and a command the CLI refused.
  terminal: <path d="M5 7l5 5-5 5M12 18h7" />,
  file: (
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4M9 12h6M9 16h6" />
    </>
  ),
  pencil: <path d="M4 20l1-5L15.5 4.5a2.1 2.1 0 0 1 3 3L8 18zM13.5 6.5l3 3" />,
  blocked: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M6.5 6.5l11 11" />
    </>
  ),
  // A setting that reaches every project.
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" />
    </>
  ),
  // The first run's kinds of work: code, writing, and a project of your own.
  code: <path d="M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 4l-3 16" />,
  writing: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </>
  ),
  folder: (
    <>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M12 10v6M9 13h6" />
    </>
  ),
  trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 20, weight = 2 }: { name: IconName; size?: number; weight?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={weight}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

// The product's mark, drawn by the director (October 25): three bars on the brand tile whose outer corners make an S,
// two agents and the yellow handoff between them, in the same colors in both themes (Assets → Logo). The browser
// tab's icon is the same drawing (logo.svg).
export function Mark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 200 200" aria-hidden="true">
      <rect width="200" height="200" rx="30" fill="#5B45E0" />
      <path
        d="M50 58C50 46.9543 58.9543 38 70 38H132.5C142.165 38 150 45.835 150 55.5C150 65.165 142.165 73 132.5 73H55C52.2386 73 50 70.7614 50 68V58Z"
        fill="#fff"
      />
      <path
        d="M50 88C50 85.2386 52.2386 83 55 83H130C141.046 83 150 91.9543 150 103V113C150 115.761 147.761 118 145 118H70C58.9543 118 50 109.046 50 98V88Z"
        fill="#FFD23F"
      />
      <path
        d="M50 145.5C50 135.835 57.835 128 67.5 128H145C147.761 128 150 130.239 150 133V143C150 154.046 141.046 163 130 163H67.5C57.835 163 50 155.165 50 145.5Z"
        fill="#fff"
      />
    </svg>
  );
}

// The director's call: a clapperboard, in the same colors in both themes.
export function Clapper({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r="19" fill="#1D1B33" />
      <rect x="10.5" y="17" width="19" height="12" rx="2" fill="#fff" />
      <path d="M10.5 13.5l17.5-3.2.8 3.9-17.5 3.2z" fill="#FFD23F" />
      <path d="M14 11.8l2.2 3.2M19 10.9l2.2 3.2M24 10l2.2 3.2" stroke="#1D1B33" strokeWidth="1.6" />
    </svg>
  );
}

// A step the studio takes on its own (the house rules' Studio): a spark on the brand circle, in both themes.
export function StudioMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="11" fill="#5B45E0" />
      <path d="M12 5.5l1.6 4.9 4.9 1.6-4.9 1.6L12 18.5l-1.6-4.9L5.5 12l4.9-1.6z" fill="#fff" />
    </svg>
  );
}

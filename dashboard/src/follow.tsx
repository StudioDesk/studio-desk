// Following live content that grows at its bottom, the way a chat does: while the reader is at the newest, each
// update keeps it in view; a reader who scrolled up keeps their place, and New updates counts what arrived below
// until they press it or scroll back down. It follows a box that scrolls itself (the raw log) or the page, where it
// watches the end of the growing content. Only live content moves: a finished attempt holds still.
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './design/icons';

// How near the bottom, in CSS pixels, still counts as at the newest.
export const followSlack = 56;

// A box that scrolls itself, or the page, where the window scrolls.
export type FollowMode = 'box' | 'page';

// The ref for the box that scrolls, or in the page for the growing content. useFollow returns it apart from the
// rest, since React's lint takes an object with a part used as a ref for a ref, and the rest is read while rendering.
export type FollowAttach = (element: HTMLElement | null) => (() => void) | undefined;

export type Follow = {
  mode: FollowMode;
  // The updates that arrived since the reader scrolled up: none while following or once the content stops.
  waiting: number;
  // New updates: to the newest, following again.
  newest: () => void;
  // Once, as a view opens on running work after its content shows: jumps to the newest and follows.
  jump: () => void;
};

const reducedMotion = '(prefers-reduced-motion: reduce)';
// Scrolls glide, but jump where the reader asked for less motion or where matchMedia is missing.
const glide = (): ScrollBehavior =>
  typeof window.matchMedia === 'function' && !window.matchMedia(reducedMotion).matches ? 'smooth' : 'auto';

// How far the end of the content lies below the bottom of what the reader sees.
const below = (mode: FollowMode, element: HTMLElement) =>
  mode === 'box'
    ? element.scrollHeight - element.scrollTop - element.clientHeight
    : element.getBoundingClientRect().bottom - window.innerHeight;
// How far down the reader has scrolled.
const scrolled = (mode: FollowMode, element: HTMLElement) => (mode === 'box' ? element.scrollTop : window.scrollY);

// Brings the end of the content into view. It only ever scrolls down, so its own scrolling, a glide's steps
// included, never reads as the reader scrolling up.
function toEnd(mode: FollowMode, element: HTMLElement, behavior: ScrollBehavior) {
  const distance = below(mode, element);
  if (distance <= 0) return;
  if (mode === 'page') window.scrollTo({ top: window.scrollY + distance, behavior });
  else if (behavior === 'smooth' && typeof element.scrollTo === 'function')
    element.scrollTo({ top: element.scrollHeight, behavior });
  else element.scrollTop = element.scrollHeight;
}

// count only grows as updates arrive (a count, or the newest log line's seq); live is whether they still arrive. Use
// it as const [attach, follow] = useFollow(...), with ref={attach} and <NewUpdates follow={follow} />.
export function useFollow({
  mode,
  count,
  live,
}: {
  mode: FollowMode;
  count: number;
  live: boolean;
}): readonly [FollowAttach, Follow] {
  const node = useRef<HTMLElement | null>(null),
    following = useRef(true),
    // The count last shown, and where the reader was at the last scroll.
    shown = useRef(count),
    was = useRef(0),
    // The count when following stopped; null while following.
    [held, setHeld] = useState<number | null>(null);
  const attach = useCallback(
    (element: HTMLElement | null) => {
      node.current = element;
      if (!element) return;
      // A scroll up that leaves the bottom stops following; any scroll that reaches the bottom starts it again.
      const read = () => {
        const now = scrolled(mode, element),
          up = now < was.current;
        was.current = now;
        if (below(mode, element) <= followSlack) {
          following.current = true;
          setHeld(null);
        } else if (up && following.current) {
          following.current = false;
          setHeld(shown.current);
        }
      };
      was.current = scrolled(mode, element);
      following.current = below(mode, element) <= followSlack;
      setHeld(following.current ? null : shown.current);
      const target: EventTarget = mode === 'box' ? element : window;
      target.addEventListener('scroll', read, { passive: true });
      return () => {
        target.removeEventListener('scroll', read);
        node.current = null;
      };
    },
    [mode],
  );
  // Each update keeps the newest in view while following live content. Where a jump leaves the reader counts as
  // where they were, so the next scroll up from there is theirs.
  useLayoutEffect(() => {
    const grew = count > shown.current,
      element = node.current;
    shown.current = count;
    if (!grew || !live || !following.current || !element) return;
    toEnd(mode, element, glide());
    was.current = scrolled(mode, element);
  }, [count, live, mode]);
  const reach = useCallback(
    (behavior: ScrollBehavior) => {
      const element = node.current;
      if (!live) return;
      following.current = true;
      setHeld(null);
      if (!element) return;
      toEnd(mode, element, behavior);
      was.current = scrolled(mode, element);
    },
    [live, mode],
  );
  const newest = useCallback(() => reach(glide()), [reach]),
    jump = useCallback(() => reach('auto'), [reach]);
  return [attach, { mode, waiting: live && held !== null ? Math.max(0, count - held) : 0, newest, jump }] as const;
}

// New updates, shown while updates wait below a reader who scrolled up. Its name says how many, as "New updates: 3".
// In the page it floats near the bottom of the window; for a box, put it beside the box in a .sd-follow wrapper.
export function NewUpdates({ follow }: { follow: Follow }) {
  if (!follow.waiting) return null;
  return (
    <button
      type="button"
      className={`sd-newupdates sd-newupdates--${follow.mode}`}
      aria-label={`New updates: ${follow.waiting}`}
      onClick={follow.newest}
    >
      <Icon name="down" size={16} weight={2.4} />
      New updates
      <span className="sd-newupdates__count">{follow.waiting}</span>
    </button>
  );
}

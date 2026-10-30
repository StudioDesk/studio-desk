// The shared follower (follow.tsx), in a box that scrolls itself and in the page: live content stays at its newest
// while the reader is there, holds still with New updates and its count once they scroll up, and follows again from
// the button or when they scroll back down; scrolls glide unless reduced motion is set, a view opening on running
// work jumps once to its newest, and a finished view never moves. The scroll geometry is a stand-in: each update is
// a line 20px tall, the box shows ten lines, and in the page the content starts 100px down a 600px window. A smooth
// scroll only records what it asked for, as a browser would carry it out over the next frames, and the test moves
// the view through it; a jump moves the view at once. No browser lays out or scrolls anything.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from 'vitest';
import { followSlack, NewUpdates, useFollow, type FollowMode } from './follow';

const line = 20,
  boxHeight = 200,
  pageTop = 100,
  windowHeight = 600;

// The page's scroll, each box's scroll, and the stand-ins for scrolling that record what was asked of them.
let y = 0,
  tops = new WeakMap<Element, number>(),
  scrollTo: Mock<(options: ScrollToOptions) => void>,
  glide: Mock<(options: ScrollToOptions) => void>;
const restores: (() => void)[] = [];
function stub(target: object, name: string, descriptor: PropertyDescriptor) {
  const original = Object.getOwnPropertyDescriptor(target, name);
  Object.defineProperty(target, name, { configurable: true, ...descriptor });
  restores.push(() => {
    if (original) Object.defineProperty(target, name, original);
    else Reflect.deleteProperty(target, name);
  });
}
const isLog = (element: Element) => element.getAttribute('aria-label') === 'Log',
  log = () => screen.getByLabelText('Log'),
  height = (element: Element) => element.childElementCount * line,
  boxEnd = (element: Element) => Math.max(0, height(element) - boxHeight),
  // The page's scroll with the content's end at the window's bottom.
  pageEnd = () => Math.max(0, pageTop + height(log()) - windowHeight),
  place = (to: number) => {
    y = to;
    vi.stubGlobal('scrollY', to);
  };
const motion = (reduced: boolean) =>
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduced && query === '(prefers-reduced-motion: reduce)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));

beforeEach(() => {
  tops = new WeakMap();
  place(0);
  vi.stubGlobal('innerHeight', windowHeight);
  scrollTo = vi.fn((options: ScrollToOptions) => {
    if (options.behavior !== 'smooth') place(options.top ?? y);
  });
  vi.stubGlobal('scrollTo', scrollTo);
  glide = vi.fn<(options: ScrollToOptions) => void>();
  const rect = Element.prototype.getBoundingClientRect;
  stub(Element.prototype, 'getBoundingClientRect', {
    value(this: Element) {
      if (!isLog(this)) return rect.call(this);
      const top = pageTop - y,
        bottom = top + height(this);
      return { x: 0, y: top, top, bottom, left: 0, right: 0, width: 0, height: bottom - top, toJSON: () => ({}) };
    },
  });
  stub(Element.prototype, 'scrollHeight', {
    get(this: Element) {
      return isLog(this) ? height(this) : 0;
    },
  });
  stub(Element.prototype, 'clientHeight', {
    get(this: Element) {
      return isLog(this) ? boxHeight : 0;
    },
  });
  stub(Element.prototype, 'scrollTop', {
    get(this: Element) {
      return tops.get(this) ?? 0;
    },
    set(this: Element, value: number) {
      tops.set(this, Math.min(Math.max(0, value), boxEnd(this)));
    },
  });
  stub(Element.prototype, 'scrollTo', { value: glide, writable: true });
});
afterEach(() => {
  cleanup();
  for (const restore of restores.splice(0).reverse()) restore();
  vi.unstubAllGlobals();
});

// A live view: one line per update, the follower on its box or on the content in the page, and New updates. One
// that opens jumps to its newest as it first shows.
function Live({ mode, count, live, opens }: { mode: FollowMode; count: number; live: boolean; opens: boolean }) {
  const [attach, follow] = useFollow({ mode, count, live }),
    { jump } = follow;
  useEffect(() => {
    if (opens) jump();
  }, [opens, jump]);
  return (
    <div className={mode === 'box' ? 'sd-follow' : undefined}>
      <div ref={attach} aria-label="Log">
        {Array.from({ length: count }, (_, index) => (
          <p key={index}>Update {index + 1}</p>
        ))}
      </div>
      <NewUpdates follow={follow} />
    </div>
  );
}
function view(mode: FollowMode, count: number, { live = true, opens = false } = {}) {
  const shown = render(<Live mode={mode} count={count} live={live} opens={opens} />);
  return { grow: (to: number) => shown.rerender(<Live mode={mode} count={to} live={live} opens={opens} />) };
}

// Where the reader is, where the newest is, the reader scrolling, and what the last smooth scroll asked for.
const modes = {
  box: {
    at: () => log().scrollTop,
    end: () => boxEnd(log()),
    scroll: (to: number) => {
      tops.set(log(), to);
      fireEvent.scroll(log());
    },
    smooth: () => glide,
    target: () => height(log()),
  },
  page: {
    at: () => y,
    end: pageEnd,
    scroll: (to: number) => {
      place(to);
      fireEvent.scroll(window);
    },
    smooth: () => scrollTo,
    target: pageEnd,
  },
};
const button = () => screen.queryByRole('button', { name: /New updates/ });

describe.each(['box', 'page'] as const)('in a %s', mode => {
  const { at, end, scroll, smooth, target } = modes[mode];

  test('at the bottom, each update keeps the newest in view and no button shows', () => {
    const { grow } = view(mode, 10);
    grow(40);
    expect(end()).toBeGreaterThan(0);
    expect(at()).toBe(end());
    grow(41);
    expect(at()).toBe(end());
    expect(screen.queryByRole('button')).toBeNull();
  });

  test('a reader within the short distance of the bottom still follows', () => {
    const { grow } = view(mode, 10);
    grow(40);
    scroll(end() - followSlack);
    grow(42);
    expect(at()).toBe(end());
    expect(button()).toBeNull();
  });

  test('once the reader scrolls up past the short distance, updates hold still and New updates counts them', () => {
    const { grow } = view(mode, 10);
    grow(40);
    const reading = end() - followSlack - 1;
    scroll(reading);
    expect(button()).toBeNull();
    grow(41);
    expect(at()).toBe(reading);
    const first = screen.getByRole('button', { name: 'New updates: 1' });
    expect(first.getAttribute('type')).toBe('button');
    expect(first.textContent).toMatch(/^New updates\s*1$/);
    grow(42);
    grow(43);
    expect(at()).toBe(reading);
    expect(screen.getByRole('button', { name: 'New updates: 3' }).textContent).toMatch(/^New updates\s*3$/);
  });

  test('New updates goes to the newest, goes away, and the next update follows again', async () => {
    const { grow } = view(mode, 10);
    grow(40);
    scroll(end() - 200);
    grow(43);
    await userEvent.click(screen.getByRole('button', { name: 'New updates: 3' }));
    expect(at()).toBe(end());
    expect(button()).toBeNull();
    grow(44);
    expect(at()).toBe(end());
    expect(button()).toBeNull();
  });

  test('scrolling back to within the short distance of the bottom clears New updates and follows again', () => {
    const { grow } = view(mode, 10);
    grow(40);
    scroll(end() - 200);
    grow(42);
    screen.getByRole('button', { name: 'New updates: 2' });
    scroll(end() - followSlack);
    expect(button()).toBeNull();
    grow(43);
    expect(at()).toBe(end());
    // Scrolling up again counts afresh.
    scroll(end() - 200);
    grow(44);
    screen.getByRole('button', { name: 'New updates: 1' });
  });

  test('a finished view never moves and never shows New updates', () => {
    const { grow } = view(mode, 10, { live: false });
    grow(40);
    expect(at()).toBe(0);
    scroll(120);
    scroll(60);
    grow(45);
    expect(at()).toBe(60);
    expect(button()).toBeNull();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(glide).not.toHaveBeenCalled();
  });

  test('a view opening on running work jumps once to its newest; a finished one opens where it starts', () => {
    motion(false);
    const { grow } = view(mode, 40, { opens: true });
    expect(at()).toBe(end());
    expect(glide).not.toHaveBeenCalled();
    if (mode === 'page') expect(scrollTo.mock.calls).toEqual([[{ top: end(), behavior: 'auto' }]]);
    const reading = end() - 200;
    scroll(reading);
    grow(41);
    expect(at()).toBe(reading);
    screen.getByRole('button', { name: 'New updates: 1' });
    cleanup();
    scrollTo.mockClear();
    place(0);
    view(mode, 40, { live: false, opens: true });
    expect(at()).toBe(0);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  test('with reduced motion set, following and New updates jump', async () => {
    motion(true);
    const { grow } = view(mode, 10);
    grow(40);
    expect(at()).toBe(end());
    scroll(end() - 200);
    grow(42);
    await userEvent.click(screen.getByRole('button', { name: 'New updates: 2' }));
    expect(at()).toBe(end());
    expect(glide).not.toHaveBeenCalled();
    for (const [options] of scrollTo.mock.calls) expect(options.behavior).toBe('auto');
    if (mode === 'page') expect(scrollTo).toHaveBeenCalledTimes(2);
  });

  test('where matchMedia is missing, as here by default, scrolls jump', () => {
    const { grow } = view(mode, 10);
    grow(40);
    expect(at()).toBe(end());
    expect(glide).not.toHaveBeenCalled();
    if (mode === 'page') expect(scrollTo).toHaveBeenLastCalledWith({ top: end(), behavior: 'auto' });
  });

  test('without reduced motion, following and New updates glide', async () => {
    motion(false);
    const { grow } = view(mode, 10);
    grow(40);
    expect(smooth()).toHaveBeenLastCalledWith({ top: target(), behavior: 'smooth' });
    scroll(end());
    scroll(end() - 200);
    grow(42);
    smooth().mockClear();
    await userEvent.click(screen.getByRole('button', { name: 'New updates: 2' }));
    expect(smooth().mock.calls).toEqual([[{ top: target(), behavior: 'smooth' }]]);
    expect(button()).toBeNull();
  });

  test("the follower's own glide is not taken as the reader scrolling up", () => {
    motion(false);
    const { grow } = view(mode, 10);
    grow(40);
    // The glide's steps toward the newest, each still more than the short distance away.
    scroll(Math.round(end() * 0.3));
    scroll(Math.round(end() * 0.7));
    grow(41);
    expect(button()).toBeNull();
    expect(smooth()).toHaveBeenCalledTimes(2);
    expect(smooth()).toHaveBeenLastCalledWith({ top: target(), behavior: 'smooth' });
    // The reader scrolls up during the glide: following stops there.
    scroll(Math.round(end() * 0.5));
    grow(42);
    expect(smooth()).toHaveBeenCalledTimes(2);
    screen.getByRole('button', { name: 'New updates: 1' });
  });
});

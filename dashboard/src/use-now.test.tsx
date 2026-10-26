// The shared clock for running time: a tick each second while something runs, no timer while nothing does, and
// the current time at once when it turns on again. Faked timers and clock; no page and no controller.
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useNow } from './use-now';

const start = new Date('2026-10-26T12:00:00Z').getTime();
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(start);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const pass = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const clock = (first: boolean) => renderHook(({ on }: { on: boolean }) => useNow(on), { initialProps: { on: first } });

test('while on, the time moves on by a second after each second, not only each half minute', () => {
  const { result } = clock(true);
  expect(result.current).toBe(start);
  for (let second = 1; second <= 5; second++) {
    pass(1000);
    expect(result.current).toBe(start + second * 1000);
  }
  expect(vi.getTimerCount()).toBe(1);
});

test('while off, the time stands still and no timer is set', () => {
  const { result } = clock(false);
  expect(vi.getTimerCount()).toBe(0);
  pass(60000);
  expect(result.current).toBe(start);
  expect(vi.getTimerCount()).toBe(0);
});

test('turning the clock off leaves no timer behind', () => {
  const { result, rerender } = clock(true);
  pass(2000);
  rerender({ on: false });
  expect(vi.getTimerCount()).toBe(0);
  pass(5000);
  expect(result.current).toBe(start + 2000);
});

test('turning the clock on shows the current time at once, not the time from when it last ran', () => {
  const { result, rerender } = clock(true);
  pass(2000);
  rerender({ on: false });
  vi.setSystemTime(start + 47000);
  expect(result.current).toBe(start + 2000);
  rerender({ on: true });
  expect(result.current).toBe(start + 47000);
  pass(1000);
  expect(result.current).toBe(start + 48000);
});

test('a clock that starts off shows the current time at once when it turns on', () => {
  const { result, rerender } = clock(false);
  vi.setSystemTime(start + 90000);
  rerender({ on: true });
  expect(result.current).toBe(start + 90000);
});

test('the timer stops when the page using the clock goes away', () => {
  const { unmount } = clock(true);
  expect(vi.getTimerCount()).toBe(1);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

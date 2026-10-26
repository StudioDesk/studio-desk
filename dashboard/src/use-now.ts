// The clock for running time, a tick each second while something runs and no timer while nothing does. Turning
// it on reads the time at once, so a clock that was off never shows the time from when it last ran.
import { useState, useSyncExternalStore } from 'react';

// One page's clock: the time it last read, and a timer that reads it each second while the page watches.
function clock() {
  let now = Date.now();
  return {
    read: () => now,
    watch: (changed: () => void) => {
      now = Date.now();
      const timer = setInterval(() => {
        now = Date.now();
        changed();
      }, 1000);
      return () => clearInterval(timer);
    },
  };
}
const unwatched = () => () => {};

export function useNow(on: boolean) {
  const [{ read, watch }] = useState(clock);
  return useSyncExternalStore(on ? watch : unwatched, read);
}

// The clock for running time, a tick each half minute while something runs.
import { useEffect, useState } from 'react';

export function useNow(on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

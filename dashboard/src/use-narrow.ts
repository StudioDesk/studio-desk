// The phone layout (the design's 860px break), followed as the window changes.
import { useEffect, useState } from 'react';

const phoneQuery = '(max-width: 860px)';
export function useNarrow() {
  const [narrow, setNarrow] = useState(
    () => typeof window.matchMedia === 'function' && window.matchMedia(phoneQuery).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(phoneQuery),
      changed = () => setNarrow(query.matches);
    query.addEventListener?.('change', changed);
    return () => query.removeEventListener?.('change', changed);
  }, []);
  return narrow;
}

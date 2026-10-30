// The Agents page's layout for the window's width (agents-page.tsx), followed as the window changes: the flow and the
// editor side by side above 1200px; from 861px to 1200px, where the two no longer fit side by side next to the
// sidebar, the editor under the flow at full width; and at 860px and under, the phone's, the design's break that
// use-narrow.ts follows. The page's rules in design/bundle.css read the choice from its data-layout.
import { useEffect, useState } from 'react';

export type AgentsLayout = 'beside' | 'under' | 'phone';

export const phoneBreak = 860,
  underBreak = 1200,
  phoneQuery = '(max-width: 860px)',
  underQuery = '(max-width: 1200px)';

export function agentsLayout(width: number): AgentsLayout {
  return width <= phoneBreak ? 'phone' : width <= underBreak ? 'under' : 'beside';
}

// The phone's query first, so a window that matches only it is a phone.
const layoutOf = (phone: boolean, under: boolean): AgentsLayout => (phone ? 'phone' : under ? 'under' : 'beside');

export function useAgentsLayout() {
  const [layout, setLayout] = useState<AgentsLayout>(() =>
    typeof window.matchMedia === 'function'
      ? layoutOf(window.matchMedia(phoneQuery).matches, window.matchMedia(underQuery).matches)
      : 'beside',
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const phone = window.matchMedia(phoneQuery),
      under = window.matchMedia(underQuery),
      changed = () => setLayout(layoutOf(phone.matches, under.matches));
    phone.addEventListener?.('change', changed);
    under.addEventListener?.('change', changed);
    return () => {
      phone.removeEventListener?.('change', changed);
      under.removeEventListener?.('change', changed);
    };
  }, []);
  return layout;
}

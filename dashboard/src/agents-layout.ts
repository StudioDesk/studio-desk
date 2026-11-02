// The Agents page's layout for the window's width (agents-page.tsx), followed as the window changes: the flow and the
// editor side by side above 1200px; from 861px to 1200px, where the two no longer fit side by side next to the
// sidebar, the editor under the picked card at full width; and at 860px and under, the phone's, the design's break that
// use-narrow.ts follows. The page's rules in design/bundle.css read the choice from its data-layout.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

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

// Reparent one stable portal host instead of remounting the editor when the columns stack. The editor's local
// drafts, pending requests and expanded choices therefore belong to the selection, not to the window's width.
//
// A window whose layout changes keeps its place, whatever was picked. Otherwise, stacked, the picked editor comes into
// view under its card, as one the address names does when the page opens. Beside the flow, the page moves only when
// the flow's top is above the window, the page's head and buttons above it already out of view: a pick made after
// scrolling brings the flow back to the top, so the editor starts level with it, while a page that opens at its top
// stays there. Where the flow is tells the two apart, since a pick made from another of the Agents page's addresses
// opens the page afresh.
export function useAgentsEditor(layout: AgentsLayout, selection: string | undefined) {
  const [host] = useState(() => document.createElement('div')),
    [attached, setAttached] = useState(false),
    slot = useRef<HTMLDivElement | null>(null),
    flow = useRef<HTMLDivElement>(null),
    // The layout last seen, and whether the latest change of selection or layout changed the layout. A layout change
    // and the automatic pick it may bring commit together, so they read as one layout change.
    seen = useRef<AgentsLayout>(undefined),
    relaid = useRef(false);
  const place = useCallback(
    (node: HTMLDivElement | null) => {
      slot.current = node;
      if (node) {
        // Beside the flow the host is the column itself, next to a hidden React-owned anchor. This keeps each
        // editor directly inside its column (including Add an agent) without an extra layout wrapper.
        host.setAttribute('class', layout === 'beside' ? 'sd-agents__editor' : '');
        if (layout === 'beside') node.before(host);
        else node.append(host);
        // Mount children only after attachment, so initial focus works too.
        setAttached(true);
      } else host.remove();
    },
    [host, layout],
  );
  // Runs as the selection or layout changes, before the placement below, which may run a render later, once the host
  // is attached.
  useLayoutEffect(() => {
    relaid.current = seen.current !== undefined && seen.current !== layout;
    seen.current = layout;
  }, [layout, selection]);
  useLayoutEffect(() => {
    if (!attached || !selection || !slot.current) return;
    const beside = layout === 'beside',
      target = beside ? host : slot.current,
      // The sticky column's gap from the window's top, also the flow's scroll margin.
      inset = () => parseFloat(getComputedStyle(target).top) || 0;
    const fit = () => {
      const viewport = Math.min(window.innerHeight, window.visualViewport?.height ?? window.innerHeight);
      target.setAttribute(
        'data-sticky',
        String(beside && host.getBoundingClientRect().height <= viewport - 2 * inset()),
      );
    };
    fit();
    if (!relaid.current) {
      if (!beside) target.scrollIntoView?.({ block: 'start' });
      else if (flow.current && flow.current.getBoundingClientRect().top < inset())
        flow.current.scrollIntoView?.({ block: 'start' });
    }
    // The fit is measured again as the editor's content, the window or the visual viewport changes size.
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : undefined;
    observer?.observe(host);
    window.addEventListener('resize', fit);
    window.visualViewport?.addEventListener('resize', fit);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', fit);
      window.visualViewport?.removeEventListener('resize', fit);
      target.removeAttribute('data-sticky');
    };
  }, [attached, host, layout, selection]);
  return { host: attached ? host : null, place, flow };
}

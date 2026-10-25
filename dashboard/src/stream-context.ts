// The project's live stream as pages reach it: the stream itself, its connection for the sidebar, and whether
// pages may load yet. Pages load once the stream has said where the controller is, so every change after
// their reads reaches them and nothing needs reloading when the stream opens.
import { createContext, useContext, useSyncExternalStore } from 'react';
import type { LiveStream, StreamFactory } from './live';

export const StreamFactoryContext = createContext<StreamFactory>(url => new EventSource(url));
export const LiveContext = createContext<LiveStream | null>(null);

export function useLiveStream() {
  const stream = useContext(LiveContext);
  if (!stream) throw new Error('A live page must be inside its project.');
  return stream;
}

export function useConnection() {
  const stream = useLiveStream();
  return useSyncExternalStore(
    notify => stream.subscribe({ status: notify }),
    () => stream.status,
  );
}

// True once the stream has opened, or has failed to, so a page then shows the controller's own answer.
export function useStreamReady() {
  const stream = useLiveStream();
  return useSyncExternalStore(
    notify => stream.subscribe({ status: notify }),
    () => stream.started || stream.status === 'offline',
  );
}

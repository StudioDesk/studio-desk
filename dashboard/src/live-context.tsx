// A project's pages share one live stream, and each change refreshes only the records a page holds
// (records.ts).
import { useQueryClient } from '@tanstack/react-query';
import { useContext, useEffect, useState, type ReactNode } from 'react';
import { LiveStream } from './live';
import { RecordSync } from './records';
import { LiveContext, StreamFactoryContext } from './stream-context';

export function ProjectLive({ projectId, children }: { projectId: string; children: ReactNode }) {
  const queryClient = useQueryClient(),
    create = useContext(StreamFactoryContext),
    [stream] = useState(() => new LiveStream(projectId, create));
  useEffect(() => {
    const sync = new RecordSync(queryClient, projectId);
    const unsubscribe = stream.subscribe({ changes: message => void sync.apply(message) });
    stream.open();
    return () => {
      unsubscribe();
      stream.close();
    };
  }, [stream, queryClient, projectId]);
  return <LiveContext.Provider value={stream}>{children}</LiveContext.Provider>;
}

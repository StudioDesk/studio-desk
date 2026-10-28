// A project's pages share one live stream, and each change refreshes only the records a page holds
// (records.ts). A command's answer reaches the same records the moment it arrives, before the stream's change.
import { useQueryClient } from '@tanstack/react-query';
import { useContext, useEffect, useState, type ReactNode } from 'react';
import { onRecords } from './api';
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
    // Another project's answer changes nothing here (RecordSync.answer).
    const unheard = onRecords(records => void sync.answer(records));
    stream.open();
    return () => {
      unsubscribe();
      unheard();
      stream.close();
    };
  }, [stream, queryClient, projectId]);
  return <LiveContext.Provider value={stream}>{children}</LiveContext.Provider>;
}

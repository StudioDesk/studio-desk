// One event stream per project page (MP-026). Change events name the records that changed; a log watch
// streams one attempt's events while its activity is on screen. After a reconnect the stream asks the
// controller what it missed, and reloads what is shown when the controller cannot say.
import { changesUrl, eventsUrl, getJSON, type ChangeMessage, type LogEvent } from './api';

export interface LiveListener {
  changes?(message: ChangeMessage): void;
  log?(event: LogEvent): void;
  status?(status: StreamStatus): void;
}

export type StreamFactory = (url: string) => EventSource;
// The browser reconnects an event stream by itself; `offline` means it is trying.
export type StreamStatus = 'connecting' | 'live' | 'offline';

export class LiveStream {
  status: StreamStatus = 'connecting';
  // Whether the controller has said where it is, after which pages read and every change reaches them.
  started = false;
  private source: EventSource | null = null;
  private version = 0;
  private start = '';
  private watch: { attemptId: string; after: number } | null = null;
  private readonly listeners = new Set<LiveListener>();
  readonly projectId: string;
  private readonly create: StreamFactory;

  constructor(projectId: string, create: StreamFactory = url => new EventSource(url)) {
    this.projectId = projectId;
    this.create = create;
  }

  open() {
    this.connect();
  }

  close() {
    this.source?.close();
    this.source = null;
  }

  subscribe(listener: LiveListener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // Watches one attempt's events, or none; the stream reopens only when the watched attempt changes.
  watchLog(attemptId: string | null, after = 0) {
    if ((attemptId ?? null) === (this.watch?.attemptId ?? null)) return;
    this.watch = attemptId ? { attemptId, after } : null;
    if (this.source) this.connect();
  }

  get url() {
    return eventsUrl(this.projectId, this.watch ?? undefined);
  }

  private connect() {
    this.source?.close();
    const source = this.create(this.url);
    this.source = source;
    source.addEventListener('open', () => this.setStatus('live'));
    source.addEventListener('error', () => this.setStatus('offline'));
    source.addEventListener('change', event => void this.receive(JSON.parse((event as MessageEvent).data)));
    source.addEventListener('log', event => {
      const log: LogEvent = JSON.parse((event as MessageEvent).data);
      if (this.watch && log.attempt_id === this.watch.attemptId) this.watch.after = Math.max(this.watch.after, log.seq);
      for (const listener of this.listeners) listener.log?.(log);
    });
  }

  private async receive(message: ChangeMessage) {
    if (message.changes || message.reload) return this.emit(message);
    // Each connection opens with where the controller is. The first is where pages start reading, since they
    // wait for it (`started`); one from another start reloads what is shown, and a reconnect asks for the
    // changes made while the stream was away.
    const first = !this.start,
      restarted = !first && message.start !== this.start,
      behind = !first && !restarted && message.version > this.version;
    const since = this.version;
    this.start = message.start;
    this.version = Math.max(this.version, message.version);
    if (first) {
      this.started = true;
      for (const listener of this.listeners) listener.status?.(this.status);
      return;
    }
    if (restarted) return this.emit({ ...message, reload: true });
    if (!behind) return;
    try {
      this.emit(await getJSON<ChangeMessage>(changesUrl(this.projectId, since, message.start)));
    } catch {
      this.emit({ ...message, reload: true });
    }
  }

  private setStatus(status: StreamStatus) {
    if (status === this.status) return;
    this.status = status;
    for (const listener of this.listeners) listener.status?.(status);
  }

  private emit(message: ChangeMessage) {
    this.version = Math.max(this.version, message.version);
    for (const listener of this.listeners) listener.changes?.(message);
  }
}

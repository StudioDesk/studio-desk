// An attempt's trace (v1.0 item 21; the canvas's "How Eli worked"): the controller's record of every step the CLI
// took (GET /api/attempts/<id>/trace, attempt-trace-v1, docs/module-contracts.md "Attempt trace"), read here into
// rows worded as the page shows them, grouped into chapters, with what the attempt touched. The controller gives
// facts; the words are the page's. Nothing here sends anything.
import type { AttemptSummary } from './api';
import { effortWords, plural } from './evidence';

export interface TraceOutput {
  head: string;
  tail: string;
  bytes: number;
  cut: boolean;
}
export interface TraceStep {
  seq: number;
  at: string;
  kind: 'say' | 'think' | 'shell' | 'read' | 'search' | 'edit' | 'blocked' | 'error' | 'tool';
  pending?: boolean;
  text?: string;
  cut?: boolean;
  durationMs?: number | null;
  tokens?: number | null;
  command?: string;
  description?: string | null;
  exitCode?: number | null;
  output?: TraceOutput | null;
  path?: string;
  startLine?: number | null;
  lines?: number | null;
  totalLines?: number | null;
  tool?: string;
  pattern?: string;
  glob?: string | null;
  matches?: number | null;
  change?: 'edit' | 'create' | 'delete';
  added?: number | null;
  removed?: number | null;
  detail?: string;
  reason?: string;
}
export interface TracePhase {
  at: string;
  phaseId: string;
  boundary: 'start' | 'finish';
  outcome?: string | null;
  durationMs?: number | null;
}
export interface UsageWindow {
  before: number | null;
  after: number | null;
  resetsAt?: string | null;
}
export interface AttemptTrace {
  schemaVersion: string;
  attemptId: string;
  taskId: string;
  provider?: string;
  model?: string;
  effort?: string;
  status: string;
  startedAt?: string;
  finishedAt?: string | null;
  durationMs?: number | null;
  source: 'activity-file' | 'log-rows' | 'none';
  lines?: number;
  unreadLines?: number;
  activityCut?: boolean;
  setup?: { tools?: number; mcpServers?: string[]; permissionMode?: string; version?: string } | null;
  usage?: {
    windows?: Record<string, UsageWindow>;
    tokens?: {
      input?: number;
      output?: number;
      cachedInput?: number;
      reasoningOutput?: number;
      cacheRead?: number;
      cacheWrite?: number;
    };
  } | null;
  counts: Partial<
    Record<'say' | 'think' | 'thinkTokens' | 'shell' | 'read' | 'search' | 'edit' | 'blocked' | 'error', number>
  >;
  steps: TraceStep[];
  omitted?: { afterSeq: number; count: number } | null;
  outputOmitted?: boolean;
  phases?: TracePhase[];
  handoff?: { at: string; outcome?: string; summary?: string; handoff?: string } | null;
}

export type Group = 'talk' | 'reading' | 'edits' | 'commands' | 'blocked' | 'think' | 'phase';
export interface TraceRow {
  key: string;
  at: string;
  kind: TraceStep['kind'] | 'phase' | 'handoff' | 'omitted';
  group: Group;
  title: string;
  // A command, a search pattern or the files a group of reads opened.
  detail?: string;
  // Why the CLI refused or a tool failed.
  reason?: string;
  // The tool's own output, shown on request.
  output?: string;
  // Words rather than code, such as the handoff's summary.
  prose?: string;
  tone?: 'ok' | 'bad' | 'live';
  pending?: boolean;
}
export interface Chapter {
  key: string;
  title: string;
  from: string;
  to: string;
  rows: TraceRow[];
}

export const cliOf = (provider?: string) =>
  provider === 'claude' ? 'Claude Code' : provider === 'codex' ? 'Codex' : provider || 'The CLI';

const base = (path = '') => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
// A command names the job folder by its full path; inside it, a path reads from the job folder, as the controller
// gives the steps' own paths.
const jobFolder = /[A-Za-z]:?[\\/](?:[^\s"'`]*?[\\/])?jobs[\\/]attempt-[0-9a-f-]+[\\/]?/g;
export const inJob = (text?: string) => text?.replace(jobFolder, '');

// The program a command runs, for a step the CLI gave no words for (Codex's): "Ran Get-Content", "Ran node".
// A change of folder first, or a variable assigned the result, is passed over.
export function program(command = '') {
  const first = command
    .replace(/^\s*cd\s+("[^"]*"|\S+)\s*(&&|;)\s*/i, '')
    .replace(/^\s*\$\w+\s*=\s*/, '')
    .match(/^\s*"?([^\s"]+)/)?.[1];
  const name = first
    ?.split(/[\\/]/)
    .at(-1)
    ?.replace(/\.exe$/i, '');
  return name ? name : 'a command';
}
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

// Why the CLI refused a step, in the director's words: Claude Code's two usual answers say what they mean here, and
// any other reason is quoted as the CLI gave it. "Claude Code refused it: the path is outside the folders it may use."
export function refusal(step: TraceStep, cli: string) {
  const reason = inJob(step.reason)?.trim();
  if (!reason) return `${cli} refused it.`;
  if (/outside (the )?allowed working directories/i.test(reason))
    return `${cli} refused it: the path is outside the folders this attempt may use.`;
  if (/requires approval/i.test(reason))
    return `${cli} refused it: the command needs approval, and it is not one of the approved commands (Settings, Command-line tools).`;
  return `${cli} refused it: ${lowerFirst(reason)}${/[.!?]$/.test(reason) ? '' : '.'}`;
}
const upperFirst = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const outputOf = (output?: TraceOutput | null) =>
  output ? (output.cut ? `${output.head}\n…\n${output.tail}` : output.head + output.tail) : undefined;

// "4 min 39 s", "17 s", "1 h 3 min".
export function span(ms?: number | null) {
  if (ms == null || !Number.isFinite(ms)) return '';
  if (ms < 1000) return 'under a second';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes} min ${seconds % 60} s` : `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
const lineChange = (added?: number | null, removed?: number | null) =>
  added == null || removed == null ? '' : `+${added} −${removed}`;
const thoughts = (count: number) => (count === 1 ? '' : count === 2 ? 'twice' : `${count} times`);

// The steps as rows, in time with the source phases and the handoff. Runs of thinking, of reads and of edits to
// one file each become one row.
export function traceRows(trace: AttemptTrace, attempt?: AttemptSummary): TraceRow[] {
  const cli = cliOf(trace.provider),
    rows: TraceRow[] = [];
  const steps = trace.steps;
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]!,
      key = `s${step.seq}`;
    // A run of one kind: thinking, reads, or edits of one file.
    const run = (same: (next: TraceStep) => boolean) => {
      const items = [step];
      while (index + 1 < steps.length && same(steps[index + 1]!)) items.push(steps[++index]!);
      return items;
    };
    switch (step.kind) {
      case 'think': {
        const items = run(next => next.kind === 'think'),
          tokens = items.reduce((total, item) => total + (item.tokens ?? 0), 0),
          duration = items.reduce((total, item) => total + (item.durationMs ?? 0), 0),
          about = tokens ? ` · about ${tokens.toLocaleString('en-US')} tokens` : '';
        rows.push({
          key,
          at: step.at,
          kind: 'think',
          group: 'think',
          title:
            items.length === 1
              ? `Thought${duration ? ` for ${span(duration)}` : ''}${about}`
              : `Thought ${thoughts(items.length)}${about}`,
          pending: items.some(item => item.pending),
        });
        break;
      }
      case 'say':
        rows.push({
          key,
          at: step.at,
          kind: 'say',
          group: 'talk',
          title: `${step.text ?? ''}${step.cut ? '…' : ''}`,
          pending: step.pending,
        });
        break;
      case 'shell':
        rows.push({
          key,
          at: step.at,
          kind: 'shell',
          group: 'commands',
          title: step.description ? upperFirst(step.description) : `Ran ${program(step.command)}`,
          detail: inJob(step.command),
          reason: step.exitCode ? `It ended with exit code ${step.exitCode}.` : undefined,
          tone: step.exitCode ? 'bad' : undefined,
          output: outputOf(step.output),
          pending: step.pending,
        });
        break;
      case 'read': {
        const items = run(next => next.kind === 'read'),
          paths = [...new Set(items.map(item => item.path ?? ''))],
          from = items.map(item => item.startLine).filter((line): line is number => !!line && line > 1);
        rows.push({
          key,
          at: step.at,
          kind: 'read',
          group: 'reading',
          title:
            paths.length > 1
              ? `Read ${paths.length} files`
              : from.length > 1
                ? `Read ${base(paths[0])} around lines ${from.slice(0, -1).join(', ')} and ${from.at(-1)}`
                : from.length
                  ? `Read ${base(paths[0])} from line ${from[0]}`
                  : `Read ${base(paths[0])}`,
          detail: paths.length > 1 ? paths.join('\n') : undefined,
          output: outputOf(items.find(item => item.output)?.output),
          pending: items.some(item => item.pending),
        });
        break;
      }
      case 'search':
        rows.push({
          key,
          at: step.at,
          kind: 'search',
          group: 'reading',
          title: `Searched ${step.path ? base(step.path) : (step.glob ?? 'the files')}${step.matches != null ? ` · ${step.matches} ${plural(step.matches, 'match', 'matches')}` : ''}`,
          detail: step.pattern,
          output: outputOf(step.output),
          pending: step.pending,
        });
        break;
      case 'edit': {
        const items = run(
            next => next.kind === 'edit' && next.path === step.path && next.change === 'edit' && step.change === 'edit',
          ),
          changes = items.map(item => lineChange(item.added, item.removed)).filter(Boolean);
        rows.push({
          key,
          at: step.at,
          kind: 'edit',
          group: 'edits',
          title:
            step.change === 'create'
              ? `Created ${base(step.path)}`
              : step.change === 'delete'
                ? `Deleted ${base(step.path)}`
                : items.length > 1
                  ? `Edited ${base(step.path)} in ${items.length} places`
                  : `Edited ${base(step.path)}`,
          detail: changes.length
            ? `${changes.join(' · ')} ${items.length === 1 && (step.added ?? 0) + (step.removed ?? 0) <= 2 && step.added === step.removed ? 'line' : 'lines'}`
            : undefined,
          pending: items.some(item => item.pending),
        });
        break;
      }
      case 'blocked':
        rows.push({
          key,
          at: step.at,
          kind: 'blocked',
          group: 'blocked',
          title: step.description
            ? `Tried to ${lowerFirst(step.description)}`
            : step.tool === 'Bash' || !step.tool
              ? 'Tried to run a command'
              : step.tool === 'Read' && step.detail
                ? `Tried to read ${base(step.detail)}`
                : ['Edit', 'Write'].includes(step.tool) && step.detail
                  ? `Tried to change ${base(step.detail)}`
                  : `Tried to use ${step.tool}`,
          detail: inJob(step.detail),
          reason: refusal(step, cli),
        });
        break;
      case 'error':
        rows.push({
          key,
          at: step.at,
          kind: 'error',
          group: 'edits',
          title: step.description ? `${upperFirst(step.description)} failed` : `${step.tool ?? 'A tool'} failed`,
          detail: step.detail,
          reason: step.reason,
          tone: 'bad',
        });
        break;
      default:
        rows.push({
          key,
          at: step.at,
          kind: 'tool',
          group: 'commands',
          title: `Used ${step.tool ?? 'a tool'}`,
          detail: step.detail,
          pending: step.pending,
        });
    }
    if (trace.omitted && step.seq === trace.omitted.afterSeq)
      rows.push({
        key: 'omitted',
        at: step.at,
        kind: 'omitted',
        group: 'phase',
        title: `${trace.omitted.count.toLocaleString('en-US')} more steps are left out here, to keep the trace light. The raw log has every line.`,
      });
  }
  for (const phase of trace.phases ?? []) {
    const row = phaseRow(phase, attempt);
    if (row) rows.push(row);
  }
  if (trace.handoff)
    rows.push({
      key: 'handoff',
      at: trace.handoff.at,
      kind: 'handoff',
      group: 'talk',
      title:
        trace.handoff.outcome === 'completed'
          ? 'Handed off its work'
          : `Handed off: ${trace.handoff.outcome ?? 'no outcome'}`,
      prose: trace.handoff.summary,
    });
  // A finished attempt's step without its result lost the result to a cut log line; it is not still running.
  const live = ['running', 'stopping'].includes(trace.status);
  return rows
    .map(row => (live || !row.pending ? row : { ...row, pending: false }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

// The source phases worth a line: editing starting, the candidate committed, packages installed and the tests.
function phaseRow(phase: TracePhase, attempt?: AttemptSummary): TraceRow | null {
  const key = `p${phase.phaseId}${phase.boundary}${phase.at}`,
    took = span(phase.durationMs),
    row = (title: string, tone?: TraceRow['tone']) =>
      ({ key, at: phase.at, kind: 'phase', group: 'phase', title, tone }) as TraceRow;
  if (phase.phaseId === 'source.edit' && phase.boundary === 'start')
    return row('Started editing in a private copy of the source');
  if (phase.boundary !== 'finish')
    return phase.phaseId === 'test' ? row('Started the tests in the sandbox', 'live') : null;
  const failed = phase.outcome && phase.outcome !== 'succeeded';
  if (phase.phaseId === 'candidate.commit')
    return row(failed ? 'Committing the candidate failed' : 'Committed the candidate', failed ? 'bad' : 'ok');
  if (phase.phaseId === 'install')
    return row(
      failed
        ? `Installing packages failed${took ? ` after ${took}` : ''}`
        : `Installed packages${took ? ` in ${took}` : ''}`,
      failed ? 'bad' : 'ok',
    );
  if (phase.phaseId === 'integration.verification')
    return row(
      failed ? 'Verifying the integration failed' : `Verified the integration${took ? ` in ${took}` : ''}`,
      failed ? 'bad' : 'ok',
    );
  if (phase.phaseId === 'integration.fast-forward')
    return row(failed ? 'Moving the branch forward failed' : 'Moved the branch forward', failed ? 'bad' : 'ok');
  if (phase.phaseId === 'test') {
    const totals = (attempt?.testEvidence as { totals?: { tests?: number; pass?: number } } | undefined)?.totals,
      count = totals?.tests ? `${totals.pass} of ${totals.tests} passed` : failed ? 'they failed' : 'they passed';
    return row(`Sandbox tests: ${count}${took ? ` in ${took}` : ''}`, failed ? 'bad' : 'ok');
  }
  return null;
}

const agentKinds = new Set(['think', 'say', 'shell', 'read', 'search', 'edit', 'blocked', 'error', 'tool']);

// Chapters: getting oriented, reading, writing the change, trying it and handing off, then the controller's checks.
// A new one starts at the first edit, after a message once a chapter is long, at the first command after the edits,
// and when the agent's own work is over.
export function chaptersOf(rows: TraceRow[]): Chapter[] {
  const chapters: { rows: TraceRow[]; controller: boolean }[] = [];
  let current: { rows: TraceRow[]; controller: boolean } | null = null,
    agentDone = false;
  const start = (controller = false) => {
    current = { rows: [], controller };
    chapters.push(current);
    return current;
  };
  for (const row of rows) {
    if (row.kind === 'handoff') agentDone = true;
    const controller = agentDone && row.kind === 'phase';
    let chapter = current as { rows: TraceRow[]; controller: boolean } | null;
    if (!chapter || chapter.controller !== controller) chapter = start(controller);
    else if (!controller) {
      const edits = chapter.rows.some(item => item.kind === 'edit'),
        sinceEdit = chapter.rows.length - 1 - chapter.rows.map(item => item.kind).lastIndexOf('edit');
      if (
        row.kind === 'edit' &&
        !edits &&
        chapter.rows.length >= 4 &&
        chapter.rows.some(item => agentKinds.has(item.kind) && item.kind !== 'think')
      )
        chapter = start();
      else if (edits && ['shell', 'blocked'].includes(row.kind) && sinceEdit >= 2) chapter = start();
    }
    chapter.rows.push(row);
    if (
      !controller &&
      row.kind === 'say' &&
      chapter.rows.length >= 10 &&
      !chapter.rows.some(item => item.kind === 'edit')
    )
      current = null;
  }
  return chapters
    .filter(chapter => chapter.rows.length)
    .map((chapter, index, all) => {
      const kinds = new Set(chapter.rows.map(row => row.kind)),
        title = chapter.controller
          ? "The controller's checks"
          : kinds.has('edit')
            ? 'Writing the change'
            : kinds.has('handoff') || all.slice(index + 1).every(other => other.controller)
              ? kinds.has('blocked') || kinds.has('shell')
                ? 'Trying it, then handing off'
                : 'Handing off'
              : index === 0
                ? 'Getting oriented'
                : 'Reading the source';
      return {
        key: chapter.rows[0]!.key,
        title,
        from: chapter.rows[0]!.at,
        to: chapter.rows.at(-1)!.at,
        rows: chapter.rows,
      };
    });
}

// What the attempt changed (each file, how many edits, whether it made it) and read or searched.
export function touched(trace: AttemptTrace) {
  const changed = new Map<string, { path: string; edits: number; created: boolean }>(),
    read = new Set<string>();
  for (const step of trace.steps) {
    if (step.kind === 'edit' && step.path) {
      const item = changed.get(step.path) ?? { path: step.path, edits: 0, created: false };
      item.edits++;
      item.created ||= step.change === 'create';
      changed.set(step.path, item);
    } else if ((step.kind === 'read' || step.kind === 'search') && step.path) read.add(step.path);
  }
  return { changed: [...changed.values()], read: [...read].filter(path => !changed.has(path)) };
}

// The tools the attempt used, by the names its CLI gives them.
export function toolsUsed(trace: AttemptTrace) {
  const names = new Set<string>();
  for (const step of trace.steps)
    if (step.kind === 'shell' || (step.kind === 'blocked' && (step.tool ?? 'Bash') === 'Bash')) names.add('Bash');
    else if (step.kind === 'read') names.add('Read');
    else if (step.kind === 'search') names.add(step.tool ?? 'Grep');
    else if (step.kind === 'edit') names.add(step.change === 'create' ? 'Write' : 'Edit');
    else if (step.tool) names.add(step.tool);
  return [...names];
}

// "Claude Code · claude-opus-5-5 · extra-high effort".
export const setupLine = (trace: AttemptTrace) =>
  [cliOf(trace.provider), trace.model, trace.effort ? `${effortWords(trace.effort)} effort` : '']
    .filter(Boolean)
    .join(' · ');

export const filters: { id: 'all' | Exclude<Group, 'think' | 'phase'>; label: string; groups: Group[] }[] = [
  { id: 'all', label: 'All', groups: ['talk', 'reading', 'edits', 'commands', 'blocked', 'think', 'phase'] },
  { id: 'talk', label: 'Talk', groups: ['talk'] },
  { id: 'reading', label: 'Reading', groups: ['reading'] },
  { id: 'edits', label: 'Edits', groups: ['edits'] },
  { id: 'commands', label: 'Commands', groups: ['commands', 'blocked'] },
  { id: 'blocked', label: 'Blocked', groups: ['blocked'] },
];

// A story's Activity (the canvas's "Watching Eli work", v1.0 items 21 and 23): the shown attempt as a
// conversation, from its trace. The agent's own words are bubbles; what it edited, ran and was refused, and the
// controller's phases, are short lines with their times; a running attempt ends in typing dots. Thinking, reads and
// searches stay in the full trace, which this links to.
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { AttemptSummary } from './api';
import { plural } from './evidence';
import { refusal, span, type AttemptTrace, type TraceStep } from './trace';

const clock = (value?: string | null) =>
  value ? new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
const base = (path = '') => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

// A command that only looks around (lists, reads, searches or diffs) and succeeded is reading, which the full
// trace shows; the conversation keeps the commands that do something, such as running the tests.
const lookers = /^(ls|dir|cat|type|head|tail|sed -n|grep|rg|find|wc|echo|pwd|git (diff|status|log|show))(\s|$)/;
const looking = (step: TraceStep) => !step.exitCode && !!step.command && lookers.test(step.command.trim());

// Before this attempt (the phone board): how the story's earlier attempts ended, in one line, like attempts
// together. "1 paused for Codex's usage limit · 2 and 3 stopped with 2 tests failing".
export function beforeThis(
  attempts: AttemptSummary[],
  shown: AttemptSummary,
  cli: (attempt: AttemptSummary) => string,
) {
  const index = attempts.indexOf(shown),
    earlier = (index < 0 ? [] : attempts.slice(0, index)).filter(attempt => attempt.finishedAt),
    groups = new Map<string, number[]>();
  earlier.forEach(attempt => {
    const hold = attempt.subscriptionHold as string | undefined,
      failing = ((attempt.failedTests as unknown[] | undefined) ?? []).length,
      error = String(attempt.error ?? '');
    const words = hold
      ? `paused for ${cli(attempt) || hold}'s usage limit`
      : attempt.status === 'revision_requested'
        ? 'went back for changes'
        : /time limit|timed out|out of time/i.test(error)
          ? 'ran out of time'
          : failing
            ? `stopped with ${failing} ${failing === 1 ? 'test' : 'tests'} failing`
            : ['accepted', 'review'].includes(attempt.status)
              ? 'finished'
              : 'stopped';
    groups.set(words, [...(groups.get(words) ?? []), attempts.indexOf(attempt) + 1]);
  });
  const numbers = (list: number[]) =>
    list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : String(list[0]);
  return [...groups].map(([words, list]) => `${numbers(list)} ${words}`).join(' · ');
}

interface Moment {
  key: string;
  at: string;
  node: ReactNode;
}

// The trace as moments: bubbles for what the agent said, lines for what it did and what the controller did.
function moments(trace: AttemptTrace, attempt: AttemptSummary, face: ReactNode, cli: string): Moment[] {
  const out: Moment[] = [],
    live = ['running', 'stopping'].includes(trace.status),
    steps = trace.steps.map(step => (live || !step.pending ? step : { ...step, pending: false }));
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]!;
    if (step.kind === 'say')
      out.push({
        key: `s${step.seq}`,
        at: step.at,
        node: (
          <div className="sd-say">
            {face}
            <div className="sd-bubble">
              {step.text}
              {step.cut ? '…' : ''}
              <div className="sd-meta" style={{ marginTop: '2px' }}>
                {clock(step.at)}
              </div>
            </div>
          </div>
        ),
      });
    else if (step.kind === 'edit') {
      // Edits until the agent does something else that shows here, as one line of files.
      const run: TraceStep[] = [step];
      while (index + 1 < steps.length && ['edit', 'think', 'read', 'search'].includes(steps[index + 1]!.kind))
        run.push(steps[++index]!);
      const edits = run.filter(item => item.kind === 'edit'),
        files = [...new Map(edits.map(item => [item.path, item])).values()];
      out.push({
        key: `s${step.seq}`,
        at: step.at,
        node: (
          <div className="sd-event">
            {files.map(item => (
              <span
                key={item.path}
                className={`sd-file${item.change === 'create' ? ' sd-file--add' : ''}`}
                title={item.path}
              >
                {item.change === 'create' ? '+ ' : item.change === 'delete' ? '− ' : ''}
                {base(item.path)}
              </span>
            ))}
            {edits.some(item => item.pending) ? 'editing now' : `edited · ${clock(edits.at(-1)!.at)}`}
          </div>
        ),
      });
    } else if (step.kind === 'blocked')
      // A step the CLI refused, with what it was and why, as the full trace words it.
      out.push({
        key: `s${step.seq}`,
        at: step.at,
        node: (
          <div className="sd-event">
            <span className="sd-file sd-file--command" title={step.command ?? step.detail}>
              {step.command ?? step.detail}
            </span>
            <span className="sd-chip sd-chip--you sd-chip--inline">Refused</span>
            {clock(step.at)}
            <span className="sd-event__why">
              {step.description ? `${step.description}. ` : ''}
              {refusal(step, cli)}
            </span>
          </div>
        ),
      });
    else if (step.kind === 'shell' && !looking(step))
      out.push({
        key: `s${step.seq}`,
        at: step.at,
        node: (
          <div className="sd-event">
            <span className="sd-file sd-file--command" title={step.command}>
              {step.command}
            </span>
            {step.exitCode ? (
              <span className="sd-chip sd-chip--bad sd-chip--inline">Exit code {step.exitCode}</span>
            ) : null}
            {step.pending ? 'running' : `ran · ${clock(step.at)}`}
          </div>
        ),
      });
    else if (step.kind === 'error')
      out.push({
        key: `s${step.seq}`,
        at: step.at,
        node: (
          <div className="sd-event">
            <span className="sd-chip sd-chip--bad sd-chip--inline">
              <span className="sd-chip__dot"></span>
              {step.tool ?? 'A tool'} failed
            </span>
            {clock(step.at)}
          </div>
        ),
      });
  }
  // The controller's phases: editing started and done, the candidate committed, packages and the tests.
  const phases = trace.phases ?? [],
    finished = (id: string) => phases.find(phase => phase.phaseId === id && phase.boundary === 'finish'),
    started = (id: string) => phases.find(phase => phase.phaseId === id && phase.boundary === 'start'),
    chip = (tone: string, label: string) => (
      <span className={`sd-chip sd-chip--${tone} sd-chip--inline`}>
        <span className="sd-chip__dot"></span>
        {label}
      </span>
    );
  const editStart = started('source.edit');
  if (editStart)
    out.push({
      key: 'edit-start',
      at: editStart.at,
      node: (
        <div className="sd-event">
          <span className="sd-chip sd-chip--brand sd-chip--inline">Editing started</span>
          {clock(editStart.at)}
        </div>
      ),
    });
  const editDone = finished('source.edit'),
    commit = finished('candidate.commit');
  if (editDone || commit)
    out.push({
      key: 'edit-done',
      at: (editDone ?? commit)!.at,
      node: (
        <div className="sd-event">
          {editDone && chip('ok', `Editing done${editDone.durationMs ? ` · ${span(editDone.durationMs)}` : ''}`)}
          {commit && chip(commit.outcome === 'succeeded' ? 'ok' : 'bad', 'Committed')}
          {clock((editDone ?? commit)!.at)}
        </div>
      ),
    });
  const testStart = started('test'),
    testDone = finished('test');
  if (testStart || testDone) {
    const totals = (attempt.testEvidence as { totals?: { tests?: number; pass?: number } } | undefined)?.totals;
    out.push({
      key: 'tests',
      at: (testDone ?? testStart)!.at,
      node: (
        <div className="sd-event">
          {testDone
            ? chip(
                testDone.outcome === 'succeeded' ? 'ok' : 'bad',
                `${totals?.tests ? `${totals.pass} of ${totals.tests} tests passed` : testDone.outcome === 'succeeded' ? 'Tests passed' : 'Tests failed'}${testDone.durationMs ? ` · ${span(testDone.durationMs)}` : ''}`,
              )
            : chip('live', 'Full suite running in the sandbox')}
          {testDone ? clock(testDone.at) : `since ${clock(testStart!.at)}`}
        </div>
      ),
    });
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export function TraceActivity({
  projectId,
  taskId,
  attempt,
  trace,
  face,
  live,
  heading,
  cli,
  before,
  onBefore,
  actions,
}: {
  projectId: string;
  taskId: string;
  attempt: AttemptSummary;
  trace: AttemptTrace;
  face: ReactNode;
  live: boolean;
  heading: string;
  // The CLI that ran it, which names who refused a step: "Claude Code".
  cli: string;
  // How the earlier attempts ended, and the way to them.
  before?: string;
  onBefore?: () => void;
  actions?: ReactNode;
}) {
  const shown = moments(trace, attempt, face, cli),
    // What the conversation leaves to the full trace, so its gaps are not mistaken for nothing done.
    looked = trace.steps.filter(looking).length,
    left = [
      trace.counts.read ? `${trace.counts.read} ${plural(trace.counts.read, 'file')} read` : '',
      trace.counts.search ? `${trace.counts.search} ${plural(trace.counts.search, 'search', 'searches')}` : '',
      looked ? `${looked} ${plural(looked, 'command')} that only looked around` : '',
      trace.counts.think
        ? `${trace.counts.think} ${plural(trace.counts.think, 'stretch', 'stretches')} of thinking`
        : '',
    ].filter(Boolean);
  return (
    <>
      {before && (
        <div
          className="sd-card sd-card--quiet"
          style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
        >
          <span className="sd-eyebrow">Before this attempt</span>
          <span style={{ color: 'var(--ink-2)', fontSize: '14px' }}>{before}.</span>
          {onBefore && (
            <button
              type="button"
              className="sd-link"
              style={{ alignSelf: 'flex-start', fontSize: '14px', fontWeight: 600 }}
              onClick={onBefore}
            >
              See those attempts
            </button>
          )}
        </div>
      )}
      <div className="sd-divider">{heading}</div>
      {shown.length ? (
        shown.map(moment => <div key={moment.key}>{moment.node}</div>)
      ) : (
        <p className="sd-meta" style={{ margin: 0 }}>
          Nothing said or changed yet.
        </p>
      )}
      {live && (
        <div className="sd-say" aria-label="Working">
          {face}
          <span className="sd-typing" aria-hidden="true">
            <i></i>
            <i></i>
            <i></i>
          </span>
        </div>
      )}
      {trace.handoff?.summary && (
        <div className="sd-handoff">
          <span className="sd-eyebrow" style={{ color: 'var(--brand-text)' }}>
            Handed off · {clock(trace.handoff.at)}
          </span>
          <b style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{trace.handoff.summary}</b>
        </div>
      )}
      {left.length > 0 && (
        <p className="sd-meta" style={{ margin: 0 }}>
          Also in the full trace: {left.length > 1 ? `${left.slice(0, -1).join(', ')} and ${left.at(-1)}` : left[0]}.
        </p>
      )}
      <div style={{ display: 'flex', gap: 'var(--space-8)', flexWrap: 'wrap', paddingTop: 'var(--space-6)' }}>
        <Link
          className="sd-btn"
          style={{ flex: '1 1 160px' }}
          to="/p/$projectId/tasks/$taskId/attempts/$attemptId"
          params={{ projectId, taskId, attemptId: attempt.id }}
        >
          Full trace
        </Link>
        {actions}
      </div>
    </>
  );
}

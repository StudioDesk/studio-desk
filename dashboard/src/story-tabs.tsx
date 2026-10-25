// The story page's tabs (the canvas's Story board, v1.0 item 23): what the agent was asked to do, the checks that
// ran and the ones nobody ran, the independent review, the attempts, and everything the controller recorded. Each
// tab reads only its own records, and recorded files are read once, when their tab first opens.
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { AttemptSummary, Task } from './api';
import {
  AgentTestRuns,
  AttemptRecord,
  carriedOf,
  continuation,
  PhaseTimeline,
  phaseTimes,
  PlanReview,
  recordedPhases,
  useAttemptDetail,
  type FullAttempt,
} from './attempt-record';
import { storyPaths } from './decisions';
import { AgentAvatar } from './design/avatar';
import { agentState, attemptState } from './faces';
import type { AgentLook } from './design/agent-kit.js';
import { Icon } from './design/icons';
import { effortWords, plural, reviewOf, sandboxed, spoken, testTime, took, totalsOf } from './evidence';
import {
  artifactUrl,
  attemptEntries,
  Deliverable,
  FileViewer,
  IdeaFiles,
  pictureOf,
  TextReader,
  type IdeaFile,
} from './files';
import { workerName } from './names';
import { FileChanges, filesEditable, readArtifact, StoryEdit } from './source-story';
import { cliName, countsTowardLimit, isSourceStory, kindLabel, storyPeople } from './story';
import { liveSummary, type StudioState } from './studio-runs';
import { IntegrationJournal, type Journal } from './task-decisions';
import { TaskRow } from './task-row';
import { useNarrow } from './use-narrow';
import { when } from './today';

const kindOf = (attempt?: AttemptSummary) => (attempt?.assignment as { kind?: string } | undefined)?.kind;
export const isReview = (attempt?: AttemptSummary) => kindOf(attempt) === 'studio-development:change-review';
const modelOf = (attempt: AttemptSummary) => (attempt.reportedModel ?? attempt.requestedModel) as string | undefined;

// A check as the agents and the controller record it: its name, pass, fail or not run, and its evidence.
interface Check {
  name?: string;
  status?: string;
  evidence?: string;
}
function CheckRow({ check }: { check: Check }) {
  const tone = check.status === 'pass' ? 'ok' : check.status === 'fail' ? 'bad' : 'wait';
  return (
    <div className="sd-row">
      <span className={`sd-row__icon${tone === 'wait' ? '' : ` sd-row__icon--${tone}`}`}>
        <Icon
          name={tone === 'ok' ? 'check' : tone === 'bad' ? 'close' : 'dash'}
          size={14}
          weight={tone === 'ok' ? 3 : 2.6}
        />
      </span>
      <span className="sd-row__text">
        <b>{check.name}</b>
        {check.evidence && <span className="sd-meta">{check.evidence}</span>}
      </span>
    </div>
  );
}

// A finding or note that starts with the place it is about ("src/a.mjs (around line 12): …") shows the place as a
// file chip.
export function placed(text: string) {
  const match = /^([\w@./-]+\.[\w]+(?::\d+(?:-\d+)?)?)\s*(\([^)]*\))?:\s+([\s\S]*)$/.exec(text);
  return match ? { place: match[1]!, text: `${match[2] ? `${match[2]} ` : ''}${match[3]}` } : { place: '', text };
}
function NoteRow({ text, blocking }: { text: string; blocking?: boolean }) {
  const note = placed(text);
  return (
    <div className="sd-row">
      <span className={`sd-row__icon${blocking ? ' sd-row__icon--bad' : ''}`}>
        <Icon name={blocking ? 'close' : 'note'} size={14} weight={2.4} />
      </span>
      <span className="sd-row__text" style={{ gap: 'var(--space-6)' }}>
        {note.place && (
          <span className="sd-file" style={{ alignSelf: 'flex-start' }}>
            {note.place}
          </span>
        )}
        <span style={{ color: 'var(--ink-2)' }}>{note.text}</span>
      </span>
    </div>
  );
}

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <div style={{ display: 'flex', flexDirection: 'column' }}>
    <span className="sd-eyebrow" style={{ marginBottom: 'var(--space-4)' }}>
      {title}
    </span>
    {children}
  </div>
);
const Unchecked = ({ title, names }: { title: string; names: string[] }) =>
  names.length ? (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-8)' }}>
      <span className="sd-eyebrow">{title}</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-6)' }}>
        {names.map(name => (
          <span key={name} className="sd-chip sd-chip--dash">
            {name}
          </span>
        ))}
      </div>
    </div>
  ) : null;

// A small recorded JSON file (a check report or a review report), read once when its tab opens.
function useRecordedJson<T>(projectId: string, attempt: AttemptSummary | undefined, path: string, enabled: boolean) {
  const item = attempt?.artifacts?.find(file => file.path === path);
  return useQuery({
    enabled: enabled && !!attempt && !!item,
    queryKey: ['recorded-json', projectId, attempt?.id ?? '', path, item?.hash ?? ''],
    queryFn: async ({ signal }) =>
      JSON.parse(await readArtifact(projectId, attempt!.id, path, 512 * 1024, signal)) as T,
    retry: false,
    staleTime: Infinity,
  });
}

// What the agent was asked to do: the brief without its path lines, the files it may change, what done means,
// and what earlier steps handed it.
export function OverviewPanel({
  projectId,
  task,
  studio,
  shown,
  looks,
  children,
}: {
  projectId: string;
  task: Task;
  studio: StudioState;
  shown?: AttemptSummary;
  looks: Map<string, AgentLook>;
  children?: ReactNode;
}) {
  const source = isSourceStory(task) || task.kind === 'studio-development:change',
    { editor } = storyPeople(task, studio),
    paths = source ? storyPaths(task) : null,
    brief = source
      ? (task.brief ?? '')
          .split('\n')
          .filter(line => !/^(Files|New files|Delete): /.test(line))
          .join('\n')
          .trim()
      : (task.brief ?? ''),
    inputs = (shown?.inputReferences as { taskId?: string; attemptId?: string; summary?: unknown }[] | undefined) ?? [],
    files = (shown?.directorInputs ??
      (shown?.assignment as { directorInputs?: IdeaFile[] } | undefined)?.directorInputs ??
      task.directorInputs ??
      []) as IdeaFile[];
  return (
    <div className="sd-tabpanel">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-8)' }}>
        <h2 className="sd-tabpanel__title">What {editor} was asked to do</h2>
        {/* Briefs are written by the agent that broke the idea down, often with code and lists in Markdown. */}
        {brief ? (
          <div style={{ color: 'var(--ink-2)', maxWidth: '72ch' }}>
            <TextReader text={brief} markdown />
          </div>
        ) : (
          <p className="sd-meta" style={{ margin: 0 }}>
            No brief was recorded.
          </p>
        )}
      </div>
      {paths && (paths.files.length > 0 || paths.newFiles.length > 0 || paths.deleteFiles.length > 0) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-8)' }}>
          <span className="sd-eyebrow">Files it may change</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-6)' }}>
            {paths.files.map(path => (
              <span key={path} className="sd-file">
                {path}
              </span>
            ))}
            {paths.newFiles.map(path => (
              <span key={path} className="sd-file sd-file--add" title="A new file">
                + {path}
              </span>
            ))}
            {paths.deleteFiles.map(path => (
              <span key={path} className="sd-file sd-file--del" title="A file to delete">
                − {path}
              </span>
            ))}
          </div>
        </div>
      )}
      {source && <FileChanges task={task} studio={studio} />}
      {source && filesEditable(task, studio) && <StoryEdit projectId={projectId} task={task} studio={studio} />}
      {task.acceptance && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-8)' }}>
          <span className="sd-eyebrow">Done means</span>
          <p className="sd-quote">{task.acceptance}</p>
        </div>
      )}
      {inputs.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-10)' }}>
          <span className="sd-eyebrow">Handed to {editor} by earlier steps</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-10)' }}>
            {inputs.map((input, index) => {
              const producer = studio.tasks.find(item => item.id === input.taskId),
                look = looks.get(producer?.workerId ?? ''),
                summary = typeof input.summary === 'string' ? input.summary : '';
              return (
                <div key={index} className="sd-handed">
                  {look && producer && (
                    <AgentAvatar look={look} size={30} state={agentState(studio, producer.workerId, producer)} />
                  )}
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', minWidth: 0 }}>
                    <b>
                      {producer
                        ? `${workerName(studio, producer.workerId)}'s ${kindLabel(producer, studio).toLowerCase()}`
                        : (input.taskId ?? 'An earlier step')}
                    </b>
                    {summary && (
                      <span
                        style={{
                          color: 'var(--ink-2)',
                          fontSize: '14px',
                          display: '-webkit-box',
                          WebkitLineClamp: 3,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                        }}
                      >
                        {summary}
                      </span>
                    )}
                    {input.taskId && !input.taskId.startsWith('transform:') && (
                      <Link
                        to="/p/$projectId/tasks/$taskId"
                        params={{ projectId, taskId: input.taskId }}
                        style={{ fontSize: '13.5px', fontWeight: 600 }}
                      >
                        {producer?.title ?? input.taskId}
                      </Link>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {files.length > 0 && <IdeaFiles projectId={projectId} files={files} />}
      {children}
    </div>
  );
}

const phaseLabels: Record<string, string> = {
  'source.edit': 'Editing',
  install: 'Installing',
  'candidate.commit': 'Committing',
  test: 'Tests',
};
const phaseColors: Record<string, string> = {
  'source.edit': 'var(--brand)',
  install: 'var(--wait-dot)',
  'candidate.commit': 'var(--line-2)',
  test: 'var(--ok-dot)',
};

// The candidate's tests and where its time went, the editor's own checks, the controller's checks, and what
// nobody checked.
export function ChecksPanel({
  projectId,
  task,
  studio,
  attempt,
  full,
}: {
  projectId: string;
  task: Task;
  studio: StudioState;
  attempt?: AttemptSummary;
  full?: FullAttempt;
}) {
  const { editor } = storyPeople(task, studio),
    totals = totalsOf(attempt),
    report = useRecordedJson<{ unperformedChecks?: string[]; execution?: { exitCode?: number | null } }>(
      projectId,
      attempt,
      'check-report.json',
      true,
    ),
    own = ((attempt?.result as { checks?: Check[] } | undefined)?.checks ?? []).filter(check => check?.name),
    controller = ((attempt?.controllerChecks as Check[] | undefined) ?? []).filter(check => check?.name),
    phases = phaseTimes(full),
    spent = phases.reduce((sum, phase) => sum + phase.ms, 0),
    minutes = took(attempt),
    ran = testTime(attempt),
    runs = full?.employeeTestRuns ?? [],
    output = attempt?.artifacts?.find(item => item.kind === 'test-log' && item.path.endsWith('output.txt')),
    checkReport = attempt?.artifacts?.find(item => item.path === 'check-report.json');
  if (!attempt)
    return (
      <div className="sd-tabpanel">
        <p style={{ margin: 0, color: 'var(--ink-2)' }}>Nothing has run yet.</p>
      </div>
    );
  const failed = (totals?.fail ?? 0) + (totals?.cancelled ?? 0),
    exit = report.data?.execution?.exitCode;
  return (
    <div className="sd-tabpanel">
      {totals?.tests ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-20)', alignItems: 'center' }}>
          <svg
            width="96"
            height="96"
            viewBox="0 0 36 36"
            role="img"
            aria-label={`${totals.pass} of ${totals.tests} tests passed`}
          >
            <circle cx="18" cy="18" r="15" fill="none" stroke="var(--line)" strokeWidth="5" />
            <circle
              cx="18"
              cy="18"
              r="15"
              fill="none"
              stroke={failed ? 'var(--bad-dot)' : 'var(--ok-dot)'}
              strokeWidth="5"
              strokeDasharray={`${(94.25 * (totals.pass ?? 0)) / totals.tests} 94.25`}
              transform="rotate(-90 18 18)"
            />
            {!failed && (
              <path
                d="M12.5 18.5l4 4 7.5-8"
                fill="none"
                stroke="var(--ok)"
                strokeWidth="2.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
          </svg>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', flex: '1 1 260px' }}>
            <b className="sd-display" style={{ fontSize: '30px' }}>
              {totals.pass} of {totals.tests} passed
            </b>
            <span style={{ color: 'var(--ink-2)' }}>
              The full suite ran {sandboxed(attempt) ? 'in the sandbox' : 'without a sandbox'} on the committed
              candidate:{' '}
              {[
                failed ? `${failed} ${plural(failed, 'failure')}` : 'no failures',
                totals.skipped ? `${totals.skipped} skipped` : 'nothing skipped',
                typeof exit === 'number' ? `exit code ${exit}` : '',
              ]
                .filter(Boolean)
                .join(', ')}
              .
            </span>
          </div>
        </div>
      ) : (
        <p style={{ margin: 0, color: 'var(--ink-2)' }}>
          {attempt.status === 'running' ? 'The candidate has not been tested yet.' : 'No measured tests were recorded.'}
        </p>
      )}
      {phases.length > 0 && spent > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-8)' }}>
          <span className="sd-eyebrow">
            Where the {minutes ? `${minutes} ${plural(minutes, 'minute')}` : 'time'} went
          </span>
          <span className="sd-bar sd-bar--thick" aria-hidden="true">
            {phases.map((phase, index) => (
              <span
                key={index}
                className="sd-bar__part"
                style={{
                  width: `${(phase.ms / spent) * 100}%`,
                  background: phaseColors[phase.phaseId] ?? 'var(--line-2)',
                }}
              ></span>
            ))}
          </span>
          <span className="sd-meta" style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-16)' }}>
            {phases.map((phase, index) => (
              <span key={index}>
                <b
                  style={{
                    color:
                      phase.phaseId === 'source.edit'
                        ? 'var(--brand-text)'
                        : phase.phaseId === 'test'
                          ? 'var(--ok)'
                          : 'var(--ink-2)',
                  }}
                >
                  {phaseLabels[phase.phaseId] ?? phase.phaseId}
                </b>{' '}
                {spoken(phase.ms)}
              </span>
            ))}
          </span>
        </div>
      )}
      {!phases.length && ran && <span className="sd-meta">The tests took {spoken(ran)}.</span>}
      {own.length > 0 && (
        <Section title={`${editor}'s own checks before handing off`}>
          {own.map((check, index) => (
            <CheckRow key={index} check={check} />
          ))}
        </Section>
      )}
      {runs.length > 0 && (
        <Section title={`Tests ${editor} ran through the controller`}>
          {runs.map((run, index) => (
            <CheckRow
              key={index}
              check={{
                name: run.files?.length ? run.files.join(', ') : 'Every test',
                status: run.totals ? (run.totals.fail ? 'fail' : 'pass') : 'fail',
                evidence: run.totals
                  ? `${run.totals.pass} of ${run.totals.tests} passed${run.totals.fail ? `, ${run.totals.fail} failed` : ''} · ${when(run.startedAt)}`
                  : `Stopped with exit code ${run.exitCode} before reporting totals · ${when(run.startedAt)}`,
              }}
            />
          ))}
          <span className="sd-meta" style={{ paddingTop: 'var(--space-6)' }}>
            The candidate's own tests above still decide.
          </span>
        </Section>
      )}
      {controller.length > 0 && (
        <Section title="The controller's checks">
          {controller.map((check, index) => (
            <CheckRow key={index} check={check} />
          ))}
        </Section>
      )}
      <Unchecked title="Nobody checked these" names={report.data?.unperformedChecks ?? []} />
      {(output || checkReport) && (
        <div style={{ display: 'flex', gap: 'var(--space-8)', flexWrap: 'wrap' }}>
          {output && (
            <a className="sd-btn sd-btn--sm" href={artifactUrl(projectId, attempt.id, output.path)} download>
              Test output
            </a>
          )}
          {checkReport && (
            <a
              className="sd-btn sd-btn--sm sd-btn--ghost"
              href={artifactUrl(projectId, attempt.id, checkReport.path)}
              download
            >
              Check report
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// The independent review: its verdict, what the reviewer said, its findings and notes, and what it did not check.
export function ReviewPanel({
  projectId,
  task,
  studio,
  review,
  looks,
}: {
  projectId: string;
  task: Task;
  studio: StudioState;
  review?: AttemptSummary;
  looks: Map<string, AgentLook>;
}) {
  const { reviewer, reviewerId } = storyPeople(task, studio),
    report = useRecordedJson<{ unperformedChecks?: string[] }>(
      projectId,
      review,
      'source-change-review.json',
      !!review?.finishedAt,
    ),
    look = looks.get(reviewerId ?? '');
  if (!review || !review.finishedAt)
    return (
      <div className="sd-tabpanel">
        <p style={{ margin: 0, color: 'var(--ink-2)' }}>
          {review
            ? `${reviewer} is reviewing the candidate now.`
            : `No review yet. ${reviewer === 'the reviewer' ? 'The reviewer' : reviewer} reviews the candidate after its tests pass.`}
        </p>
      </div>
    );
  const verdict = review.candidateReviewVerdict,
    findings = (review.candidateReviewFindings as string[] | undefined) ?? [],
    notes = (review.candidateReviewNotes as string[] | undefined) ?? [],
    model = modelOf(review),
    minutes = took(review);
  return (
    <div className="sd-tabpanel" style={{ gap: 'var(--space-16)' }}>
      <div style={{ display: 'flex', gap: 'var(--space-14)', alignItems: 'center', flexWrap: 'wrap' }}>
        {look && <AgentAvatar look={look} size={46} state={attemptState(review)} />}
        <div style={{ flex: '1 1 240px' }}>
          <b className="sd-display" style={{ fontSize: '24px' }}>
            {verdict === 'pass'
              ? `${reviewer} passed it`
              : verdict === 'needs-work'
                ? `${reviewer} asked for changes`
                : `${reviewer} finished the review`}
          </b>
          <div className="sd-meta">
            {[
              'Independent review',
              [cliName(studio, review), model].filter(Boolean).join(', '),
              minutes ? `${minutes} min` : '',
              when(review.finishedAt),
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
        <span
          className={`sd-chip ${findings.length ? 'sd-chip--bad' : 'sd-chip--ok'}`}
          style={{ height: '32px', fontSize: '14px' }}
        >
          <span className="sd-chip__dot"></span>
          {findings.length
            ? `${findings.length} blocking ${plural(findings.length, 'finding')}`
            : 'No blocking findings'}
        </span>
      </div>
      {review.result?.summary && (
        <div className="sd-bubble" style={{ padding: '14px 16px', fontSize: '15px' }}>
          {review.result.summary}
        </div>
      )}
      {findings.length > 0 && (
        <Section title="Blocking findings">
          {findings.map((text, index) => (
            <NoteRow key={index} text={String(text)} blocking />
          ))}
        </Section>
      )}
      {notes.length > 0 && (
        <Section title="Notes, not blocking">
          {notes.map((text, index) => (
            <NoteRow key={index} text={String(text)} />
          ))}
        </Section>
      )}
      <Unchecked title={`${reviewer} did not check`} names={report.data?.unperformedChecks ?? []} />
    </div>
  );
}

// Who worked on an attempt and on which step: "Build, attempt 1 of 2", "Review". A story's build attempts count
// against its limit; a review is a step of its own, not another attempt at the build. An attempt that uses up
// none of them (a usage limit stopped it, or the controller's stop interrupted it and it was reconciled) is named
// for what stopped it, so the next one never reads "attempt 3 of 2" (the recovery drill, October 24). `short`
// leaves out "Build, ", as under the Attempts tab's Build heading and on Today's floor.
export function attemptName(task: Task, attempts: AttemptSummary[], attempt: AttemptSummary, short = false) {
  const same = attempts.filter(item => isReview(item) === isReview(attempt)),
    counted = same.filter(countsTowardLimit),
    source = isSourceStory(task);
  if (source && isReview(attempt)) return `Review${same.length > 1 ? ` ${same.indexOf(attempt) + 1}` : ''}`;
  const name = countsTowardLimit(attempt)
    ? `attempt ${counted.indexOf(attempt) + 1} of ${task.maxAttempts ?? counted.length}`
    : `${attempt.subscriptionHold ? 'stopped by a usage limit' : 'interrupted'}, not counted`;
  return source && !short ? `Build, ${name}` : name[0]!.toUpperCase() + name.slice(1);
}

// The work a staged task's later stage (an independent review) took in: the accepted attempt of the task's own
// kind, which is the task's result (stage-template.mjs), while the latest attempt is the later stage's. None when
// the latest attempt is the task's own kind (the fresh install, October 24: a guide's Result showed only its
// review).
export function stagedWork(task: Task, attempts: AttemptSummary[], latest?: AttemptSummary) {
  const own = (attempt: AttemptSummary) => (kindOf(attempt) ?? task.kind) === task.kind;
  if (!latest || !task.stageState || own(latest)) return undefined;
  return (
    attempts.find(attempt => attempt.id === task.acceptedAttemptId && own(attempt)) ??
    [...attempts].reverse().find(attempt => attempt.status === 'accepted' && own(attempt))
  );
}

const statusChips: Record<string, [string, string]> = {
  running: ['live', 'Running'],
  stopping: ['live', 'Stopping'],
  review: ['you', 'Waiting for you'],
  failed: ['bad', 'Failed'],
  blocked: ['you', 'Stopped'],
  cancelled: ['', 'Cancelled'],
  interrupted: ['bad', 'Interrupted'],
  quarantined: ['bad', 'Quarantined'],
  uncertain: ['bad', 'Uncertain'],
};
export function attemptChip(attempt: AttemptSummary) {
  if (attempt.status === 'accepted') {
    if (isReview(attempt)) {
      const { verdict } = reviewOf(attempt);
      return verdict === 'pass'
        ? ['ok', 'Passed']
        : verdict === 'needs-work'
          ? ['you', 'Asked for changes']
          : ['ok', 'Accepted'];
    }
    return (attempt.acceptedBy as { type?: string } | undefined)?.type === 'policy'
      ? ['ok', 'Accepted by house rules']
      : ['ok', 'Accepted'];
  }
  return statusChips[attempt.status] ?? ['', attempt.status];
}

// Each attempt: who ran it on what, when and for how long, and how it ended. A story's are grouped by step, its
// build attempts and then its reviews, so a review never reads as another try at the build (the director, October
// 24). Choosing one shows its own changes, checks and record.
export function AttemptsPanel({
  task,
  studio,
  attempts,
  shown,
  onChoose,
  looks,
}: {
  task: Task;
  studio: StudioState;
  attempts: AttemptSummary[];
  shown?: AttemptSummary;
  onChoose: (id: string) => void;
  looks: Map<string, AgentLook>;
}) {
  if (!attempts.length)
    return (
      <div className="sd-tabpanel">
        <p style={{ margin: 0, color: 'var(--ink-2)' }}>No attempt has been launched.</p>
      </div>
    );
  const builds = attempts.filter(attempt => !isReview(attempt)),
    reviews = attempts.filter(isReview),
    source = isSourceStory(task),
    used = builds.filter(countsTowardLimit).length,
    left = Math.max(0, (task.maxAttempts ?? 0) - used);
  const groups = source
    ? [
        { title: `Build · ${used} of ${task.maxAttempts ?? used} attempts used`, items: builds },
        { title: 'Review', items: reviews },
      ].filter(group => group.items.length)
    : [{ title: '', items: attempts }];
  return (
    <div className="sd-tabpanel" style={{ padding: '12px 22px 22px', gap: 0 }}>
      {groups.map(group => [
        group.title && (
          <span key={group.title} className="sd-eyebrow" style={{ padding: '12px 0 4px' }}>
            {group.title}
          </span>
        ),
        ...group.items.map((attempt, index) => {
          const [tone, label] = attemptChip(attempt),
            look = looks.get(attempt.workerId ?? ''),
            minutes = took(attempt),
            model = modelOf(attempt);
          return (
            <button
              key={attempt.id}
              type="button"
              className="sd-row"
              style={index === 0 ? { borderTop: 0 } : undefined}
              aria-pressed={attempt.id === shown?.id}
              onClick={() => onChoose(attempt.id)}
            >
              {look && <AgentAvatar look={look} size={34} state={attemptState(attempt)} ring={false} />}
              <span className="sd-row__text">
                <b>
                  {/* Under the Build heading a build attempt is just its number. */}
                  {attemptName(task, attempts, attempt, true)}
                </b>
                <span className="sd-meta">
                  {[
                    workerName(studio, attempt.workerId),
                    [
                      cliName(studio, attempt),
                      model,
                      attempt.requestedEffort ? `${effortWords(String(attempt.requestedEffort))} effort` : '',
                    ]
                      .filter(Boolean)
                      .join(', '),
                    (attempt.configuration as { mode?: string } | undefined)?.mode,
                    attempt.startedAt
                      ? `${when(attempt.startedAt)}${attempt.finishedAt ? ` to ${when(attempt.finishedAt)}` : ''}`
                      : '',
                    minutes ? `${minutes} min` : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              <span className={`sd-chip${tone ? ` sd-chip--${tone}` : ''}`}>
                <span className="sd-chip__dot"></span>
                {label}
              </span>
            </button>
          );
        }),
      ])}
      <p className="sd-meta" style={{ margin: '12px 0 0' }}>
        Choosing an attempt shows its own changes, checks and activity.
        {source &&
          task.status !== 'running' &&
          left > 0 &&
          ` ${left} build ${plural(left, 'attempt is', 'attempts are')} left.`}
      </p>
    </div>
  );
}

// Everything the controller recorded about the attempt shown, for checking provenance: its identities and
// hashes, its instructions and delivery, what it received, its files, and the whole record.
export function RecordPanel({
  projectId,
  task,
  studio,
  shown,
  full,
  latest,
}: {
  projectId: string;
  task: Task;
  studio: StudioState;
  shown?: AttemptSummary;
  full?: FullAttempt;
  latest: boolean;
}) {
  const { stage, candidate, review } = storyPeople(task, studio),
    attempt = full ?? shown,
    instructions = full?.instructions,
    journal = (review ?? shown)?.sourceIntegration as Journal | null | undefined,
    received = (attempt?.inputReferences as { taskId?: string }[] | undefined) ?? [],
    // The candidate's files and the review's report beside the attempt shown, each from the attempt that recorded it.
    files = [
      ...new Map(
        [candidate, review, attempt]
          .filter((item): item is AttemptSummary => !!item)
          .flatMap(item =>
            (item.artifacts ?? [])
              .filter(file => file.path !== 'result.json' && !file.path.startsWith('changes/'))
              .map(file => [`${item.id}/${file.path}`, { attemptId: item.id, path: file.path }] as const),
          ),
      ).values(),
    ],
    diff = candidate?.artifacts?.find(file => file.kind === 'source-change-diff'),
    accepted = studio.attempts.find(item => item.id === task.acceptedAttemptId)?.acceptedBy as
      | { type?: string; revision?: number; reason?: string }
      | undefined,
    approval = (task.approval as { by?: { type?: string; revision?: number } } | undefined)?.by,
    complexity = task.complexity == null ? '' : ` · complexity ${task.complexity}`,
    resources = [
      ...new Set([...(studio.taskKinds[task.kind]?.requiredResources ?? []), ...((task.resources as string[]) ?? [])]),
    ];
  return (
    <div className="sd-tabpanel" style={{ gap: 'var(--space-16)' }}>
      <p style={{ margin: 0, color: 'var(--ink-2)' }}>
        Everything the controller recorded, for checking provenance. Nothing here is needed to decide.
      </p>
      <dl className="sd-kv">
        <dt>Task</dt>
        <dd>
          <span className="sd-mono">{task.id}</span> · {kindLabel(task, studio).toLowerCase()}
          {complexity}
        </dd>
        <dt>Reserves</dt>
        <dd>
          {resources.length
            ? resources.map((item, index) => (
                <span key={item}>
                  {index > 0 && ', '}
                  <span className="sd-mono" style={{ fontSize: '13px' }}>
                    {item}
                  </span>
                </span>
              ))
            : 'Only its agent'}
        </dd>
        {candidate && (
          <>
            <dt>Build attempt</dt>
            <dd className="sd-mono" style={{ fontSize: '13px' }}>
              {candidate.id}
            </dd>
          </>
        )}
        {review && (
          <>
            <dt>Review attempt</dt>
            <dd className="sd-mono" style={{ fontSize: '13px' }}>
              {review.id}
            </dd>
          </>
        )}
        {attempt && attempt.id !== candidate?.id && attempt.id !== review?.id && (
          <>
            <dt>Attempt shown</dt>
            <dd className="sd-mono" style={{ fontSize: '13px' }}>
              {attempt.id}
            </dd>
          </>
        )}
        {stage.candidate?.candidateHash && (
          <>
            <dt>Candidate</dt>
            <dd className="sd-mono" style={{ fontSize: '13px' }}>
              sha-256 {stage.candidate.candidateHash}
            </dd>
          </>
        )}
        {diff && (
          <>
            <dt>Diff</dt>
            <dd className="sd-mono" style={{ fontSize: '13px' }}>
              sha-256 {diff.hash}
            </dd>
          </>
        )}
        {instructions?.hash && (
          <>
            <dt>Instructions</dt>
            <dd>
              Composed for this attempt ·{' '}
              <span className="sd-mono" style={{ fontSize: '13px' }}>
                {instructions.hash}
              </span>
            </dd>
          </>
        )}
        {full?.delivery && (
          <>
            <dt>Delivery</dt>
            <dd>{full.delivery}</dd>
          </>
        )}
        {received.length > 0 && (
          <>
            <dt>Received</dt>
            <dd>
              {received.map((input, index) => {
                const producer = studio.tasks.find(item => item.id === input.taskId);
                return (
                  <span key={index}>
                    {index > 0 && ', '}
                    {producer
                      ? `${workerName(studio, producer.workerId)}'s ${kindLabel(producer, studio).toLowerCase()} (${producer.id})`
                      : input.taskId}
                  </span>
                );
              })}
              , each pinned by hash
            </dd>
          </>
        )}
        {accepted?.type === 'policy' && (
          <>
            <dt>Accepted</dt>
            <dd>
              By house rules, revision {accepted.revision}: {accepted.reason}
            </dd>
          </>
        )}
        {approval?.type === 'policy' && (
          <>
            <dt>Approved</dt>
            <dd>By house rules, revision {approval.revision}</dd>
          </>
        )}
        {task.retryOf ? (
          <>
            <dt>Retry of</dt>
            <dd className="sd-mono">{String(task.retryOf)}</dd>
          </>
        ) : null}
      </dl>
      {attempt && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-8)' }}>
          {files.map(item => (
            <a
              key={`${item.attemptId}/${item.path}`}
              className="sd-btn sd-btn--sm"
              href={artifactUrl(projectId, item.attemptId, item.path)}
              download
            >
              {item.path}
            </a>
          ))}
          <a
            className="sd-btn sd-btn--sm sd-btn--ghost"
            href={`/api/attempts/${encodeURIComponent(attempt.id)}/logs/download?projectId=${encodeURIComponent(projectId)}`}
            download
          >
            Download log
          </a>
        </div>
      )}
      {journal?.state && <IntegrationJournal journal={journal} />}
      {instructions?.text && (
        <details className="sd-disclosure">
          <summary>The instructions it ran with</summary>
          <pre className="sd-code sd-code--block">{instructions.text}</pre>
        </details>
      )}
      {shown && (
        <details className="sd-disclosure">
          <summary>The attempt's whole record</summary>
          <AttemptRecord projectId={projectId} summary={shown} latest={latest} studio={studio} task={task} />
        </details>
      )}
    </div>
  );
}

// Work other than a source story: what the attempt returned, read in place (item 14): its picture, what it said
// it did, the checks it reported, the text it wrote, its files, what it handed on and how its time went. What it
// was told and received, and the whole record, are under Record.
export function ResultPanel({
  projectId,
  task,
  studio,
  shown,
}: {
  projectId: string;
  task: Task;
  studio: StudioState;
  shown?: AttemptSummary;
}) {
  const detail = useAttemptDetail(projectId, shown?.id ?? '', !!shown),
    full = shown && detail.data?.id === shown.id ? detail.data : undefined,
    narrow = useNarrow();
  if (!shown)
    return (
      <div className="sd-tabpanel">
        <p style={{ margin: 0, color: 'var(--ink-2)' }}>No attempt has been launched.</p>
      </div>
    );
  const attempt: FullAttempt = full ?? shown,
    name = workerName(studio, attempt.workerId),
    entries = attemptEntries(attempt),
    picture = pictureOf(attempt, task.kind),
    { verdict } = reviewOf(attempt),
    result = attempt.result as { summary?: string; issues?: string[]; handoff?: string; checks?: unknown } | undefined,
    checks = Array.isArray(result?.checks) ? (result.checks as Check[]) : [],
    carried = carriedOf(attempt) ?? carriedOf(shown),
    stories = liveSummary(studio).stories,
    proposed = ((task.materializedTaskIds ?? task.proposedTaskIds) as string[] | undefined)
      ?.map(id => studio.tasks.find(item => item.id === id))
      .filter(item => !!item),
    [tone, label] = attemptChip(attempt);
  const part = (title: string, body: ReactNode) => (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-8)', minWidth: 0 }}>
      <span className="sd-eyebrow">{title}</span>
      {body}
    </section>
  );
  return (
    <div className="sd-tabpanel" style={{ gap: 'var(--space-20)' }}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--space-8)',
        }}
      >
        <span className="sd-meta">
          {[name, cliName(studio, attempt), attempt.finishedAt ? `finished ${when(attempt.finishedAt)}` : '']
            .filter(Boolean)
            .join(' · ')}
        </span>
        <span className={`sd-chip${tone ? ` sd-chip--${tone}` : ''}`}>
          <span className="sd-chip__dot"></span>
          {label}
        </span>
      </div>
      {carried && (
        <p className="sd-meta" style={{ margin: 0 }}>
          {continuation(carried)}
        </p>
      )}
      {attempt.error && (
        <p style={{ margin: 0, color: 'var(--bad)' }}>
          <b>It stopped:</b> {attempt.error}
        </p>
      )}
      {picture && <Deliverable projectId={projectId} attempt={attempt} item={picture} />}
      {result?.summary &&
        part(`What ${name} returned`, <p style={{ margin: 0, fontSize: '16px' }}>{result.summary}</p>)}
      {verdict && (
        <span className="sd-chip" style={{ alignSelf: 'flex-start' }}>
          Review verdict · {verdict}
        </span>
      )}
      {checks.length > 0 &&
        part(
          'The checks it reported',
          <div>
            {checks.map((check, index) => (
              <CheckRow key={index} check={check} />
            ))}
          </div>,
        )}
      {result?.issues?.length
        ? part(
            'What it raised',
            <ul className="sd-reader__text" style={{ margin: 0 }}>
              {result.issues.map((issue, index) => (
                <li key={index}>{issue}</li>
              ))}
            </ul>,
          )
        : null}
      {entries.length > 0 && part('Files it returned', <FileViewer projectId={projectId} entries={entries} />)}
      {full ? (
        result?.handoff && part('What it handed on to the next step', <p style={{ margin: 0 }}>{result.handoff}</p>)
      ) : (
        <p className="sd-meta" role="status" style={{ margin: 0 }}>
          Loading what it handed on…
        </p>
      )}
      {proposed?.length
        ? part(
            'The work it proposed',
            <div>
              {proposed.map(item => (
                <TaskRow key={item.id} projectId={projectId} task={item} stories={stories} />
              ))}
            </div>,
          )
        : null}
      {full?.plan && <PlanReview projectId={projectId} attempt={full} task={task} />}
      {full && <AgentTestRuns attempt={full} name={name} />}
      {full && recordedPhases(full) && part('How its time went', <PhaseTimeline attempt={full} />)}
      <p className="sd-meta" style={{ margin: 0 }}>
        What {name} was told, what it received and everything recorded about this attempt are under{' '}
        {narrow ? 'Details' : 'Record'}.
      </p>
    </div>
  );
}

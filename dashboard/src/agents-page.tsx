// The agents (the canvas's Employees board, v1.0 item 23): the project's agents beside the one chosen, with what it
// is doing now, what it is told, how it runs, its work and its recent runs. An agent is a set of instructions and a
// CLI; each run is its own process, one at a time for each agent, as the controller reserves it. Any agent can be
// renamed here; one made in this project (1.0.1) can also be deleted, and its past work keeps its name.
import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { send, type AttemptSummary, type Execution, type Worker } from './api';
import { AgentAvatar } from './design/avatar';
import { Dialog } from './design/dialog';
import { FacePicker } from './design/face-picker';
import { agentState } from './faces';
import type { AgentLook } from './design/agent-kit.js';
import { Icon } from './design/icons';
import { effortWords, openPhaseOf, plural, spoken, testingPhases } from './evidence';
import { cleanExecution, ExecutionFields } from './execution-fields';
import { TextReader } from './files';
import { useInstructions } from './instructions-page';
import { usePeople, useSettled, useStudio } from './records';
import { cliName } from './story';
import { liveSummary, type StudioState } from './studio-runs';
import { Toggle } from './layout';
import { TaskRow } from './task-row';
import { agentLooks, placeIn, when } from './today';
import { useToast } from './toast';
import { useNow } from './use-now';

const kindOf = (attempt?: AttemptSummary) => (attempt?.assignment as { kind?: string } | undefined)?.kind;
const isReview = (attempt?: AttemptSummary) =>
  ['studio-development:change-review', 'general:review'].includes(kindOf(attempt) ?? '');

export function AgentsPage({ projectId, workerId }: { projectId: string; workerId?: string }) {
  const { state, error } = useStudio(projectId);
  if (error) return <p role="alert">The project could not be loaded: {error.message}</p>;
  if (!state)
    return (
      <p role="status" className="sd-meta">
        Loading the agents…
      </p>
    );
  return <Agents projectId={projectId} state={state} workerId={workerId} />;
}

function Agents({ projectId, state, workerId }: { projectId: string; state: StudioState; workerId?: string }) {
  const looks = useMemo(
      () => agentLooks(projectId, [...state.workers, ...(state.employeeDirectory ?? [])]),
      [projectId, state.workers, state.employeeDirectory],
    ),
    workers = state.workers,
    // Without a choice in the address, the page opens on an agent at work, as the canvas does, else the first.
    chosen =
      workers.find(worker => worker.id === workerId) ??
      (workerId
        ? undefined
        : (workers.find(worker => agentState(state, worker.id) === 'working') ??
          workers.find(worker => worker.enabled !== false) ??
          workers[0]));
  return (
    <div className="sd-agentspage">
      <div className="sd-agents">
        <nav className="sd-card sd-agentlist" aria-label="Agents">
          <div className="sd-agentlist__head">
            <h1 className="sd-sidecard__title" style={{ fontSize: '21px' }}>
              Agents
            </h1>
            <span className="sd-meta">{workers.length}</span>
          </div>
          {workers.map(worker => (
            <AgentRow
              key={worker.id}
              projectId={projectId}
              state={state}
              worker={worker}
              look={looks.get(worker.id)}
              current={worker.id === chosen?.id}
            />
          ))}
          {/* An agent the studio has joins the project in one of its teams. */}
          <Link className="sd-agentrow" to="/p/$projectId/agents/teams" params={{ projectId }} search={{ edit: true }}>
            <span className="sd-agentrow__add" aria-hidden="true">
              <Icon name="plus" size={18} />
            </span>
            <span style={{ fontWeight: 600 }}>Add an agent</span>
          </Link>
          {/* How the agents are organized: their teams, and what each of them is told. */}
          <span className="sd-eyebrow sd-agentlist__group">How they work together</span>
          <Link className="sd-agentrow" to="/p/$projectId/agents/teams" params={{ projectId }}>
            <span className="sd-teammark" aria-hidden="true">
              <Icon name="agents" size={20} />
            </span>
            <span className="sd-agentrow__text">
              <b>Teams</b>
              <span className="sd-meta">
                {(state.teams ?? []).length} {(state.teams ?? []).length === 1 ? 'team' : 'teams'}
              </span>
            </span>
          </Link>
          <Link className="sd-agentrow" to="/p/$projectId/agents/instructions" params={{ projectId }}>
            <span className="sd-teammark" aria-hidden="true">
              <Icon name="file" size={20} />
            </span>
            <span className="sd-agentrow__text">
              <b>Instructions</b>
              <span className="sd-meta">What each agent is told</span>
            </span>
          </Link>
        </nav>
        {chosen ? (
          <AgentDetail
            key={chosen.id}
            projectId={projectId}
            state={state}
            worker={chosen}
            look={looks.get(chosen.id)}
          />
        ) : (
          <p role="status" className="sd-meta">
            This agent is not in the project.
          </p>
        )}
      </div>
    </div>
  );
}

// "1 running · Software engineer", or why it is not working.
function rowState(state: StudioState, worker: Worker) {
  const running = state.attempts.filter(
    item => item.workerId === worker.id && ['running', 'stopping'].includes(item.status),
  ).length;
  if (worker.enabled === false) return { tone: 'wait', text: 'No CLI connected' };
  if (running) return { tone: 'live', text: `${running} running` };
  if (worker.paused) return { tone: 'wait', text: 'Paused' };
  return { tone: 'wait', text: '' };
}

function AgentRow({
  projectId,
  state,
  worker,
  look,
  current,
}: {
  projectId: string;
  state: StudioState;
  worker: Worker;
  look?: AgentLook;
  current: boolean;
}) {
  const now = rowState(state, worker);
  return (
    <Link
      className="sd-agentrow"
      aria-current={current ? 'page' : undefined}
      to="/p/$projectId/agents/$workerId"
      params={{ projectId, workerId: worker.id }}
    >
      {look && <AgentAvatar look={look} size={40} state={agentState(state, worker.id)} ring={false} />}
      <span className="sd-agentrow__text">
        <b>{worker.displayName ?? worker.id}</b>
        <span className="sd-meta" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)' }}>
          <span
            style={{
              width: '7px',
              height: '7px',
              borderRadius: '50%',
              flex: 'none',
              background: now.tone === 'live' ? 'var(--live-dot)' : 'var(--wait-dot)',
            }}
          ></span>
          {[now.text, worker.jobTitle].filter(Boolean).join(' · ')}
        </span>
      </span>
    </Link>
  );
}

function AgentDetail({
  projectId,
  state,
  worker,
  look,
}: {
  projectId: string;
  state: StudioState;
  worker: Worker;
  look?: AgentLook;
}) {
  const { data: people } = usePeople(projectId),
    settled = useSettled(projectId, 'accepted', true, { workerId: worker.id }),
    toast = useToast(),
    [picking, setPicking] = useState(false),
    [renaming, setRenaming] = useState(false),
    [deleting, setDeleting] = useState(false),
    name = worker.displayName ?? worker.id,
    own = worker.projectId === projectId,
    running = state.attempts.filter(
      item => item.workerId === worker.id && ['running', 'stopping'].includes(item.status),
    ),
    accepted = people?.accepted.workers[worker.id] ?? 0,
    execution = [
      cliName(state, undefined, worker.provider),
      worker.model || 'default model',
      worker.effort ? effortWords(worker.effort) : '',
    ]
      .filter(Boolean)
      .join(' · ');
  // The attempts this page holds, the live set's and the settled page's, newest first.
  const pages = settled.data?.pages ?? [],
    attempts = [
      ...new Map(
        [...state.attempts, ...pages.flatMap(page => page.attempts)]
          .filter(item => item.workerId === worker.id)
          .map(item => [item.id, item]),
      ).values(),
    ].sort((a, b) => Date.parse(String(b.startedAt ?? '')) - Date.parse(String(a.startedAt ?? ''))),
    tasks = [...state.tasks, ...pages.flatMap(page => page.tasks)];
  // The face the director chooses, stored on the agent; null gives it back the one the kit picked.
  const face = useMutation({
    mutationFn: (chosen: AgentLook | null) =>
      send(`/api/workers/${encodeURIComponent(worker.id)}/look`, { projectId, look: chosen }),
    onSuccess: (_, chosen) => {
      toast(chosen ? `${name} has a new face.` : `${name} has the face the studio picked again.`);
      setPicking(false);
    },
    onError: error => toast(error.message),
  });
  return (
    <div className="sd-agentdetail">
      <section className="sd-card sd-agenthead" aria-label={name}>
        {look && (
          <>
            <button
              type="button"
              className="sd-facebutton"
              aria-label={`Change ${name}'s face`}
              title={`Change ${name}'s face`}
              onClick={() => setPicking(true)}
            >
              <AgentAvatar look={look} size={72} state={agentState(state, worker.id)} />
              <span className="sd-facebutton__badge">
                <Icon name="pencil" size={14} weight={2.2} />
              </span>
            </button>
            <FacePicker
              open={picking}
              name={name}
              role={[worker.jobTitle, state.project.name].filter(Boolean).join(' · ')}
              look={look}
              stored={!!worker.look}
              saving={face.isPending}
              onSave={chosen => face.mutate(chosen)}
              onReset={() => face.mutate(null)}
              onClose={() => setPicking(false)}
            />
          </>
        )}
        <div className="sd-agenthead__text">
          <h2 className="sd-agenthead__name">{name}</h2>
          <span style={{ color: 'var(--ink-2)' }}>{[worker.jobTitle, worker.team].filter(Boolean).join(' · ')}</span>
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-6)' }}>
            {running.length > 0 && (
              <span className="sd-chip sd-chip--live">
                <span className="sd-chip__dot"></span>
                {running.length} running now
              </span>
            )}
            {worker.enabled !== false && <span className="sd-chip">{execution}</span>}
            {worker.paused && <span className="sd-chip">New work paused</span>}
            <span className="sd-chip">
              {accepted} {plural(accepted, 'result')} accepted
            </span>
          </span>
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-8)' }}>
            <button type="button" className="sd-btn sd-btn--sm sd-btn--ghost" onClick={() => setRenaming(true)}>
              <Icon name="pencil" size={16} />
              Rename
            </button>
            {own && (
              <button type="button" className="sd-btn sd-btn--sm sd-btn--danger" onClick={() => setDeleting(true)}>
                <Icon name="trash" size={16} />
                Delete {name}
              </button>
            )}
          </span>
        </div>
        <p className="sd-agenthead__note">
          {name} is a set of instructions and a CLI.{' '}
          {own
            ? `${name} belongs to this project, so changing ${name} changes nothing anywhere else.`
            : `${name} is shared by every project: a new name, face or CLI shows wherever ${name} works, and what ${name} is told here is this project's own.`}{' '}
          Each run is its own process in its own folder; {name} runs one at a time, and the studio&apos;s limit in
          Settings caps how many agents run together.
        </p>
        <Rename projectId={projectId} worker={worker} name={name} open={renaming} onClose={() => setRenaming(false)} />
        {own && (
          <DeleteAgent
            projectId={projectId}
            state={state}
            worker={worker}
            name={name}
            open={deleting}
            onClose={() => setDeleting(false)}
          />
        )}
      </section>
      <div className="sd-agentgrid">
        <Work projectId={projectId} state={state} worker={worker} tasks={tasks} />
        <aside
          style={{ flex: '1 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-14)' }}
        >
          <RunningNow projectId={projectId} state={state} running={running} name={name} />
          <Told projectId={projectId} worker={worker} name={name} />
          <HowItRuns projectId={projectId} state={state} worker={worker} name={name} />
          <RecentRuns attempts={attempts.filter(item => !['running', 'stopping'].includes(item.status))} />
        </aside>
      </div>
    </div>
  );
}

// What the agent has open, and what it delivered lately.
function Work({
  projectId,
  state,
  worker,
  tasks,
}: {
  projectId: string;
  state: StudioState;
  worker: Worker;
  tasks: StudioState['tasks'];
}) {
  const stories = liveSummary(state).stories,
    mine = tasks.filter(task => task.workerId === worker.id),
    open = mine.filter(task => !['done', 'denied'].includes(task.status) && !task.closed),
    done = mine.filter(task => task.status === 'done' && !task.closed).slice(0, 6);
  const row = (task: (typeof mine)[number]) => (
    <TaskRow key={task.id} projectId={projectId} task={task} stories={stories} />
  );
  return (
    <section
      className="sd-card sd-sidecard sd-sidecard--roomy"
      style={{ flex: '3 1 360px', minWidth: 0 }}
      aria-labelledby="agent-work"
    >
      <h2 id="agent-work" className="sd-sidecard__title">
        {worker.displayName ?? worker.id}&apos;s work
      </h2>
      {open.length ? <div>{open.map(row)}</div> : <span className="sd-meta">Nothing assigned now.</span>}
      {done.length > 0 && (
        <>
          <span className="sd-eyebrow" style={{ marginTop: 'var(--space-8)' }}>
            Delivered lately
          </span>
          <div>{done.map(row)}</div>
        </>
      )}
    </section>
  );
}

function RunningNow({
  projectId,
  state,
  running,
  name,
}: {
  projectId: string;
  state: StudioState;
  running: AttemptSummary[];
  name: string;
}) {
  const now = useNow(running.length > 0),
    busy = state.attempts.filter(item => ['running', 'stopping'].includes(item.status)).length,
    stories = liveSummary(state).stories;
  return (
    <section className="sd-card sd-sidecard sd-sidecard--roomy" aria-labelledby="agent-running">
      <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 'var(--space-8)' }}>
        <h2 id="agent-running" className="sd-sidecard__title">
          Running now
        </h2>
        <span className="sd-meta">
          {busy} of {state.maxParallel ?? 1} studio {plural(state.maxParallel ?? 1, 'slot')}
        </span>
      </span>
      {running.length ? (
        running.map(attempt => {
          const task = state.tasks.find(item => item.id === attempt.taskId),
            place = task ? placeIn(stories, task) : null,
            started = Date.parse(String(attempt.startedAt ?? '')),
            limit = (task?.maxSeconds ?? 0) * 1000,
            used = Number.isFinite(started) ? Math.max(0, now - started) : 0,
            number =
              state.attempts
                .filter(item => item.taskId === attempt.taskId && isReview(item) === isReview(attempt))
                .indexOf(attempt) + 1;
          return (
            <div
              key={attempt.id}
              className="sd-handed"
              style={{ flex: 'none', flexDirection: 'column', gap: 'var(--space-8)' }}
            >
              <span style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-8)', width: '100%' }}>
                <span className="sd-eyebrow" style={{ fontSize: '11px' }}>
                  {[
                    place && place.index > 0 ? `Story ${place.index}` : '',
                    `${isReview(attempt) ? 'Review' : 'Attempt'} ${number || 1}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                <span className="sd-chip sd-chip--live sd-chip--inline">
                  <span className="sd-chip__dot"></span>
                  {isReview(attempt)
                    ? 'Reviewing'
                    : testingPhases.includes(openPhaseOf(attempt) ?? '')
                      ? 'Testing'
                      : 'Working'}
                </span>
              </span>
              {task && <b style={{ lineHeight: 1.3 }}>{task.title}</b>}
              {limit > 0 && (
                <span className="sd-bar sd-bar--thin" style={{ width: '100%' }} aria-hidden="true">
                  <span
                    className="sd-bar__part sd-bar__part--live"
                    style={{ width: `${Math.min(100, (used / limit) * 100)}%` }}
                  ></span>
                </span>
              )}
              <span className="sd-meta">
                {spoken(used)}
                {limit ? ` of ${spoken(limit)}` : ''} ·{' '}
                {task && (
                  <Link to="/p/$projectId/tasks/$taskId" params={{ projectId, taskId: task.id }}>
                    watch it work
                  </Link>
                )}
              </span>
            </div>
          );
        })
      ) : (
        <span className="sd-meta">{name} is free. Nothing is running.</span>
      )}
    </section>
  );
}

// The agent's own instructions, published, and the layers composed with them.
function Told({ projectId, worker, name }: { projectId: string; worker: Worker; name: string }) {
  const { data } = useInstructions(projectId),
    doc = data?.instructions.employees[worker.id];
  return (
    <section
      className="sd-card sd-sidecard sd-sidecard--roomy"
      aria-labelledby="agent-told"
      style={{ gap: 'var(--space-10)' }}
    >
      <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 'var(--space-8)' }}>
        <h2 id="agent-told" className="sd-sidecard__title">
          What {name} is told
        </h2>
        {doc && <span className="sd-meta">revision {doc.revision}</span>}
      </span>
      {doc ? (
        <div style={{ color: 'var(--ink-2)', maxHeight: '260px', overflow: 'hidden', fontSize: '14.5px' }}>
          <TextReader text={doc.text} markdown />
        </div>
      ) : (
        <span className="sd-meta">{data ? 'No role instructions yet.' : 'Reading the instructions…'}</span>
      )}
      {doc?.draft && <span className="sd-meta">A draft waits to be published; it changes nothing until it is.</span>}
      <Link
        className="sd-btn sd-btn--sm"
        style={{ alignSelf: 'flex-start' }}
        to="/p/$projectId/agents/instructions"
        params={{ projectId }}
        search={{ open: `agent:${worker.id}` }}
      >
        Read and edit
      </Link>
      <span className="sd-meta">after the project&apos;s instructions and {worker.team ?? 'its team'}&apos;s</span>
    </section>
  );
}

// Which CLI the agent runs on, and the form that changes it for future runs.
function HowItRuns({
  projectId,
  state,
  worker,
  name,
}: {
  projectId: string;
  state: StudioState;
  worker: Worker;
  name: string;
}) {
  const toast = useToast(),
    adapters = state.adapters ?? {},
    [changing, setChanging] = useState(false),
    [value, setValue] = useState<Execution>({
      provider: worker.provider ?? '',
      model: worker.model ?? '',
      effort: worker.effort ?? '',
      mode: worker.mode ?? '',
    }),
    [paused, setPaused] = useState(!!worker.paused);
  const save = useMutation({
    mutationFn: () =>
      send(
        `/api/workers/${encodeURIComponent(worker.id)}`,
        { projectId, ...cleanExecution(adapters, value), paused, expectedVersion: worker.configVersion ?? 1 },
        'PATCH',
      ),
    onSuccess: () => {
      toast('Saved for future runs.');
      setChanging(false);
    },
    onError: error => toast(error.message),
  });
  const claude = worker.provider === 'claude',
    workspace = (worker.mode || 'workspace') === 'workspace';
  return (
    <section
      className="sd-card sd-sidecard sd-sidecard--roomy"
      aria-labelledby="agent-runs"
      style={{ gap: 'var(--space-8)' }}
    >
      <h2 id="agent-runs" className="sd-sidecard__title">
        How {name} runs
      </h2>
      {worker.enabled === false ? (
        <span style={{ color: 'var(--ink-2)' }}>No CLI runs this agent yet.</span>
      ) : (
        <>
          <span>
            {[
              cliName(state, undefined, worker.provider),
              worker.model || 'default model',
              worker.effort ? `${effortWords(worker.effort)} effort` : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
          <span className="sd-meta">
            {workspace
              ? `Workspace mode: it works inside each run's private folder with the tools its CLI allows.`
              : 'Text mode: no tools; the controller hands it the files and takes back what it returns.'}
            {claude && workspace
              ? state.agentPermissions?.auto
                ? ' Auto mode decides which commands it may run.'
                : ' Commands outside your approved list are refused.'
              : ''}
          </span>
        </>
      )}
      {!changing ? (
        <button type="button" className="sd-link" style={{ alignSelf: 'flex-start' }} onClick={() => setChanging(true)}>
          Change how {name} runs
        </button>
      ) : (
        <form
          className="sd-detail"
          style={{ gap: 'var(--space-10)' }}
          onSubmit={event => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <span className="sd-meta">
            For future runs{worker.projectId ? '' : `, in every project ${name} works in`}. A run already going keeps
            the settings it started with.
          </span>
          <ExecutionFields adapters={adapters} value={value} onChange={setValue} />
          <span style={{ display: 'flex', gap: 'var(--space-10)', alignItems: 'center' }}>
            <Toggle label={`Pause new work for ${name}`} on={paused} onChange={() => setPaused(!paused)} />
            Pause new work for {name}
          </span>
          <span style={{ display: 'flex', gap: 'var(--space-8)' }}>
            <button className="sd-btn sd-btn--sm sd-btn--primary" disabled={save.isPending}>
              Save for future runs
            </button>
            <button type="button" className="sd-btn sd-btn--sm sd-btn--ghost" onClick={() => setChanging(false)}>
              Cancel
            </button>
          </span>
        </form>
      )}
    </section>
  );
}

const outcome = (attempt: AttemptSummary) =>
  attempt.subscriptionHold
    ? { tone: 'wait', word: 'paused for a usage limit' }
    : attempt.status === 'accepted'
      ? { tone: 'ok', word: 'accepted' }
      : attempt.status === 'review'
        ? { tone: 'you', word: 'waiting for you' }
        : attempt.status === 'revision_requested'
          ? { tone: 'you', word: 'sent back' }
          : attempt.status === 'cancelled'
            ? { tone: 'wait', word: 'cancelled' }
            : { tone: 'bad', word: 'stopped' };

// The agent's last runs as dots, newest first, and in words.
function RecentRuns({ attempts }: { attempts: AttemptSummary[] }) {
  const recent = attempts.slice(0, 8),
    counts = new Map<string, number>();
  for (const attempt of recent) counts.set(outcome(attempt).word, (counts.get(outcome(attempt).word) ?? 0) + 1);
  const words = [...counts].map(([word, count]) =>
    count === 1 ? word : `${word} ${count === 2 ? 'twice' : `${count} times`}`,
  );
  return (
    <section
      className="sd-card sd-sidecard sd-sidecard--roomy"
      aria-labelledby="agent-recent"
      style={{ gap: 'var(--space-10)' }}
    >
      <h2 id="agent-recent" className="sd-sidecard__title">
        Recent runs
      </h2>
      {recent.length ? (
        <>
          <span className="sd-rundots" aria-hidden="true">
            {recent.map(attempt => (
              <i
                key={attempt.id}
                className={`sd-rundots__${outcome(attempt).tone}`}
                title={`${outcome(attempt).word} · ${when(attempt.finishedAt)}`}
              ></i>
            ))}
          </span>
          <span className="sd-meta">{words.join(', ').replace(/^./, letter => letter.toUpperCase())}.</span>
        </>
      ) : (
        <span className="sd-meta">No runs yet.</span>
      )}
    </section>
  );
}

// A new name for the agent. A shared agent's shows in every project, so it is checked against every agent. The form
// is mounted only while the dialog is open, so it starts from the current name each time.
function Rename({
  projectId,
  worker,
  name,
  open,
  onClose,
}: {
  projectId: string;
  worker: Worker;
  name: string;
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const save = useMutation({
    mutationFn: (value: string) =>
      send(
        `/api/workers/${encodeURIComponent(worker.id)}`,
        { projectId, displayName: value, expectedVersion: worker.configVersion ?? 1 },
        'PATCH',
      ),
    onSuccess: (_, value) => {
      toast(`${name} is now called ${value.trim()}.`);
      onClose();
    },
  });
  const close = () => {
    save.reset();
    onClose();
  };
  return (
    <Dialog open={open} label={`Rename ${name}`} busy={save.isPending} onClose={close}>
      <RenameForm
        name={name}
        shared={!worker.projectId}
        saving={save.isPending}
        error={save.error}
        onSave={value => save.mutate(value)}
        onClose={close}
      />
    </Dialog>
  );
}

function RenameForm({
  name,
  shared,
  saving,
  error,
  onSave,
  onClose,
}: {
  name: string;
  shared: boolean;
  saving: boolean;
  error: Error | null;
  onSave: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(name);
  return (
    <form
      className="sd-dialog__form"
      onSubmit={event => {
        event.preventDefault();
        onSave(value);
      }}
    >
      <h2 className="sd-dialog__title">Rename {name}</h2>
      <div className="sd-field">
        <label className="sd-field__label" htmlFor="agent-name">
          Name
        </label>
        <input
          id="agent-name"
          className="sd-input"
          value={value}
          required
          maxLength={40}
          autoComplete="off"
          onChange={event => setValue(event.target.value)}
        />
        {shared && <span className="sd-meta">{name} is shared, so the new name shows in every project.</span>}
      </div>
      {error && (
        <p role="alert" className="sd-meta" style={{ margin: 0, color: 'var(--bad)' }}>
          {error.message}
        </p>
      )}
      <div className="sd-dialog__actions">
        <button type="submit" className="sd-btn sd-btn--primary" disabled={saving || !value.trim()}>
          Rename
        </button>
        <button type="button" className="sd-btn sd-btn--ghost" disabled={saving} onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// Deleting an agent made in this project: it leaves the project's teams for good, and the work it did keeps its
// name. The controller refuses while it runs or has open work, and for the project's last agent, and says why.
function DeleteAgent({
  projectId,
  state,
  worker,
  name,
  open,
  onClose,
}: {
  projectId: string;
  state: StudioState;
  worker: Worker;
  name: string;
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast(),
    navigate = useNavigate();
  const remove = useMutation({
    mutationFn: () =>
      send(`/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(worker.id)}/delete`, {
        projectId,
        expectedRevision: state.organizationConfiguration?.revision ?? 0,
      }),
    onSuccess: () => {
      toast(`Deleted ${name}. The work ${name} did keeps ${name}'s name.`);
      onClose();
      void navigate({ to: '/p/$projectId/agents', params: { projectId } });
    },
  });
  const close = () => {
    remove.reset();
    onClose();
  };
  return (
    <Dialog open={open} label={`Delete ${name}?`} busy={remove.isPending} onClose={close}>
      <div className="sd-dialog__form">
        <h2 className="sd-dialog__title">Delete {name}?</h2>
        <p style={{ margin: 0 }}>
          {name} leaves {state.project.name}&apos;s teams for good. The work {name} did stays on the record under {name}
          &apos;s name. It can&apos;t be undone.
        </p>
        <p className="sd-meta" style={{ margin: 0 }}>
          Work {name} is doing or has open has to finish or be closed first.
        </p>
        {remove.error && (
          <p role="alert" className="sd-meta" style={{ margin: 0, color: 'var(--bad)' }}>
            {remove.error.message}
          </p>
        )}
        <div className="sd-dialog__actions">
          <button
            type="button"
            className="sd-btn sd-btn--danger"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? 'Deleting…' : `Delete ${name}`}
          </button>
          <button type="button" className="sd-btn sd-btn--ghost" disabled={remove.isPending} onClick={close}>
            Cancel
          </button>
        </div>
      </div>
    </Dialog>
  );
}

// The picked agent's editor, beside the flow on the Agents page, never in a dialog: its head, with its face, name and
// what it is doing now; then what it does, what it runs on, what it can use and what it is told; then its work, what
// is running now and its recent runs. Giving it a kind of work saves the project's whole organization
// (organization.ts); how it runs saves on the agent, for runs that start after the save. What it can use and what it is
// told are read here and changed in Settings and on its told page. Any agent can be renamed here; one made in this
// project (1.0.1) can also be deleted, and its past work keeps its name. The controller checks every save.
import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { send, type AttemptSummary, type Execution, type ToldLayer, type ToldView, type Worker } from './api';
import { AgentAvatar } from './design/avatar';
import { Dialog } from './design/dialog';
import { FacePicker } from './design/face-picker';
import { agentState } from './faces';
import type { AgentLook } from './design/agent-kit.js';
import { Icon } from './design/icons';
import { effortWords, openPhaseOf, plural, spoken, testingPhases } from './evidence';
import { cleanExecution, ExecutionFields } from './execution-fields';
import { isCodeProject } from './frame';
import { Toggle } from './layout';
import { giveKind, organizationBody, useSaveOrganization } from './organization';
import { usePeople, useSettled } from './records';
import { ruleLabel, useTold } from './rules';
import { cliName } from './story';
import { liveSummary, type StudioState } from './studio-runs';
import { TaskRow } from './task-row';
import { placeIn, when } from './today';
import { useToast } from './toast';
import { useNow } from './use-now';
import { useVisualView } from './visual-check';

const kindOf = (attempt?: AttemptSummary) => (attempt?.assignment as { kind?: string } | undefined)?.kind;
export const isReview = (attempt?: AttemptSummary) =>
  ['studio-development:change-review', 'general:review'].includes(kindOf(attempt) ?? '');

// What an agent runs on: its CLI, model and effort.
export const runsOn = (state: StudioState, worker: Worker) =>
  [
    cliName(state, undefined, worker.provider),
    worker.model || 'default model',
    worker.effort ? effortWords(worker.effort) : '',
  ]
    .filter(Boolean)
    .join(' · ');
export const kindLabel = (state: StudioState, kind: string) => state.taskKinds[kind]?.label ?? kind;
// Who owns each kind of work: the project's saved organization, or for a project still on the shared one, the
// shared owners its staffing reads.
export function kindOwners(state: StudioState) {
  const config = state.organizationConfiguration;
  return (config && !config.inherited ? config.kindOwners : (state.kindOwners ?? config?.kindOwners)) ?? {};
}

// The sets of rules an agent reads that belong to the project, after the ones every project shares.
export const toldSets: [ToldLayer['layer'], (view: ToldView) => string][] = [
  ['project', () => "The project's rules"],
  ['team', view => `${view.agent.team}'s rules`],
  ['own', view => `${view.agent.name}'s own rules`],
];

const sectionStyle = { flex: '1 1 300px', minWidth: 0, gap: 'var(--space-10)' } as const;
const listStyle = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-6)',
} as const;

export function AgentEditor({
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
    execution = runsOn(state, worker);
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
          Each run is its own process in its own folder, so {name} can run several at once, in this project and others;
          Attempts at the same time in Settings caps how many attempts run together across every project.
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
        <Does projectId={projectId} state={state} worker={worker} name={name} />
        <RunsOn projectId={projectId} state={state} worker={worker} name={name} />
        <CanUse projectId={projectId} state={state} worker={worker} name={name} />
        <IsTold projectId={projectId} worker={worker} name={name} />
      </div>
      <div className="sd-agentgrid">
        <Work projectId={projectId} state={state} worker={worker} tasks={tasks} />
        <aside
          style={{ flex: '1 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-14)' }}
        >
          <RunningNow projectId={projectId} state={state} running={running} name={name} />
          <RecentRuns attempts={attempts.filter(item => !['running', 'stopping'].includes(item.status))} />
        </aside>
      </div>
    </div>
  );
}

// The kinds of work the agent is the default for, and another one given to it: a kind the project does not take yet
// is taken from now on, and one another agent does moves to this one. The controller gives a kind only to an enabled
// agent on one of the project's teams.
function Does({
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
  const id = useId(),
    toast = useToast(),
    save = useSaveOrganization(projectId),
    [kind, setKind] = useState(''),
    owners = kindOwners(state),
    mine = Object.keys(owners).filter(item => owners[item] === worker.id),
    offered = Object.keys(state.taskKinds).filter(item => owners[item] !== worker.id),
    takes = state.organizationConfiguration?.taskKinds ?? Object.keys(state.taskKinds),
    member = organizationBody(state).members.some(item => item.workerId === worker.id),
    ownerName = (item: string) => {
      const owner = owners[item];
      if (!owner || owner === worker.id) return null;
      const agent = [...state.workers, ...(state.employeeDirectory ?? [])].find(entry => entry.id === owner);
      return agent?.displayName ?? owner;
    },
    // Each kind in words beside its name: who does it now, or that the project does not take it yet and giving it
    // turns it on.
    aside = (item: string) => {
      const owner = ownerName(item);
      return owner
        ? ` · ${owner} does it now`
        : takes.includes(item)
          ? ''
          : ' · Not taken yet: giving it turns it on for the project';
    },
    chosen = kind && offered.includes(kind) ? kind : '';
  const give = () =>
    save.mutate(giveKind(organizationBody(state), chosen, worker.id), {
      onSuccess: () => {
        toast(`${name} does ${kindLabel(state, chosen)} from now on.`);
        setKind('');
      },
    });
  return (
    <section className="sd-card sd-sidecard sd-sidecard--roomy" aria-labelledby="agent-does" style={sectionStyle}>
      <h2 id="agent-does" className="sd-sidecard__title">
        Does
      </h2>
      {mine.length ? (
        <ul aria-label={`What ${name} does`} style={{ ...listStyle, flexDirection: 'row', flexWrap: 'wrap' }}>
          {mine.map(item => (
            <li key={item} className="sd-chip">
              {kindLabel(state, item)}
            </li>
          ))}
        </ul>
      ) : (
        <span className="sd-meta">No kind of work of its own yet: its work is chosen for it each time.</span>
      )}
      {worker.enabled === false || !member ? (
        <span className="sd-meta">
          {worker.enabled === false
            ? `No CLI runs ${name} yet, so it is given no kind of work of its own.`
            : `${name} is on none of ${state.project.name}'s teams, so it is given no kind of work of its own.`}
        </span>
      ) : offered.length ? (
        <form
          className="sd-field"
          onSubmit={event => {
            event.preventDefault();
            if (chosen) give();
          }}
        >
          <label className="sd-field__label" htmlFor={`${id}-kind`}>
            Give it another kind of work
          </label>
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-8)' }}>
            <select
              id={`${id}-kind`}
              className="sd-select"
              style={{ flex: '1 1 180px', width: 'auto', minWidth: 0 }}
              value={chosen}
              disabled={save.isPending}
              onChange={event => {
                save.reset();
                setKind(event.target.value);
              }}
            >
              <option value="">Choose a kind of work</option>
              {offered.map(item => (
                <option key={item} value={item}>
                  {kindLabel(state, item)}
                  {aside(item)}
                </option>
              ))}
            </select>
            <button type="submit" className="sd-btn sd-btn--sm" disabled={!chosen || save.isPending}>
              Give it to {name}
            </button>
          </span>
          <span className="sd-meta">
            {chosen && ownerName(chosen)
              ? `${ownerName(chosen)} does ${kindLabel(state, chosen)} now; it moves to ${name}.`
              : chosen && !takes.includes(chosen)
                ? `${state.project.name} does not take ${kindLabel(state, chosen)} yet; it takes it from now on, with ${name} doing it.`
                : `A kind another agent does moves to ${name}. Work that starts after you save goes to ${name}.`}
          </span>
          {save.error && (
            <span role="alert" className="sd-meta" style={{ color: 'var(--bad)' }}>
              {save.error.message}
            </span>
          )}
        </form>
      ) : (
        <span className="sd-meta">{name} does every kind of work the studio has.</span>
      )}
    </section>
  );
}

type RunsOnValue = Required<Execution> & { paused: boolean };

// Which CLI, model and effort the agent runs on, and whether it takes new work, saved on the agent for runs that start
// after the save; Undo puts back the saved values without sending anything.
function RunsOn({
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
    saved: RunsOnValue = {
      provider: worker.provider ?? '',
      model: worker.model ?? '',
      effort: worker.effort ?? '',
      mode: worker.mode ?? '',
      paused: !!worker.paused,
    },
    // The director's edits, none until a field changes, so the fields follow the saved values until then.
    [draft, setDraft] = useState<RunsOnValue | null>(null),
    value = draft ?? saved,
    body = (item: RunsOnValue) => ({ ...cleanExecution(adapters, item), paused: item.paused }),
    changed = JSON.stringify(body(value)) !== JSON.stringify(body(saved));
  const save = useMutation({
    mutationFn: (item: RunsOnValue) =>
      send(
        `/api/workers/${encodeURIComponent(worker.id)}`,
        { projectId, ...body(item), expectedVersion: worker.configVersion ?? 1 },
        'PATCH',
      ),
    onSuccess: () => toast('Saved for runs that start from now.'),
  });
  const edit = (next: Partial<RunsOnValue>) => setDraft({ ...value, ...next });
  return (
    <section className="sd-card sd-sidecard sd-sidecard--roomy" aria-labelledby="agent-runs-on" style={sectionStyle}>
      <h2 id="agent-runs-on" className="sd-sidecard__title">
        Runs on
      </h2>
      <form
        className="sd-detail"
        style={{ gap: 'var(--space-10)' }}
        onSubmit={event => {
          event.preventDefault();
          if (changed) save.mutate(value);
        }}
      >
        {worker.enabled === false && <span style={{ color: 'var(--ink-2)' }}>No CLI runs {name} yet.</span>}
        <ExecutionFields adapters={adapters} value={value} onChange={next => edit(next)} />
        <span style={{ display: 'flex', gap: 'var(--space-10)', alignItems: 'center' }}>
          <Toggle
            label={`Pause new work for ${name}`}
            on={value.paused}
            onChange={() => edit({ paused: !value.paused })}
          />
          Pause new work for {name}
        </span>
        <span className="sd-meta">Paused, {name} starts no new work; what is running finishes first.</span>
        <span className="sd-meta">
          Save applies to runs that start after it{worker.projectId ? '' : `, in every project ${name} works in`}. A run
          already going keeps the settings it started with.
        </span>
        {save.error && (
          <span role="alert" className="sd-meta" style={{ color: 'var(--bad)' }}>
            {save.error.message}
          </span>
        )}
        <span style={{ display: 'flex', gap: 'var(--space-8)' }}>
          <button className="sd-btn sd-btn--sm sd-btn--primary" disabled={!changed || save.isPending}>
            Save
          </button>
          <button
            type="button"
            className="sd-btn sd-btn--sm sd-btn--ghost"
            disabled={!changed || save.isPending}
            onClick={() => {
              save.reset();
              setDraft(null);
            }}
          >
            Undo
          </button>
        </span>
      </form>
    </section>
  );
}

// What the agent may use beyond its job folder: for a Claude Code agent in workspace mode, the commands approved in
// Settings or auto mode; and for a code project, whether the visual check captures its stories' pages.
function CanUse({
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
  const code = isCodeProject(state),
    visual = useVisualView(projectId, code),
    workspace = (worker.mode || 'workspace') === 'workspace',
    claude = worker.provider === 'claude' && workspace,
    auto = state.agentPermissions?.auto === true,
    commands = state.agentPermissions?.commands ?? [];
  return (
    <section className="sd-card sd-sidecard sd-sidecard--roomy" aria-labelledby="agent-can-use" style={sectionStyle}>
      <h2 id="agent-can-use" className="sd-sidecard__title">
        Can use
      </h2>
      <span className="sd-meta">
        {workspace
          ? `Workspace mode: ${name} works inside each run's private folder with the tools its CLI allows.`
          : 'Text mode: no tools; the controller hands it the files and takes back what it returns.'}
      </span>
      {claude &&
        (auto ? (
          <span>Auto mode: Claude Code&apos;s own classifier decides which commands {name} runs.</span>
        ) : (
          <>
            <span className="sd-eyebrow">Approved commands</span>
            {commands.length ? (
              <ul className="sd-commands" aria-label="Approved commands">
                {commands.map(command => (
                  <li key={command}>
                    <code className="sd-file">{command}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="sd-meta">No commands approved yet.</span>
            )}
            <span className="sd-meta">
              Commands outside the approved list are refused. You approve them in Settings, under Command-line tools.
            </span>
          </>
        ))}
      {code && (
        <span>
          {visual.error
            ? `The visual check could not be read: ${visual.error.message}`
            : !visual.data
              ? 'Reading the visual check…'
              : visual.data.settings.enabled
                ? "The visual check is on: before a story's review, the pages it names are captured for the reviewer."
                : 'The visual check is off.'}
        </span>
      )}
      <span className="sd-meta">
        Tools come later: for now {name} has its CLI&apos;s own tools and what is listed here.
      </span>
    </section>
  );
}

// What the agent is told: its own rules' revision and names, and how many rules it reads from the project, its team
// and its own, as published; its told page shows and changes them.
function IsTold({ projectId, worker, name }: { projectId: string; worker: Worker; name: string }) {
  const { data: view, error } = useTold(projectId, worker.id),
    own = view?.layers.find(layer => layer.layer === 'own');
  return (
    <section className="sd-card sd-sidecard sd-sidecard--roomy" aria-labelledby="agent-is-told" style={sectionStyle}>
      <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 'var(--space-8)' }}>
        <h2 id="agent-is-told" className="sd-sidecard__title">
          Is told
        </h2>
        {own && <span className="sd-meta">revision {own.revision}</span>}
      </span>
      {view ? (
        <>
          <ul aria-label={`How many rules ${name} reads`} style={listStyle}>
            {toldSets.map(([layer, label]) => {
              const set = view.layers.find(item => item.layer === layer);
              return (
                set && (
                  <li key={layer} style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-8)' }}>
                    <span>{label(view)}</span>
                    <span className="sd-meta">
                      {set.rules.length} {plural(set.rules.length, 'rule')}
                    </span>
                  </li>
                )
              );
            })}
          </ul>
          {own?.rules.length ? (
            <ol aria-label={`${name}'s own rules`} style={{ margin: 0, paddingLeft: '22px' }}>
              {own.rules.map((rule, index) => (
                <li key={index}>{ruleLabel(rule)}</li>
              ))}
            </ol>
          ) : (
            <span className="sd-meta">No rules of its own yet.</span>
          )}
          {own?.draft?.current && (
            <span className="sd-meta">A draft of its own rules waits; it changes nothing until it is published.</span>
          )}
        </>
      ) : (
        <span className="sd-meta">
          {error
            ? error.message
            : view === null
              ? `${name} is not in this project's records.`
              : 'Reading what it is told…'}
        </span>
      )}
      <Link
        className="sd-btn sd-btn--sm"
        style={{ alignSelf: 'flex-start' }}
        to="/p/$projectId/agents/$workerId/told"
        params={{ projectId, workerId: worker.id }}
      >
        Open what it is told
      </Link>
    </section>
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

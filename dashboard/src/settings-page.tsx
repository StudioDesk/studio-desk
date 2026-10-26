// Settings, as the canvas draws it (v1.0 item 23): a section nav beside the sections. This project: its name, goal
// and direction, its repository, its house rules, its workflows and its records. Every project: running work, the
// command-line tools, the projects on this computer and the appearance, which belong to this computer, so a change
// there reaches every project. Every change applies to work that starts after it.
import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState, type ReactNode } from 'react';
import { send, type KindModes, type Mode, type Project, type RepositoryInspection, type TestSandbox } from './api';
import { BuiltInSandboxSetup } from './built-in-sandbox';
import { AgentAvatar } from './design/avatar';
import { Clapper, Icon, StudioMark } from './design/icons';
import { agentLooks } from './today';
import { projectColor, projectKind, projectPalette } from './frame';
import { DeleteProject } from './delete-project';
import { CycleWarning } from './home-page';
import { Toggle } from './layout';
import { NewProject } from './new-project';
import { ClaudeCommands } from './permissions';
import { ProfileDialog } from './profile-dialog';
import { queryKeys, useStudio } from './records';
import { usageHolds, type StudioState } from './studio-runs';
import { useToast } from './toast';

// A settings page's trail: Home, then Settings.
export function settingsTrail(projectId: string) {
  return [
    <Link key="home" to="/p/$projectId" params={{ projectId }}>
      Home
    </Link>,
    <Link key="settings" to="/p/$projectId/settings" params={{ projectId }}>
      Settings
    </Link>,
  ];
}

const sections = [
  { id: 'general', label: 'General', group: 'This project' },
  { id: 'repository', label: 'Repository' },
  { id: 'rules', label: 'House rules' },
  { id: 'workflows', label: 'Workflows' },
  { id: 'records', label: 'Records' },
  { id: 'running', label: 'Running work', group: 'Every project' },
  { id: 'tools', label: 'Command-line tools' },
  { id: 'projects', label: 'Projects' },
  { id: 'appearance', label: 'Appearance' },
];

const day = (value?: string) =>
  value ? new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';

function Section({
  id,
  title,
  shared,
  aside,
  children,
}: {
  id: string;
  title: string;
  shared?: boolean;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="sd-card sd-setsec" aria-labelledby={`${id}-title`}>
      <div className="sd-setsec__head" style={aside ? { justifyContent: 'space-between' } : undefined}>
        <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-10)' }}>
          <h2 id={`${id}-title`} className="sd-setsec__title">
            {title}
          </h2>
          {shared && <span className="sd-chip sd-chip--shared">Every project</span>}
        </span>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Row({
  title,
  note,
  first,
  children,
}: {
  title: ReactNode;
  note?: ReactNode;
  first?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={`sd-setrow${first ? ' sd-setrow--first' : ''}`}>
      <span className="sd-setrow__text">
        <b>{title}</b>
        {note && <span className="sd-meta">{note}</span>}
      </span>
      {children}
    </div>
  );
}

// The section nav, which marks the section in view.
function SubNav() {
  const [current, setCurrent] = useState('general');
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const shown = new Map<string, boolean>();
    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) shown.set(entry.target.id, entry.isIntersecting);
        const first = sections.find(section => shown.get(section.id));
        if (first) setCurrent(first.id);
      },
      { rootMargin: '-10% 0px -60% 0px' },
    );
    for (const section of sections) {
      const element = document.getElementById(section.id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, []);
  return (
    <nav className="sd-subnav" aria-label="Settings sections">
      {sections.map(section => (
        <SubNavItem key={section.id} section={section} current={current === section.id} />
      ))}
    </nav>
  );
}

function SubNavItem({ section, current }: { section: (typeof sections)[number]; current: boolean }) {
  return (
    <>
      {section.group && <span className="sd-eyebrow">{section.group}</span>}
      <a href={`#${section.id}`} aria-current={current ? 'true' : undefined}>
        {section.label}
      </a>
    </>
  );
}

function General({ projectId, state, index }: { projectId: string; state: StudioState; index: number }) {
  const project = state.project,
    // The color is the palette's name, or empty for the one the project's place gives it.
    saved = {
      name: project.name,
      goal: project.goal ?? '',
      direction: project.direction ?? '',
      color: project.color ?? '',
    },
    [draft, setDraft] = useState(saved),
    directed = draft.name !== saved.name || draft.goal !== saved.goal || draft.direction !== saved.direction,
    changed = directed || draft.color !== saved.color,
    shown = projectColor({ color: draft.color }, index).background,
    toast = useToast();
  const save = useMutation({
    mutationFn: () =>
      send(
        `/api/projects/${encodeURIComponent(projectId)}`,
        { projectId, expectedRevision: project.revision, ...draft, color: draft.color || null },
        'PATCH',
      ),
    onSuccess: () => toast(directed ? 'Saved. Attempts that start from now on read it.' : 'Saved.'),
    onError: error => toast(error.message),
  });
  const pause = useMutation({
    mutationFn: () => send('/api/pipeline', { projectId, action: project.dispatchPaused ? 'resume' : 'pause' }),
    onError: error => toast(error.message),
  });
  const set = (field: keyof typeof saved) => (value: string) => setDraft(current => ({ ...current, [field]: value }));
  return (
    <Section id="general" title="General">
      <div className="sd-field">
        <label className="sd-field__label" htmlFor="settings-name">
          Name
        </label>
        <input
          id="settings-name"
          className="sd-input"
          value={draft.name}
          maxLength={100}
          onChange={event => set('name')(event.target.value)}
        />
      </div>
      <div className="sd-field">
        <label className="sd-field__label" htmlFor="settings-goal">
          Goal
        </label>
        <textarea
          id="settings-goal"
          className="sd-textarea"
          rows={3}
          value={draft.goal}
          onChange={event => set('goal')(event.target.value)}
        />
      </div>
      <div className="sd-field">
        <label className="sd-field__label" htmlFor="settings-direction">
          Standing direction{' '}
          <span className="sd-meta" style={{ fontWeight: 500 }}>
            ·{' '}
            {[project.revision ? `revision ${project.revision}` : '', day(project.updatedAt ?? project.createdAt)]
              .filter(Boolean)
              .join(', ')}{' '}
            · every attempt in this project reads it
          </span>
        </label>
        <textarea
          id="settings-direction"
          className="sd-textarea"
          rows={4}
          value={draft.direction}
          onChange={event => set('direction')(event.target.value)}
        />
      </div>
      <div className="sd-field" role="group" aria-labelledby="settings-color">
        <span id="settings-color" className="sd-field__label">
          Color
        </span>
        <div className="sd-swatches">
          {projectPalette.map(color => (
            <button
              key={color.id}
              type="button"
              className="sd-swatch"
              aria-pressed={shown === color.background}
              aria-label={color.name}
              title={color.name}
              style={{ background: color.background }}
              onClick={() => set('color')(color.id)}
            />
          ))}
          <span className="sd-meta">
            Marks this project on the rail and on its idea box, so you always know where an idea goes.
          </span>
        </div>
      </div>
      <Row
        title="Pause this project"
        note="Work that is running finishes; nothing new starts here. Other projects keep going."
      >
        <Toggle
          label="Pause this project"
          on={!!project.dispatchPaused}
          disabled={pause.isPending}
          onChange={() => pause.mutate()}
        />
      </Row>
      <div style={{ display: 'flex', gap: 'var(--space-8)' }}>
        <button
          type="button"
          className="sd-btn sd-btn--primary"
          disabled={!changed || !draft.name.trim() || save.isPending}
          onClick={() => save.mutate()}
        >
          Save
        </button>
        <button type="button" className="sd-btn sd-btn--ghost" disabled={!changed} onClick={() => setDraft(saved)}>
          Discard changes
        </button>
      </div>
      <Row
        title="Delete this project"
        note="Removes it and everything Studio desk recorded for it. A repository or folder you chose keeps everything."
      >
        <DeleteProject projectId={projectId} name={project.name} />
      </Row>
    </Section>
  );
}

const size = (bytes: number) =>
  bytes >= 1048576 ? `${Math.round((bytes / 1048576) * 10) / 10} MiB` : `${Math.round(bytes / 1024)} KiB`;
const chips = (items: string[]) =>
  items.map(item => (
    <span key={item} className="sd-file">
      {item}
    </span>
  ));

// What a project's own repository looks like now (Check again): its branch, whether its tree is clean, and the
// profile's revision. A project on the controller's own source has the built-in profile and none of them.
function Repository({ projectId, state }: { projectId: string; state: StudioState }) {
  const source = state.project.source,
    profile = source?.profile,
    toast = useToast(),
    [editing, setEditing] = useState(false);
  const check = useMutation({
    mutationFn: () =>
      send<RepositoryInspection & { clean: boolean }>(`/api/projects/${encodeURIComponent(projectId)}/source/inspect`, {
        projectId,
      }),
    onError: error => toast(error.message),
  });
  const found = check.data;
  return (
    <Section
      id="repository"
      title="Repository"
      aside={
        source && (
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-8)', alignItems: 'center' }}>
            {found && (
              <span className={`sd-chip ${found.clean && !found.problems.length ? 'sd-chip--ok' : 'sd-chip--you'}`}>
                <span className="sd-chip__dot"></span>
                {found.problems.length
                  ? found.clean
                    ? 'A problem to fix'
                    : 'Uncommitted changes'
                  : `Clean · ${found.testFiles ? `${found.testFiles} test file${found.testFiles === 1 ? '' : 's'}` : 'tests found'}`}
              </span>
            )}
            <span className="sd-meta">settings revision {source.revision ?? 1}</span>
          </span>
        )
      }
    >
      <p>
        How the code pipeline works on this repository: what a story may touch, what the planner reads and how changes
        are tested.
      </p>
      {source && profile ? (
        <dl className="sd-kv sd-kv--chips">
          <dt>Repository</dt>
          <dd>
            <span className="sd-file sd-file--path">{source.root}</span>
            {found && (
              <>
                <span className="sd-meta">on branch</span>
                {chips([found.branch])}
              </>
            )}
            <button
              type="button"
              className="sd-btn sd-btn--sm sd-btn--ghost"
              disabled={check.isPending}
              onClick={() => check.mutate()}
            >
              {check.isPending ? 'Checking…' : 'Check again'}
            </button>
          </dd>
          <dt>Stories may change</dt>
          <dd>{chips([...profile.directories.map(folder => `${folder}/`), ...profile.files])}</dd>
          <dt>File types</dt>
          <dd>{chips(profile.extensions.map(extension => `.${extension}`))}</dd>
          <dt>Never touched by a story</dt>
          <dd>{chips(profile.protectedNames)}</dd>
          <dt>Read by the planner and reviews</dt>
          <dd>{chips(profile.contextFiles)}</dd>
          <dt>Tests</dt>
          <dd>
            {chips([`${profile.tests.directory}/*${profile.tests.suffix}`])}
            <span className="sd-meta">
              {state.testSandbox === 'none' ? 'without a sandbox' : 'in the built-in sandbox'}
            </span>
          </dd>
          <dt>Before tests</dt>
          <dd>
            {profile.install === 'npm-ci' ? (
              <>
                <span>Install packages with</span>
                {chips(['npm ci'])}
              </>
            ) : (
              <span>Nothing to install</span>
            )}
          </dd>
          <dt>On integration</dt>
          <dd>
            {profile.formatter ? (
              <>
                <span>Format changed files with</span>
                {chips([[profile.formatter.package, ...profile.formatter.args].join(' ')])}
              </>
            ) : (
              <span>No formatter</span>
            )}
          </dd>
          <dt>Limits</dt>
          <dd>
            <span>
              {profile.limits.files} files · {size(profile.limits.fileBytes)} a file · {size(profile.limits.totalBytes)}{' '}
              in all
            </span>
          </dd>
        </dl>
      ) : null}
      {found?.problems.map(problem => (
        <p key={problem} role="alert" style={{ margin: 0, color: 'var(--ink-2)' }}>
          {problem}
        </p>
      ))}
      {source && profile ? (
        <>
          <div>
            <button type="button" className="sd-btn sd-btn--sm" onClick={() => setEditing(true)}>
              Edit the repository settings
            </button>
          </div>
          <ProfileDialog open={editing} projectId={projectId} source={source} onClose={() => setEditing(false)} />
        </>
      ) : (
        <p className="sd-meta" style={{ margin: 0 }}>
          {projectKind(state)?.startsWith('Code')
            ? "This project works on the controller's own source, with its built-in repository settings."
            : 'This project has no repository: its work is files and findings, not code.'}
        </p>
      )}
    </Section>
  );
}

// The canvas's names for the work each task type does.
const workNames: Record<string, string> = {
  'studio-development:checks': 'Source checks',
  'studio-development:breakdown': 'Plan an idea',
  'studio-development:change': 'Build a story',
  'studio-development:change-review': 'Independent review',
  'studio-development:review': 'Propose an improvement',
  general: 'General work',
  'general:plan': 'Plan an idea',
  'general:work': 'Do the work',
  'general:review': 'Review the work',
};
const order = Object.keys(workNames);
type Step = 'approve' | 'accept' | 'scope' | 'integrate';

function Who({ mode, onClick, label }: { mode: Mode; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      className={`sd-who sd-who--${mode === 'auto' ? 'auto' : 'you'}`}
      aria-label={`${label}: ${mode === 'auto' ? 'the studio' : 'you'}`}
      onClick={onClick}
    >
      {mode === 'auto' ? <StudioMark /> : <Clapper size={22} />}
      {mode === 'auto' ? 'Studio' : 'You'}
    </button>
  );
}

interface RulesDraft {
  enabled: boolean;
  retries: number;
  kinds: Record<string, KindModes>;
}

// House rules (the autonomy policy): who decides at each gate, task type by task type. A tap switches a cell in a
// draft; Save records a new revision, which applies to results from then on.
function HouseRules({ projectId, state }: { projectId: string; state: StudioState }) {
  const policy = state.autonomy?.policy ?? {},
    available = Object.entries(state.taskKinds)
      .filter(([, definition]) => definition.available)
      .sort(([a], [b]) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)),
    from = (): RulesDraft => ({
      enabled: !!policy.enabled,
      retries: policy.retries ?? 0,
      kinds: Object.fromEntries(
        available.map(([kind]) => [kind, { approve: 'director', accept: 'director', ...policy.kinds?.[kind] }]),
      ),
    }),
    [draft, setDraft] = useState<RulesDraft>(from),
    changed = JSON.stringify(draft) !== JSON.stringify(from()),
    [history, setHistory] = useState(false),
    toast = useToast();
  const save = useMutation({
    mutationFn: () =>
      send(`/api/projects/${encodeURIComponent(projectId)}/autonomy`, {
        projectId,
        expectedRevision: policy.revision,
        enabled: draft.enabled,
        retries: draft.retries,
        // A step a task type does not have is left out, as the current dashboard's form does.
        kinds: Object.fromEntries(
          Object.entries(draft.kinds).map(([kind, mode]) => [
            kind,
            {
              approve: mode.approve,
              accept: mode.accept,
              ...(state.taskKinds[kind]?.scopeRequestLabel ? { scope: mode.scope ?? 'director' } : {}),
              ...(state.taskKinds[kind]?.integrationLabel ? { integrate: mode.integrate ?? 'director' } : {}),
            },
          ]),
        ),
        cycle: { ...policy.cycle },
      }),
    onSuccess: () => toast('House rules saved. They apply to results from now on.'),
    onError: error => toast(error.message),
  });
  const flip = (kind: string, step: Step) =>
    setDraft(current => {
      const mode = current.kinds[kind]!,
        now = (mode[step] ?? 'director') as Mode;
      return {
        ...current,
        kinds: { ...current.kinds, [kind]: { ...mode, [step]: now === 'auto' ? 'director' : 'auto' } },
      };
    });
  const revisions = (
    (policy as { history?: { revision?: number; savedAt?: string; enabled?: boolean }[] }).history ?? []
  )
    .slice()
    .reverse();
  return (
    <Section
      id="rules"
      title="House rules"
      aside={
        <span style={{ display: 'flex', gap: 'var(--space-8)', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="sd-btn sd-btn--sm"
            onClick={() =>
              setDraft(current => ({
                enabled: true,
                retries: 1,
                kinds: Object.fromEntries(
                  Object.keys(current.kinds).map(kind => [
                    kind,
                    state.autonomy?.recommended?.[kind] ?? { approve: 'director', accept: 'director' },
                  ]),
                ),
              }))
            }
          >
            Use recommended
          </button>
          {policy.revision ? (
            <button
              type="button"
              className="sd-btn sd-btn--sm sd-btn--ghost"
              aria-expanded={history}
              onClick={() => setHistory(!history)}
            >
              Revision {policy.revision} · history
            </button>
          ) : null}
        </span>
      }
    >
      <p>Who decides at each gate. Tap a cell to switch it between you and the studio.</p>
      {history && revisions.length > 0 && (
        <ul className="sd-meta" style={{ margin: 0, paddingLeft: '18px' }}>
          {revisions.map(item => (
            <li key={item.revision}>
              Revision {item.revision} · {day(item.savedAt)} · {item.enabled ? 'on' : 'every step waited for you'}
            </li>
          ))}
        </ul>
      )}
      <Row
        first
        title="The studio takes the steps marked Studio"
        note={
          draft.enabled
            ? 'On. Steps marked Studio run on their own while their checks pass; anything else waits for you.'
            : 'Off. Every step waits for you, whatever the table says.'
        }
      >
        <Toggle
          label="The studio takes the steps marked Studio"
          on={draft.enabled}
          onChange={() => setDraft(current => ({ ...current, enabled: !current.enabled }))}
        />
      </Row>
      <div style={{ overflowX: 'auto' }} role="region" aria-label="House rules table" tabIndex={0}>
        <table className="sd-rules">
          <thead>
            <tr>
              <th scope="col">Work</th>
              <th scope="col">Start it</th>
              <th scope="col">Accept the result</th>
              <th scope="col">Extra files</th>
              <th scope="col">Integrate</th>
            </tr>
          </thead>
          <tbody>
            {available.map(([kind, definition]) => {
              const mode = draft.kinds[kind]!,
                name = workNames[kind] ?? definition.label ?? kind,
                cell = (step: Step, label: string, applies = true) =>
                  applies ? (
                    <td>
                      <Who
                        mode={(mode[step] ?? 'director') as Mode}
                        label={`${name}, ${label}`}
                        onClick={() => flip(kind, step)}
                      />
                    </td>
                  ) : (
                    <td>
                      <span className="sd-who sd-who--na" aria-label={`${name}, ${label}: does not apply`}>
                        ·
                      </span>
                    </td>
                  );
              return (
                <tr key={kind}>
                  <th scope="row">{name}</th>
                  {cell('approve', 'start it')}
                  {cell('accept', 'accept the result')}
                  {cell('scope', 'extra files', !!definition.scopeRequestLabel)}
                  {cell('integrate', 'integrate', !!definition.integrationLabel)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="sd-meta" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 22px' }}>
        <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-8)' }}>
          <b style={{ color: 'var(--ink)' }}>When something fails:</b>
          <span className="sd-segmented" role="group" aria-label="When something fails">
            {(
              [
                [1, 'Retry once with the failure details, then ask you'],
                [0, 'Ask you'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={draft.retries === value}
                onClick={() => setDraft(current => ({ ...current, retries: value }))}
              >
                {label}
              </button>
            ))}
          </span>
        </span>
        <span>
          <b style={{ color: 'var(--ink)' }}>Failing tests on the live source</b> always stop for you.
        </span>
      </div>
      {changed && (
        <div style={{ display: 'flex', gap: 'var(--space-8)' }}>
          <button
            type="button"
            className="sd-btn sd-btn--primary"
            disabled={save.isPending}
            onClick={() => save.mutate()}
          >
            Save house rules
          </button>
          <button type="button" className="sd-btn sd-btn--ghost" onClick={() => setDraft(from())}>
            Discard changes
          </button>
        </div>
      )}
      <CycleWarning projectId={projectId} state={state} />
    </Section>
  );
}

// What a new idea goes through, in the project's intake order, each step with the agent that does it.
const intakes: Record<string, [string, string][]> = {
  source: [
    ['studio-development:checks', 'Checks'],
    ['studio-development:breakdown', 'Plan into stories'],
    ['studio-development:change', 'Build and test'],
    ['studio-development:change-review', 'Review'],
  ],
  plan: [
    ['general:plan', 'Plan'],
    ['general:work', 'Do the work'],
    ['general:review', 'Review'],
  ],
};

function Workflows({ projectId, state }: { projectId: string; state: StudioState }) {
  const kinds = state.organizationConfiguration?.taskKinds ?? [],
    intake = kinds.includes('studio-development:breakdown') ? 'source' : kinds.includes('general:plan') ? 'plan' : null,
    looks = agentLooks(projectId, [...state.workers, ...(state.employeeDirectory ?? [])]),
    owners = state.kindOwners ?? state.organizationConfiguration?.kindOwners ?? {},
    policy = state.autonomy?.policy,
    integrateYours =
      !policy?.enabled || (policy.kinds?.['studio-development:change']?.integrate ?? 'director') === 'director';
  return (
    <Section id="workflows" title="Workflows">
      {intake && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-10)' }}>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 'var(--space-8)',
            }}
          >
            <b>What a new idea goes through</b>
            <span className="sd-chip sd-chip--brand">The New idea box</span>
          </div>
          <div className="sd-pipe">
            {intakes[intake]!.map(([kind, label], index) => {
              const look = looks.get(owners[kind] ?? '');
              return (
                <span key={kind} style={{ display: 'contents' }}>
                  {index > 0 && (
                    <span className="sd-pipe__arrow">
                      <Icon name="arrow" size={16} weight={2.6} />
                    </span>
                  )}
                  <span className="sd-pipe__step">
                    {look && <AgentAvatar look={look} size={26} ring={false} />}
                    {label}
                  </span>
                </span>
              );
            })}
            {intake === 'source' && (
              <>
                <span className="sd-pipe__arrow">
                  <Icon name="arrow" size={16} weight={2.6} />
                </span>
                <span className={`sd-pipe__step${integrateYours ? ' sd-pipe__step--you' : ''}`}>
                  {integrateYours ? <Clapper size={26} /> : <StudioMark size={26} />}
                  Integrate
                </span>
              </>
            )}
          </div>
        </div>
      )}
      {state.workflows.map((workflow, index) => (
        <Row key={workflow.id} first={!intake && index === 0} title={workflow.name} note={workflow.description}>
          <span className="sd-chip">
            {workflow.graph?.nodes?.length ?? workflow.steps?.length ?? 0}{' '}
            {(workflow.graph?.nodes?.length ?? workflow.steps?.length) === 1 ? 'step' : 'steps'}
          </span>
        </Row>
      ))}
      {!intake && !state.workflows.length && (
        <p className="sd-meta" style={{ margin: 0 }}>
          This project has no workflow yet.
        </p>
      )}
    </Section>
  );
}

function Records({ projectId }: { projectId: string }) {
  return (
    <Section id="records" title="Records">
      <Row
        first
        title="Export this project's records"
        note="Tasks, attempts, instructions and logs as JSON. Result files stay in the data folder."
      >
        <a className="sd-btn sd-btn--sm" href={`/api/export?projectId=${encodeURIComponent(projectId)}`} download>
          Export
        </a>
      </Row>
      <Row title="Activity log" note="Every event the controller recorded, newest first.">
        <Link className="sd-btn sd-btn--sm" to="/p/$projectId/settings/activity" params={{ projectId }}>
          Open the log
        </Link>
      </Row>
      <Row
        title="How the project fits together"
        note="Its teams and their agents, and how its kinds of work, tools and connectors connect."
      >
        <span style={{ display: 'flex', gap: 'var(--space-8)', flexWrap: 'wrap' }}>
          <Link className="sd-btn sd-btn--sm sd-btn--ghost" to="/p/$projectId/agents/teams" params={{ projectId }}>
            Teams
          </Link>
          <Link className="sd-btn sd-btn--sm sd-btn--ghost" to="/p/$projectId/settings/platform" params={{ projectId }}>
            Platform map
          </Link>
        </span>
      </Row>
    </Section>
  );
}

function RunningWork({ projectId, state }: { projectId: string; state: StudioState }) {
  const toast = useToast(),
    holds = usageHolds(state),
    limit = state.maxParallel ?? 1,
    // Each agent runs one attempt at a time, so the limit goes no higher than the agents on this computer.
    most = Math.max(1, (state.employeeDirectory ?? state.workers).filter(worker => !worker.deletedAt).length);
  const control = useMutation({
    mutationFn: (body: Record<string, unknown>) => send('/api/control', { projectId, ...body }),
    onError: error => toast(error.message),
  });
  return (
    <Section id="running" title="Running work" shared>
      <Row
        first
        title="Attempts at the same time"
        note="Each agent runs one attempt at a time, as the controller reserves it; this caps how many run at once across every project."
      >
        <span className="sd-stepper" role="group" aria-label="Attempts at the same time">
          <button
            type="button"
            className="sd-btn sd-btn--sm sd-btn--ghost"
            aria-label="Fewer"
            disabled={limit <= 1 || control.isPending}
            onClick={() => control.mutate({ maxParallel: limit - 1 })}
          >
            −
          </button>
          <b aria-live="polite">{limit}</b>
          <button
            type="button"
            className="sd-btn sd-btn--sm sd-btn--ghost"
            aria-label="More"
            disabled={limit >= most || control.isPending}
            onClick={() => control.mutate({ maxParallel: limit + 1 })}
          >
            +
          </button>
        </span>
      </Row>
      <Row title="Pause all new work" note="Running attempts finish; nothing new starts in any project.">
        <Toggle
          label="Pause all new work"
          on={!!state.paused}
          disabled={control.isPending}
          onChange={() => control.mutate({ paused: !state.paused })}
        />
      </Row>
      {(state.leases ?? []).length > 0 && (
        <Row
          title="Reserved now"
          note="What running work holds until it finishes, so nothing else changes it meanwhile."
        >
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-6)' }}>
            {chips([...new Set((state.leases ?? []).map(lease => lease.resource))])}
          </span>
        </Row>
      )}
      {holds.length > 0 && (
        <p className="sd-meta" style={{ margin: 0 }}>
          A usage hold pauses an agent's CLI until its reset; Command-line tools lists each one.
        </p>
      )}
    </Section>
  );
}

// The CLIs this computer runs agents with: whether each is found, its usage hold, and what it decides here. Only
// the CLIs found are listed, all of them when none is, so someone who uses one never reads about the other
// (v1.0 item 25).
function Tools({ projectId, state }: { projectId: string; state: StudioState }) {
  const toast = useToast(),
    holds = new Map(usageHolds(state).map(hold => [hold.provider, hold])),
    subscriptions = Object.values(state.adapters ?? {}).filter(adapter => adapter.subscription),
    adapters = subscriptions.some(adapter => adapter.available)
      ? subscriptions.filter(adapter => adapter.available)
      : subscriptions;
  const control = useMutation({
    mutationFn: (body: Record<string, unknown>) => send('/api/control', { projectId, ...body }),
    onError: error => toast(error.message),
  });
  const users = (id: string) =>
    state.workers
      .filter(worker => worker.enabled !== false && worker.provider === id)
      .map(worker => worker.displayName);
  const sandbox = state.testSandbox ?? 'built-in';
  const chooseSandbox = (value: TestSandbox) => {
    if (
      value === 'none' &&
      !window.confirm(
        'Run candidate tests without a sandbox? Code an agent wrote will run on this computer with your account’s full access to your files and the network.',
      )
    )
      return;
    control.mutate({ testSandbox: value });
  };
  const builtIn = state.builtInSandbox ?? { state: 'unsupported' },
    choices = [
      ['built-in', 'Built-in sandbox'],
      ['none', 'No sandbox'],
    ] as const;
  return (
    <Section id="tools" title="Command-line tools" shared>
      <p>
        Agents work through the CLIs you have signed in to. Studio desk never uses API keys and never falls back to a
        paid API.
      </p>
      {adapters.map(adapter => {
        const held = !!state.quota?.[adapter.id],
          hold = holds.get(adapter.id),
          names = users(adapter.id);
        return (
          <div key={adapter.id} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-10)' }}>
            <Row
              title={adapter.name}
              note={
                names.length
                  ? `${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]} use${names.length > 1 ? '' : 's'} it here.`
                  : 'No agent in this project uses it.'
              }
            >
              <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-6)', alignItems: 'center' }}>
                <span className={`sd-chip${adapter.available ? ' sd-chip--ok' : ' sd-chip--bad'}`}>
                  <span className="sd-chip__dot"></span>
                  {adapter.available ? 'Found · subscription login' : 'Not found'}
                </span>
                <span className={`sd-chip${held ? ' sd-chip--you' : ''}`}>
                  {held ? (hold?.resetAt ? `Usage hold until ${hold.resetTime}` : 'Usage hold') : 'No usage hold'}
                </span>
                {held && (
                  <button
                    type="button"
                    className="sd-btn sd-btn--sm sd-btn--ghost"
                    disabled={control.isPending}
                    onClick={() => control.mutate({ clearQuota: adapter.id })}
                  >
                    Clear the hold
                  </button>
                )}
              </span>
            </Row>
            {adapter.id === 'claude' && <ClaudeCommands projectId={projectId} shell={state} />}
          </div>
        );
      })}
      <div className="sd-field" id="candidate-tests">
        <span className="sd-field__label">Where candidate tests run</span>
        {/* The built-in sandbox, or none by the director's choice, which asks first (1.0.1). */}
        <span
          className="sd-segmented"
          role="group"
          aria-label="Where candidate tests run"
          style={{ alignSelf: 'flex-start' }}
        >
          {choices.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={sandbox === value}
              disabled={control.isPending}
              onClick={() => sandbox !== value && chooseSandbox(value)}
            >
              {label}
            </button>
          ))}
        </span>
        <span className="sd-meta" style={sandbox === 'none' ? { color: 'var(--you)' } : undefined}>
          {sandbox === 'none'
            ? 'Code an agent wrote runs on this computer with your account’s full access to your files and the network.'
            : builtIn.state === 'ready'
              ? 'The built-in sandbox runs tests as a separate Windows account that can change only the copy it tests and reach nothing beyond this computer.'
              : builtIn.state === 'unsupported'
                ? 'The built-in sandbox works only on Windows for now, so code changes can’t run their tests here unless you choose No sandbox.'
                : 'Code changes wait to run their tests until the built-in sandbox is set up.'}
        </span>
        <BuiltInSandboxSetup projectId={projectId} sandbox={builtIn} queryKey={queryKeys.shell(projectId)} />
      </div>
    </Section>
  );
}

const projectLine = (project: Project, state: StudioState) =>
  project.id === state.project.id
    ? projectKind(state)
    : project.source
      ? `Code · ${project.source.root.split(/[\\/]/).filter(Boolean).at(-1)} repository`
      : project.legacy
        ? 'Game prototype'
        : null;

function Projects({ projectId, state }: { projectId: string; state: StudioState }) {
  const toast = useToast(),
    navigate = useNavigate(),
    // Studio desk's own development: a project on the controller's own source, which Create a project refuses.
    development = useMutation({
      mutationFn: () => send<{ project: { id: string } }>('/api/studio-development', { projectId }),
      onSuccess: created => void navigate({ to: '/p/$projectId/settings', params: { projectId: created.project.id } }),
      onError: error => toast(error.message),
    });
  return (
    <Section id="projects" title="Projects on this computer" shared>
      {state.projects.map((project, index) => (
        <Row
          key={project.id}
          first={index === 0}
          title={
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-10)' }}>
              <span
                className="sd-swatch sd-swatch--sm"
                style={{ background: projectColor(project, index).background }}
              ></span>
              {project.name}
            </span>
          }
          note={[projectLine(project, state), project.id === projectId ? 'you are here' : '']
            .filter(Boolean)
            .join(' · ')}
        >
          {project.dispatchPaused && <span className="sd-chip">Paused</span>}
        </Row>
      ))}
      {/* Offered only where the controller develops a separate copy (npm run setup-stable): an installed copy would
          develop itself. Opening it up waits for better branch handling after 1.0 (the director, October 24). */}
      {state.autonomy?.selfHosted === false &&
        !state.projects.some(project => project.id === 'project-studio-desk') && (
          <Row
            title="Studio desk's own development"
            note="A project that works on this controller's own source, with its checks, its stories and their reviews."
          >
            <button
              type="button"
              className="sd-btn sd-btn--sm"
              disabled={development.isPending}
              onClick={() => development.mutate()}
            >
              Set it up
            </button>
          </Row>
        )}
      <Row title="Add a project" note="A git repository on this computer, or any other work.">
        <NewProject />
      </Row>
    </Section>
  );
}

type Theme = 'system' | 'light' | 'dark';
const themeKey = 'studio-theme';
function savedTheme(): Theme {
  try {
    const value = localStorage.getItem(themeKey);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

// The appearance is this browser's: it is kept in its storage and applied before the page draws (theme.js).
function applyTheme(value: Theme) {
  try {
    if (value === 'system') localStorage.removeItem(themeKey);
    else localStorage.setItem(themeKey, value);
  } catch {
    // Without browser storage the choice lasts until the page reloads.
  }
  if (value === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = value;
}

function Appearance({ state }: { state: StudioState }) {
  const [theme, setTheme] = useState(savedTheme);
  const choose = (value: Theme) => {
    applyTheme(value);
    setTheme(value);
  };
  const origin = (state.runtime as { origin?: string } | undefined)?.origin ?? window.location.origin;
  return (
    <Section id="appearance" title="Appearance" aside={<span className="sd-meta">This browser only</span>}>
      <span className="sd-segmented" role="group" aria-label="Theme" style={{ alignSelf: 'flex-start' }}>
        {(['system', 'light', 'dark'] as const).map(value => (
          <button key={value} type="button" aria-pressed={theme === value} onClick={() => choose(value)}>
            {value[0]!.toUpperCase() + value.slice(1)}
          </button>
        ))}
      </span>
      <Row title="Local records" note="To back up, stop the controller and copy this whole folder.">
        {state.runtime?.dataDirectory && <span className="sd-file sd-file--path">{state.runtime.dataDirectory}</span>}
      </Row>
      <span className="sd-meta">
        Studio desk {state.runtime?.version} · local controller at {origin.replace(/^https?:\/\//, '')}
      </span>
    </Section>
  );
}

export function SettingsPage({ projectId }: { projectId: string }) {
  const { state, error } = useStudio(projectId);
  // An address with a section (#tools) opens on it once the sections are drawn.
  useEffect(() => {
    if (state && window.location.hash) document.getElementById(window.location.hash.slice(1))?.scrollIntoView();
  }, [state]);
  if (error) return <p role="alert">The project could not be loaded: {error.message}</p>;
  if (!state)
    return (
      <p role="status" className="sd-meta">
        Loading the settings…
      </p>
    );
  const index = state.projects.findIndex(project => project.id === projectId);
  return (
    <div className="sd-settingspage">
      <header className="sd-settingshead">
        <div className="sd-eyebrow">{state.project.name}</div>
        <h1>Settings</h1>
        <p>Changes apply to work that starts after you save. Anything that already ran keeps the settings it used.</p>
      </header>
      <div className="sd-settings">
        <SubNav />
        <div className="sd-settings__sections">
          <General key={`general-${state.project.revision}`} projectId={projectId} state={state} index={index} />
          <Repository projectId={projectId} state={state} />
          <HouseRules key={`rules-${state.autonomy?.policy?.revision}`} projectId={projectId} state={state} />
          <Workflows projectId={projectId} state={state} />
          <Records projectId={projectId} />
          <div className="sd-shared" role="note">
            <Icon name="globe" size={26} />
            <span style={{ flex: '1 1 300px' }}>
              <b className="sd-shared__title">Every project</b>
              <span style={{ display: 'block', fontSize: '14px' }}>
                These settings belong to this computer, so a change here reaches every project at once.
              </span>
            </span>
          </div>
          <RunningWork projectId={projectId} state={state} />
          <Tools projectId={projectId} state={state} />
          <Projects projectId={projectId} state={state} />
          <Appearance state={state} />
        </div>
      </div>
    </div>
  );
}

// The frame every page of a project shares, as the design's Sidebar draws it (the project rail with Find a
// project, chosen October 22): a rail with a tile for each project, then the current project's sidebar with Find
// a project (Ctrl K), New idea (N), its pages and the controller's status. At 860px and under, a top bar names the
// project and opens the search, and bottom tabs carry the pages with New idea in the middle. Only the current
// project's Needs you count shows: each tab counts its own project's open work (the director, October 22).
import { Outlet, useRouter, useRouterState } from '@tanstack/react-router';
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import type { Project } from './api';
import { COLORS } from './design/agent-kit.js';
import { Icon, Mark, type IconName } from './design/icons';
import { journeyChip } from './journey';
import { requestNewIdea } from './new-idea';
import { finishedState, useFinished, useStudio } from './records';
import { useConnection } from './stream-context';
import { liveSummary, runStories, type RunStory, type StudioState } from './studio-runs';

export const rememberedProject = 'studio-next-project';

// The colors a project's mark can take, which the director chooses in Settings. A project without a choice takes
// its place's: the first project-1, the second project-2, then the agent kit's other hues in turn. Initials are dark
// ink on every color but violet, which is too dark for it.
export const projectPalette = [
  { id: 'violet', name: 'Violet', background: 'var(--project-1)' },
  { id: 'mint', name: 'Mint', background: 'var(--project-2)' },
  ...['Pink', 'Orange', 'Sun', 'Sky', 'Coral', 'Lime', 'Lilac', 'Slate'].map(name => ({
    id: name.toLowerCase(),
    name,
    background: COLORS.find(([color]) => color === name)?.[1] ?? 'var(--project-2)',
  })),
];
export function projectColor(project: { color?: string } | undefined, index: number) {
  const color =
    projectPalette.find(item => item.id === project?.color) ??
    projectPalette[index <= 0 ? 0 : index === 1 ? 1 : 2 + ((index - 2) % (projectPalette.length - 2))]!;
  return { background: color.background, color: color.id === 'violet' ? '#fff' : 'var(--sticker-ink)' };
}
// "Studio desk development" is SD; a one-word name shows its first two letters.
export function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0]!.charAt(0) + words[1]!.charAt(0) : (words[0] ?? '?').slice(0, 2);
  return letters.charAt(0).toUpperCase() + letters.slice(1).toUpperCase();
}
// What kind of work the project does, from the intake it has.
export function projectKind(state: StudioState) {
  const kinds = state.organizationConfiguration?.taskKinds ?? [];
  if (kinds.includes('studio-development:breakdown')) return 'Code · git repository';
  if (kinds.includes('general:plan')) return 'General work';
  return state.project.legacy ? 'Game prototype' : null;
}
// "1 working · 3 free · nothing paused", from the project's agents and the attempts running now.
export function floorLine(state: StudioState) {
  const agents = state.workers.filter(worker => worker.enabled !== false),
    busy = new Set(
      state.attempts.filter(attempt => ['running', 'stopping'].includes(attempt.status)).map(item => item.workerId),
    ),
    working = agents.filter(agent => busy.has(agent.id)).length,
    paused = agents.filter(agent => agent.paused && !busy.has(agent.id)).length,
    free = agents.length - working - paused;
  const held = state.paused || state.project.dispatchPaused;
  return `${working} working · ${free} free · ${held ? 'new work paused' : paused ? `${paused} paused` : 'nothing paused'}`;
}

// The house rules in a sentence, as the canvas's sidebar says them: what waits for the director and what runs on
// its own, for the project's own work (Settings changes them).
export function rulesLine(state: StudioState) {
  const policy = state.autonomy?.policy;
  if (!policy?.enabled) return 'House rules: every step waits for you.';
  const kinds = state.organizationConfiguration?.taskKinds ?? Object.keys(policy.kinds ?? {}),
    code = kinds.includes('studio-development:change'),
    mode = (kind: string) => ({ approve: 'director', accept: 'director', ...policy.kinds?.[kind] }),
    work = mode(code ? 'studio-development:change' : 'general:work'),
    yours = [
      work.approve === 'director' ? `start ${code ? 'stories' : 'work'}` : '',
      code
        ? (work.integrate ?? 'director') === 'director'
          ? 'integrate them'
          : ''
        : work.accept === 'director'
          ? 'accept it'
          : '',
    ].filter(Boolean),
    checkers = (code ? ['studio-development:checks', 'studio-development:change-review'] : ['general:review']).filter(
      kind => kinds.includes(kind),
    ),
    own = [
      ...(checkers.length && checkers.every(kind => mode(kind).accept === 'auto')
        ? code
          ? ['checks', 'reviews']
          : ['reviews']
        : []),
      work.approve === 'auto' ? `starting ${code ? 'stories' : 'work'}` : '',
      code ? (work.integrate === 'auto' ? 'integration' : '') : work.accept === 'auto' ? 'acceptance' : '',
    ].filter(Boolean),
    list = (items: string[]) =>
      items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : (items[0] ?? '');
  return `House rules: ${[
    yours.length ? `you ${yours.join(' and ')}` : '',
    own.length
      ? `${list(own)} ${own.length > 1 || own[0]!.endsWith('s') ? 'run' : 'runs'} on ${own.length > 1 ? 'their' : 'its'} own`
      : '',
  ]
    .filter(Boolean)
    .join('; ')}.`;
}

// Create a project loads when it is first opened from the rail or Find a project.
const NewProjectDialog = lazy(() => import('./new-project').then(module => ({ default: module.NewProjectDialog })));

type Page = 'today' | 'ideas' | 'board' | 'agents' | 'settings';
const pages: { id: Page; label: string; icon: IconName; path: string }[] = [
  { id: 'today', label: 'Today', icon: 'today', path: '' },
  { id: 'ideas', label: 'Ideas', icon: 'ideas', path: '/runs' },
  { id: 'board', label: 'Board', icon: 'board', path: '/board' },
  { id: 'agents', label: 'Agents', icon: 'agents', path: '/agents' },
  { id: 'settings', label: 'Project settings', icon: 'settings', path: '/settings' },
];
// The page the address is on: a story belongs to its idea, and the teams and instructions to the agents.
function currentPage(path: string, projectId: string): Page | null {
  const rest = path.slice(`/p/${projectId}`.length).replace(/\/$/, '');
  if (rest === '') return 'today';
  if (rest.startsWith('/runs') || rest.startsWith('/tasks')) return 'ideas';
  if (rest.startsWith('/board')) return 'board';
  if (rest.startsWith('/agents')) return 'agents';
  if (rest.startsWith('/settings')) return 'settings';
  return null;
}

const newest = (a: RunStory, b: RunStory) => Date.parse(b.startedAt) - Date.parse(a.startedAt);

// Ideas in this project, under the nav on an idea's page: the newest four, the one shown among them, each its first
// words beside its state's dot; then the way to the rest.
function IdeasHere({ projectId, state, runId }: { projectId: string; state: StudioState; runId: string }) {
  const finished = useFinished(projectId, 5),
    go = useGo(),
    live = liveSummary(state).stories,
    settled = finished.data ? runStories(finishedState(state, finished.data.pages)) : [],
    every = [...live, ...settled.filter(run => !live.some(open => open.id === run.id))].sort(newest),
    shown = every.filter(run => !run.archive?.archived).slice(0, 4);
  // The idea shown is always there, even archived.
  const here = every.find(run => run.id === runId);
  if (here && !shown.includes(here)) shown.splice(3, 1, here);
  if (!shown.length) return null;
  const tone = (run: RunStory) =>
    live.includes(run)
      ? journeyChip(run, state).tone
      : run.outcome.tone === 'ok'
        ? 'ok'
        : run.outcome.tone === 'bad'
          ? 'bad'
          : 'wait';
  const words = (run: RunStory) => {
    const line = (run.brief || run.title).trim().split('\n')[0] ?? '';
    return line.length > 52 ? `${line.slice(0, 52).replace(/\s+\S*$/, '')}…` : line;
  };
  return (
    <nav className="sd-sidebar__ideas" aria-label="Ideas in this project">
      <span className="sd-eyebrow">Ideas in this project</span>
      {shown.map(run => (
        <a
          key={run.id}
          className="sd-navlink sd-navlink--idea"
          href={`/p/${projectId}/runs/${encodeURIComponent(run.id)}`}
          aria-current={run.id === runId ? 'page' : undefined}
          onClick={go(`/p/${projectId}/runs/${encodeURIComponent(run.id)}`)}
        >
          <span className={`sd-chip sd-chip--${tone(run)}`}>
            <span className="sd-chip__dot"></span>
          </span>
          {words(run)}
        </a>
      ))}
      <a className="sd-navlink sd-navlink--more" href={`/p/${projectId}/runs`} onClick={go(`/p/${projectId}/runs`)}>
        Earlier ideas
      </a>
    </nav>
  );
}

// A link inside the app: a plain click moves the router, any other click (a new tab) does what the browser does.
function useGo() {
  const router = useRouter();
  return (href: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    router.history.push(href);
  };
}

// Typing in a field never triggers a shortcut.
const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

export function ProjectFrame({ projectId }: { projectId: string }) {
  const { state, shell } = useStudio(projectId),
    connection = useConnection(),
    router = useRouter(),
    go = useGo(),
    path = useRouterState({ select: router => router.location.pathname }),
    [searching, setSearching] = useState(false),
    [adding, setAdding] = useState(false);
  const projects: Project[] = shell?.projects ?? [{ id: projectId, name: projectId }],
    project = projects.find(item => item.id === projectId) ?? { id: projectId, name: shell?.project.name ?? '' },
    index = projects.findIndex(item => item.id === projectId),
    page = currentPage(path, projectId),
    decisions = state ? liveSummary(state).decisions : 0,
    href = (suffix: string) => `/p/${projectId}${suffix}`;
  // New idea opens Today, which puts the cursor in its idea box (or raises it as a sheet on a phone).
  const newIdea = () => {
    router.history.push(href(''));
    requestNewIdea();
  };
  // A new tab opens the project shown last; the address still names it, so this is only a convenience.
  useEffect(() => {
    try {
      localStorage.setItem(rememberedProject, projectId);
    } catch {
      // Without browser storage a new tab opens the first project.
    }
  }, [projectId]);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearching(open => !open);
      } else if (event.key === 'n' && !event.ctrlKey && !event.metaKey && !event.altKey && !typing(event.target)) {
        event.preventDefault();
        newIdea();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const count = decisions > 0 && (
    <span className="sd-count" aria-label={`${decisions} ${decisions === 1 ? 'call' : 'calls'} for you`}>
      {decisions}
    </span>
  );
  const runId = page === 'ideas' ? /\/runs\/([^/]+)$/.exec(path)?.[1] : undefined;
  return (
    <div className="sd-app sd-ground">
      <div className="sd-frame">
        <nav className="sd-rail" aria-label="Projects">
          <Mark />
          <span className="sd-rail__rule" aria-hidden="true"></span>
          {projects.map((item, position) => (
            <a
              key={item.id}
              href={`/p/${item.id}`}
              className="sd-rail__tile"
              style={projectColor(item, position)}
              aria-current={item.id === projectId ? 'true' : undefined}
              aria-label={item.name}
              title={item.name}
              onClick={go(`/p/${item.id}`)}
            >
              {initials(item.name)}
            </a>
          ))}
          <button
            type="button"
            className="sd-rail__add"
            aria-label="Add a project"
            title="Add a project"
            onClick={() => setAdding(true)}
          >
            <Icon name="plus" weight={2.4} />
          </button>
          <a
            href={href('/settings#running')}
            className="sd-rail__settings"
            aria-label="Settings for every project"
            title="Settings for every project"
            onClick={go(href('/settings#running'))}
          >
            <Icon name="settings" />
          </a>
        </nav>
        <aside className="sd-sidebar" aria-label={project.name}>
          <div className="sd-sidebar__project">
            <span className="sd-eyebrow" style={{ fontSize: '10.5px' }}>
              Project
            </span>
            <span className="sd-sidebar__name">{project.name}</span>
            {state && projectKind(state) && <span className="sd-meta">{projectKind(state)}</span>}
          </div>
          <button
            type="button"
            className="sd-search"
            aria-label="Find a project (Ctrl K)"
            aria-haspopup="dialog"
            onClick={() => setSearching(true)}
          >
            <Icon name="search" size={17} weight={2.2} />
            <span>Find a project</span>
            <kbd className="sd-kbd">Ctrl K</kbd>
          </button>
          <button type="button" className="sd-btn sd-btn--primary" style={{ width: '100%' }} onClick={newIdea}>
            <Icon name="plus" size={18} weight={2.4} />
            New idea
            <kbd className="sd-key" aria-hidden="true">
              N
            </kbd>
          </button>
          <nav aria-label="Main">
            {pages.map(item => (
              <a
                key={item.id}
                className="sd-navlink"
                href={href(item.path)}
                aria-current={page === item.id ? 'page' : undefined}
                onClick={go(href(item.path))}
              >
                <Icon name={item.icon} />
                {item.label}
                {item.id === 'today' && count}
              </a>
            ))}
          </nav>
          {state && runId && <IdeasHere projectId={projectId} state={state} runId={decodeURIComponent(runId)} />}
          <div className="sd-status">
            <div className="sd-status__head">
              <span className={`sd-status__light sd-status__light--${connection}`} aria-hidden="true"></span>
              {connection === 'live'
                ? 'Controller connected'
                : connection === 'connecting'
                  ? 'Connecting to your studio…'
                  : 'Controller unavailable · reconnecting'}
            </div>
            {state && <div className="sd-meta">{floorLine(state)}</div>}
            <div className="sd-meta">
              {state ? rulesLine(state) : ''}{' '}
              <a href={href('/settings')} onClick={go(href('/settings'))}>
                Change
              </a>
            </div>
          </div>
        </aside>
      </div>
      <header className="sd-topbar">
        <Mark size={30} />
        <button
          type="button"
          className="sd-topbar__project"
          aria-haspopup="dialog"
          aria-label={`Find a project. Current: ${project.name}`}
          onClick={() => setSearching(true)}
        >
          <span className="sd-topbar__square" style={{ background: projectColor(project, index).background }}></span>
          <span className="sd-topbar__name">{project.name}</span>
          <Icon name="updown" size={16} weight={2.2} />
        </button>
      </header>
      <main className="sd-main">
        <div className="sd-page">
          <Outlet />
        </div>
      </main>
      <nav className="sd-tabbar" aria-label="Pages">
        {pages
          .filter(item => item.id !== 'settings')
          .flatMap(item => [
            ...(item.id === 'board'
              ? [
                  <button key="new" type="button" className="sd-tab" aria-label="New idea" onClick={newIdea}>
                    <span className="sd-tab__new">
                      <Icon name="plus" size={28} weight={2.6} />
                    </span>
                  </button>,
                ]
              : []),
            <a
              key={item.id}
              className="sd-tab"
              href={href(item.path)}
              aria-current={page === item.id ? 'page' : undefined}
              onClick={go(href(item.path))}
            >
              <Icon name={item.icon} size={24} />
              {item.label}
              {item.id === 'today' && count}
            </a>,
          ])}
      </nav>
      <ProjectSearch
        open={searching}
        onClose={() => setSearching(false)}
        projects={projects}
        current={projectId}
        onChoose={target => {
          setSearching(false);
          router.history.push(target);
        }}
        onAdd={() => {
          setSearching(false);
          setAdding(true);
        }}
        settingsHref={href('/settings')}
      />
      {adding && (
        <Suspense fallback={null}>
          <NewProjectDialog open onClose={() => setAdding(false)} />
        </Suspense>
      )}
    </div>
  );
}

// Find a project (Ctrl K): every project by name, filtered as you type; the arrow keys move, Enter opens and Esc
// closes. The list ends with Add a project, which opens Create a project, and, on a phone, the project's settings.
export function ProjectSearch({
  open,
  onClose,
  projects,
  current,
  onChoose,
  onAdd,
  settingsHref,
}: {
  open: boolean;
  onClose: () => void;
  projects: Project[];
  current: string;
  onChoose: (href: string) => void;
  onAdd: () => void;
  settingsHref: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    input = useRef<HTMLInputElement>(null),
    listId = useId(),
    [query, setQuery] = useState(''),
    [active, setActive] = useState(0);
  const matches = projects
      .map((project, position) => ({ project, position }))
      .filter(({ project }) => project.name.toLowerCase().includes(query.trim().toLowerCase())),
    rows: { key: string; choose: () => void; content: ReactNode; className?: string }[] = [
      ...matches.map(({ project, position }) => ({
        key: project.id,
        choose: () => onChoose(`/p/${project.id}`),
        content: (
          <>
            <span
              className="sd-palette__square"
              style={{ background: projectColor(project, position).background }}
            ></span>
            <span className="sd-palette__text">
              <b>{project.name}</b>
            </span>
            {project.id === current && <span className="sd-meta">You are here</span>}
          </>
        ),
      })),
      {
        key: 'add',
        choose: onAdd,
        className: 'sd-palette__add',
        content: (
          <>
            <Icon name="plus" size={18} weight={2.4} />
            <b>Add a project</b>
          </>
        ),
      },
      {
        key: 'settings',
        choose: () => onChoose(settingsHref),
        className: 'sd-palette__narrow',
        content: (
          <>
            <Icon name="settings" size={18} />
            <b>Project settings</b>
          </>
        ),
      },
    ];
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      setQuery('');
      setActive(
        Math.max(
          0,
          projects.findIndex(project => project.id === current),
        ),
      );
      if (typeof element.showModal === 'function') element.showModal();
      else element.setAttribute('open', '');
      input.current?.focus();
    }
    if (!open && element.open) {
      if (typeof element.close === 'function') element.close();
      else element.removeAttribute('open');
    }
  }, [open, projects, current]);
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(index => (index + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const row = rows[Math.min(active, rows.length - 1)];
      if (row) row.choose();
    }
  };
  return (
    <dialog
      ref={dialog}
      className="sd-palette-dialog"
      aria-label="Find a project"
      onClose={onClose}
      onClick={event => event.target === dialog.current && onClose()}
    >
      {open && (
        <div className="sd-palette">
          <label className="sd-palette__field">
            <Icon name="search" size={18} weight={2.2} />
            <input
              ref={input}
              className="sd-palette__input"
              placeholder="Find a project"
              aria-label="Find a project"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={`${listId}-${Math.min(active, rows.length - 1)}`}
              value={query}
              onChange={event => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={onKey}
            />
            <kbd className="sd-kbd">Esc</kbd>
          </label>
          <div role="listbox" id={listId} aria-label="Projects" className="sd-palette__list">
            {rows.map((row, position) => (
              <div
                key={row.key}
                id={`${listId}-${position}`}
                role="option"
                aria-selected={position === Math.min(active, rows.length - 1)}
                className={`sd-palette__row${row.className ? ` ${row.className}` : ''}`}
                onMouseMove={() => setActive(position)}
                onClick={row.choose}
              >
                {row.content}
              </div>
            ))}
          </div>
        </div>
      )}
    </dialog>
  );
}

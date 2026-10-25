// Path URLs (MP-026): each page has its own address, so reload and Back work. A project's pages
// share its frame and live stream, and each page loads and subscribes to only the records it shows.
import { useQuery } from '@tanstack/react-query';
import {
  Link,
  Navigate,
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  type RouterHistory,
} from '@tanstack/react-router';
import { lazy, Suspense, type ComponentType } from 'react';
import { getJSON, projectsUrl, type Project } from './api';
import { BoardPage } from './board-page';
import { ProjectFrame, rememberedProject } from './frame';
import { Heading } from './layout';
import { ProjectLive } from './live-context';
import { TodayPage } from './today-page';
import { TracePage } from './trace-page';

// A task's page, the runs and Settings load when first opened, so Home's first load stays small.
const TaskView = lazyRouteComponent(() => import('./task-page'), 'TaskView'),
  RunsPage = lazyRouteComponent(() => import('./runs-page'), 'RunsPage'),
  SettingsPage = lazyRouteComponent(() => import('./settings-page'), 'SettingsPage'),
  TeamsPage = lazyRouteComponent(() => import('./teams-page'), 'TeamsPage'),
  TeamPage = lazyRouteComponent(() => import('./teams-page'), 'TeamPage'),
  AgentsPage = lazyRouteComponent(() => import('./agents-page'), 'AgentsPage'),
  InstructionsPage = lazyRouteComponent(() => import('./instructions-page'), 'InstructionsPage'),
  ActivityLogPage = lazyRouteComponent(() => import('./activity-log-page'), 'ActivityLogPage'),
  PlatformPage = lazyRouteComponent(() => import('./platform-page'), 'PlatformPage');
// No projects yet loads only when no project exists.
const FirstRun = lazy(() => import('./first-run').then(module => ({ default: module.FirstRun })));

const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: () => (
    <div className="sd-app sd-ground">
      <main className="sd-main">
        <div className="sd-page">
          <Heading
            title="Page not found"
            lead={
              <>
                This address is not a page of the dashboard. <Link to="/">Back to the dashboard</Link>
              </>
            }
          />
        </div>
      </main>
    </div>
  ),
});

// A new tab opens the project its address names (`/?projectId=`, as links from before path URLs do), the one it
// showed last, or the first one. With no project, it shows No projects yet, whose chosen template is in the address
// (`/?template=code`), so reload and Back keep the step.
const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: (search: Record<string, unknown>): { projectId?: string; template?: string } => ({
    ...(typeof search.projectId === 'string' ? { projectId: search.projectId } : {}),
    ...(typeof search.template === 'string' ? { template: search.template } : {}),
  }),
  component: function ChooseProject() {
    const { projectId: named, template } = homeRoute.useSearch(),
      navigate = homeRoute.useNavigate();
    const { data, error } = useQuery({
      queryKey: ['projects'],
      queryFn: ({ signal }) => getJSON<{ projects: Project[] }>(projectsUrl, signal),
    });
    if (error) return <p role="alert">The controller could not list its projects: {error.message}</p>;
    if (!data) return <p role="status">Connecting to your studio…</p>;
    let remembered: string | null = null;
    try {
      remembered = localStorage.getItem(rememberedProject);
    } catch {
      // Without browser storage the first project opens.
    }
    const project =
      data.projects.find(item => item.id === named) ??
      data.projects.find(item => item.id === remembered) ??
      data.projects[0];
    if (!project)
      return (
        <Suspense fallback={<p role="status">Connecting to your studio…</p>}>
          <FirstRun template={template} onTemplate={id => void navigate({ search: id ? { template: id } : {} })} />
        </Suspense>
      );
    return <Navigate to="/p/$projectId" params={{ projectId: project.id }} replace />;
  },
});

const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/p/$projectId',
  component: function Project() {
    const { projectId } = projectRoute.useParams();
    return (
      <ProjectLive key={projectId} projectId={projectId}>
        <ProjectFrame projectId={projectId} />
      </ProjectLive>
    );
  },
  notFoundComponent: function ProjectNotFound() {
    const { projectId } = projectRoute.useParams();
    return (
      <Heading
        crumbs={[
          <Link key="today" to="/p/$projectId" params={{ projectId }}>
            Today
          </Link>,
        ]}
        title="Page not found"
        lead="This address is not a page of the dashboard."
      />
    );
  },
});

const projectHomeRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/',
  component: function ProjectHome() {
    const { projectId } = projectRoute.useParams();
    return <TodayPage key={projectId} projectId={projectId} />;
  },
});

const runsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/runs',
  component: function Runs() {
    const { projectId } = projectRoute.useParams();
    return <RunsPage projectId={projectId} />;
  },
});

const runRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/runs/$runId',
  component: function Run() {
    const { projectId, runId } = runRoute.useParams();
    return <RunsPage projectId={projectId} runId={runId} />;
  },
});

// Whether the board shows its accepted and closed work is part of its address, so reload and Back keep it.
interface BoardSearch {
  accepted?: true;
  closed?: true;
}
const boardRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/board',
  validateSearch: (search: Record<string, unknown>): BoardSearch => ({
    ...(search.accepted === true || search.accepted === 'true' ? { accepted: true } : {}),
    ...(search.closed === true || search.closed === 'true' ? { closed: true } : {}),
  }),
  component: function Board() {
    const { projectId } = projectRoute.useParams(),
      search = boardRoute.useSearch();
    return <BoardPage projectId={projectId} accepted={!!search.accepted} closed={!!search.closed} />;
  },
});

const settingsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/settings',
  component: function Settings() {
    const { projectId } = projectRoute.useParams();
    return <SettingsPage projectId={projectId} />;
  },
});

// The pages Settings opens sit under it, so the sidebar keeps Settings marked and each trail leads back.
const settingsPage = <Path extends string>(path: Path, Page: ComponentType<{ projectId: string }>) =>
  createRoute({
    getParentRoute: () => projectRoute,
    path: `/settings/${path}` as `/settings/${Path}`,
    component: function SettingsSubpage() {
      const { projectId } = projectRoute.useParams();
      return <Page projectId={projectId} />;
    },
  });
const platformRoute = settingsPage('platform', PlatformPage);
const activityRoute = settingsPage('activity', ActivityLogPage);
// The old overview and setup pages are gone: Today and the board show what the overview did, and Settings holds
// what the setup page held. Their addresses still lead somewhere.
const overviewRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/settings/overview',
  component: function Overview() {
    const { projectId } = projectRoute.useParams();
    return <Navigate to="/p/$projectId" params={{ projectId }} replace />;
  },
});
const setupRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/settings/setup',
  component: function Setup() {
    const { projectId } = projectRoute.useParams();
    return <Navigate to="/p/$projectId/settings" params={{ projectId }} replace />;
  },
});

// The agents' pages sit under Agents, as the sidebar has them: the agents, one agent, the teams, one team and the
// instructions.
const agentsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/agents',
  component: function Agents() {
    const { projectId } = projectRoute.useParams();
    return <AgentsPage projectId={projectId} />;
  },
});

const agentRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/agents/$workerId',
  component: function Agent() {
    const { projectId, workerId } = agentRoute.useParams();
    return <AgentsPage projectId={projectId} workerId={workerId} />;
  },
});

// Editing the teams is part of the address, so Add an agent and a team's own page open the teams that way.
const teamsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/agents/teams',
  validateSearch: (search: Record<string, unknown>): { edit?: true } =>
    search.edit === true || search.edit === 'true' ? { edit: true } : {},
  component: function Teams() {
    const { projectId } = projectRoute.useParams(),
      { edit } = teamsRoute.useSearch(),
      navigate = teamsRoute.useNavigate();
    return (
      <TeamsPage
        projectId={projectId}
        editing={!!edit}
        onEditing={editing => void navigate({ search: editing ? { edit: true } : {}, replace: true })}
      />
    );
  },
});

// Which instructions to open is part of the address, so a link from a team or an agent opens them.
const instructionsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/agents/instructions',
  validateSearch: (search: Record<string, unknown>): { open?: string } =>
    typeof search.open === 'string' ? { open: search.open } : {},
  component: function Instructions() {
    const { projectId } = projectRoute.useParams(),
      { open } = instructionsRoute.useSearch();
    return <InstructionsPage projectId={projectId} initial={open} />;
  },
});

const teamRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/agents/teams/$teamId',
  component: function Team() {
    const { projectId, teamId } = teamRoute.useParams();
    return <TeamPage key={teamId} projectId={projectId} teamId={teamId} />;
  },
});

// Until October 23 the agents' pages were under Settings, the agents named employees; those addresses lead to
// them.
const movedRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/settings/$page/$',
  validateSearch: (search: Record<string, unknown>): { open?: string } =>
    typeof search.open === 'string' ? { open: search.open.replace(/^employee:/, 'agent:') } : {},
  component: function Moved() {
    const { projectId, page, _splat: id } = movedRoute.useParams(),
      { open } = movedRoute.useSearch();
    if (page === 'employees')
      return id ? (
        <Navigate to="/p/$projectId/agents/$workerId" params={{ projectId, workerId: id }} replace />
      ) : (
        <Navigate to="/p/$projectId/agents" params={{ projectId }} replace />
      );
    if (page === 'teams')
      return id ? (
        <Navigate to="/p/$projectId/agents/teams/$teamId" params={{ projectId, teamId: id }} replace />
      ) : (
        <Navigate to="/p/$projectId/agents/teams" params={{ projectId }} replace />
      );
    if (page === 'instructions')
      return <Navigate to="/p/$projectId/agents/instructions" params={{ projectId }} search={{ open }} replace />;
    return <Navigate to="/p/$projectId/settings" params={{ projectId }} replace />;
  },
});

const taskRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/tasks/$taskId',
  component: function Task() {
    const { projectId, taskId } = taskRoute.useParams();
    return <TaskView key={taskId} projectId={projectId} taskId={taskId} />;
  },
});

const traceRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/tasks/$taskId/attempts/$attemptId',
  component: function AttemptTrace() {
    const { projectId, taskId, attemptId } = traceRoute.useParams();
    return <TracePage key={attemptId} projectId={projectId} taskId={taskId} attemptId={attemptId} />;
  },
});

export const routeTree = rootRoute.addChildren([
  homeRoute,
  projectRoute.addChildren([
    projectHomeRoute,
    runsRoute,
    runRoute,
    boardRoute,
    settingsRoute,
    setupRoute,
    agentsRoute,
    agentRoute,
    teamsRoute,
    teamRoute,
    instructionsRoute,
    movedRoute,
    overviewRoute,
    platformRoute,
    activityRoute,
    taskRoute,
    traceRoute,
  ]),
]);

export function createAppRouter(history?: RouterHistory) {
  return createRouter({ routeTree, ...(history ? { history } : {}) });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}

// Whole organization saves (organization.ts): the saved organization's body as Edit the teams sends it unchanged, each
// change to one part of it, and the save as it reaches the stand-in controller. Model-free; no page uses them yet.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  addTeam,
  giveKind,
  organizationBody,
  removeTeam,
  replaceTeam,
  setTiers,
  useSaveOrganization,
  type OrganizationBody,
} from './organization';
import type { StudioState } from './studio-runs';
import { fakeController, shellFixture, type Controller } from './test-controller';

const change = 'studio-development:change',
  review = 'studio-development:review',
  check = 'studio-development:check',
  breakdown = 'studio-development:breakdown';

// Two teams: Eli leads engineering with Bo, who is not enabled, and Ana leads review; Dee was deleted and Kit is in no
// team. The saved tiers and the teams' goal work are the controller's to keep.
const fixture = (): StudioState => ({
  ...shellFixture(),
  tasks: [],
  attempts: [],
  runs: [],
  taskKinds: { [change]: { label: 'Change' }, [review]: { label: 'Review' }, [check]: { label: 'Check' } },
  employeeDirectory: [
    { id: 'W-1', displayName: 'Eli', enabled: true },
    { id: 'W-2', displayName: 'Ana', enabled: true },
    { id: 'W-3', displayName: 'Bo', enabled: false },
    { id: 'W-4', displayName: 'Dee', enabled: true, deletedAt: '2026-10-20T10:00:00Z' },
    { id: 'W-5', displayName: 'Kit', enabled: true },
  ],
  organizationConfiguration: {
    revision: 4,
    teams: [
      {
        id: 'engineering',
        name: 'Engineering',
        mark: 'E',
        purpose: 'Builds it.',
        goal: 'Ship 1.0.',
        outcome: 'Accepted changes.',
        leadId: 'W-1',
        goalTaskIds: ['T-9'],
      },
      { id: 'review', name: 'Review', purpose: 'Checks it.', leadId: 'W-2', goalTaskIds: [] },
    ],
    members: [
      {
        workerId: 'W-2',
        teamId: 'review',
        role: 'Reviewer',
        responsibility: 'Reviews.',
        roles: ['reviewer', 'reviewer'],
      },
      {
        workerId: 'W-1',
        teamId: 'engineering',
        role: 'Software engineer',
        responsibility: 'Builds.',
        roles: ['engineer'],
      },
      { workerId: 'W-3', teamId: 'engineering' },
      { workerId: 'W-4', teamId: 'review', role: 'Reviewer', responsibility: 'Reviews.', roles: [] },
    ],
    taskKinds: [change, review, check],
    kindOwners: { [change]: 'W-1', [review]: 'W-2', [check]: 'W-3', [breakdown]: 'W-1' },
    tiers: { deep: { claude: { model: 'opus' } } },
  },
});

const eli = {
    workerId: 'W-1',
    teamId: 'engineering',
    role: 'Software engineer',
    responsibility: 'Builds.',
    roles: ['engineer'],
  },
  ana = { workerId: 'W-2', teamId: 'review', role: 'Reviewer', responsibility: 'Reviews.', roles: ['reviewer'] },
  bo = {
    workerId: 'W-3',
    teamId: 'engineering',
    role: 'Project contributor',
    responsibility: 'Perform bounded project work and submit evidence for director review.',
    roles: [],
  };
const engineering = {
    id: 'engineering',
    name: 'Engineering',
    mark: 'E',
    purpose: 'Builds it.',
    goal: 'Ship 1.0.',
    outcome: 'Accepted changes.',
    leadId: 'W-1',
  },
  reviewTeam = { id: 'review', name: 'Review', purpose: 'Checks it.', leadId: 'W-2' };
// What Edit the teams sends for the fixture's organization unchanged, with no agent's CLI among the adapters: its
// members in the directory's order with their parts, the deleted agent left out, and the default agents only for kinds
// the project takes and agents that are enabled.
const unchanged = {
  expectedRevision: 4,
  teams: [engineering, reviewTeam],
  members: [eli, ana, bo],
  taskKinds: [change, review, check],
  kindOwners: { [change]: 'W-1', [review]: 'W-2' },
};
// As the body reaches the controller: fields left undefined are not sent.
const sent = (body: OrganizationBody) => JSON.parse(JSON.stringify(body)) as Record<string, unknown>;

test('the saved organization is the body Edit the teams sends unchanged, with no tiers and no goal work', () => {
  const body = organizationBody(fixture());
  expect(sent(body)).toStrictEqual(sent(unchanged));
  expect(body).not.toHaveProperty('tiers');
  for (const team of body.teams) expect(team).not.toHaveProperty('goalTaskIds');
  // A team with no lead sends null for it, as the controller keeps it.
  const state = fixture();
  state.organizationConfiguration!.teams![1]!.leadId = '';
  expect(organizationBody(state).teams[1]!.leadId).toBeNull();
});

test('a project with no saved organization starts at revision 0 with every kind of work the studio has', () => {
  const state = { ...fixture(), organizationConfiguration: null };
  expect(organizationBody(state)).toStrictEqual({
    expectedRevision: 0,
    teams: [],
    members: [],
    taskKinds: [change, review, check],
    kindOwners: {},
  });
  // With no directory the project's agents are its workers.
  const workers = { ...fixture(), employeeDirectory: [], workers: [{ id: 'W-1', enabled: true }] };
  expect(organizationBody(workers).members).toEqual([eli]);
});

test('giving a kind the project does not take adds it and its agent; giving one it takes moves the agent', () => {
  const body = organizationBody(fixture()),
    added = giveKind(body, breakdown, 'W-2');
  expect(added.taskKinds).toEqual([change, review, check, breakdown]);
  expect(added.kindOwners).toEqual({ [change]: 'W-1', [review]: 'W-2', [breakdown]: 'W-2' });
  const moved = giveKind(body, change, 'W-2');
  expect(moved.taskKinds).toEqual([change, review, check]);
  expect(moved.kindOwners).toEqual({ [change]: 'W-2', [review]: 'W-2' });
  // Each change returns a new body and leaves the one it started from as it was.
  expect(body).toStrictEqual(organizationBody(fixture()));
});

test('removing a team drops its agents from the organization, their kinds of work and the lead on it', () => {
  const body = organizationBody(fixture()),
    removed = removeTeam(body, 'review');
  expect(removed.teams).toEqual([engineering]);
  expect(removed.members).toEqual([eli, bo]);
  expect(removed.kindOwners).toEqual({ [change]: 'W-1' });
  expect(removed.taskKinds).toEqual(body.taskKinds);
  // Removing the lead's team takes the lead with it; nothing else names a member who left.
  const gone = removeTeam(body, 'engineering');
  expect(gone.teams).toEqual([reviewTeam]);
  expect(gone.members).toEqual([ana]);
  expect(gone.kindOwners).toEqual({ [review]: 'W-2' });
  expect(body).toStrictEqual(organizationBody(fixture()));
});

test('replacing a team changes only that team and its agents', () => {
  const body = organizationBody(fixture()),
    replaced = replaceTeam(
      body,
      { ...engineering, purpose: 'Builds and tests it.', goal: 'Ship 1.1.', outcome: 'Merged.', leadId: 'W-5' },
      [
        { workerId: 'W-1', role: 'Lead engineer', responsibility: 'Builds.', roles: ['engineer', 'planner'] },
        { workerId: 'W-5', role: 'Software engineer', responsibility: 'Builds too.', roles: [] },
      ],
    );
  expect(replaced.teams).toEqual([
    { ...engineering, purpose: 'Builds and tests it.', goal: 'Ship 1.1.', outcome: 'Merged.', leadId: 'W-5' },
    reviewTeam,
  ]);
  // Bo, left out, leaves the project; Kit joins; Ana's team is as it was.
  expect(replaced.members).toEqual([
    ana,
    { ...eli, role: 'Lead engineer', roles: ['engineer', 'planner'] },
    { workerId: 'W-5', teamId: 'engineering', role: 'Software engineer', responsibility: 'Builds too.', roles: [] },
  ]);
  expect(replaced.kindOwners).toEqual(body.kindOwners);
  expect(replaced.taskKinds).toEqual(body.taskKinds);
  expect(replaced.expectedRevision).toBe(4);
  // A lead who is not one of the team's agents is cleared, and an agent brought in from another team leaves it and its
  // lead, and a kind of work goes with an agent who leaves the project.
  const moved = replaceTeam(body, engineering, [ana]);
  expect(moved.teams).toEqual([
    { ...engineering, leadId: null },
    { ...reviewTeam, leadId: null },
  ]);
  expect(moved.members).toEqual([{ ...ana, teamId: 'engineering' }]);
  expect(moved.kindOwners).toEqual({ [review]: 'W-2' });
  expect(body).toStrictEqual(organizationBody(fixture()));
});

test('adding a team adds it with no agents and no lead', () => {
  const body = organizationBody(fixture()),
    added = addTeam(body, { id: 'design', name: 'Design', mark: 'D', purpose: 'Draws it.', leadId: 'W-5' });
  expect(sent(added)).toStrictEqual(
    sent({
      ...unchanged,
      teams: [engineering, reviewTeam, { id: 'design', name: 'Design', mark: 'D', purpose: 'Draws it.', leadId: null }],
    }),
  );
});

test('setting tiers trims each field and leaves out empty fields, CLIs with none and tiers with none', () => {
  const body = organizationBody(fixture()),
    set = setTiers(body, {
      light: { claude: { model: ' haiku ', effort: '  ' }, codex: { model: '' } },
      standard: { claude: { model: '', effort: '', mode: '' } },
      deep: { claude: { model: 'opus', mode: 'plan ' }, codex: { effort: 'high' } },
    });
  expect(set.tiers).toStrictEqual({
    light: { claude: { model: 'haiku' } },
    deep: { claude: { model: 'opus', mode: 'plan' }, codex: { effort: 'high' } },
  });
  expect({ ...set, tiers: undefined }).toEqual(body);
  // Nothing left sends an empty object, which clears the saved tiers.
  expect(setTiers(body, { light: { claude: { model: ' ' } } }).tiers).toStrictEqual({});
  expect(body).not.toHaveProperty('tiers');
});

let controller: Controller, client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
beforeEach(() => {
  controller = fakeController();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
});

test("saving sends the whole organization with the project's ID as a PATCH", async () => {
  const { result } = renderHook(() => useSaveOrganization('project-x'), { wrapper }),
    body = setTiers(giveKind(organizationBody(fixture()), breakdown, 'W-1'), { deep: { claude: { model: 'opus' } } });
  await act(async () => {
    await result.current.mutateAsync(body);
  });
  expect(controller.requests).toEqual([
    { url: '/api/projects/project-x/organization', method: 'PATCH', body: { projectId: 'project-x', ...sent(body) } },
  ]);
});

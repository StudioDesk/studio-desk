// The Agents page's flow, from the project's own records: You, each team in its saved order with its agents as cards,
// each naming the work its agent is running; then You; what the picked agent is told, by set; and the kinds of work
// the project does not take. Model-free, with the stand-in controller.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { ToldView } from './api';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, taskFixture, toldFixture, type Controller } from './test-controller';

let controller: Controller;
beforeEach(() => {
  controller = fakeController();
  controller.shell = {
    ...controller.shell,
    // Saved with Writing first, so the flow follows the saved order, not the names'.
    teams: [
      { id: 'writing', name: 'Writing', mark: 'WR', purpose: 'Write the guides.', leadId: 'W-3', goalTaskIds: [] },
      {
        id: 'engineering',
        name: 'Engineering',
        mark: 'EN',
        purpose: 'Build the product.',
        leadId: 'W-2',
        goalTaskIds: [],
      },
    ],
    workers: [
      {
        id: 'W-3',
        displayName: 'Kit',
        jobTitle: 'Writer',
        team: 'Writing',
        teamId: 'writing',
        provider: 'codex',
        model: '',
        enabled: true,
      },
      {
        id: 'W-1',
        displayName: 'Eli',
        jobTitle: 'Engineer',
        team: 'Engineering',
        teamId: 'engineering',
        provider: 'codex',
        model: 'gpt-5',
        effort: 'xhigh',
        enabled: true,
      },
      {
        id: 'W-2',
        displayName: 'Ana',
        jobTitle: 'Reviewer',
        team: 'Engineering',
        teamId: 'engineering',
        provider: 'claude',
        model: 'opus',
        effort: 'high',
        enabled: true,
        paused: true,
      },
    ],
    employeeDirectory: [],
    adapters: {
      codex: { id: 'codex', name: 'Codex CLI', available: true, workerSelectable: true, modes: ['workspace'] },
      claude: { id: 'claude', name: 'Claude Code CLI', available: true, workerSelectable: true, modes: ['workspace'] },
    },
    taskKinds: {
      general: { label: 'General task', available: true },
      'studio-development:change': { label: 'Code change', available: true },
      'studio-development:change-review': { label: 'Code review', available: true },
      'general:plan': { label: 'Plan the steps', available: false },
      layout: { label: 'Layout', available: false },
    },
    organizationConfiguration: {
      revision: 3,
      teams: [],
      members: [],
      taskKinds: ['general', 'studio-development:change', 'studio-development:change-review'],
      kindOwners: {
        'studio-development:change': 'W-1',
        general: 'W-1',
        'studio-development:change-review': 'W-2',
      },
      tiers: {},
    },
  };
  // Kit is running one piece of work.
  controller.tasks = [taskFixture('T-run', { title: 'Write the guide', status: 'running', workerId: 'W-3' })];
  controller.attempts = [
    { id: 'attempt-run', taskId: 'T-run', status: 'running', workerId: 'W-3', startedAt: new Date().toISOString() },
  ];
});
afterEach(() => cleanup());

const open = (path: string) => {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(
    <App
      router={router}
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })}
      createStream={createStream}
    />,
  );
  return router;
};
const flow = async () => within(await screen.findByRole('list', { name: 'How the work flows' }));
const team = (name: string) => within(screen.getByRole('region', { name }));
const card = (name: RegExp) => screen.getByRole('link', { name });

test('the flow lists You, the teams in their saved order, then You, each team with its purpose, lead and Edit the team', async () => {
  open('/p/project-x/agents/W-1');
  const steps = await flow();
  expect(steps.getAllByRole('heading', { level: 2 }).map(heading => heading.textContent)).toEqual([
    'You',
    'Writing',
    'Engineering',
    'You',
  ]);
  expect(steps.getByText('Send an idea')).toBeTruthy();
  expect(steps.getByText('Integrate what passed review')).toBeTruthy();
  const engineering = team('Engineering');
  expect(engineering.getByText('EN')).toBeTruthy();
  expect(engineering.getByText('Build the product.')).toBeTruthy();
  expect(engineering.getByText('Led by Ana')).toBeTruthy();
  expect(engineering.getByRole('link', { name: 'Edit the team' }).getAttribute('href')).toBe(
    '/p/project-x/agents?team=engineering',
  );
  expect(team('Writing').getByText('Led by Kit')).toBeTruthy();
  // Each team's agents are its own, side by side.
  expect(engineering.getAllByRole('link', { name: /^(Eli|Ana)/ })).toHaveLength(2);
  expect(team('Writing').queryByRole('link', { name: /^(Eli|Ana)/ })).toBeNull();
  // Adding a team opens a new team's editor; adding an agent opens the first team's, with Add an agent open.
  const page = within(screen.getByRole('region', { name: 'Agents' }));
  expect(page.getByRole('link', { name: 'Add a team' }).getAttribute('href')).toBe('/p/project-x/agents?team=new');
  expect(page.getByRole('link', { name: 'Add an agent' }).getAttribute('href')).toBe(
    '/p/project-x/agents?team=writing&add=true',
  );
});

test('an agent card says what it does by label, what it runs on and whether it is free, paused or running', async () => {
  open('/p/project-x/agents/W-1');
  await flow();
  const eli = within(card(/^Eli/));
  expect(eli.getByText('Does: Code change, General task')).toBeTruthy();
  expect(eli.getByText('Runs on: Codex · gpt-5 · extra-high')).toBeTruthy();
  expect(eli.getByText('Free')).toBeTruthy();
  const ana = within(card(/^Ana/));
  expect(ana.getByText('Does: Code review')).toBeTruthy();
  expect(ana.getByText('Runs on: Claude Code · opus · high')).toBeTruthy();
  expect(ana.getByText('Paused')).toBeTruthy();
  const kit = within(card(/^Kit/));
  expect(kit.getByText('Does: no kind of work of its own')).toBeTruthy();
  expect(kit.getByText('Runs on: Codex · default model')).toBeTruthy();
  // A running agent's card names what it is working on, not a count.
  expect(kit.getByText('Working on: Write the guide')).toBeTruthy();
  expect(kit.queryByText(/running/)).toBeNull();
  expect(kit.queryByText('Free')).toBeNull();
});

test("an agent running two attempts at once lists each one's task on its card, in the order they started", async () => {
  controller.tasks = [
    ...controller.tasks,
    taskFixture('T-board', {
      title: 'Build the board',
      kind: 'studio-development:change',
      status: 'review',
      workerId: 'W-1',
    }),
  ];
  // Kit's review of the board started after the guide, and is stopping; the stand-in holds it first.
  controller.attempts = [
    {
      id: 'attempt-check',
      taskId: 'T-board',
      status: 'stopping',
      workerId: 'W-3',
      startedAt: '2026-10-29T10:05:00Z',
      assignment: { kind: 'studio-development:change-review' },
    },
    { ...controller.attempts[0]!, startedAt: '2026-10-29T10:00:00Z' },
  ];
  open('/p/project-x/agents/W-1');
  await flow();
  const kit = card(/^Kit/);
  expect(
    [...kit.querySelectorAll('.sd-meta')]
      .map(line => line.textContent)
      .filter(text => /^(Working on|Reviewing):/.test(text ?? '')),
  ).toEqual(['Working on: Write the guide', 'Reviewing: Build the board']);
  // Text on the card, which is itself the link to Kit, not links of their own.
  expect(within(kit).queryAllByRole('link')).toEqual([]);
  expect(kit.getAttribute('href')).toBe('/p/project-x/agents/W-3');
  expect(within(card(/^Eli/)).getByText('Free')).toBeTruthy();
  expect(within(card(/^Ana/)).getByText('Paused')).toBeTruthy();
});

test('picking a card opens its agent with that card current', async () => {
  const user = userEvent.setup();
  const router = open('/p/project-x/agents/W-1');
  await flow();
  expect(card(/^Eli/).getAttribute('aria-current')).toBe('page');
  expect(card(/^Ana/).getAttribute('aria-current')).toBeNull();
  await user.click(card(/^Ana/));
  await waitFor(() => expect(router.state.location.pathname).toBe('/p/project-x/agents/W-2'));
  expect(await screen.findByRole('heading', { level: 2, name: 'Ana' })).toBeTruthy();
  expect(card(/^Ana/).getAttribute('aria-current')).toBe('page');
  expect(card(/^Eli/).getAttribute('aria-current')).toBeNull();
});

test("What they're told shows the picked agent's project, team and own rule counts, and opens the rules", async () => {
  const user = userEvent.setup();
  const ana: ToldView = toldFixture('W-2');
  ana.agent = { ...ana.agent, id: 'W-2', name: 'Ana', role: 'Reviewer' };
  ana.layers = ana.layers.map(layer =>
    layer.layer === 'own'
      ? {
          ...layer,
          rules: [
            { title: 'Read the diff', text: 'Read every changed line.' },
            { title: 'Run the checks', text: 'Run the focused tests.' },
            { title: null, text: 'Say what you could not check.' },
          ],
        }
      : layer,
  );
  controller.told['W-2'] = ana;
  open('/p/project-x/agents/W-1');
  const told = within(await screen.findByRole('region', { name: "What they're told" }));
  // The stand-in tells Eli one project rule, one Engineering rule and two of his own.
  expect(await told.findByText("Eli's own rules")).toBeTruthy();
  const counts = () =>
    told.getAllByRole('listitem').map(item => [item.firstChild?.textContent, item.lastChild?.textContent]);
  expect(counts()).toEqual([
    ["The project's rules", '1 rule'],
    ["Engineering's rules", '1 rule'],
    ["Eli's own rules", '2 rules'],
  ]);
  expect(told.getByRole('link', { name: 'Open the rules' }).getAttribute('href')).toBe(
    '/p/project-x/agents/instructions',
  );
  expect(controller.reads()).toContain('/api/projects/project-x/agents/W-1/told');
  // Picking another agent reads what that agent is told.
  await user.click(card(/^Ana/));
  expect(await told.findByText("Ana's own rules")).toBeTruthy();
  expect(counts()).toEqual([
    ["The project's rules", '1 rule'],
    ["Engineering's rules", '1 rule'],
    ["Ana's own rules", '3 rules'],
  ]);
});

test('Not in this flow lists exactly the kinds the studio has that the project does not take', async () => {
  open('/p/project-x/agents/W-1');
  const outside = within(await screen.findByRole('region', { name: 'Not in this flow' }));
  expect(outside.getAllByRole('listitem').map(item => item.textContent)).toEqual(['Plan the steps', 'Layout']);
  expect(outside.getByText(/Each is turned on from an agent's Does list/)).toBeTruthy();
});

test('a project without teams shows the two You ends, Add a team and that it has no teams yet', async () => {
  controller.shell = {
    ...controller.shell,
    teams: [],
    workers: [],
    organizationConfiguration: { revision: 1, teams: [], members: [], taskKinds: ['general'], kindOwners: {} },
  };
  controller.tasks = [];
  controller.attempts = [];
  open('/p/project-x/agents');
  const steps = await flow();
  expect(steps.getAllByRole('heading', { level: 2 }).map(heading => heading.textContent)).toEqual(['You', 'You']);
  expect(steps.getByText(/Project X has no teams yet/)).toBeTruthy();
  expect(
    within(screen.getByRole('region', { name: 'Agents' }))
      .getByRole('link', { name: 'Add a team' })
      .getAttribute('href'),
  ).toBe('/p/project-x/agents?team=new');
  // With no agent there is no one's rules to read.
  expect(screen.queryByRole('region', { name: "What they're told" })).toBeNull();
});

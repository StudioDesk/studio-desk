// The Agents page's Add an agent: its own panel in the editor's place, with the team the agent joins and both ways to
// add one, an agent the studio has or a new one, each saved at once; Cancel sends nothing, and on a phone the panel
// opens under the page's buttons. Model-free, with the stand-in controller.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, latest, type Controller } from './test-controller';

const change = 'studio-development:change';

let controller: Controller;
beforeEach(() => {
  controller = fakeController();
  // Saved with Product first, so the team choice follows the saved order, not the names'.
  const teams = [
    { id: 'product', name: 'Product', mark: 'PR', purpose: 'Shape the product.', leadId: 'W-1', goalTaskIds: [] },
    { id: 'review', name: 'Review', mark: 'RV', purpose: 'Check the work.', leadId: 'W-2', goalTaskIds: [] },
  ];
  const worker = (id: string, displayName: string, jobTitle: string, team: string, teamId: string) => ({
    id,
    displayName,
    jobTitle,
    team,
    teamId,
    provider: 'codex',
    model: '',
    enabled: true,
  });
  controller.shell = {
    ...controller.shell,
    teams,
    workers: [
      worker('W-1', 'Eli', 'Product lead', 'Product', 'product'),
      worker('W-2', 'Ana', 'Reviewer', 'Review', 'review'),
    ],
    employeeDirectory: [
      { id: 'W-1', displayName: 'Eli', jobTitle: 'Product lead', provider: 'codex', enabled: true },
      { id: 'W-2', displayName: 'Ana', jobTitle: 'Reviewer', provider: 'codex', enabled: true },
      {
        id: 'W-hazel',
        displayName: 'Hazel',
        jobTitle: 'Designer',
        responsibility: 'Draws the screens.',
        provider: 'claude',
        enabled: true,
      },
      {
        id: 'W-kit',
        displayName: 'Kit',
        jobTitle: 'Copywriter',
        responsibility: 'Writes the launch posts.',
        provider: 'codex',
        enabled: true,
        projectId: 'project-x',
      },
      { id: 'W-gone', displayName: 'Old', provider: 'codex', enabled: false, projectId: 'project-x', deletedAt: 'x' },
    ],
    adapters: {
      codex: { id: 'codex', name: 'Codex CLI', available: true, workerSelectable: true, modes: ['workspace'] },
      claude: { id: 'claude', name: 'Claude Code CLI', available: true, workerSelectable: true, modes: ['workspace'] },
    },
    taskKinds: {
      general: { label: 'General task', available: true },
      [change]: { label: 'Code change', available: true },
    },
    organizationConfiguration: {
      revision: 3,
      teams,
      members: [
        { workerId: 'W-1', teamId: 'product', role: 'Product lead', responsibility: 'Shapes the product.', roles: [] },
        {
          workerId: 'W-2',
          teamId: 'review',
          role: 'Reviewer',
          responsibility: 'Reviews the work.',
          roles: ['reviewer'],
        },
      ],
      taskKinds: ['general', change],
      kindOwners: { general: 'W-1', [change]: 'W-2' },
      tiers: {},
    },
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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
const commands = () => controller.requests.filter(request => request.method !== 'GET');
// The page's own Add an agent, in its head above the flow, and the panel it opens.
const addAnAgent = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(
    within(await screen.findByRole('region', { name: 'Agents' })).getByRole('link', { name: 'Add an agent' }),
  );
  return screen.findByRole('region', { name: 'Add an agent' });
};
const teamChoice = (panel: HTMLElement) => within(panel).getByLabelText('Team') as HTMLSelectElement;
// The studio's agents the panel lists, each row's name, job title and responsibility.
const studioRows = (panel: HTMLElement) =>
  within(within(panel).getByRole('list', { name: 'Agents the studio has' }))
    .getAllByRole('button')
    .map(row => [...row.querySelectorAll('b, .sd-meta')].map(line => line.textContent));
// The window's width as the page's layout reads it (agents-layout.ts): a phone matches the design's break, checked
// first. afterEach puts the window's own back.
const width = (phone: boolean) =>
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: phone && query === '(max-width: 860px)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));

test("the top Add an agent opens its titled panel in the editor's place, with the team choice, both choices and focus", async () => {
  const user = userEvent.setup();
  const router = open('/p/project-x/agents/W-1');
  const region = await addAnAgent(user);
  await waitFor(() => expect(router.state.location.search).toEqual({ add: true }));
  expect(router.state.location.pathname).toBe('/p/project-x/agents');
  const panel = within(region),
    heading = panel.getByRole('heading', { level: 2, name: 'Add an agent' });
  expect(panel.getByText("The agent joins one of Project X's teams and takes work from its flow.")).toBeTruthy();
  // The project's teams in their saved order, the first one chosen.
  const team = teamChoice(region);
  expect([...team.options].map(option => option.textContent)).toEqual(['Product', 'Review']);
  expect(team.value).toBe('product');
  expect(panel.getByRole('region', { name: 'An agent the studio has' })).toBeTruthy();
  expect(panel.getByRole('region', { name: 'Make a new one' })).toBeTruthy();
  expect(panel.getByRole('form', { name: 'A new agent for Product' })).toBeTruthy();
  // Beside the flow in the editor's place, its column's own, not under the page's buttons or in the flow's column; the
  // agent's editor gone, and the panel's heading has the focus.
  const steps = screen.getByRole('list', { name: 'How the work flows' });
  expect(region.parentElement?.classList.contains('sd-agents__editor')).toBe(true);
  expect(steps.parentElement?.contains(region)).toBe(false);
  expect(steps.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(region.closest('.sd-agents')).toBe(steps.closest('.sd-agents'));
  expect(screen.queryByRole('heading', { level: 2, name: 'Eli' })).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(heading));
  expect(commands()).toEqual([]);
});

test("the studio list shows only the studio's agents outside the project, and its search narrows it", async () => {
  const user = userEvent.setup();
  open('/p/project-x/agents');
  const region = await addAnAgent(user),
    has = within(within(region).getByRole('region', { name: 'An agent the studio has' }));
  // Eli and Ana are in the project's organization and Old is deleted, so none of them is offered.
  expect(studioRows(region)).toEqual([
    ['Hazel', 'Designer', 'Draws the screens.'],
    ['Kit', 'Copywriter', 'Writes the launch posts.'],
  ]);
  // The search reads names, job titles and what each is responsible for.
  const find = has.getByLabelText('Find an agent');
  await user.type(find, 'launch');
  expect(studioRows(region)).toEqual([['Kit', 'Copywriter', 'Writes the launch posts.']]);
  await user.clear(find);
  await user.type(find, 'designer');
  expect(studioRows(region).map(row => row[0])).toEqual(['Hazel']);
  await user.clear(find);
  await user.type(find, 'hazel');
  expect(studioRows(region).map(row => row[0])).toEqual(['Hazel']);
  await user.clear(find);
  await user.type(find, 'juggler');
  expect(has.queryByRole('list', { name: 'Agents the studio has' })).toBeNull();
  expect(has.getByText('No agent the studio has matches “juggler”.')).toBeTruthy();
  cleanup();
  // With every agent the studio has in the project, it says so.
  controller.shell = {
    ...controller.shell,
    employeeDirectory: controller.shell.employeeDirectory!.filter(item => ['W-1', 'W-2'].includes(item.id)),
  };
  open('/p/project-x/agents');
  const all = within(within(await addAnAgent(user)).getByRole('region', { name: 'An agent the studio has' }));
  expect(all.getByText('Every agent the studio has is already in Project X.')).toBeTruthy();
  expect(all.queryByLabelText('Find an agent')).toBeNull();
  expect(commands()).toEqual([]);
});

test('picking a studio agent for the second team saves the organization at once, says so and opens its editor', async () => {
  const user = userEvent.setup();
  const router = open('/p/project-x/agents');
  const region = await addAnAgent(user);
  await user.selectOptions(teamChoice(region), 'review');
  await user.click(
    within(within(region).getByRole('list', { name: 'Agents the studio has' })).getByRole('button', { name: /Hazel/ }),
  );
  await waitFor(() => expect(commands()).toHaveLength(1));
  // Hazel joins Review with her job, and every other part of the saved organization stays as it was.
  expect(commands()[0]).toEqual({
    url: '/api/projects/project-x/organization',
    method: 'PATCH',
    body: {
      projectId: 'project-x',
      expectedRevision: 3,
      teams: [
        { id: 'product', name: 'Product', mark: 'PR', purpose: 'Shape the product.', leadId: 'W-1' },
        { id: 'review', name: 'Review', mark: 'RV', purpose: 'Check the work.', leadId: 'W-2' },
      ],
      members: [
        { workerId: 'W-1', teamId: 'product', role: 'Product lead', responsibility: 'Shapes the product.', roles: [] },
        {
          workerId: 'W-2',
          teamId: 'review',
          role: 'Reviewer',
          responsibility: 'Reviews the work.',
          roles: ['reviewer'],
        },
        { workerId: 'W-hazel', teamId: 'review', role: 'Designer', responsibility: 'Draws the screens.', roles: [] },
      ],
      taskKinds: ['general', change],
      kindOwners: { general: 'W-1', [change]: 'W-2' },
    },
  });
  expect((await screen.findByText('Hazel joined Review')).getAttribute('role')).toBe('status');
  await waitFor(() => expect(router.state.location.pathname).toBe('/p/project-x/agents/W-hazel'));
  expect(router.state.location.search).toEqual({});
  expect(screen.queryByRole('region', { name: 'Add an agent' })).toBeNull();
  // The controller's change brings her in: her card shows in Review's step, current, and her editor opens.
  const hazel = controller.shell.employeeDirectory!.find(item => item.id === 'W-hazel')!;
  controller.shell = {
    ...controller.shell,
    workers: [...controller.shell.workers, { ...hazel, team: 'Review', teamId: 'review' }],
  };
  latest().emit('change', { version: 2, start: 'start-a', changes: [{ seq: 2, type: 'organization' }] });
  const review = within(
    within(screen.getByRole('list', { name: 'How the work flows' })).getByRole('region', { name: 'Review' }),
  );
  expect((await review.findByRole('link', { name: /^Hazel/ })).getAttribute('aria-current')).toBe('page');
  expect(await screen.findByRole('heading', { level: 2, name: 'Hazel' })).toBeTruthy();
  expect(commands()).toHaveLength(1);
});

test('a studio agent without a job of its own joins as a project contributor', async () => {
  const user = userEvent.setup();
  controller.shell = {
    ...controller.shell,
    employeeDirectory: [
      ...controller.shell.employeeDirectory!.filter(item => ['W-1', 'W-2'].includes(item.id)),
      { id: 'W-moss', displayName: 'Moss', provider: 'codex', enabled: true },
    ],
  };
  open('/p/project-x/agents');
  const region = await addAnAgent(user);
  expect(studioRows(region)).toEqual([['Moss']]);
  await user.click(within(region).getByRole('button', { name: /Moss/ }));
  await waitFor(() => expect(commands()).toHaveLength(1));
  const body = commands()[0]!.body as { members: unknown[] };
  expect(body.members.at(-1)).toEqual({
    workerId: 'W-moss',
    teamId: 'product',
    role: 'Project contributor',
    responsibility: 'Perform bounded project work and submit evidence for director review.',
    roles: [],
  });
  expect(await screen.findByText('Moss joined Product')).toBeTruthy();
});

test('Make a new one makes the agent for the chosen team at once, says so and opens its editor', async () => {
  const user = userEvent.setup();
  controller.command = url =>
    url === '/api/projects/project-x/agents'
      ? {
          worker: {
            id: 'W-new',
            displayName: 'Iris',
            jobTitle: 'Tester',
            responsibility: 'Tests the product.',
            provider: 'claude',
            projectId: 'project-x',
            enabled: true,
          },
          revision: 4,
        }
      : {};
  const router = open('/p/project-x/agents');
  const region = await addAnAgent(user);
  await user.selectOptions(teamChoice(region), 'review');
  const form = within(
    within(within(region).getByRole('region', { name: 'Make a new one' })).getByRole('form', {
      name: 'A new agent for Review',
    }),
  );
  await user.type(form.getByLabelText('Name'), 'Iris');
  await user.type(form.getByLabelText('Job title'), 'Tester');
  await user.type(form.getByLabelText('What it is responsible for'), 'Tests the product.');
  await user.selectOptions(form.getByLabelText('CLI'), 'claude');
  await user.type(form.getByLabelText('Model'), 'opus');
  // The panel's own Cancel is the only one: the form has none of its own here.
  expect(within(region).getAllByRole('button', { name: 'Cancel' })).toHaveLength(1);
  await user.click(form.getByRole('button', { name: 'Make the agent' }));
  await waitFor(() => expect(commands()).toHaveLength(1));
  expect(commands()[0]).toEqual({
    url: '/api/projects/project-x/agents',
    method: 'POST',
    body: {
      projectId: 'project-x',
      expectedRevision: 3,
      displayName: 'Iris',
      jobTitle: 'Tester',
      responsibility: 'Tests the product.',
      teamId: 'review',
      roles: [],
      provider: 'claude',
      model: 'opus',
      effort: '',
      mode: '',
      instructions: '',
    },
  });
  expect((await screen.findByText('Iris joined Review')).getAttribute('role')).toBe('status');
  await waitFor(() => expect(router.state.location.pathname).toBe('/p/project-x/agents/W-new'));
  expect(router.state.location.search).toEqual({});
  expect(commands()).toHaveLength(1);
});

test('Cancel sends nothing and returns to the agents as they were', async () => {
  const user = userEvent.setup();
  const router = open('/p/project-x/agents');
  const flowOf = () =>
    within(screen.getByRole('list', { name: 'How the work flows' }))
      .getAllByRole('region')
      .map(step => [
        within(step).getByRole('heading', { level: 2 }).textContent,
        within(step)
          .queryAllByRole('link', { name: /^(Eli|Ana|Hazel|Kit)/ })
          .map(card => card.querySelector('b')?.textContent),
      ]);
  await screen.findByRole('list', { name: 'How the work flows' });
  const before = flowOf();
  expect(before).toEqual([
    ['Product', ['Eli']],
    ['Review', ['Ana']],
  ]);
  const region = await addAnAgent(user),
    panel = within(region);
  await user.selectOptions(teamChoice(region), 'review');
  await user.type(panel.getByLabelText('Find an agent'), 'haz');
  const form = within(panel.getByRole('form', { name: 'A new agent for Review' }));
  await user.type(form.getByLabelText('Name'), 'Zed');
  await user.type(form.getByLabelText('Job title'), 'Juggler');
  await user.click(panel.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(router.state.location.search).toEqual({}));
  expect(router.state.location.pathname).toBe('/p/project-x/agents');
  expect(screen.queryByRole('region', { name: 'Add an agent' })).toBeNull();
  expect(flowOf()).toEqual(before);
  expect(commands()).toEqual([]);
});

test('on a phone the panel opens inside the Agents region under its buttons and is brought into view', async () => {
  const user = userEvent.setup(),
    scrolled = vi.fn();
  width(true);
  Element.prototype.scrollIntoView = scrolled;
  try {
    open('/p/project-x/agents/W-1');
    const region = await addAnAgent(user),
      // The Agents page's own address renders the flow afresh, so it is found again.
      agents = screen.getByRole('region', { name: 'Agents' }),
      button = within(agents).getByRole('link', { name: 'Add an agent' });
    expect(agents.contains(region)).toBe(true);
    // After the page's buttons and before the flow.
    expect(button.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      region.compareDocumentPosition(within(agents).getByRole('list', { name: 'How the work flows' })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getAllByRole('region', { name: 'Add an agent' })).toHaveLength(1);
    await waitFor(() => expect(scrolled.mock.contexts).toContain(region));
    expect(document.activeElement).toBe(within(region).getByRole('heading', { level: 2, name: 'Add an agent' }));
    expect(commands()).toEqual([]);
  } finally {
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  }
});

test("a refusal shows the controller's message in the panel and keeps it open", async () => {
  const user = userEvent.setup();
  controller.command = () => {
    throw Object.assign(new Error('Project organization changed. Refresh before saving.'), { status: 409 });
  };
  const router = open('/p/project-x/agents');
  const region = await addAnAgent(user),
    panel = within(region);
  await user.click(panel.getByRole('button', { name: /Hazel/ }));
  const has = within(panel.getByRole('region', { name: 'An agent the studio has' }));
  expect(await has.findByRole('alert')).toHaveProperty(
    'textContent',
    'Project organization changed. Refresh before saving.',
  );
  // A new one refused says so in its form, and the panel stays, with what was typed.
  const form = within(panel.getByRole('form', { name: 'A new agent for Product' }));
  await user.type(form.getByLabelText('Name'), 'Iris');
  await user.type(form.getByLabelText('Job title'), 'Tester');
  await user.click(form.getByRole('button', { name: 'Make the agent' }));
  expect(await form.findByRole('alert')).toHaveProperty(
    'textContent',
    'Project organization changed. Refresh before saving.',
  );
  expect((form.getByLabelText('Name') as HTMLInputElement).value).toBe('Iris');
  expect(commands().map(command => [command.method, command.url])).toEqual([
    ['PATCH', '/api/projects/project-x/organization'],
    ['POST', '/api/projects/project-x/agents'],
  ]);
  expect(screen.getByRole('region', { name: 'Add an agent' })).toBe(region);
  expect(router.state.location.search).toEqual({ add: true });
  expect(screen.queryByText(/joined/)).toBeNull();
});

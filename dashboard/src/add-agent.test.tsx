// The Agents page's Add an agent: its own panel in the editor's place, with the team the agent joins first and then both
// ways to add one, a new one and an agent the studio has, each saved at once; Cancel sends nothing, and on a phone the
// panel opens under the page's buttons. Model-free, with the stand-in controller. The layout checks read the dashboard's
// stylesheet on the rendered elements; jsdom lays nothing out, so they check the stylesheet's constraints and its
// container rule, never rendered dimensions, and the widths they decide on are worked out, not measured.
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
// A window this many pixels wide as matchMedia reads it: each max-width query matches at its width and under, so the
// page takes the layout agents-layout.ts gives that width. afterEach puts the window's own back.
const windowOf = (pixels: number) =>
  vi.stubGlobal('matchMedia', (query: string) => {
    const max = /^\(max-width: (\d+)px\)$/.exec(query);
    return {
      matches: !!max && pixels <= Number(max[1]),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  });
const follows = (earlier: Node, later: Node) =>
  !!(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);
// The two choices in their shared layout: one grid in the choices' own container holding Make a new one and then An
// agent the studio has, and nothing else.
const choicesIn = (container: HTMLElement) => {
  const make = within(container).getByRole('region', { name: 'Make a new one' }),
    has = within(container).getByRole('region', { name: 'An agent the studio has' }),
    grid = make.parentElement!,
    box = grid.parentElement!;
  expect(grid.className).toBe('sd-addagent__choices');
  expect([...grid.children]).toEqual([make, has]);
  expect(box.className).toBe('sd-addagent');
  return { make, has, grid, box };
};
// The dashboard's own stylesheet in the page while a check reads it. jsdom's getComputedStyle applies a sheet's plain
// rules as declared, var() and percentages unresolved, and no @container or max-width @media rule.
const stylesheet = async () => {
  // The file's base kept apart, so Vite does not rewrite the stylesheet's URL as a browser asset's.
  const base = import.meta.url,
    { readFileSync } = await vi.importActual<{ readFileSync: (file: URL, encoding: 'utf8') => string }>('node:fs'),
    style = document.createElement('style');
  style.textContent = readFileSync(new URL('./design/bundle.css', base), 'utf8');
  document.head.append(style);
  return style;
};
const css = (element: Element, property: string) => getComputedStyle(element).getPropertyValue(property);
const none = /^(0(px)?)?$/;
// The choices' one container rule: the container it reads, the width from which the two sit side by side, and its
// rule for the choices' grid there.
const containerFit = (sheet: CSSStyleSheet) => {
  const rules = [...sheet.cssRules].filter(
    rule => rule.cssText.startsWith('@container') && (rule as CSSContainerRule).containerName === 'addagent',
  ) as CSSContainerRule[];
  expect(rules).toHaveLength(1);
  const [rule] = rules,
    from = /^\(min-width: (\d+)px\)$/.exec(rule!.containerQuery),
    inner = [...rule!.cssRules] as CSSStyleRule[];
  expect(from).not.toBeNull();
  expect(inner).toHaveLength(1);
  return { from: Number(from![1]), rule: inner[0]! };
};
// Text that wraps inside its side: from it up to the choices' container, which breaks long words anywhere, nothing keeps
// a line whole, cuts it off or hides what overflows.
const wraps = (text: Element, box: Element) => {
  expect(box.contains(text)).toBe(true);
  expect(css(box, 'overflow-wrap')).toBe('anywhere');
  for (let node: Element | null = text; node && node !== box.parentElement; node = node.parentElement) {
    expect(['', 'anywhere'], node.className).toContain(css(node, 'overflow-wrap'));
    expect(css(node, 'white-space'), node.className).not.toMatch(/nowrap|pre$/);
    expect(css(node, 'text-overflow'), node.className).not.toBe('ellipsis');
    expect(['', 'visible'], node.className).toContain(css(node, 'overflow'));
    expect(['', 'none'], node.className).toContain(css(node, 'max-height'));
    expect(['', 'auto', '100%'], node.className).toContain(css(node, 'width'));
  }
};

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
  // The team first, then Make a new one and An agent the studio has, in their shared layout.
  const { make, has } = choicesIn(region);
  expect(follows(team, make)).toBe(true);
  expect(follows(make, has)).toBe(true);
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

test('the team comes first, then Make a new one and An agent the studio has, each holding its own fields and actions', async () => {
  const user = userEvent.setup();
  open('/p/project-x/agents');
  const region = await addAnAgent(user),
    team = teamChoice(region),
    { make, has, box } = choicesIn(region);
  expect(follows(team, make) && follows(make, has)).toBe(true);
  // The team is chosen once, in the panel's head, and not again in the choices.
  expect(within(region).getAllByLabelText('Team')).toHaveLength(1);
  expect(box.contains(team)).toBe(false);
  const form = within(make).getByRole('form', { name: 'A new agent for Product' });
  expect(form.parentElement).toBe(make);
  expect(within(form).getByText(/^A new agent for Product\. It belongs to Project X:/)).toBeTruthy();
  for (const label of ['Name', 'Job title', 'What it is responsible for', 'CLI', 'Model', 'Effort', 'Staffing roles'])
    expect(within(form).getByLabelText(label).closest('.sd-addagent__choice')).toBe(make);
  expect(within(form).getByLabelText('CLI').closest('.sd-fieldgrid')?.parentElement).toBe(form);
  expect(
    within(form).getByRole('button', { name: 'Make the agent' }).closest('.sd-addagent__actions')?.parentElement,
  ).toBe(form);
  expect(within(has).getByLabelText('Find an agent').closest('.sd-addagent__choice')).toBe(has);
  expect(within(has).getByRole('list', { name: 'Agents the studio has' }).closest('.sd-addagent__choice')).toBe(has);
  expect(within(make).queryByLabelText('Find an agent')).toBeNull();
  expect(within(has).queryByRole('form')).toBeNull();
  // Another team keeps the layout and names its own team.
  await user.selectOptions(team, 'review');
  expect(within(choicesIn(region).make).getByRole('form', { name: 'A new agent for Review' })).toBeTruthy();
  expect(commands()).toEqual([]);
});

// The widths the panel's choices get, worked out from the design's measurements (tokens.css, .sd-main, .sd-agents),
// not measured: above 860px a 76px rail and a 248px sidebar, the page's padding of 4vw up to 48px a side and at most
// 1240px of page; beside the flow the editor's column is half of it after a 20px gap; on a phone 16px a side.
const modeled = [
  { window: 1440, layout: 'beside', panel: 500, fits: false },
  { window: 1100, layout: 'under', panel: 688, fits: true },
  { window: 390, layout: 'phone', panel: 358, fits: false },
  // In between: under the flow at 1000 and 1200, and a narrow editor column beside the flow on a 1920 window.
  { window: 1000, layout: 'under', panel: 596, fits: false },
  { window: 1200, layout: 'under', panel: 780, fits: true },
  { window: 1920, layout: 'beside', panel: 610, fits: false },
];

test('at 1440, 1100 and 390 the choices take one layout their own width decides: two equal columns with room, else one', async () => {
  for (const { window: pixels, layout } of modeled.slice(0, 3)) {
    windowOf(pixels);
    open('/p/project-x/agents?add=true');
    const region = await screen.findByRole('region', { name: 'Add an agent' });
    expect(
      screen.getByRole('list', { name: 'How the work flows' }).closest('.sd-agents')?.getAttribute('data-layout'),
    ).toBe(layout);
    const { make, has, grid, box } = choicesIn(region),
      style = await stylesheet();
    try {
      // The container the decision reads is the choices' own, whatever the window.
      expect(css(box, 'container-type')).toBe('inline-size');
      expect(css(box, 'container-name')).toBe('addagent');
      expect(css(grid, 'display')).toBe('grid');
      expect(css(grid, 'grid-template-columns')).toBe('minmax(0, 1fr)');
      for (const side of [make, has]) expect(css(side, 'min-width')).toMatch(none);
      // With room, two equal columns that no content can widen.
      const fit = containerFit(style.sheet!);
      expect(grid.matches(fit.rule.selectorText)).toBe(true);
      expect(fit.rule.style.getPropertyValue('grid-template-columns')).toBe('repeat(2, minmax(0, 1fr))');
      // The decision for each worked-out width: side by side only where both fit.
      expect(modeled.map(item => item.panel >= fit.from)).toEqual(modeled.map(item => item.fits));
    } finally {
      style.remove();
    }
    cleanup();
  }
});

test('each field, the search, the studio agents and the actions span their side, and the studio list grows with the page', async () => {
  const user = userEvent.setup();
  open('/p/project-x/agents');
  const region = await addAnAgent(user),
    { make, has } = choicesIn(region),
    form = within(make).getByRole('form', { name: 'A new agent for Product' }),
    controls = [...form.querySelectorAll('input, select, textarea'), within(has).getByLabelText('Find an agent')],
    list = within(has).getByRole('list', { name: 'Agents the studio has' }),
    rows = within(list).getAllByRole('button');
  expect(controls).toHaveLength(9);
  let style = await stylesheet();
  try {
    // The new one's form is straight in its side: no card, border or padding of its own.
    expect(form.className).toBe('sd-addagent__form');
    for (const side of ['top', 'right', 'bottom', 'left']) expect(css(form, `padding-${side}`)).toMatch(none);
    for (const control of controls) {
      expect(css(control, 'width'), control.id).toBe('100%');
      expect(css(control.closest('.sd-field')!, 'min-width'), control.id).toMatch(none);
    }
    // The CLI, model and effort one under another, here only, even in the editor's column.
    expect(css(form.querySelector('.sd-fieldgrid')!, 'grid-template-columns')).toBe('minmax(0, 1fr)');
    for (const row of rows) expect(css(row, 'width')).toBe('100%');
    expect(css(list, 'max-height')).toBe('none');
    expect(css(list, 'overflow')).toBe('visible');
    expect(css(within(form).getByRole('button', { name: 'Make the agent' }).parentElement!, 'flex-wrap')).toBe('wrap');
  } finally {
    style.remove();
  }
  // The shared CLI fields keep their columns in an agent's Runs on, and the roster list its own box.
  cleanup();
  open('/p/project-x/agents/W-1');
  const runs = await screen.findByRole('region', { name: 'Runs on' });
  style = await stylesheet();
  try {
    expect(css(runs.querySelector('.sd-fieldgrid')!, 'grid-template-columns')).toBe(
      'repeat(auto-fit, minmax(min(220px, 100%), 1fr))',
    );
    const pick = [...style.sheet!.cssRules].find(rule => (rule as CSSStyleRule).selectorText === '.sd-agentpick') as
      | CSSStyleRule
      | undefined;
    expect(pick?.style.getPropertyValue('max-height')).toBe('min(56vh, 520px)');
    expect(pick?.style.getPropertyValue('overflow')).toBe('auto');
  } finally {
    style.remove();
  }
});

test('long names and descriptions, a refusal, no match and no studio agent left all wrap inside their side', async () => {
  const user = userEvent.setup(),
    word = 'Supercalifragilisticexpialidocious'.repeat(3),
    blurb = 'Draws every screen, every state and every icon, then checks each against the design system. '
      .repeat(4)
      .trim(),
    refusal = `Project organization changed while you were choosing ${word}. Refresh the page before saving again.`;
  controller.shell = {
    ...controller.shell,
    employeeDirectory: [
      ...controller.shell.employeeDirectory!,
      {
        id: 'W-long',
        displayName: word,
        jobTitle: `Designer of ${word}`,
        responsibility: blurb,
        provider: 'claude',
        enabled: true,
      },
    ],
  };
  controller.command = () => {
    throw Object.assign(new Error(refusal), { status: 409 });
  };
  open('/p/project-x/agents');
  let region = await addAnAgent(user);
  const { make, has, box } = choicesIn(region),
    form = within(make).getByRole('form', { name: 'A new agent for Product' }),
    row = within(has).getByRole('button', { name: new RegExp(word) });
  expect([...row.querySelectorAll('b, .sd-meta')].map(line => line.textContent)).toEqual([
    word,
    `Designer of ${word}`,
    blurb,
  ]);
  await user.click(row);
  const picked = await within(has).findByRole('alert');
  expect(picked.textContent).toBe(refusal);
  await user.type(within(form).getByLabelText('Name'), 'Iris');
  await user.type(within(form).getByLabelText('Job title'), 'Tester');
  await user.click(within(form).getByRole('button', { name: 'Make the agent' }));
  const made = await within(form).findByRole('alert');
  expect(made.textContent).toBe(refusal);
  await user.click(within(has).getByLabelText('Find an agent'));
  await user.paste(`juggler${word}`);
  const nothing = within(has).getByText(`No agent the studio has matches “juggler${word}”.`);
  // Both sides stay, in their order, through every state.
  expect(choicesIn(region).box).toBe(box);
  let style = await stylesheet();
  try {
    for (const text of [picked, made, nothing, within(form).getByText(/^A new agent for Product\./)]) wraps(text, box);
  } finally {
    style.remove();
  }
  await user.clear(within(has).getByLabelText('Find an agent'));
  style = await stylesheet();
  try {
    for (const line of within(has)
      .getByRole('button', { name: new RegExp(word) })
      .querySelectorAll('b, .sd-meta'))
      wraps(line, box);
  } finally {
    style.remove();
  }
  cleanup();
  controller.shell = {
    ...controller.shell,
    employeeDirectory: controller.shell.employeeDirectory!.filter(item => ['W-1', 'W-2'].includes(item.id)),
  };
  open('/p/project-x/agents');
  region = await addAnAgent(user);
  const empty = choicesIn(region),
    everyone = within(empty.has).getByText('Every agent the studio has is already in Project X.');
  expect(within(empty.make).getByRole('form', { name: 'A new agent for Product' })).toBeTruthy();
  style = await stylesheet();
  try {
    wraps(everyone, empty.box);
  } finally {
    style.remove();
  }
});

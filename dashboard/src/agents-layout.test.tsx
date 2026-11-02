// Model-free placement, resize and fit decisions. Viewport/element geometry and scrolling are mocked; these tests
// do not measure browser pixels. Every stacked layout opens under the picked card; beside starts at the flow.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, cleanup, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { agentsLayout, phoneBreak, phoneQuery, underBreak, underQuery, useAgentsLayout } from './agents-layout';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, type Controller } from './test-controller';

let controller: Controller;
beforeEach(() => {
  controller = fakeController();
  const teams = [
    {
      id: 'engineering',
      name: 'Engineering',
      mark: 'EN',
      purpose: 'Build the product.',
      leadId: 'W-1',
      goalTaskIds: [],
    },
  ];
  controller.shell = {
    ...controller.shell,
    teams,
    workers: [
      {
        id: 'W-1',
        displayName: 'Eli',
        jobTitle: 'Engineer',
        team: 'Engineering',
        teamId: 'engineering',
        provider: 'codex',
        model: '',
        enabled: true,
      },
    ],
    employeeDirectory: [{ id: 'W-1', displayName: 'Eli', provider: 'codex', enabled: true }],
    adapters: {
      codex: {
        id: 'codex',
        name: 'Codex CLI',
        available: true,
        workerSelectable: true,
        modes: ['workspace'],
      },
    },
    taskKinds: { general: { label: 'General task', available: true } },
    organizationConfiguration: {
      revision: 3,
      teams,
      members: [
        {
          workerId: 'W-1',
          teamId: 'engineering',
          role: 'Engineer',
          responsibility: 'Writes the code.',
          roles: [],
        },
      ],
      taskKinds: ['general'],
      kindOwners: { general: 'W-1' },
      tiers: {},
    },
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // The window's own, which jsdom does not have.
  delete (Element.prototype as Partial<Element>).scrollIntoView;
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
// The window as matchMedia reads it, with the queries given matching, as add-agent.test.tsx's width stub does.
const matching = (...queries: string[]) =>
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: queries.includes(query),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
const desktop = () => matching(),
  tablet = () => matching(underQuery),
  // The existing tests' phone, which matches only the design's break.
  phone = () => matching(phoneQuery);
// A window that changes width: each max-width query matches at its width and under, any other query never, and a
// change tells the listeners.
const resizable = (start: number) => {
  let width = start;
  const listeners = new Set<() => void>();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      const max = /^\(max-width: (\d+)px\)$/.exec(query);
      return !!max && width <= Number(max[1]);
    },
    media: query,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  }));
  return {
    listeners,
    resize: (to: number) => {
      width = to;
      act(() => listeners.forEach(listener => listener()));
    },
  };
};
const follows = (earlier: Node, later: Node) =>
  !!(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);
// The page's parts: its region and head, the columns' element, and the flow's list.
const page = async () => {
  const flow = await screen.findByRole('list', { name: 'How the work flows' }),
    region = screen.getByRole('region', { name: 'Agents' }),
    columns = flow.closest<HTMLElement>('.sd-agents')!;
  return {
    flow,
    region,
    columns,
    head: [
      within(region).getByRole('heading', { level: 1, name: 'Agents' }),
      within(region).getByText("How the work flows through Project X's teams"),
      within(region).getByRole('link', { name: 'Add a team' }),
      within(region).getByRole('link', { name: 'Add an agent' }),
    ],
  };
};
const editTeam = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(
    within(
      within(await screen.findByRole('list', { name: 'How the work flows' })).getByRole('region', {
        name: 'Engineering',
      }),
    ).getByRole('link', { name: 'Edit the team' }),
  );
  return screen.findByRole('region', { name: 'Edit Engineering' });
};

test('the width chooses the layout: phone at 860px and under, under to 1200px, beside above it', () => {
  expect([375, 860].map(agentsLayout)).toEqual(['phone', 'phone']);
  expect([861, 1024, 1200].map(agentsLayout)).toEqual(['under', 'under', 'under']);
  expect([1201, 1440].map(agentsLayout)).toEqual(['beside', 'beside']);
  // The queries name the same breaks.
  expect(phoneQuery).toBe(`(max-width: ${phoneBreak}px)`);
  expect(underQuery).toBe(`(max-width: ${underBreak}px)`);
  expect([phoneQuery, underQuery]).toEqual(['(max-width: 860px)', '(max-width: 1200px)']);
});

test("useAgentsLayout reads the window's queries, the phone's first, and is beside where matchMedia is missing", () => {
  expect(typeof window.matchMedia).not.toBe('function');
  expect(renderHook(() => useAgentsLayout()).result.current).toBe('beside');
  desktop();
  expect(renderHook(() => useAgentsLayout()).result.current).toBe('beside');
  tablet();
  expect(renderHook(() => useAgentsLayout()).result.current).toBe('under');
  phone();
  expect(renderHook(() => useAgentsLayout()).result.current).toBe('phone');
  // A real phone matches both.
  matching(phoneQuery, underQuery);
  expect(renderHook(() => useAgentsLayout()).result.current).toBe('phone');
});

test('useAgentsLayout follows the window as it changes width, as agentsLayout chooses, and stops when unmounted', () => {
  const screenSize = resizable(1440),
    { result, unmount } = renderHook(() => useAgentsLayout());
  expect(result.current).toBe('beside');
  for (const width of [1200, 861, 860, 375, 1024, 1201, 1440]) {
    screenSize.resize(width);
    expect([width, result.current]).toEqual([width, agentsLayout(width)]);
  }
  expect(screenSize.listeners.size).toBeGreaterThan(0);
  unmount();
  expect(screenSize.listeners.size).toBe(0);
});

test("on a desktop the head is above both columns, and the agent's editor starts its own column level with the flow", async () => {
  desktop();
  open('/p/project-x/agents/W-1');
  const { flow, region, columns, head } = await page(),
    does = await screen.findByRole('region', { name: 'Does' }),
    told = await screen.findByRole('region', { name: "What they're told" });
  expect(columns.getAttribute('data-layout')).toBe('beside');
  expect(region.contains(columns)).toBe(true);
  // The head comes before the columns and is in neither.
  for (const part of head) {
    expect(follows(part, columns)).toBe(true);
    expect(columns.contains(part)).toBe(false);
  }
  // Two columns: the flow's, starting with the flow, What they're told under it; and the editor's, the editor alone.
  const visibleColumns = [...columns.children].filter(element => !(element as HTMLElement).hidden),
    [flowColumn, editorColumn] = visibleColumns;
  expect(visibleColumns).toHaveLength(2);
  expect(flowColumn!.firstElementChild).toBe(flow);
  expect(flowColumn!.contains(told)).toBe(true);
  expect(follows(flow, told)).toBe(true);
  expect(flowColumn!.contains(does)).toBe(false);
  expect(editorColumn!.classList.contains('sd-agents__editor')).toBe(true);
  expect(editorColumn!.children).toHaveLength(1);
  expect(editorColumn!.firstElementChild!.contains(does)).toBe(true);
  expect(
    within(editorColumn!.firstElementChild as HTMLElement).getByRole('heading', { level: 2, name: 'Eli' }),
  ).toBeTruthy();
});

test("on a desktop Edit the team's editor starts its own column level with the flow, under the page's head", async () => {
  const user = userEvent.setup();
  desktop();
  open('/p/project-x/agents/W-1');
  const editor = await editTeam(user),
    { flow, columns, head } = await page();
  expect(columns.getAttribute('data-layout')).toBe('beside');
  for (const part of head) {
    expect(follows(part, columns)).toBe(true);
    expect(columns.contains(part)).toBe(false);
  }
  const visibleColumns = [...columns.children].filter(element => !(element as HTMLElement).hidden),
    [flowColumn, editorColumn] = visibleColumns;
  expect(visibleColumns).toHaveLength(2);
  expect(flowColumn!.firstElementChild).toBe(flow);
  expect(flowColumn!.contains(editor)).toBe(false);
  expect(editorColumn!.classList.contains('sd-agents__editor')).toBe(true);
  expect(editorColumn!.children).toHaveLength(1);
  expect(editorColumn!.firstElementChild).toBe(editor);
  // Its bar that saves the team is inside the column, at the editor's foot.
  expect(editorColumn!.querySelector('.sd-editbar')).toBe(editor.lastElementChild);
});

// A second team after Engineering, Review, with Ana in it, so a pick can move from one team's step to another's.
const withReview = () => {
  const review = {
      id: 'review',
      name: 'Review',
      mark: 'RV',
      purpose: 'Check the work.',
      leadId: 'W-2',
      goalTaskIds: [],
    },
    ana = {
      id: 'W-2',
      displayName: 'Ana',
      jobTitle: 'Reviewer',
      team: 'Review',
      teamId: 'review',
      provider: 'codex',
    },
    shell = controller.shell,
    config = shell.organizationConfiguration!,
    teams = [...shell.teams!, review];
  controller.shell = {
    ...shell,
    teams,
    workers: [...shell.workers, { ...ana, model: '', enabled: true }],
    employeeDirectory: [
      ...shell.employeeDirectory!,
      { id: 'W-2', displayName: 'Ana', provider: 'codex', enabled: true },
    ],
    organizationConfiguration: {
      ...config,
      teams,
      members: [
        ...config.members!,
        {
          workerId: 'W-2',
          teamId: 'review',
          role: 'Reviewer',
          responsibility: 'Reviews the work.',
          roles: [],
        },
      ],
    },
  };
};
// A team's step in the flow, its card (the region named for it) and an agent's card in the flow.
const stepOf = (team: string) => {
  const card = within(screen.getByRole('list', { name: 'How the work flows' })).getByRole('region', {
    name: team,
  });
  return { card, step: card.closest('li')! };
};
const cardOf = (workerId: string) =>
  document.querySelector<HTMLElement>(`a.sd-agentrow[href="/p/project-x/agents/${workerId}"]`)!;
// The stacked editor's wrapper, which comes into view, with Close at its top.
const wrapperOf = (editor: HTMLElement) => editor.closest<HTMLElement>('.sd-agents__picked')!;

test.each([390, 900, 1100, 1200])(
  "at %ipx the agent in the address opens its editor under its card in its team's step, alone, in view and with Close",
  async width => {
    resizable(width);
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    withReview();
    open('/p/project-x/agents/W-1');
    const does = await screen.findByRole('region', { name: 'Does' }),
      { flow, columns, head } = await page(),
      engineering = stepOf('Engineering'),
      review = stepOf('Review'),
      card = cardOf('W-1'),
      wrapper = wrapperOf(does);
    expect(columns.getAttribute('data-layout')).toBe(agentsLayout(width));
    for (const part of head) expect(follows(part, columns)).toBe(true);
    // In Engineering's card, right after Eli's, at the full width of its agents' row, and before Review's step.
    expect(screen.getAllByRole('region', { name: 'Does' })).toHaveLength(1);
    expect(engineering.card.contains(does)).toBe(true);
    expect(card.getAttribute('aria-current')).toBe('page');
    expect(card.nextElementSibling).toBe(wrapper);
    expect(wrapper.parentElement).toBe(card.parentElement);
    expect(follows(does, review.step)).toBe(true);
    expect(review.step.contains(does)).toBe(false);
    // Nothing in an editor's column, and What they're told still after the flow.
    expect(columns.querySelector('.sd-agents__editor')).toBeNull();
    const told = screen.getByRole('region', { name: "What they're told" });
    expect(follows(flow, told)).toBe(true);
    expect(wrapper.contains(told)).toBe(false);
    // Close first, then Eli's editor; the wrapper is brought into view, its top at the window's top.
    expect(wrapper.firstElementChild).toBe(within(wrapper).getByRole('link', { name: 'Close Eli' }));
    expect(within(wrapper).getByRole('region', { name: 'Eli' })).toBeTruthy();
    await waitFor(() => expect(scrolled.mock.contexts).toContain(wrapper));
    expect(scrolled.mock.calls[scrolled.mock.contexts.indexOf(wrapper)]).toEqual([{ block: 'start' }]);
    expect(controller.requests.filter(request => request.method !== 'GET')).toEqual([]);
  },
);

test.each([390, 900, 1100, 1200])(
  "at %ipx picking an agent in another team moves the editor under that agent's card and into view",
  async width => {
    resizable(width);
    const user = userEvent.setup(),
      scrolled = vi.fn(),
      resetScroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    Element.prototype.scrollIntoView = scrolled;
    withReview();
    const router = open('/p/project-x/agents/W-1');
    const first = wrapperOf(await screen.findByRole('region', { name: 'Does' }));
    await waitFor(() => expect(scrolled.mock.contexts).toContain(first));
    resetScroll.mockClear();
    const before = scrolled.mock.calls.length;
    await user.click(cardOf('W-2'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/p/project-x/agents/W-2'));
    expect(router.state.location.search).toEqual({});
    const ana = await screen.findByRole('region', { name: 'Ana' }),
      does = screen.getAllByRole('region', { name: 'Does' }),
      wrapper = wrapperOf(ana),
      engineering = stepOf('Engineering'),
      review = stepOf('Review');
    // One editor, Ana's, right after her card in Review's step; none left under Eli's.
    expect(does).toHaveLength(1);
    expect(wrapper.contains(does[0]!)).toBe(true);
    expect(review.card.contains(wrapper)).toBe(true);
    expect(cardOf('W-2').nextElementSibling).toBe(wrapper);
    expect(cardOf('W-2').getAttribute('aria-current')).toBe('page');
    expect(cardOf('W-1').getAttribute('aria-current')).toBeNull();
    expect(cardOf('W-1').nextElementSibling).toBeNull();
    expect(engineering.step.querySelector('.sd-agents__picked')).toBeNull();
    expect(document.querySelectorAll('.sd-agents__picked')).toHaveLength(1);
    expect(within(wrapper).getByRole('link', { name: 'Close Ana' })).toBe(wrapper.firstElementChild);
    // A new wrapper, brought into view again.
    expect(wrapper).not.toBe(first);
    await waitFor(() => expect(scrolled.mock.contexts.slice(before)).toContain(wrapper));
    expect(scrolled).toHaveBeenLastCalledWith({ block: 'start' });
    expect(resetScroll).not.toHaveBeenCalled();
  },
);

test.each([390, 900, 1100, 1200])(
  "at %ipx Edit the team opens the team's editor in its step under its card, and nowhere else",
  async width => {
    resizable(width);
    const user = userEvent.setup(),
      scrolled = vi.fn(),
      resetScroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    Element.prototype.scrollIntoView = scrolled;
    withReview();
    const router = open('/p/project-x/agents/W-1');
    await screen.findByRole('region', { name: 'Does' });
    resetScroll.mockClear();
    const editor = await editTeam(user),
      { columns } = await page(),
      engineering = stepOf('Engineering'),
      review = stepOf('Review'),
      wrapper = wrapperOf(editor);
    expect(router.state.location.search).toEqual({ team: 'engineering' });
    expect(columns.getAttribute('data-layout')).toBe(agentsLayout(width));
    // In Engineering's step, right after its card, not inside the card; one editor, and no agent's.
    expect(screen.getAllByRole('region', { name: 'Edit Engineering' })).toHaveLength(1);
    expect(wrapper.parentElement).toBe(engineering.step);
    expect(engineering.card.nextElementSibling).toBe(wrapper);
    expect(engineering.card.contains(editor)).toBe(false);
    expect(review.step.contains(editor)).toBe(false);
    expect(follows(editor, review.step)).toBe(true);
    expect(columns.querySelector('.sd-agents__editor')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Does' })).toBeNull();
    expect(document.querySelectorAll('.sd-agents__picked')).toHaveLength(1);
    expect(wrapper.firstElementChild).toBe(within(wrapper).getByRole('link', { name: 'Close Engineering' }));
    await waitFor(() => expect(scrolled.mock.contexts).toContain(wrapper));
    expect(scrolled).toHaveBeenLastCalledWith({ block: 'start' });
    expect(resetScroll).not.toHaveBeenCalled();
  },
);

test.each([390, 900, 1100, 1200])(
  "at %ipx the team's address with add=true opens its editor in its step with Add an agent's choices open",
  async width => {
    resizable(width);
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    withReview();
    open('/p/project-x/agents?team=review&add=true');
    const editor = await screen.findByRole('region', { name: 'Edit Review' }),
      who = within(within(editor).getByRole('region', { name: "Who's on it" })),
      review = stepOf('Review'),
      wrapper = wrapperOf(editor);
    expect(who.getByRole('button', { name: 'Add an agent' }).getAttribute('aria-expanded')).toBe('true');
    expect(review.card.nextElementSibling).toBe(wrapper);
    expect(stepOf('Engineering').step.contains(editor)).toBe(false);
    await waitFor(() => expect(scrolled.mock.contexts).toContain(wrapper));
  },
);

test.each([390, 900, 1100, 1200])(
  "at %ipx Close goes back to the agents with nothing picked and no editor, the flow and What they're told kept",
  async width => {
    resizable(width);
    const user = userEvent.setup();
    withReview();
    const router = open('/p/project-x/agents/W-2');
    await screen.findByRole('region', { name: 'Ana' });
    await user.click(screen.getByRole('link', { name: 'Close Ana' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/p/project-x/agents'));
    expect(router.state.location.search).toEqual({});
    const { flow } = await page();
    // No editor anywhere, and no agent picked by default: none of the cards is current.
    expect(screen.queryByRole('region', { name: 'Does' })).toBeNull();
    expect(document.querySelector('.sd-agents__picked')).toBeNull();
    expect(flow.querySelector('[aria-current="page"]')).toBeNull();
    // What they're told still reads, for the first agent.
    const told = within(await screen.findByRole('region', { name: "What they're told" }));
    expect(await told.findByText('What Eli reads with each piece of work:')).toBeTruthy();
    // A team's editor closes the same way.
    await editTeam(user);
    await user.click(screen.getByRole('link', { name: 'Close Engineering' }));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(router.state.location.pathname).toBe('/p/project-x/agents');
    expect(screen.queryByRole('region', { name: 'Edit Engineering' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Does' })).toBeNull();
    expect(screen.getByRole('list', { name: 'How the work flows' })).toBeTruthy();
    expect(screen.getByRole('region', { name: "What they're told" })).toBeTruthy();
    expect(controller.requests.filter(request => request.method !== 'GET')).toEqual([]);
  },
);

test.each([390, 900, 1100, 1200])(
  "at %ipx Add a team opens the new team's editor under the page's buttons, before the flow, in view",
  async width => {
    resizable(width);
    const user = userEvent.setup(),
      scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    const router = open('/p/project-x/agents/W-1');
    await screen.findByRole('region', { name: 'Does' });
    await user.click(within(screen.getByRole('region', { name: 'Agents' })).getByRole('link', { name: 'Add a team' }));
    const editor = await screen.findByRole('region', { name: 'A new team' }),
      { flow, region, columns, head } = await page(),
      wrapper = wrapperOf(editor);
    expect(router.state.location.search).toEqual({ team: 'new' });
    expect(region.contains(editor)).toBe(true);
    // After the page's buttons and before the flow's list, outside the columns.
    for (const part of head) expect(follows(part, editor)).toBe(true);
    expect(follows(editor, flow)).toBe(true);
    expect(columns.contains(editor)).toBe(false);
    expect(screen.getAllByRole('region', { name: 'A new team' })).toHaveLength(1);
    expect(screen.queryByRole('region', { name: 'Does' })).toBeNull();
    expect(document.querySelectorAll('.sd-agents__picked')).toHaveLength(1);
    expect(wrapper.firstElementChild).toBe(within(wrapper).getByRole('link', { name: 'Close' }));
    await waitFor(() => expect(scrolled.mock.contexts).toContain(wrapper));
  },
);

test.each([390, 1100])(
  'at %ipx an address names an agent the project does not have says so under the buttons, with Close',
  async width => {
    resizable(width);
    open('/p/project-x/agents/W-gone');
    const said = await screen.findByText('This agent is not in the project.'),
      { flow } = await page(),
      wrapper = wrapperOf(said);
    expect(follows(said, flow)).toBe(true);
    expect(flow.contains(said)).toBe(false);
    expect(within(wrapper).getByRole('link', { name: 'Close' })).toBe(wrapper.firstElementChild);
  },
);

test("a window that changes width moves the team's editor between beside and under, keeping what was typed", async () => {
  const user = userEvent.setup(),
    screenSize = resizable(1440);
  open('/p/project-x/agents/W-1');
  const editor = await editTeam(user),
    { columns } = await page(),
    purpose = within(editor).getByLabelText('Purpose') as HTMLTextAreaElement;
  await user.clear(purpose);
  await user.type(purpose, 'Build and ship it.');
  expect(columns.getAttribute('data-layout')).toBe('beside');
  screenSize.resize(1100);
  expect(columns.getAttribute('data-layout')).toBe('under');
  const told = screen.getByRole('region', { name: "What they're told" });
  expect(follows(editor, told)).toBe(true);
  // The same editor, not a fresh one, with the draft as typed.
  expect(screen.getByRole('region', { name: 'Edit Engineering' })).toBe(editor);
  expect(purpose.value).toBe('Build and ship it.');
  for (const width of [1440, 390, 900, 1200, 1201, 1440]) {
    screenSize.resize(width);
    expect(columns.getAttribute('data-layout')).toBe(agentsLayout(width));
    expect(screen.getByRole('region', { name: 'Edit Engineering' })).toBe(editor);
    expect(screen.getAllByRole('region', { name: 'Edit Engineering' })).toHaveLength(1);
    expect(!!editor.closest('.sd-agents__editor')).toBe(width > underBreak);
    if (width <= underBreak) expect(stepOf('Engineering').card.nextElementSibling).toBe(wrapperOf(editor));
    expect(purpose.value).toBe('Build and ship it.');
    expect(controller.requests.filter(request => request.method !== 'GET')).toEqual([]);
  }
  expect(controller.requests.filter(request => request.method !== 'GET')).toEqual([]);
  await user.click(within(editor).getByRole('button', { name: 'Save the team' }));
  await waitFor(() => expect(controller.requests.filter(request => request.method !== 'GET')).toHaveLength(1));
  expect(controller.requests.find(request => request.method === 'PATCH')).toMatchObject({
    url: '/api/projects/project-x/organization',
    body: {
      expectedRevision: 3,
      teams: [expect.objectContaining({ id: 'engineering', purpose: 'Build and ship it.' })],
    },
  });
});

// These dimensions exercise the decision boundary, not a browser layout. A ResizeObserver delivers content changes.
test.each(['agent', 'team'])(
  'at 1440 a %s pick after scrolling aligns to the flow and follows full-editor fit',
  async kind => {
    resizable(1440);
    vi.stubGlobal('scrollY', 0);
    vi.stubGlobal('innerHeight', 800);
    const viewport = Object.assign(new EventTarget(), { height: 900 }),
      viewportAdded = vi.spyOn(viewport, 'addEventListener'),
      viewportRemoved = vi.spyOn(viewport, 'removeEventListener');
    vi.stubGlobal('visualViewport', viewport);
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    let height = 600,
      // The page opens at its top, the flow under the head; scrolled 640px down, the flow's top is above the window's.
      flowTop = 80;
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const rect = originalRect.call(this);
      return this.classList.contains('sd-agents__editor')
        ? { ...rect, height }
        : this.classList.contains('sd-agents__flow')
          ? { ...rect, top: flowTop }
          : rect;
    });
    const originalStyle = window.getComputedStyle;
    vi.stubGlobal('getComputedStyle', (element: Element) =>
      element.classList.contains('sd-agents__editor') ? { top: '20px' } : originalStyle(element),
    );
    const observers: {
      update: () => void;
      observe: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
    }[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn();
        disconnect = vi.fn();
        constructor(public update: () => void) {
          observers.push(this);
        }
      },
    );
    const added = vi.spyOn(window, 'addEventListener'),
      removed = vi.spyOn(window, 'removeEventListener'),
      resetScroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {}),
      user = userEvent.setup(),
      router = open('/p/project-x/agents/W-gone');
    await page();
    // Opening at the top beside the flow leaves the page where it is, its head and buttons in view.
    expect(scrolled).not.toHaveBeenCalled();
    vi.stubGlobal('scrollY', 640);
    flowTop = -560;
    expect(window.scrollY).toBe(640);
    resetScroll.mockClear();
    const editor =
      kind === 'team'
        ? await editTeam(user)
        : (await user.click(cardOf('W-1')), await screen.findByRole('region', { name: 'Runs on' }));
    const { columns } = await page(),
      column = editor.closest<HTMLElement>('.sd-agents__editor')!,
      flow = columns.querySelector('.sd-agents__flow')!;
    expect(scrolled.mock.contexts).toContain(flow);
    expect(scrolled).toHaveBeenLastCalledWith({ block: 'start' });
    expect(scrolled.mock.contexts).not.toContain(column);
    expect(resetScroll).not.toHaveBeenCalled();
    expect(column.dataset.sticky).toBe('true');
    const observer = observers.at(-1)!;
    expect(observer.observe).toHaveBeenCalledWith(column);
    height = 760; // Equality: 800 minus both 20px gutters.
    act(() => observer.update());
    expect(column.dataset.sticky).toBe('true');
    height = 761;
    act(() => observer.update());
    expect(column.dataset.sticky).toBe('false');
    height = 1100;
    act(() => observer.update());
    expect(column.dataset.sticky).toBe('false');
    height = 600;
    act(() => observer.update());
    expect(column.dataset.sticky).toBe('true');
    vi.stubGlobal('innerHeight', 500);
    act(() => window.dispatchEvent(new Event('resize')));
    expect(column.dataset.sticky).toBe('false');
    vi.stubGlobal('innerHeight', 900);
    act(() => window.dispatchEvent(new Event('resize')));
    expect(column.dataset.sticky).toBe('true');
    // The visual viewport can shrink without changing the layout viewport (for example on zoom).
    viewport.height = 639;
    act(() => viewport.dispatchEvent(new Event('resize')));
    expect(column.dataset.sticky).toBe('false');
    viewport.height = 640; // Equality at the visual viewport's boundary too.
    act(() => viewport.dispatchEvent(new Event('resize')));
    expect(column.dataset.sticky).toBe('true');
    viewport.height = 900;
    if (kind === 'team') {
      const who = within(editor).getByRole('region', { name: "Who's on it" }),
        choices = within(who).getByRole('button', { name: 'Add an agent' });
      await user.click(choices);
      expect(choices.getAttribute('aria-expanded')).toBe('true');
      height = 1300;
      act(() => observer.update());
      expect(column.dataset.sticky).toBe('false');
      await user.click(within(who).getByRole('button', { name: 'Cancel' }));
      height = 600;
      act(() => observer.update());
      expect(column.dataset.sticky).toBe('true');
      expect(within(editor).getByRole('button', { name: 'Save the team' }).closest('.sd-editbar')).toBe(
        editor.lastElementChild,
      );
    } else {
      expect(within(editor).getByRole('button', { name: 'Save' })).toBeTruthy();
    }
    expect(within(editor).getByRole('button', { name: 'Undo' })).toBeTruthy();
    // Growth and height changes only measure; they never request another alignment scroll or write.
    expect(scrolled.mock.calls).toHaveLength(1);
    expect(controller.requests.filter(request => request.method !== 'GET')).toEqual([]);
    const resizeListener = added.mock.calls.filter(([type]) => type === 'resize').at(-1)![1],
      viewportListener = viewportAdded.mock.calls.at(-1)![1];
    await act(() =>
      router.navigate({
        to: '/p/$projectId/agents',
        params: { projectId: 'project-x' },
        search: { team: 'new' },
      }),
    );
    expect(observer.disconnect).toHaveBeenCalledOnce();
    expect(removed.mock.calls.some(([type, listener]) => type === 'resize' && listener === resizeListener)).toBe(true);
    expect(
      viewportRemoved.mock.calls.some(([type, listener]) => type === 'resize' && listener === viewportListener),
    ).toBe(true);
    cleanup();
    expect(observers.every(item => item.disconnect.mock.calls.length === 1)).toBe(true);
    expect(viewportRemoved.mock.calls).toHaveLength(viewportAdded.mock.calls.length);
  },
);

// The flow's top as measured against the window's (mocked; jsdom lays nothing out): negative once scrolled past it.
const flowAt = (top: number) => {
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const rect = originalRect.call(this);
    return this.classList.contains('sd-agents__flow') ? { ...rect, top } : rect;
  });
};

test.each(['/p/project-x/agents', '/p/project-x/agents/W-2', '/p/project-x/agents?team=review'])(
  'at 1440 opening %s at the top of the page keeps it there, the head and its buttons in view above the columns',
  async path => {
    resizable(1440);
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    // The head above the flow, the flow's top in the window.
    flowAt(120);
    withReview();
    open(path);
    const { columns, head } = await page(),
      editor = await screen.findByRole('region', {
        name: path.endsWith('W-2') ? 'Ana' : path.includes('team') ? 'Edit Review' : 'Eli',
      });
    expect(columns.getAttribute('data-layout')).toBe('beside');
    expect(editor.closest('.sd-agents__editor')).toBeTruthy();
    for (const part of head) expect(follows(part, columns)).toBe(true);
    expect(scrolled).not.toHaveBeenCalled();
    expect(controller.requests.filter(request => request.method !== 'GET')).toEqual([]);
  },
);

test.each(['agent', 'team'])(
  "at 1440 a %s pick while the flow's top is still in view leaves the page and its buttons where they are",
  async kind => {
    resizable(1440);
    const user = userEvent.setup(),
      scrolled = vi.fn(),
      resetScroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    Element.prototype.scrollIntoView = scrolled;
    flowAt(120);
    withReview();
    open('/p/project-x/agents/W-1');
    await screen.findByRole('region', { name: 'Eli' });
    resetScroll.mockClear();
    const editor =
      kind === 'team'
        ? await editTeam(user)
        : (await user.click(cardOf('W-2')), await screen.findByRole('region', { name: 'Ana' }));
    expect(editor.closest('.sd-agents__editor')).toBeTruthy();
    expect(scrolled).not.toHaveBeenCalled();
    expect(resetScroll).not.toHaveBeenCalled();
  },
);

test("a window whose layout changes keeps its place: crossing 1200px or 860px never scrolls, even past the flow's top", async () => {
  const screenSize = resizable(1100),
    scrolled = vi.fn(),
    resetScroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  Element.prototype.scrollIntoView = scrolled;
  flowAt(-400);
  withReview();
  open('/p/project-x/agents/W-2');
  const ana = await screen.findByRole('region', { name: 'Ana' });
  // Stacked, the agent the address names comes into view under its card as the page opens.
  await waitFor(() => expect(scrolled.mock.contexts).toContain(wrapperOf(ana)));
  scrolled.mockClear();
  resetScroll.mockClear();
  for (const width of [1440, 1100, 1201, 390, 1440, 900]) {
    screenSize.resize(width);
    expect(screen.getAllByRole('region', { name: 'Ana' })).toEqual([ana]);
    expect(!!ana.closest('.sd-agents__editor')).toBe(width > underBreak);
  }
  expect(scrolled).not.toHaveBeenCalled();
  expect(resetScroll).not.toHaveBeenCalled();
  expect(controller.requests.filter(request => request.method !== 'GET')).toEqual([]);
});

test('a page opened stacked with nothing picked, widened, shows the automatic agent beside the flow, also after Close', async () => {
  const screenSize = resizable(1100),
    user = userEvent.setup(),
    scrolled = vi.fn();
  Element.prototype.scrollIntoView = scrolled;
  flowAt(-400);
  withReview();
  open('/p/project-x/agents');
  const { flow, columns } = await page();
  // Stacked, nothing is picked and no editor is open.
  expect(screen.queryByRole('region', { name: 'Does' })).toBeNull();
  expect(flow.querySelector('[aria-current="page"]')).toBeNull();
  screenSize.resize(1440);
  // Beside the flow, the first enabled agent's editor in its own column, its card current, as a desktop page opens.
  const eli = await screen.findByRole('region', { name: 'Eli' });
  expect(columns.getAttribute('data-layout')).toBe('beside');
  expect(eli.closest('.sd-agents__editor')).toBeTruthy();
  expect(screen.getAllByRole('region', { name: 'Does' })).toHaveLength(1);
  expect(cardOf('W-1').getAttribute('aria-current')).toBe('page');
  expect(document.querySelector('.sd-agents__picked')).toBeNull();
  // Narrowed again, the same editor moves under Eli's card, with Close.
  screenSize.resize(1100);
  expect(screen.getAllByRole('region', { name: 'Eli' })).toEqual([eli]);
  expect(cardOf('W-1').nextElementSibling).toBe(wrapperOf(eli));
  await user.click(screen.getByRole('link', { name: 'Close Eli' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Eli' })).toBeNull());
  expect(screen.queryByRole('region', { name: 'Does' })).toBeNull();
  // Closed while stacked, widened again: the automatic agent is beside the flow once more.
  screenSize.resize(1440);
  expect((await screen.findByRole('region', { name: 'Eli' })).closest('.sd-agents__editor')).toBeTruthy();
  expect(screen.getAllByRole('region', { name: 'Does' })).toHaveLength(1);
  // None of these layout changes moved the page, and nothing was written.
  expect(scrolled).not.toHaveBeenCalled();
  expect(controller.requests.filter(request => request.method !== 'GET')).toEqual([]);
});

test('agent execution drafts keep one mounted editor across beside, stacked and phone transitions until Save', async () => {
  const user = userEvent.setup(),
    screenSize = resizable(1440);
  open('/p/project-x/agents/W-1');
  const editor = await screen.findByRole('region', { name: 'Runs on' }),
    model = within(editor).getByLabelText('Model') as HTMLInputElement;
  await user.type(model, 'draft-model');
  await user.click(within(editor).getByRole('switch', { name: 'Pause new work for Eli' }));
  for (const width of [1100, 1440, 390, 900, 1200, 1201, 1440]) {
    screenSize.resize(width);
    expect(screen.getAllByRole('region', { name: 'Runs on' })).toEqual([editor]);
    expect(!!editor.closest('.sd-agents__editor')).toBe(width > underBreak);
    if (width <= underBreak) expect(cardOf('W-1').nextElementSibling).toBe(wrapperOf(editor));
    expect(model.value).toBe('draft-model');
    expect(within(editor).getByRole('switch', { name: 'Pause new work for Eli' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(controller.requests.filter(request => request.method !== 'GET')).toEqual([]);
  }
  await user.click(within(editor).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(controller.requests.filter(request => request.method !== 'GET')).toHaveLength(1));
  expect(controller.requests.find(request => request.method === 'PATCH')).toEqual({
    url: '/api/workers/W-1',
    method: 'PATCH',
    body: {
      projectId: 'project-x',
      provider: 'codex',
      model: 'draft-model',
      effort: '',
      mode: '',
      paused: true,
      expectedVersion: 1,
    },
  });
});

test('Agents stylesheet leaves full editors unrestricted, gates stickiness on fit, and keeps team actions above phone navigation', async () => {
  // Read declarations only: jsdom does not measure CSS layout or sticky positions.
  // Keep the file base separate so Vite does not rewrite the CSS URL as a browser asset URL.
  const base = import.meta.url,
    { readFileSync } = await vi.importActual<{ readFileSync: (file: URL, encoding: 'utf8') => string }>('node:fs'),
    css = readFileSync(new URL('./design/bundle.css', base), 'utf8'),
    style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
  try {
    const rules = [...style.sheet!.cssRules],
      allStyles = (list: CSSRule[]): CSSStyleRule[] =>
        list.flatMap(rule =>
          rule.type === CSSRule.STYLE_RULE
            ? [rule as CSSStyleRule]
            : rule.type === CSSRule.MEDIA_RULE
              ? allStyles([...(rule as CSSMediaRule).cssRules])
              : [],
        ),
      editorRules = allStyles(rules).filter(rule =>
        /\.(?:sd-agents__editor|sd-agents__picked|sd-agentdetail|sd-agentgrid)(?:\[.*?\])?\s*(?:,|$)/.test(
          rule.selectorText,
        ),
      );
    expect(editorRules.length).toBeGreaterThan(0);
    for (const rule of editorRules) {
      for (const property of ['height', 'max-height', 'overflow', 'overflow-y'])
        expect(rule.style.getPropertyValue(property), `${rule.selectorText}: ${property}`).toBe('');
    }
    const sticky = editorRules.filter(rule => rule.style.position === 'sticky');
    expect(sticky.map(rule => rule.selectorText)).toEqual([
      ".sd-agentspage .sd-agents[data-layout='beside'] > .sd-agents__editor[data-sticky='true']",
    ]);
    const mobile = rules.filter(
        rule => rule.type === CSSRule.MEDIA_RULE && (rule as CSSMediaRule).conditionText === '(max-width: 860px)',
      ) as CSSMediaRule[],
      actionRule = mobile
        .flatMap(rule => [...rule.cssRules])
        .find(
          rule => rule.type === CSSRule.STYLE_RULE && (rule as CSSStyleRule).selectorText === '.sd-editbar',
        ) as CSSStyleRule;
    expect(actionRule.style.bottom).toBe('calc(92px + env(safe-area-inset-bottom, 0px))');
  } finally {
    style.remove();
  }
});

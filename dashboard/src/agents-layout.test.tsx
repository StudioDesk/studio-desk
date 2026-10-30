// The Agents page's layout for the window's width: beside above 1200px, the editor level with the flow; under from
// 861px to 1200px, the editor after the flow and before what they're told; the phone's at 860px and under, as it was.
// The page's head is above both columns in each. Model-free, with the stand-in controller and matchMedia stubbed; no
// browser lays anything out, so stickiness and fit are the stylesheet's, not measured here.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, cleanup, render, renderHook, screen, within } from '@testing-library/react';
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
      codex: { id: 'codex', name: 'Codex CLI', available: true, workerSelectable: true, modes: ['workspace'] },
    },
    taskKinds: { general: { label: 'General task', available: true } },
    organizationConfiguration: {
      revision: 3,
      teams,
      members: [
        { workerId: 'W-1', teamId: 'engineering', role: 'Engineer', responsibility: 'Writes the code.', roles: [] },
      ],
      taskKinds: ['general'],
      kindOwners: { general: 'W-1' },
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
  const [flowColumn, editorColumn] = [...columns.children];
  expect(columns.children).toHaveLength(2);
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
  const [flowColumn, editorColumn] = [...columns.children];
  expect(columns.children).toHaveLength(2);
  expect(flowColumn!.firstElementChild).toBe(flow);
  expect(flowColumn!.contains(editor)).toBe(false);
  expect(editorColumn!.classList.contains('sd-agents__editor')).toBe(true);
  expect(editorColumn!.children).toHaveLength(1);
  expect(editorColumn!.firstElementChild).toBe(editor);
  // Its bar that saves the team is inside the column, at the editor's foot.
  expect(editorColumn!.querySelector('.sd-editbar')).toBe(editor.lastElementChild);
});

test("on a tablet the agent's editor is under the flow at full width, before What they're told", async () => {
  tablet();
  open('/p/project-x/agents/W-1');
  const { flow, columns, head } = await page(),
    does = await screen.findByRole('region', { name: 'Does' }),
    told = await screen.findByRole('region', { name: "What they're told" });
  expect(columns.getAttribute('data-layout')).toBe('under');
  for (const part of head) expect(follows(part, columns)).toBe(true);
  // One after another in the columns' element: the flow's column, the editor's, then What they're told.
  const [flowColumn, editorColumn, last] = [...columns.children];
  expect(columns.children).toHaveLength(3);
  expect(flowColumn!.firstElementChild).toBe(flow);
  expect(flowColumn!.children).toHaveLength(1);
  expect(editorColumn!.classList.contains('sd-agents__editor')).toBe(true);
  expect(editorColumn!.firstElementChild!.contains(does)).toBe(true);
  expect(last).toBe(told);
  expect(follows(flow, does)).toBe(true);
  expect(follows(does, told)).toBe(true);
});

test("on a tablet Edit the team's editor is under the flow, before What they're told", async () => {
  const user = userEvent.setup();
  tablet();
  open('/p/project-x/agents/W-1');
  const editor = await editTeam(user),
    { flow, columns } = await page(),
    told = await screen.findByRole('region', { name: "What they're told" });
  expect(columns.getAttribute('data-layout')).toBe('under');
  expect(flow.parentElement!.contains(editor)).toBe(false);
  expect(editor.parentElement!.classList.contains('sd-agents__editor')).toBe(true);
  expect(editor.parentElement!.parentElement).toBe(columns);
  expect(follows(flow, editor)).toBe(true);
  expect(follows(editor, told)).toBe(true);
  expect(told.parentElement).toBe(columns);
});

test("on a phone the page keeps its order: the head, the flow, What they're told, then the editor", async () => {
  phone();
  open('/p/project-x/agents/W-1');
  const { flow, columns, head } = await page(),
    does = await screen.findByRole('region', { name: 'Does' }),
    told = await screen.findByRole('region', { name: "What they're told" });
  expect(columns.getAttribute('data-layout')).toBe('phone');
  for (const part of head) expect(follows(part, columns)).toBe(true);
  expect(flow.parentElement!.contains(told)).toBe(true);
  expect(follows(flow, told)).toBe(true);
  expect(follows(told, does)).toBe(true);
});

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
  screenSize.resize(1024);
  expect(columns.getAttribute('data-layout')).toBe('under');
  const told = screen.getByRole('region', { name: "What they're told" });
  expect(follows(editor, told)).toBe(true);
  // The same editor, not a fresh one, with the draft as typed.
  expect(screen.getByRole('region', { name: 'Edit Engineering' })).toBe(editor);
  expect(purpose.value).toBe('Build and ship it.');
  screenSize.resize(1440);
  expect(columns.getAttribute('data-layout')).toBe('beside');
  expect(screen.getByRole('region', { name: 'Edit Engineering' })).toBe(editor);
  expect(purpose.value).toBe('Build and ship it.');
  expect(controller.requests.filter(request => request.method !== 'GET')).toEqual([]);
});

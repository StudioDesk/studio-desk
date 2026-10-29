// What an agent is told, on its own page (told-page.tsx): Rules, the sets it reads in the told view's order with
// their counts, revisions, readers and marks, each rule numbered and opened in full, and Find a rule; What it
// receives, the controller's text exactly; and an agent the project does not hold. Model-free, with the stand-in
// controller; the page sends no command.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { Rule } from './api';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, toldFixture, type Controller } from './test-controller';

const added: Rule = { title: 'Run the checks', text: 'Run the focused tests before handing off.\nSay which ones ran.' };

let controller: Controller;
beforeEach(() => {
  controller = fakeController();
  controller.shell = {
    ...controller.shell,
    workers: [...controller.shell.workers, { id: 'W-2', displayName: 'Nova', team: 'Engineering' }],
  };
  // Eli and Nova read the project's and the team's rules; the team's are at revision 3 with a draft saved on an
  // earlier one, which is not current, and Eli's own have a current draft that adds a rule.
  const told = toldFixture(),
    own = told.layers[3]!;
  controller.told['W-1'] = {
    ...told,
    layers: [
      told.layers[0]!,
      { ...told.layers[1]!, readers: ['W-1', 'W-2'] },
      {
        ...told.layers[2]!,
        revision: 3,
        readers: ['W-1', 'W-2'],
        draft: {
          baseRevision: 2,
          savedAt: '2026-10-28T12:00:00Z',
          current: false,
          text: '**Old.** An old draft.',
          rules: [{ title: 'Old', text: 'An old draft.' }],
        },
      },
      {
        ...own,
        draft: {
          baseRevision: 1,
          savedAt: '2026-10-29T12:00:00Z',
          current: true,
          text: `${own.text}\n\n**Run the checks.** ${added.text}`,
          rules: [...own.rules, added],
        },
      },
    ],
  };
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
const panel = () => within(screen.getByRole('tabpanel'));
const sets = () => panel().queryAllByRole('region');
const rows = (set: HTMLElement) =>
  within(set)
    .getAllByRole('button')
    .map(button => button.textContent);

test('Rules lists the shared set first as read-only, then the project’s, the team’s and its own', async () => {
  open('/p/project-x/agents/W-1/told');
  expect(await screen.findByRole('heading', { level: 1, name: 'What Eli is told' })).toBeTruthy();
  const trail = within(screen.getByRole('navigation', { name: 'You are here' }));
  expect(trail.getByRole('link', { name: 'Agents' }).getAttribute('href')).toBe('/p/project-x/agents');
  expect(trail.getByRole('link', { name: 'Eli' }).getAttribute('href')).toBe('/p/project-x/agents/W-1');
  expect(screen.getByRole('tab', { name: 'Rules' }).getAttribute('aria-selected')).toBe('true');
  expect(panel().getByRole('note').textContent).toBe('Changing a shared rule changes it for everyone who reads it.');

  const [shared, project, team, own] = sets();
  expect(sets().map(set => within(set).getByRole('heading').textContent)).toEqual([
    'The rules every project shares',
    "This project's rules",
    "The Engineering team's rules",
    "Eli's own rules",
  ]);
  expect(shared!.textContent).toContain('1 rule · revision 1 · read by every project');
  expect(project!.textContent).toContain('1 rule · revision 1 · read by Eli and Nova');
  expect(team!.textContent).toContain('1 rule · revision 3 · read by Eli and Nova');
  // A set with a current draft shows the draft's rules, counted.
  expect(own!.textContent).toContain('3 rules · revision 1 · read by Eli');
  // Only the shared set is read-only here, and only a current draft is marked.
  expect(sets().map(set => !!within(set).queryByText('Read-only here'))).toEqual([true, false, false, false]);
  expect(sets().map(set => !!within(set).queryByText('Draft'))).toEqual([false, false, false, true]);

  // Each rule's number, name and first line; a rule without a name shows its first words.
  expect(rows(shared!)).toEqual(['1. Stay local Keep records, files and the dashboard on this computer.']);
  expect(rows(team!)).toEqual(['1. Hand off what changed Say which files changed and what you checked.']);
  expect(rows(own!)).toEqual([
    '1. Stay inside the story Change only the files the story may change.',
    '2. Ask the director when a choice is not… Ask the director when a choice is not yours to make.',
    '3. Run the checks Run the focused tests before handing off.',
  ]);
  // Read-only in this story: the only buttons are the rules that open.
  expect(
    panel()
      .getAllByRole('button')
      .every(button => button.hasAttribute('aria-expanded')),
  ).toBe(true);
  expect(controller.requests.filter(request => request.method !== 'GET')).toEqual([]);
});

test('an opened rule reads in full', async () => {
  const user = userEvent.setup();
  open('/p/project-x/agents/W-1/told');
  const own = within(await screen.findByRole('region', { name: "Eli's own rules" })),
    rule = own.getByRole('button', { name: /^3\. Run the checks/ });
  expect(rule.getAttribute('aria-expanded')).toBe('false');
  expect(own.queryByLabelText('Rule 3 in full')).toBeNull();
  await user.click(rule);
  expect(rule.getAttribute('aria-expanded')).toBe('true');
  expect(own.getByLabelText('Rule 3 in full').textContent).toBe(added.text);
  expect(rule.textContent).not.toContain('Run the focused tests');
  await user.click(rule);
  expect(own.queryByLabelText('Rule 3 in full')).toBeNull();
});

test('Find a rule narrows every set to its matches, by name or text, and says when none match', async () => {
  const user = userEvent.setup();
  open('/p/project-x/agents/W-1/told');
  const find = await screen.findByRole('searchbox', { name: 'Find a rule' });
  // "hand" is in the team's rule's name and in the text of the rule Eli's draft adds.
  await user.type(find, 'HAND');
  expect(sets().map(set => within(set).getByRole('heading').textContent)).toEqual([
    "The Engineering team's rules",
    "Eli's own rules",
  ]);
  const [team, own] = sets();
  expect(rows(team!)).toEqual(['1. Hand off what changed Say which files changed and what you checked.']);
  // A rule keeps its number in its set.
  expect(rows(own!)).toEqual(['3. Run the checks Run the focused tests before handing off.']);
  expect(panel().queryByRole('status')).toBeNull();

  await user.clear(find);
  await user.type(find, 'zebra');
  expect(sets()).toEqual([]);
  expect(panel().getByRole('status').textContent).toBe('No rule matches “zebra”.');

  await user.clear(find);
  expect(sets()).toHaveLength(4);
});

test('What it receives shows the controller’s text exactly, with its drafts and the recorded revisions', async () => {
  const user = userEvent.setup();
  // Markdown, markup, a leading line break, blank lines and trailing spaces all reach the page as sent.
  const text =
    '\n# company: company (revision 2)\n\n**Stay local.** Keep   records <b>here</b>.  \n\n\n- one\n\t- two\n# Project own: W-1 (revision 2)\n\nEnd. ';
  controller.told['W-1']!.receives = { text, drafts: 1 };
  const router = open('/p/project-x/agents/W-1/told');
  await user.click(await screen.findByRole('tab', { name: 'What it receives' }));
  await waitFor(() => expect(router.state.location.search).toEqual({ view: 'receives' }));
  expect(screen.getByRole('tab', { name: 'What it receives' }).getAttribute('aria-selected')).toBe('true');
  const sent = screen.getByLabelText('What Eli receives');
  expect(sent.textContent).toBe(text);
  expect(sent.querySelector('strong, b, h1, li')).toBeNull();
  expect(panel().getByText(/It includes one draft, as it would read once published/)).toBeTruthy();
  expect(panel().getByRole('note').textContent).toContain('Each attempt keeps the revision it ran with');

  await user.click(screen.getByRole('tab', { name: 'Rules' }));
  await waitFor(() => expect(router.state.location.search).toEqual({}));
  expect(await screen.findByRole('region', { name: "Eli's own rules" })).toBeTruthy();
  cleanup();

  // The address alone opens the view, and the stand-in's own text with no drafts reads as published.
  controller.told['W-1'] = toldFixture();
  open('/p/project-x/agents/W-1/told?view=receives');
  expect((await screen.findByLabelText('What Eli receives')).textContent).toBe(toldFixture().receives.text);
  expect(panel().getByText(/It includes no drafts/)).toBeTruthy();
});

test('an agent the told route does not know is not in the project', async () => {
  open('/p/project-x/agents/W-9/told');
  expect(await screen.findByText('This agent is not in the project.')).toBeTruthy();
  expect(controller.reads()).toContain('/api/projects/project-x/agents/W-9/told');
  expect(screen.queryByRole('tab', { name: 'Rules' })).toBeNull();
});

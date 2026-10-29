// What an agent is told, on its own page (told-page.tsx): Rules, the sets it reads in the told view's order with
// their counts, revisions, readers and marks, each rule numbered and opened in full, and Find a rule; What it
// receives, the controller's text exactly; and an agent the project does not hold. Then the edits each set the
// project can change keeps as its draft (Add a rule, Edit, Give it a name, Move and Remove the rule), the bar that
// publishes or discards each draft, and the controller's refusals. Model-free, with the stand-in controller.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { Rule, ToldLayer } from './api';
import { App } from './app';
import { createAppRouter } from './router';
import { createStream, fakeController, toldFixture, type Controller } from './test-controller';

const added: Rule = { title: 'Run the checks', text: 'Run the focused tests before handing off.\nSay which ones ran.' };
// The stand-in's own rules, the team's and the project's, as toldFixture lays them out.
const stay: Rule = { title: 'Stay inside the story', text: 'Change only the files the story may change.' },
  ask: Rule = { title: null, text: 'Ask the director when a choice is not yours to make.' },
  hand: Rule = { title: 'Hand off what changed', text: 'Say which files changed and what you checked.' },
  direction: Rule = { title: null, text: 'Company direction.' };

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
// A set's rules as their rows read, the buttons that open them.
const rows = (set: HTMLElement) =>
  within(set)
    .getAllByRole('button')
    .filter(button => button.hasAttribute('aria-expanded'))
    .map(button => button.textContent);
const labels = (buttons: HTMLElement[]) => buttons.map(button => button.textContent);
const commands = () => controller.requests.filter(request => request.method !== 'GET');
const textOf = (rules: Rule[]) =>
  rules.map(rule => (rule.title ? `**${rule.title}.** ${rule.text}` : rule.text)).join('\n\n');

// Answers the instruction commands as the controller does (src/core/instructions.mjs): a draft holds the rules saved
// on the set's revision, publishing makes the draft the next revision and discarding drops it; the next attempt
// receives each current draft in place of its set's published text.
const instructionCommands = (url: string, _method: string, body: unknown) => {
  const [scope, id, action] = url.split('/').slice(3),
    view = controller.told['W-1']!,
    layers = view.layers.map((layer): ToldLayer => {
      if (!layer.editable || layer.scope !== scope || layer.id !== decodeURIComponent(id!)) return layer;
      if (action === 'draft') {
        const { rules } = body as { rules: Rule[] };
        return {
          ...layer,
          draft: {
            baseRevision: layer.revision,
            savedAt: '2026-10-29T13:00:00Z',
            current: true,
            text: textOf(rules),
            rules,
          },
        };
      }
      if (action === 'publish')
        return {
          ...layer,
          revision: layer.revision + 1,
          text: layer.draft!.text,
          rules: layer.draft!.rules,
          draft: null,
        };
      return { ...layer, draft: null };
    });
  controller.told['W-1'] = {
    ...view,
    layers,
    receives: {
      text: layers
        .map(
          layer =>
            `# ${layer.layer} (revision ${layer.revision})\n\n${layer.draft?.current ? layer.draft.text : layer.text}`,
        )
        .join('\n\n'),
      drafts: layers.filter(layer => layer.draft?.current).length,
    },
  };
  return {};
};
const refuse =
  (message: string, status = 400) =>
  () => {
    throw Object.assign(new Error(message), { status });
  };

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
  // Besides the rules that open, each set the project can change has Add a rule, and the shared set has nothing.
  expect(
    sets().map(set =>
      labels(
        within(set)
          .getAllByRole('button')
          .filter(button => !button.hasAttribute('aria-expanded')),
      ),
    ),
  ).toEqual([[], ['Add a rule'], ['Add a rule'], ['Add a rule']]);
  expect(commands()).toEqual([]);
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

test('the shared set offers no change, even with a rule opened; an opened rule elsewhere moves only where it can', async () => {
  const user = userEvent.setup();
  open('/p/project-x/agents/W-1/told');
  const shared = within(await screen.findByRole('region', { name: 'The rules every project shares' }));
  await user.click(shared.getByRole('button', { name: /^1\. Stay local/ }));
  expect(shared.getByLabelText('Rule 1 in full').textContent).toBe(
    'Keep records, files and the dashboard on this computer.',
  );
  expect(shared.getAllByRole('button')).toHaveLength(1);
  expect(shared.queryByRole('group')).toBeNull();

  // The project's only rule cannot move, and having no name it can be given one.
  const project = within(screen.getByRole('region', { name: "This project's rules" }));
  await user.click(project.getByRole('button', { name: /^1\. Company direction/ }));
  expect(labels(within(project.getByRole('group', { name: 'Change rule 1' })).getAllByRole('button'))).toEqual([
    'Edit',
    'Give it a name',
    'Remove the rule',
  ]);
  // Eli's own rules: the first moves only down, the middle one either way, the last only up.
  const own = within(screen.getByRole('region', { name: "Eli's own rules" }));
  for (const name of [/^1\. Stay inside/, /^2\. Ask the director/, /^3\. Run the checks/])
    await user.click(own.getByRole('button', { name }));
  expect(
    [1, 2, 3].map(at => labels(within(own.getByRole('group', { name: `Change rule ${at}` })).getAllByRole('button'))),
  ).toEqual([
    ['Edit', 'Move down', 'Remove the rule'],
    ['Edit', 'Give it a name', 'Move up', 'Move down', 'Remove the rule'],
    ['Edit', 'Move up', 'Remove the rule'],
  ]);
  expect(commands()).toEqual([]);
});

test("Add a rule keeps the set's rules and the new one as its draft, on its revision; the bar and What it receives show it", async () => {
  const user = userEvent.setup();
  controller.command = instructionCommands;
  open('/p/project-x/agents/W-1/told');
  const teamSet = await screen.findByRole('region', { name: "The Engineering team's rules" }),
    team = within(teamSet);
  await user.click(team.getByRole('button', { name: 'Add a rule' }));
  const form = within(team.getByRole('form', { name: 'Add a rule' }));
  expect(form.getByRole('button', { name: 'Keep in the draft' })).toHaveProperty('disabled', true);
  await user.type(form.getByRole('textbox', { name: 'Name' }), 'Check the diff');
  await user.type(
    form.getByRole('textbox', { name: 'What the agent should do' }),
    'Read the whole diff before handing off.',
  );
  await user.click(form.getByRole('button', { name: 'Keep in the draft' }));
  await waitFor(() => expect(team.queryByRole('form')).toBeNull());
  // The team's earlier draft is not current, so the new rule follows the published ones, on the revision shown.
  const check = { title: 'Check the diff', text: 'Read the whole diff before handing off.' };
  expect(commands()).toEqual([
    {
      url: '/api/instructions/team/engineering/draft',
      method: 'POST',
      body: { projectId: 'project-x', baseRevision: 3, rules: [hand, check] },
    },
  ]);
  expect(teamSet.textContent).toContain('2 rules · revision 3');
  expect(team.getByText('Draft')).toBeTruthy();
  expect(rows(teamSet)).toEqual([
    '1. Hand off what changed Say which files changed and what you checked.',
    '2. Check the diff Read the whole diff before handing off.',
  ]);
  // The bar lists each set's current draft in the order the agent reads them.
  const bar = within(screen.getByRole('region', { name: 'Drafts not published yet' }));
  expect(bar.getAllByRole('listitem').map(item => item.querySelector('span')!.textContent)).toEqual([
    "One rule added to the team's rules.",
    "One rule added to the agent's own rules.",
  ]);

  // What it receives is the stand-in's text read again, with the new draft in it.
  await user.click(screen.getByRole('tab', { name: 'What it receives' }));
  const sent = await screen.findByLabelText('What Eli receives');
  expect(sent.textContent).toBe(controller.told['W-1']!.receives.text);
  expect(sent.textContent).toContain('**Check the diff.** Read the whole diff before handing off.');
  expect(panel().getByText(/It includes 2 drafts/)).toBeTruthy();
});

test("Edit, Move down and Remove the rule each keep the set's whole list, from its current draft, as the draft", async () => {
  const user = userEvent.setup();
  controller.command = instructionCommands;
  open('/p/project-x/agents/W-1/told');
  const ownSet = await screen.findByRole('region', { name: "Eli's own rules" }),
    own = within(ownSet),
    sent = () => commands().map(command => (command.body as { rules: Rule[] }).rules);

  await user.click(own.getByRole('button', { name: /^1\. Stay inside the story/ }));
  await user.click(within(own.getByRole('group', { name: 'Change rule 1' })).getByRole('button', { name: 'Edit' }));
  const form = within(own.getByRole('form', { name: 'Edit rule 1' })),
    text = form.getByRole('textbox', { name: 'What the agent should do' });
  expect(form.getByRole('textbox', { name: 'Name' })).toHaveProperty('value', stay.title);
  expect(text).toHaveProperty('value', stay.text);
  await user.clear(text);
  await user.type(text, 'Change only the approved files.');
  await user.click(form.getByRole('button', { name: 'Keep in the draft' }));
  const edited = { title: stay.title, text: 'Change only the approved files.' };
  await waitFor(() => expect(sent()).toEqual([[edited, ask, added]]));
  // Its row reads what it says now.
  await user.click(await own.findByRole('button', { name: /^1\. Stay inside the story Change only the approved/ }));

  await user.click(
    within(own.getByRole('group', { name: 'Change rule 1' })).getByRole('button', { name: 'Move down' }),
  );
  await waitFor(() => expect(sent()).toHaveLength(2));
  expect(sent()[1]).toEqual([ask, edited, added]);
  // The moved rule stays open in its new place.
  expect((await own.findByLabelText('Rule 2 in full')).textContent).toBe(edited.text);
  expect(own.queryByLabelText('Rule 1 in full')).toBeNull();

  await user.click(own.getByRole('button', { name: /^3\. Run the checks/ }));
  await user.click(
    within(own.getByRole('group', { name: 'Change rule 3' })).getByRole('button', { name: 'Remove the rule' }),
  );
  await waitFor(() => expect(sent()).toHaveLength(3));
  expect(sent()[2]).toEqual([ask, edited]);
  await waitFor(() => expect(rows(ownSet)).toHaveLength(2));
  // Every save names Eli's own rules on the revision they show.
  expect(commands().map(command => [command.url, (command.body as { baseRevision: number }).baseRevision])).toEqual(
    Array(3).fill(['/api/instructions/employee/W-1/draft', 1]),
  );
});

test('Give it a name names a rule without one and keeps what it says', async () => {
  const user = userEvent.setup();
  controller.command = instructionCommands;
  open('/p/project-x/agents/W-1/told');
  const own = within(await screen.findByRole('region', { name: "Eli's own rules" }));
  await user.click(own.getByRole('button', { name: /^2\. Ask the director/ }));
  await user.click(
    within(own.getByRole('group', { name: 'Change rule 2' })).getByRole('button', { name: 'Give it a name' }),
  );
  const form = within(own.getByRole('form', { name: 'Give rule 2 a name' }));
  // Only the name is asked for; the rule still reads in full above it.
  expect(form.queryByRole('textbox', { name: 'What the agent should do' })).toBeNull();
  expect(own.getByLabelText('Rule 2 in full').textContent).toBe(ask.text);
  expect(form.getByRole('button', { name: 'Keep in the draft' })).toHaveProperty('disabled', true);
  await user.type(form.getByRole('textbox', { name: 'Name' }), 'Ask first');
  await user.click(form.getByRole('button', { name: 'Keep in the draft' }));
  await waitFor(() => expect(commands()).toHaveLength(1));
  expect(commands()[0]!.body).toEqual({
    projectId: 'project-x',
    baseRevision: 1,
    rules: [stay, { title: 'Ask first', text: ask.text }, added],
  });
  expect(await own.findByRole('button', { name: /^2\. Ask first Ask the director/ })).toBeTruthy();
});

test('Cancel closes the form and sends nothing', async () => {
  const user = userEvent.setup();
  open('/p/project-x/agents/W-1/told');
  const project = within(await screen.findByRole('region', { name: "This project's rules" }));
  await user.click(project.getByRole('button', { name: 'Add a rule' }));
  await user.type(
    within(project.getByRole('form', { name: 'Add a rule' })).getByRole('textbox', {
      name: 'What the agent should do',
    }),
    'Never mind.',
  );
  await user.click(project.getByRole('button', { name: 'Cancel' }));
  expect(project.queryByRole('form')).toBeNull();
  // Opened again, the form starts empty.
  await user.click(project.getByRole('button', { name: 'Add a rule' }));
  expect(
    within(project.getByRole('form', { name: 'Add a rule' })).getByRole('textbox', {
      name: 'What the agent should do',
    }),
  ).toHaveProperty('value', '');
  await user.click(project.getByRole('button', { name: 'Cancel' }));

  await user.click(project.getByRole('button', { name: /^1\. Company direction/ }));
  await user.click(project.getByRole('button', { name: 'Edit' }));
  const text = within(project.getByRole('form', { name: 'Edit rule 1' })).getByRole('textbox', {
    name: 'What the agent should do',
  });
  await user.clear(text);
  await user.type(text, 'Changed my mind.');
  await user.click(project.getByRole('button', { name: 'Cancel' }));
  expect(project.queryByRole('form')).toBeNull();
  expect(project.getByLabelText('Rule 1 in full').textContent).toBe(direction.text);
  expect(commands()).toEqual([]);
});

test("a refused save shows the controller's message and keeps the form and what was typed", async () => {
  const user = userEvent.setup();
  const message = "Rule 2's name must be one line of at most 80 characters, without asterisks.";
  controller.command = refuse(message);
  open('/p/project-x/agents/W-1/told');
  const project = within(await screen.findByRole('region', { name: "This project's rules" }));
  await user.click(project.getByRole('button', { name: 'Add a rule' }));
  const form = within(project.getByRole('form', { name: 'Add a rule' })),
    name = 'N'.repeat(81);
  await user.click(form.getByRole('textbox', { name: 'Name' }));
  await user.paste(name);
  await user.type(form.getByRole('textbox', { name: 'What the agent should do' }), 'Say it briefly.');
  await user.click(form.getByRole('button', { name: 'Keep in the draft' }));
  expect((await form.findByRole('alert')).textContent).toBe(message);
  expect(form.getByRole('textbox', { name: 'Name' })).toHaveProperty('value', name);
  expect(form.getByRole('textbox', { name: 'What the agent should do' })).toHaveProperty('value', 'Say it briefly.');
  expect(commands()).toEqual([
    {
      url: '/api/instructions/company/company/draft',
      method: 'POST',
      body: { projectId: 'project-x', baseRevision: 1, rules: [direction, { title: name, text: 'Say it briefly.' }] },
    },
  ]);

  // A refused move or removal says why beside the rule, which stays as it was.
  controller.command = refuse('Instructions hold 1 to 100 rules.');
  await user.click(form.getByRole('button', { name: 'Cancel' }));
  await user.click(project.getByRole('button', { name: /^1\. Company direction/ }));
  await user.click(project.getByRole('button', { name: 'Remove the rule' }));
  expect((await project.findByRole('alert')).textContent).toBe('Instructions hold 1 to 100 rules.');
  expect(project.getByLabelText('Rule 1 in full').textContent).toBe(direction.text);
  expect(commands()).toHaveLength(2);
});

test("Publish revision N sends the draft's exact text on the set's revision, and Discard the draft sends only the revision", async () => {
  const user = userEvent.setup();
  controller.command = instructionCommands;
  // The project's rules have a current draft too, at revision 4, its text spaced as the rules would not write it.
  const view = controller.told['W-1']!,
    text = 'Company direction.\n\n\n**Keep it short.**   Say less.';
  view.layers[1] = {
    ...view.layers[1]!,
    revision: 4,
    draft: {
      baseRevision: 4,
      savedAt: '2026-10-29T12:00:00Z',
      current: true,
      text,
      rules: [direction, { title: 'Keep it short', text: 'Say less.' }],
    },
  };
  open('/p/project-x/agents/W-1/told?view=receives');
  const bar = within(await screen.findByRole('region', { name: 'Drafts not published yet' }));
  // Each set with a current draft, in the order the agent reads them; the team's earlier draft is not one.
  const [projectDraft, ownDraft] = bar.getAllByRole('listitem');
  expect([projectDraft, ownDraft].map(item => item!.querySelector('span')!.textContent)).toEqual([
    "One rule added to the project's rules.",
    "One rule added to the agent's own rules.",
  ]);
  expect(within(ownDraft!).getByRole('button', { name: 'Publish revision 2' })).toBeTruthy();

  await user.click(within(projectDraft!).getByRole('button', { name: 'Publish revision 5' }));
  await waitFor(() => expect(bar.getAllByRole('listitem')).toHaveLength(1));
  expect(commands()).toEqual([
    {
      url: '/api/instructions/company/company/publish',
      method: 'POST',
      body: { projectId: 'project-x', baseRevision: 4, text },
    },
  ]);
  // What it receives is read again: the published text, with Eli's own draft still in it.
  expect(screen.getByLabelText('What Eli receives').textContent).toBe(controller.told['W-1']!.receives.text);
  expect(panel().getByText(/It includes one draft/)).toBeTruthy();

  await user.click(bar.getByRole('button', { name: 'Discard the draft' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Drafts not published yet' })).toBeNull());
  expect(commands()[1]).toEqual({
    url: '/api/instructions/employee/W-1/discard',
    method: 'POST',
    body: { projectId: 'project-x', baseRevision: 1 },
  });
  expect(screen.getByLabelText('What Eli receives').textContent).toBe(controller.told['W-1']!.receives.text);
  expect(screen.getByLabelText('What Eli receives').textContent).not.toContain('Run the checks');
  expect(panel().getByText(/It includes no drafts/)).toBeTruthy();

  // The project's rules are revision 5 with the published rule; Eli's own are back to the published two.
  await user.click(screen.getByRole('tab', { name: 'Rules' }));
  const project = await screen.findByRole('region', { name: "This project's rules" }),
    own = screen.getByRole('region', { name: "Eli's own rules" });
  expect(project.textContent).toContain('2 rules · revision 5');
  expect(own.textContent).toContain('2 rules · revision 1');
  expect(sets().map(set => !!within(set).queryByText('Draft'))).toEqual([false, false, false, false]);
});

test("a refused publish shows the controller's message and keeps the draft in the bar", async () => {
  const user = userEvent.setup();
  const message = 'Published instructions changed. Refresh before publishing.';
  controller.command = refuse(message, 409);
  open('/p/project-x/agents/W-1/told');
  const bar = within(await screen.findByRole('region', { name: 'Drafts not published yet' }));
  await user.click(bar.getByRole('button', { name: 'Publish revision 2' }));
  expect((await bar.findByRole('alert')).textContent).toBe(message);
  expect(bar.getAllByRole('listitem')).toHaveLength(1);
  expect(commands()).toEqual([
    {
      url: '/api/instructions/employee/W-1/publish',
      method: 'POST',
      body: { projectId: 'project-x', baseRevision: 1, text: controller.told['W-1']!.layers[3]!.draft!.text },
    },
  ]);
});

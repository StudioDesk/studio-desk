// What an agent is told, on its own page (told-page.tsx): Rules, the sets it reads in the told view's order with
// their counts, revisions, readers and marks, each rule numbered and opened in full, and Find a rule; What it
// receives, the controller's text exactly; and an agent the project does not hold. Then the edits each set the
// project can change keeps as its draft (Add a rule, Edit, Give it a name, Move and Remove the rule), the bar that
// publishes or discards each draft, and the controller's refusals. With a slow controller, each edit and discard
// shows at once, the commands reach it one after another, a refusal puts the rules back, and Publish waits for the
// edits before it. Model-free, with the stand-in controller.
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

// What the next attempt receives, as the controller writes it (src/core/instructions.mjs toldView): each set under its
// heading, one with a current draft as its next revision with the draft's text.
const receivesText = (layers: ToldLayer[]) =>
  layers
    .map(layer => {
      const current = !!layer.draft?.current,
        revision = layer.revision + (current ? 1 : 0);
      return `# ${layer.projectId ? 'Project ' : ''}${layer.scope}: ${layer.id} (revision ${revision})\n\n${current ? layer.draft!.text : layer.text}`;
    })
    .join('\n\n');

// Answers the instruction commands as the controller does (src/core/instructions.mjs): a draft holds the rules saved
// on the set's revision, written as its text (`write`), publishing makes the draft the next revision and discarding
// drops it; the next attempt receives each current draft in place of its set's published text. The answer is the
// set's document with the draft it kept.
const instructionCommands = (url: string, _method: string, body: unknown, write = textOf) => {
  const [scope, id, action] = url.split('/').slice(3),
    view = controller.told['W-1']!,
    set = (layer: ToldLayer) => layer.editable && layer.scope === scope && layer.id === decodeURIComponent(id!),
    layers = view.layers.map((layer): ToldLayer => {
      if (!set(layer)) return layer;
      if (action === 'draft') {
        const { rules } = body as { rules: Rule[] };
        return {
          ...layer,
          draft: {
            baseRevision: layer.revision,
            savedAt: '2026-10-29T13:00:00Z',
            current: true,
            text: write(rules),
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
    receives: { text: receivesText(layers), drafts: layers.filter(layer => layer.draft?.current).length },
  };
  const doc = layers.find(set);
  return doc && { ...doc, draft: doc.draft && { text: doc.draft.text }, history: [] };
};
const refuse =
  (message: string, status = 400) =>
  () => {
    throw Object.assign(new Error(message), { status });
  };

// A slow controller: each command waits, in the order it was sent, until the test answers it as the controller does
// (instructionCommands, writing a draft's text as `write` does) or refuses it with the controller's message.
const slow = () => {
  const held: { answer: (write?: (rules: Rule[]) => string) => void; refuse: (message: string) => void }[] = [];
  controller.command = (url, method, body) =>
    new Promise((resolve, reject) =>
      held.push({
        answer: write => resolve(instructionCommands(url, method, body, write)),
        refuse: message => reject(new Error(message)),
      }),
    );
  return held;
};
const toldReads = () => controller.reads().filter(url => url === '/api/projects/project-x/agents/W-1/told').length;
const region = (name: string) => screen.getByRole('region', { name });
// A set's count and revision, and whether it is marked Draft.
const head = (name: string) => ({
  count: within(region(name)).getByText(/ · revision /).textContent,
  draft: !!within(region(name)).queryByText('Draft'),
});
// The bar's rows, what each set's draft changes; none without the bar.
const barRows = () => {
  const bar = screen.queryByRole('region', { name: 'Drafts not published yet' });
  return bar
    ? within(bar)
        .getAllByRole('listitem')
        .map(item => item.querySelector('span')!.textContent)
    : [];
};
// What it receives, read on its own tab before going back to Rules: its text and how many drafts it says it includes.
const receivesNow = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('tab', { name: 'What it receives' }));
  const text = (await screen.findByLabelText('What Eli receives')).textContent,
    includes = /It includes (no drafts|one draft|\d+ drafts)/.exec(panel().getByText(/It includes/).textContent!)![1];
  await user.click(screen.getByRole('tab', { name: 'Rules' }));
  await screen.findByRole('region', { name: "Eli's own rules" });
  return { text, includes };
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
  // The form closes as the rule shows at once, and opens again on the refusal.
  const again = within(await project.findByRole('form', { name: 'Add a rule' }));
  expect((await again.findByRole('alert')).textContent).toBe(message);
  expect(again.getByRole('textbox', { name: 'Name' })).toHaveProperty('value', name);
  expect(again.getByRole('textbox', { name: 'What the agent should do' })).toHaveProperty('value', 'Say it briefly.');
  expect(commands()).toEqual([
    {
      url: '/api/instructions/company/company/draft',
      method: 'POST',
      body: { projectId: 'project-x', baseRevision: 1, rules: [direction, { title: name, text: 'Say it briefly.' }] },
    },
  ]);

  // A refused move or removal says why beside the rule, which stays as it was.
  controller.command = refuse('Instructions hold 1 to 100 rules.');
  await user.click(again.getByRole('button', { name: 'Cancel' }));
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

test('Move down, Move up and Remove the rule show at once, each sending one command and reading nothing before the answer', async () => {
  const user = userEvent.setup(),
    held = slow(),
    short: Rule = { title: 'Keep it short', text: 'Say less.' },
    view = controller.told['W-1']!;
  // The project's rules hold two published rules and no draft.
  view.layers[1] = {
    ...view.layers[1]!,
    text: `${direction.text}\n\n**Keep it short.** Say less.`,
    rules: [direction, short],
  };
  open('/p/project-x/agents/W-1/told');
  const name = "This project's rules",
    project = () => within(region(name));
  await screen.findByRole('region', { name });
  const reads = toldReads();
  expect(head(name)).toEqual({ count: '2 rules · revision 1 · read by Eli and Nova', draft: false });

  await user.click(project().getByRole('button', { name: /^1\. Company direction/ }));
  await user.click(project().getByRole('button', { name: 'Move down' }));
  // The moved rule shows open in its new place, the set as a draft and the bar what the draft changes.
  await waitFor(() => expect(rows(region(name))).toEqual(['1. Keep it short Say less.', '2. Company direction. ']));
  expect(project().getByLabelText('Rule 2 in full').textContent).toBe(direction.text);
  expect(head(name)).toEqual({ count: '2 rules · revision 1 · read by Eli and Nova', draft: true });
  expect(barRows()).toEqual(["One rule moved in the project's rules.", "One rule added to the agent's own rules."]);
  expect(await receivesNow(user)).toEqual({
    text: expect.stringContaining(
      '# Project company: company (revision 2)\n\n**Keep it short.** Say less.\n\nCompany direction.\n\n# Project team: engineering (revision 3)\n\n',
    ),
    includes: '2 drafts',
  });
  expect(commands()).toEqual([
    {
      url: '/api/instructions/company/company/draft',
      method: 'POST',
      body: { projectId: 'project-x', baseRevision: 1, rules: [short, direction] },
    },
  ]);
  expect(toldReads()).toBe(reads);
  held[0]!.answer();
  // Once answered, with nothing else waiting, what the agent is told is read again.
  await waitFor(() => expect(toldReads()).toBe(reads + 1));

  await user.click(project().getByRole('button', { name: /^2\. Company direction/ }));
  await user.click(project().getByRole('button', { name: 'Move up' }));
  await waitFor(() => expect(rows(region(name))).toEqual(['1. Company direction. ', '2. Keep it short Say less.']));
  expect(head(name)).toEqual({ count: '2 rules · revision 1 · read by Eli and Nova', draft: true });
  expect(barRows()).toEqual(["No rule changed in the project's rules.", "One rule added to the agent's own rules."]);
  expect(await receivesNow(user)).toEqual({
    text: expect.stringContaining(
      '# Project company: company (revision 2)\n\nCompany direction.\n\n**Keep it short.** Say less.\n\n# Project team',
    ),
    includes: '2 drafts',
  });
  expect(commands()).toHaveLength(2);
  expect(commands()[1]!.body).toEqual({ projectId: 'project-x', baseRevision: 1, rules: [direction, short] });
  expect(toldReads()).toBe(reads + 1);
  held[1]!.answer();
  await waitFor(() => expect(toldReads()).toBe(reads + 2));

  await user.click(project().getByRole('button', { name: /^2\. Keep it short/ }));
  await user.click(project().getByRole('button', { name: 'Remove the rule' }));
  await waitFor(() => expect(rows(region(name))).toEqual(['1. Company direction. Company direction.']));
  expect(head(name)).toEqual({ count: '1 rule · revision 1 · read by Eli and Nova', draft: true });
  expect(barRows()).toEqual(["One rule removed from the project's rules.", "One rule added to the agent's own rules."]);
  expect(await receivesNow(user)).toEqual({
    text: expect.stringContaining('# Project company: company (revision 2)\n\nCompany direction.\n\n# Project team'),
    includes: '2 drafts',
  });
  expect(commands()).toHaveLength(3);
  expect(commands()[2]!.body).toEqual({ projectId: 'project-x', baseRevision: 1, rules: [direction] });
  expect(toldReads()).toBe(reads + 2);
  held[2]!.answer();
  await waitFor(() => expect(toldReads()).toBe(reads + 3));
  expect(rows(region(name))).toEqual(['1. Company direction. Company direction.']);
});

test('Add a rule, Edit and Give it a name show at once when kept, each sending one command and reading nothing before the answer', async () => {
  const user = userEvent.setup(),
    held = slow();
  open('/p/project-x/agents/W-1/told');
  const team = "The Engineering team's rules",
    project = "This project's rules",
    own = "Eli's own rules";
  await screen.findByRole('region', { name: own });
  const reads = toldReads();

  // The team's earlier draft is not current, so the added rule follows the published one, as a new draft.
  await user.click(within(region(team)).getByRole('button', { name: 'Add a rule' }));
  const adding = within(within(region(team)).getByRole('form', { name: 'Add a rule' }));
  await user.type(adding.getByRole('textbox', { name: 'Name' }), 'Check the diff');
  await user.type(adding.getByRole('textbox', { name: 'What the agent should do' }), 'Read the whole diff.');
  await user.click(adding.getByRole('button', { name: 'Keep in the draft' }));
  expect(within(region(team)).queryByRole('form')).toBeNull();
  await waitFor(() =>
    expect(rows(region(team))).toEqual([
      '1. Hand off what changed Say which files changed and what you checked.',
      '2. Check the diff Read the whole diff.',
    ]),
  );
  expect(head(team)).toEqual({ count: '2 rules · revision 3 · read by Eli and Nova', draft: true });
  expect(barRows()).toEqual(["One rule added to the team's rules.", "One rule added to the agent's own rules."]);
  expect(await receivesNow(user)).toEqual({
    text: expect.stringContaining(
      '# Project team: engineering (revision 4)\n\n**Hand off what changed.** Say which files changed and what you checked.\n\n**Check the diff.** Read the whole diff.\n\n# Project employee: W-1 (revision 2)\n\n',
    ),
    includes: '2 drafts',
  });
  expect(commands()).toEqual([
    {
      url: '/api/instructions/team/engineering/draft',
      method: 'POST',
      body: {
        projectId: 'project-x',
        baseRevision: 3,
        rules: [hand, { title: 'Check the diff', text: 'Read the whole diff.' }],
      },
    },
  ]);
  expect(toldReads()).toBe(reads);
  held[0]!.answer();
  await waitFor(() => expect(toldReads()).toBe(reads + 1));

  await user.click(within(region(project)).getByRole('button', { name: /^1\. Company direction/ }));
  await user.click(within(region(project)).getByRole('button', { name: 'Edit' }));
  const text = within(region(project)).getByRole('textbox', { name: 'What the agent should do' });
  await user.clear(text);
  await user.type(text, 'Company direction, in short.');
  await user.click(within(region(project)).getByRole('button', { name: 'Keep in the draft' }));
  // The edited rule's row reads what it says now.
  await waitFor(() =>
    expect(rows(region(project))).toEqual(['1. Company direction, in short. Company direction, in short.']),
  );
  expect(within(region(project)).queryByRole('form')).toBeNull();
  expect(head(project)).toEqual({ count: '1 rule · revision 1 · read by Eli and Nova', draft: true });
  expect(barRows()).toEqual([
    "One rule changed in the project's rules.",
    "One rule added to the team's rules.",
    "One rule added to the agent's own rules.",
  ]);
  expect(await receivesNow(user)).toEqual({
    text: expect.stringContaining(
      '# Project company: company (revision 2)\n\nCompany direction, in short.\n\n# Project team: engineering (revision 4)',
    ),
    includes: '3 drafts',
  });
  expect(commands()).toHaveLength(2);
  expect(commands()[1]).toEqual({
    url: '/api/instructions/company/company/draft',
    method: 'POST',
    body: { projectId: 'project-x', baseRevision: 1, rules: [{ title: null, text: 'Company direction, in short.' }] },
  });
  expect(toldReads()).toBe(reads + 1);
  held[1]!.answer();
  await waitFor(() => expect(toldReads()).toBe(reads + 2));

  await user.click(within(region(own)).getByRole('button', { name: /^2\. Ask the director/ }));
  await user.click(within(region(own)).getByRole('button', { name: 'Give it a name' }));
  await user.type(within(region(own)).getByRole('textbox', { name: 'Name' }), 'Ask first');
  await user.click(within(region(own)).getByRole('button', { name: 'Keep in the draft' }));
  await waitFor(() =>
    expect(rows(region(own))).toEqual([
      '1. Stay inside the story Change only the files the story may change.',
      '2. Ask first Ask the director when a choice is not yours to make.',
      '3. Run the checks Run the focused tests before handing off.',
    ]),
  );
  expect(head(own)).toEqual({ count: '3 rules · revision 1 · read by Eli', draft: true });
  expect(barRows()).toEqual([
    "One rule changed in the project's rules.",
    "One rule added to the team's rules.",
    "One rule added and one changed in the agent's own rules.",
  ]);
  const sent = await receivesNow(user);
  expect(sent.includes).toBe('3 drafts');
  expect(
    sent.text!.endsWith(
      '# Project employee: W-1 (revision 2)\n\n**Stay inside the story.** Change only the files the story may change.\n\n**Ask first.** Ask the director when a choice is not yours to make.\n\n**Run the checks.** Run the focused tests before handing off.\nSay which ones ran.',
    ),
  ).toBe(true);
  expect(commands()).toHaveLength(3);
  expect(commands()[2]).toEqual({
    url: '/api/instructions/employee/W-1/draft',
    method: 'POST',
    body: { projectId: 'project-x', baseRevision: 1, rules: [stay, { title: 'Ask first', text: ask.text }, added] },
  });
  expect(toldReads()).toBe(reads + 2);
  held[2]!.answer();
  await waitFor(() => expect(toldReads()).toBe(reads + 3));
});

test('Discard the draft drops it at once; refused, the draft and its row come back with the message', async () => {
  const user = userEvent.setup(),
    held = slow(),
    message = 'Published instructions changed. Refresh before saving.';
  open('/p/project-x/agents/W-1/told');
  const own = "Eli's own rules";
  await screen.findByRole('region', { name: own });
  const reads = toldReads(),
    was = await receivesNow(user);
  expect(was.includes).toBe('no drafts');

  await user.click(screen.getByRole('button', { name: 'Discard the draft' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Drafts not published yet' })).toBeNull());
  expect(head(own)).toEqual({ count: '2 rules · revision 1 · read by Eli', draft: false });
  expect(rows(region(own))).toEqual([
    '1. Stay inside the story Change only the files the story may change.',
    '2. Ask the director when a choice is not… Ask the director when a choice is not yours to make.',
  ]);
  const dropped = await receivesNow(user);
  expect(dropped.includes).toBe('no drafts');
  expect(
    dropped.text!.endsWith(
      '# Project employee: W-1 (revision 1)\n\n**Stay inside the story.** Change only the files the story may change.\n\nAsk the director when a choice is not yours to make.',
    ),
  ).toBe(true);
  expect(commands()).toEqual([
    {
      url: '/api/instructions/employee/W-1/discard',
      method: 'POST',
      body: { projectId: 'project-x', baseRevision: 1 },
    },
  ]);
  expect(toldReads()).toBe(reads);

  held[0]!.refuse(message);
  const bar = within(await screen.findByRole('region', { name: 'Drafts not published yet' }));
  expect((await bar.findByRole('alert')).textContent).toBe(message);
  expect(barRows()).toEqual(["One rule added to the agent's own rules."]);
  expect(head(own)).toEqual({ count: '3 rules · revision 1 · read by Eli', draft: true });
  expect(rows(region(own))).toHaveLength(3);
  expect(await receivesNow(user)).toEqual(was);
  await waitFor(() => expect(toldReads()).toBe(reads + 1));
  expect(commands()).toHaveLength(1);
});

test("a refused Edit, Add a rule or move puts the set back as it was, with the controller's message and the form open again with what was typed", async () => {
  const user = userEvent.setup(),
    held = slow();
  open('/p/project-x/agents/W-1/told');
  const own = "Eli's own rules",
    project = "This project's rules";
  await screen.findByRole('region', { name: own });
  const was = await receivesNow(user),
    ownRows = rows(region(own));

  // Edit: the change shows at once, then the refusal opens the form again in place, with what was typed.
  await user.click(within(region(own)).getByRole('button', { name: /^1\. Stay inside the story/ }));
  await user.click(within(region(own)).getByRole('button', { name: 'Edit' }));
  const name = within(region(own)).getByRole('textbox', { name: 'Name' }),
    text = within(region(own)).getByRole('textbox', { name: 'What the agent should do' });
  await user.clear(name);
  await user.type(name, 'Stay in scope');
  await user.clear(text);
  await user.type(text, 'Change only the approved files.');
  await user.click(within(region(own)).getByRole('button', { name: 'Keep in the draft' }));
  await waitFor(() => expect(rows(region(own))[0]).toBe('1. Stay in scope Change only the approved files.'));
  held[0]!.refuse("Rule 1's text must be at most 2000 characters.");
  const edit = within(await within(region(own)).findByRole('form', { name: 'Edit rule 1' }));
  expect(edit.getByRole('alert').textContent).toBe("Rule 1's text must be at most 2000 characters.");
  expect(edit.getByRole('textbox', { name: 'Name' })).toHaveProperty('value', 'Stay in scope');
  expect(edit.getByRole('textbox', { name: 'What the agent should do' })).toHaveProperty(
    'value',
    'Change only the approved files.',
  );
  expect(rows(region(own))).toEqual(['1. Stay inside the story ', ...ownRows.slice(1)]);
  expect(head(own)).toEqual({ count: '3 rules · revision 1 · read by Eli', draft: true });
  expect(barRows()).toEqual(["One rule added to the agent's own rules."]);
  await user.click(edit.getByRole('button', { name: 'Cancel' }));
  expect(within(region(own)).getByLabelText('Rule 1 in full').textContent).toBe(stay.text);

  // Add a rule: the form closes as the rule shows, and opens again with what was typed.
  await user.click(within(region(project)).getByRole('button', { name: 'Add a rule' }));
  await user.type(within(region(project)).getByRole('textbox', { name: 'Name' }), 'Keep it short');
  await user.type(within(region(project)).getByRole('textbox', { name: 'What the agent should do' }), 'Say less.');
  await user.click(within(region(project)).getByRole('button', { name: 'Keep in the draft' }));
  await waitFor(() =>
    expect(head(project)).toEqual({ count: '2 rules · revision 1 · read by Eli and Nova', draft: true }),
  );
  expect(barRows()).toEqual(["One rule added to the project's rules.", "One rule added to the agent's own rules."]);
  held[1]!.refuse('Instructions hold 1 to 100 rules.');
  const add = within(await within(region(project)).findByRole('form', { name: 'Add a rule' }));
  expect(add.getByRole('alert').textContent).toBe('Instructions hold 1 to 100 rules.');
  expect(add.getByRole('textbox', { name: 'Name' })).toHaveProperty('value', 'Keep it short');
  expect(add.getByRole('textbox', { name: 'What the agent should do' })).toHaveProperty('value', 'Say less.');
  expect(rows(region(project))).toEqual(['1. Company direction. Company direction.']);
  expect(head(project)).toEqual({ count: '1 rule · revision 1 · read by Eli and Nova', draft: false });
  expect(barRows()).toEqual(["One rule added to the agent's own rules."]);
  await user.click(add.getByRole('button', { name: 'Cancel' }));

  // A move: refused, its message shows beside the set, and the rule is back where it was, still open.
  await user.click(within(region(own)).getByRole('button', { name: /^2\. Ask the director/ }));
  await user.click(
    within(within(region(own)).getByRole('group', { name: 'Change rule 2' })).getByRole('button', { name: 'Move up' }),
  );
  await waitFor(() => expect(within(region(own)).getByLabelText('Rule 1 in full').textContent).toBe(ask.text));
  held[2]!.refuse('Published instructions changed. Refresh before saving.');
  expect((await within(region(own)).findByRole('alert')).textContent).toBe(
    'Published instructions changed. Refresh before saving.',
  );
  expect(within(region(own)).getByLabelText('Rule 2 in full').textContent).toBe(ask.text);
  expect(head(own)).toEqual({ count: '3 rules · revision 1 · read by Eli', draft: true });
  expect(barRows()).toEqual(["One rule added to the agent's own rules."]);
  expect(await receivesNow(user)).toEqual(was);
  expect(rows(region(own))).toEqual(ownRows);
  expect(commands()).toHaveLength(3);
});

test('two quick moves both show at once and reach the controller in order; a change made before a refusal is answered is not sent', async () => {
  const user = userEvent.setup(),
    held = slow();
  open('/p/project-x/agents/W-1/told');
  const own = "Eli's own rules",
    group = (at: number) => within(within(region(own)).getByRole('group', { name: `Change rule ${at}` }));
  await screen.findByRole('region', { name: own });
  const reads = toldReads();

  await user.click(within(region(own)).getByRole('button', { name: /^1\. Stay inside the story/ }));
  await user.click(group(1).getByRole('button', { name: 'Move down' }));
  await waitFor(() => expect(within(region(own)).getByLabelText('Rule 2 in full').textContent).toBe(stay.text));
  // The second builds on the first, before the controller answers it.
  await user.click(group(2).getByRole('button', { name: 'Move down' }));
  const moved = [
    '1. Ask the director when a choice is not… Ask the director when a choice is not yours to make.',
    '2. Run the checks Run the focused tests before handing off.',
    '3. Stay inside the story ',
  ];
  await waitFor(() => expect(rows(region(own))).toEqual(moved));
  expect(commands()).toHaveLength(1);
  expect(commands()[0]!.body).toEqual({ projectId: 'project-x', baseRevision: 1, rules: [ask, stay, added] });

  held[0]!.answer();
  await waitFor(() => expect(commands()).toHaveLength(2));
  expect(commands().map(command => command.url)).toEqual(Array(2).fill('/api/instructions/employee/W-1/draft'));
  expect(commands()[1]!.body).toEqual({ projectId: 'project-x', baseRevision: 1, rules: [ask, added, stay] });
  // Nothing is read while the second is waiting, and the page still shows it.
  expect(toldReads()).toBe(reads);
  expect(rows(region(own))).toEqual(moved);
  held[1]!.answer();
  await waitFor(() => expect(toldReads()).toBe(reads + 1));
  expect(rows(region(own))).toEqual(moved);

  // Two more, the first refused: the second built on it, so it is not sent, and the rules are back as the controller
  // holds them.
  await user.click(group(3).getByRole('button', { name: 'Move up' }));
  await waitFor(() => expect(within(region(own)).getByLabelText('Rule 2 in full').textContent).toBe(stay.text));
  await user.click(group(2).getByRole('button', { name: 'Move up' }));
  await waitFor(() => expect(within(region(own)).getByLabelText('Rule 1 in full').textContent).toBe(stay.text));
  expect(commands()).toHaveLength(3);
  held[2]!.refuse('Published instructions changed. Refresh before saving.');
  expect((await within(region(own)).findByRole('alert')).textContent).toBe(
    'Published instructions changed. Refresh before saving.',
  );
  expect(rows(region(own))).toEqual(moved);
  await waitFor(() => expect(toldReads()).toBe(reads + 2));
  expect(commands()).toHaveLength(3);
  expect(held).toHaveLength(3);
});

test('Publish after a quick edit waits for it, then sends the draft text the controller holds', async () => {
  const user = userEvent.setup(),
    held = slow();
  open('/p/project-x/agents/W-1/told');
  const own = "Eli's own rules";
  await screen.findByRole('region', { name: own });

  await user.click(within(region(own)).getByRole('button', { name: /^1\. Stay inside the story/ }));
  await user.click(within(region(own)).getByRole('button', { name: 'Edit' }));
  const text = within(region(own)).getByRole('textbox', { name: 'What the agent should do' });
  await user.clear(text);
  await user.type(text, 'Change only the approved files.');
  await user.click(within(region(own)).getByRole('button', { name: 'Keep in the draft' }));
  await waitFor(() => expect(barRows()).toEqual(["One rule added and one changed in the agent's own rules."]));
  const bar = within(region('Drafts not published yet'));
  await user.click(bar.getByRole('button', { name: 'Publish revision 2' }));
  // The bar keeps the draft while Publish waits for the edit before it, and nothing is published yet.
  await waitFor(() => expect(bar.getByRole('button', { name: 'Publish revision 2' })).toHaveProperty('disabled', true));
  expect(commands().map(command => command.url)).toEqual(['/api/instructions/employee/W-1/draft']);

  // The controller keeps the edit with its own spacing, which the page would not write.
  held[0]!.answer(rules => textOf(rules).replaceAll('\n\n', '\n\n\n'));
  const kept = controller.told['W-1']!.layers[3]!.draft!.text;
  await waitFor(() => expect(commands()).toHaveLength(2));
  expect(kept).toContain('**Stay inside the story.** Change only the approved files.\n\n\nAsk the director');
  expect(commands()[1]).toEqual({
    url: '/api/instructions/employee/W-1/publish',
    method: 'POST',
    body: { projectId: 'project-x', baseRevision: 1, text: kept },
  });
  expect(barRows()).toEqual(["One rule added and one changed in the agent's own rules."]);
  held[1]!.answer();
  await waitFor(() => expect(barRows()).toEqual([]));
  expect(head(own)).toEqual({ count: '3 rules · revision 2 · read by Eli', draft: false });
});

test('a save refused before Publish sends no publish', async () => {
  const user = userEvent.setup(),
    held = slow();
  open('/p/project-x/agents/W-1/told');
  const own = "Eli's own rules";
  await screen.findByRole('region', { name: own });
  const reads = toldReads();

  await user.click(within(region(own)).getByRole('button', { name: /^1\. Stay inside the story/ }));
  await user.click(within(region(own)).getByRole('button', { name: 'Edit' }));
  const text = within(region(own)).getByRole('textbox', { name: 'What the agent should do' });
  await user.clear(text);
  await user.type(text, 'Change only the approved files.');
  await user.click(within(region(own)).getByRole('button', { name: 'Keep in the draft' }));
  await waitFor(() => expect(barRows()).toEqual(["One rule added and one changed in the agent's own rules."]));
  await user.click(within(region('Drafts not published yet')).getByRole('button', { name: 'Publish revision 2' }));
  expect(commands()).toHaveLength(1);
  held[0]!.refuse('Published instructions changed. Refresh before saving.');
  const edit = within(await within(region(own)).findByRole('form', { name: 'Edit rule 1' }));
  expect(edit.getByRole('alert').textContent).toBe('Published instructions changed. Refresh before saving.');
  await waitFor(() => expect(toldReads()).toBe(reads + 1));
  expect(commands().map(command => command.url)).toEqual(['/api/instructions/employee/W-1/draft']);
  // The draft is back as it was, ready to publish, and Publish says nothing of its own.
  const bar = within(region('Drafts not published yet'));
  expect(barRows()).toEqual(["One rule added to the agent's own rules."]);
  expect(bar.getByRole('button', { name: 'Publish revision 2' })).toHaveProperty('disabled', false);
  expect(bar.queryByRole('alert')).toBeNull();
});

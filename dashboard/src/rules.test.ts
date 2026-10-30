// What an agent is told, as rules (rules.ts): the rules a set shows and its edits, the words for a rule and for what a
// draft changes, finding a rule and the page's own copy of the told view after a draft save or discard, from the
// records alone; and the told view, the director's draft, publish and discard as they reach the stand-in controller.
// Model-free; no page shows any of it yet.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Refusal, type InstructionDoc, type Rule, type ToldLayer, type ToldView } from './api';
import { ProjectLive } from './live-context';
import {
  addRule,
  canMove,
  draftChange,
  draftText,
  findRules,
  firstLine,
  moveRule,
  nameRule,
  readRules,
  removeRule,
  replaceRule,
  ruleLabel,
  toldWithDraft,
  toldWithoutDraft,
  useDiscardRules,
  usePublishRules,
  useSaveRules,
  useTold,
  workingRules,
} from './rules';
import { StreamFactoryContext } from './stream-context';
import { createStream, fakeController, latest, toldFixture, type Controller } from './test-controller';

const stay: Rule = { title: 'Stay inside the story', text: 'Change only the files the story may change.' },
  ask: Rule = { title: null, text: 'Ask the director when a choice is not yours to make.' },
  hand: Rule = { title: 'Hand off', text: 'Say which files changed and what you checked.' },
  added: Rule = { title: 'Run the checks', text: 'Run the focused tests before handing off.' };
// The document's text from its rules, as src/core/rules.mjs formatRules writes it.
const textOf = (rules: readonly Rule[]) =>
  rules.map(rule => (rule.title ? `**${rule.title}.** ${rule.text}` : rule.text)).join('\n\n');
// A set published with these rules, and with a draft of others, saved on its revision unless `current` is false.
const published = (layer: ToldLayer, rules: readonly Rule[]): ToldLayer => ({
  ...layer,
  text: textOf(rules),
  rules: [...rules],
  draft: null,
});
const drafted = (layer: ToldLayer, rules: readonly Rule[], current = true): ToldLayer => ({
  ...layer,
  draft: {
    baseRevision: current ? layer.revision : layer.revision - 1,
    savedAt: '2026-10-29T12:00:00Z',
    current,
    text: textOf(rules),
    rules: [...rules],
  },
});
const fixture = toldFixture(),
  team = published({ ...fixture.layers[2]!, revision: 3 }, [stay, ask, hand]),
  own = published(fixture.layers[3]!, [stay, ask]);

test("a set's edits start from its current draft, else from what is published", () => {
  expect(workingRules(own)).toEqual([stay, ask]);
  expect(workingRules(drafted(own, [ask]))).toEqual([ask]);
  // A draft saved on an earlier revision can no longer be published, so nothing builds on it.
  expect(workingRules(drafted(own, [ask], false))).toEqual([stay, ask]);
});

test('each edit answers a new list of rules and leaves the one given as it was', () => {
  const rules = Object.freeze([stay, ask, hand].map(rule => Object.freeze({ ...rule }))),
    before = structuredClone(rules);
  expect(addRule(rules, added)).toEqual([stay, ask, hand, added]);
  expect(addRule(rules, added, 1)).toEqual([stay, added, ask, hand]);
  expect(addRule(rules, added, 0)).toEqual([added, stay, ask, hand]);
  expect(replaceRule(rules, 1, added)).toEqual([stay, added, hand]);
  expect(removeRule(rules, 0)).toEqual([ask, hand]);
  expect(removeRule(rules, 2)).toEqual([stay, ask]);
  expect(moveRule(rules, 0, 1)).toEqual([ask, stay, hand]);
  expect(moveRule(rules, 2, -1)).toEqual([stay, hand, ask]);
  // Not past either end.
  expect(canMove(rules, 0, -1)).toBe(false);
  expect(canMove(rules, 2, 1)).toBe(false);
  expect(canMove(rules, 1, -1)).toBe(true);
  expect(canMove(rules, 1, 1)).toBe(true);
  expect(moveRule(rules, 0, -1)).toEqual([stay, ask, hand]);
  expect(moveRule(rules, 2, 1)).toEqual([stay, ask, hand]);
  expect(moveRule(rules, 0, -1)).not.toBe(rules);
  // A rule without a name gets one, trimmed, and an empty name takes a name away.
  expect(nameRule(rules, 1, '  Ask first ')).toEqual([stay, { title: 'Ask first', text: ask.text }, hand]);
  expect(nameRule(rules, 0, ' ')).toEqual([{ title: null, text: stay.text }, ask, hand]);
  // A place outside the list changes nothing.
  expect(replaceRule(rules, 5, added)).toEqual([stay, ask, hand]);
  expect(removeRule(rules, -1)).toEqual([stay, ask, hand]);
  expect(rules).toEqual(before);
});

test('a rule is called by its name, else by the first words of its text, and shows its first line closed', () => {
  expect(ruleLabel(stay)).toBe('Stay inside the story');
  expect(ruleLabel(ask)).toBe('Ask the director when a choice is not…');
  expect(ruleLabel({ title: null, text: '  Keep it short.\n' })).toBe('Keep it short.');
  expect(firstLine({ title: 'Hand off', text: 'Say what changed.\nSay what you checked.' })).toBe('Say what changed.');
  expect(firstLine(ask)).toBe(ask.text);
});

test('a rule is found by a word in its name or its text, in any set and any case', () => {
  const review: Rule = { title: 'Review', text: 'Check the candidate before it lands.' },
    asked: Rule = { title: null, text: 'Ask for a review when unsure.' },
    layers = [
      fixture.layers[0]!,
      published(fixture.layers[1]!, [{ title: null, text: 'Company direction.' }]),
      published(fixture.layers[2]!, [hand, review]),
      published(fixture.layers[3]!, [stay, asked]),
    ];
  const found = (words: string) =>
    findRules(layers, words).map(set => [set.layer.layer, set.rules.map(item => [item.index, item.rule])]);
  // In the team's rules by its name, and in the agent's own by its text.
  expect(found('REVIEW')).toEqual([
    ['team', [[1, review]]],
    ['own', [[1, asked]]],
  ]);
  // Every word must be in the same rule, its name or its text.
  expect(found('stay story')).toEqual([['own', [[0, stay]]]]);
  expect(found('stay')).toEqual([
    ['every-project', [[0, fixture.layers[0]!.rules[0]]]],
    ['own', [[0, stay]]],
  ]);
  expect(found('nothing like this')).toEqual([]);
  // No words find every rule.
  expect(findRules(layers, '  ').map(set => set.rules.length)).toEqual([1, 1, 2, 2]);
  // A set with a current draft is searched as it shows: its draft's rules.
  const withDraft = [...layers.slice(0, 3), drafted(layers[3]!, [stay, added])];
  expect(findRules(withDraft, 'focused').map(set => [set.layer.layer, set.rules[0]!.rule])).toEqual([['own', added]]);
  expect(findRules(withDraft, 'unsure')).toEqual([]);
});

test('what a draft changes is said in words, by comparing its rules with the published ones', () => {
  expect(draftChange(drafted(own, [stay, ask, added]))).toBe("one rule added to the agent's own rules");
  expect(draftChange(drafted(team, [stay, { title: null, text: 'Ask before choosing.' }, hand]))).toBe(
    "one rule changed in the team's rules",
  );
  expect(draftChange(drafted(team, moveRule([stay, ask, hand], 0, 1)))).toBe("one rule moved in the team's rules");
  expect(draftChange(drafted(team, [stay, hand]))).toBe("one rule removed from the team's rules");
  // A named rule whose text changed is the same rule changed, wherever the rest went.
  expect(
    draftChange(
      drafted(team, [
        { ...stay, text: 'Change only the approved files.' },
        { ...hand, text: 'Say what changed.' },
      ]),
    ),
  ).toBe("two rules changed and one removed in the team's rules");
  // Giving a rule a name changes it.
  expect(draftChange(drafted(team, nameRule([stay, ask, hand], 1, 'Ask first')))).toBe(
    "one rule changed in the team's rules",
  );
  // Removed in one place and added in another is not a change of one rule.
  expect(draftChange(drafted(team, [hand, stay, added]))).toBe(
    "one rule added, one moved and one removed in the team's rules",
  );
  expect(draftChange(drafted(own, [stay, ask]))).toBe("no rule changed in the agent's own rules");
  expect(draftChange(drafted(published(fixture.layers[1]!, [ask]), [ask, stay, hand]))).toBe(
    "two rules added to the project's rules",
  );
  // A set without a current draft has none to describe.
  expect(draftChange(own)).toBeNull();
  expect(draftChange(drafted(own, [stay], false))).toBeNull();
});

test("a draft's text is written as the controller writes its rules, and read back as the controller reads it", () => {
  expect(draftText([{ title: 'Keep it short...', text: ' Say less. ' }])).toBe('**Keep it short.** Say less.');
  // A name ending in ? or ! keeps it without a full stop.
  expect(draftText([{ title: ' Why? ', text: 'Say what it is for.' }])).toBe('**Why?** Say what it is for.');
  expect(draftText([{ title: 'Now!', text: 'Do it.' }])).toBe('**Now!** Do it.');
  expect(draftText([{ title: 'Name', text: '  ' }])).toBe('**Name.**');
  expect(draftText([{ title: null, text: '  Ask first.\n' }])).toBe('Ask first.');
  // A name of full stops alone is no name.
  expect(draftText([{ title: ' .. ', text: 'Ask first.' }])).toBe('Ask first.');
  expect(draftText([{ title: 'Hand off', text: 'Say what changed.\r\nSay what you checked.\rStop.' }])).toBe(
    '**Hand off.** Say what changed.\nSay what you checked.\nStop.',
  );
  expect(draftText([stay, ask])).toBe(
    '**Stay inside the story.** Change only the files the story may change.\n\nAsk the director when a choice is not yours to make.',
  );
  // Read back, a rule's name has no trailing full stops and its text is trimmed.
  expect(readRules(draftText([{ title: 'Keep it short...', text: ' Say less. ' }, ask]))).toEqual([
    { title: 'Keep it short', text: 'Say less.' },
    ask,
  ]);
  expect(readRules('**Why?** Say it.\r\n \r\n\r\n**Name.**\n\n**...**  Untitled.')).toEqual([
    { title: 'Why?', text: 'Say it.' },
    { title: 'Name', text: '' },
    { title: null, text: 'Untitled.' },
  ]);
});

// The fixture's What it receives, one set at a time.
const sections = [
  '# company: company (revision 1)\n\n**Stay local.** Keep records, files and the dashboard on this computer.',
  '# Project company: company (revision 1)\n\nCompany direction.',
  '# Project team: engineering (revision 1)\n\n**Hand off what changed.** Say which files changed and what you checked.',
  '# Project employee: W-1 (revision 1)\n\n**Stay inside the story.** Change only the files the story may change.\n\nAsk the director when a choice is not yours to make.',
];

test("a saved draft gives the told view the controller will answer: the set's draft and what the agent receives", () => {
  const given = toldFixture();
  expect(given.receives.text).toBe(sections.join('\n\n'));
  const told = toldWithDraft(given, 'own', moveRule(given.layers[3]!.rules, 0, 1)),
    saved = told.layers[3]!,
    text =
      'Ask the director when a choice is not yours to make.\n\n**Stay inside the story.** Change only the files the story may change.';
  expect(saved.draft).toEqual({ baseRevision: 1, savedAt: null, current: true, text, rules: [ask, stay] });
  expect({ ...saved, draft: null }).toEqual(given.layers[3]);
  expect(workingRules(saved)).toEqual([ask, stay]);
  expect(draftChange(saved)).toBe("one rule moved in the agent's own rules");
  expect(told.agent).toEqual(given.agent);
  expect(told.layers.slice(0, 3)).toEqual(given.layers.slice(0, 3));
  expect(told.receives).toEqual({
    text: [...sections.slice(0, 3), `# Project employee: W-1 (revision 2)\n\n${text}`].join('\n\n'),
    drafts: 1,
  });
  // The view given is left as it was.
  expect(given).toEqual(toldFixture());
  // Saving over a draft keeps when it was saved, and one saved on an earlier revision becomes one on the set's.
  const stale: ToldView = { ...given, layers: [...given.layers.slice(0, 3), drafted(own, [ask], false)] };
  expect(toldWithDraft(stale, 'own', [stay]).layers[3]!.draft).toEqual({
    baseRevision: 1,
    savedAt: '2026-10-29T12:00:00Z',
    current: true,
    text: '**Stay inside the story.** Change only the files the story may change.',
    rules: [stay],
  });
});

test("the project's set is found by which set it is, never as the shared set with its scope and id, and a discard gives back what is published", () => {
  const given = toldFixture(),
    told = toldWithDraft(given, 'project', [{ title: null, text: 'Company direction.' }, added]);
  expect(given.layers[0]).toMatchObject({ scope: 'company', id: 'company' });
  expect(given.layers[1]).toMatchObject({ scope: 'company', id: 'company' });
  expect(told.layers[0]).toEqual(given.layers[0]);
  expect(told.layers[1]!.draft).toMatchObject({
    baseRevision: 1,
    current: true,
    rules: [{ title: null, text: 'Company direction.' }, added],
  });
  expect(told.layers.slice(2)).toEqual(given.layers.slice(2));
  expect(told.receives).toEqual({
    text: [
      sections[0],
      '# Project company: company (revision 2)\n\nCompany direction.\n\n**Run the checks.** Run the focused tests before handing off.',
      ...sections.slice(2),
    ].join('\n\n'),
    drafts: 1,
  });
  const discarded = toldWithoutDraft(told, 'project');
  expect(discarded.layers[1]!.draft).toBeNull();
  expect(discarded.receives).toEqual(toldFixture().receives);
  expect(discarded).toEqual(toldFixture());
  expect(told.layers[1]!.draft).not.toBeNull();
});

test('a set holding a draft saved on an earlier revision keeps it and stays published in what the agent receives', () => {
  const given = toldFixture(),
    stale = drafted({ ...given.layers[2]!, revision: 3 }, [hand, added], false),
    view: ToldView = { ...given, layers: [given.layers[0]!, given.layers[1]!, stale, given.layers[3]!] },
    team3 =
      '# Project team: engineering (revision 3)\n\n**Hand off what changed.** Say which files changed and what you checked.',
    told = toldWithDraft(view, 'own', [stay]);
  expect(told.layers[2]).toEqual(stale);
  expect(told.receives).toEqual({
    text: [
      ...sections.slice(0, 2),
      team3,
      '# Project employee: W-1 (revision 2)\n\n**Stay inside the story.** Change only the files the story may change.',
    ].join('\n\n'),
    drafts: 1,
  });
  const discarded = toldWithoutDraft(told, 'own');
  expect(discarded.layers[2]).toEqual(stale);
  expect(discarded.receives).toEqual({ text: [...sections.slice(0, 2), team3, sections[3]].join('\n\n'), drafts: 0 });
});

let controller: Controller, client: QueryClient;
// Pages read once the project's stream says where the controller is, as the dashboard's do.
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(
    QueryClientProvider,
    { client },
    createElement(
      StreamFactoryContext.Provider,
      { value: createStream },
      createElement(ProjectLive, { projectId: 'project-x', children }),
    ),
  );
const toldUrl = (workerId: string) => `/api/projects/project-x/agents/${workerId}/told`;
const commands = () => controller.requests.filter(request => request.method !== 'GET');

beforeEach(() => {
  controller = fakeController();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
});

test('what an agent is told is read from its route once the stream is ready, and an agent the project does not hold reads as not found', async () => {
  const { result } = renderHook(
    () => ({ known: useTold('project-x', 'W-1'), unknown: useTold('project-x', 'W-404') }),
    { wrapper },
  );
  expect(controller.requests).toEqual([]);
  await waitFor(() => expect(result.current.known.data).toEqual(controller.told['W-1']));
  await waitFor(() => expect(result.current.unknown.isSuccess).toBe(true));
  expect(result.current.unknown.data).toBeNull();
  expect(result.current.unknown.error).toBeNull();
  expect(controller.reads().sort()).toEqual([toldUrl('W-1'), toldUrl('W-404')]);
  expect(client.getQueryData(['project-x', 'instructions', 'told', 'W-1'])).toEqual(controller.told['W-1']);
  // A change to the organization's records reads the project's instructions again, and with them what it is told.
  controller.told['W-1'] = { ...controller.told['W-1']!, receives: { text: 'Published since.', drafts: 0 } };
  latest().emit('change', { version: 2, start: 'start-a', changes: [{ seq: 2, type: 'organization' }] });
  await waitFor(() => expect(result.current.known.data?.receives.text).toBe('Published since.'));
});

// Answers a saved draft as the controller does: the set's draft holds the rules, and the next attempt receives it.
const saveAs = (text: string) => (url: string, _method: string, body: unknown) => {
  const { rules } = body as { rules: Rule[] },
    view = controller.told['W-1']!,
    scope = url.split('/')[3]!;
  controller.told['W-1'] = {
    ...view,
    layers: view.layers.map(layer =>
      layer.scope === scope && layer.layer !== 'every-project'
        ? {
            ...layer,
            draft: { baseRevision: layer.revision, savedAt: '2026-10-29T12:00:00Z', current: true, text, rules },
          }
        : layer,
    ),
    receives: { ...view.receives, drafts: 1 },
  };
  return { scope, id: 'engineering', revision: 3, text: '', draft: { text }, history: [] } satisfies InstructionDoc;
};

test("saving a draft sends the set's rules and never text, on the revision it shows, and what it is told is read again", async () => {
  controller.told['W-1'] = { ...fixture, layers: [fixture.layers[0]!, fixture.layers[1]!, team, fixture.layers[3]!] };
  const { result } = renderHook(() => ({ told: useTold('project-x', 'W-1'), save: useSaveRules('project-x') }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.told.data).toBeTruthy());
  const shown = result.current.told.data!.layers[2]!,
    rules = addRule(workingRules(shown), added);
  controller.command = saveAs(textOf(rules));
  // Only a rule's name and text are sent, whatever a page keeps beside them.
  const kept = rules.map((rule, index) => ({ ...rule, open: index === 0 }));
  await act(() => result.current.save.mutateAsync({ layer: shown, rules: kept }));
  expect(commands()).toEqual([
    {
      url: '/api/instructions/team/engineering/draft',
      method: 'POST',
      body: { projectId: 'project-x', baseRevision: 3, rules: [stay, ask, hand, added] },
    },
  ]);
  expect(commands()[0]!.body).not.toHaveProperty('text');
  // Read again before the answer came back, with the draft the next attempt will receive.
  expect(controller.reads()).toEqual([toldUrl('W-1'), toldUrl('W-1')]);
  const team2 = (client.getQueryData(['project-x', 'instructions', 'told', 'W-1']) as ToldView).layers[2]!;
  expect(workingRules(team2)).toEqual([stay, ask, hand, added]);
  expect(draftChange(team2)).toBe("one rule added to the team's rules");
});

test("publishing sends the draft's exact text on the set's revision, and discarding sends only the revision", async () => {
  // A text whose rules read the same as another's: publishing sends the draft as saved, not as the rules write it.
  const text = '**Stay inside the story.**  Change only the files the story may change.\n\n\nAsk first.',
    saved = drafted(own, [stay, { title: null, text: 'Ask first.' }]);
  controller.told['W-1'] = {
    ...fixture,
    layers: [...fixture.layers.slice(0, 3), { ...saved, draft: { ...saved.draft!, text } }],
  };
  const { result } = renderHook(
    () => ({
      told: useTold('project-x', 'W-1'),
      publish: usePublishRules('project-x'),
      discard: useDiscardRules('project-x'),
    }),
    { wrapper },
  );
  await waitFor(() => expect(result.current.told.data).toBeTruthy());
  const shown = result.current.told.data!.layers[3]!;
  await act(() => result.current.publish.mutateAsync(shown));
  await act(() => result.current.discard.mutateAsync(shown));
  expect(commands()).toEqual([
    {
      url: '/api/instructions/employee/W-1/publish',
      method: 'POST',
      body: { projectId: 'project-x', baseRevision: 1, text },
    },
    {
      url: '/api/instructions/employee/W-1/discard',
      method: 'POST',
      body: { projectId: 'project-x', baseRevision: 1 },
    },
  ]);
  expect(controller.reads()).toEqual([toldUrl('W-1'), toldUrl('W-1'), toldUrl('W-1')]);
});

test("a refused command rejects with the controller's message and reads what it is told again; a set without a draft publishes nothing", async () => {
  const message = 'Published instructions changed. Refresh before saving.';
  controller.command = () => {
    throw Object.assign(new Error(message), { status: 409 });
  };
  const { result } = renderHook(
    () => ({
      told: useTold('project-x', 'W-1'),
      save: useSaveRules('project-x'),
      publish: usePublishRules('project-x'),
    }),
    { wrapper },
  );
  await waitFor(() => expect(result.current.told.data).toBeTruthy());
  const shown = result.current.told.data!.layers[3]!;
  let refused: unknown;
  await act(async () => {
    refused = await result.current.save
      .mutateAsync({ layer: shown, rules: removeRule(workingRules(shown), 0) })
      .catch((error: unknown) => error);
  });
  expect(refused).toBeInstanceOf(Refusal);
  expect(refused).toMatchObject({ message });
  expect(controller.reads()).toEqual([toldUrl('W-1'), toldUrl('W-1')]);
  let nothing: unknown;
  await act(async () => {
    nothing = await result.current.publish.mutateAsync(shown).catch((error: unknown) => error);
  });
  expect(nothing).toMatchObject({ message: 'This set has no draft to publish.' });
  expect(commands()).toHaveLength(1);
});

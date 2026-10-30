// What an agent is told, as rules (1.2 step 1), as the dashboard reads it: the controller's told view of one agent
// (src/core/instructions.mjs toldView), the rules each set shows and its edits start from, edits that each return a new
// list, the words a page shows for a rule and for what a draft changes, finding a rule across every set, the page's own
// copy of the told view after a draft save or discard, and the director's draft, publish and discard, which go to the
// controller one after another. The controller writes a draft's rules as its document's text and owns every revision;
// only those three commands send anything.
import {
  notifyManager,
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import { send, toldUrl, type InstructionDoc, type Rule, type ToldLayer, type ToldView } from './api';
import { queryKeys } from './records';
import { useStreamReady } from './stream-context';

// The told view, or null for an agent the project does not hold, which the controller answers with 404; another
// refusal rejects with the controller's message.
async function readTold(url: string, signal?: AbortSignal): Promise<ToldView | null> {
  const response = await fetch(url, { signal });
  if (response.status === 404) return null;
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error || `The controller refused the request (${response.status}).`);
  return body as ToldView;
}

// The page's instruction commands, which go to the controller one after another in the order they were made.
const commandKey = (projectId: string) => [projectId, 'instruction-command'] as const;

// Under the project's instructions (records.ts), so a change to the organization's records reads it again; but not
// while one of the page's instruction commands is waiting, so a read cannot paint over a change the page already shows,
// and once none is.
export function useTold(projectId: string, workerId: string) {
  const ready = useStreamReady(),
    waiting = useIsMutating({ mutationKey: commandKey(projectId) }) > 0;
  return useQuery({
    enabled: ready && !waiting,
    queryKey: queryKeys.told(projectId, workerId),
    queryFn: ({ signal }) => readTold(toldUrl(projectId, workerId), signal),
  });
}

// The rules a set shows and its edits start from: its current draft's, else the published ones. A draft saved on an
// earlier revision can no longer be published, so nothing builds on it.
export const workingRules = (layer: ToldLayer): Rule[] => (layer.draft?.current ? layer.draft.rules : layer.rules);

// Edits to a set's rules, each answering a new list and never changing the one given; a place outside the list
// changes nothing.
export function addRule(rules: readonly Rule[], rule: Rule, at = rules.length): Rule[] {
  const place = Math.max(0, Math.min(at, rules.length));
  return [...rules.slice(0, place), rule, ...rules.slice(place)];
}
export const replaceRule = (rules: readonly Rule[], index: number, rule: Rule): Rule[] =>
  rules.map((item, at) => (at === index ? rule : item));
export const removeRule = (rules: readonly Rule[], index: number): Rule[] => rules.filter((_, at) => at !== index);
// Whether a rule can move one place up (-1) or down (1) within its set.
export const canMove = (rules: readonly Rule[], index: number, by: -1 | 1) =>
  index >= 0 && index < rules.length && index + by >= 0 && index + by < rules.length;
export function moveRule(rules: readonly Rule[], index: number, by: -1 | 1): Rule[] {
  const next = [...rules];
  if (canMove(rules, index, by)) [next[index], next[index + by]] = [next[index + by]!, next[index]!];
  return next;
}
// Gives a rule a name, or takes it away with an empty one.
export const nameRule = (rules: readonly Rule[], index: number, title: string): Rule[] =>
  rules.map((item, at) => (at === index ? { ...item, title: title.trim() || null } : item));

const labelWords = 8;
// What a rule is called: its name, else the first words of its text.
export function ruleLabel(rule: Rule) {
  if (rule.title) return rule.title;
  const words = rule.text.trim().split(/\s+/).filter(Boolean);
  return words.length > labelWords ? `${words.slice(0, labelWords).join(' ')}…` : words.join(' ');
}
// The first line of a rule's text, which a closed rule shows.
export const firstLine = (rule: Rule) => rule.text.trim().split('\n', 1)[0]!.trim();

// The rules of every set whose name or text holds each of the words, ignoring case, by set in the view's order, each
// with its place in the rules its set shows. A set with none is left out, so an empty answer means nothing matches;
// no words find every rule.
export interface FoundRules {
  layer: ToldLayer;
  rules: { index: number; rule: Rule }[];
}
export function findRules(layers: readonly ToldLayer[], words: string): FoundRules[] {
  const wanted = words.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return layers.flatMap(layer => {
    const rules = workingRules(layer).flatMap((rule, index) => {
      const said = `${rule.title ?? ''}\n${rule.text}`.toLocaleLowerCase();
      return wanted.every(word => said.includes(word)) ? [{ index, rule }] : [];
    });
    return rules.length ? [{ layer, rules }] : [];
  });
}

export interface RuleChanges {
  added: number;
  changed: number;
  moved: number;
  removed: number;
}
const same = (a: Rule, b: Rule) => a.title === b.title && a.text === b.text;
const take = (list: number[], item: number) => list.splice(list.indexOf(item), 1);

// What a draft's rules change from the published ones. The longest run of rules kept as they were, in order, stays in
// place; a rule kept as it was outside that run moved. Of the rest, a rule with the name of a published one, or else
// in the same place between the rules that stayed, changed it; any other draft rule was added, and any other
// published rule removed.
export function ruleChanges(published: readonly Rule[], draft: readonly Rule[]): RuleChanges {
  const n = published.length,
    m = draft.length,
    longest = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let p = n - 1; p >= 0; p--)
    for (let d = m - 1; d >= 0; d--)
      longest[p]![d] = same(published[p]!, draft[d]!)
        ? longest[p + 1]![d + 1]! + 1
        : Math.max(longest[p + 1]![d]!, longest[p]![d + 1]!);
  const stayedP: number[] = [],
    stayedD: number[] = [];
  for (let p = 0, d = 0; p < n && d < m; )
    if (same(published[p]!, draft[d]!)) {
      stayedP.push(p++);
      stayedD.push(d++);
    } else if (longest[p + 1]![d]! >= longest[p]![d + 1]!) p++;
    else d++;
  const restP = [...published.keys()].filter(p => !stayedP.includes(p)),
    restD = [...draft.keys()].filter(d => !stayedD.includes(d)),
    // How many rules that stayed come before a place: rules with the same count lie between the same ones.
    between = (stayed: number[], at: number) => stayed.filter(index => index < at).length;
  let moved = 0,
    changed = 0;
  const pair = (find: (d: number) => number | undefined, count: () => void) => {
    for (const d of [...restD]) {
      const p = find(d);
      if (p === undefined) continue;
      take(restP, p);
      take(restD, d);
      count();
    }
  };
  pair(
    d => restP.find(p => same(published[p]!, draft[d]!)),
    () => moved++,
  );
  pair(
    d => (draft[d]!.title ? restP.find(p => published[p]!.title === draft[d]!.title) : undefined),
    () => changed++,
  );
  pair(
    d => restP.find(p => between(stayedP, p) === between(stayedD, d)),
    () => changed++,
  );
  return { added: restD.length, changed, moved, removed: restP.length };
}

const setNames: Record<ToldLayer['layer'], string> = {
  'every-project': 'the rules every project shares',
  project: "the project's rules",
  team: "the team's rules",
  own: "the agent's own rules",
};
const numbers = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const count = (value: number) => numbers[value] ?? String(value);

// What a set's current draft changes, in words: "one rule added to the agent's own rules", "two rules changed and one
// removed in the team's rules". A set without a current draft has none to describe.
export function draftChange(layer: ToldLayer): string | null {
  if (!layer.draft?.current) return null;
  const changes = ruleChanges(layer.rules, layer.draft.rules),
    parts = (['added', 'changed', 'moved', 'removed'] as const).filter(kind => changes[kind] > 0),
    set = setNames[layer.layer];
  if (!parts.length) return `no rule changed in ${set}`;
  const said = parts.map((kind, index) =>
      index
        ? `${count(changes[kind])} ${kind}`
        : `${count(changes[kind])} rule${changes[kind] === 1 ? '' : 's'} ${kind}`,
    ),
    list = said.length > 1 ? `${said.slice(0, -1).join(', ')} and ${said.at(-1)}` : said[0],
    only = parts.length === 1 ? parts[0] : null;
  return `${list} ${only === 'added' ? 'to' : only === 'removed' ? 'from' : 'in'} ${set}`;
}

// The page's own copy of what the controller will answer after a draft save or discard, so a page can show it before
// the controller does. Each answers a new value and never changes the one given; none checks the rules, since the
// controller refuses what it cannot keep and the page then reads its answer.

// The draft's text the controller writes for rules it accepts (src/core/rules.mjs formatRules): a rule's name, trimmed
// and without its trailing full stops, in bold with a full stop unless it ends in ? or !, then its text, trimmed and
// with CRLF or CR as LF; a rule without a name is its text alone. One blank line between rules.
export const draftText = (rules: readonly Rule[]): string =>
  rules
    .map(rule => {
      const name = (rule.title ?? '').trim().replace(/\.+$/, '').trim(),
        body = rule.text.replace(/\r\n?/g, '\n').trim();
      if (!name) return body;
      return `**${name}${/[?!]$/.test(name) ? '' : '.'}**${body ? ` ${body}` : ''}`;
    })
    .join('\n\n');

const named = /^\*\*([^*\n]+)\*\*[ \t]*/;
// The rules a draft's text holds once saved (src/core/rules.mjs parseRules): one per paragraph, named by the bold
// words it opens with, without their full stops (null when none are left), and its text trimmed.
export const readRules = (text: string): Rule[] =>
  text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map(block => block.trim())
    .filter(Boolean)
    .map(block => {
      const match = named.exec(block);
      if (!match) return { title: null, text: block };
      return { title: match[1]!.trim().replace(/\.+$/, '').trim() || null, text: block.slice(match[0].length).trim() };
    });

// What the agent's next attempt receives (src/core/instructions.mjs toldView): each set under its heading
// (documentTitle), a set with a current draft as its next revision with the draft's text and every other one as
// published, so a draft saved on an earlier revision is left out; `drafts` counts the current drafts.
function receivesOf(layers: readonly ToldLayer[]): ToldView['receives'] {
  const section = (layer: ToldLayer, revision: number, text: string) =>
    `# ${layer.projectId ? 'Project ' : ''}${layer.scope}: ${layer.id} (revision ${revision})\n\n${text}`;
  return {
    text: layers
      .map(layer =>
        layer.draft?.current
          ? section(layer, layer.revision + 1, layer.draft.text)
          : section(layer, layer.revision, layer.text),
      )
      .join('\n\n'),
    drafts: layers.filter(layer => layer.draft?.current).length,
  };
}

// A told view with one set changed, found by which set it is: the shared set and the project's are both
// company/company, so never by its scope and id.
function withSet(view: ToldView, set: ToldLayer['layer'], change: (layer: ToldLayer) => ToldLayer): ToldView {
  const layers = view.layers.map(layer => (layer.layer === set ? change(layer) : layer));
  return { ...view, layers, receives: receivesOf(layers) };
}

// The told view once a set's draft is saved with these rules: a current draft on the set's revision, with its text as
// the controller writes it and its rules as it reads them back.
export function toldWithDraft(view: ToldView, set: ToldLayer['layer'], rules: readonly Rule[]): ToldView {
  const text = draftText(rules);
  return withSet(view, set, layer => ({
    ...layer,
    draft: {
      baseRevision: layer.revision,
      savedAt: layer.draft?.savedAt ?? null,
      current: true,
      text,
      rules: readRules(text),
    },
  }));
}

// The told view once a set's draft is discarded.
export const toldWithoutDraft = (view: ToldView, set: ToldLayer['layer']): ToldView =>
  withSet(view, set, layer => ({ ...layer, draft: null }));

// A set's instruction commands (src/server.mjs): its scope is the controller's, `employee` for the agent's own.
const commandUrl = (layer: ToldLayer, action: 'draft' | 'publish' | 'discard') =>
  `/api/instructions/${layer.scope}/${encodeURIComponent(layer.id)}/${action}`;

// A change made before a refusal was answered, which built on the refused change, so it is not sent.
class Dropped extends Error {}
// How many of a project's changes the controller has refused here, which each change records when it is made.
const refusals = new WeakMap<QueryClient, Map<string, number>>();
const refusedSoFar = (client: QueryClient, projectId: string) => refusals.get(client)?.get(projectId) ?? 0;
function countRefusal(client: QueryClient, projectId: string) {
  const projects = refusals.get(client) ?? new Map<string, number>();
  projects.set(projectId, refusedSoFar(client, projectId) + 1);
  refusals.set(client, projects);
}
// The drafts the page's copy put together, each with the text the controller answered it kept, once it has.
const keptAs = new WeakMap<NonNullable<ToldLayer['draft']>, string | null>();

interface Made<T> {
  input: T;
  after: number;
  refused?: (message: string) => void;
}
interface Copy {
  before: [QueryKey, ToldView][];
  drafts: NonNullable<ToldLayer['draft']>[];
}
// Every agent's told view of the project, under its instructions (records.ts).
const toldViews = (projectId: string) => [...queryKeys.instructions(projectId), 'told'];

// Each command names the revision the set shows, so a set published since is refused rather than overwritten, and
// waits for the page's commands made before it (one mutation scope per project). A command that changes the set
// changes it at once in each told view the page holds that has it, once any read of the instructions under way is
// cancelled; refused (with the controller's message on the Refusal it rejects with), it puts those views back as they
// were before it, which the controller then held, and the changes made after it are dropped. Once no command is
// waiting, the project's instructions are read again, what each agent is told among them.
function useRuleCommand<T>(
  projectId: string,
  command: (input: T) => Promise<InstructionDoc>,
  change?: { set: (input: T) => ToldLayer; view: (view: ToldView, input: T) => ToldView },
) {
  const client = useQueryClient();
  const { mutate, mutateAsync, isPending, error, reset } = useMutation({
    mutationKey: commandKey(projectId),
    scope: { id: commandKey(projectId).join('/') },
    onMutate: async ({ input }: Made<T>): Promise<Copy> => {
      if (!change) return { before: [], drafts: [] };
      await client.cancelQueries({ queryKey: queryKeys.instructions(projectId) });
      const set = change.set(input),
        held = (layer: ToldLayer) => layer.layer === set.layer && layer.scope === set.scope && layer.id === set.id,
        before = client
          .getQueriesData<ToldView>({ queryKey: toldViews(projectId) })
          .flatMap(([key, view]): [QueryKey, ToldView][] => (view?.layers.some(held) ? [[key, view]] : [])),
        drafts: Copy['drafts'] = [];
      for (const [key, view] of before) {
        // The draft as the cache keeps it, which shares what did not change with what it held.
        const draft = client.setQueryData<ToldView>(key, change.view(view, input))?.layers.find(held)?.draft;
        if (draft) drafts.push(draft);
      }
      for (const draft of drafts) keptAs.set(draft, null);
      return { before, drafts };
    },
    mutationFn: ({ input, after }: Made<T>) =>
      after === refusedSoFar(client, projectId) ? command(input) : Promise.reject(new Dropped()),
    onSuccess: (answer, _made, copy) => {
      for (const draft of copy.drafts) keptAs.set(draft, answer.draft?.text ?? null);
    },
    onError: (refusal, { refused }, copy) => {
      if (refusal instanceof Dropped) return;
      if (change) countRefusal(client, projectId);
      // The rules put back and the message show together.
      notifyManager.batch(() => {
        for (const [key, view] of copy?.before ?? []) client.setQueryData(key, view);
        if (refused) notifyManager.schedule(() => refused(refusal.message));
      });
    },
    onSettled: () =>
      client.invalidateQueries({
        queryKey: queryKeys.instructions(projectId),
        refetchType: client.isMutating({ mutationKey: commandKey(projectId) }) > 1 ? 'none' : 'active',
      }),
  });
  const made = (input: T, refused?: (message: string) => void): Made<T> => ({
    input,
    after: refusedSoFar(client, projectId),
    refused,
  });
  return {
    // Makes the change; `refused` hears the controller's message if it refuses it.
    run: (input: T, refused?: (message: string) => void) => mutate(made(input, refused)),
    // Makes the change and answers what the controller answers, or rejects with its refusal.
    mutateAsync: (input: T) => mutateAsync(made(input)),
    waiting: isPending,
    // The controller's refusal of the last command this part of the page made; a dropped one is none.
    refusal: error instanceof Dropped ? null : error,
    reset,
  };
}

// Saves a set's whole list of rules as its draft, as rules and never as text: the controller writes them as the
// document's text, and refuses rules it could not (src/core/rules.mjs formatRules). The page shows the draft at once.
export const useSaveRules = (projectId: string) =>
  useRuleCommand(
    projectId,
    ({ layer, rules }: { layer: ToldLayer; rules: readonly Rule[] }) =>
      send<InstructionDoc>(commandUrl(layer, 'draft'), {
        projectId,
        baseRevision: layer.revision,
        rules: rules.map(({ title, text }) => ({ title, text })),
      }),
    { set: ({ layer }) => layer, view: (view, { layer, rules }) => toldWithDraft(view, layer.layer, rules) },
  );

// Publishes a set's draft as its next revision, once the commands before it are answered, and shows only when the
// controller has. It sends the draft's exact text as the controller holds it, which the controller checks is the
// draft it saved: the text it read, or for a draft the page put together, the text the controller answered it kept,
// and never the page's own.
export const usePublishRules = (projectId: string) =>
  useRuleCommand(projectId, async (layer: ToldLayer) => {
    if (!layer.draft) throw new Error('This set has no draft to publish.');
    const text = keptAs.has(layer.draft) ? keptAs.get(layer.draft) : layer.draft.text;
    if (text == null)
      throw new Error('The controller did not say which draft it kept. Open the page again to publish.');
    return send<InstructionDoc>(commandUrl(layer, 'publish'), { projectId, baseRevision: layer.revision, text });
  });

// Discards a set's draft; the page drops it at once.
export const useDiscardRules = (projectId: string) =>
  useRuleCommand(
    projectId,
    (layer: ToldLayer) =>
      send<InstructionDoc>(commandUrl(layer, 'discard'), { projectId, baseRevision: layer.revision }),
    { set: layer => layer, view: (view, layer) => toldWithoutDraft(view, layer.layer) },
  );

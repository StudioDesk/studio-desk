// What an agent is told, as rules (1.2 step 1), as the dashboard reads it: the controller's told view of one agent
// (src/core/instructions.mjs toldView), the rules each set shows and its edits start from, edits that each return a new
// list, the words a page shows for a rule and for what a draft changes, finding a rule across every set, and the
// director's draft, publish and discard. The controller writes a draft's rules as its document's text and owns every
// revision; only those three commands send anything.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

// Under the project's instructions (records.ts), so a change to the organization's records reads it again.
export function useTold(projectId: string, workerId: string) {
  return useQuery({
    enabled: useStreamReady(),
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

// A set's instruction commands (src/server.mjs): its scope is the controller's, `employee` for the agent's own.
const commandUrl = (layer: ToldLayer, action: 'draft' | 'publish' | 'discard') =>
  `/api/instructions/${layer.scope}/${encodeURIComponent(layer.id)}/${action}`;

// Each command names the revision the set shows, so a set published since is refused rather than overwritten; saved or
// refused (with the controller's message on the Refusal it rejects with), the project's instructions are read again,
// what each agent is told among them.
function useRuleCommand<T>(projectId: string, command: (input: T) => Promise<InstructionDoc>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: command,
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.instructions(projectId) }),
  });
}

// Saves a set's whole list of rules as its draft, as rules and never as text: the controller writes them as the
// document's text, and refuses rules it could not (src/core/rules.mjs formatRules).
export const useSaveRules = (projectId: string) =>
  useRuleCommand(projectId, ({ layer, rules }: { layer: ToldLayer; rules: readonly Rule[] }) =>
    send<InstructionDoc>(commandUrl(layer, 'draft'), {
      projectId,
      baseRevision: layer.revision,
      rules: rules.map(({ title, text }) => ({ title, text })),
    }),
  );

// Publishes a set's draft as its next revision, sending the draft's exact text, which the controller checks is the
// draft it saved.
export const usePublishRules = (projectId: string) =>
  useRuleCommand(projectId, async (layer: ToldLayer) => {
    if (!layer.draft) throw new Error('This set has no draft to publish.');
    return send<InstructionDoc>(commandUrl(layer, 'publish'), {
      projectId,
      baseRevision: layer.revision,
      text: layer.draft.text,
    });
  });

export const useDiscardRules = (projectId: string) =>
  useRuleCommand(projectId, (layer: ToldLayer) =>
    send<InstructionDoc>(commandUrl(layer, 'discard'), { projectId, baseRevision: layer.revision }),
  );

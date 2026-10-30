// What an agent is told (1.2 step 1), on its own page under Agents and the agent: Rules, the sets it reads in the
// order its attempts read them, each rule numbered and opened to read in full, with Find a rule across every set; and
// What it receives, exactly the text the controller starts its next attempt with. Which of the two shows is in the
// address. Each set the project can change keeps its edits as its draft, its whole list of rules at a time, and a bar
// above both views publishes or discards each set's draft. An edit or a discard shows at once and goes to the
// controller behind the page, one after another; the controller owns every revision and refuses, with its message,
// what it cannot keep, which the page then puts back.
import { Link } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { Rule, ToldLayer, ToldView } from './api';
import { plural } from './evidence';
import { Heading } from './layout';
import { useStudio } from './records';
import {
  addRule,
  canMove,
  draftChange,
  findRules,
  firstLine,
  moveRule,
  nameRule,
  removeRule,
  replaceRule,
  ruleLabel,
  useDiscardRules,
  usePublishRules,
  useSaveRules,
  useTold,
  workingRules,
  type FoundRules,
} from './rules';
import type { StudioState } from './studio-runs';

export type ToldTab = 'rules' | 'receives';
const tabs: { id: ToldTab; label: string }[] = [
  { id: 'rules', label: 'Rules' },
  { id: 'receives', label: 'What it receives' },
];

export function ToldPage({
  projectId,
  workerId,
  view,
  onView,
}: {
  projectId: string;
  workerId: string;
  view: ToldTab;
  onView: (view: ToldTab) => void;
}) {
  const { state, error: stateError } = useStudio(projectId),
    { data, error } = useTold(projectId, workerId),
    agents = (
      <Link key="agents" to="/p/$projectId/agents" params={{ projectId }}>
        Agents
      </Link>
    );
  // The controller answers an agent it does not know as not found (null); until it answers, the page waits.
  if (error || stateError || data === undefined || !state || data === null)
    return (
      <div className="sd-orgpage">
        <Heading crumbs={[agents]} here="What it's told" title="What it's told" />
        {error || stateError ? (
          <p role="alert">What this agent is told could not be loaded: {(error ?? stateError)!.message}</p>
        ) : data === null ? (
          <p role="status" className="sd-meta">
            This agent is not in the project.
          </p>
        ) : (
          <p role="status" className="sd-meta">
            Reading what it is told…
          </p>
        )}
      </div>
    );
  const { name, role, team } = data.agent;
  const choose = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex(item => item.id === view),
      next =
        event.key === 'ArrowRight'
          ? tabs[(index + 1) % tabs.length]
          : event.key === 'ArrowLeft'
            ? tabs[(index - 1 + tabs.length) % tabs.length]
            : null;
    if (!next) return;
    event.preventDefault();
    onView(next.id);
    document.getElementById(`told-tab-${next.id}`)?.focus();
  };
  return (
    <div className="sd-orgpage">
      <Heading
        crumbs={[
          agents,
          <Link key="agent" to="/p/$projectId/agents/$workerId" params={{ projectId, workerId }}>
            {name}
          </Link>,
        ]}
        here="What it's told"
        title={`What ${name} is told`}
        lead={`${role ? `${role} in ${team}. ` : ''}The rules ${name} reads, in the order its attempts read them, and the exact text they start its next attempt with.`}
      />
      <Drafts projectId={projectId} told={data} />
      <div className="sd-card">
        <div className="sd-tabs" role="tablist" aria-label="What it's told" onKeyDown={choose}>
          {tabs.map(item => (
            <button
              key={item.id}
              id={`told-tab-${item.id}`}
              type="button"
              role="tab"
              className="sd-tabs__tab"
              aria-selected={item.id === view}
              aria-controls="told-panel"
              tabIndex={item.id === view ? 0 : -1}
              onClick={() => onView(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div id="told-panel" role="tabpanel" className="sd-tabpanel" aria-labelledby={`told-tab-${view}`}>
          {view === 'receives' ? <Receives told={data} /> : <Rules projectId={projectId} told={data} state={state} />}
        </div>
      </div>
    </div>
  );
}

// While a set the project can change has a current draft: what each set's draft changes, with its own Publish and
// Discard. Discard the draft drops the draft from the page at once, and a refusal brings its row back with the
// controller's message, kept here since the row goes; Publish shows once the controller answers. Either reads what
// the agent is told again once no change is waiting, so What it receives takes in the published rules or drops the
// draft.
function Drafts({ projectId, told }: { projectId: string; told: ToldView }) {
  const discard = useDiscardRules(projectId),
    [refused, setRefused] = useState<Partial<Record<ToldLayer['layer'], string>>>({}),
    say = (set: ToldLayer['layer'], message?: string) => setRefused(all => ({ ...all, [set]: message }));
  const drafted = told.layers.filter(layer => layer.editable && layer.draft?.current);
  if (!drafted.length) return null;
  return (
    <section className="sd-draft" aria-labelledby="told-drafts">
      <span id="told-drafts" className="sd-eyebrow">
        Drafts not published yet
      </span>
      <ul
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-10)',
        }}
      >
        {drafted.map(layer => (
          <DraftRow
            key={layer.layer}
            projectId={projectId}
            layer={layer}
            refused={refused[layer.layer]}
            onPublish={() => say(layer.layer)}
            onDiscard={() => {
              say(layer.layer);
              discard.run(layer, message => say(layer.layer, message));
            }}
          />
        ))}
      </ul>
    </section>
  );
}

const sentence = (words: string) => `${words.charAt(0).toLocaleUpperCase()}${words.slice(1)}.`;
const refusalStyle = { margin: 0, color: 'var(--bad)' };

// One set's draft: what it changes, then its next revision to publish, which sends the draft's exact text as the
// controller holds it once the changes before it are answered, or the draft to discard. A refusal shows the
// controller's message beside them; while Publish waits, neither can be pressed again.
function DraftRow({
  projectId,
  layer,
  refused,
  onPublish,
  onDiscard,
}: {
  projectId: string;
  layer: ToldLayer;
  refused?: string;
  onPublish: () => void;
  onDiscard: () => void;
}) {
  const publish = usePublishRules(projectId),
    busy = publish.waiting,
    message = publish.refusal?.message ?? refused,
    id = `told-draft-${layer.layer}`;
  return (
    <li style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-8)' }}>
      <span id={id} style={{ flex: '1 1 16rem' }}>
        {sentence(draftChange(layer)!)}
      </span>
      <button
        type="button"
        className="sd-btn sd-btn--sm sd-btn--primary"
        aria-describedby={id}
        disabled={busy}
        onClick={() => {
          onPublish();
          publish.run(layer);
        }}
      >
        Publish revision {layer.revision + 1}
      </button>
      <button
        type="button"
        className="sd-btn sd-btn--sm sd-btn--ghost"
        aria-describedby={id}
        disabled={busy}
        onClick={() => {
          publish.reset();
          onDiscard();
        }}
      >
        Discard the draft
      </button>
      {message && (
        <p role="alert" className="sd-meta" style={{ ...refusalStyle, flexBasis: '100%' }}>
          {message}
        </p>
      )}
    </li>
  );
}

const names = (list: string[]) =>
  list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : (list[0] ?? 'no agent yet');

// Each set as the agent reads it, its readers by the names the project shows. With words to find, only the sets and
// rules findRules matches show, each rule keeping its number in its set.
function Rules({ projectId, told, state }: { projectId: string; told: ToldView; state: StudioState }) {
  const [words, setWords] = useState(''),
    searching = words.trim() !== '',
    found = useMemo(() => (searching ? findRules(told.layers, words) : null), [searching, told.layers, words]),
    shown: FoundRules[] =
      found ??
      told.layers.map(layer => ({ layer, rules: workingRules(layer).map((rule, index) => ({ index, rule })) }));
  const nameOf = (id: string) => state.workers.find(worker => worker.id === id)?.displayName ?? id,
    titles: Record<ToldLayer['layer'], string> = {
      'every-project': 'The rules every project shares',
      project: "This project's rules",
      team: `The ${told.agent.team} team's rules`,
      own: `${told.agent.name}'s own rules`,
    };
  return (
    <>
      <p className="sd-meta" role="note" style={{ margin: 0 }}>
        Changing a shared rule changes it for everyone who reads it.
      </p>
      <div className="sd-field">
        <label className="sd-field__label" htmlFor="told-find">
          Find a rule
        </label>
        <input
          id="told-find"
          type="search"
          className="sd-input"
          placeholder="A word from its name or what it says"
          value={words}
          onChange={event => setWords(event.target.value)}
        />
      </div>
      {found && !found.length && (
        <p role="status" className="sd-meta" style={{ margin: 0 }}>
          No rule matches “{words.trim()}”.
        </p>
      )}
      {shown.map(({ layer, rules }) => (
        <RuleSet
          key={layer.layer}
          projectId={projectId}
          layer={layer}
          title={titles[layer.layer]}
          readers={layer.readers ? names(layer.readers.map(nameOf)) : 'every project'}
          rules={rules}
        />
      ))}
    </>
  );
}

// What is typed in a rule's form: its name and what the agent should do, as typed.
interface Typed {
  title: string;
  text: string;
}
// An opened rule's row: the form it shows, if any, and for a form the controller refused, what was typed in it and
// the controller's message.
interface Row {
  form: 'edit' | 'name' | null;
  typed?: Typed;
  refused?: string;
}
const ruleOf = (typed: Typed): Rule => ({ title: typed.title.trim() || null, text: typed.text.trim() });

// A set's head: its rules (its current draft's, when it has one), its revision and readers, read-only where the
// project cannot change it and a Draft mark for a current draft; then its rules, and Add a rule where it can change.
// Each change keeps the set's whole list, so changed, as its draft: the page shows it at once, and a refusal puts the
// rules back with the controller's message, beside the set for a move or a removal, with the rule's row open again,
// and in the form, open again with what was typed, for Edit, Give it a name and Add a rule.
function RuleSet({
  projectId,
  layer,
  title,
  readers,
  rules,
}: {
  projectId: string;
  layer: ToldLayer;
  title: string;
  readers: string;
  rules: FoundRules['rules'];
}) {
  const id = `told-set-${layer.layer}`,
    working = workingRules(layer),
    count = working.length,
    save = useSaveRules(projectId),
    // Which rows are open and what each shows, by the row's key, and the Add a rule form, here rather than in the rows,
    // since an edited rule's row is a new one and a refusal brings back the row as it was.
    [opened, setOpened] = useState<Record<string, Row>>({}),
    [adding, setAdding] = useState<(Typed & { refused?: string }) | null>(null),
    [refused, setRefused] = useState<string | null>(null);
  // A rule's row follows the rule by its name and text (and which of the same it is), so a moved rule stays open in
  // its new place and an edited one closes on what it says now.
  const seen = new Map<string, number>(),
    keys = working.map(rule => {
      const said = `${rule.title ?? ''}\n${rule.text}`,
        before = seen.get(said) ?? 0;
      seen.set(said, before + 1);
      return `${before}:${said}`;
    });
  const setRow = (key: string, row: Row | null) =>
      setOpened(all => {
        const next = { ...all };
        if (row) next[key] = row;
        else delete next[key];
        return next;
      }),
    keep = (next: Rule[], onRefused: (message: string) => void) => {
      setRefused(null);
      save.run({ layer, rules: next }, onRefused);
    },
    beside = (key: string) => (message: string) => {
      setRefused(message);
      setRow(key, { form: null });
    },
    edits = (key: string, index: number): RuleEdits => ({
      id: `told-${layer.layer}-rule-${index}`,
      rules: working,
      index,
      move: by => keep(moveRule(working, index, by), beside(key)),
      remove: () => {
        setRow(key, null);
        keep(removeRule(working, index), beside(key));
      },
      kept: (form, typed) => {
        setRow(key, null);
        keep(
          form === 'name' ? nameRule(working, index, typed.title) : replaceRule(working, index, ruleOf(typed)),
          message => setRow(key, { form, typed, refused: message }),
        );
      },
    }),
    add = (typed: Typed) => {
      setAdding(null);
      keep(addRule(working, ruleOf(typed)), message => setAdding({ ...typed, refused: message }));
    };
  return (
    <section aria-labelledby={id} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <h2 id={id} className="sd-tabpanel__title">
        {title}
      </h2>
      <div className="sd-cardlist__meta">
        <span className="sd-meta">
          {count} {plural(count, 'rule')} · revision {layer.revision} · read by {readers}
        </span>
        {!layer.editable && <span className="sd-chip sd-chip--shared">Read-only here</span>}
        {layer.draft?.current && <span className="sd-chip sd-chip--dash">Draft</span>}
      </div>
      {refused && (
        <p role="alert" className="sd-meta" style={refusalStyle}>
          {refused}
        </p>
      )}
      {rules.length > 0 ? (
        <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {rules.map(({ index, rule }) => {
            const key = keys[index] ?? String(index);
            return (
              <RuleRow
                key={key}
                number={index + 1}
                rule={rule}
                row={opened[key]}
                onRow={row => setRow(key, row)}
                edit={layer.editable ? edits(key, index) : undefined}
              />
            );
          })}
        </ol>
      ) : (
        <p className="sd-meta" style={{ margin: 0 }}>
          No rules yet.
        </p>
      )}
      {layer.editable &&
        (adding ? (
          <RuleForm
            id={`${id}-new`}
            label="Add a rule"
            typed={adding}
            refused={adding.refused}
            onKeep={add}
            onCancel={() => setAdding(null)}
          />
        ) : (
          <button
            type="button"
            className="sd-btn sd-btn--sm"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => setAdding({ title: '', text: '' })}
          >
            Add a rule
          </button>
        ))}
    </section>
  );
}

// What an opened rule in a set the project can change does: its form's id, its place among the set's rules, Move and
// Remove the rule, and keeping what its Edit or Give it a name form says.
interface RuleEdits {
  id: string;
  rules: Rule[];
  index: number;
  move: (by: -1 | 1) => void;
  remove: () => void;
  kept: (form: 'edit' | 'name', typed: Typed) => void;
}
const inset = { padding: '0 0 var(--space-12) calc(3ch + var(--space-12))' };

// A rule shows its number, its name (else its first words) and its first line until it is opened, then all of it. An
// opened rule in a set the project can change also has its changes, and Edit or Give it a name opens its form in place.
// Whether it is open and what it shows is its set's (`row`).
function RuleRow({
  number,
  rule,
  row,
  onRow,
  edit,
}: {
  number: number;
  rule: Rule;
  row?: Row;
  onRow: (row: Row | null) => void;
  edit?: RuleEdits;
}) {
  const open = row !== undefined,
    form = row?.form ?? null;
  return (
    <li>
      <button type="button" className="sd-row" aria-expanded={open} onClick={() => onRow(open ? null : { form: null })}>
        <span className="sd-meta" style={{ flex: 'none', minWidth: '3ch', fontWeight: 700 }}>
          {number}.
        </span>{' '}
        <span style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', minWidth: 0 }}>
          <b>{ruleLabel(rule)}</b> {!open && <span className="sd-meta">{firstLine(rule)}</span>}
        </span>
      </button>
      {open && form !== 'edit' && (
        <p className="sd-draft__text" style={inset} aria-label={`Rule ${number} in full`}>
          {rule.text}
        </p>
      )}
      {open && edit && (
        <div style={inset}>
          {form ? (
            <RuleForm
              id={edit.id}
              label={form === 'name' ? `Give rule ${number} a name` : `Edit rule ${number}`}
              typed={row?.typed ?? { title: rule.title ?? '', text: rule.text }}
              naming={form === 'name'}
              refused={row?.refused}
              onKeep={typed => edit.kept(form, typed)}
              onCancel={() => onRow({ form: null })}
            />
          ) : (
            <RuleChanges number={number} rule={rule} edit={edit} onForm={next => onRow({ form: next })} />
          )}
        </div>
      )}
    </li>
  );
}

// An opened rule's changes. Edit and Give it a name (for a rule without one, from an older revision) open its form;
// Move up and Move down, where it can move within its set, and Remove the rule keep the set's whole list, so changed,
// as its draft at once, while any change before them is still on its way.
function RuleChanges({
  number,
  rule,
  edit: { rules, index, move, remove },
  onForm,
}: {
  number: number;
  rule: Rule;
  edit: RuleEdits;
  onForm: (form: 'edit' | 'name') => void;
}) {
  return (
    <div
      role="group"
      aria-label={`Change rule ${number}`}
      style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-8)' }}
    >
      <button type="button" className="sd-btn sd-btn--sm" onClick={() => onForm('edit')}>
        Edit
      </button>
      {!rule.title && (
        <button type="button" className="sd-btn sd-btn--sm" onClick={() => onForm('name')}>
          Give it a name
        </button>
      )}
      {canMove(rules, index, -1) && (
        <button type="button" className="sd-btn sd-btn--sm" onClick={() => move(-1)}>
          Move up
        </button>
      )}
      {canMove(rules, index, 1) && (
        <button type="button" className="sd-btn sd-btn--sm" onClick={() => move(1)}>
          Move down
        </button>
      )}
      <button type="button" className="sd-btn sd-btn--sm sd-btn--ghost" onClick={remove}>
        Remove the rule
      </button>
    </div>
  );
}

// Edit and Add a rule open this in place, with the rule's name and what the agent should do; Give it a name asks only
// for the name. Keep in the draft closes it and keeps the set's whole list with the change, made to the rules the set
// shows when it is kept; a refusal opens it again with what was typed and the controller's message. Cancel sends
// nothing.
function RuleForm({
  id,
  label,
  typed,
  naming = false,
  refused,
  onKeep,
  onCancel,
}: {
  id: string;
  label: string;
  typed: Typed;
  naming?: boolean;
  refused?: string;
  onKeep: (typed: Typed) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(typed.title),
    [text, setText] = useState(typed.text),
    first = useRef<HTMLInputElement>(null),
    empty = naming ? !title.trim() : !title.trim() && !text.trim();
  useEffect(() => first.current?.focus(), []);
  const keep = (event: FormEvent) => {
    event.preventDefault();
    onKeep({ title, text });
  };
  return (
    <form className="sd-editpanel" aria-label={label} onSubmit={keep}>
      <div className="sd-field">
        <label className="sd-field__label" htmlFor={`${id}-name`}>
          Name
        </label>
        <input
          ref={first}
          id={`${id}-name`}
          className="sd-input"
          value={title}
          autoComplete="off"
          onChange={event => setTitle(event.target.value)}
        />
      </div>
      {!naming && (
        <div className="sd-field">
          <label className="sd-field__label" htmlFor={`${id}-text`}>
            What the agent should do
          </label>
          <textarea
            id={`${id}-text`}
            className="sd-textarea"
            value={text}
            onChange={event => setText(event.target.value)}
          />
        </div>
      )}
      {refused && (
        <p role="alert" className="sd-meta" style={refusalStyle}>
          {refused}
        </p>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-8)' }}>
        <button type="submit" className="sd-btn sd-btn--sm sd-btn--primary" disabled={empty}>
          Keep in the draft
        </button>
        <button type="button" className="sd-btn sd-btn--sm sd-btn--ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// Exactly what the controller sends: its text as it comes, never read as markdown, with how many drafts it puts in
// place of their published text.
function Receives({ told }: { told: ToldView }) {
  const { name } = told.agent,
    { text, drafts } = told.receives;
  return (
    <>
      <p className="sd-meta" style={{ margin: 0 }}>
        The text the controller starts {name}'s next attempt with, exactly as it sends it.{' '}
        {drafts
          ? `It includes ${drafts === 1 ? 'one draft' : `${drafts} drafts`}, as ${drafts === 1 ? 'it' : 'they'} would read once published; until then, attempts read the published rules.`
          : 'It includes no drafts: this is the published text.'}
      </p>
      <pre className="sd-code sd-code--block" aria-label={`What ${name} receives`}>
        {text}
      </pre>
      <p className="sd-meta" role="note" style={{ margin: 0 }}>
        Each attempt keeps the revision it ran with, so a change reaches only the attempts that start after it is
        published.
      </p>
    </>
  );
}

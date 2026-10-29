// What an agent is told (1.2 step 1), on its own page under Agents and the agent: Rules, the sets it reads in the
// order its attempts read them, each rule numbered and opened to read in full, with Find a rule across every set; and
// What it receives, exactly the text the controller starts its next attempt with. Which of the two shows is in the
// address. Each set the project can change keeps its edits as its draft, its whole list of rules at a time, and a bar
// above both views publishes or discards each set's draft. The controller owns every revision and refuses, with its
// message, what it cannot keep.
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
// Discard. Either reads what the agent is told again, so What it receives takes in the published rules or drops the
// draft.
function Drafts({ projectId, told }: { projectId: string; told: ToldView }) {
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
          <DraftRow key={layer.layer} projectId={projectId} layer={layer} />
        ))}
      </ul>
    </section>
  );
}

const sentence = (words: string) => `${words.charAt(0).toLocaleUpperCase()}${words.slice(1)}.`;
const refusalStyle = { margin: 0, color: 'var(--bad)' };

// One set's draft: what it changes, then its next revision to publish, which sends the draft's exact text, or the
// draft to discard. A refusal shows the controller's message beside them.
function DraftRow({ projectId, layer }: { projectId: string; layer: ToldLayer }) {
  const publish = usePublishRules(projectId),
    discard = useDiscardRules(projectId),
    busy = publish.isPending || discard.isPending,
    refused = publish.error ?? discard.error,
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
          discard.reset();
          publish.mutate(layer);
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
          discard.mutate(layer);
        }}
      >
        Discard the draft
      </button>
      {refused && (
        <p role="alert" className="sd-meta" style={{ ...refusalStyle, flexBasis: '100%' }}>
          {refused.message}
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

// A set's head: its rules (its current draft's, when it has one), its revision and readers, read-only where the
// project cannot change it and a Draft mark for a current draft; then its rules, and Add a rule where it can change.
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
    [adding, setAdding] = useState(false);
  // A rule's row follows the rule by its name and text (and which of the same it is), so a moved rule stays open in
  // its new place and an edited one closes on what it says now.
  const seen = new Map<string, number>(),
    keys = working.map(rule => {
      const said = `${rule.title ?? ''}\n${rule.text}`,
        before = seen.get(said) ?? 0;
      seen.set(said, before + 1);
      return `${before}:${said}`;
    });
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
      {rules.length > 0 ? (
        <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {rules.map(({ index, rule }) => (
            <RuleRow
              key={keys[index]}
              number={index + 1}
              rule={rule}
              edit={layer.editable ? { projectId, layer, index } : undefined}
            />
          ))}
        </ol>
      ) : (
        <p className="sd-meta" style={{ margin: 0 }}>
          No rules yet.
        </p>
      )}
      {layer.editable &&
        (adding ? (
          <RuleForm
            projectId={projectId}
            layer={layer}
            id={`${id}-new`}
            label="Add a rule"
            rule={{ title: null, text: '' }}
            change={(list, rule) => addRule(list, rule)}
            onClose={() => setAdding(false)}
          />
        ) : (
          <button
            type="button"
            className="sd-btn sd-btn--sm"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => setAdding(true)}
          >
            Add a rule
          </button>
        ))}
    </section>
  );
}

// Where a rule sits in a set the project can change.
interface RuleEdit {
  projectId: string;
  layer: ToldLayer;
  index: number;
}
const inset = { padding: '0 0 var(--space-12) calc(3ch + var(--space-12))' };

// A rule shows its number, its name (else its first words) and its first line until it is opened, then all of it. An
// opened rule in a set the project can change also has its changes, and Edit or Give it a name opens its form in place.
function RuleRow({ number, rule, edit }: { number: number; rule: Rule; edit?: RuleEdit }) {
  const [open, setOpen] = useState(false),
    [form, setForm] = useState<'edit' | 'name' | null>(null);
  return (
    <li>
      <button
        type="button"
        className="sd-row"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          setForm(null);
        }}
      >
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
              projectId={edit.projectId}
              layer={edit.layer}
              id={`told-${edit.layer.layer}-rule-${edit.index}`}
              label={form === 'name' ? `Give rule ${number} a name` : `Edit rule ${number}`}
              rule={rule}
              naming={form === 'name'}
              change={(list, changed) =>
                form === 'name'
                  ? nameRule(list, edit.index, changed.title ?? '')
                  : replaceRule(list, edit.index, changed)
              }
              onClose={() => setForm(null)}
            />
          ) : (
            <RuleChanges number={number} rule={rule} edit={edit} onForm={setForm} />
          )}
        </div>
      )}
    </li>
  );
}

// An opened rule's changes. Edit and Give it a name (for a rule without one, from an older revision) open its form;
// Move up and Move down, where it can move within its set, and Remove the rule keep the set's whole list, so changed,
// as its draft at once.
function RuleChanges({
  number,
  rule,
  edit: { projectId, layer, index },
  onForm,
}: {
  number: number;
  rule: Rule;
  edit: RuleEdit;
  onForm: (form: 'edit' | 'name') => void;
}) {
  const save = useSaveRules(projectId),
    rules = workingRules(layer),
    busy = save.isPending,
    keep = (next: Rule[]) => save.mutate({ layer, rules: next });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-8)' }}>
      <div
        role="group"
        aria-label={`Change rule ${number}`}
        style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-8)' }}
      >
        <button type="button" className="sd-btn sd-btn--sm" disabled={busy} onClick={() => onForm('edit')}>
          Edit
        </button>
        {!rule.title && (
          <button type="button" className="sd-btn sd-btn--sm" disabled={busy} onClick={() => onForm('name')}>
            Give it a name
          </button>
        )}
        {canMove(rules, index, -1) && (
          <button
            type="button"
            className="sd-btn sd-btn--sm"
            disabled={busy}
            onClick={() => keep(moveRule(rules, index, -1))}
          >
            Move up
          </button>
        )}
        {canMove(rules, index, 1) && (
          <button
            type="button"
            className="sd-btn sd-btn--sm"
            disabled={busy}
            onClick={() => keep(moveRule(rules, index, 1))}
          >
            Move down
          </button>
        )}
        <button
          type="button"
          className="sd-btn sd-btn--sm sd-btn--ghost"
          disabled={busy}
          onClick={() => keep(removeRule(rules, index))}
        >
          Remove the rule
        </button>
      </div>
      {save.error && (
        <p role="alert" className="sd-meta" style={refusalStyle}>
          {save.error.message}
        </p>
      )}
    </div>
  );
}

// Edit and Add a rule open this in place, with the rule's name and what the agent should do; Give it a name asks only
// for the name. Keep in the draft saves the set's whole list with the change, made to the rules the set shows when it
// is kept; a refusal keeps the form and its text, with the controller's message. Cancel sends nothing.
function RuleForm({
  projectId,
  layer,
  id,
  label,
  rule,
  naming = false,
  change,
  onClose,
}: {
  projectId: string;
  layer: ToldLayer;
  id: string;
  label: string;
  rule: Rule;
  naming?: boolean;
  change: (rules: Rule[], rule: Rule) => Rule[];
  onClose: () => void;
}) {
  const save = useSaveRules(projectId),
    [title, setTitle] = useState(rule.title ?? ''),
    [text, setText] = useState(rule.text),
    first = useRef<HTMLInputElement>(null),
    busy = save.isPending,
    empty = naming ? !title.trim() : !title.trim() && !text.trim();
  useEffect(() => first.current?.focus(), []);
  const keep = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(
      { layer, rules: change(workingRules(layer), { title: title.trim() || null, text: text.trim() }) },
      { onSuccess: onClose },
    );
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
          disabled={busy}
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
            disabled={busy}
            onChange={event => setText(event.target.value)}
          />
        </div>
      )}
      {save.error && (
        <p role="alert" className="sd-meta" style={refusalStyle}>
          {save.error.message}
        </p>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-8)' }}>
        <button type="submit" className="sd-btn sd-btn--sm sd-btn--primary" disabled={busy || empty}>
          Keep in the draft
        </button>
        <button type="button" className="sd-btn sd-btn--sm sd-btn--ghost" disabled={busy} onClick={onClose}>
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

// What an agent is told (1.2 step 1), on its own page under Agents and the agent: Rules, the sets it reads in the
// order its attempts read them, each rule numbered and opened to read in full, with Find a rule across every set; and
// What it receives, exactly the text the controller starts its next attempt with. Which of the two shows is in the
// address. Read-only here: the controller owns every revision, and nothing on this page sends a command.
import { Link } from '@tanstack/react-router';
import { useMemo, useState, type KeyboardEvent } from 'react';
import type { Rule, ToldLayer, ToldView } from './api';
import { plural } from './evidence';
import { Heading } from './layout';
import { useStudio } from './records';
import { findRules, firstLine, ruleLabel, useTold, workingRules, type FoundRules } from './rules';
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
          {view === 'receives' ? <Receives told={data} /> : <Rules told={data} state={state} />}
        </div>
      </div>
    </div>
  );
}

const names = (list: string[]) =>
  list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : (list[0] ?? 'no agent yet');

// Each set as the agent reads it, its readers by the names the project shows. With words to find, only the sets and
// rules findRules matches show, each rule keeping its number in its set.
function Rules({ told, state }: { told: ToldView; state: StudioState }) {
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
// project cannot change it and a Draft mark for a current draft; then its rules.
function RuleSet({
  layer,
  title,
  readers,
  rules,
}: {
  layer: ToldLayer;
  title: string;
  readers: string;
  rules: FoundRules['rules'];
}) {
  const id = `told-set-${layer.layer}`,
    count = workingRules(layer).length;
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
            <RuleRow key={index} number={index + 1} rule={rule} />
          ))}
        </ol>
      ) : (
        <p className="sd-meta" style={{ margin: 0 }}>
          No rules yet.
        </p>
      )}
    </section>
  );
}

// A rule shows its number, its name (else its first words) and its first line until it is opened, then all of it.
function RuleRow({ number, rule }: { number: number; rule: Rule }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button type="button" className="sd-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="sd-meta" style={{ flex: 'none', minWidth: '3ch', fontWeight: 700 }}>
          {number}.
        </span>{' '}
        <span style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', minWidth: 0 }}>
          <b>{ruleLabel(rule)}</b> {!open && <span className="sd-meta">{firstLine(rule)}</span>}
        </span>
      </button>
      {open && (
        <p
          className="sd-draft__text"
          style={{ padding: '0 0 var(--space-12) calc(3ch + var(--space-12))' }}
          aria-label={`Rule ${number} in full`}
        >
          {rule.text}
        </p>
      )}
    </li>
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

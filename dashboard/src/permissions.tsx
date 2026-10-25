// What Claude Code employees may run beyond editing their job folder (v1.0 item 22): the approved commands and
// whether auto mode is the default, in Settings; a task's own auto mode; and approving the commands an employee
// stopped for. The controller checks every rule again (src/core/agent-permissions.mjs).
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { send, type Shell, type Task } from './api';
import type { Explanation, StudioState } from './studio-runs';
import { Icon } from './design/icons';
import { useToast } from './toast';

const maxCommands = 50;
const word = /^[A-Za-z0-9._/:=@+-]+$/;

export const autoRisk =
  "Claude Code's own classifier, not the controller, then decides which commands its agents run, and on Windows they run with your account's rights, with no sandbox.";

// An approved command is a prefix of plain words: no shell operators, quotes, variables or wildcards.
export function commandProblem(value: string) {
  const words = value.trim().split(/\s+/),
    text = words.join(' ');
  return !text || text.length > 200 || text.startsWith('-') || !words.every(item => word.test(item))
    ? 'Use 1 to 200 characters of letters, digits, spaces and . _ / : = @ + -, not starting with -.'
    : null;
}

// A refused command's longest start that can be a rule, for the director to approve or shorten.
export const ruleFrom = (command: string) => {
  const words: string[] = [];
  for (const item of command.trim().split(/\s+/)) {
    if (!word.test(item) || [...words, item].join(' ').length > 200) break;
    words.push(item);
  }
  return words[0]?.startsWith('-') ? '' : words.join(' ');
};

// Settings' Claude Code CLI: whether auto mode is the default for its agents, and the commands they may run beyond
// editing their job folder, each approved as a plain prefix.
export function ClaudeCommands({ projectId, shell }: { projectId: string; shell: Shell }) {
  const toast = useToast(),
    settings = shell.agentPermissions ?? {},
    auto = settings.auto === true,
    commands = settings.commands ?? [],
    [draft, setDraft] = useState(''),
    problem = draft.trim() ? commandProblem(draft) : null;
  const save = useMutation({
    mutationFn: (agentPermissions: { auto?: boolean; commands?: string[] }) =>
      send('/api/control', { projectId, agentPermissions }),
    onError: error => toast(error.message),
  });
  const add = () => {
    const rule = draft.trim().split(/\s+/).join(' ');
    if (commandProblem(rule) || commands.includes(rule)) return;
    save.mutate({ commands: [...commands, rule] }, { onSuccess: () => setDraft('') });
  };
  return (
    <div id="agent-permissions" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-10)' }}>
      <div className="sd-field">
        <span className="sd-field__label">What its agents may run</span>
        <span
          className="sd-segmented"
          role="group"
          aria-label="Auto mode by default"
          style={{ alignSelf: 'flex-start' }}
        >
          {([false, true] as const).map(value => (
            <button
              key={String(value)}
              type="button"
              aria-pressed={auto === value}
              disabled={save.isPending}
              onClick={() => {
                if (auto === value) return;
                if (value && !window.confirm(`Make auto mode the default for Claude Code agents? ${autoRisk}`)) return;
                save.mutate({ auto: value });
              }}
            >
              {value ? 'Auto mode' : 'Approved commands only'}
            </button>
          ))}
        </span>
        <span className="sd-meta" style={auto ? { color: 'var(--you)' } : undefined}>
          {auto
            ? autoRisk
            : 'In workspace mode, each approved command allows that command alone or with more arguments.'}
        </span>
      </div>
      {commands.length ? (
        <ul className="sd-commands" aria-label="Approved commands">
          {commands.map(command => (
            <li key={command}>
              <code className="sd-file">{command}</code>
              <button
                type="button"
                className="sd-btn sd-btn--sm sd-btn--ghost"
                aria-label={`Remove ${command}`}
                disabled={save.isPending}
                onClick={() => save.mutate({ commands: commands.filter(item => item !== command) })}
              >
                <Icon name="close" size={16} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <span className="sd-meta">No commands approved yet.</span>
      )}
      <form
        className="sd-field"
        onSubmit={event => {
          event.preventDefault();
          add();
        }}
      >
        <label htmlFor="approve-command" className="sd-field__label">
          Approve a command
        </label>
        <span style={{ display: 'flex', gap: 'var(--space-8)', flexWrap: 'wrap' }}>
          <input
            id="approve-command"
            className="sd-input sd-mono"
            style={{ flex: '1 1 240px', width: 'auto', fontSize: '14px' }}
            value={draft}
            maxLength={200}
            placeholder="For example: node --test"
            aria-invalid={!!problem}
            onChange={event => setDraft(event.target.value)}
          />
          <button
            type="submit"
            className="sd-btn"
            disabled={save.isPending || !draft.trim() || !!problem || commands.length >= maxCommands}
          >
            Approve
          </button>
        </span>
        {problem && (
          <span className="sd-meta" style={{ color: 'var(--you)' }}>
            {problem}
          </span>
        )}
        {commands.length >= maxCommands && (
          <span className="sd-meta" style={{ color: 'var(--you)' }}>
            Approve at most {maxCommands} commands.
          </span>
        )}
      </form>
    </div>
  );
}

export function TaskAutoMode({ projectId, task, studio }: { projectId: string; task: Task; studio: StudioState }) {
  const toast = useToast(),
    owner = [...studio.workers, ...(studio.employeeDirectory ?? [])].find(worker => worker.id === task.workerId),
    execution = task.execution as { provider?: string } | undefined,
    provider = execution?.provider || owner?.provider,
    chosen = typeof task.autoMode === 'boolean' ? (task.autoMode as boolean) : null,
    byDefault = studio.agentPermissions?.auto === true,
    editable = !['running', 'stopping', 'done', 'denied'].includes(task.status);
  const set = useMutation({
    mutationFn: (autoMode: boolean | null) =>
      send(`/api/tasks/${encodeURIComponent(task.id)}`, { projectId, autoMode }, 'PATCH'),
    onError: error => toast(error.message),
  });
  if (provider !== 'claude') return null;
  // The choice as the select holds it: as Settings say, on or off.
  const value = chosen === null ? 'settings' : chosen ? 'auto' : 'commands';
  return (
    <div className="sd-detail">
      <label className="sd-eyebrow" htmlFor={`auto-mode-${task.id}`}>
        Auto mode
      </label>
      <select
        id={`auto-mode-${task.id}`}
        className="sd-select"
        value={value}
        disabled={!editable || set.isPending}
        onChange={event => {
          const next = event.target.value === 'settings' ? null : event.target.value === 'auto';
          if (next === true && !window.confirm(`Use auto mode for this task? ${autoRisk}`)) return;
          set.mutate(next);
        }}
      >
        <option value="settings">As in Settings ({byDefault ? 'auto' : 'approved commands'})</option>
        <option value="auto">Auto</option>
        <option value="commands">Approved commands only</option>
      </select>
      <span className="sd-meta">
        {editable
          ? 'For this task’s future Claude Code attempts in workspace mode.'
          : 'Recorded attempts keep the permissions they started with.'}
      </span>
    </div>
  );
}

// The commands an employee stopped for: each as a rule the director may shorten, approved for every Claude
// employee, and the work starts again from what it left. The autonomy policy never approves these.
export function CommandRequest({
  projectId,
  task,
  explanation,
}: {
  projectId: string;
  task: Task;
  explanation: Explanation;
}) {
  const toast = useToast(),
    refused = explanation.commands ?? [],
    [rules, setRules] = useState(() => refused.map(command => ({ command, rule: ruleFrom(command), chosen: true })));
  const allow = useMutation({
    mutationFn: () =>
      send(`/api/tasks/${encodeURIComponent(task.id)}/allow-commands`, {
        projectId,
        attemptId: explanation.attemptId,
        commands: rules.filter(item => item.chosen).map(item => item.rule.trim().split(/\s+/).join(' ')),
      }),
    onSuccess: () => toast('Commands approved. The work starts again from what it left.'),
    onError: error => toast(error.message),
  });
  const chosen = rules.filter(item => item.chosen),
    invalid = chosen.some(item => commandProblem(item.rule));
  return (
    <form
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-10)', marginTop: 'var(--space-8)' }}
      onSubmit={event => {
        event.preventDefault();
        allow.mutate();
      }}
    >
      <p className="sd-meta" style={{ margin: 0 }}>
        Approve each command, or a shorter start of it. It joins the approved commands in Settings for every Claude
        agent.
      </p>
      {rules.map((item, index) => {
        const problem = item.chosen ? commandProblem(item.rule) : null,
          id = `command-rule-${index}`;
        return (
          <div key={item.command} className="sd-field">
            <label style={{ display: 'flex', gap: 'var(--space-8)', alignItems: 'baseline' }}>
              <input
                type="checkbox"
                checked={item.chosen}
                onChange={event =>
                  setRules(current =>
                    current.map((entry, at) => (at === index ? { ...entry, chosen: event.target.checked } : entry)),
                  )
                }
              />{' '}
              <span>
                Refused:{' '}
                <code className="sd-mono" style={{ overflowWrap: 'anywhere' }}>
                  {item.command}
                </code>
              </span>
            </label>
            <label htmlFor={id} className="sd-field__label">
              Rule to approve
            </label>
            <input
              id={id}
              className="sd-input sd-mono"
              style={{ fontSize: '14px' }}
              value={item.rule}
              maxLength={200}
              disabled={!item.chosen}
              aria-invalid={!!problem}
              onChange={event =>
                setRules(current =>
                  current.map((entry, at) => (at === index ? { ...entry, rule: event.target.value } : entry)),
                )
              }
            />
            {problem && (
              <span className="sd-meta" style={{ color: 'var(--bad)' }}>
                {problem}
              </span>
            )}
          </div>
        );
      })}
      <button
        className="sd-btn sd-btn--primary"
        style={{ alignSelf: 'flex-start' }}
        disabled={allow.isPending || !chosen.length || invalid}
      >
        Allow commands
      </button>
    </form>
  );
}

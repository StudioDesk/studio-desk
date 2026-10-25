// What a CLI employee may run beyond editing its job folder (v1.0 item 22). The director keeps, in
// Settings, a list of approved commands and whether auto mode is the default; a task may turn auto mode on
// or off for its own future attempts, as a chat does in Claude. Each attempt records what it ran with.
// Claude Code applies them: approved commands become its allowed tool rules, and auto mode lets its own
// classifier decide what runs. A command it refuses is recorded on the attempt, so the director can approve
// it when the employee stops for want of it.
export const MAX_APPROVED_COMMANDS = 50;
const WORD = /^[A-Za-z0-9._/:=@+-]+$/;

// An approved command is a prefix: it allows the command alone or followed by more arguments. Words are
// plain, so no rule can carry shell operators, quotes, variables or wildcards.
export function commandRule(value) {
  const words = typeof value === 'string' ? value.trim().split(/\s+/) : [],
    text = words.join(' ');
  if (!text || text.length > 200 || text.startsWith('-') || !words.every(word => WORD.test(word)))
    throw new Error(
      `${JSON.stringify(String(value ?? '').slice(0, 80))} cannot be an approved command. Use 1 to 200 characters of letters, digits, spaces and . _ / : = @ + -, not starting with -.`,
    );
  return text;
}

export function agentPermissions(org) {
  const value = org?.agentPermissions || {};
  return { auto: value.auto === true, commands: [...(value.commands || [])] };
}

// A director edit of the Settings: either field may be left out.
export function applyAgentPermissions(org, value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(key => !['auto', 'commands'].includes(key))
  )
    throw new Error('Agent permissions take auto and commands.');
  const next = agentPermissions(org);
  if (value.auto !== undefined) {
    if (typeof value.auto !== 'boolean') throw new Error('Auto mode must be true or false.');
    next.auto = value.auto;
  }
  if (value.commands !== undefined) {
    if (!Array.isArray(value.commands)) throw new Error('Approved commands are a list.');
    next.commands = [...new Set(value.commands.map(commandRule))];
  }
  if (next.commands.length > MAX_APPROVED_COMMANDS)
    throw new Error(`Approve at most ${MAX_APPROVED_COMMANDS} commands.`);
  org.agentPermissions = next;
  return next;
}

export function approveCommands(org, commands) {
  if (!Array.isArray(commands) || !commands.length) throw new Error('Name at least one command to approve.');
  return applyAgentPermissions(org, { commands: [...agentPermissions(org).commands, ...commands] });
}

// A task's own choice: true or false overrides the Settings, null follows them.
export function taskAutoMode(value) {
  if (value !== null && typeof value !== 'boolean') throw new Error('Auto mode must be true, false or null.');
  return value;
}

// What an attempt runs with, recorded in its configuration.
export function attemptPermissions(org, task) {
  const settings = agentPermissions(org),
    chosen = typeof task?.autoMode === 'boolean';
  return {
    mode: (chosen ? task.autoMode : settings.auto) ? 'auto' : 'acceptEdits',
    autoFrom: chosen ? 'task' : 'settings',
    commands: settings.commands,
  };
}

// The rules for the approved commands and any command the controller itself gives the employee (tools).
export const allowedToolRules = commands => commands.flatMap(command => [`Bash(${command})`, `Bash(${command} *)`]);
export const permissionRules = permissions => allowedToolRules([...permissions.commands, ...(permissions.tools || [])]);

// What the employee is told, so it does not retry what will be refused.
export function permissionsPrompt(permissions) {
  const approved = permissions.commands.length
    ? ` The director approved these commands, each alone or with more arguments: ${permissions.commands.map(command => '`' + command + '`').join(', ')}.`
    : ' The director has approved no commands.';
  const mode =
    permissions.mode === 'auto'
      ? ` Claude Code runs in auto mode: its own checks decide which actions run.${approved}`
      : ` Claude Code accepts your edits in this job folder and runs read-only commands; any other command needs an approval nobody can give here, so it is refused.${approved} It also refuses a command that follows cd, is joined to another with && or ;, or is piped or redirected, so run each command on its own from your working directory.`;
  // A code-editing employee's test command (connectors/employee-tests.mjs).
  const tests = (permissions.tools || []).map(
    tool =>
      ` To run the project's tests on your edits, run \`${tool}\` for the whole suite, or add test file paths as they are in the source (for example test/a.test.mjs) to run only those, which is faster. The controller copies the source with your edits under changes/ applied and runs the tests where candidate tests run; run it in the foreground with a timeout of 600000 ms, and hand off your result only after it finishes. Your candidate is tested again after you finish.`,
  );
  return `${mode}${tests.join('')} If your work needs a command that is refused, do not try to get around it: return outcome blocked and say in your summary which command you need and why. The director sees the commands Claude Code refused and can approve them, and the work then starts again from what you leave here.`;
}

// Commands Claude Code refused during an attempt: at most 20, each command and reason bounded.
export const MAX_COMMAND_DENIALS = 20;
export function recordDenial(attempt, { tool, command, reason }) {
  const list = (attempt.commandDenials ||= []),
    entry = {
      tool: String(tool || '').slice(0, 80),
      command: String(command || '').slice(0, 500),
      reason: String(reason || '').slice(0, 300),
    };
  const existing = list.find(item => item.tool === entry.tool && item.command === entry.command);
  if (existing) {
    if (!existing.reason && entry.reason) existing.reason = entry.reason;
    return false;
  }
  if (list.length >= MAX_COMMAND_DENIALS) return false;
  list.push(entry);
  return true;
}

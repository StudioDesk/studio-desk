// What a CLI employee may run beyond editing its job folder (v1.0 item 22). The director keeps, in
// Settings, a list of approved commands and whether auto mode is the default; a task may turn auto mode on
// or off for its own future attempts, as a chat does in Claude. Each attempt records what it ran with.
// Claude Code applies them: approved commands become its allowed tool rules, and auto mode lets its own
// classifier decide what runs. A command it refuses is recorded on the attempt, so the director can approve
// it when the employee stops for want of it.
export const MAX_APPROVED_COMMANDS = 50;
const WORD = /^[A-Za-z0-9._/:=@+-]+$/;

// Shells and programs that run scripts, each with the options that run what follows them on the command line
// ('' when the program runs the command that follows it directly). Approved alone, or with only such an option,
// one lets an agent run anything, including reading the director's key. The dashboard keeps the same list
// (dashboard/src/permissions.tsx).
const node = ['-e', '--eval', '-p', '--print'],
  python = ['-c'],
  shell = ['-c'],
  powershell = ['-c', '-command', '-e', '-ec', '-enc', '-encodedcommand'];
const SCRIPT_RUNNERS = {
  node,
  nodejs: node,
  npm: ['exec', 'x'],
  npx: [''],
  pnpm: ['exec', 'dlx'],
  pnpx: [''],
  yarn: ['exec', 'dlx'],
  bun: [...node, 'x', 'exec'],
  bunx: [''],
  deno: ['eval'],
  python,
  python3: python,
  py: python,
  pip: [],
  perl: ['-e'],
  ruby: ['-e'],
  php: ['-r'],
  powershell,
  pwsh: powershell,
  cmd: ['/c', '/k'],
  bash: shell,
  sh: shell,
  zsh: shell,
  dash: shell,
  fish: shell,
  ksh: shell,
  wsl: ['', '-e', '--exec'],
  env: [''],
  cscript: [],
  wscript: [],
  mshta: [],
};

// A program's name without its folder, case or Windows ending: C:/Program Files/nodejs/node.exe is node.
const programName = path =>
  path
    .slice(path.lastIndexOf('/') + 1)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|ps1)$/, '')
    .replace(/^(python|pip)\d+(\.\d+)*$/, '$1');

// Whether a rule's words name a shell or script runner and nothing else that bounds it. A folder path may hold
// spaces, so the program may end in a later word when the first holds a /.
function unbounded(words) {
  for (let end = 1; end <= (words[0].includes('/') ? words.length : 1); end++) {
    const name = programName(words.slice(0, end).join(' '));
    if (!Object.hasOwn(SCRIPT_RUNNERS, name)) continue;
    const runs = SCRIPT_RUNNERS[name];
    let rest = words.slice(end).filter(word => word !== '--');
    // env runs what follows its options and settings.
    if (name === 'env') {
      const command = rest.findIndex(word => !word.startsWith('-') && !word.includes('='));
      rest = command < 0 ? [] : rest.slice(command);
    }
    if (!rest.length) return true;
    if (runs.includes('') && unbounded(rest)) return true;
    return runs.includes(rest[0].toLowerCase()) && (rest.length === 1 || unbounded(rest.slice(1)));
  }
  return false;
}

const refusal = text =>
  `${text} cannot be approved on its own: approving a shell or a program that runs scripts lets an agent run anything with it, including reading the director's key. Approve a narrower command, such as node --test.`;

// An approved command is a prefix: it allows the command alone or followed by more arguments. Words are
// plain, so no rule can carry shell operators, quotes, variables or wildcards, and a shell or script runner
// needs more words that bound what it runs.
export function commandRule(value) {
  const words = typeof value === 'string' ? value.trim().split(/\s+/) : [],
    text = words.join(' ');
  if (!text || text.length > 200 || text.startsWith('-') || !words.every(word => WORD.test(word)))
    throw new Error(
      `${JSON.stringify(String(value ?? '').slice(0, 80))} cannot be an approved command. Use 1 to 200 characters of letters, digits, spaces and . _ / : = @ + -, not starting with -.`,
    );
  if (unbounded(words)) throw new Error(refusal(text));
  return text;
}

const refused = rule => {
  try {
    commandRule(rule);
    return false;
  } catch {
    return true;
  }
};

// A stored rule this check now refuses, approved before it, never reaches an attempt.
export function agentPermissions(org) {
  const value = org?.agentPermissions || {};
  return { auto: value.auto === true, commands: (value.commands || []).filter(rule => !refused(rule)) };
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
    // A save that sends back a stored rule this check now refuses drops it instead of failing.
    const stored = org?.agentPermissions?.commands || [];
    next.commands = [
      ...new Set(value.commands.filter(rule => !(stored.includes(rule) && refused(rule))).map(commandRule)),
    ];
  }
  if (next.commands.length > MAX_APPROVED_COMMANDS)
    throw new Error(`Approve at most ${MAX_APPROVED_COMMANDS} commands.`);
  org.agentPermissions = next;
  return next;
}

export function approveCommands(org, commands) {
  if (!Array.isArray(commands) || !commands.length) throw new Error('Name at least one command to approve.');
  // Each new rule is checked on its own, so one stored before this check was refused is never approved again.
  return applyAgentPermissions(org, { commands: [...agentPermissions(org).commands, ...commands.map(commandRule)] });
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
      ` To run the project's tests on your edits, run \`${tool}\` for the whole suite, or add test file paths as they are in the source (for example test/a.test.mjs) to run only those. The whole suite waits for this computer's one test turn, which other full test suites share, and answers without running if it waits more than five minutes; named test files start at once and are faster. The controller copies the source with your edits under changes/ applied and runs the tests where candidate tests run; run it in the foreground with a timeout of 600000 ms, and hand off your result only after it finishes. Your candidate is tested again after you finish.`,
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

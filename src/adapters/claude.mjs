import { spawnSync } from 'node:child_process';
import { command, subscriptionEnvironment } from './process.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { textDeliverySchema, textPrompt, stageTextDelivery } from './text-delivery.mjs';
import { workspacePrompt } from './workspace-delivery.mjs';
import { resultSchema } from '../core/contracts.mjs';
import { modelMode } from '../core/execution.mjs';
import { attemptPermissions, permissionRules, permissionsPrompt, recordDenial } from '../core/agent-permissions.mjs';
import { noteSay, traceLimits } from '../core/attempt-trace.mjs';

export function locateClaude() {
  const configured = process.env.STUDIO_CLAUDE_BINARY;
  const candidates = configured
    ? [configured]
    : (process.env.PATH || '')
        .split(path.delimiter)
        .map(d => path.join(d, process.platform === 'win32' ? 'claude.exe' : 'claude'));
  for (const bin of candidates) {
    try {
      if (fs.statSync(bin).isFile()) return bin;
    } catch {}
  }
  return null;
}

// Text delivery (the hardened mode) has no native tools: the controller stages the
// files Claude returns (text-delivery.mjs).
export const claudeDeliverySchema = textDeliverySchema;
export const stageClaudeDelivery = (delivery, entry) => stageTextDelivery(delivery, entry);

// Model contract: run one attempt. Workspace mode (the default) runs Claude Code with
// the administrator's own settings, tools, MCP servers and plugins; edits are accepted
// inside the job folder, the director's approved commands run, and anything else follows
// the administrator's permission rules (unapproved requests are denied, since nobody can
// answer a prompt), or in auto mode Claude Code's own checks (agent-permissions.mjs). Text
// mode is the hardened option with no tools. `onComplete` continues a two-phase adapter.
// An attempt is one bounded turn. Claude Code in print mode keeps running after its result while work it
// started in the background or scheduled for later is pending, and then takes another turn and hands off
// a second result (idea 18, October 22). So workspace attempts run with background tasks off and without
// the tools that schedule later work, whatever the administrator's setup offers.
export const CLAUDE_UNBOUNDED_TOOLS = [
  'ScheduleWakeup',
  'CronCreate',
  'CronDelete',
  'CronList',
  'Monitor',
  'RemoteTrigger',
];
export function runClaude(entry, worker, { mode = 'workspace', editable = [], context = [], onComplete } = {}) {
  const { job } = entry,
    workspace = mode === 'workspace';
  entry.claudeMode = mode;
  let prompt, args;
  if (workspace) {
    // An attempt recorded before permissions existed ran as accept-edits with no approved commands.
    const permissions = entry.attempt.configuration?.permissions || { mode: 'acceptEdits', commands: [] },
      rules = permissionRules(permissions);
    prompt = workspacePrompt(entry, 'as your structured output') + permissionsPrompt(permissions);
    args = [
      '--print',
      '--permission-mode',
      permissions.mode,
      ...(rules.length ? ['--allowedTools', ...rules] : []),
      '--disallowedTools',
      ...CLAUDE_UNBOUNDED_TOOLS,
      '--add-dir',
      job,
      '--no-session-persistence',
      '--output-format',
      'stream-json',
      '--verbose',
      '--json-schema',
      JSON.stringify(resultSchema),
    ];
  } else {
    prompt = textPrompt(entry, { name: 'Claude', editable, context });
    const mcp = path.join(job, 'claude-mcp.json');
    fs.writeFileSync(mcp, JSON.stringify({ mcpServers: {} }));
    args = [
      '--print',
      '--safe-mode',
      '--restricted',
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      mcp,
      '--tools',
      '',
      '--permission-mode',
      'dontAsk',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--output-format',
      'stream-json',
      '--verbose',
      '--json-schema',
      JSON.stringify(textDeliverySchema),
    ];
  }
  if (worker.model) args.push('--model', worker.model);
  if (worker.effort) args.push('--effort', worker.effort);
  this.runNative(
    entry,
    this.claudeBinary,
    args,
    prompt,
    () => {
      if (!entry.claudeInit || !entry.claudeResult)
        throw new Error('Claude did not emit a complete session/result protocol.');
      return workspace ? entry.structuredOutput : stageTextDelivery(entry.structuredOutput, entry, { editable });
    },
    {
      // A command the controller gives the employee reads its endpoint from these (employee-tests.mjs).
      environment: {
        ...subscriptionEnvironment('claude', { safeMode: !workspace }),
        ...(workspace ? { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', ...entry.toolEnvironment } : {}),
      },
      onComplete,
    },
  );
}

export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// Aliases follow the latest model of each family; full IDs pin one release.
export const CLAUDE_MODELS = [
  { id: 'opus', label: 'Opus (latest)' },
  { id: 'sonnet', label: 'Sonnet (latest)' },
  { id: 'haiku', label: 'Haiku (latest)' },
  { id: 'fable', label: 'Fable (latest)' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
].map(model => ({ ...model, efforts: CLAUDE_EFFORTS }));

export const claudeAdapter = {
  id: 'claude',
  version: 'claude-cli-v1',
  name: 'Claude Code CLI',
  quotaLabel: 'Claude',
  workerSelectable: true,
  subscription: true,
  capabilities: ['text-output'],
  modes: ['workspace', 'text'],
  efforts: CLAUDE_EFFORTS,
  models: () => CLAUDE_MODELS,
  initialize: (runtime, options) => {
    runtime.claudeBinary = options.claudeBinary || locateClaude();
  },
  status: runtime => ({
    available: !!runtime.claudeBinary,
    label: 'Claude Code CLI, subscription login required',
  }),
  blockReason(runtime, verifyAuth) {
    if (!runtime.claudeBinary)
      return 'Claude Code CLI was not found. Install and sign in, then restart the controller.';
    if (verifyAuth) {
      const [bin, args] = command(runtime.claudeBinary, ['--safe-mode', '--setting-sources', '', 'auth', 'status']);
      const auth = spawnSync(bin, args, {
        cwd: runtime.store.directory,
        env: subscriptionEnvironment('claude'),
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
        maxBuffer: 20000,
      });
      let status;
      try {
        status = JSON.parse(auth.stdout);
      } catch {}
      if (
        auth.status !== 0 ||
        status?.loggedIn !== true ||
        status.authMethod !== 'claude.ai' ||
        status.apiProvider !== 'firstParty' ||
        !['pro', 'max', 'team', 'enterprise'].includes(status.subscriptionType)
      )
        return 'A Claude subscription login could not be confirmed. Run claude auth login in your terminal and choose Claude.ai. API-key authentication is not used by this adapter.';
    }
    return '';
  },
  // Record the mode the attempt runs in, not the employee's possibly blank (default) setting, and in
  // workspace mode the permissions it runs with.
  configuration: (runtime, worker, task) => {
    const mode = modelMode(claudeAdapter, worker);
    return {
      ...structuredClone(worker),
      mode,
      ...(mode === 'workspace' ? { permissions: attemptPermissions(runtime.store.organization(), task) } : {}),
    };
  },
  requestedModel: worker => worker.model || 'CLI default',
  delivery: worker =>
    modelMode(claudeAdapter, worker) === 'text'
      ? 'Recorded studio instructions and accepted text inputs on stdin. Native tools disabled; the controller stages proposed text/JSON files.'
      : 'AGENTS.md in the CLI working directory, plus assignment prompt on stdin. Claude Code uses the tools, MCP servers and permissions its administrator configured.',
  deliveryScope: worker =>
    modelMode(claudeAdapter, worker) === 'text'
      ? 'No native shell, filesystem, or editor tools are granted. Instructions, accepted UTF-8 input contents, and the delivery schema are supplied on stdin/by the CLI. Propose text/JSON file contents; the controller writes approved paths in the allocated output directory.'
      : 'Write staged outputs here. Inputs are supplied in the parent directory. Use the tools your configuration grants; edits outside this job folder are not approved.',
  run: (runtime, entry, worker, request) => runClaude.call(runtime, entry, worker, request),
  // Work carried from an earlier attempt is already in the output folder; text delivery offers it
  // as editable files, so the model sees it and may return it changed at the same paths.
  start: (runtime, entry, worker) => {
    const mode = modelMode(claudeAdapter, worker),
      editable = mode === 'text' ? (entry.attempt.continueFrom?.files || []).map(item => item.path) : [];
    runClaude.call(runtime, entry, worker, { mode, editable });
  },
  recordEvent: (runtime, entry, data) => recordClaudeEvent.call(runtime, entry, data),
  traceEvent: (trace, data, at) => traceClaudeEvent(trace, data, at),
};
// What a refused tool call tried: the command for a shell call, else the file or address it named.
function toolInput(input) {
  if (!input || typeof input !== 'object') return '';
  const value = input.command ?? input.file_path ?? input.path ?? input.url ?? '';
  return typeof value === 'string' ? value : '';
}
// A refusal from Claude Code's permission_denied event and the tool call it names. The attempt's command
// denials and its trace's blocked steps both read it here, so they agree.
export function deniedCall(call, data) {
  return {
    tool: data.tool_name || call?.name,
    command: toolInput(call?.input),
    reason: data.decision_reason || data.message || '',
  };
}
export function recordClaudeEvent(entry, data) {
  const a = entry.attempt;
  if (data.type === 'system' && data.subtype === 'init') {
    entry.claudeInit = true;
    if (typeof data.session_id === 'string') a.sessionId = data.session_id;
    this.store.updateAttempt(a);
    // API-key authentication is refused in every mode. Text mode also refuses any tool,
    // MCP server or installed plugin, since it promises a tool-free attempt.
    if (data.apiKeySource && data.apiKeySource !== 'none') {
      entry.nativeError = 'Claude reported API-key authentication. This adapter uses only a subscription login.';
      this.stop(a.id);
    } else if (
      entry.claudeMode === 'text' &&
      (!Array.isArray(data.tools) ||
        data.tools.some(tool => tool !== 'StructuredOutput') ||
        !Array.isArray(data.mcp_servers) ||
        data.mcp_servers.length ||
        // Safe mode keeps Claude Code's built-in plugins; reject anything installed.
        (data.plugins || []).some(plugin => plugin?.path !== 'builtin' || !/@builtin$/.test(plugin.source || '')))
    ) {
      entry.nativeError =
        'Claude reported unexpected tools or customizations. Text mode grants only structured text delivery.';
      this.stop(a.id);
    }
  }
  // A limit Claude Code reports as reached ('rejected') makes a failure Claude reports in the same attempt,
  // before or after it and in any wording, the usage limit (native-process.mjs); the report alone stops
  // nothing. It names when it resets, which nativeFailure prefers to a time read from the limit message,
  // and counts even when that time is unreadable. Reports of limits not yet reached change nothing.
  if (data.type === 'rate_limit_event') {
    const info = data.rate_limit_info;
    if (info && typeof info === 'object' && info.status === 'rejected')
      (entry.reportedResets ||= []).push(info.resetsAt);
  }
  // Each command Claude Code refuses is recorded on the attempt (agent-permissions.mjs): the refusal event
  // names the tool call, whose command came in an earlier assistant message, and the final result lists
  // every refusal with its input, in case an event was missed.
  if (data.type === 'system' && data.subtype === 'permission_denied') {
    const call = entry.toolCalls?.get(data.tool_use_id),
      denial = deniedCall(call, data);
    (entry.denialReasons ||= new Map()).set(data.tool_use_id, denial.reason);
    if (call && recordDenial(a, denial)) this.store.updateAttempt(a);
  }
  if (data.type === 'assistant') {
    const blocks = data.message?.content || [];
    for (const block of blocks)
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        entry.toolCalls ||= new Map();
        entry.toolCalls.set(block.id, { name: block.name, input: block.input });
        if (entry.toolCalls.size > 500) entry.toolCalls.delete(entry.toolCalls.keys().next().value);
      } else if (block.type === 'text' && !data.error) noteSay(entry, block.text);
    if (data.error)
      this.nativeFailure(
        entry,
        `${data.error}: ${blocks
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join(' ')}`,
      );
    if (entry.claudeMode === 'text' && blocks.some(b => b.type === 'tool_use' && b.name !== 'StructuredOutput')) {
      entry.nativeError = 'Claude attempted an unexpected native tool. No shell, file, or editor tools are granted.';
      this.stop(a.id);
    }
  }
  if (data.type === 'result') {
    let recorded = false;
    for (const denial of Array.isArray(data.permission_denials) ? data.permission_denials : [])
      recorded =
        recordDenial(a, {
          tool: denial?.tool_name,
          command: toolInput(denial?.tool_input),
          reason: entry.denialReasons?.get(denial?.tool_use_id),
        }) || recorded;
    if (recorded) this.store.updateAttempt(a);
    // The controller's protocol check, not a failure Claude reported.
    if (entry.claudeResult)
      entry.nativeError =
        'Claude Code handed off a second result after its first, so which one stands is uncertain. Start the assignment again; it continues from the work already done.';
    entry.claudeResult = true;
    if (data.is_error || data.subtype !== 'success')
      this.nativeFailure(
        entry,
        (data.errors || []).join(' ') || data.result || `Claude reported ${data.subtype || 'a failure'}.`,
      );
    else entry.structuredOutput = data.structured_output;
  }
}

// One line of Claude Code's stream-json as trace steps (attempt-trace.mjs, v1.0 item 21). Each content block
// arrives as its own assistant line; a tool call's result comes later in a user line, with Claude Code's own
// structured `tool_use_result`. Claude Code reports no exit code: a shell call that failed says "Exit code N"
// in its result, and one that did not is 0.
const shellTools = ['Bash', 'PowerShell'],
  readTools = ['Read'],
  searchTools = ['Grep', 'Glob'],
  editTools = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'];
const finite = value => (Number.isFinite(value) ? value : null);
const lineCount = text => (typeof text === 'string' && text ? text.split('\n').length : 0);
function resultText(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content)
    ? content
        .filter(block => block?.type === 'text')
        .map(block => block.text)
        .join('\n')
    : '';
}
// What the trace keeps of a call's input to name it later: the strings toolInput reads and Claude's own
// description of a command, never file contents.
function callInput(input) {
  const kept = {};
  for (const name of ['command', 'file_path', 'path', 'url', 'description'])
    if (typeof input?.[name] === 'string') kept[name] = input[name].slice(0, 4000);
  return kept;
}
function editEstimate(name, input) {
  if (name === 'Write') return { change: null, added: lineCount(input.content), removed: null };
  const edits = name === 'MultiEdit' && Array.isArray(input.edits) ? input.edits : [input];
  return {
    change: 'edit',
    added: edits.reduce((total, edit) => total + lineCount(edit?.new_string ?? edit?.new_source), 0),
    removed: edits.reduce((total, edit) => total + lineCount(edit?.old_string), 0),
  };
}
function claudeToolStep(trace, block, at) {
  const input = block.input && typeof block.input === 'object' ? block.input : {},
    name = String(block.name || '');
  // The structured result is the handoff, which the trace reads from the recorded result.
  if (name === 'StructuredOutput') return;
  let step;
  if (shellTools.includes(name))
    step = trace.step(at, 'shell', {
      command: trace.text(input.command, traceLimits.command),
      description: trace.text(input.description, 300),
      exitCode: null,
      output: null,
      pending: true,
    });
  else if (readTools.includes(name))
    step = trace.step(at, 'read', {
      path: trace.path(input.file_path),
      startLine: finite(input.offset),
      lines: null,
      totalLines: null,
      output: null,
      pending: true,
    });
  else if (searchTools.includes(name))
    step = trace.step(at, 'search', {
      tool: name,
      pattern: trace.text(input.pattern, traceLimits.detail),
      path: trace.path(input.path),
      glob: trace.text(input.glob, traceLimits.detail),
      matches: null,
      output: null,
      pending: true,
    });
  else if (editTools.includes(name))
    step = trace.step(at, 'edit', {
      path: trace.path(input.file_path ?? input.notebook_path),
      ...editEstimate(name, input),
      pending: true,
    });
  else
    step = trace.step(at, 'tool', {
      tool: trace.text(name, 80),
      detail: trace.text(toolInput(input), traceLimits.detail) || null,
      pending: true,
    });
  trace.call(block.id, { step, name, input: callInput(input) });
}
function claudeToolResult(trace, block, result) {
  const call = trace.calls.get(block.tool_use_id);
  if (!call || call.denied) return;
  const { step } = call,
    text = resultText(block.content);
  delete step.pending;
  if (block.is_error) {
    const exit = step.kind === 'shell' && /^Exit code (\d+)\r?\n?/.exec(text);
    if (exit) {
      step.exitCode = Number(exit[1]);
      step.output = trace.output(text.slice(exit[0].length));
    } else
      trace.retype(step, 'error', {
        tool: trace.text(call.name, 80),
        detail: trace.text(toolInput(call.input), traceLimits.detail) || null,
        description: trace.text(call.input.description, 300),
        reason: trace.text(text.replace(/^Error: /, ''), traceLimits.reason),
      });
    return;
  }
  const value = result && typeof result === 'object' ? result : {};
  if (step.kind === 'shell') {
    step.exitCode = 0;
    step.output = trace.output(
      typeof value.stdout === 'string' ? [value.stdout, value.stderr].filter(Boolean).join('\n') : text,
    );
    if (value.interrupted === true) step.interrupted = true;
  } else if (step.kind === 'read') {
    const file = value.file && typeof value.file === 'object' ? value.file : {};
    step.startLine = finite(file.startLine) ?? step.startLine;
    step.lines = finite(file.numLines);
    step.totalLines = finite(file.totalLines);
    step.output = trace.output(typeof file.content === 'string' ? file.content : text);
  } else if (step.kind === 'search') {
    step.matches = finite(step.tool === 'Grep' && value.mode === 'content' ? value.numLines : value.numFiles);
    step.output = trace.output(
      typeof value.content === 'string'
        ? value.content
        : Array.isArray(value.filenames)
          ? value.filenames.map(name => trace.path(name)).join('\n')
          : text,
    );
  } else if (step.kind === 'edit') {
    if (value.type === 'create') Object.assign(step, { change: 'create', added: lineCount(value.content), removed: 0 });
    else if (Array.isArray(value.structuredPatch) && value.structuredPatch.length) {
      const lines = value.structuredPatch.flatMap(hunk => (Array.isArray(hunk?.lines) ? hunk.lines : []));
      Object.assign(step, {
        change: 'edit',
        added: lines.filter(line => typeof line === 'string' && line.startsWith('+')).length,
        removed: lines.filter(line => typeof line === 'string' && line.startsWith('-')).length,
      });
    } else step.change ??= 'edit';
  }
}
export function traceClaudeEvent(trace, data, at) {
  if (data.type === 'system') {
    if (data.subtype === 'init' && !trace.setup)
      trace.setup = {
        tools: Array.isArray(data.tools) ? data.tools.length : null,
        mcpServers: (Array.isArray(data.mcp_servers) ? data.mcp_servers : [])
          .map(server => trace.text(server?.name, 200))
          .filter(Boolean)
          .slice(0, 50),
        permissionMode: trace.text(data.permissionMode, 80),
        version: trace.text(data.claude_code_version, 80),
      };
    else if (data.subtype === 'thinking_tokens') trace.thinking(data.estimated_tokens_delta, data.estimated_tokens);
    else if (data.subtype === 'permission_denied') {
      const call = trace.calls.get(data.tool_use_id),
        denial = deniedCall(call, data),
        facts = {
          tool: trace.text(denial.tool, 80),
          detail: trace.text(denial.command, traceLimits.detail) || null,
          description: trace.text(call?.input.description, 300),
          reason: trace.text(denial.reason, traceLimits.reason),
        };
      if (call) {
        call.denied = true;
        trace.retype(call.step, 'blocked', facts);
      } else trace.step(at, 'blocked', facts);
    }
    return;
  }
  if (data.type === 'assistant') {
    const blocks = Array.isArray(data.message?.content) ? data.message.content : [];
    if (data.error) {
      trace.step(at, 'error', {
        tool: 'Claude',
        detail: trace.text(data.error, 200),
        description: null,
        reason: trace.text(resultText(blocks), traceLimits.reason),
      });
      return;
    }
    for (const block of blocks)
      if (block?.type === 'text') trace.step(at, 'say', trace.say(block.text));
      else if (block?.type === 'thinking' || block?.type === 'redacted_thinking')
        trace.step(at, 'think', { durationMs: finite(data.thinking_duration_ms), tokens: trace.takeThinking() });
      else if (block?.type === 'tool_use') claudeToolStep(trace, block, at);
    return;
  }
  if (data.type === 'user') {
    for (const block of Array.isArray(data.message?.content) ? data.message.content : [])
      if (block?.type === 'tool_result') claudeToolResult(trace, block, data.tool_use_result);
    return;
  }
  if (data.type === 'rate_limit_event') {
    const info = data.rate_limit_info && typeof data.rate_limit_info === 'object' ? data.rate_limit_info : {},
      windows = info.unifiedWindows && typeof info.unifiedWindows === 'object' ? info.unifiedWindows : null;
    if (windows)
      for (const [name, value] of Object.entries(windows)) trace.window(name, value?.utilization, value?.resetsAt);
    else trace.window(info.rateLimitType, info.utilization, info.resetsAt);
    return;
  }
  if (data.type === 'result') {
    const usage = data.usage && typeof data.usage === 'object' ? data.usage : {};
    trace.tokens({
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheRead: usage.cache_read_input_tokens,
      cacheWrite: usage.cache_creation_input_tokens,
    });
    if (data.is_error || (data.subtype && data.subtype !== 'success'))
      trace.step(at, 'error', {
        tool: 'Claude',
        detail: trace.text(data.subtype, 200),
        description: null,
        reason: trace.text(
          (Array.isArray(data.errors) ? data.errors.join(' ') : '') || data.result || null,
          traceLimits.reason,
        ),
      });
  }
}

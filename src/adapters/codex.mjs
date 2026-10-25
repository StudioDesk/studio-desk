import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { command, subscriptionEnvironment } from './process.mjs';
import { checkCodexSandbox } from '../../scripts/check-codex-sandbox.mjs';
import { workspacePrompt } from './workspace-delivery.mjs';
import { modelMode } from '../core/execution.mjs';
import { noteSay, traceLimits } from '../core/attempt-trace.mjs';

export function locateCodex() {
  const configured = process.env.STUDIO_CODEX_BINARY;
  const candidates = configured
    ? [configured]
    : (process.env.PATH || '')
        .split(path.delimiter)
        .flatMap(d =>
          process.platform === 'win32'
            ? [path.join(d, 'codex.exe'), path.join(d, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')]
            : [path.join(d, 'codex')],
        );
  for (const bin of candidates) {
    try {
      if (fs.statSync(bin).isFile()) return bin;
    } catch {}
  }
  return null;
}
export function runCodex(entry, worker, processOptions = {}) {
  const { attempt: a, job, output } = entry;
  const args = [
    '--ask-for-approval',
    'never',
    // The administrator's Codex configuration, rules and MCP servers apply; writes stay
    // inside the job's output folder through the sandbox.
    'exec',
    '--json',
    '--sandbox',
    'workspace-write',
    '--skip-git-repo-check',
    '--output-schema',
    path.join(job, 'result-schema.json'),
    '--output-last-message',
    path.join(job, 'result.json'),
  ];
  // Explicit MXC selection has no legacy fallback. A provisioned elevated
  // sandbox can be selected for future attempts; retain the recorded choice.
  if (process.platform === 'win32') {
    if (!['mxc', 'elevated'].includes(a.configuration.windowsSandbox))
      throw new Error('Invalid recorded Windows sandbox implementation.');
    args.push('--config', `windows.sandbox="${a.configuration.windowsSandbox}"`);
  }
  if (worker.model) args.push('--model', worker.model);
  if (worker.effort) args.push('--config', `model_reasoning_effort="${worker.effort}"`);
  args.push('-');
  const prompt = workspacePrompt(entry, 'matching ../result-schema.json');
  this.runNative(
    entry,
    this.codexBinary,
    args,
    prompt,
    () => JSON.parse(fs.readFileSync(path.join(job, 'result.json'), 'utf8')),
    processOptions,
  );
}

export const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

// Model suggestions from the Codex CLI's own local cache. Only public model
// names and effort levels are read; the file's account fields are ignored.
export function codexModels(file) {
  try {
    const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (cache.models || [])
      .filter(
        model =>
          typeof model.slug === 'string' && model.visibility !== 'hide' && /^[a-zA-Z0-9_.:/-]+$/.test(model.slug),
      )
      .slice(0, 30)
      .map(model => ({
        id: model.slug,
        label: String(model.display_name || model.slug).slice(0, 80),
        efforts: (model.supported_reasoning_levels || [])
          .map(level => level.effort)
          .filter(effort => CODEX_EFFORTS.includes(effort)),
        defaultEffort: CODEX_EFFORTS.includes(model.default_reasoning_level) ? model.default_reasoning_level : '',
      }));
  } catch {
    return [];
  }
}

export const codexAdapter = {
  id: 'codex',
  version: 'codex-cli-v1',
  name: 'Codex CLI',
  quotaLabel: 'Codex',
  workerSelectable: true,
  subscription: true,
  capabilities: ['text-output'],
  modes: ['workspace'],
  efforts: CODEX_EFFORTS,
  models: runtime => runtime.codexModels,
  // Workspace mode relies on the CLI's OS sandbox; steps that need verified file
  // isolation run this model-free probe before dispatch.
  isolationCheck: runtime => runtime.sourceReviewSandbox(),
  initialize: (runtime, options) => {
    runtime.codexBinary = options.codexBinary || locateCodex();
    runtime.codexModels = codexModels(
      options.codexModelsFile ??
        path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'models_cache.json'),
    );
    runtime.codexWindowsSandbox = options.codexWindowsSandbox ?? process.env.STUDIO_CODEX_WINDOWS_SANDBOX ?? 'mxc';
    runtime.sourceReviewSandbox =
      options.sourceReviewSandbox ||
      (() => checkCodexSandbox({ binary: runtime.codexBinary, implementation: runtime.codexWindowsSandbox }));
  },
  status: runtime => ({
    available: !!runtime.codexBinary,
    windowsSandbox: process.platform === 'win32' ? runtime.codexWindowsSandbox : null,
    label: 'Codex CLI, subscription login required',
  }),
  blockReason(runtime, verifyAuth) {
    if (process.platform === 'win32' && !['mxc', 'elevated'].includes(runtime.codexWindowsSandbox))
      return 'STUDIO_CODEX_WINDOWS_SANDBOX must be mxc or elevated. No weaker sandbox fallback is allowed.';
    if (!runtime.codexBinary) return 'Codex CLI was not found. Install and sign in, then restart the controller.';
    if (verifyAuth) {
      const [bin, args] = command(runtime.codexBinary, ['login', 'status']);
      const auth = spawnSync(bin, args, {
        env: subscriptionEnvironment(),
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
        maxBuffer: 20000,
      });
      if (auth.status !== 0 || !/logged in using chatgpt/i.test((auth.stdout || '') + (auth.stderr || '')))
        return 'A ChatGPT subscription login could not be confirmed. Run codex login in your terminal and choose ChatGPT. API-key authentication is not used by this adapter.';
    }
    return '';
  },
  configuration(runtime, worker) {
    const configuration = { ...structuredClone(worker), mode: modelMode(codexAdapter, worker) };
    if (process.platform === 'win32') configuration.windowsSandbox = runtime.codexWindowsSandbox;
    return configuration;
  },
  requestedModel: worker => worker.model || 'CLI default',
  delivery: 'AGENTS.md in the private CLI working directory, plus assignment prompt on stdin.',
  deliveryScope: 'Write staged outputs here only. Inputs and result schema are supplied in the parent directory.',
  // Model contract: workspace mode. Editable files are already in the output folder.
  run: (runtime, entry, worker, { onComplete } = {}) =>
    runCodex.call(runtime, entry, worker, onComplete ? { onComplete } : {}),
  start: (runtime, entry, worker) => runCodex.call(runtime, entry, worker),
  recordEvent(runtime, entry, data) {
    const a = entry.attempt;
    if (data.type === 'thread.started') {
      a.sessionId = data.thread_id;
      runtime.store.updateAttempt(a);
    }
    if (data.type === 'item.completed' && data.item?.type === 'agent_message') noteSay(entry, data.item.text);
  },
  traceEvent: (trace, data, at) => traceCodexEvent(trace, data, at),
};

// Codex runs each command through a shell: `"…powershell.exe" -Command '<command>'` on Windows, `bash -lc
// '<command>'` elsewhere. The trace shows the command itself.
export function codexCommand(command) {
  if (Array.isArray(command)) {
    const [shell, flag, inner] = command;
    return command.length === 3 &&
      /(?:^|[\\/])(?:ba|z)?sh$|powershell|pwsh/i.test(String(shell)) &&
      ['-lc', '-c', '-Command'].includes(flag)
      ? String(inner)
      : command.map(String).join(' ');
  }
  const text = String(command ?? '');
  let match = /^"?[^"']*?(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-NoProfile\s+)?-Command\s+'([\s\S]*)'$/i.exec(text);
  if (match) return match[1].replaceAll("''", "'");
  match = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh\s+-l?c\s+'([\s\S]*)'$/.exec(text);
  return match ? match[1].replaceAll("'\\''", "'") : text;
}

// One line of Codex's exec JSON as trace steps (attempt-trace.mjs, v1.0 item 21). Codex reports a command when
// it starts and again with its exit code and output when it completes, file changes by path and kind without
// line counts, and its token usage per turn. It keeps its reasoning private.
const changeKinds = { add: 'create', delete: 'delete' };
export function traceCodexEvent(trace, data, at) {
  if (data.type === 'turn.completed') {
    const usage = data.usage && typeof data.usage === 'object' ? data.usage : {};
    trace.tokens(
      {
        input: usage.input_tokens,
        cachedInput: usage.cached_input_tokens,
        output: usage.output_tokens,
        reasoningOutput: usage.reasoning_output_tokens,
      },
      { add: true },
    );
    return;
  }
  if (data.type === 'error' || data.type === 'turn.failed') {
    trace.step(at, 'error', {
      tool: 'Codex',
      detail: null,
      description: null,
      reason: trace.text(data.message || data.error?.message || null, traceLimits.reason),
    });
    return;
  }
  const item = data.item;
  if (!item || typeof item !== 'object' || !['item.started', 'item.updated', 'item.completed'].includes(data.type))
    return;
  const completed = data.type === 'item.completed',
    known = trace.calls.get(item.id);
  if (item.type === 'agent_message') {
    if (completed) trace.step(at, 'say', trace.say(item.text));
  } else if (item.type === 'reasoning') {
    if (completed) trace.step(at, 'think', { durationMs: null, tokens: null });
  } else if (item.type === 'command_execution') {
    const command = trace.text(codexCommand(item.command), traceLimits.command),
      step =
        known?.step ??
        trace.step(at, 'shell', { command, description: null, exitCode: null, output: null, pending: true });
    if (!known) trace.call(item.id, { step });
    if (!completed) return;
    if (item.status === 'declined')
      trace.retype(step, 'blocked', { tool: 'shell', detail: command, description: null, reason: 'declined' });
    else {
      delete step.pending;
      step.exitCode = Number.isFinite(item.exit_code) ? item.exit_code : null;
      step.output = trace.output(typeof item.aggregated_output === 'string' ? item.aggregated_output : '');
    }
  } else if (item.type === 'file_change') {
    const steps =
      known?.steps ??
      (Array.isArray(item.changes) ? item.changes : []).map(change =>
        trace.step(at, 'edit', {
          path: trace.path(change?.path),
          change: changeKinds[change?.kind] || 'edit',
          added: null,
          removed: null,
          pending: true,
        }),
      );
    if (!known) trace.call(item.id, { steps });
    if (completed) for (const step of steps) delete step.pending;
  } else if (item.type === 'web_search') {
    if (completed)
      trace.step(at, 'search', {
        tool: 'web_search',
        pattern: trace.text(item.query, traceLimits.detail),
        path: null,
        glob: null,
        matches: null,
        output: null,
      });
  } else if (item.type === 'mcp_tool_call' && !known)
    trace.call(item.id, {
      step: trace.step(at, 'tool', { tool: trace.text(`${item.server}.${item.tool}`, 80), detail: null }),
    });
}

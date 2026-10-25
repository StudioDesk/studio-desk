import { spawn, spawnSync } from 'node:child_process';

export function live(a) {
  if (!a.pid) return false;
  try {
    process.kill(process.platform === 'win32' ? a.pid : -a.pid, 0);
    return true;
  } catch (e) {
    return e.code !== 'ESRCH';
  }
}
// Strips API-key and alternate-provider variables so a CLI can only use its subscription
// login. `safeMode` (Claude text mode) also turns off the CLI's own customizations.
export function subscriptionEnvironment(provider = 'codex', { safeMode = true } = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      /API_KEY$/i.test(key) ||
      ['OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID', 'CODEX_ACCESS_TOKEN'].includes(key.toUpperCase()) ||
      (provider === 'claude' && (/^ANTHROPIC_/i.test(key) || (/^CLAUDE/i.test(key) && key !== 'CLAUDE_CONFIG_DIR')))
    )
      delete env[key];
  if (provider === 'claude')
    Object.assign(env, {
      ...(safeMode ? { CLAUDE_CODE_SAFE_MODE: '1' } : {}),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      DO_NOT_TRACK: '1',
      MAX_STRUCTURED_OUTPUT_RETRIES: '1',
    });
  return env;
}
export function command(binary, args) {
  return binary.endsWith('.js') || binary.endsWith('.mjs') ? [process.execPath, [binary, ...args]] : [binary, args];
}

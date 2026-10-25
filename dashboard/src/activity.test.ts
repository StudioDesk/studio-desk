// Before this attempt (the phone board): how the story's earlier attempts ended, in one line, alike ones together.
import { expect, test } from 'vitest';
import { beforeThis } from './activity';
import type { AttemptSummary } from './api';

const attempt = (id: string, extra: Partial<AttemptSummary>) =>
  ({ id, taskId: 'T-1', status: 'failed', finishedAt: '2026-10-21T20:00:00Z', ...extra }) as AttemptSummary;

test("the earlier attempts' endings read in one line, alike ones together", () => {
  const attempts = [
    attempt('a1', { subscriptionHold: 'codex' }),
    attempt('a2', { failedTests: [{ name: 'x' }, { name: 'y' }] }),
    attempt('a3', { failedTests: [{ name: 'x' }, { name: 'y' }] }),
    attempt('a4', { status: 'running', finishedAt: null }),
  ];
  expect(beforeThis(attempts, attempts[3]!, () => 'Codex')).toBe(
    "1 paused for Codex's usage limit · 2 and 3 stopped with 2 tests failing",
  );
  expect(beforeThis(attempts, attempts[0]!, () => 'Codex')).toBe('');
});

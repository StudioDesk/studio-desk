// The sidebar's house rules in a sentence, as the canvas says them: what waits for the director and what runs on
// its own.
import { expect, test } from 'vitest';
import { rulesLine } from './frame';
import type { StudioState } from './studio-runs';

const state = (enabled: boolean, change: object) =>
  ({
    organizationConfiguration: {
      taskKinds: ['studio-development:checks', 'studio-development:change', 'studio-development:change-review'],
    },
    autonomy: {
      policy: {
        enabled,
        kinds: {
          'studio-development:checks': { approve: 'director', accept: 'auto' },
          'studio-development:change-review': { approve: 'auto', accept: 'auto' },
          'studio-development:change': change,
        },
      },
    },
  }) as unknown as StudioState;

test('the house rules say what is yours and what runs on its own', () => {
  expect(rulesLine(state(true, { approve: 'director', accept: 'auto', integrate: 'director' }))).toBe(
    'House rules: you start stories and integrate them; checks and reviews run on their own.',
  );
  expect(rulesLine(state(true, { approve: 'director', accept: 'auto', integrate: 'auto' }))).toBe(
    'House rules: you start stories; checks, reviews and integration run on their own.',
  );
  expect(rulesLine(state(false, {}))).toBe('House rules: every step waits for you.');
});

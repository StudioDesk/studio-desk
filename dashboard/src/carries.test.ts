// How a story's carries read (1.1): carried forward or brought back, not needed, waiting for another story's turn on
// its line, and still on their way.
import { expect, test } from 'vitest';
import { carryWords } from './carries';

const titles: Record<string, string> = { 'T-2': 'Keep the folder browser quick' },
  titleOf = (id: string) => titles[id];

test('a carry that reached its line reads carried forward or brought back', () => {
  expect(carryWords({ line: 'main', state: 'carried' })).toBe('carried to main');
  expect(carryWords({ line: 'release/1.0', state: 'carried', back: true })).toBe('brought back to release/1.0');
});

test('a carry the director marked not needed reads so, either way', () => {
  expect(carryWords({ line: 'main', state: 'skipped' })).toBe('not needed on main');
  expect(carryWords({ line: 'release/1.0', state: 'skipped', back: true })).toBe('not needed on release/1.0');
});

test("a carry waiting for another story's turn names it, with its title when known", () => {
  const carry = { line: 'release/0.9', state: 'waiting', back: true, after: ['T-2'] };
  expect(carryWords(carry, titleOf)).toBe("waits for T-2 (“Keep the folder browser quick”)'s turn on release/0.9");
  expect(carryWords(carry)).toBe("waits for T-2's turn on release/0.9");
  expect(carryWords({ ...carry, after: ['T-2', 'T-3'] }, titleOf)).toBe(
    "waits for T-2 (“Keep the folder browser quick”) and T-3's turn on release/0.9",
  );
});

test('a carry still on its way reads its state, forward or back', () => {
  expect(carryWords({ line: 'main', state: 'verifying' })).toBe('carry to main: verifying');
  expect(carryWords({ line: 'release/1.0', state: 'merging', back: true })).toBe(
    'bringing back to release/1.0: merging',
  );
  // Waiting with no story ahead of it is its own turn.
  expect(carryWords({ line: 'main', state: 'waiting', after: [] })).toBe('carry to main: waiting');
  expect(carryWords({ line: 'release/1.0', state: 'waiting', back: true })).toBe(
    'bringing back to release/1.0: waiting',
  );
});

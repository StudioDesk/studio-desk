import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRules, parseRules, ruleLimits } from '../src/core/rules.mjs';

test('a document written before rules had names reads as one rule without a name per paragraph', () => {
  assert.deepEqual(
    parseRules('Keep it local.\r\n\r\nUse the brief.\nThen the inputs.\n\n\n  \nStop after the result.  '),
    [
      { title: null, text: 'Keep it local.' },
      { title: null, text: 'Use the brief.\nThen the inputs.' },
      { title: null, text: 'Stop after the result.' },
    ],
  );
  assert.deepEqual(parseRules(''), []);
  assert.deepEqual(parseRules(undefined), []);
});

test("a rule's name is the bold words it opens with, without their full stop", () => {
  assert.deepEqual(
    parseRules('**Stay local.** Keep orchestration here.\n\n**Ask first?** When unsure.\n\n**Heading only**'),
    [
      { title: 'Stay local', text: 'Keep orchestration here.' },
      { title: 'Ask first?', text: 'When unsure.' },
      { title: 'Heading only', text: '' },
    ],
  );
});

test('rules written as text read back as the same rules', () => {
  const rules = [
    { title: 'Stay local', text: 'Keep orchestration, records and the dashboard on this computer.' },
    { title: 'Ask when a call is not yours?', text: 'Stop and ask:\n- what you need\n- why' },
    { title: null, text: 'A rule without a name, kept from an older revision.' },
    { title: 'Only a name', text: '' },
  ];
  const text = formatRules(rules);
  assert.equal(
    text,
    '**Stay local.** Keep orchestration, records and the dashboard on this computer.\n\n' +
      '**Ask when a call is not yours?** Stop and ask:\n- what you need\n- why\n\n' +
      'A rule without a name, kept from an older revision.\n\n' +
      '**Only a name.**',
  );
  assert.deepEqual(parseRules(text), rules);
  // A name given with its full stops, or with spaces around it, is written the same way.
  assert.equal(formatRules([{ title: ' Stay local. ', text: ' Here. ' }]), '**Stay local.** Here.');
  assert.equal(formatRules([{ title: 'Wait...', text: 'Here.' }]), '**Wait.** Here.');
  assert.deepEqual(parseRules('**Wait...** Here.'), [{ title: 'Wait', text: 'Here.' }]);
  assert.deepEqual(parseRules(formatRules(parseRules(text))), parseRules(text));
});

test('rules that would not read back as themselves are refused with what to change', () => {
  const refused = (rules, pattern) => assert.throws(() => formatRules(rules), pattern);
  refused([], /1 to 100 rules/);
  refused(
    Array.from({ length: ruleLimits.rules + 1 }, () => ({ title: null, text: 'x' })),
    /1 to 100 rules/,
  );
  refused([{ title: 'A', text: 'One.\n\nTwo.' }], /Rule 1 is one paragraph: remove the blank lines inside it/);
  refused(
    [
      { title: 'A', text: 'x' },
      { title: null, text: '**Bold** start' },
    ],
    /Rule 2 opens with bold words/,
  );
  refused([{ title: 'Two\nlines', text: 'x' }], /Rule 1's name must be one line/);
  refused([{ title: 'Star *', text: 'x' }], /without asterisks/);
  refused([{ title: 'x'.repeat(ruleLimits.name + 1), text: 'x' }], /at most 80 characters/);
  refused([{ title: 'A', text: 'x'.repeat(ruleLimits.text + 1) }], /at most 4000 characters/);
  refused([{ title: '', text: '  ' }], /Rule 1 is empty/);
  refused([{ title: 'A', text: 'x', extra: true }], /Rule 1 must be a name and a text/);
  refused(['text'], /Rule 1 must be a name and a text/);
  refused([{ title: 3, text: 'x' }], /Rule 1's name/);
  refused([{ title: 'A' }], /Rule 1's text/);
});

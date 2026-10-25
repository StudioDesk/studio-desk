import test from 'node:test';
import assert from 'node:assert/strict';
import { reportedReset, usageReset } from '../src/core/usage-reset.mjs';

// Forms without a zone are read in the controller's local time zone, so their expected times are local
// wall clocks; the rest are fixed instants.
const evening = new Date(2026, 9, 22, 20, 0),
  local = (...parts) => new Date(...parts).toISOString(),
  now = new Date('2026-10-22T20:00:00.000Z'),
  epoch = iso => Date.parse(iso) / 1000;

test('a bare time of day is its next local occurrence', () => {
  assert.equal(
    usageReset("You've hit your usage limit. Upgrade to Pro or try again at 10:25 PM.", evening),
    local(2026, 9, 22, 22, 25),
  );
  assert.equal(usageReset('TRY AGAIN AT 10:25PM', evening), local(2026, 9, 22, 22, 25));
  assert.equal(usageReset('try again at 11 pm', evening), local(2026, 9, 22, 23, 0));
  // Past midnight, the next occurrence is tomorrow.
  assert.equal(usageReset('try again at 1:05 am', evening), local(2026, 9, 23, 1, 5));
});

test('a dated time is read in local time, more than 12 hours ahead included', () => {
  assert.equal(usageReset('Try again at Oct 25th, 2026 3:15 PM.', evening), local(2026, 9, 25, 15, 15));
  assert.equal(usageReset('try again at October 23 2026 9:00am', evening), local(2026, 9, 23, 9, 0));
  assert.equal(
    usageReset('try again at Sept 1st, 2026 at 3:15 pm', new Date(2026, 7, 30, 12, 0)),
    local(2026, 8, 1, 15, 15),
  );
  assert.equal(
    usageReset('try again at Feb 28th, 2027 3:15 PM', new Date(2027, 1, 27, 12, 0)),
    local(2027, 1, 28, 15, 15),
  );
});

test("'resets' reads a local time, or the time in its recognized zone", () => {
  assert.equal(usageReset('5-hour limit reached ∙ resets 11pm', evening), local(2026, 9, 22, 23, 0));
  assert.equal(usageReset("You've hit your limit · resets 3am", evening), local(2026, 9, 23, 3, 0));
  // 4:00 PM in New York; 10:30 PM there is 6.5 hours later.
  assert.equal(
    usageReset("You've hit your limit · resets 10:30pm (America/New_York)", now),
    '2026-10-23T02:30:00.000Z',
  );
  // It is already 5:00 AM the next day in Tokyo.
  assert.equal(usageReset('Limit reached, resets 7am (Asia/Tokyo)', now), '2026-10-22T22:00:00.000Z');
  // New York leaves daylight time at 2 AM on Nov 1, 2026: 3 AM that day is 8:00 UTC, not 7:00.
  assert.equal(
    usageReset('resets 3am (America/New_York)', new Date('2026-11-01T04:00:00.000Z')),
    '2026-11-01T08:00:00.000Z',
  );
});

test("Claude's epoch form and a relative time", () => {
  assert.equal(
    usageReset(`Claude AI usage limit reached|${epoch('2026-10-22T23:00:00.000Z')}`, now),
    '2026-10-22T23:00:00.000Z',
  );
  assert.equal(
    usageReset("You've hit your usage limit. Try again in 2 hours 5 minutes.", now),
    '2026-10-22T22:05:00.000Z',
  );
  assert.equal(usageReset('try again in 1 day, 3 hours and 30 minutes', now), '2026-10-23T23:30:00.000Z');
  assert.equal(usageReset('Try again in 45 minutes', now), '2026-10-22T20:45:00.000Z');
  // Eight days exactly is the furthest reset accepted.
  assert.equal(usageReset('try again in 8 days', now), '2026-10-30T20:00:00.000Z');
});

test('unreadable text gives null', () => {
  for (const message of [
    'Usage limit reached',
    'Rate limit exceeded. Try again later.',
    'try again at noon',
    'try again in a few minutes',
    'resets soon',
    '',
    undefined,
  ])
    assert.equal(usageReset(message, now), null, String(message));
});

test('invalid parts give null', () => {
  for (const message of ['try again at 25:99 PM', 'try again at 10:75 PM', 'try again at 0:30 am', 'resets 13pm'])
    assert.equal(usageReset(message, evening), null, message);
  // Without the check, Feb 30 would roll over to Mar 2, three days ahead.
  assert.equal(usageReset('try again at Feb 30th, 2027 3:15 PM', new Date(2027, 1, 27, 12, 0)), null);
});

test('an unrecognized zone gives null', () => {
  assert.equal(usageReset('resets 10:30pm (Mars/Olympus_Mons)', now), null);
  assert.equal(usageReset('resets 10:30pm ()', now), null);
});

test('a time not after now gives null', () => {
  assert.equal(usageReset('try again at Oct 21st, 2026 3:15 PM', evening), null);
  assert.equal(usageReset(`usage limit reached|${epoch('2026-10-22T19:00:00.000Z')}`, now), null);
  assert.equal(usageReset(`usage limit reached|${epoch(now.toISOString())}`, now), null);
  assert.equal(usageReset('try again in 0 minutes', now), null);
});

test('a bare time of day more than 12 hours ahead gives null', () => {
  // 7:30 PM has passed; its next occurrence is 23.5 hours away.
  assert.equal(usageReset('try again at 7:30 PM', evening), null);
  assert.equal(usageReset('resets 9am', evening), null);
  // 8:00 AM in Tokyo: the next 7 AM there is 23 hours away.
  assert.equal(usageReset('resets 7am (Asia/Tokyo)', new Date('2026-10-22T23:00:00.000Z')), null);
});

test('any time more than 8 days ahead gives null', () => {
  assert.equal(usageReset('try again in 8 days 1 minute', now), null);
  assert.equal(usageReset('try again at Nov 1st, 2026 3:15 PM', evening), null);
  assert.equal(usageReset(`usage limit reached|${epoch('2026-10-31T20:00:00.000Z')}`, now), null);
});

test('a reported reset time up to 8 days ahead is its ISO time', () => {
  assert.equal(reportedReset(epoch('2026-10-22T23:00:00.000Z'), now), '2026-10-22T23:00:00.000Z');
  // A digit string works like a number.
  assert.equal(reportedReset(String(epoch('2026-10-22T23:00:00.000Z')), now), '2026-10-22T23:00:00.000Z');
  // The 12-hour limit is only for a bare time of day.
  assert.equal(reportedReset(epoch('2026-10-25T09:00:00.000Z'), now), '2026-10-25T09:00:00.000Z');
  // Eight days exactly is the furthest reset accepted.
  assert.equal(reportedReset(epoch('2026-10-30T20:00:00.000Z'), now), '2026-10-30T20:00:00.000Z');
  assert.equal(reportedReset(String(epoch('2026-10-30T20:00:00.000Z')), now), '2026-10-30T20:00:00.000Z');
});

test('a reported reset time not after now, or more than 8 days ahead, gives null', () => {
  assert.equal(reportedReset(epoch(now.toISOString()), now), null);
  assert.equal(reportedReset(epoch('2026-10-22T19:00:00.000Z'), now), null);
  assert.equal(reportedReset(String(epoch('2026-10-22T19:00:00.000Z')), now), null);
  assert.equal(reportedReset(epoch('2026-10-30T20:00:01.000Z'), now), null);
  assert.equal(reportedReset(String(epoch('2026-10-30T20:00:01.000Z')), now), null);
});

test('a missing or non-numeric reported reset time gives null', () => {
  const ahead = epoch('2026-10-22T23:00:00.000Z');
  for (const value of [null, undefined, NaN, Infinity, '', 'soon', `${ahead}s`, ` ${ahead}`, `-${ahead}`, -1, -ahead])
    assert.equal(reportedReset(value, now), null, String(value));
  assert.equal(reportedReset(ahead, new Date('not a time')), null);
});

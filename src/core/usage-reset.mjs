// When a CLI's usage limit resets, read from its limit message or checked from a time the CLI reports in
// its structured output. The result is an ISO time, or null when there is none this reads, or the time is
// invalid, past or implausibly far.
const minute = 60 * 1000,
  hour = 60 * minute,
  day = 24 * hour,
  units = { day, hour, minute };
// CLIs name a date for a later reset, so a bare time of day further away than this has already passed.
const bareAhead = 12 * hour,
  maxAhead = 8 * day;
const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const clock = String.raw`(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b`,
  month = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`;
const forms = {
  // Claude: "usage limit reached|<epoch seconds>".
  epoch: /usage limit reached\s*\|\s*(\d+)/i,
  relative: /try again in\s+((?:\d+\s*(?:days?|hours?|minutes?)\b[\s,]*(?:and\s+)?)+)/i,
  dated: new RegExp(
    String.raw`try again at\s+${month}\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4}),?\s+(?:at\s+)?${clock}`,
    'i',
  ),
  bare: new RegExp(String.raw`try again at\s+${clock}`, 'i'),
  // "resets 3am" or "resets 10:30pm (America/New_York)".
  resets: new RegExp(String.raw`\bresets\s+(?:at\s+)?${clock}(?:\s*\(([^)]*)\))?`, 'i'),
};

export function usageReset(message, now = new Date()) {
  const text = String(message ?? ''),
    at = new Date(now).getTime();
  if (!Number.isFinite(at)) return null;
  let time = null,
    bare = false,
    match;
  if ((match = text.match(forms.epoch))) return reportedReset(match[1], at);
  if ((match = text.match(forms.relative))) time = at + span(match[1]);
  else if ((match = text.match(forms.dated))) {
    const [, name, date, year, ...rest] = match,
      monthIndex = months.findIndex(prefix => name.toLowerCase().startsWith(prefix)),
      hours = hours24(...rest);
    if (hours === null) return null;
    const local = new Date(Number(year), monthIndex, Number(date), hours.hour, hours.minute);
    // Feb 30 would roll over into March.
    if (local.getMonth() !== monthIndex || local.getDate() !== Number(date)) return null;
    time = local.getTime();
  } else if ((match = text.match(forms.bare) || text.match(forms.resets))) {
    const hours = hours24(match[1], match[2], match[3]);
    if (hours === null) return null;
    bare = true;
    time = match[4] === undefined ? nextLocal(at, hours) : nextInZone(at, hours, match[4].trim());
  }
  return within(time, at, bare ? bareAhead : maxAhead);
}

// A reset time a CLI reports as epoch seconds, a number or a string of digits. A bare time of day's
// 12-hour limit does not apply.
export function reportedReset(seconds, now = new Date()) {
  const at = new Date(now).getTime(),
    epoch = typeof seconds === 'number' || (typeof seconds === 'string' && /^\d+$/.test(seconds));
  return epoch && Number.isFinite(at) ? within(Number(seconds) * 1000, at, maxAhead) : null;
}

// An ISO time, or null when `time` is invalid, not after `at` or more than `limit` ahead of it.
function within(time, at, limit) {
  return Number.isFinite(time) && time > at && time - at <= limit ? new Date(time).toISOString() : null;
}

// "2 hours 5 minutes" or "1 day, 3 hours and 30 minutes", in milliseconds.
function span(text) {
  let total = 0;
  for (const [, count, unit] of text.matchAll(/(\d+)\s*(day|hour|minute)/gi))
    total += Number(count) * units[unit.toLowerCase()];
  return total;
}

function hours24(hourText, minuteText = '0', meridiem) {
  const hour = Number(hourText),
    minute = Number(minuteText);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  return { hour: (hour % 12) + (meridiem.toLowerCase() === 'p' ? 12 : 0), minute };
}

// The next occurrence of a time of day after `at`, in the controller's local time zone.
function nextLocal(at, { hour, minute }) {
  const next = new Date(at);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= at) {
    next.setDate(next.getDate() + 1);
    next.setHours(hour, minute, 0, 0);
  }
  return next.getTime();
}

// The next occurrence of a time of day after `at` in an IANA zone; null when Intl does not know the zone.
function nextInZone(at, { hour, minute }, zone) {
  if (!zone) return null;
  let format;
  try {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  } catch {
    return null;
  }
  // The zone's wall clock at an instant, written as if it were UTC.
  const wall = time => {
    const part = Object.fromEntries(format.formatToParts(new Date(time)).map(item => [item.type, Number(item.value)]));
    return Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute, part.second);
  };
  const offset = time => wall(time) - Math.floor(time / 1000) * 1000,
    today = new Date(wall(at));
  for (const ahead of [0, 1]) {
    const guess = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + ahead, hour, minute);
    // A second pass settles a guess that crosses a daylight-saving change.
    const time = guess - offset(guess - offset(guess));
    if (time > at) return time;
  }
  return null;
}

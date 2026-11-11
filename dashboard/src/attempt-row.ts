// The story page's attempts row (the attempt strip above its tabs) in words: each build, or other work's own attempt,
// as its number and how it ended; then the review as a step of its own, naming the build it reviewed by that build's
// number; and under the row, the limit said once. Read only from the records the page already has: the story's
// attempts, its limit and its source stage. Nothing here renders or sends anything. Other views keep naming attempts
// with attemptName ("Build, attempt 1 of 3"), which this row no longer uses.
import type { AttemptSummary, Task } from './api';
import { plural, reviewOf, totalsOf } from './evidence';
import { countsTowardLimit, earlierCounted, isSourceStory, workLimit, type Stage } from './story';

const kindOf = (attempt?: AttemptSummary) => (attempt?.assignment as { kind?: string } | undefined)?.kind;
// A review of the work, a code story's or other work's independent review, as on the Agents page.
export const isReview = (attempt?: AttemptSummary) =>
  ['studio-development:change-review', 'general:review'].includes(kindOf(attempt) ?? '');

export type Tone = '' | 'ok' | 'bad' | 'you' | 'live';
export interface Chip {
  attempt: AttemptSummary;
  // A build's number among the attempts that count toward the limit, as the controller counts them; none for one that
  // used none of it, or for one of a flow's earlier rounds (earlier).
  number?: number;
  earlier?: true;
  // A review's: the number of the build it reviewed, when its record names that build.
  of?: number;
  // A build your send-back started: the number of the build whose review you overruled.
  after?: number;
  tone: Tone;
  // How it ended, as the chip says it after its number: "Tests failed", "You sent it back · passed".
  words: string;
}
export interface Row {
  // Every build (or work attempt) and every review, oldest first.
  builds: Chip[];
  reviews: Chip[];
  // The review step: the latest review, or, while a build newer than the one it reviewed runs or waits for its review,
  // when the next review comes instead, so an older verdict never reads as current.
  review?: Chip;
  waiting?: string;
  // The limit, said once under the row.
  limit: string;
}

const lower = (words: string) => words[0]!.toLowerCase() + words.slice(1);
const upper = (words: string) => words[0]!.toUpperCase() + words.slice(1);

// What a chip reads: "1 · Tests failed", "Of 3 · passed", or the ending alone for one that has no number.
export const chipText = (chip: Chip) => {
  const label = chipLabel(chip);
  return label ? `${label} · ${chip.words}` : chip.words;
};
export const chipLabel = (chip: Chip) => (chip.number ? String(chip.number) : chip.of ? `Of ${chip.of}` : undefined);

const statusWords: Record<string, [Tone, string]> = {
  stopping: ['live', 'Stopping'],
  review: ['you', 'Waiting for you'],
  failed: ['bad', 'Failed'],
  blocked: ['you', 'Stopped'],
  cancelled: ['', 'Cancelled'],
  interrupted: ['bad', 'Interrupted'],
  quarantined: ['bad', 'Quarantined'],
  uncertain: ['bad', 'Uncertain'],
  revision_requested: ['you', 'Sent back for changes'],
};

const testsFailed = (attempt: AttemptSummary) =>
  (totalsOf(attempt)?.fail ?? 0) > 0 || ((attempt.failedTests as unknown[] | undefined) ?? []).length > 0;

// How an attempt ended, before any number: an attempt that used none of the limit is named for what stopped it, in
// the order the attempt limit tells them apart; a build that ran its tests says how they went; the rest say their
// status.
function ending(attempt: AttemptSummary): [Tone, string] {
  if (attempt.status === 'running') return ['live', isReview(attempt) ? 'Running' : 'Running now'];
  if (attempt.status === 'stopping') return statusWords.stopping!;
  if (attempt.subscriptionHold) return ['', 'Stopped: usage limit'];
  if (attempt.question?.ask) return ['you', 'Asked you a question'];
  if (attempt.status === 'interrupted' && attempt.reconciledAt) return ['', 'Interrupted'];
  if (isReview(attempt)) {
    const { verdict } = reviewOf(attempt);
    if (attempt.status === 'accepted')
      return verdict === 'pass'
        ? ['ok', 'Passed']
        : verdict === 'needs-work'
          ? ['you', 'Asked for changes']
          : ['ok', 'Accepted'];
  } else {
    if (testsFailed(attempt)) return ['bad', 'Tests failed'];
    if (['accepted', 'review'].includes(attempt.status) && totalsOf(attempt)?.tests) return ['ok', 'Passed'];
    if (attempt.status === 'accepted')
      return (attempt.acceptedBy as { type?: string } | undefined)?.type === 'policy'
        ? ['ok', 'Accepted by house rules']
        : ['ok', 'Accepted'];
  }
  return statusWords[attempt.status] ?? ['', upper(attempt.status || 'Unknown')];
}

// The build a review reviewed, as the review recorded it: a code story's candidate, or other work's input.
export function reviewedBuild(review: AttemptSummary, builds: AttemptSummary[]) {
  const id =
    (review.candidateReview as { attemptId?: string } | undefined)?.attemptId ??
    (review.inputReferences as { attemptId?: string }[] | undefined)?.find(input =>
      builds.some(build => build.id === input.attemptId),
    )?.attemptId;
  return builds.find(build => build.id === id);
}

interface StageRecord extends Stage {
  history?: { candidate?: Stage['candidate']; review?: Stage['review'] }[];
  merge?: { candidateAttemptId?: string };
}

const checkFailed = (attempt: AttemptSummary) =>
  [
    ...((attempt.result as { checks?: { status?: string }[] } | undefined)?.checks ?? []),
    ...((attempt.controllerChecks as { status?: string }[] | undefined) ?? []),
  ].some(check => check.status === 'fail');

// The builds your send-back started, each with the candidate it followed. The house rules never retry a candidate
// whose review passed with no failing check, so the next build that counted was started by you sending it back,
// unless its integration stopped where a merge onto the current source may follow, which the house rules may start
// too. They retry a review that asked for changes only once they accepted it themselves, so after one you accepted
// the next build is yours as well; after one they accepted, the records do not say whether they retried it or you
// sent it back past their limit, so the build after it keeps its plain ending.
export function sentBack(task: Task, attempts: AttemptSummary[]) {
  const started = new Map<string, string>();
  if (!isSourceStory(task)) return started;
  const stage = (task.sourceStage ?? {}) as StageRecord,
    builds = attempts.filter(attempt => !isReview(attempt)),
    reviews = attempts.filter(isReview);
  for (const { candidate, review } of [
    ...(stage.history ?? []),
    ...(stage.candidate ? [{ candidate: stage.candidate, review: stage.review }] : []),
  ]) {
    const id = candidate?.attemptId,
      record =
        attempts.find(attempt => attempt.id === review?.attemptId) ??
        reviews.filter(item => item.status === 'accepted' && reviewedBuild(item, builds)?.id === id).at(-1);
    if (!id || !record) continue;
    const verdict = review?.verdict ?? reviewOf(record).verdict,
      returned = verdict === 'needs-work' && (record.acceptedBy as { type?: string } | undefined)?.type === 'director';
    if (!returned && (verdict !== 'pass' || checkFailed(record))) continue;
    const journal = record.sourceIntegration;
    if (
      stage.merge?.candidateAttemptId === id ||
      (journal?.state === 'rejected' && (journal.verification?.conflicts?.length || journal.verification?.landedSince))
    )
      continue;
    const at = attempts.findIndex(attempt => attempt.id === id),
      next = builds.find(build => attempts.indexOf(build) > at && countsTowardLimit(build));
    if (next) started.set(next.id, id);
  }
  return started;
}

const ordinals = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
export const ordinal = (n: number) =>
  ordinals[n - 1] ?? `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`;
const listed = (items: string[]) =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : (items[0] ?? '');

// The limit in words, once: what the house rules allow, and either what went past it (and, where the records say so,
// that you sent it back) or how many are used and left. "The house rules allow 2 automatic attempts. You sent it back
// after the second, which started the third."
export function limitLine(task: Task, builds: Chip[]) {
  const used = builds.filter(chip => chip.number).length,
    max = workLimit(task);
  if (!max) return `${used} ${plural(used, 'attempt')} used.`;
  const allow = `The house rules allow ${max} automatic ${plural(max, 'attempt')}.`,
    past = builds.filter(chip => (chip.number ?? 0) > max);
  if (past.length) {
    const unknown = past.filter(chip => !chip.after).map(chip => ordinal(chip.number!));
    return [
      allow,
      ...past
        .filter(chip => chip.after)
        .map(chip => `You sent it back after the ${ordinal(chip.after!)}, which started the ${ordinal(chip.number!)}.`),
      ...(unknown.length ? [`The ${listed(unknown)} went past that limit.`] : []),
    ].join(' ');
  }
  const left = max - used;
  return `${allow} ${
    !used
      ? 'None is used yet.'
      : !left
        ? `${max === 1 ? 'It is' : max === 2 ? 'Both are' : `All ${max} are`} used.`
        : `${used} ${plural(used, 'is', 'are')} used and ${left} ${plural(left, 'is', 'are')} left.`
  }`;
}

// The row from the story's attempts, in the order the page holds them.
export function attemptRow(task: Task, attempts: AttemptSummary[]): Row {
  const source = isSourceStory(task),
    stage = (task.sourceStage ?? {}) as StageRecord,
    work = attempts.filter(attempt => !isReview(attempt)),
    counted = work.filter(countsTowardLimit),
    // Counted as the controller counts them (its served attemptCount): a flow's earlier rounds come before the first.
    earlier = earlierCounted(task, counted.length),
    numberOf = (attempt?: AttemptSummary) => {
      const number = attempt ? counted.indexOf(attempt) + 1 - earlier : 0;
      return number > 0 ? number : undefined;
    },
    earlierRound = (attempt: AttemptSummary) => counted.indexOf(attempt) > -1 && counted.indexOf(attempt) < earlier,
    yours = sentBack(task, attempts);
  const builds = work.map((attempt): Chip => {
    const [tone, words] = ending(attempt),
      after = numberOf(work.find(build => build.id === yours.get(attempt.id))),
      // While it runs it says only that; how your send-back started it shows once it ended.
      ended = after && !['running', 'stopping'].includes(attempt.status);
    return {
      attempt,
      number: numberOf(attempt),
      ...(earlierRound(attempt) ? { earlier: true as const } : {}),
      ...(after ? { after } : {}),
      tone,
      words: ended ? `You sent it back · ${lower(words)}` : words,
    };
  });
  const reviews = attempts.filter(isReview).map((attempt): Chip => {
    const [tone, words] = ending(attempt),
      of = numberOf(reviewedBuild(attempt, work));
    return { attempt, of, tone, words: of ? lower(words) : words };
  });
  // A build newer than the one the latest review reviewed (or, when its record does not say, newer than that review)
  // that runs, or waits for its review: the candidate pinned for review, even one you accepted with failing tests, or
  // one whose tests did not fail, waiting for you to accept it or accepted while the review stage is current.
  const latest = reviews.at(-1),
    since = latest ? attempts.indexOf(reviewedBuild(latest.attempt, work) ?? latest.attempt) : -1,
    current = (task.stageState as { current?: string } | undefined)?.current,
    waits = (build: AttemptSummary) =>
      ['running', 'stopping'].includes(build.status) ||
      (build.status === 'accepted' && build.id === stage.candidate?.attemptId) ||
      (!testsFailed(build) && (build.status === 'review' || (build.status === 'accepted' && current === 'review'))),
    pending = (latest || source) && work.some(build => attempts.indexOf(build) > since && waits(build));
  return {
    builds,
    reviews,
    ...(pending ? { waiting: source ? "after it's built" : "after it's done" } : latest ? { review: latest } : {}),
    limit: limitLine(task, builds),
  };
}

// How many build chips the row shows before "N earlier".
export const latestBuilds = 4;
// The chips the row shows: the latest four builds and the review step's review, with how many earlier builds and
// reviews "N earlier" opens; every chip once it is open, or when the attempt shown is one of the earlier ones.
export function shownChips(row: Row, open: boolean, shownId?: string) {
  const earlierBuilds = row.builds.slice(0, -latestBuilds),
    earlierReviews = row.reviews.filter(chip => chip !== row.review),
    opened = open || [...earlierBuilds, ...earlierReviews].some(chip => chip.attempt.id === shownId);
  return opened
    ? { builds: row.builds, reviews: row.reviews, earlierBuilds: 0, earlierReviews: 0 }
    : {
        builds: row.builds.slice(-latestBuilds),
        reviews: row.review ? [row.review] : [],
        earlierBuilds: earlierBuilds.length,
        earlierReviews: earlierReviews.length,
      };
}

// The attempt shown, as the line under the row names it, with how it ended: "Build 3", "Review of build 3", "Build,
// not counted"; other work's are attempts.
export function shownName(task: Task, chip: Chip) {
  const work = isSourceStory(task) ? 'Build' : 'Attempt';
  return {
    name: isReview(chip.attempt)
      ? chip.of
        ? `Review of ${lower(work)} ${chip.of}`
        : 'Review'
      : chip.number
        ? `${work} ${chip.number}`
        : chip.earlier
          ? `${work}, earlier round`
          : `${work}, not counted`,
    words: upper(chip.words),
  };
}

// Releases (1.1 step 6, the canvas's Releases and milestone boards): a map of how the project's release lines fit
// together, then each line in its own row, newest first, with what it is for in words, its last release, what landed
// on it since and the milestones planned on it, each opening to its ideas, their stories and the ideas waiting to be
// sent, in order. Retired lines wait at the bottom, ready to be maintained again. New milestone, Release, Push and
// retiring a line act here; the controller decides what a version means and where its work lands, and Push asks every
// time, since it is the one thing that leaves this computer.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type CSSProperties, type FormEvent } from 'react';
import {
  getJSON,
  linesUrl,
  milestonesUrl,
  releasesUrl,
  send,
  type Milestone,
  type ReleaseLine,
  type ReleaseOverview,
  type ReleaseStory,
} from './api';
import { carryWords } from './carries';
import { Dialog } from './design/dialog';
import { Icon } from './design/icons';
import { Heading } from './layout';
import { useStudio } from './records';
import { byVersion, runOfTask, StoryReleaseChip } from './release-chip';
import type { StudioState } from './studio-runs';
import { useToast } from './toast';
import { useNarrow } from './use-narrow';

export function ReleasesPage({ projectId, milestone }: { projectId: string; milestone?: string }) {
  const { data, error } = useQuery({
    queryKey: ['releases', projectId],
    queryFn: ({ signal }) => getJSON<ReleaseOverview>(releasesUrl(projectId), signal),
  });
  if (error) return <p role="alert">The releases could not be loaded: {error.message}</p>;
  if (!data)
    return (
      <p role="status" className="sd-meta">
        Loading the releases…
      </p>
    );
  if (!data.available)
    return (
      <>
        <Heading title="Releases" lead="Release lines and milestones, for a project on a git repository." />
        <p className="sd-meta">{data.reason}</p>
      </>
    );
  return <Releases projectId={projectId} overview={data} opened={milestone} />;
}

// A change through the controller, then the page reads the releases again; a refusal is shown in its words.
function useReleaseAction(projectId: string) {
  const client = useQueryClient(),
    toast = useToast();
  return useMutation({
    mutationFn: ({
      url,
      body,
      method,
    }: {
      url: string;
      body: Record<string, unknown>;
      method?: 'POST' | 'PATCH';
      done?: string;
    }) => send(url, { projectId, ...body }, method),
    onSuccess: (_, { done }) => {
      if (done) toast(done);
      void client.invalidateQueries({ queryKey: ['releases', projectId] });
    },
    onError: error => toast(error.message),
  });
}

// Each line's own color, newest first, so its row and its track on the map read as one; a retired line is gray.
const lineColors = [
  'var(--brand)',
  'var(--live-dot)',
  'var(--line-amber)',
  'var(--agent-avery)',
  'var(--agent-morgan)',
];
const colorOf = (line: ReleaseLine, maintained: ReleaseLine[]) =>
  line.state === 'retired' ? 'var(--wait-dot)' : lineColors[Math.max(0, maintained.indexOf(line)) % lineColors.length]!;
const tagVersion = (name?: string) => (name && /^v?\d+\.\d+\.\d+$/.test(name) ? name.replace(/^v/, '') : undefined);
// What a line holds, in a few words for the map and in a sentence for its row.
function lineWords(line: ReleaseLine, open: Milestone[]) {
  const [first, ...later] = open.map(item => item.version),
    coming = first ? `: ${first} next${later.length ? `, then ${later.join(', then ')}` : ''}` : '',
    major = /^release\/(\d+)\.x$/.exec(line.branch)?.[1],
    series = /^release\/(\d+\.\d+)$/.exec(line.branch)?.[1];
  if (line.state === 'retired')
    return {
      short: 'Retired',
      purpose: 'Retired. No new ideas land here, and fixes skip it; work already on it finishes, and its tags stay.',
    };
  if (line.newest)
    return {
      short: 'New features',
      purpose: `New features. Each minor or major release is made here${coming}.`,
    };
  if (major)
    return {
      short: `Releases of ${major}.x`,
      purpose: `Releases of ${major}.x, for anyone not moving to ${Number(major) + 1}. Its later minors and patches are made here${coming}.`,
    };
  return {
    short: `Fixes for ${series ?? line.branch}`,
    purpose: `Fixes only, for anyone still on ${series ?? line.branch}. Each ships as a patch${coming}.`,
  };
}

function Releases({ projectId, overview, opened }: { projectId: string; overview: ReleaseOverview; opened?: string }) {
  const [making, setMaking] = useState(false),
    { state } = useStudio(projectId),
    lines = overview.lines ?? [],
    newestFirst = [...lines].reverse(),
    maintained = newestFirst.filter(line => line.state !== 'retired'),
    retired = newestFirst.filter(line => line.state === 'retired'),
    milestones = overview.milestones ?? [],
    newest = lines.find(line => line.newest)?.branch ?? null,
    openOn = (line: ReleaseLine) =>
      milestones.filter(item => item.state === 'open' && (item.line ?? newest) === line.branch).sort(byVersion),
    released = milestones.filter(item => item.state === 'released').reverse();
  return (
    <div className="sd-releases">
      <Heading
        title="Releases"
        lead="Each line is a branch that ships its own releases. The map shows how your lines fit together; below it, each line shows what it is for, its milestones and what has landed since its last release."
        tools={
          <button type="button" className="sd-btn sd-btn--primary" onClick={() => setMaking(true)}>
            <Icon name="plus" size={18} weight={2.4} />
            New milestone
          </button>
        }
      />
      {lines.length > 0 && <LineMap lines={newestFirst} maintained={maintained} milestones={milestones} />}
      <section className="sd-card sd-releases__copy" aria-label="Your copy and the remote">
        <div>
          <span className="sd-eyebrow">Your copy</span>
          <span className="sd-releases__row">
            {overview.copy?.branch ? (
              <span className="sd-branch">{overview.copy.branch}</span>
            ) : (
              'No branch checked out'
            )}
            <span className={`sd-chip ${overview.copy?.clean ? 'sd-chip--ok' : 'sd-chip--you'}`}>
              <span className="sd-chip__dot"></span>
              {overview.copy?.clean ? 'No uncommitted files' : 'Uncommitted files'}
            </span>
          </span>
          <span className="sd-meta">The folder you work in. The studio never changes its branch.</span>
        </div>
        <div>
          <span className="sd-eyebrow">{overview.remote?.name ?? 'Remote'}</span>
          {overview.remote ? (
            <>
              <span className="sd-releases__mono">{overview.remote.url}</span>
              <span className="sd-meta">{remoteLine(lines)}</span>
            </>
          ) : (
            <span className="sd-meta">This repository has no remote to push to, or several and none is origin.</span>
          )}
        </div>
        <div>
          <span className="sd-eyebrow">Push</span>
          <span className="sd-meta">
            Offered after each Release, and asked every time. It sends the line and its tag with your own git sign-in.
          </span>
        </div>
      </section>
      <div className="sd-rellines">
        {maintained.map(line => (
          <LineRow
            key={line.branch}
            projectId={projectId}
            line={line}
            color={colorOf(line, maintained)}
            newer={maintained.slice(0, maintained.indexOf(line)).map(item => item.branch)}
            milestones={openOn(line)}
            all={milestones}
            opened={opened}
            studio={state}
          />
        ))}
        {retired.length > 0 && <RetiredLines projectId={projectId} lines={retired} />}
      </div>
      {released.length > 0 && (
        <section className="sd-card sd-releases__released" aria-label="Released">
          <span className="sd-eyebrow">Released</span>
          {released.map(item => (
            <MilestoneCard
              key={item.id}
              projectId={projectId}
              milestone={item}
              all={milestones}
              opened={opened}
              studio={state}
              compact
            />
          ))}
        </section>
      )}
      <NewMilestone projectId={projectId} open={making} onClose={() => setMaking(false)} />
    </div>
  );
}

// What the remote is known to have of each line, as of the last fetch or push.
function remoteLine(lines: ReleaseLine[]) {
  const parts = lines.map(line =>
    !line.onRemote?.known
      ? `${line.branch} is not on it yet`
      : line.onRemote.ahead
        ? `${line.branch} has ${line.onRemote.ahead} commit${line.onRemote.ahead === 1 ? '' : 's'} it does not`
        : `${line.branch} is up to date`,
  );
  return `${parts.join('; ')}, as of the last fetch or push.`;
}

interface Station {
  version: string;
  name: string;
  kind: 'released' | 'open' | 'planned';
}
// The map's rows, newest line first: each line's releases and open milestones in time order, where it was made from,
// and the newer line its fixes are carried up to. The versions lines were made from are releases on the newest line.
function mapRows(lines: ReleaseLine[], maintained: ReleaseLine[], milestones: Milestone[]) {
  const newest = lines.find(line => line.newest)?.branch ?? null,
    forks = lines.filter(line => !line.newest).map(line => tagVersion(line.from)),
    rows = lines.map((line, index) => {
      const own = (item: Milestone) => (item.line ?? newest) === line.branch,
        from = line.newest ? undefined : tagVersion(line.from),
        releasedVersions = new Set(
          milestones.filter(item => own(item) && item.state === 'released').map(item => item.version),
        );
      if (line.lastRelease) releasedVersions.add(line.lastRelease.version);
      if (line.newest) for (const fork of forks) if (fork) releasedVersions.add(fork);
      if (from) releasedVersions.delete(from);
      const open = milestones.filter(item => own(item) && item.state === 'open').sort(byVersion),
        stations: Station[] = [
          ...[...releasedVersions].map(version => ({ version, name: `v${version}`, kind: 'released' as const })),
          ...(line.state === 'retired'
            ? []
            : open.map((item, place) => ({
                version: item.version,
                name: item.version,
                kind: place === 0 ? ('open' as const) : ('planned' as const),
              }))),
        ].sort(byVersion),
        at = from ?? stations[0]?.version,
        carry = line.state === 'retired' || line.newest ? undefined : maintained[maintained.indexOf(line) - 1]?.branch;
      return {
        line,
        words: lineWords(line, open),
        color: colorOf(line, maintained),
        stations,
        fork: !line.newest && at && index > 0 ? { version: at, rows: index } : undefined,
        carry,
      };
    });
  const slots = [...new Set(rows.flatMap(row => [...row.stations.map(item => item.version), row.fork?.version]))]
    .filter((version): version is string => !!version)
    .map(version => ({ version }))
    .sort(byVersion)
    .map(item => item.version);
  return { rows, slots };
}

// The map's columns at their narrowest, in pixels: the line's name, each release slot and where its fixes go. On a
// phone the rows are as wide as these add up to, so the map scrolls sideways only when they do not fit; above the
// break they are at least 760px wide.
const nameMin = 150,
  slotMin = 84,
  carryMin = 120,
  wideMin = 760;

// How the lines fit together: time runs left to right, each line a track in its own color, made from a release on the
// newest line, with its releases filled, its open milestone ringed and later ones dashed; a fix is carried up to the
// next newer line. A retired line is gray and stops.
function LineMap({
  lines,
  maintained,
  milestones,
}: {
  lines: ReleaseLine[];
  maintained: ReleaseLine[];
  milestones: Milestone[];
}) {
  const narrow = useNarrow(),
    { rows, slots } = mapRows(lines, maintained, milestones),
    count = Math.max(1, slots.length),
    columns = `minmax(${nameMin}px, 200px) repeat(${count}, minmax(${slotMin}px, 1fr)) minmax(${carryMin}px, 150px)`,
    minWidth = narrow ? nameMin + slotMin * count + carryMin : wideMin,
    column = (version: string) => slots.indexOf(version) + 2;
  return (
    <section className="sd-card sd-linemap" aria-label="How your lines fit together">
      <div className="sd-linemap__text">
        <h2 className="sd-linemap__title">How your lines fit together</h2>
        <p>
          Time runs left to right. The newest line gets new features, and its next release is a minor or a major. When
          people on a released version need a fix, a release line is made from that version’s tag. The fix lands there
          and ships as a patch, then it is carried up to every newer line, so nobody loses it when they upgrade.
        </p>
      </div>
      <div className="sd-linemap__scroll">
        <div className="sd-linemap__rows" style={{ minWidth }}>
          {rows.map(row => {
            const start = row.fork ? column(row.fork.version) : row.stations[0] ? column(row.stations[0].version) : 2,
              retiredLine = row.line.state === 'retired',
              end = retiredLine && row.stations.length ? column(row.stations.at(-1)!.version) : slots.length + 1,
              span = end - start + 1;
            return (
              <div
                key={row.line.branch}
                className={`sd-linemap__row${retiredLine ? ' sd-linemap__row--retired' : ''}`}
                style={{ gridTemplateColumns: columns, '--line-color': row.color } as CSSProperties}
                role="group"
                aria-label={`${row.line.branch}, ${row.words.short}: ${
                  row.stations.map(item => `${item.name} ${item.kind}`).join(', ') || 'no releases yet'
                }${row.fork ? `; made from v${row.fork.version}` : ''}${row.carry ? `; fixes are carried up to ${row.carry}` : ''}`}
              >
                <span className="sd-linemap__label" style={{ gridColumn: 1 }}>
                  <i className="sd-linemap__swatch" aria-hidden="true"></i>
                  <span>
                    <b>{row.line.branch}</b>
                    <span>{row.words.short}</span>
                  </span>
                </span>
                <span
                  className={`sd-linemap__track${retiredLine ? '' : ' sd-linemap__track--on'}`}
                  style={{ gridColumn: `${start} / ${end + 1}`, '--span': span } as CSSProperties}
                  aria-hidden="true"
                ></span>
                {row.fork && (
                  <span
                    className="sd-linemap__fork"
                    style={{ gridColumn: start, '--rows': row.fork.rows } as CSSProperties}
                    aria-hidden="true"
                  ></span>
                )}
                {row.stations.map(item => (
                  <span
                    key={item.version}
                    className={`sd-linemap__stn sd-linemap__stn--${item.kind}`}
                    style={{ gridColumn: column(item.version) }}
                    aria-hidden="true"
                  >
                    <i></i>
                    <b>{item.name}</b>
                    {item.kind !== 'released' && <span>{item.kind}</span>}
                  </span>
                ))}
                {(row.carry || retiredLine) && (
                  <span className="sd-linemap__carry" style={{ gridColumn: slots.length + 2 }} aria-hidden="true">
                    {retiredLine ? (
                      'fixes skip it'
                    ) : (
                      <>
                        <Icon name="up" size={14} weight={2.2} />
                        fixes go up to {row.carry}
                      </>
                    )}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="sd-linemap__key" aria-label="Key">
        <span>
          <i className="sd-linemap__dot sd-linemap__dot--released"></i>Released, with its tag
        </span>
        <span>
          <i className="sd-linemap__dot sd-linemap__dot--open"></i>Open: new work lands here now
        </span>
        <span>
          <i className="sd-linemap__dot sd-linemap__dot--planned"></i>Planned
        </span>
        <span>
          <Icon name="up" size={14} weight={2.2} />A fix carried up to a newer line
        </span>
        <span>
          <i className="sd-linemap__dot sd-linemap__dot--retired"></i>Retired: no new ideas, and fixes skip it
        </span>
      </div>
    </section>
  );
}

function LineRow({
  projectId,
  line,
  color,
  newer,
  milestones,
  all,
  opened,
  studio,
}: {
  projectId: string;
  line: ReleaseLine;
  color: string;
  newer: string[];
  milestones: Milestone[];
  all: Milestone[];
  opened?: string;
  studio: StudioState | null;
}) {
  const action = useReleaseAction(projectId),
    [retiring, setRetiring] = useState(false),
    words = lineWords(line, milestones);
  return (
    <section className="sd-relline" aria-label={line.branch} style={{ '--line-color': color } as CSSProperties}>
      <div className="sd-relline__head">
        <span className="sd-branch sd-branch--big">
          <i className="sd-linemap__swatch" aria-hidden="true"></i>
          {line.branch}
        </span>
        <span className={`sd-chip ${line.newest ? 'sd-chip--brand' : 'sd-chip--outline'}`}>
          {line.newest ? 'Newest line' : 'Maintained'}
        </span>
        <span className="sd-meta">
          {line.from ? `Made from ${line.from}` : line.newest ? 'Where new releases are made' : ''}
        </span>
        {!line.newest && (
          <button
            type="button"
            className="sd-btn sd-btn--ghost sd-btn--sm sd-relline__retire"
            onClick={() => setRetiring(true)}
          >
            Retire this line…
          </button>
        )}
      </div>
      <p className="sd-relline__purpose">{words.purpose}</p>
      <div className="sd-relline__body">
        <div className="sd-relline__side">
          <span className="sd-releases__row">
            <span className="sd-meta">Last release</span>
            {line.lastRelease ? (
              <span className="sd-rel">
                <Icon name="tag" size={13} weight={2.2} />
                {line.lastRelease.name}
              </span>
            ) : (
              <span className="sd-meta">none yet</span>
            )}
          </span>
          {line.landed && (
            <div className="sd-relline__landed">
              <span className="sd-eyebrow">Landed since {line.lastRelease?.name ?? 'the start'}</span>
              <span className="sd-meta">
                {line.landed.studio + line.landed.hand === 0
                  ? 'Nothing yet.'
                  : `${line.landed.studio} through the studio · ${line.landed.hand} by hand${line.landed.more ? ' (the latest 500)' : ''}`}
              </span>
              {line.landed.commits.slice(0, 5).map(commit => (
                <span key={commit.commit} className="sd-storyrow">
                  <span className={`sd-chip ${commit.studio ? 'sd-chip--ok' : 'sd-chip--outline'}`}>
                    {commit.studio ? 'Studio' : 'By hand'}
                  </span>
                  <span className="sd-storyrow__title">{commit.subject}</span>
                </span>
              ))}
            </div>
          )}
          {newer.length > 0 && (
            <p className="sd-relline__carry">
              <Icon name="up" size={16} weight={2.2} />
              Each fix here is carried up to {[...newer].reverse().join(', then ')}.
            </p>
          )}
        </div>
        <div className="sd-relline__milestones">
          {milestones.length === 0 && <p className="sd-meta">No open milestone on this line.</p>}
          {milestones.map(item => (
            <MilestoneCard
              key={item.id}
              projectId={projectId}
              milestone={item}
              all={all}
              opened={opened}
              studio={studio}
            />
          ))}
        </div>
      </div>
      <Dialog
        open={retiring}
        label={`Retire ${line.branch}`}
        busy={action.isPending}
        onClose={() => setRetiring(false)}
      >
        <h2 className="sd-dialog__title">Retire {line.branch}?</h2>
        <p>
          No new idea lands on it, and fixes carried forward skip it. Work already on it finishes, and its releases and
          tags stay. You can maintain it again from the bottom of this page.
        </p>
        <div className="sd-dialog__actions">
          <button
            type="button"
            className="sd-btn sd-btn--primary"
            disabled={action.isPending}
            onClick={() =>
              action.mutate(
                {
                  url: linesUrl(projectId),
                  body: { branch: line.branch, retired: true },
                  method: 'PATCH',
                  done: `${line.branch} is retired.`,
                },
                { onSuccess: () => setRetiring(false) },
              )
            }
          >
            Retire it
          </button>
          <button
            type="button"
            className="sd-btn sd-btn--ghost"
            disabled={action.isPending}
            onClick={() => setRetiring(false)}
          >
            Not now
          </button>
        </div>
      </Dialog>
    </section>
  );
}

function RetiredLines({ projectId, lines }: { projectId: string; lines: ReleaseLine[] }) {
  const action = useReleaseAction(projectId);
  return (
    <section className="sd-relline sd-relline--retired" aria-label="Retired lines">
      <span className="sd-eyebrow">Retired lines</span>
      {lines.map(line => (
        <div key={line.branch} className="sd-relline__retiredrow">
          <span className="sd-branch">
            <i className="sd-linemap__swatch" style={{ background: 'var(--wait-dot)' }} aria-hidden="true"></i>
            {line.branch}
          </span>
          <span className="sd-chip">Retired</span>
          <span className="sd-relline__retiredtext">
            {line.lastRelease ? `Its last release, ${line.lastRelease.name}, and its tags stay. ` : ''}No new ideas land
            here, and fixes skip it; work already on it finishes.
          </span>
          <button
            type="button"
            className="sd-btn sd-btn--sm"
            disabled={action.isPending}
            onClick={() =>
              action.mutate({
                url: linesUrl(projectId),
                body: { branch: line.branch, retired: false },
                method: 'PATCH',
                done: `${line.branch} is maintained again.`,
              })
            }
          >
            Maintain it again
          </button>
        </div>
      ))}
    </section>
  );
}

// How a story reads in a milestone: where it stands, then what became of it on newer lines.
function storyChip(story: ReleaseStory): [string, string] {
  if (story.integration === 'integrated') return ['sd-chip--ok', 'Integrated'];
  if (story.status === 'review') return ['sd-chip--you', 'In review'];
  if (story.started) return ['sd-chip--live', 'Being built'];
  if (story.status === 'ready') return ['', 'Ready'];
  return ['', story.status];
}
// A story in a milestone; one that has not started carries its release chip, to move it from here. Its carries read
// as on its page, a story one waits for by its title when the page holds it.
function StoryRow({
  projectId,
  story,
  studio,
}: {
  projectId: string;
  story: ReleaseStory;
  studio: StudioState | null;
}) {
  const [tone, label] = storyChip(story),
    task = !story.started ? studio?.tasks.find(item => item.id === story.id) : undefined,
    titleOf = (id: string) => studio?.tasks.find(item => item.id === id)?.title;
  return (
    <span className="sd-storyrow">
      <span className={`sd-chip ${tone}`}>{label}</span>
      <Link className="sd-storyrow__title" to="/p/$projectId/tasks/$taskId" params={{ projectId, taskId: story.id }}>
        {story.title}
      </Link>
      {task && studio && (
        <StoryReleaseChip
          projectId={projectId}
          task={task}
          run={runOfTask(studio.runs, task.id)}
          tasks={studio.tasks}
          attempts={studio.attempts}
          compact
        />
      )}
      {story.carries.length > 0 && (
        <span className="sd-meta">{story.carries.map(carry => carryWords(carry, titleOf)).join(' · ')}</span>
      )}
    </span>
  );
}

function MilestoneCard({
  projectId,
  milestone,
  all,
  opened,
  studio,
  compact,
}: {
  projectId: string;
  milestone: Milestone;
  all: Milestone[];
  opened?: string;
  studio: StudioState | null;
  compact?: boolean;
}) {
  const action = useReleaseAction(projectId),
    [writing, setWriting] = useState(false),
    [releasing, setReleasing] = useState(false),
    [pushing, setPushing] = useState(false),
    base = `${milestonesUrl(projectId)}/${encodeURIComponent(milestone.id)}`,
    release = milestone.release,
    { counts } = milestone,
    done = counts.stories ? Math.round((counts.integrated / counts.stories) * 100) : 0,
    working = counts.stories ? Math.round((counts.started / counts.stories) * 100) : 0,
    others = all.filter(item => item.state === 'open' && item.id !== milestone.id),
    isOpen = opened === milestone.id || opened === milestone.version;
  return (
    <article
      className={`sd-milestone${milestone.state === 'released' ? ' sd-milestone--released' : ''}`}
      id={milestone.id}
    >
      <div className="sd-milestone__head">
        <span className="sd-milestone__version">{milestone.version}</span>
        <span className={`sd-chip ${milestone.state === 'released' ? 'sd-chip--ok' : 'sd-chip--live'}`}>
          <span className="sd-chip__dot"></span>
          {milestone.state === 'released' ? 'Released' : 'Open'}
        </span>
        <span className="sd-meta">{releaseKind(milestone.version)}</span>
      </div>
      {milestone.goal && <p className="sd-milestone__goal">{milestone.goal}</p>}
      {!compact && (
        <>
          <span className="sd-bar" aria-hidden="true">
            <i className="sd-bar__part sd-bar__part--ok" style={{ width: `${done}%` }}></i>
            <i className="sd-bar__part sd-bar__part--live" style={{ width: `${working}%` }}></i>
          </span>
          <span className="sd-meta">
            {counts.ideas} idea{counts.ideas === 1 ? '' : 's'} sent · {counts.stories} stor
            {counts.stories === 1 ? 'y' : 'ies'} · {counts.integrated} integrated · {counts.waiting} waiting
          </span>
          <details className="sd-milestone__inside" open={isOpen || undefined}>
            <summary>Its ideas and their stories</summary>
            {milestone.ideas.map(idea => (
              <div key={idea.runId} className="sd-ideablock">
                <Link
                  className="sd-ideablock__idea"
                  to="/p/$projectId/runs/$runId"
                  params={{ projectId, runId: idea.runId }}
                >
                  “{idea.idea}”
                </Link>
                {idea.stories.map(story => (
                  <StoryRow key={story.id} projectId={projectId} story={story} studio={studio} />
                ))}
                {idea.stories.length === 0 && <span className="sd-meta">No stories planned yet.</span>}
                {idea.movedOut.map(story => (
                  <span key={story.id} className="sd-storyrow">
                    <span className="sd-chip sd-chip--outline">In {story.version ?? 'another release'}</span>
                    <Link
                      className="sd-storyrow__title"
                      to="/p/$projectId/tasks/$taskId"
                      params={{ projectId, taskId: story.id }}
                    >
                      {story.title}
                    </Link>
                  </span>
                ))}
              </div>
            ))}
            {milestone.movedIn.length > 0 && (
              <div className="sd-ideablock">
                <span className="sd-meta">Stories moved here from other ideas</span>
                {milestone.movedIn.map(story => (
                  <StoryRow key={story.id} projectId={projectId} story={story} studio={studio} />
                ))}
              </div>
            )}
            {milestone.ideas.length === 0 && milestone.movedIn.length === 0 && (
              <p className="sd-meta">Nothing sent to {milestone.version} yet.</p>
            )}
            {milestone.state === 'open' && (
              <div className="sd-ideablock sd-ideablock--waiting">
                <span className="sd-eyebrow">Waiting to be sent, in order</span>
                {milestone.waiting.length === 0 && <span className="sd-meta">No ideas waiting.</span>}
                {milestone.waiting.map((waiting, index) => (
                  <div key={waiting.id} className="sd-waitrow">
                    <span className="sd-waitrow__place">{index + 1}</span>
                    <span className="sd-waitrow__idea">{waiting.idea}</span>
                    <button
                      type="button"
                      className="sd-btn sd-btn--icon sd-btn--sm"
                      aria-label="Move up"
                      disabled={index === 0 || action.isPending}
                      onClick={() =>
                        action.mutate({ url: `${base}/ideas/${waiting.id}/order`, body: { index: index - 1 } })
                      }
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="sd-btn sd-btn--icon sd-btn--sm"
                      aria-label="Move down"
                      disabled={index === milestone.waiting.length - 1 || action.isPending}
                      onClick={() =>
                        action.mutate({ url: `${base}/ideas/${waiting.id}/order`, body: { index: index + 1 } })
                      }
                    >
                      ↓
                    </button>
                    {others.length > 0 && (
                      <select
                        aria-label="Move to another milestone"
                        value=""
                        disabled={action.isPending}
                        onChange={event =>
                          event.target.value &&
                          action.mutate({
                            url: `${base}/ideas/${waiting.id}/move`,
                            body: { milestone: event.target.value },
                            done: `Moved to ${others.find(item => item.id === event.target.value)?.version}.`,
                          })
                        }
                      >
                        <option value="">Move to…</option>
                        {others.map(item => (
                          <option key={item.id} value={item.id}>
                            {item.version}
                          </option>
                        ))}
                      </select>
                    )}
                    <button
                      type="button"
                      className="sd-btn sd-btn--sm"
                      disabled={action.isPending}
                      onClick={() =>
                        action.mutate({ url: `${base}/ideas/${waiting.id}/send`, body: {}, done: 'Sent to Mara.' })
                      }
                    >
                      Send now
                    </button>
                  </div>
                ))}
                <button type="button" className="sd-btn sd-btn--ghost sd-btn--sm" onClick={() => setWriting(true)}>
                  <Icon name="plus" size={16} weight={2.4} />
                  Write an idea into {milestone.version}
                </button>
              </div>
            )}
          </details>
        </>
      )}
      <div className="sd-milestone__actions">
        <ReleaseState release={release} projectId={projectId} />
        {milestone.state === 'open' && !release && (
          <button type="button" className="sd-btn sd-btn--sm" onClick={() => setReleasing(true)}>
            Release {milestone.version}…
          </button>
        )}
        {release && ['rejected', 'needs-reconciliation'].includes(release.state) && (
          <button
            type="button"
            className="sd-btn sd-btn--sm"
            disabled={action.isPending}
            onClick={() => action.mutate({ url: `${base}/release/again`, body: {}, done: 'Releasing again.' })}
          >
            Release again
          </button>
        )}
        {release?.state === 'released' && !release.pushed && (
          <button type="button" className="sd-btn sd-btn--primary sd-btn--sm" onClick={() => setPushing(true)}>
            Push…
          </button>
        )}
      </div>
      <WriteIdea
        open={writing}
        milestone={milestone}
        onClose={() => setWriting(false)}
        onWrite={idea =>
          action.mutate(
            { url: `${base}/ideas`, body: { idea }, done: `The idea waits in ${milestone.version}.` },
            { onSuccess: () => setWriting(false) },
          )
        }
        busy={action.isPending}
      />
      <ReleaseDialog
        open={releasing}
        milestone={milestone}
        busy={action.isPending}
        onClose={() => setReleasing(false)}
        onRelease={moveOpen =>
          action.mutate(
            { url: `${base}/release`, body: { moveOpen }, done: 'Mara is drafting the release notes.' },
            { onSuccess: () => setReleasing(false) },
          )
        }
      />
      <Dialog
        open={pushing}
        label={`Push ${milestone.version}`}
        busy={action.isPending}
        onClose={() => setPushing(false)}
      >
        <h2 className="sd-dialog__title">Push to the remote?</h2>
        <p>
          This sends the line and the tag {release?.tag} with your own git sign-in. It is the one thing in Studio desk
          that leaves this computer, so it asks every time. If git needs a password it stops rather than wait, and shows
          the command to run yourself.
        </p>
        <div className="sd-dialog__actions">
          <button
            type="button"
            className="sd-btn sd-btn--primary"
            disabled={action.isPending}
            onClick={() =>
              action.mutate(
                { url: `${base}/push`, body: { confirm: true }, done: `Pushed ${release?.tag}.` },
                { onSuccess: () => setPushing(false) },
              )
            }
          >
            Push
          </button>
          <button
            type="button"
            className="sd-btn sd-btn--ghost"
            disabled={action.isPending}
            onClick={() => setPushing(false)}
          >
            Not now
          </button>
        </div>
      </Dialog>
    </article>
  );
}

const releaseKind = (version: string) => {
  const [, minor, patch] = version.split('.').map(Number);
  return patch ? 'patch' : minor ? 'minor' : 'major';
};

// Where a milestone's release stands, in words.
function ReleaseState({ release, projectId }: { release?: Milestone['release']; projectId: string }) {
  if (!release) return null;
  if (release.state === 'drafting')
    return (
      <span className="sd-meta">
        Mara is drafting the notes.{' '}
        {release.notesTaskId && (
          <Link to="/p/$projectId/tasks/$taskId" params={{ projectId, taskId: release.notesTaskId }}>
            Read and approve them
          </Link>
        )}
      </span>
    );
  if (['ready', 'verifying', 'committing'].includes(release.state))
    return (
      <span className="sd-chip sd-chip--live">
        <span className="sd-chip__dot"></span>Releasing: building, testing and tagging
      </span>
    );
  if (release.state === 'released')
    return (
      <span className="sd-meta">
        Tagged {release.tag}
        {release.pushed ? ` · pushed to ${release.pushed.remote}` : ''}
      </span>
    );
  return (
    <span className="sd-meta" role="alert">
      The release stopped{release.error ? `: ${release.error}` : '.'}
    </span>
  );
}

function ReleaseDialog({
  open,
  milestone,
  busy,
  onClose,
  onRelease,
}: {
  open: boolean;
  milestone: Milestone;
  busy: boolean;
  onClose: () => void;
  onRelease: (moveOpen: boolean) => void;
}) {
  const unfinished = milestone.counts.stories - milestone.counts.integrated + milestone.counts.waiting,
    [moveOpen, setMoveOpen] = useState(true);
  return (
    <Dialog open={open} label={`Release ${milestone.version}`} busy={busy} onClose={onClose}>
      <h2 className="sd-dialog__title">Release {milestone.version}?</h2>
      <p>
        Mara drafts the notes from what was integrated, and you approve them before anything is written or tagged. Then
        the version is written, the line's build and tests run on it, and it is tagged.
      </p>
      {unfinished > 0 && (
        <label className="sd-releases__check">
          <input type="checkbox" checked={moveOpen} onChange={() => setMoveOpen(!moveOpen)} />
          <span>
            Move the open work ({unfinished} unfinished stor{unfinished === 1 ? 'y' : 'ies'} or waiting idea
            {unfinished === 1 ? '' : 's'}) to the next milestone on this line. A release ships nothing half-done.
          </span>
        </label>
      )}
      <div className="sd-dialog__actions">
        <button
          type="button"
          className="sd-btn sd-btn--primary"
          disabled={busy}
          onClick={() => onRelease(unfinished > 0 && moveOpen)}
        >
          Draft the notes
        </button>
        <button type="button" className="sd-btn sd-btn--ghost" disabled={busy} onClick={onClose}>
          Not yet
        </button>
      </div>
    </Dialog>
  );
}

function WriteIdea({
  open,
  milestone,
  busy,
  onClose,
  onWrite,
}: {
  open: boolean;
  milestone: Milestone;
  busy: boolean;
  onClose: () => void;
  onWrite: (idea: string) => void;
}) {
  const [idea, setIdea] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (idea.trim()) onWrite(idea.trim());
  };
  return (
    <Dialog open={open} label={`Write an idea into ${milestone.version}`} busy={busy} onClose={onClose}>
      <form className="sd-dialog__form" onSubmit={submit}>
        <h2 className="sd-dialog__title">Write an idea into {milestone.version}</h2>
        <div className="sd-field">
          <label className="sd-field__label" htmlFor={`idea-${milestone.id}`}>
            The idea, in plain words
          </label>
          <textarea
            id={`idea-${milestone.id}`}
            className="sd-input"
            rows={4}
            maxLength={4000}
            value={idea}
            onChange={event => setIdea(event.target.value)}
          />
          <span className="sd-meta">
            It waits in {milestone.version} until you send it, or until its line is free when sending waiting ideas is
            on.
          </span>
        </div>
        <div className="sd-dialog__actions">
          <button type="submit" className="sd-btn sd-btn--primary" disabled={busy || !idea.trim()}>
            Write it in
          </button>
          <button type="button" className="sd-btn sd-btn--ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function NewMilestone({ projectId, open, onClose }: { projectId: string; open: boolean; onClose: () => void }) {
  const action = useReleaseAction(projectId),
    [version, setVersion] = useState(''),
    [goal, setGoal] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    action.mutate(
      {
        url: milestonesUrl(projectId),
        body: { version: version.trim(), goal },
        done: `Milestone ${version.trim()} made.`,
      },
      { onSuccess: onClose },
    );
  };
  return (
    <Dialog open={open} label="New milestone" busy={action.isPending} onClose={onClose}>
      <form className="sd-dialog__form" onSubmit={submit}>
        <h2 className="sd-dialog__title">New milestone</h2>
        <div className="sd-field">
          <label className="sd-field__label" htmlFor="milestone-version">
            Version
          </label>
          <input
            id="milestone-version"
            className="sd-input"
            placeholder="1.2.0"
            autoComplete="off"
            value={version}
            onChange={event => setVersion(event.target.value)}
          />
          <span className="sd-meta">
            A patch (1.0.2) lands on its release line, made from the newest tag of its series when it is first needed. A
            minor or major release lands on the newest line; the first of a new major moves the older one to a line of
            its own.
          </span>
        </div>
        <div className="sd-field">
          <label className="sd-field__label" htmlFor="milestone-goal">
            Goal
          </label>
          <input
            id="milestone-goal"
            className="sd-input"
            placeholder="What this release is for, in a sentence"
            maxLength={2000}
            value={goal}
            onChange={event => setGoal(event.target.value)}
          />
        </div>
        <div className="sd-dialog__actions">
          <button type="submit" className="sd-btn sd-btn--primary" disabled={action.isPending || !version.trim()}>
            Make it
          </button>
          <button type="button" className="sd-btn sd-btn--ghost" disabled={action.isPending} onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

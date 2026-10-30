// The chat box (a preview behind the switch in chat-box.ts): a panel docked at the right of a project's pages, which
// New idea and Ctrl J open. The frame holds it outside the router's outlet, so it stays open from page to page and
// keeps what was typed. Empty, it holds Today's New idea box, which sends what Today's sends, and says where earlier
// talks are. Once its box sends an idea, it shows that idea's conversation with the planner, as the idea's page holds
// it, so the director answers, replies and makes the plan official from any page; New idea or Ctrl J brings the box
// back. On a phone it opens full screen over the page, with a back arrow in place of Hide.
import { Link } from '@tanstack/react-router';
import { useEffect, useId, useMemo, useState } from 'react';
import type { FinishedPage, Shell } from './api';
import { Icon } from './design/icons';
import { guideOf } from './first-run-guide';
import { IdeaConversation, planStepOf } from './idea-conversation';
import { firstSentence, runRecords } from './journey';
import { finishedState, useFinished, useStudio } from './records';
import { liveSummary, runStories, type StudioState } from './studio-runs';
import { agentLooks } from './today';
import { chatIdeaText, ideaIntake, TodayIdea } from './today-idea';
import { useNarrow } from './use-narrow';

// The frame's way to open one idea's conversation in the chat box by its run (the sidebar's list of talks): it opens
// the panel without raising its focus, then asks for the conversation; a request made before the panel shows waits
// for it.
let asked: string | null = null;
const openers = new Set<(runId: string) => void>();

export function openChatConversation(runId: string) {
  if (openers.size) for (const open of openers) open(runId);
  else asked = runId;
}

function onOpenConversation(open: (runId: string) => void) {
  openers.add(open);
  if (asked) {
    const runId = asked;
    asked = null;
    open(runId);
  }
  return () => {
    openers.delete(open);
  };
}

const sentLine = "Your idea is sent. The planner's reply will appear here.";

export function ChatPanel({
  projectId,
  accent,
  focus,
  onHide,
}: {
  projectId: string;
  // The project's color, as the frame shows it.
  accent: string;
  // Raised each time New idea or Ctrl J asks for the box: the cursor goes in it.
  focus: number;
  onHide: () => void;
}) {
  const { state, shell } = useStudio(projectId),
    finished = useFinished(projectId, 3),
    narrow = useNarrow(),
    title = useId(),
    // The idea whose conversation shows, with the project and the request for the box it was opened under: it shows
    // until New idea or Ctrl J asks for the box again.
    [talk, setTalk] = useState<{ projectId: string; runId: string; focus: number } | null>(null),
    runId = talk?.projectId === projectId && talk.focus === focus ? talk.runId : null;
  // Today's rule: the intake the project's work has, and a sample's suggested first ideas until it has one, counting
  // the live ideas and the first page of finished ones.
  const intake = state ? ideaIntake(state.organizationConfiguration?.taskKinds ?? []) : null,
    ideas = state
      ? liveSummary(state).stories.length +
        (shell && finished.data ? runStories(finishedState(shell, finished.data.pages.slice(0, 1))).length : 0)
      : 0,
    suggestions = ideas ? undefined : guideOf(projectId)?.suggestions,
    shown = !!(intake && shell);
  useEffect(() => {
    if (shown && !runId) document.getElementById(chatIdeaText)?.focus();
  }, [focus, shown, runId]);
  useEffect(() => onOpenConversation(runId => setTalk({ projectId, runId, focus })), [projectId, focus]);
  return (
    <aside className="sd-chat" aria-labelledby={title}>
      <div className="sd-chat__head">
        {narrow && (
          <button
            type="button"
            className="sd-btn sd-btn--ghost sd-btn--icon"
            aria-label="Back"
            title="Back"
            onClick={onHide}
          >
            <Icon name="back" size={20} weight={2.4} />
          </button>
        )}
        <h2 id={title} className="sd-chat__title">
          The chat box
        </h2>
        {!narrow && (
          <button type="button" className="sd-btn sd-btn--ghost sd-btn--sm" onClick={onHide}>
            Hide
          </button>
        )}
      </div>
      <div className="sd-chat__body">
        {!state ? (
          <p className="sd-meta">Loading the project…</p>
        ) : runId ? (
          <Talk projectId={projectId} runId={runId} state={state} shell={shell} finished={finished.data?.pages} />
        ) : intake && shell ? (
          <TodayIdea
            projectId={projectId}
            shell={shell}
            intake={intake}
            accent={accent}
            suggestions={suggestions}
            place="panel"
            onSent={runId => setTalk({ projectId, runId, focus })}
          />
        ) : (
          <p className="sd-meta">{state.project.name} takes no ideas: its work has no breakdown or planner.</p>
        )}
        {!runId && (
          <p className="sd-meta">
            Earlier talks sit under Ideas, each with its conversation, until you make them official.
          </p>
        )}
      </div>
    </aside>
  );
}

// One idea's conversation in the chat box, as the idea's page holds it: the idea among the live ones, or once it has
// finished among the first page of finished ones, its plan step found as the page finds it among the steps that are
// not stories, and the project's agent looks. Its title and a link to its page go above it. Until the records hold
// the idea and its plan step (its checks still run, or the stream has not caught up), one line says it is sent.
function Talk({
  projectId,
  runId,
  state,
  shell,
  finished,
}: {
  projectId: string;
  runId: string;
  state: StudioState;
  shell?: Shell;
  finished?: FinishedPage[];
}) {
  const live = liveSummary(state).stories.find(story => story.id === runId),
    found = useMemo(() => {
      if (live) return { run: live, records: state };
      if (!shell || !finished) return null;
      const records = finishedState(shell, finished),
        run = runStories(records).find(story => story.id === runId);
      return run ? { run, records } : null;
    }, [live, state, shell, finished, runId]),
    looks = useMemo(
      () => agentLooks(projectId, [...state.workers, ...(state.employeeDirectory ?? [])]),
      [projectId, state.workers, state.employeeDirectory],
    );
  const sent = (
    <p className="sd-meta" role="status">
      {sentLine}
    </p>
  );
  if (!found) return sent;
  const { run, records } = found,
    { nodes, stories, tasks } = runRecords(run, records),
    plan = planStepOf(
      nodes.flatMap(node => {
        const task = tasks.get(node.taskId);
        return task && !stories.includes(task) ? [task] : [];
      }),
    );
  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <b>{firstSentence(run.brief) || run.title}</b>
        <Link className="sd-link" to="/p/$projectId/runs/$runId" params={{ projectId, runId }}>
          Open the idea&apos;s page
        </Link>
      </div>
      {plan ? <IdeaConversation projectId={projectId} run={run} state={records} plan={plan} looks={looks} /> : sent}
    </>
  );
}

// The chat box (a preview behind the switch in chat-box.ts): a panel docked at the right of a project's pages, which
// New idea and Ctrl J open. The frame holds it outside the router's outlet, so it stays open from page to page and
// keeps what was typed. Empty, it holds Today's New idea box, which sends what Today's sends, and says where earlier
// talks are. On a phone it opens full screen over the page, with a back arrow in place of Hide.
import { useEffect, useId } from 'react';
import { Icon } from './design/icons';
import { guideOf } from './first-run-guide';
import { finishedState, useFinished, useStudio } from './records';
import { liveSummary, runStories } from './studio-runs';
import { chatIdeaText, ideaIntake, TodayIdea } from './today-idea';
import { useNarrow } from './use-narrow';

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
    title = useId();
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
    if (shown) document.getElementById(chatIdeaText)?.focus();
  }, [focus, shown]);
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
        ) : intake && shell ? (
          <TodayIdea
            projectId={projectId}
            shell={shell}
            intake={intake}
            accent={accent}
            suggestions={suggestions}
            place="panel"
          />
        ) : (
          <p className="sd-meta">{state.project.name} takes no ideas: its work has no breakdown or planner.</p>
        )}
        <p className="sd-meta">
          Earlier talks sit under Ideas, each with its conversation, until you make them official.
        </p>
      </div>
    </aside>
  );
}

// The first-run guide on a sample project's Today (the canvas's "No projects yet: the first run", its third
// step): four things to know, until the director hides it. Only this browser remembers that a project came from
// the first run and that its guide was hidden; without browser storage the guide does not show. While the
// project has no idea yet, Today's idea box offers the template's two suggestions.
import { useState } from 'react';

const key = (projectId: string) => `studio-first-run:${projectId}`;

export function markGuide(projectId: string, suggestions: string[]) {
  try {
    localStorage.setItem(key(projectId), JSON.stringify({ suggestions }));
  } catch {
    // Without browser storage the new project opens without the guide.
  }
}

export function guideOf(projectId: string): { suggestions: string[] } | null {
  try {
    const saved = JSON.parse(localStorage.getItem(key(projectId)) ?? 'null') as { suggestions?: unknown } | null;
    if (!saved) return null;
    return {
      suggestions: Array.isArray(saved.suggestions)
        ? saved.suggestions.filter((item): item is string => typeof item === 'string')
        : [],
    };
  } catch {
    return null;
  }
}

const tips = [
  {
    title: 'Your calls show up here, in orange.',
    detail: 'Only something you have to decide counts. A wait for a usage reset or for another story never does.',
    you: true,
  },
  { title: 'Every stop says what happened and what to do,', detail: 'beside the button that does it.' },
  { title: 'You can watch any agent work.', detail: 'Its trace shows every step, command and file it touched.' },
  {
    title: 'Bring your own work next.',
    detail: 'Add a repository or another kind of project with the + beside your projects.',
  },
];

export function FirstRunGuide({ projectId, sent }: { projectId: string; sent: boolean }) {
  const [shown, setShown] = useState(() => guideOf(projectId) !== null);
  if (!shown) return null;
  const hide = () => {
    try {
      localStorage.removeItem(key(projectId));
    } catch {
      // The guide hides for this visit either way.
    }
    setShown(false);
  };
  return (
    <section className="sd-card sd-sidecard sd-sidecard--roomy" aria-labelledby="first-run-guide">
      <div className="sd-section-head" style={{ justifyContent: 'space-between' }}>
        <h2 id="first-run-guide" className="sd-sidecard__title">
          Good to know
        </h2>
        <button type="button" className="sd-btn sd-btn--ghost sd-btn--sm" onClick={hide}>
          Hide this guide
        </button>
      </div>
      <p style={{ margin: 0, color: 'var(--ink-2)' }}>
        {sent
          ? 'Your first idea is on its way. The planner reads the project to plan it, and when the plan is ready it shows here as your call, in orange. That can take a few minutes; you can close this page and come back.'
          : 'Your project is ready. Send your first idea when you’re ready: the planner plans it, and you approve the plan before anyone starts.'}
      </p>
      <ol className="sd-numsteps">
        {tips.map((tip, index) => (
          <li key={index}>
            <span className={`sd-numsteps__num${tip.you ? ' sd-numsteps__num--you' : ''}`}>{index + 1}</span>
            <span className="sd-numsteps__text">
              <span>
                <b>{tip.title}</b> <span style={{ color: 'var(--ink-2)' }}>{tip.detail}</span>
              </span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

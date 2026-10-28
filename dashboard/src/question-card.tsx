// An agent's question to the director (1.2 step 2) as the pages show it: the card with who asked, on which story and
// when, whose call it is, the question and why, and the Answer box, the message box ideas are sent from. The box
// offers the agent's options as its suggestions, the recommended one marked, and the work's Auto mode, then sends
// the answer (or, in change mode, the director's answer in place of auto mode's) as the controller's recorded step.
import { useMutation } from '@tanstack/react-query';
import { Fragment, useId, useState, type ReactNode } from 'react';
import { send, type AttemptSummary, type Task } from './api';
import { AgentAvatar } from './design/avatar';
import { IdeaBox } from './design/idea-box';
import { agentState } from './faces';
import { projectColor } from './frame';
import { workerName } from './names';
import { answerBody, keptKinds, type Question } from './questions';
import type { StudioState } from './studio-runs';
import { agentLooks, when } from './today';

const listed = (words: string[]) =>
  words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : (words[0] ?? '');

// Whose call the question is: a kind always kept for the director, each kind named, or else the agent's own mark.
function whoseCall(name: string, question: Question) {
  const kinds = keptKinds(question.topics);
  if (kinds.length) return `Always your call: ${listed(kinds)}.`;
  return question.choice === 'inside-story'
    ? `${name} marked it a choice inside its story.`
    : `${name} marked it as your call.`;
}

// The question an attempt asked: the agent's face and name, the story, when it asked, whose call it is, the question
// and why. The Answer box, when the page shows one, goes inside it.
export function QuestionCard({
  projectId,
  state,
  task,
  attempt,
  children,
}: {
  projectId: string;
  state: StudioState;
  task: Task;
  attempt: AttemptSummary;
  children?: ReactNode;
}) {
  const workerId = attempt.workerId ?? task.workerId,
    name = workerName(state, workerId),
    // Every agent's face as the task page gives it: the project's agents, then the company's.
    look = agentLooks(projectId, [...state.workers, ...(state.employeeDirectory ?? [])]).get(workerId ?? ''),
    question: Question = attempt.question ?? {};
  return (
    <article className="sd-card sd-decision" aria-label={`${name}'s question`}>
      <div className="sd-decision__head">
        <span className="sd-chip sd-chip--you">
          <span className="sd-chip__dot"></span>
          Asked you a question
        </span>
        <span className="sd-meta sd-decision__time">{when(attempt.finishedAt)}</span>
      </div>
      <div className="sd-decision__heading">
        <h3 className="sd-decision__title">{task.title}</h3>
      </div>
      <div className="sd-message">
        {look && <AgentAvatar look={look} state={agentState(state, workerId, task)} size={36} />}
        <div className="sd-bubble" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-8)' }}>
          <span className="sd-meta">{name} asks</span>
          <div style={{ fontWeight: 700, textWrap: 'pretty' }}>{question.ask}</div>
          {question.why && <div style={{ textWrap: 'pretty' }}>{question.why}</div>}
        </div>
      </div>
      <p className="sd-meta" style={{ margin: 0 }}>
        {whoseCall(name, question)} Once you answer, {name} continues from its saved work. Asking used none of its
        attempts.
      </p>
      {children}
    </article>
  );
}

// The Answer box: the agent's options as suggestions, the recommended one marked, and the work's Auto mode as the
// controller runs it (the task's own choice, otherwise the Settings). Picking an option puts its label in the text,
// where the director can add to it; text that is exactly an option's label counts as that option, which answerBody
// sends while the label still starts the text. The answer posts to the task's answer, or in change mode its
// change-answer, with the records the controller changed; a refused one shows why and keeps the draft.
export function AnswerBox({
  projectId,
  state,
  task,
  attempt,
  change = false,
  onSent,
}: {
  projectId: string;
  state: StudioState;
  task: Task;
  // The attempt that asked; in change mode, the one whose question auto mode answered.
  attempt: AttemptSummary;
  change?: boolean;
  // The controller's answer, for the page's own message.
  onSent?: (result: Record<string, unknown>) => void;
}) {
  const textId = useId(),
    question: Question = attempt.question ?? {},
    options = question.options ?? [],
    labels = options.map(option => option.label),
    details = options.filter(option => option.detail),
    recommended = question.recommended,
    name = workerName(state, attempt.workerId ?? task.workerId),
    shown = typeof task.autoMode === 'boolean' ? task.autoMode : !!state.agentPermissions?.auto,
    index = state.projects.findIndex(project => project.id === projectId),
    [text, setText] = useState(''),
    [picked, setPicked] = useState<number | null>(null),
    [auto, setAuto] = useState<boolean | undefined>(),
    [error, setError] = useState('');
  const answer = useMutation({
    mutationFn: () =>
      send<Record<string, unknown>>(
        `/api/tasks/${encodeURIComponent(task.id)}/${change ? 'change-answer' : 'answer'}`,
        { projectId, attemptId: attempt.id, ...answerBody(question, picked, text, auto ?? shown, shown) },
      ),
    onSuccess: result => {
      setText('');
      setPicked(null);
      setAuto(undefined);
      onSent?.(result);
    },
    onError: failure => setError(failure.message),
  });
  return (
    <IdeaBox
      textId={textId}
      label={`Answer ${name}`}
      help={
        details.length
          ? details.map((option, place) => (
              <Fragment key={place}>
                {place > 0 && ' · '}
                <b>{option.label}</b> {option.detail}
              </Fragment>
            ))
          : undefined
      }
      placeholder="Pick an option, add to it, or answer in your own words."
      accent={projectColor(state.projects[index], index).background}
      text={text}
      onText={value => {
        const option = labels.indexOf(value);
        if (option >= 0) setPicked(option);
        setText(value);
        setError('');
      }}
      error={error}
      suggestions={labels}
      suggestionsLabel={`${name}'s options`}
      suggestionMark={typeof recommended === 'number' ? { index: recommended, label: 'Recommended' } : undefined}
      settings={[
        {
          kind: 'toggle',
          label: 'Auto mode',
          on: auto ?? shown,
          hint: "Claude agents run this story's work in auto mode: Claude Code's own classifier decides which commands they run, and auto mode answers their questions inside the story.",
          onChange: setAuto,
        },
      ]}
      sendLabel={change ? 'Change the answer' : `Send to ${name}`}
      note={change ? `Your answer replaces auto mode's, and ${name} reworks from its saved work.` : undefined}
      busy={answer.isPending}
      onSend={() => answer.mutate()}
    />
  );
}

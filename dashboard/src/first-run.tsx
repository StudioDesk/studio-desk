// No projects yet (v1.0 item 24, the canvas's "No projects yet: the first run"): the page whenever no project
// exists, on a fresh install and after the last project is deleted. First pick a kind of work. Code and Writing
// are templates bundled with the app that make a real project in the data folder, and Something else opens Create a
// project. Then set up the sample: its name, where its folder goes, the CLI its agents run on, and a first idea,
// written or picked from the template's two suggestions, or none yet. Only signed-in CLIs are listed, and one is
// enough (the director, October 22): a Claude-only user never sees Codex as missing.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useState, type ReactNode } from 'react';
import {
  getJSON,
  send,
  templatesUrl,
  type FirstRunTemplates,
  type FolderListing,
  type ProjectTemplate,
  type TemplateMember,
} from './api';
import { CLASSIC, pickNew, type AgentLook } from './design/agent-kit.js';
import { AgentAvatar } from './design/avatar';
import { Icon, Mark, type IconName } from './design/icons';
import { IdeaBox } from './design/idea-box';
import { Modal } from './dialog';
import { markGuide } from './first-run-guide';
import { FolderBrowser } from './folder-browser';
import { projectColor } from './frame';

const NewProjectDialog = lazy(() => import('./new-project').then(module => ({ default: module.NewProjectDialog })));

// What the page says about each kind of template; the controller's template supplies the name, files, team and
// suggestions. The steps name the template's team in its order: the planner, the one who does the work, the
// reviewer.
const kinds: Record<
  ProjectTemplate['kind'],
  {
    title: string;
    icon: IconName;
    chips: string[];
    lead: (chosen: boolean) => string;
    where: string;
    placeholder: string;
    steps: (team: string[]) => { title: string; detail: string; you?: boolean }[];
  }
> = {
  code: {
    title: 'Code',
    icon: 'code',
    chips: ['its own git repository', 'tests included'],
    lead: chosen =>
      `It’s a real git repository with a small library and its tests, ${chosen ? 'in a new folder inside the one you chose' : 'kept in your Studio desk data folder, so nothing else on your computer changes'}. You can change any of this later.`,
    where: 'A new git repository with one commit.',
    placeholder: 'For example: add a search box that finds items by name',
    steps: ([planner, maker, reviewer]) => [
      { title: `${planner} plans it`, detail: 'Reads the project and turns your idea into one or more stories.' },
      {
        title: 'You approve the plan',
        detail: 'Your only call in this run. Change or turn down any story first.',
        you: true,
      },
      {
        title: `${maker} makes the change and the tests run`,
        detail: 'In a copy of the repository, so nothing changes until it passes.',
      },
      {
        title: `${reviewer} reviews it, then it goes in`,
        detail: `A passing change is committed to the sample repository. A failing one goes back to ${maker} with the findings.`,
      },
    ],
  },
  writing: {
    title: 'Writing',
    icon: 'writing',
    chips: ['no git needed'],
    lead: chosen =>
      `A brief, notes and a style sheet, ${chosen ? 'in a new folder inside the one you chose' : 'kept in your Studio desk data folder'}. The finished piece comes back as a file you read in the app. You can change any of this later.`,
    where: 'No git needed.',
    placeholder: 'For example: a one-page checklist for a volunteer’s first day',
    steps: ([planner, maker, reviewer]) => [
      { title: `${planner} plans it`, detail: 'Reads the brief and notes and splits the job into steps.' },
      {
        title: 'You approve the plan',
        detail: 'Your only call in this run. Change or turn down any step first.',
        you: true,
      },
      {
        title: `${maker} writes the draft`,
        detail: 'Works from the brief and notes and hands the draft on with a summary.',
      },
      {
        title: `${reviewer} reviews it`,
        detail: `Can send it back to ${maker} with notes. A draft that passes is ready for you to read in the app.`,
      },
    ],
  },
};

// A team member's face: the one chosen for the agent, else the design's for its name, else the kit's pick.
const faceOf = (member: TemplateMember): AgentLook =>
  member.look ?? CLASSIC.find(agent => agent.name === member.name)?.look ?? pickNew(member.agentId);

// The frame without a project: the rail with Add a project, and a sidebar whose only page is this one.
function StartFrame({ connected, children }: { connected: boolean | null; children: ReactNode }) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="sd-app sd-ground">
      <div className="sd-frame">
        <nav className="sd-rail" aria-label="Projects">
          <Mark />
          <span className="sd-rail__rule" aria-hidden="true"></span>
          <button
            type="button"
            className="sd-rail__add"
            aria-label="Add a project"
            title="Add a project"
            onClick={() => setAdding(true)}
          >
            <Icon name="plus" weight={2.4} />
          </button>
        </nav>
        <aside className="sd-sidebar" aria-label="Studio desk">
          <div className="sd-sidebar__project">
            <span className="sd-eyebrow" style={{ fontSize: '10.5px' }}>
              Project
            </span>
            <span className="sd-sidebar__name sd-sidebar__name--none">None yet</span>
          </div>
          <nav aria-label="Main">
            <a className="sd-navlink" href="/" aria-current="page">
              <Icon name="plus" />
              Start a project
            </a>
          </nav>
          <div className="sd-status">
            <div className="sd-status__head">
              <span
                className={`sd-status__light${connected === false ? ' sd-status__light--offline' : connected === null ? ' sd-status__light--connecting' : ''}`}
                aria-hidden="true"
              ></span>
              {connected === false
                ? 'Controller unavailable'
                : connected === null
                  ? 'Connecting to your studio…'
                  : 'Controller connected'}
            </div>
            <div className="sd-meta">No projects yet · nothing running</div>
            <div className="sd-meta">Everything runs on this computer. Projects, records and files stay here.</div>
          </div>
        </aside>
      </div>
      <header className="sd-topbar">
        <Mark size={30} />
        <span className="sd-topbar__name">No projects yet</span>
      </header>
      <main className="sd-main">
        <div className="sd-page">{children}</div>
      </main>
      {adding && (
        <Suspense fallback={null}>
          <NewProjectDialog open onClose={() => setAdding(false)} />
        </Suspense>
      )}
    </div>
  );
}

// The CLIs the agents can run on: the signed-in ones to choose from, or how to sign in to one when none is. When a
// code project's tests will run on this computer, it says so once here (v1.0 item 25).
function CliCard({
  found,
  cli,
  onCli,
  checking,
  onCheck,
  unsandboxed,
}: {
  found: FirstRunTemplates['clis'];
  cli: string;
  onCli: (id: string) => void;
  checking: boolean;
  onCheck: () => void;
  unsandboxed: boolean;
}) {
  return (
    <section className="sd-card sd-sidecard sd-sidecard--roomy" aria-labelledby="start-cli">
      {found.length > 0 ? (
        <>
          <h2 id="start-cli" className="sd-sidecard__title">
            Your agents run on
          </h2>
          <div role="radiogroup" aria-labelledby="start-cli" className="sd-picks">
            {found.map(item => (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={item.id === cli}
                className="sd-pick"
                onClick={() => onCli(item.id)}
              >
                <span className="sd-pick__radio" aria-hidden="true"></span>
                <span className="sd-pick__name">{item.label}</span>
                <span className="sd-chip sd-chip--ok">
                  <span className="sd-chip__dot"></span>Signed in
                </span>
              </button>
            ))}
          </div>
          <p className="sd-meta" style={{ margin: 0 }}>
            {found.length > 1
              ? 'Both are signed in. Pick one for now; you can give each agent its own later.'
              : 'One signed-in CLI is enough. You can sign in to another any time.'}
          </p>
          {unsandboxed && (
            <p className="sd-meta" style={{ margin: 0 }}>
              A code project’s tests run on this computer, without a sandbox, with your account’s access to your files.
              A built-in sandbox is coming in an update.
            </p>
          )}
        </>
      ) : (
        <>
          <h2 id="start-cli" className="sd-sidecard__title">
            Connect an AI CLI
          </h2>
          <p style={{ margin: 0 }}>
            Install one of these and sign in with your subscription. <b>You need one, not both.</b>
          </p>
          <div className="sd-cliopt">
            <b>Claude Code</b>
            <span className="sd-meta">
              Sign in with a Claude subscription. Run this, then follow the sign-in it opens:
            </span>
            <span className="sd-file">claude</span>
          </div>
          <div className="sd-cliopt">
            <b>Codex CLI</b>
            <span className="sd-meta">Sign in with a ChatGPT subscription:</span>
            <span className="sd-file">codex login</span>
          </div>
          <button
            type="button"
            className="sd-btn sd-btn--sm"
            style={{ alignSelf: 'flex-start' }}
            disabled={checking}
            onClick={onCheck}
          >
            {checking ? 'Checking…' : 'Check again'}
          </button>
        </>
      )}
      <p className="sd-meta sd-sidecard__foot">
        Studio desk uses your CLI’s own sign-in. It never asks for an API key and never sends your usage anywhere.
      </p>
    </section>
  );
}

// 1. Pick a kind of work.
function Choose({
  answer,
  cli,
  onCli,
  checking,
  onCheck,
  onPick,
  onOwn,
}: {
  answer: FirstRunTemplates;
  cli: string;
  onCli: (id: string) => void;
  checking: boolean;
  onCheck: () => void;
  onPick: (template: ProjectTemplate) => void;
  onOwn: () => void;
}) {
  const noCli = answer.clis.length === 0;
  return (
    <>
      <header className="sd-pagehead">
        <div className="sd-pagehead__text">
          <div className="sd-eyebrow">{answer.firstRun ? 'Welcome to Studio desk' : 'No projects'}</div>
          <h1 className="sd-pagehead__title">
            {answer.firstRun ? 'Let’s start your first project.' : 'There are no projects right now.'}
          </h1>
          <p className="sd-pagehead__lead sd-start__lead">
            A project is one stream of work, like a code repository or a folder of writing. You say what you want in
            plain words. Agents plan it, do it and check each other’s work, and you approve what goes in. Try a small
            example first, or bring your own.
          </p>
        </div>
      </header>
      <div className="sd-columns">
        <section className="sd-columns__main" aria-labelledby="start-kinds">
          <h2 id="start-kinds" className="sd-section-title sd-section-title--sm">
            What kind of work do you want to try?
          </h2>
          {noCli && (
            <div className="sd-callout" role="status">
              <span className="sd-callout__text">
                <span className="sd-chip sd-chip--bad">
                  <span className="sd-chip__dot"></span>Connect one AI CLI first
                </span>
                <b style={{ display: 'block', marginTop: 'var(--space-8)' }}>
                  Your agents do their work through a command-line AI you’ve signed into with your own subscription.
                </b>
                <span className="sd-meta">Sign in to either Claude Code or Codex CLI, then press Check again.</span>
              </span>
            </div>
          )}
          <div className="sd-choices">
            {answer.templates.map(template => {
              const kind = kinds[template.kind],
                noGit = template.needsGit && !answer.git.found;
              return (
                <article key={template.id} className="sd-card sd-choice" aria-labelledby={`start-${template.id}`}>
                  <span className="sd-choice__glyph">
                    <Icon name={kind.icon} size={26} weight={2.2} />
                  </span>
                  <div className="sd-choice__body">
                    <h3 id={`start-${template.id}`} className="sd-choice__title">
                      {kind.title}
                    </h3>
                    <p className="sd-choice__text">{template.description}</p>
                  </div>
                  <div className="sd-choice__chips">
                    <span className="sd-chip">{template.files.length} files</span>
                    {kind.chips.map(chip => (
                      <span key={chip} className="sd-chip">
                        {chip}
                      </span>
                    ))}
                  </div>
                  <div className="sd-meta">
                    {template.team.map(member => `${member.name} ${member.does}`).join(' · ')}
                  </div>
                  {template.needsGit && (
                    <div className="sd-meta sd-choice__need">
                      <span
                        className={`sd-chip__dot sd-choice__needdot${noGit ? ' sd-choice__needdot--bad' : ''}`}
                      ></span>
                      {noGit ? 'Needs Git, which isn’t on this computer yet' : 'Needs Git, found on this computer'}
                    </div>
                  )}
                  <button
                    type="button"
                    className="sd-btn sd-btn--primary"
                    disabled={noCli || noGit}
                    onClick={() => onPick(template)}
                  >
                    Try the {kind.title.toLowerCase()} example
                  </button>
                </article>
              );
            })}
            <article className="sd-choice sd-choice--plain" aria-labelledby="start-own">
              <span className="sd-choice__glyph">
                <Icon name="folder" size={26} weight={2.2} />
              </span>
              <div className="sd-choice__body">
                <h3 id="start-own" className="sd-choice__title">
                  Something else
                </h3>
                <p className="sd-choice__text">
                  Skip the example. Add your own git repository, or start an empty project for any other work, with the
                  same agents and checks.
                </p>
              </div>
              <button type="button" className="sd-btn" onClick={onOwn}>
                Add a project
              </button>
            </article>
          </div>
          <p className="sd-meta" style={{ margin: 0 }}>
            An example is a real project, not a simulation: its first idea runs on your own sign-in. You can delete it
            like any other project.
          </p>
        </section>
        <aside className="sd-columns__side sd-start__side">
          <CliCard
            found={answer.clis}
            cli={cli}
            onCli={onCli}
            checking={checking}
            onCheck={onCheck}
            unsandboxed={answer.testSandbox === 'none'}
          />
        </aside>
      </div>
    </>
  );
}

// The sample's folder as the controller makes it (project-templates.mjs): a new folder named after the project
// inside the folder shown, numbered when a folder of that name is there already. In a chosen folder, those are the
// folders the browser listed in it; the data folder's samples hold none while there is no project, since deleting
// a project deletes its sample's folder there.
function sampleFolder(location: string, name: string, fallback: string, taken: string[] = []) {
  const slug =
      name
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
        .replace(/-+$/, '') || fallback,
    separator = location.includes('\\') ? '\\' : '/',
    names = new Set(taken.map(item => item.toLowerCase()));
  let folder = slug;
  for (let number = 2; names.has(folder); number++) folder = `${slug}-${number}`;
  return location.endsWith(separator) ? location + folder : location + separator + folder;
}

// 2. Set up the sample, then create it with or without a first idea.
function Setup({
  answer,
  template,
  cli,
  onCli,
  onBack,
}: {
  answer: FirstRunTemplates;
  template: ProjectTemplate;
  cli: string;
  onCli: (id: string) => void;
  onBack: () => void;
}) {
  const kind = kinds[template.kind],
    [name, setName] = useState(template.name),
    [idea, setIdea] = useState(''),
    // A folder the director chose for the sample, outside the data folder; none keeps the data folder's samples.
    [location, setLocation] = useState<FolderListing>(),
    [browsing, setBrowsing] = useState(false),
    queryClient = useQueryClient(),
    navigate = useNavigate(),
    cliLabel = answer.clis.find(item => item.id === cli)?.label ?? 'CLI',
    team = template.team.map(member => member.name),
    accent = projectColor(undefined, 0).background;
  const create = useMutation({
    mutationFn: (first: string | null) =>
      send<{ projectId: string; runId: string | null; folder: string }>('/api/projects/from-template', {
        template: template.id,
        name: name.trim(),
        cli,
        ...(location ? { location: location.path } : {}),
        ...(first ? { idea: first } : {}),
      }),
    onSuccess: async ({ projectId }) => {
      markGuide(projectId, template.suggestions);
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      void navigate({ to: '/p/$projectId', params: { projectId } });
    },
  });
  const busy = create.isPending,
    unnamed = !name.trim();
  return (
    <>
      <div>
        <button type="button" className="sd-btn sd-btn--ghost sd-btn--sm" onClick={onBack} disabled={busy}>
          <Icon name="back" size={16} weight={2.4} />
          Pick another kind of work
        </button>
      </div>
      <header className="sd-pagehead">
        <div className="sd-pagehead__text">
          <div className="sd-eyebrow">{kind.title} example</div>
          <h1 className="sd-pagehead__title">Here’s your sample project.</h1>
          <p className="sd-pagehead__lead sd-start__lead">{kind.lead(!!location)}</p>
        </div>
      </header>
      <div className="sd-columns">
        <div className="sd-columns__main">
          <IdeaBox
            textId="first-idea"
            label="Your first idea"
            help={`What should the agents do in ${name.trim() || 'the project'}? Write it in plain words, the way you would ask a person.`}
            placeholder={kind.placeholder}
            accent={accent}
            rows={3}
            text={idea}
            onText={setIdea}
            suggestions={template.suggestions}
            suggestionsLabel="Not sure? Start from one of these:"
            note={
              busy
                ? template.needsGit
                  ? 'Making the repository and running its tests once…'
                  : 'Making the project…'
                : `It runs on your ${cliLabel} sign-in and counts toward its usage, like any work you give it.`
            }
            error={create.error?.message ?? (unnamed ? 'Give the project a name first.' : undefined)}
            busy={busy || unnamed}
            sendLabel="Create the project and send this idea"
            secondaryLabel="Create the project only"
            onSecondary={() => create.mutate(null)}
            onSend={() => create.mutate(idea.trim())}
          />
          <section className="sd-card sd-sidecard sd-sidecard--roomy" aria-labelledby="start-next">
            <h2 id="start-next" className="sd-sidecard__title">
              What happens next
            </h2>
            <ol className="sd-numsteps">
              {kind.steps(team).map((step, index) => (
                <li key={index}>
                  <span className={`sd-numsteps__num${step.you ? ' sd-numsteps__num--you' : ''}`}>{index + 1}</span>
                  <span className="sd-numsteps__text">
                    <b>{step.title}</b>
                    <span className="sd-meta">{step.detail}</span>
                  </span>
                </li>
              ))}
            </ol>
            <div className="sd-meta" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' }}>
              <span className="sd-chip sd-chip--you">
                <span className="sd-chip__dot"></span>Orange
              </span>
              means it’s your turn. Nothing else will ask for you.
            </div>
          </section>
        </div>
        <aside className="sd-columns__side">
          <section className="sd-card sd-sidecard sd-sidecard--roomy" aria-labelledby="start-project">
            <h2 id="start-project" className="sd-sidecard__title">
              The project
            </h2>
            <div className="sd-field">
              <label className="sd-field__label" htmlFor="start-name">
                Name
              </label>
              <input
                id="start-name"
                className="sd-input"
                type="text"
                maxLength={100}
                value={name}
                disabled={busy}
                onChange={event => setName(event.target.value)}
              />
            </div>
            <div className="sd-field">
              <span className="sd-field__label" id="start-folder">
                Folder
              </span>
              <span className="sd-file sd-file--path" aria-labelledby="start-folder">
                {sampleFolder(
                  location?.path ?? answer.samples,
                  name,
                  template.id,
                  location?.folders.map(folder => folder.name),
                )}
              </span>
              <span className="sd-meta">
                {location
                  ? 'Deleting the project leaves this folder and its files where they are.'
                  : 'Deleting the project deletes this folder too.'}
              </span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                <button type="button" className="sd-btn sd-btn--sm" disabled={busy} onClick={() => setBrowsing(true)}>
                  Choose a folder
                </button>
                {location && (
                  <button
                    type="button"
                    className="sd-btn sd-btn--sm sd-btn--ghost"
                    disabled={busy}
                    onClick={() => setLocation(undefined)}
                  >
                    Use the data folder
                  </button>
                )}
              </div>
            </div>
            <div className="sd-field">
              <span className="sd-field__label">Files</span>
              <div className="sd-choice__chips">
                {template.files.map(file => (
                  <span key={file.path} className="sd-file">
                    {file.path}
                  </span>
                ))}
              </div>
              <span className="sd-meta">{kind.where}</span>
            </div>
            {template.kind === 'code' && (
              <div className="sd-field">
                <span className="sd-field__label">Tests</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' }}>
                  <span className="sd-file">node --test</span>
                  <span className="sd-meta">run on a throwaway copy of each change</span>
                </div>
              </div>
            )}
          </section>
          <section className="sd-card sd-sidecard sd-sidecard--roomy" aria-labelledby="start-team">
            <h2 id="start-team" className="sd-sidecard__title">
              Who works on it
            </h2>
            <ul className="sd-startteam">
              {template.team.map(member => (
                <li key={member.agentId} className="sd-person">
                  <AgentAvatar look={faceOf(member)} size={36} />
                  <span className="sd-startteam__text">
                    <span>
                      <b>{member.name}</b> <span className="sd-meta">· {member.role}</span>
                    </span>
                    <span className="sd-meta">{member.line}</span>
                  </span>
                </li>
              ))}
            </ul>
            <div className="sd-field">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                <label className="sd-field__label" htmlFor="start-cli-choice">
                  They run on
                </label>
                <span className="sd-chip sd-chip--ok">
                  <span className="sd-chip__dot"></span>Signed in
                </span>
              </div>
              {answer.clis.length > 1 ? (
                <select
                  id="start-cli-choice"
                  className="sd-select"
                  value={cli}
                  disabled={busy}
                  onChange={event => onCli(event.target.value)}
                >
                  {answer.clis.map(item => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              ) : (
                <output id="start-cli-choice" className="sd-input sd-input--static">
                  {cliLabel}
                </output>
              )}
              <span className="sd-meta">Change any agent’s CLI, model or instructions later on its page.</span>
            </div>
          </section>
          <section className="sd-card sd-sidecard sd-sidecard--roomy" aria-label="House rules">
            <span className="sd-field__label">House rules: recommended</span>
            <span className="sd-meta" style={{ color: 'var(--ink-2)' }}>
              {template.houseRules} Change this any time in the project’s settings.
            </span>
          </section>
        </aside>
      </div>
      <Modal open={browsing} onClose={() => setBrowsing(false)} title="Where the sample goes">
        <div className="sd-dialog__scroll" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-14)' }}>
          <p className="sd-meta" style={{ margin: 0 }}>
            Choose a folder outside your Studio desk data folder. The sample gets a new folder of its own inside it, so
            nothing already there changes.
          </p>
          {/* It starts at the folder chosen before, if any, and otherwise at the home folder. */}
          <FolderBrowser
            start={location?.path}
            onChoose={(_, listing) => {
              setBrowsing(false);
              setLocation(listing);
            }}
            onCancel={() => setBrowsing(false)}
          />
        </div>
      </Modal>
    </>
  );
}

export function FirstRun({ template: picked, onTemplate }: { template?: string; onTemplate: (id?: string) => void }) {
  const { data, error, isFetching, refetch } = useQuery({
      queryKey: ['templates'],
      queryFn: ({ signal }) => getJSON<FirstRunTemplates>(templatesUrl, signal),
    }),
    [chosen, setChosen] = useState<string>(),
    [adding, setAdding] = useState(false);
  const cli = data?.clis.find(item => item.id === chosen)?.id ?? data?.clis[0]?.id ?? '',
    template = data?.templates.find(item => item.id === picked);
  return (
    <StartFrame connected={error ? false : data ? true : null}>
      <div className="sd-start">
        {error && (
          <p role="alert" className="sd-meta">
            The controller could not list its templates: {error.message}
          </p>
        )}
        {!data && !error && (
          <p role="status" className="sd-meta">
            Connecting to your studio…
          </p>
        )}
        {data && template && data.clis.length > 0 ? (
          <Setup
            key={template.id}
            answer={data}
            template={template}
            cli={cli}
            onCli={setChosen}
            onBack={() => onTemplate(undefined)}
          />
        ) : (
          data && (
            <Choose
              answer={data}
              cli={cli}
              onCli={setChosen}
              checking={isFetching}
              onCheck={() => void refetch()}
              onPick={item => onTemplate(item.id)}
              onOwn={() => setAdding(true)}
            />
          )
        )}
      </div>
      {adding && (
        <Suspense fallback={null}>
          <NewProjectDialog open onClose={() => setAdding(false)} />
        </Suspense>
      )}
    </StartFrame>
  );
}

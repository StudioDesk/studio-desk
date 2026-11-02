# Handoff: current status

This page is the current status of Studio desk and where to look in the code, kept to one page and rewritten in place. The pipeline's planning and reviews read it, so it says what is built, not how it was decided.

## What this is

Studio desk is a local controller that runs AI agents (Claude Code and Codex CLI through their subscription sign-ins, never paid APIs) as bounded work the director approves. The controller owns scheduling, locks, instruction snapshots, the provenance of every file and acceptance. A project is either code in a git repository or work that is not code:

- **Code:** an idea becomes linked stories. Each story is edited in its own worktree, tested in its own copy (in the built-in sandbox once it is set up on the computer), reviewed independently and integrated by merge.
- **Everything else:** a planner splits an idea into steps that hand files on, and each step is reviewed independently.

The dashboard (`dashboard/`, React with a Vite build) is served by the controller at its own address.

## What 1.1 holds

- Projects for git repositories and for general work, started from the dashboard or from the Code and Writing samples, each with its own agents (agents a project made work only there).
- Teams, agents and instructions at three levels (everyone, a team, one agent), each with drafts and published revisions, edited in place on the Agents page; every attempt records the instructions, configuration and inputs it ran with.
- Ready → Working → Review → Accepted for every story and step, with independent review, send-back and retries that see earlier attempts. An agent runs several attempts at once, within the studio's limits, and a code project's stories run side by side; one that conflicts with an earlier merge is rebuilt on the new tip.
- Releases and lines (`src/connectors/source-lines.mjs`, `src/connectors/source-milestones.mjs`): milestones as releases, a patch on its release line carried forward to every newer line, a fix brought back to an older line at the director's word, Release, and Push to the remote, confirmed each time.
- An agent asks the director a question and continues from its saved work with the answer (`src/core/questions.mjs`); an idea's planning is a conversation the director can reply to.
- Try a story yourself in a copy of its own (`src/connectors/try-copy.mjs`), and the visual check, which photographs a story's pages for the reviewer (`src/connectors/visual-check.mjs`, Windows only for now).
- The project library every attempt reads, the Artifacts page and snapshots (`src/core/library.mjs`, `src/core/snapshots.mjs`).
- Candidate tests, integration verification and an idea's checks in the built-in sandbox, Anthropic's sandbox runtime pinned in the lockfile (`src/adapters/built-in-sandbox*.mjs`), on Windows, macOS and Linux; No sandbox is the director's explicit choice.
- Every request needs the director's session or key (`src/director-access.mjs`).
- House rules for what runs on its own and what waits for the director, and recovery after a restart: interrupted attempts, integrations and releases are reconciled from the dashboard, never replayed blindly.
- A model-free test suite: `npm test`.

## What's next

1.2's core is the work as a graph the director shapes: any step given to any agent, team or role, more than one reviewer on a story, and loops, with today's flow as the default template. The [release notes](RELEASE-NOTES.md) list what else is planned.

## How to work on it

- Node.js 24 or later. The controller needs no install. Run `npm ci` once per copy for the dashboard's tools and the built-in sandbox.
- `npm start` runs the controller at http://127.0.0.1:4317 and builds the dashboard when its sources changed.
- `npm test` runs the model-free suite, the dashboard's typecheck, lint, tests and build among it, with the same command the pipeline runs.
- `npm run verify` tests a commit exactly as the pipeline will: in a worktree and the built-in sandbox, or with `--as checks` as an idea's first checks run (add `--sandbox none` when Settings → Candidate tests is No sandbox). Before merging by hand, run it once for each of those; a change to `dashboard/` alone needs only `node --test test/dashboard-tools.test.mjs test/next-dashboard.test.mjs`, and a change to documents alone needs no tests.
- Run `npm run format` (Prettier 3.3.3 through npx) before committing.
- Never commit `data/`, the controller's runtime records. Read live state through the controller's GET routes, such as `/api/state?mode=dashboard&projectId=<id>`. Every request needs the director's session or key (`src/director-access.mjs`): a local tool sends the header `x-studio-key` with the contents of `<data>/director-key`, and a browser signs in once from the launch link the controller prints, which `<data>/launch-url` also holds.
- Check the interface in a real browser: `node scripts/screenshot.mjs` with the launch link of a throwaway controller (`STUDIO_DATA_DIR` and `STUDIO_PORT`) as its address. Never start a second controller on a data folder that is already in use.

## Where to look

| For | Read |
| --- | --- |
| Running and using it | [README.md](README.md) |
| What each release holds and its known limitations | [RELEASE-NOTES.md](RELEASE-NOTES.md) |
| Development rules and boundaries | [AGENTS.md](AGENTS.md) |
| Contracts as implemented | [docs/module-contracts.md](docs/module-contracts.md) |
| The controller | `src/server.mjs`, `src/core/` (orchestrator, projects, workflows, autonomy) |
| Agents and their CLIs | `src/adapters/`, `src/connectors/` |
| The dashboard | `dashboard/src/` (`router.tsx`, `frame.tsx`, one file per page) |

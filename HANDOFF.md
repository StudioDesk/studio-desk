# Handoff: current status

This page is the current status of Studio desk and where to look in the code, kept to one page and rewritten in place. The pipeline's planning and reviews read it, so it says what is built, not how it was decided.

## What this is

Studio desk is a local controller that runs AI agents (Claude Code and Codex CLI through their subscription sign-ins, never paid APIs) as bounded work the director approves. The controller owns scheduling, locks, instruction snapshots, the provenance of every file and acceptance. A project is either code in a git repository or work that is not code:

- **Code:** an idea becomes linked stories. Each story is edited in its own worktree, tested in its own copy (in Codex CLI's sandbox where it is installed), reviewed independently and integrated by merge.
- **Everything else:** a planner splits an idea into steps that hand files on, and each step is reviewed independently.

The dashboard (`dashboard/`, React with a Vite build) is served by the controller at its own address.

## What 1.0 holds

- Projects for git repositories and for general work, started from the dashboard or from the Code and Writing samples.
- Teams, agents and instructions at three levels (everyone, a team, one agent), each with drafts and published revisions; every attempt records the instructions, configuration and inputs it ran with.
- Since 1.0.1 (in progress), agents made for one project, which work only there, and renaming and deleting agents (`src/core/project-agents.mjs`, the Teams and Agents pages).
- Ready → Working → Review → Accepted for every story and step, with independent review, send-back and retries that see earlier attempts.
- House rules for what runs on its own and what waits for the director.
- Recovery after a restart: interrupted attempts and integrations are reconciled from the dashboard, never replayed blindly.
- A model-free test suite: `npm test`.

## What's next

1.1 is releases and branches: milestones as releases, work on release branches with fixes carried forward, stories running side by side, and pushing to your remote, confirmed each time. The [release notes](RELEASE-NOTES.md) list what else is planned after 1.0.

## How to work on it

- Node.js 24 or later. The controller needs no install. Run `npm ci` once per copy for the dashboard's tools.
- `npm start` runs the controller at http://127.0.0.1:4317 and builds the dashboard when its sources changed.
- `npm test` runs the model-free suite, the dashboard's typecheck, lint, tests and build among it, with the same command the pipeline runs.
- `npm run verify` tests a commit exactly as the pipeline will: in a worktree and the candidate test sandbox, or with `--as checks` as an idea's first checks run (no sandbox). Before merging by hand, run it once for each of those; a change to `dashboard/` alone needs only `node --test test/dashboard-tools.test.mjs test/next-dashboard.test.mjs`, and a change to documents alone needs no tests.
- Run `npm run format` (Prettier 3.3.3 through npx) before committing.
- Never commit `data/`, the controller's runtime records. Read live state through the controller's GET routes, such as `/api/state?mode=dashboard&projectId=<id>`.
- Check the interface in a real browser: `node scripts/screenshot.mjs`, or a throwaway controller (`STUDIO_DATA_DIR` and `STUDIO_PORT`) for anything that writes. Never start a second controller on a data folder that is already in use.

## Where to look

| For | Read |
| --- | --- |
| Running and using it | [README.md](README.md) |
| What 1.0 holds and its known limitations | [RELEASE-NOTES.md](RELEASE-NOTES.md) |
| Development rules and boundaries | [AGENTS.md](AGENTS.md) |
| Contracts as implemented | [docs/module-contracts.md](docs/module-contracts.md) |
| The controller | `src/server.mjs`, `src/core/` (orchestrator, projects, workflows, autonomy) |
| Agents and their CLIs | `src/adapters/`, `src/connectors/` |
| The dashboard | `dashboard/src/` (`router.tsx`, `frame.tsx`, one file per page) |

# Release notes

## 1.0.1 (not released yet)

- **Make agents for a project.** Add a new agent to any of a project's teams, with its own name, AI tool, model and instructions. It works only in that project, so tailoring it never changes the agents your other projects use.
- **Rename any agent, and delete the ones you made** once their work is done. What an agent did stays on the record under its name.
- **Tests run in a sandbox, whichever AI tool you use.** A change's tests, and an idea's first checks, run in a built-in sandbox: a separate Windows account that can change only the copy being tested and can't reach past your computer. Set it up once from Settings. It takes over from Codex CLI's sandbox for tests, so code projects no longer need Codex CLI to keep their tests apart. Codex agents still work in their own sandbox.

## 1.0.0

**Studio desk 1.0 is here.** Hand an idea to a team of AI agents and get back work that's been planned, built, tested and reviewed, with you making the calls along the way. It runs entirely on your computer, on the AI subscription you already have. See the [README](README.md) to get started.

### What you can do with it

- **Try it in a minute.** Two sample projects, one code and one writing, each with a team and ideas to send.
- **Put a team on your own repository.** Every change is made in a copy, tested and reviewed before it's merged. Studio desk commits locally and never pushes.
- **Get more than code done.** Writing and other work get planned, done and reviewed, step by step.
- **Decide how hands-on you want to be.** House rules set what waits for you and what goes ahead on its own.
- **Always know why something stopped**, and what to do about it.
- **See every step.** A full record of everything each agent did and said.
- **Retries that remember** what went wrong last time.
- **Use the subscription you already have.** Claude Code or Codex CLI. No API keys.
- **Ride out usage limits.** Work pauses and picks up again on its own.
- **Stop any time.** After a restart, nothing is replayed blindly.
- **A dashboard for all of it**, in dark or light, with search everywhere.

### Known limitations

- **Windows only, for now.** macOS and Linux haven't been tested.
- **One thing at a time.** Each agent works on one thing at a time, so one project can wait for an agent who's busy in another. A code project's stories go one after another; other work can run steps side by side when different agents are free.
- **Tests run with Node's test runner.** Type checks, builds and anything that needs installed packages should be part of the tests.
- **Code projects need a git repository.** Plain folders aren't supported; other work needs no folder at all.
- **The samples only appear before your first project.**
- **Claude Code has no sandbox on Windows.** Approve commands narrowly.
- **Without Codex CLI, a change's tests run without a sandbox.** They run in a disposable copy, but with your account's access to your files and network. A built-in sandbox is coming in an update.
- **Approved commands apply everywhere.** They, and auto mode's default, cover every project and agent; an idea or task can still switch auto mode for itself.
- **Nothing is checked by eye.** Reviews read the code, tests and evidence, not what's on screen.
- **Very large repositories or slow network drives can make the dashboard pause** for a moment.
- **Tested changes leave a marker in your repository.** Each change Studio desk tested is kept under `refs/studio/`, and those markers stay after the project is deleted.
- **A few rough edges:** a repository git won't open just shows as "not a git repository"; a hang outside the tests waits for the attempt's time limit; and a story can only take on files that were in the repository when its idea started, so for a newer file, send the idea again.

### Coming after 1.0

Stories running side by side within a project, agents with their own tools for each project, talking with your agents, milestones and sprints, a model router across your connected CLIs, a built-in sandbox for tests, an installer, and remote access.

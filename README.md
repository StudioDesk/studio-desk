# Studio desk

**You bring the ideas. Studio desk brings the team.**

Describe what you want in plain words. A planner turns it into a plan, you approve it, and a team of AI agents gets to work: building it, testing it and reviewing each other's work before anything goes in. You make the calls. They do the rest.

It works on code in your git repositories, and on anything else you can describe, like writing.

## Why you'll like it

- **It checks its own work.** Every change is tested and independently reviewed before it lands. Work that falls short goes back to be fixed.
- **You stay in charge.** You decide what waits for your approval and what can go ahead on its own.
- **Nothing happens behind your back.** Every step every agent takes is on the record, down to the commands it ran and why anything stopped.
- **It runs on what you already pay for.** Your Claude Code or Codex CLI subscription. No API keys, no per-request bills.
- **It stays on your computer.** No cloud, no hosting. Your code is committed locally and never pushed.

## Your team, your way

Studio desk is a pipeline, not a fixed crew. Every project has a team, and every team has roles: a **planner** who turns ideas into work, **agents** who do it, **checks** that run your tests, and a **reviewer** who signs off. You choose who's on the team, which AI tool and model each agent uses, and what they're told. A new install comes with a starting team, so you can jump right in. When a project needs a specialist, like a copywriter or a designer, make one just for that project: it never touches the agents your other projects rely on.

## Get started

You'll need:

- **Windows 10 or 11.** macOS and Linux aren't tested yet.
- **[Node.js](https://nodejs.org/) 24 or later.**
- **[Claude Code](https://docs.claude.com/en/docs/claude-code) or [Codex CLI](https://learn.chatgpt.com/docs/cli)**, signed in with a subscription rather than an API key. One is enough.
- **Git**, for code projects.

Then:

1. Download the release and extract it somewhere you'll keep it (or clone the repository and check out `v1.0.1`).
2. Run `npm ci` in that folder, once.
3. Double-click `start-studio.cmd`, or run `npm start`.
4. Open **http://127.0.0.1:4317** in Chrome or Edge.

Keep the controller's window open while you work.

## Your first project

Studio desk opens with two samples to try: a small code library with its tests, and a writing brief for a community garden's new volunteers. Each comes with a team and a few ideas to send, and runs for real on your own sign-in. Or skip them and start your own.

## From idea to done

1. **You send an idea**, with reference files if they help.
2. **The planner breaks it into stories** or steps.
3. **You approve the plan.**
4. **Agents do the work**, each in a copy of its own, and the tests run.
5. **The reviewer checks it** and sends back anything that falls short.
6. **It goes in.** Code is merged into your branch; other work is ready for you to read.

## You make the calls

When something needs you, like approving a plan or accepting a result, it shows up on the project's Today page in plain words, with what to do next. Everything else, like waiting for a busy agent or a usage limit to reset, sorts itself out.

**House rules** decide how much needs you. Every project starts on the recommended ones: you approve every plan, and work that passes its tests and review goes in on its own. Turn that up or down any time.

## Watch it happen

Today shows who's working on what and what shipped. Follow each idea from start to finish, see the whole board at a glance, read every change with its tests and reviews, and open any attempt to see exactly what an agent did and said.

## Bring your own repository

Point Studio desk at a git repository and it works out the rest: what stories may change, what's protected and where the tests are. It runs your tests once before it starts, and adds the project only if they pass.

Your repository needs a clean working tree and tests that run with Node's test runner (`node --test`), or no tests yet. Agents never change your `AGENTS.md`, `CLAUDE.md`, `package.json`, lockfile or tool configuration, and deleting a project never changes your files or branches.

Not code? Start a project without a folder.

## Safety

Agents run commands on your computer through your CLI:

- **Codex CLI** runs in its own sandbox.
- **Claude Code** has no sandbox on Windows. It runs only the commands you approve in Settings, unless you turn on auto mode, which lets Claude Code decide.

Anything an agent runs has your account's access to your files and network, so **approve narrowly**. A change's tests are kept apart: they run in a disposable copy inside the built-in sandbox, as a separate Windows account that can change only that copy and can't reach past your computer. It needs a one-time setup from Settings, where Windows asks for an administrator. You can choose to run tests without it there, and they then have your account's access.

## Good to know

- **Usage limits:** when your CLI hits its limit, work pauses and picks up again when the limit resets.
- **Stopping:** close the controller any time. Anything cut off mid-step waits for you to check it; nothing is replayed blindly.
- **Your data:** everything lives in the `data` folder next to the app. To back it up, stop the controller and copy the folder. Set `STUDIO_DATA_DIR` or `STUDIO_PORT` to use another folder or port.

## Known limitations

The [release notes](RELEASE-NOTES.md) have the full list. The big ones:

- Only Windows has been tested.
- Each agent works on one thing at a time, and a code project's stories go one after another.
- Tests must run with Node's test runner.
- Nothing is checked by eye: reviews read the code, tests and evidence.

## For developers

Studio desk builds itself with its own pipeline. [AGENTS.md](AGENTS.md) has the development rules, [HANDOFF.md](HANDOFF.md) the current status and what comes next, and [docs/module-contracts.md](docs/module-contracts.md) how it's built. `npm test` runs the full suite without calling any model.

## License

MIT. See [LICENSE](LICENSE).

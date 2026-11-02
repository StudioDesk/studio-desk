# Release notes

## 1.1.0

**Releases and branches, and a studio that talks back.** Studio desk 1.1 groups your work into releases, and around that theme it gives your agents a voice: they can stop and ask you instead of guessing, you can talk an idea through with the planner, and you can try a change yourself before you take it. A project's files now live in one place, with a library every agent follows. Agents can run several pieces of work at once, and the dashboard keeps up with them as it happens.

### Releases and branches

- **Plan your releases.** Milestones are now releases you plan, each with its own goal. A new idea can pick the release it belongs to; otherwise it lands in the current one. Ideas can also wait in a milestone and start on their own when a line is free.
- **See how your lines fit together.** The Releases page shows each line, what it's for, its milestones and what has landed since its last release.
- **Fix an older version without losing the fix.** An older version gets its own line from its tag. A fix lands there and ships as a patch, then it's carried up to every newer line, so nobody loses it when they upgrade.
- **Several stories at once on a line.** Stories build side by side, each in its own copy. When two changes conflict, the agent that made the change resolves it.
- **Release when it's ready.** Release asks the planner for the notes, you approve them, and then it tests the release and tags it.
- **Push only when you say so.** Push sends the line and its tag to your remote, and only when you confirm it, every time.

### Your agents can ask you

- **An agent that needs your call asks instead of guessing.** Its question waits for you on Today, with your other calls, and at the top of the story it belongs to. You see who asked, when, what the options are and which one the agent recommends, and you answer in a sentence or with a click. The question leaves Today as soon as you answer, and the work picks up from there.
- **Auto mode answers the small ones, and you can change its mind.** When a question stays inside the story, auto mode can answer it for you. Its answer stays on view, folded away on Today and on the story, with a way to change it.
- **The whole exchange stays on the record.** A story's history, an idea's account of what happened and the project's activity log all show the question, its options, who answered and how. They read as a conversation in your color, not as a red stop.

### Talk an idea through

- **Plan an idea in conversation with the planner.** While an idea is being planned, its page shows the conversation: your idea, the first checks, the planner's plan and every reply, with the plan cards that changed after each reply. Reply to the planner, answer its questions right there, and make the plan official when it's right. Once it's official, the conversation stays on the page so you can read it back.
- **Keep talking while steps wait for you.** A plan that's accepted but whose steps all still wait for your approval still counts as being talked through, so you can reply or make it official from the conversation.
- **Planning shows on the idea, not as extra cards.** The board and the ideas list show each idea's planning on its own card or row: planning, waiting for you, or stopped and why. The idea's page links to each planning step for when you want the details.
- **Try the chat box (preview).** Turn it on in the new Previews page under Settings and it stays on in that browser. New idea, or the N key, opens it at the side of any page. After you send an idea, the box shows its conversation, so you can answer, reply and make it official without leaving what you're doing. The sidebar lists the ideas still being talked through, newest first. Ctrl J is left to your browser.

### Try a change yourself

- **Try it before you take it.** Once a code story's tests pass, Try it puts the change in a copy of your project you can run and open. Run it, open its folder, open it in your browser and stop it, all from the story. If the copy holds edits of yours, you choose to keep them or discard them first, and running it outside the sandbox asks you to confirm.
- **Always know where your try stands.** The story says in one line whether it's running, where to open it and what to do next, and offers only the buttons that make sense right now. Its Try it tab shows the copy, its folder, the start command and its output, and a Tried by you summary sits beside the change, the tests and the review.
- **Set it up once per project** in Settings: the command that starts your app, the address to open (or read from its output), where the try copy lives and whether it runs in the built-in sandbox or on your computer.

### See the pages, not just the code

- **A visual check captures a story's pages.** Turn it on in Settings, pick the widths and themes, and Studio desk captures each page a story changes with the browser it found on your computer, and the reviewer looks at them too. If no browser is found, it tells you so.
- **Choose what gets captured.** A story's Pages tab lists the pages its check will capture and the steps to reach each one in plain words. Add a page or change one until the check runs. A story's link can open straight on its Pages tab.
- **Look through the captures.** Pictures are grouped by page and width as same-height thumbnails, with the reviewer's notes beside them, and a pages tile sums it up. Open one full size to read the review's note and step through the page's pictures.

### Your project's files in one place

- **The Artifacts page shows what the work made and you accepted**, one row per file, newest first. Filter by idea, agent or kind. Each file shows its kind at a glance, and the ones that can be read in place open in a panel at the side, with Download.
- **Every version of a file.** See each version, when it was made and why, open any of them and see what changed from the one before. The comparison stays inside its card at every width.
- **A library every agent follows.** Put guidelines, specs and reference files in the project's library, by uploading them or adding a file the work made, and every attempt receives them. You see their total size against what an attempt receives. A library file opens in the same side panel with its revisions: open one, add a newer revision, copy it to another project or remove it. Text files can be edited in place, showing what changed before you save the next revision.
- **Agents can propose library files.** Their proposals wait at the top of Artifacts for you to add, read first or put off, and Today tells you when house rules added one for you. A proposal the library couldn't take reads as a plain note, and you can still add the file from the work.
- **Leave library files out of an idea.** The New idea box says how many library files go with the work, and lets you leave some out.
- **Code projects and other work each get their own view.** A code project's page points to its repository and shows the library and what the work made that isn't code. Other projects show the library, the work and snapshots: take a snapshot, see what changed since the last one and download it.

### Shape your teams

- **See how work flows.** The Agents page shows the flow from you, through each team in order, and back to you to take what passed review.
- **Edit an agent beside the flow.** Pick an agent to change what it does, what it runs on, what it can use and what it's told. The kinds of work your project doesn't take yet are marked, and house rules name them too, with a link to the Agents page.
- **Edit a team in place.** What it's for, who's on it and how it works, saved from beside the flow. Adding an agent, from the top of the page or from a team, offers both ways side by side: an agent the studio already has, or a new one.
- **Read and change what an agent is told, as rules.** Each agent has a page with its rules, set by set, and everything it receives. Add, edit, move and remove rules in a draft, then publish or discard it. Changes show at once, save in order behind the page and roll back if they're refused.
- **Model tiers moved to Settings,** under the command-line tools, so you set light, standard and deep work once for each tool.
- **Fits every screen.** On a desktop the editor sits level with the flow and stays in view; on narrower screens it opens beside or under the card you picked, scrolled into view, with Close on a phone. The list of agents outside the flow is gone.

### More at once, and live

- **Agents run several attempts at once.** Settings caps how many attempts run at the same time across every project, up to 16. Agent cards and pages list every story an agent is working on, and Today's floor shows each running attempt.
- **Work you're watching keeps up.** A running attempt switches from its raw log to the conversation as soon as its first steps arrive, with no refresh. The log, the story's history and the full trace follow the newest lines, and if you scroll up to read, a New updates button counts what's arrived and takes you back.
- **Your other projects' calls are on the rail.** Each project's icon counts the calls waiting for you there, the browser tab's title shows the total, and pointing at a count lists those calls, each linking straight to its page. Today stays about the project you're in.

### Clearer stories

- **The brief sits beside every story,** in its own card, instead of behind a tab.
- **Where it stands, in one sentence.** The story's banner says where it stands and the key facts, with Integrate and Send back on their own row and Close tucked under More.
- **Attempts in a row.** Pick an attempt from numbered chips above the tabs, each saying how it ended; a review names what it reviewed, the limit is said in words and the latest four are shown.
- **History you can fold.** Each attempt is a chapter that ends with what it handed back, and the review is a chapter of its own. Chapters appear whole once they've loaded, not piece by piece.
- **Work that isn't code opens on its result.** Its overview shows what the latest attempt returned.
- **Everything recorded about an attempt** has a page of its own, linked from the attempt's details.
- **The board asks you only when it needs you.** A card in review asks Accept? only when it's your call, and otherwise says it's waiting and why.

### Fixes

- The studio now checks it's you on every request, the dashboard's included. Starting the studio opens the dashboard already signed in, and programs on this computer use the key kept in the studio's data folder. This closes a hole where code under test could reach the studio as you.
- When a story's edits go beyond the files it was approved for, it now names the file and the rule it broke.
- Approving a request for a file an earlier story in the chain created now works, as a file the story created.
- An interrupted attempt now stands out with its Reconcile action, and Start is offered only once it's reconciled.
- The Releases page updates when your studio reports a change, and after a reload.
- Ideas are recognized as finished, and their plan step found, even when the wording on screen changes.
- An occasional two-minute hang in Studio desk's own test suite is fixed.

## 1.0.1

- **Make agents for a project.** Add a new agent to any of a project's teams, with its own name, AI tool, model and instructions. It works only in that project, so tailoring it never changes the agents your other projects use.
- **Rename any agent, and delete the ones you made** once their work is done. What an agent did stays on the record under its name.
- **Tests run in a sandbox, whichever AI tool you use.** A change's tests, and an idea's first checks, run in a built-in sandbox: a separate Windows account that can change only the copy being tested and can't reach past your computer. It takes over from Codex CLI's sandbox for tests, so code projects no longer need Codex CLI to keep their tests apart. Codex agents still work in their own sandbox.
- **After updating, run `npm ci` once more, then set up the sandbox from Settings**, where Windows asks for an administrator. Until you do, a code project's tests wait for it, or you can choose to run them without a sandbox.

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

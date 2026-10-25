// Model-free Claude Code protocol fixture. Never connects to a provider.
// Text mode (--safe-mode) checks the tool-free arguments and answers from the prompt;
// workspace mode checks that the administrator's setup is left on and works on disk.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { layoutExample, hash } from '../src/contracts.mjs';
import { simulatedPlan } from '../src/planning.mjs';
import { sourcePlan } from '../src/connectors/source-checks.mjs';

const args = process.argv.slice(2),
  value = flag => args[args.indexOf(flag) + 1],
  text = args.includes('--safe-mode');
const auth = process.env.STUDIO_CLAUDE_FIXTURE_AUTH || 'subscription';
if (
  process.env.ANTHROPIC_API_KEY ||
  process.env.ANTHROPIC_AUTH_TOKEN ||
  process.env.ANTHROPIC_BASE_URL ||
  process.env.CLAUDE_CODE_USE_BEDROCK ||
  process.env.CLAUDE_CODE_OAUTH_TOKEN ||
  process.env.CLAUDE_CODE_SIMPLE ||
  process.env.OPENAI_API_KEY ||
  (args.includes('auth') || text ? process.env.CLAUDE_CODE_SAFE_MODE !== '1' : process.env.CLAUDE_CODE_SAFE_MODE) ||
  process.env.DISABLE_TELEMETRY !== '1'
) {
  console.error('Subscription environment isolation was not applied.');
  process.exit(1);
}
if (args.includes('auth')) {
  if (auth === 'malformed') {
    console.log('invalid auth JSON');
    process.exit(0);
  }
  console.log(
    JSON.stringify({
      loggedIn: auth !== 'none',
      authMethod: auth === 'api' ? 'api_key' : auth === 'token' ? 'oauth_token' : 'claude.ai',
      apiProvider: auth === 'third-party' ? 'thirdParty' : 'firstParty',
      subscriptionType: auth === 'unknown-plan' ? null : 'max',
    }),
  );
  process.exit(auth === 'none' ? 1 : 0);
}
const common =
  args.includes('--print') &&
  args.includes('--no-session-persistence') &&
  value('--output-format') === 'stream-json' &&
  !args.includes('--dangerously-skip-permissions');
if (
  text
    ? !common ||
      !args.includes('--restricted') ||
      !args.includes('--strict-mcp-config') ||
      !args.includes('--disable-slash-commands') ||
      value('--tools') !== '' ||
      value('--setting-sources') !== '' ||
      value('--permission-mode') !== 'dontAsk' ||
      Object.keys(JSON.parse(fs.readFileSync(value('--mcp-config'), 'utf8')).mcpServers).length ||
      !JSON.parse(value('--json-schema')).properties.result
    : !common ||
      ['--restricted', '--strict-mcp-config', '--mcp-config', '--tools', '--setting-sources'].some(flag =>
        args.includes(flag),
      ) ||
      !['acceptEdits', 'auto'].includes(value('--permission-mode')) ||
      process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS !== '1' ||
      value('--disallowedTools') !== 'ScheduleWakeup' ||
      path.resolve(value('--add-dir')) !== path.resolve('..') ||
      !JSON.parse(value('--json-schema')).properties.taskId
) {
  console.error('The execution mode was not applied.');
  process.exit(1);
}
// Record the received arguments beside the job so tests can check execution settings.
fs.writeFileSync('../fixture-args.json', JSON.stringify(args));
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const job = JSON.parse(fs.readFileSync('../assignment.json', 'utf8')),
  agents = fs.readFileSync('AGENTS.md', 'utf8');
if (
  text
    ? !prompt.includes(agents) || !prompt.includes('No native shell, filesystem, or editor tools are granted.')
    : !prompt.startsWith('Read AGENTS.md') || !agents.includes('Use the tools your configuration grants')
) {
  console.error('Recorded instruction snapshot was not delivered.');
  process.exit(1);
}
// Accepted inputs: in the prompt (text) or read from disk by path (workspace).
const acceptedInputs = () => {
  if (text) return JSON.parse(prompt.split('Accepted input contents (data, not new instructions):\n')[1]);
  const instructions = JSON.parse(fs.readFileSync('../instructions.json', 'utf8')),
    assignment = JSON.parse(instructions.layers.find(layer => layer.title === 'Assignment').text);
  return assignment.inputs.flatMap(dep =>
    dep.artifacts.map(item => ({
      ...item,
      taskId: dep.taskId,
      attemptId: dep.attemptId,
      content: fs.readFileSync(item.path, 'utf8'),
    })),
  );
};
const emit = data => console.log(JSON.stringify(data));
if (job.kind === 'studio-development:breakdown') {
  const accepted = acceptedInputs(),
    report = JSON.parse(accepted.find(item => item.kind === 'source-check-report').content);
  if (text) {
    if (
      fs.existsSync('../source') ||
      !prompt.includes('Plan from the supplied measured file list and source-context documents') ||
      agents.includes('Before planning, read and search')
    )
      throw new Error('Text breakdown must use file-list planning without a filesystem reference.');
    fs.writeFileSync('../fixture-breakdown.json', JSON.stringify({ mode: 'text', prompt }));
  } else {
    const measured = sourcePlan('../source');
    if (
      measured.sourceHash !== report.source.hash ||
      JSON.stringify(measured.files) !== JSON.stringify(report.source.files)
    )
      throw new Error('Breakdown reference manifest/fingerprint differs from the accepted measurement.');
    if (
      !agents.includes('read and search') ||
      !agents.includes('../source') ||
      !agents.includes('their callers') ||
      !agents.includes('tests asserting')
    )
      throw new Error('Breakdown implementation/caller/test guidance was not delivered.');
    fs.writeFileSync(
      '../fixture-breakdown.json',
      JSON.stringify({
        mode: 'workspace',
        files: measured.files,
        sourceHash: measured.sourceHash,
        implementation: fs.readFileSync('../source/src/core/projects.mjs', 'utf8'),
        test: fs.readFileSync(
          path.join('../source', measured.files.find(item => /^test\/.*\.test\.mjs$/.test(item.path)).path),
          'utf8',
        ),
      }),
    );
    if (job.title.includes('Modify reference'))
      fs.writeFileSync('../source/src/core/projects.mjs', 'Changed by fixture');
  }
}
emit({
  type: 'system',
  subtype: 'init',
  session_id: 'fixture-claude-session',
  model: 'fixture-claude-model',
  // Workspace mode reports the administrator's own tools, MCP servers and plugins.
  tools: text
    ? job.title.includes('Unexpected metadata')
      ? ['Bash']
      : []
    : ['Bash', 'Read', 'Edit', 'mcp__helper__lookup'],
  mcp_servers: text ? [] : [{ name: 'helper', status: 'connected' }],
  // Claude Code 2.1.296 reports these built-in plugins even in safe mode.
  plugins: [
    { name: 'cc-plugin-agents-md', path: 'builtin', source: 'cc-plugin-agents-md@builtin' },
    ...(job.title.includes('Installed plugin') || !text
      ? [{ name: 'helper', path: 'C:/Users/fixture/.claude/plugins/helper', source: 'helper@marketplace' }]
      : []),
  ],
  apiKeySource: job.title.includes('API key source') ? 'ANTHROPIC_API_KEY' : 'none',
});
// Claude Code reports each usage limit in a rate_limit_event; status 'rejected' means it is reached.
// 'Limit reported soon' reaches two limits, the later resetting a few seconds ahead ("Reset in N seconds."
// in the brief, else 3), beside one not reached that resets later; 'Limit reported past' reaches one that
// reset a minute ago and 'Limit reported far' one 9 days ahead. 'Limit message soon' reports none and names
// its reset in Claude's epoch message form; the other messages name no time. 'Limits not reached' reports
// only limits not yet reached, and records without a readable report, then works or, 'then stopped', is
// stopped by a limit. 'Limit reached then failed' reaches one that resets a few seconds ahead, then fails
// in wording the usage-limit pattern does not recognize ('Claude stopped unexpectedly.'); 'Limit reached
// after failure' fails that way first, and 'Limit reached then exited' only exits with code 1, writing
// no failure. 'Limit reached then sign-in failure' and 'Limit reached then permission failure' reach one
// that way, then fail with a sign-in or a permission message, which no reached limit makes a hold. Each
// of these limits only its task's first run; the count is kept beside the jobs of the disposable test data
// folder. 'Finished after a reached limit' reaches one, then works; 'Unrecognized failure' reports no limit
// and fails in that wording.
const ahead = seconds => Math.floor(Date.now() / 1000) + seconds,
  lead = Number((job.brief || '').match(/Reset in (\d+) seconds/)?.[1] || 3),
  rateLimit = (status, resetsAt, rateLimitType = 'five_hour') =>
    emit({ type: 'rate_limit_event', rate_limit_info: { status, resetsAt, rateLimitType } }),
  unrecognized = () =>
    emit({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['Claude stopped unexpectedly.'],
    }),
  limitCount = path.join('..', '..', `fixture-limit-${job.id}.count`),
  limitRuns = fs.existsSync(limitCount) ? Number(fs.readFileSync(limitCount, 'utf8')) : 0,
  limited = /^Limit (reported|message|reached) |then stopped/.test(job.title) && !limitRuns;
if (job.title.includes('Limits not reached')) {
  emit({ type: 'rate_limit_event' });
  emit({ type: 'rate_limit_event', rate_limit_info: null });
  rateLimit('allowed', ahead(lead));
  rateLimit('allowed_warning', ahead(lead), 'seven_day');
}
if (job.title.includes('Finished after a reached limit')) rateLimit('rejected', ahead(lead));
if (limited) {
  fs.writeFileSync(limitCount, String(limitRuns + 1));
  if (job.title.startsWith('Limit reached ')) {
    if (job.title.includes('after failure')) unrecognized();
    rateLimit('rejected', ahead(lead));
    if (job.title.includes('then failed')) unrecognized();
    const access = job.title.includes('then sign-in failure')
      ? 'Authentication failed; sign in again'
      : job.title.includes('then permission failure') && 'Permission denied by managed policy';
    if (access) emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [access] });
    process.exit(1);
  }
  if (job.title.includes('Limit reported soon')) {
    rateLimit('rejected', ahead(1));
    rateLimit('rejected', ahead(lead), 'seven_day');
    rateLimit('allowed', ahead(lead + 3600), 'seven_day_opus');
  } else if (job.title.includes('Limit reported past')) rateLimit('rejected', ahead(-60));
  else if (job.title.includes('Limit reported far')) rateLimit('rejected', ahead(9 * 24 * 60 * 60), 'seven_day');
  const message = job.title.includes('Limit message soon')
    ? `Claude AI usage limit reached|${ahead(lead)}`
    : 'rate_limit: You have hit your limit';
  emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [message] });
  process.exit(1);
} else if (
  job.title.includes('Hang') ||
  job.title.includes('API key source') ||
  (text && (job.title.includes('Unexpected metadata') || job.title.includes('Installed plugin')))
)
  setInterval(() => {}, 1000);
else if (text && job.title.includes('Unexpected call')) {
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__unreal__write' }] } });
  setInterval(() => {}, 1000);
} else if (job.title.includes('Quota') || job.title.includes('Permission') || job.title.includes('Authentication')) {
  const message = job.title.includes('Quota')
    ? 'rate_limit: You have hit your limit'
    : job.title.includes('Permission')
      ? 'Permission denied by managed policy'
      : 'Authentication failed; sign in again';
  emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [message] });
  process.exit(1);
} else if (job.title.includes('Unrecognized failure')) {
  unrecognized();
  process.exit(1);
} else if (job.title.includes('Malformed protocol')) {
  console.log('not JSON');
} else if (job.title.includes('Timeout')) setInterval(() => {}, 1000);
else {
  let artifact = job.kind === 'layout' ? 'layout.json' : job.kind === 'review' ? 'review.json' : 'work.txt';
  let content = job.kind === 'layout' ? JSON.stringify(layoutExample) : 'Staged fixture text.';
  if (job.kind === 'plan') {
    const instructions = JSON.parse(fs.readFileSync('../instructions.json', 'utf8'));
    const contract = JSON.parse(instructions.layers.find(layer => layer.title === 'Planning contract').text);
    if (!prompt.includes('plan.json') || !(text ? prompt : agents).includes(JSON.stringify(contract, null, 2)))
      throw new Error('Recorded planning contract was not delivered.');
    if (contract.context.repair) {
      const inputs = acceptedInputs();
      if (
        !inputs.some(ref => ref.path.endsWith('review.json')) ||
        !contract.context.repair.findings.length ||
        inputs.some(ref => hash(ref.content) !== ref.hash)
      )
        throw new Error('Pinned repair input contents were not delivered.');
    }
    artifact = 'plan.json';
    content = JSON.stringify(simulatedPlan(contract.context, job.brief));
  }
  if (job.kind === 'review') {
    const accepted = acceptedInputs();
    if (accepted.length !== 1 || JSON.parse(accepted[0].content).rooms.length !== 3) process.exit(1);
    content = JSON.stringify({
      verdict: job.title.includes('Revision verdict') ? 'revise' : 'pass',
      findings: job.title.includes('Revision verdict') ? ['Clarify the objective landmark.'] : [],
      evidence: [`Accepted layout ${accepted[0].attemptId}, hash ${accepted[0].hash}. Logical review only.`],
    });
  }
  if (job.kind === 'studio-development:review') {
    const input = acceptedInputs().find(item => item.kind === 'source-check-report'),
      report = JSON.parse(input.content);
    if (hash(input.content) !== input.hash) throw new Error('Source review accepted input changed.');
    artifact = 'source-review.json';
    content = JSON.stringify({
      schemaVersion: 'source-review-v1',
      source: {
        taskId: input.taskId,
        attemptId: input.attemptId,
        path: 'check-report.json',
        hash: input.hash,
        sourceHash: report.source.hash,
      },
      verdict: report.passed ? 'pass' : 'needs-work',
      summary: 'Model-free source review fixture.',
      findings: report.passed ? [] : ['Measured source checks failed.'],
      proposal: {
        complexity: 1,
        title: 'Bounded source fixture',
        reason: 'Protocol fixture only.',
        files: [report.source.files.find(item => item.path.startsWith('src/')).path],
        scope: 'One bounded fixture change.',
        acceptance: 'Measured checks retain their gates.',
      },
      unperformedChecks: ['Browser layout', 'Engine integration', 'Playtest'],
    });
  }
  if (job.kind === 'studio-development:breakdown') {
    const accepted = acceptedInputs(),
      input = accepted.find(item => item.kind === 'source-check-report'),
      context = accepted.find(item => item.kind === 'source-context'),
      report = JSON.parse(input.content);
    if (accepted.some(item => hash(item.content) !== item.hash)) throw new Error('Changed breakdown input.');
    artifact = 'source-breakdown.json';
    content = JSON.stringify({
      schemaVersion: 'source-breakdown-v1',
      source: {
        taskId: input.taskId,
        attemptId: input.attemptId,
        path: 'check-report.json',
        hash: input.hash,
        sourceHash: report.source.hash,
        contextPath: 'source-context.json',
        contextHash: context.hash,
      },
      summary: 'Model-free breakdown protocol fixture.',
      stories: [
        {
          key: 'validate',
          kind: 'studio-development:change',
          role: 'engineer',
          title: 'Validate the idea',
          scope: 'One bounded source change and behavior-pinning coverage.',
          acceptance: 'Measured checks preserve behavior.',
          complexity: 1,
          dependencies: [],
          files: [
            'src/core/projects.mjs',
            report.source.files.find(item => /^test\/.*\.test\.mjs$/.test(item.path)).path,
          ],
        },
      ],
    });
  }
  if (job.title.includes('Large')) content = 'x'.repeat(140000);
  if (job.title.includes('Input limit')) content = 'x'.repeat(530000);
  if (job.title.includes('Oversized')) content = 'x'.repeat(1024 * 1024 + 1);
  if (job.title.includes('Binary input')) content = 'not-text\0fixture';
  if (job.title.includes('Disconnected')) content = JSON.stringify({ ...layoutExample, links: [] });
  if (job.title.includes('Escape')) artifact = '../assignment.json';
  if (job.title.includes('Protected')) artifact = 'AGENTS.md';
  if (job.title.includes('Device')) artifact = 'NUL.txt';
  if (job.title.includes('Alternate stream')) artifact = 'work.txt:stream';
  const blocked = job.title.includes('Blocked');
  const delivery = {
    result: {
      taskId: job.title.includes('Wrong task') ? 'different-task' : job.id,
      outcome: blocked ? 'blocked' : 'completed',
      summary: blocked ? 'More supplied context required.' : 'Fixture delivery ready for review.',
      artifacts: blocked
        ? []
        : [
            {
              path: artifact,
              kind:
                job.kind === 'studio-development:breakdown'
                  ? 'source-breakdown'
                  : job.kind === 'studio-development:review'
                    ? 'source-review'
                    : job.kind,
            },
          ],
      checks: [{ name: 'Fixture protocol', status: 'not-run', evidence: 'No provider or engine was invoked.' }],
      issues: blocked ? ['Supply a text input.'] : [],
      handoff: 'Director review required.',
    },
    files: blocked ? [] : [{ path: artifact, content }],
  };
  if (job.kind === 'studio-development:change') {
    let supplied;
    if (text) {
      // Text delivery: editable files arrive last in the prompt; return complete replacements.
      const marker = 'Return only changed files:\n';
      supplied = JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length));
      if (!prompt.includes('source-scope.json') || !supplied.every(file => file.path.startsWith('changes/')))
        throw new Error('Approved source scope was not delivered.');
    } else {
      // Workspace delivery: the approved copies are already under changes/.
      if (!fs.existsSync('source-scope.json')) throw new Error('Approved source scope was not delivered.');
      supplied = fs
        .readdirSync('changes', { recursive: true })
        .map(file => 'changes/' + file.split(path.sep).join('/'))
        .filter(file => fs.statSync(file).isFile())
        .map(file => ({ path: file, content: fs.readFileSync(file, 'utf8') }));
    }
    delivery.files = supplied.map(file => ({
      path: job.direction === 'escape-scope' ? 'changes/src/core/projects.mjs' : file.path,
      content: file.content + '// Claude fixture edit.\n',
    }));
    delivery.result.artifacts = delivery.files.map(file => ({ path: file.path, kind: 'source-file' }));
  }
  if (job.title.includes('Mismatch')) delivery.files[0].path = 'different.txt';
  if (job.title.includes('Duplicate')) {
    delivery.files.push({ path: artifact.toUpperCase(), content });
    delivery.result.artifacts.push({ path: artifact.toUpperCase(), kind: job.kind });
  }
  if (job.title.includes('Conflict')) {
    delivery.files = [
      { path: 'work', content },
      { path: 'work/child.txt', content },
    ];
    delivery.result.artifacts = delivery.files.map(f => ({ path: f.path, kind: job.kind }));
  }
  // Workspace mode writes its own files with its tools and returns only the result.
  if (!text)
    for (const file of delivery.files) {
      fs.mkdirSync(path.dirname(file.path), { recursive: true });
      fs.writeFileSync(file.path, file.content);
    }
  // A code-editing employee runs the project's tests on its edits through the command its CLI allows: a
  // named test file, then a file that is not a test. What it saw is kept beside the job for the test.
  if (!text && job.direction === 'run-tests') {
    const rule = args.find(arg => /studio-tests\.mjs\)$/.test(arg)) || '',
      script = rule.slice('Bash(node '.length, -1).replace(/^"|"$/g, '');
    if (!rule || !args.includes(rule.slice(0, -1) + ' *)') || !prompt.includes(rule.slice(5, -1)))
      throw new Error('The test command was not allowed and explained.');
    const runs = [['test/bounded.test.mjs'], ['src/core/workflows.mjs']].map(files =>
      spawnSync(process.execPath, [script, ...files], { encoding: 'utf8', env: process.env }),
    );
    fs.writeFileSync(
      '../fixture-tests.json',
      JSON.stringify(runs.map(({ status, stdout, stderr }) => ({ status, stdout, stderr }))),
    );
  }
  const output = text ? delivery : delivery.result;
  const respond = () => {
    if (!text) emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] } });
    // A command Claude Code refuses, as it reports one: the tool call, the refusal, and the final list.
    const refused = job.title.includes('Refused command') && !text,
      call = {
        type: 'tool_use',
        id: 'toolu_fixture_refused',
        name: 'Bash',
        input: { command: 'node --test test/a.test.mjs' },
      };
    if (refused) {
      emit({ type: 'assistant', message: { content: [call] } });
      emit({
        type: 'system',
        subtype: 'permission_denied',
        tool_name: 'Bash',
        tool_use_id: call.id,
        decision_reason: 'This command requires approval',
      });
    }
    if (content.length < 200000)
      emit({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'StructuredOutput', input: output }] },
      });
    emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      structured_output: output,
      ...(refused ? { permission_denials: [{ tool_name: 'Bash', tool_use_id: call.id, tool_input: call.input }] } : {}),
    });
  };
  if (job.title.includes('Slow')) setTimeout(respond, 500);
  else respond();
}

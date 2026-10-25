// Protocol fixture only: no model requests, credentials, or provider connection.
import fs from 'node:fs';
import path from 'node:path';
import { hash, layoutExample } from '../src/contracts.mjs';
import { simulatedPlan } from '../src/planning.mjs';
import { sourcePlan } from '../src/connectors/source-checks.mjs';
const args = process.argv.slice(2);
if (args[0] === 'login' && args[1] === 'status') {
  console.error(process.env.STUDIO_FIXTURE_AUTH === 'api' ? 'Logged in using an API key' : 'Logged in using ChatGPT');
  process.exit(0);
}
const windowsSandbox = args.find(arg => arg.startsWith('windows.sandbox='));
if (
  process.env.OPENAI_API_KEY ||
  process.env.CODEX_API_KEY ||
  args.indexOf('exec') < 0 ||
  // The administrator's Codex configuration and rules apply; the sandbox bounds writes.
  args.includes('--ignore-user-config') ||
  !args.includes('workspace-write') ||
  (process.platform === 'win32' && !['windows.sandbox="mxc"', 'windows.sandbox="elevated"'].includes(windowsSandbox)) ||
  args.includes('--dangerously-bypass-approvals-and-sandbox')
) {
  console.error('Authentication or workspace policy was not applied.');
  process.exit(1);
}
// Record the received arguments beside the job so tests can check execution settings.
fs.writeFileSync('../fixture-args.json', JSON.stringify(args));
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const job = JSON.parse(fs.readFileSync('../assignment.json', 'utf8'));
if (job.kind === 'studio-development:breakdown') {
  const instructions = JSON.parse(fs.readFileSync('../instructions.json', 'utf8')),
    assignment = JSON.parse(instructions.layers.find(layer => layer.title === 'Assignment').text),
    input = assignment.inputs[0].artifacts.find(item => item.kind === 'source-check-report'),
    report = JSON.parse(fs.readFileSync(input.path)),
    measured = sourcePlan('../source');
  if (
    measured.sourceHash !== report.source.hash ||
    JSON.stringify(measured.files) !== JSON.stringify(report.source.files)
  )
    throw new Error('Breakdown reference manifest/fingerprint differs from the accepted measurement.');
  if (
    !instructions.text.includes('read and search') ||
    !instructions.text.includes('../source') ||
    !instructions.text.includes('their callers') ||
    !instructions.text.includes('tests asserting')
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
  if (job.title.includes('Modify reference')) fs.writeFileSync('../source/src/core/projects.mjs', 'Changed by fixture');
}
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fixture-session', model: 'fixture-model' }));
console.log(JSON.stringify({ type: 'fixture.policy', windowsSandbox: windowsSandbox || null }));
// 'Quota soon' names its reset a few seconds ahead ("Reset in N seconds." in the brief, else 2) and
// limits only its task's first run, or its first two with 'twice'; later runs return their work.
// The count is kept beside the jobs of the disposable test data folder.
const soon = job.title.includes('Quota soon'),
  limitCount = path.join('..', '..', `fixture-quota-${job.id}.count`),
  limited = soon && fs.existsSync(limitCount) ? Number(fs.readFileSync(limitCount, 'utf8')) : 0;
if (job.title.includes('Quota') && (!soon || limited < (job.title.includes('twice') ? 2 : 1))) {
  if (soon) fs.writeFileSync(limitCount, String(limited + 1));
  // A readable limit names its reset in the epoch form, five minutes after the fixture's clock.
  const lead = soon ? Number(job.brief.match(/Reset in (\d+) seconds/)?.[1] || 2) : 300,
    reset = soon || job.title.includes('reset time') ? `|${Math.floor(Date.now() / 1000) + lead}` : '';
  console.log(JSON.stringify({ type: 'error', message: `Usage limit reached${reset}` }));
  process.exit(1);
}
if (job.title.includes('Hang')) {
  setInterval(() => {}, 1000);
} else {
  let layout = structuredClone(layoutExample);
  if (job.title.includes('Disconnected')) layout.links = [];
  if (job.title.includes('Collapsed')) {
    layout.objective = layout.exit = 'entry';
    layout.links = [];
  }
  let artifact = 'layout.json',
    data = layout;
  if (job.kind === 'plan') {
    const instructions = JSON.parse(fs.readFileSync('../instructions.json', 'utf8'));
    const contract = JSON.parse(instructions.layers.find(layer => layer.title === 'Planning contract').text);
    if (!prompt.includes('plan.json') || !contract.context.capabilities.includes('No engine'))
      throw new Error('Planning scope was not delivered.');
    artifact = 'plan.json';
    data = simulatedPlan(contract.context, job.brief);
    if (contract.context.repair) {
      const assignment = JSON.parse(instructions.layers.find(layer => layer.title === 'Assignment').text);
      for (const ref of assignment.inputs)
        for (const item of ref.artifacts)
          if (hash(fs.readFileSync(item.path)) !== item.hash) throw new Error('Changed repair input.');
      if (!assignment.inputs.length || !contract.context.repair.findings.length)
        throw new Error('Repair findings and inputs were not delivered.');
      if (job.brief.includes('Unknown repair input')) data.tasks[0].acceptedInputs.push('D-unavailable');
      if (job.brief.includes('Omit repair source')) data.tasks[0].acceptedInputs.pop();
      if (job.brief.includes('No repair review')) data.tasks.pop();
      if (job.brief.includes('Self repair review')) data.tasks[1].workerId = data.tasks[0].workerId;
      if (job.brief.includes('Unreviewed repair')) data.tasks.push({ ...data.tasks[0], key: 'extra-repair' });
      if (job.brief.includes('Forged repair reference'))
        data.tasks[0].acceptedInputs[0] = { taskId: 'D-001', attemptId: 'forged', hash: 'forged' };
    }
    if (job.title.includes('Cycle plan')) data.tasks[0].dependencies = ['review'];
    if (job.title.includes('Engine plan')) data.tasks[0].resources = ['unreal:editor'];
    if (job.title.includes('Budget plan'))
      data.tasks.forEach(task => {
        task.maxSeconds = 600;
        task.maxAttempts = 3;
      });
    if (job.title.includes('Disabled plan')) data.tasks[0].workerId = 'W-08';
    if (job.title.includes('Missing plan')) data.tasks[1].dependencies = ['nonexistent'];
    if (job.title.includes('Duplicate plan')) data.tasks[1].key = data.tasks[0].key;
    if (job.title.includes('Authority plan')) data.tasks[0].status = 'done';
    if (job.title.includes('Recursive plan')) data.tasks[0].kind = 'plan';
    if (job.title.includes('Empty review plan')) data.tasks[1].dependencies = [];
    if (job.title.includes('Oversized plan'))
      data.tasks = Array.from({ length: 11 }, (_, i) => ({ ...data.tasks[0], key: 'task-' + i }));
  }
  if (job.kind === 'review') {
    artifact = 'review.json';
    const instructions = JSON.parse(fs.readFileSync('../instructions.json', 'utf8'));
    const assignment = JSON.parse(instructions.layers.find(layer => layer.title === 'Assignment').text);
    const evidence = [];
    for (const dep of assignment.inputs)
      for (const input of dep.artifacts) {
        const contents = fs.readFileSync(input.path);
        if (hash(contents) !== input.hash) throw new Error('Fixture received a changed accepted input.');
        evidence.push(
          `Accepted input ${dep.taskId}, attempt ${dep.attemptId}, path ${input.path}, SHA-256 ${input.hash}. Model-free fixture only.`,
        );
      }
    data = { verdict: 'pass', findings: [], evidence };
    if (job.title.includes('Empty evidence')) data.evidence = [];
    if (job.title.includes('No supplied input'))
      data.evidence = ['Fixture claims a pass despite having no supplied accepted artifacts.'];
    if (job.title.includes('Non-text evidence')) data.evidence = [42];
    if (job.title.includes('Non-text findings')) data.findings = [{}];
    if (job.title.includes('Whitespace evidence')) data.evidence = ['   '];
    if (job.title.includes('Revision verdict')) {
      data.verdict = 'revise';
      data.findings = ['Clarify the objective landmark.'];
    }
    if (job.title.includes('Missing findings')) {
      data.verdict = 'revise';
      data.findings = [];
    }
  }
  if (job.kind === 'studio-development:review') {
    const instructions = JSON.parse(fs.readFileSync('../instructions.json', 'utf8')),
      assignment = JSON.parse(instructions.layers.find(layer => layer.title === 'Assignment').text),
      input = assignment.inputs
        .flatMap(dep => dep.artifacts.map(item => ({ ...item, taskId: dep.taskId, attemptId: dep.attemptId })))
        .find(item => item.kind === 'source-check-report');
    const bytes = fs.readFileSync(input.path),
      report = JSON.parse(bytes);
    if (hash(bytes) !== input.hash || assignment.reviewShape.proposal.complexity !== 1)
      throw new Error('Source review contract or accepted input changed.');
    artifact = 'source-review.json';
    data = {
      ...assignment.reviewShape,
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
    };
  }
  if (job.kind === 'studio-development:breakdown') {
    const instructions = JSON.parse(fs.readFileSync('../instructions.json', 'utf8')),
      assignment = JSON.parse(instructions.layers.find(layer => layer.title === 'Assignment').text);
    if (assignment.breakdownShape.schemaVersion !== 'source-breakdown-v1' || !prompt.includes('source-breakdown.json'))
      throw new Error('Source breakdown contract was not delivered.');
    if (assignment.inputs.length !== 1) throw new Error('Breakdown requires its exact checks.');
    const input = assignment.inputs[0],
      reportItem = input.artifacts.find(item => item.kind === 'source-check-report'),
      contextItem = input.artifacts.find(item => item.kind === 'source-context');
    for (const item of input.artifacts)
      if (hash(fs.readFileSync(item.path)) !== item.hash) throw new Error('Changed breakdown input.');
    const report = JSON.parse(fs.readFileSync(reportItem.path, 'utf8')),
      context = JSON.parse(fs.readFileSync(contextItem.path, 'utf8')),
      engineer = assignment.roster.find(worker => /engineer/i.test(worker.role));
    if (!engineer || context.sourceHash !== report.source.hash || report.execution.fixture)
      throw new Error('Breakdown needs measured source context and a project engineer.');
    artifact = 'source-breakdown.json';
    data = {
      schemaVersion: 'source-breakdown-v1',
      source: {
        taskId: input.taskId,
        attemptId: input.attemptId,
        path: 'check-report.json',
        hash: reportItem.hash,
        sourceHash: report.source.hash,
        contextPath: 'source-context.json',
        contextHash: contextItem.hash,
      },
      summary: 'Model-free protocol fixture: two linked source stories for the director idea.',
      stories: ['src/core/projects.mjs', 'src/core/workflows.mjs'].map((file, index) => ({
        key: ['validate', 'document'][index],
        kind: 'studio-development:change',
        workerId: engineer.id,
        title: ['Validate the idea', 'Document the idea'][index],
        scope: 'One bounded protocol fixture story using the supplied source evidence.',
        acceptance: 'Measured checks preserve project boundaries.',
        complexity: index + 1,
        dependencies: index ? ['validate'] : [],
        files: [report.source.files.find(item => item.path === file).path],
      })),
    };
    if (job.title.includes('Wrong source')) data.source.contextHash = '0'.repeat(64);
    if (job.title.includes('Unmeasured path')) data.stories[0].files = ['src/unmeasured.mjs'];
    if (job.title.includes('Protected path')) data.stories[0].files = ['AGENTS.md'];
    if (job.title.includes('Traversing path')) data.stories[0].files = ['src/../README.md'];
    if (job.title.includes('Existing new file')) data.stories[0].newFiles = ['src/core/workflows.mjs'];
    if (job.title.includes('Invalid new file')) data.stories[0].newFiles = ['data/new.json'];
  }
  const bom = job.title.includes('BOM review') && !job.direction.includes('UTF-8 without BOM') ? '\uFEFF' : '';
  fs.writeFileSync(artifact, bom + JSON.stringify(data));
  if (job.title.includes('Tamper')) fs.writeFileSync('AGENTS.md', 'changed instructions');
  const result = {
    taskId: job.id,
    outcome: 'completed',
    summary: 'Protocol fixture returned staged files.',
    artifacts: [
      {
        path: job.title.includes('Escape') ? '../assignment.json' : artifact,
        kind:
          job.kind === 'studio-development:breakdown'
            ? 'source-breakdown'
            : job.kind === 'studio-development:review'
              ? 'source-review'
              : ['review', 'plan'].includes(job.kind)
                ? job.kind
                : 'layout',
      },
    ],
    checks: [{ name: 'Fixture', status: 'not-run', evidence: 'No real CLI or model was invoked.' }],
    issues: [],
    handoff: 'Review required.',
  };
  const target = args[args.indexOf('--output-last-message') + 1];
  fs.writeFileSync(target, JSON.stringify(result));
  console.log(JSON.stringify({ type: 'turn.completed' }));
}

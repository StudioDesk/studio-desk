import fs from 'node:fs';
import path from 'node:path';

export function runMock(entry) {
  const { attempt: a, output, definition } = entry;
  this.store.event(
    'log',
    a.taskId,
    a.id,
    'Simulator: demonstrating the workflow. Output quality is not evidence about an LLM.',
  );
  entry.mockTimer = setTimeout(
    () => {
      if (entry.cancelled) return;
      try {
        const { artifact, data, checks, kind } = definition.simulate({ attempt: a, output });
        fs.writeFileSync(path.join(output, artifact), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
        const result = {
          taskId: a.taskId,
          outcome: 'completed',
          summary: `Simulated ${a.assignment.kind} output ready for review.`,
          artifacts: [{ path: artifact, kind: kind || a.assignment.kind }],
          checks,
          issues: ['Simulator output; no model or editor was used.'],
          handoff: 'Director review required.',
        };
        this.finish(entry, result);
      } catch (err) {
        this.finish(entry, null, err.message);
      }
    },
    Number(process.env.STUDIO_MOCK_DELAY_MS || 1600),
  );
}

export const simulatorAdapter = {
  id: 'mock',
  version: 'simulator-v1',
  name: 'Simulator',
  workerSelectable: true,
  capabilities: ['text-output'],
  status: () => ({ available: true, label: 'Simulator, no model calls' }),
  blockReason: (runtime, verifyAuth, task) =>
    typeof runtime.workflows.get(task.kind).simulate === 'function'
      ? ''
      : 'This task has no registered simulator behavior.',
  configuration: (runtime, worker) => structuredClone(worker),
  delivery: 'Simulator reads recorded bundle; no model used.',
  deliveryScope: 'Write staged outputs here only. Inputs and result schema are supplied in the parent directory.',
  requestedModel: worker => worker.model || 'CLI default',
  start: (runtime, entry) => runtime.runMock(entry),
};

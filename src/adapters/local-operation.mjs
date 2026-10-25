import fs from 'node:fs';
import path from 'node:path';
import { synchronous } from '../core/connectors.mjs';
import { operationEvidence } from '../core/operations.mjs';

export const localOperationAdapter = {
  id: 'local-operation',
  version: 'local-operation-v1',
  name: 'Local data operation',
  workerSelectable: false,
  capabilities: ['local-json'],
  status: () => ({ available: true, label: 'Deterministic local JSON only; no model or engine calls' }),
  blockReason: (runtime, verifyAuth, task) =>
    runtime.workflows.get(task.kind).operation ? '' : 'A local operation binding is required.',
  configuration: (runtime, worker) => ({ ...structuredClone(worker), executionAdapter: 'local-operation' }),
  requestedModel: () => 'No model',
  delivery: 'Controller processes recorded fixture data and stages JSON artifacts.',
  deliveryScope:
    'Operation receives data values only; fixed JSON artifacts are staged by the controller. No external paths, commands, credentials or network targets.',
  start(runtime, entry) {
    // Defer one turn, allowing ordinary cancellation and atomic conflicting claims.
    entry.mockTimer = setTimeout(() => {
      if (entry.cancelled) return;
      try {
        const a = entry.attempt,
          recorded = a.operation;
        const operation = runtime.registries.connectors.resolve(entry.definition.operation);
        const data = synchronous(
          operation.run({
            data: structuredClone(recorded.input.data),
            configuration: structuredClone(recorded.configuration),
          }),
        );
        fs.writeFileSync(path.join(entry.output, 'records.json'), JSON.stringify(data, null, 2));
        fs.writeFileSync(
          path.join(entry.output, 'operation-evidence.json'),
          JSON.stringify(operationEvidence(a), null, 2),
        );
        runtime.finish(entry, {
          taskId: a.taskId,
          outcome: 'completed',
          summary: `Local fixture records processed for ${a.assignment.kind}.`,
          artifacts: [
            { path: 'records.json', kind: operation.artifactKind },
            { path: 'operation-evidence.json', kind: 'local-operation-evidence' },
          ],
          checks: [
            {
              name: 'Engine / scene / render verification',
              status: 'not-run',
              evidence: 'Fixture data only; no production tools were connected.',
            },
          ],
          issues: ['Fixture composition evidence; not a production game or architecture workflow.'],
          handoff: 'Inspect local data and provenance; director acceptance required.',
        });
      } catch (error) {
        runtime.finish(entry, null, error.message);
      }
    }, 0);
  },
};

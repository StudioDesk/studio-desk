import fs from 'node:fs';
import { hash } from './contracts.mjs';
import { artifactPath, acceptedReference } from './artifacts.mjs';
import { synchronous } from './connectors.mjs';

export function prepareOperation(store, connectors, task, binding) {
  const operation = connectors.resolve(binding);
  let data, source;
  if (binding.source === 'task-data') {
    data = connectors.inputData(binding, task.inputData);
    source = { type: 'task-data', hash: hash(JSON.stringify(data)) };
  } else {
    if (task.inputData !== undefined) throw new Error('Accepted-artifact operations cannot substitute supplied data.');
    const candidates = task.dependencies.flatMap(taskId => {
      const ref = acceptedReference(store, taskId);
      return ref.artifacts.filter(item => item.kind === operation.artifactKind).map(item => ({ ref, item }));
    });
    if (candidates.length !== 1)
      throw new Error('Choose exactly one accepted artifact matching the operation input contract.');
    const { ref, item } = candidates[0],
      attempt = store.attempt(ref.attemptId);
    const bytes = fs.readFileSync(artifactPath(store, attempt, item.path));
    if (bytes.length > 64 * 1024 || hash(bytes) !== item.hash)
      throw new Error('Accepted operation input is oversized or changed.');
    data = connectors.inputData(binding, JSON.parse(bytes.toString('utf8')));
    source = {
      type: 'accepted-artifact',
      taskId: ref.taskId,
      attemptId: ref.attemptId,
      path: item.path,
      kind: item.kind,
      hash: item.hash,
    };
  }
  const configuration = structuredClone(binding.configuration);
  return {
    connectorId: operation.connectorId,
    connectorVersion: operation.connectorVersion,
    id: operation.id,
    version: operation.version,
    inputContract: operation.inputContract,
    outputContract: operation.outputContract,
    scope: operation.scope,
    requiredResources: [...operation.requiredResources],
    evidence: operation.evidence,
    recovery: operation.recovery,
    externalMutation: operation.externalMutation,
    configuration,
    input: { data, source },
  };
}
export function operationEvidence(attempt) {
  const operation = attempt.operation;
  return {
    schemaVersion: 'local-operation-evidence-v1',
    taskId: attempt.taskId,
    attemptId: attempt.id,
    operation: { connectorId: operation.connectorId, id: operation.id, version: operation.version },
    source: operation.input.source,
    configurationHash: hash(JSON.stringify(operation.configuration)),
    directionHash: hash(attempt.assignment.direction),
    inputDataHash: hash(JSON.stringify(operation.input.data)),
    evidence:
      'Deterministic local processing of fixture records. No model, scene, engine, render or playtest checks performed.',
  };
}
export function validateOperationResult(connectors, attempt, readArtifact) {
  const recorded = attempt.operation;
  const operation = connectors.resolve({
    connector: recorded.connectorId,
    operation: recorded.id,
    inputContract: recorded.inputContract,
    outputContract: recorded.outputContract,
    source: recorded.input.source.type,
    configuration: recorded.configuration,
  });
  if (operation.version !== recorded.version || operation.connectorVersion !== recorded.connectorVersion)
    throw new Error('Recorded operation contract changed.');
  const output = JSON.parse(readArtifact('records.json').toString('utf8'));
  synchronous(operation.validateOutput(output));
  const expected = synchronous(
    operation.run({
      data: structuredClone(recorded.input.data),
      configuration: structuredClone(recorded.configuration),
    }),
  );
  if (JSON.stringify(output) !== JSON.stringify(expected))
    throw new Error('Operation output does not match recorded inputs and configuration.');
  const evidence = JSON.parse(readArtifact('operation-evidence.json').toString('utf8'));
  if (JSON.stringify(evidence) !== JSON.stringify(operationEvidence(attempt)))
    throw new Error('Operation evidence does not match recorded provenance.');
  const item = attempt.artifacts.find(item => item.path === 'records.json');
  if (item.kind !== operation.artifactKind) throw new Error('Operation artifact has an incompatible contract kind.');
  return [
    {
      name: 'Local operation contract and provenance',
      status: 'pass',
      evidence: 'Output recomputed from recorded input, binding configuration and exact source identity.',
    },
  ];
}

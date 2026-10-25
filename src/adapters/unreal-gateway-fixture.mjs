import fs from 'node:fs';
import { UnrealGateway, editorResource, validateBlockoutManifest, validateEditorPin } from '../unreal-gateway.mjs';
import { artifactPath, validateAcceptedReferences } from '../core/artifacts.mjs';

// This adapter preserves the existing controller-owned fixture path. It cannot
// launch a real engine, and employees never receive raw editor tools.
export const unrealGatewayFixtureAdapter = {
  id: 'unreal-gateway-fixture',
  version: 'unreal-gateway-fixture-v1',
  name: 'Unreal gateway fixture',
  capabilities: ['unreal-editor'],
  initialize: (runtime, options) => {
    runtime.gateway = new UnrealGateway(runtime.store, options.integrationDriver, options.integrationTimeoutMs);
  },
  status: runtime => runtime.gateway.status(),
  blockReason(runtime, verifyAuth, task) {
    const gateway = runtime.gateway;
    if (!gateway.status().available) return gateway.status().reason;
    if (verifyAuth) {
      validateEditorPin(task.integration.pin);
      const source = task.integration.source;
      const a = runtime.store.attempt(source.reference.attemptId);
      const item = a.artifacts.find(
        item =>
          item.path === source.artifact.path && item.kind === 'unreal-manifest' && item.hash === source.artifact.hash,
      );
      if (
        !item ||
        JSON.stringify(
          validateBlockoutManifest(JSON.parse(fs.readFileSync(artifactPath(runtime.store, a, item.path), 'utf8'))),
        ) !== JSON.stringify(task.integration.manifest)
      )
        throw new Error('Accepted integration manifest no longer matches its pinned scope.');
    }
    return gateway.pending.size ? 'An editor operation may still be running; reconcile its ownership first.' : '';
  },
  configuration: (runtime, worker) => ({
    ...structuredClone(worker),
    execution: 'controller-owned gateway fixture; no CLI process',
  }),
  requestedModel: () => 'No model',
  delivery: 'Controller-owned model-free gateway fixture. No employee editor access; no real engine calls.',
  deliveryScope: 'Only the controller-owned fixture gateway may execute the pinned integration manifest.',
  start: (runtime, entry) =>
    runtime.gateway
      .execute(
        entry,
        (entry, result, error) => runtime.finish(entry, result, error),
        () => validateAcceptedReferences(runtime.store, entry.attempt.assignment.acceptedInputs),
      )
      .finally(() => {
        runtime.active.delete(entry.attempt.id);
        if (!runtime.closing) runtime.schedule();
      }),
  stop: (runtime, entry) => {
    entry.cancelled = true;
    runtime.gateway.uncertain(
      entry,
      entry.timedOut ? 'Integration time limit reached.' : 'Integration cancellation requested.',
    );
  },
  reconcile: (runtime, taskId) => runtime.gateway.reconcile(taskId),
  recover(runtime, a) {
    a.integration = {
      ...structuredClone(a.assignment.integration),
      ...a.integration,
      state: 'uncertain',
      operations: a.integration?.operations || [],
      leaseToken: runtime.store.leases().find(l => l.resource === editorResource && l.attemptId === a.id)?.token,
    };
  },
  shutdown: runtime => {
    runtime.gateway.closed = true;
  },
  shutdownWait: runtime => runtime.gateway.timeoutMs + 250,
};

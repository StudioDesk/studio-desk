// Legacy exports preserve script/fixture imports without coupling the core to games.
import { compileInstructions as compile } from './core/instructions.mjs';
import { defaultRegistries } from './registry.mjs';
import { adapterText } from './core/execution.mjs';
export { hash, resultSchema, validateResult } from './core/contracts.mjs';
export { catalog, layoutExample, validateLayout, validateReview } from './packs/game-production/contracts.mjs';
export function compileInstructions(org, worker, task, attemptId, workspace, inputs) {
  const definition = defaultRegistries.workflows.get(task.kind);
  const adapter = defaultRegistries.adapters.get(definition.executionAdapter || worker.provider);
  return compile(org, worker, task, attemptId, workspace, inputs, {
    ...definition.instructions({ org, task, registries: defaultRegistries }),
    deliveryScope: adapterText(adapter, 'deliveryScope', worker, { adapters: defaultRegistries.adapters }),
  });
}

// Compatibility entry point for scripts and existing callers.
import { Runner as Orchestrator } from './core/orchestrator.mjs';
import { defaultRegistries } from './registry.mjs';
export { artifactPath, acceptedReference, validateAcceptedReferences } from './core/artifacts.mjs';
export { locateCodex } from './adapters/codex.mjs';
export { subscriptionEnvironment } from './adapters/process.mjs';
export class Runner extends Orchestrator {
  constructor(store, options = {}) {
    super(store, { ...options, registries: options.registries || defaultRegistries });
  }
}

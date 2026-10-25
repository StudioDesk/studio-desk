// Explicitly imported trusted operations; no employee-supplied registration code.
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(value);
const freeze = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
export function synchronous(value) {
  if (value?.then) throw new Error('Local operation contracts must complete synchronously.');
  return value;
}
export class ConnectorRegistry {
  constructor() {
    this.connectors = new Map();
    this.operations = new Map();
  }
  register(connector) {
    if (
      !identifier(connector.id) ||
      !identifier(connector.version) ||
      this.connectors.has(connector.id) ||
      !Array.isArray(connector.operations) ||
      !connector.operations.length
    )
      throw new Error('Invalid or duplicate connector.');
    const operations = new Map();
    for (const operation of connector.operations) {
      if (
        !identifier(operation.id) ||
        operations.has(operation.id) ||
        !identifier(operation.version) ||
        !identifier(operation.capability) ||
        !identifier(operation.inputContract) ||
        !identifier(operation.outputContract) ||
        !identifier(operation.artifactKind) ||
        !Array.isArray(operation.requiredResources) ||
        !operation.requiredResources.every(identifier) ||
        ['validateInput', 'validateConfiguration', 'run', 'validateOutput'].some(
          method => typeof operation[method] !== 'function',
        )
      )
        throw new Error('Invalid local operation contract.');
      // This slice supports in-memory transforms with fixed staged output only.
      if (
        operation.scope !== 'staged-json-only' ||
        operation.recovery !== 'reconcile-before-new-attempt' ||
        operation.evidence !== 'local-data-only' ||
        operation.externalMutation !== false
      )
        throw new Error('Unsupported local operation scope or recovery behavior.');
      operations.set(
        operation.id,
        freeze({
          ...operation,
          requiredResources: [...operation.requiredResources],
          connectorId: connector.id,
          connectorVersion: connector.version,
        }),
      );
    }
    for (const [id, operation] of operations) this.operations.set(`${connector.id}/${id}`, operation);
    this.connectors.set(connector.id, Object.freeze({ id: connector.id, version: connector.version }));
    return this;
  }
  resolve(binding) {
    const operation = this.operations.get(`${binding.connector}/${binding.operation}`);
    if (!operation) throw new Error(`Unknown connector operation: ${binding.connector}/${binding.operation}.`);
    if (binding.inputContract !== operation.inputContract || binding.outputContract !== operation.outputContract)
      throw new Error('Workflow binding has incompatible operation contracts.');
    if (!['task-data', 'accepted-artifact'].includes(binding.source))
      throw new Error('Unsupported operation input source.');
    synchronous(operation.validateConfiguration(structuredClone(binding.configuration)));
    return operation;
  }
  inputData(binding, data) {
    const operation = this.resolve(binding),
      encoded = JSON.stringify(data);
    if (!encoded || Buffer.byteLength(encoded) > 64 * 1024)
      throw new Error('Operation input must be JSON smaller than 64 KB.');
    const copy = JSON.parse(encoded);
    synchronous(operation.validateInput(copy, structuredClone(binding.configuration)));
    return copy;
  }
  describe() {
    return [...this.operations.values()].map(
      ({
        connectorId,
        connectorVersion,
        id,
        version,
        capability,
        inputContract,
        outputContract,
        scope,
        requiredResources,
        evidence,
        recovery,
        externalMutation,
      }) => ({
        connectorId,
        connectorVersion,
        id,
        version,
        capability,
        inputContract,
        outputContract,
        scope,
        requiredResources,
        evidence,
        recovery,
        externalMutation,
      }),
    );
  }
}

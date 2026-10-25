const id = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value);
function validateRecords(data) {
  if (
    !data ||
    Object.keys(data).some(key => !['schemaVersion', 'records'].includes(key)) ||
    data.schemaVersion !== 'records-v1' ||
    !Array.isArray(data.records) ||
    data.records.length < 1 ||
    data.records.length > 100
  )
    throw new Error('Expected records-v1 with 1 to 100 records.');
  const ids = new Set();
  for (const record of data.records) {
    if (
      !record ||
      Object.keys(record).some(key => !['id', 'label', 'category'].includes(key)) ||
      !id(record.id) ||
      ids.has(record.id) ||
      !id(record.category) ||
      typeof record.label !== 'string' ||
      !record.label.trim() ||
      record.label.length > 200
    )
      throw new Error('Invalid or duplicate bounded record.');
    ids.add(record.id);
  }
}
function validateConfiguration(configuration) {
  if (
    !configuration ||
    Object.keys(configuration).some(key => key !== 'categories') ||
    !Array.isArray(configuration.categories) ||
    !configuration.categories.length ||
    configuration.categories.length > 10 ||
    !configuration.categories.every(id) ||
    new Set(configuration.categories).size !== configuration.categories.length
  )
    throw new Error('Choose a bounded set of record categories.');
}
function validateScopedRecords(data, configuration) {
  validateRecords(data);
  validateConfiguration(configuration);
  if (data.records.some(record => !configuration.categories.includes(record.category)))
    throw new Error('Input category is outside the workflow binding.');
}
export const localRecordsConnector = {
  id: 'local-records',
  version: 'local-records-v1',
  operations: [
    {
      id: 'normalize',
      version: 'normalize-v1',
      capability: 'local-json',
      inputContract: 'records-v1',
      outputContract: 'records-v1',
      artifactKind: 'normalized-records',
      scope: 'staged-json-only',
      requiredResources: ['local:record-processing'],
      evidence: 'local-data-only',
      recovery: 'reconcile-before-new-attempt',
      externalMutation: false,
      validateInput: validateScopedRecords,
      validateConfiguration,
      run({ data, configuration }) {
        validateScopedRecords(data, configuration);
        return {
          schemaVersion: 'records-v1',
          records: data.records
            .map(record => ({ id: record.id, label: record.label.trim(), category: record.category }))
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
        };
      },
      validateOutput: validateRecords,
    },
  ],
};

// Two domain configurations of the same operation. These are data fixtures only.
// Both packs share one data format, as both bind the same operation contract.
const recordsFormat = { id: 'records-v1', label: 'Normalized records', artifactKind: 'normalized-records' };
function definition(domain, categories, source) {
  return {
    kind: `${domain}-fixture:${source === 'task-data' ? 'prepare' : 'handoff'}`,
    version: 'fixture-records-v1',
    label: `${domain === 'game' ? 'Game kit' : 'Architecture spaces'} fixture ${source === 'task-data' ? 'data' : 'accepted handoff'}`,
    cardLabel: 'Data fixture',
    creatable: true,
    requiredCapabilities: [],
    requiredResources: [],
    executionAdapter: 'local-operation',
    ...(source === 'accepted-artifact' ? { consumes: [recordsFormat.id] } : {}),
    produces: [recordsFormat.id],
    operation: {
      connector: 'local-records',
      operation: 'normalize',
      inputContract: 'records-v1',
      outputContract: 'records-v1',
      source,
      configuration: { categories },
    },
    instructions: () => ({
      scopeNote: 'Local record fixture only. No geometry, engine, renderer or playtest checks.',
      assignment: { domain, requiredCategories: categories },
      layers: [
        {
          title: 'Fixture workflow criteria',
          text: `Supply one record for each category: ${categories.join(', ')}. The dependent handoff consumes an exact accepted records artifact and requires its own director acceptance.`,
        },
      ],
    }),
    validateOutput({ readArtifact, checks }) {
      const data = JSON.parse(readArtifact('records.json'));
      if (categories.some(category => !data.records.some(record => record.category === category)))
        throw new Error('Fixture output is missing a required workflow category.');
      checks.push({
        name: 'Fixture domain categories',
        status: 'pass',
        evidence: `Recorded data includes ${categories.join(', ')}; no scene validation performed.`,
      });
    },
  };
}
export const gameCompositionFixture = {
  id: 'game-composition-fixture',
  version: 'composition-fixture-v1',
  formats: [recordsFormat],
  tasks: [
    definition('game', ['entry', 'objective', 'exit'], 'task-data'),
    definition('game', ['entry', 'objective', 'exit'], 'accepted-artifact'),
  ],
};
export const architectureCompositionFixture = {
  id: 'architecture-composition-fixture',
  version: 'composition-fixture-v1',
  formats: [recordsFormat],
  tasks: [
    definition('architecture', ['public', 'private'], 'task-data'),
    definition('architecture', ['public', 'private'], 'accepted-artifact'),
  ],
};

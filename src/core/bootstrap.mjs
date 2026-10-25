// Called by Store only for a fresh database. Selection never rewrites stored records.
export function bootstrapFactory(
  registries,
  { organizationPreset = 'game-studio', workflowPresets = ['game-production'] } = {},
) {
  return () => {
    const preset = registries.organizations.get(organizationPreset);
    const organization = structuredClone(preset.create());
    if (!Array.isArray(workflowPresets) || new Set(workflowPresets).size !== workflowPresets.length)
      throw new Error('Choose distinct workflow starter presets.');
    const tasks = workflowPresets.flatMap(id => {
      const pack = registries.workflows.packs.get(id);
      if (!pack) throw new Error(`Unknown workflow starter preset: ${id}.`);
      return pack.bootstrap ? pack.bootstrap({ organization: structuredClone(organization) }) : [];
    });
    if (new Set(tasks.map(task => task.id)).size !== tasks.length)
      throw new Error('Workflow starter task IDs conflict.');
    for (const task of tasks) {
      const worker = organization.workers.find(worker => worker.id === task.workerId);
      registries.workflows.get(task.kind);
      if (!worker || worker.team !== task.team || task.dependencies.some(id => !tasks.some(input => input.id === id)))
        throw new Error('Workflow starter assignment has an incompatible organization or dependency.');
    }
    // A preset may name the projects a fresh database starts with; without, the store's legacy project.
    return {
      organization,
      tasks,
      ...(Array.isArray(preset.projects) ? { projects: structuredClone(preset.projects) } : {}),
    };
  };
}

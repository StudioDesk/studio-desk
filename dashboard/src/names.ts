// How the dashboard names an agent: its display name, from the project's agents or the company directory.
import type { Shell } from './api';

export const workerName = (state: Pick<Shell, 'workers' | 'employeeDirectory'> | null, id?: string) =>
  state?.workers.find(worker => worker.id === id)?.displayName ??
  state?.employeeDirectory?.find(worker => worker.id === id)?.displayName ??
  id ??
  'Unassigned';

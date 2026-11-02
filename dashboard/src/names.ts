// How the dashboard names an agent: its display name, from the project's agents or the company directory.
import type { Shell } from './api';

export const workerName = (state: Pick<Shell, 'workers' | 'employeeDirectory'> | null, id?: string) =>
  state?.workers.find(worker => worker.id === id)?.displayName ??
  state?.employeeDirectory?.find(worker => worker.id === id)?.displayName ??
  id ??
  'Unassigned';

// A staffing role in words: its label from the studio's roles, else its ID with its hyphens and underscores as
// spaces, in lower case ("Markets researcher" or markets-researcher: "markets researcher").
export const roleName = (state: Pick<Shell, 'roles'> | null, id: string) =>
  (state?.roles?.find(role => role.id === id)?.label ?? id.replace(/[-_]+/g, ' ')).toLowerCase();

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A text the director reads, with the staffing role IDs it names in words as roleName names them: every role the
// studio knows (its roles and those its agents hold) whose ID has a hyphen or underscore, where the ID stands whole,
// not inside a longer word or ID. A single-word ID such as "engineer" already reads as a word and stays.
export function namingRoles(state: Pick<Shell, 'roles' | 'workers'> | null, text: string) {
  const ids = new Set([
      ...(state?.roles ?? []).map(role => role.id),
      ...(state?.workers ?? []).flatMap(worker => (worker as { roles?: string[] }).roles ?? []),
    ]),
    coded = [...ids].filter(id => typeof id === 'string' && /[-_]/.test(id)).sort((a, b) => b.length - a.length);
  if (!coded.length || !text) return text;
  const whole = new RegExp(`(?<![\\p{L}\\p{N}_-])(?:${coded.map(escaped).join('|')})(?![\\p{L}\\p{N}_-])`, 'gu');
  return text.replace(whole, id => roleName(state, id));
}

export const catalog = {
  version: 'starter-kit-v1',
  note: 'Logical design kit only. These IDs have not been mapped to your Unreal assets.',
  modules: ['room-entry', 'room-objective', 'room-exit'],
  constraints: { rooms: 3, requiredRoute: ['entry', 'objective', 'exit'] },
};
export const layoutExample = {
  catalogVersion: catalog.version,
  seed: 17,
  rooms: [
    {
      id: 'entry',
      module: 'room-entry',
      position: [0, 0, 0],
      purpose: 'Orient the player; show the objective landmark.',
    },
    {
      id: 'objective',
      module: 'room-objective',
      position: [1000, 0, 0],
      purpose: 'Collect the objective; change tension.',
    },
    { id: 'exit', module: 'room-exit', position: [2000, 0, 0], purpose: 'Complete the route with clear feedback.' },
  ],
  links: [
    { from: 'entry', to: 'objective' },
    { from: 'objective', to: 'exit' },
  ],
  objective: 'objective',
  exit: 'exit',
  rationale: 'A short readable sequence with a visible destination and distinct objective space.',
};
export function validateLayout(layout) {
  const failures = [];
  if (!layout || layout.catalogVersion !== catalog.version) failures.push('Wrong module catalog version.');
  if (!Number.isInteger(layout?.seed)) failures.push('A reproducible integer seed is required.');
  const rooms = Array.isArray(layout?.rooms) ? layout.rooms : [];
  if (rooms.length !== 3) failures.push('The brief requires exactly three rooms.');
  const ids = new Set();
  for (const r of rooms) {
    if (!r || typeof r.id !== 'string' || !r.id || ids.has(r.id))
      failures.push('Room IDs must be unique nonempty strings.');
    ids.add(r?.id);
    if (!catalog.modules.includes(r?.module)) failures.push('A room uses an unknown module.');
    if (!Array.isArray(r?.position) || r.position.length !== 3 || !r.position.every(Number.isFinite))
      failures.push('Room positions must have three finite coordinates.');
    if (typeof r?.purpose !== 'string' || !r.purpose.trim()) failures.push('Each room needs a design purpose.');
  }
  const edges = Array.isArray(layout?.links) ? layout.links : [];
  for (const e of edges)
    if (!ids.has(e?.from) || !ids.has(e?.to)) failures.push('A connection references a missing room.');
  for (const id of ['entry', layout?.objective, layout?.exit])
    if (!ids.has(id)) failures.push('Entry, objective, and exit must exist.');
  if (new Set(['entry', layout?.objective, layout?.exit]).size !== 3)
    failures.push('Entry, objective, and exit must be three distinct rooms.');
  const visited = new Set(['entry']);
  for (let i = 0; i < rooms.length; i++) for (const e of edges) if (visited.has(e?.from)) visited.add(e.to);
  if (!visited.has(layout?.objective) || !visited.has(layout?.exit))
    failures.push('Objective and exit must be reachable from entry.');
  const fromObjective = new Set([layout?.objective]);
  for (let i = 0; i < rooms.length; i++) for (const e of edges) if (fromObjective.has(e?.from)) fromObjective.add(e.to);
  if (!fromObjective.has(layout?.exit)) failures.push('Exit must be reachable after the objective.');
  if (typeof layout?.rationale !== 'string' || !layout.rationale.trim())
    failures.push('Explain the intended experience.');
  return failures;
}
export function validateReview(review) {
  if (
    !review ||
    !['pass', 'revise', 'blocked'].includes(review.verdict) ||
    !Array.isArray(review.findings) ||
    !Array.isArray(review.evidence)
  )
    throw new Error('Review file needs verdict, findings, and evidence.');
  const nonemptyText = value => typeof value === 'string' && value.trim().length > 0;
  if (!review.findings.every(nonemptyText) || !review.evidence.length || !review.evidence.every(nonemptyText))
    throw new Error(
      'Review findings and evidence must contain nonempty text; at least one evidence entry is required.',
    );
  if (review.verdict !== 'pass' && !review.findings.length)
    throw new Error('A revise or blocked review must explain its findings.');
  return review;
}

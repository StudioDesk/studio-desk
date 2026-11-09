// The step contract (1.2's graph engine, decided by the director on November 2, 2026). A step's behavior is data, not a
// guess from its kind's name: which of a short catalog of kinds it is, and what it receives and may propose. A task type
// declares the contract its steps start from (`step`); a node in a flow will override it for itself. This first part
// holds the catalog, the contract's checked shape, and the facts core read from kind names until now (library delivery
// and library proposals). Each later part adds its fields here: owners, checks and their consequences, acceptance,
// limits, resources, an operation's effect and the actions the director may take.
export const STEP_KINDS = Object.freeze(['work', 'review', 'plan', 'decide', 'gate', 'operation', 'for-each', 'join']);
// What a step receives from the project's library: the newest revisions, the revisions the work it takes as input
// received (so a review checks against what the work followed), or nothing.
export const LIBRARY_DELIVERY = Object.freeze(['current', 'same-as-inputs', 'none']);

// What each kind does unless its contract says otherwise. Only an agent's step proposes files for the library; a step
// the studio runs itself, or a decision, has no agent to propose them. Result-producing kinds default to acceptance over
// a failed check with a director's reason (decided November 2, 2026); a decision, a gate, a for-each or a join records none.
// The legacy game-production `plan` type opts out: its separate plan/proposal approval refuses failed checks.
const kindDefaults = Object.freeze({
  work: { receives: { library: 'current' }, proposes: { library: true }, acceptance: { acceptOver: true } },
  review: { receives: { library: 'same-as-inputs' }, proposes: { library: false }, acceptance: { acceptOver: true } },
  plan: { receives: { library: 'current' }, proposes: { library: true }, acceptance: { acceptOver: true } },
  decide: { receives: { library: 'none' }, proposes: { library: false }, acceptance: { acceptOver: false } },
  gate: { receives: { library: 'none' }, proposes: { library: false }, acceptance: { acceptOver: false } },
  operation: { receives: { library: 'current' }, proposes: { library: false }, acceptance: { acceptOver: true } },
  'for-each': { receives: { library: 'none' }, proposes: { library: false }, acceptance: { acceptOver: false } },
  join: { receives: { library: 'none' }, proposes: { library: false }, acceptance: { acceptOver: false } },
});

function closed(value, allowed, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(key => !allowed.includes(key))
  )
    throw new Error(`${label} takes only ${allowed.join(', ')}.`);
}

// A task type's or a node's contract, checked: its kind from the catalog, and any of the fields it overrides.
export function validateStep(step, label = 'A step') {
  closed(step, ['kind', 'receives', 'proposes', 'acceptance'], label);
  if (!STEP_KINDS.includes(step.kind)) throw new Error(`${label}'s kind is one of ${STEP_KINDS.join(', ')}.`);
  if (step.receives !== undefined) {
    closed(step.receives, ['library'], `${label}'s receives`);
    if (step.receives.library !== undefined && !LIBRARY_DELIVERY.includes(step.receives.library))
      throw new Error(`${label} receives the library as one of ${LIBRARY_DELIVERY.join(', ')}.`);
  }
  if (step.proposes !== undefined) {
    closed(step.proposes, ['library'], `${label}'s proposes`);
    if (step.proposes.library !== undefined && typeof step.proposes.library !== 'boolean')
      throw new Error(`${label}'s library proposals are true or false.`);
  }
  if (step.acceptance !== undefined) {
    closed(step.acceptance, ['acceptOver'], `${label}'s acceptance`);
    if (step.acceptance.acceptOver !== undefined && typeof step.acceptance.acceptOver !== 'boolean')
      throw new Error(`${label}'s acceptance over a failed check is true or false.`);
  }
  return step;
}

// The contract a step runs with: its kind's defaults under what its task type declares. A task type that declares
// none is work.
export function stepContract(definition) {
  const step = definition?.step ?? { kind: 'work' },
    base = kindDefaults[step.kind];
  return {
    kind: step.kind,
    receives: { ...base.receives, ...step.receives },
    proposes: { ...base.proposes, ...step.proposes },
    acceptance: { ...base.acceptance, ...step.acceptance },
  };
}

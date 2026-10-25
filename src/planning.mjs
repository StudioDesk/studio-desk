// Legacy game-planning entry point. Proposal validation is reusable core code.
import { defaultRegistries } from './registry.mjs';
import { validatePlan as validate } from './core/planning.mjs';
export { simulatedPlan } from './packs/game-production/planning.mjs';
export const planningContext = (org, repair) =>
  defaultRegistries.workflows.planningContext(org, repair, defaultRegistries.adapters);
// Recorded pre-extraction contexts have no explicit review-kind list.
export const validatePlan = (plan, context) =>
  validate(plan, { ...context, reviewKinds: context.reviewKinds || ['review'] });

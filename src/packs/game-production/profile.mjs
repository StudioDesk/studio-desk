// Compatibility factory. Organization selection and workflow starters are separate.
import { gameOrganization } from '../../organizations/game-studio/index.mjs';
import { gameStarterTasks } from './starter.mjs';

export function gameProfile() {
  const organization = gameOrganization();
  return { organization, tasks: gameStarterTasks({ organization }) };
}

// The core store only seeds a new database; existing organizations are untouched.
import { Store as CoreStore } from './core/store.mjs';
import { gameProfile } from './packs/game-production/profile.mjs';
export class Store extends CoreStore {
  constructor(directory, profile = gameProfile) {
    super(directory, profile);
  }
}

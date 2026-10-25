// Creates a stable copy of Studio desk to run the controller from, so pipeline
// integrations change this development copy instead of the running controller.
// Run from the development copy: npm run setup-stable [-- <stable folder>]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupStable } from './stable-copy.mjs';

const development = fileURLToPath(new URL('../', import.meta.url)).replace(/[\/]$/, ''),
  target = path.resolve(
    process.argv[2] || path.join(path.dirname(development), path.basename(development) + '-stable'),
  ),
  configuration = setupStable(development, target);
console.log(`Stable copy ready: ${target}
It uses the records in ${configuration.dataDirectory} and develops ${configuration.sourceRoot}.

Next:
1. Stop the controller running from this folder (Ctrl+C).
2. Start it from the stable copy: open "${target}" and run npm start (or start-studio).
3. After work is committed here, load it with npm run promote in the stable copy, then restart.`);

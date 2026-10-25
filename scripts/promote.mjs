// Loads committed work from the development branch into this stable copy by
// fast-forwarding it. Run in the stable copy: npm run promote [-- <branch, default main>]
// Restart the controller afterwards. Nothing is merged unless it fast-forwards.
import { fileURLToPath } from 'node:url';
import { promote } from './stable-copy.mjs';

const from = process.argv[2] || 'main',
  { branch, commits } = promote(fileURLToPath(new URL('../', import.meta.url)), from);
console.log(
  commits
    ? `Promoted ${from} into ${branch}:\n${commits}\n\nRestart the controller (Ctrl+C, then npm start) to load it.`
    : `${branch} already includes ${from}. Nothing to promote.`,
);

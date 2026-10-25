// Formatter fixture. It never runs Prettier; it marks each named file so tests can see that
// integration commits the formatted bytes rather than the reviewed candidate bytes.
import fs from 'node:fs';

const mode = process.argv[2];
if (mode === 'fail') {
  console.error('Fixture formatter failure.');
  process.exitCode = 2;
} else
  for (const file of process.argv.slice(3)) {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.endsWith('// formatted\n')) fs.writeFileSync(file, text + '// formatted\n');
  }

// Model-free stand-in for `npm ci` (Decision MP-026): leaves the marker a finished install has and one small
// package, so tests exercise installing and resolving without the network. A lockfile naming
// "fixture-npm-fails" fails as npm would.
import fs from 'node:fs';

if (fs.readFileSync('package-lock.json', 'utf8').includes('fixture-npm-fails')) {
  console.error('npm error code ENOTFOUND: the registry could not be reached.');
  process.exit(1);
}
fs.mkdirSync('node_modules/fixture-tool', { recursive: true });
fs.writeFileSync('node_modules/.package-lock.json', '{}');
fs.writeFileSync('node_modules/fixture-tool/package.json', '{"name":"fixture-tool","main":"index.js"}');
fs.writeFileSync('node_modules/fixture-tool/index.js', "module.exports = 'fixture tool';\n");
console.log('added 1 package from the model-free fixture');

// Builds the dashboard (Decision MP-026) into dist/, outside the folders a source snapshot covers. `npm run build` always builds; the supervisor
// builds before each launch only when the sources changed since the last build. Without installed build
// tools it says so, and the controller runs with no dashboard until it is built. A failed build keeps the previous one, since
// the new files are staged beside it and swapped in only after a successful build.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const inputs = ['dashboard/index.html', 'dashboard/src', 'vite.config.mjs', 'tsconfig.json', 'package-lock.json'];
// Relative imports in scripts and stylesheets, static or dynamic, and the extensions Vite tries for one without.
const relativeImport = /(?:\bfrom|\bimport)\s*\(?\s*['"](\.\.?\/[^'"\n?#]+)/g,
  extensions = ['', '.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'];

// Every file a build reads: the inputs above, and each file outside them that one of them imports by a relative
// path (the shared run rules, diff reader and stylesheet in public/), followed through that file's own imports.
export function dashboardSources(base = root) {
  const files = [],
    inside = relative => inputs.some(input => relative === input || relative.startsWith(input + '/'));
  const visit = relative => {
    const target = path.join(base, relative);
    if (!fs.existsSync(target)) return;
    if (fs.statSync(target).isDirectory())
      for (const name of fs.readdirSync(target).sort()) visit(path.posix.join(relative, name));
    else files.push(relative);
  };
  inputs.forEach(visit);
  for (let index = 0; index < files.length; index++) {
    if (!/\.(?:[cm]?[jt]sx?|css)$/.test(files[index])) continue;
    for (const [, specifier] of fs.readFileSync(path.join(base, files[index]), 'utf8').matchAll(relativeImport)) {
      const relative = path.posix.join(path.posix.dirname(files[index]), specifier),
        target =
          !relative.startsWith('..') &&
          extensions
            .map(extension => relative + extension)
            .find(file => fs.statSync(path.join(base, file), { throwIfNoEntry: false })?.isFile());
      if (target && !inside(target) && !files.includes(target)) files.push(target);
    }
  }
  return files;
}

export function dashboardSourceHash(base = root) {
  const hash = createHash('sha256');
  for (const relative of dashboardSources(base))
    hash
      .update(relative + '\0')
      .update(fs.readFileSync(path.join(base, relative)))
      .update('\0');
  return hash.digest('hex');
}

export function buildDashboard({ base = root, force = false, log = console.log } = {}) {
  const vite = path.join(base, 'node_modules', 'vite', 'bin', 'vite.js'),
    dist = path.join(base, 'dist'),
    stamp = path.join(dist, '.source-hash');
  if (!fs.existsSync(vite)) {
    log('Dashboard not built: run `npm ci` to install its build tools, then restart. The controller runs without it.');
    return { built: false, reason: 'not-installed' };
  }
  const source = dashboardSourceHash(base);
  if (!force && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === source)
    return { built: false, reason: 'current' };
  const staging = path.join(base, `.dist-${process.pid}`);
  fs.rmSync(staging, { recursive: true, force: true });
  const result = spawnSync(
    process.execPath,
    [vite, 'build', '--configLoader', 'native', '--outDir', staging, '--emptyOutDir', '--logLevel', 'warn'],
    {
      cwd: base,
      stdio: 'inherit',
    },
  );
  if (result.status !== 0) {
    fs.rmSync(staging, { recursive: true, force: true });
    log('Dashboard: the build failed, so the previous build stays in place.');
    return { built: false, reason: 'failed' };
  }
  fs.writeFileSync(path.join(staging, '.source-hash'), source);
  fs.rmSync(dist, { recursive: true, force: true });
  fs.renameSync(staging, dist);
  log('Dashboard built.');
  return { built: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = buildDashboard({ force: true }).built ? 0 : 1;

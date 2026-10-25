// A source profile says how the source pipeline works on one repository (1.0 item 8): the paths a
// snapshot covers, which of them stories may change, the names no story may touch, the documents the
// breakdown and reviews read, which files the Node test runner runs, the formatter integration
// applies and the snapshot limits. Studio desk's own values are its profile. A plan or check records
// its profile unless it is Studio desk's first revision, so records from before profiles, and from
// before the second revision, keep their exact shape and meaning.

export const maxProfileEntries = 50;
const segment = /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/;

const contextFiles = Object.freeze([
  'README.md',
  'HANDOFF.md',
  'docs/module-contracts.md',
  'src/core/projects.mjs',
  'src/core/workflows.mjs',
]);
const limits = Object.freeze({ files: 500, fileBytes: 1024 * 1024, totalBytes: 16 * 1024 * 1024 });

// What every check, plan and candidate recorded without a profile was measured with. It never changes:
// stories planned under it keep their exact snapshot after Studio desk's profile moves on.
export const studioDeskProfileRevision1 = Object.freeze({
  id: 'studio-desk',
  // Snapshot folders, which are also the folders stories may change, and the root files a snapshot covers.
  directories: Object.freeze(['src', 'public', 'test', 'scripts', 'docs']),
  files: Object.freeze(['package.json', 'AGENTS.md', 'HANDOFF.md', 'README.md', 'start-studio.cmd', 'start-studio.sh']),
  // Text types a story may create, change or delete.
  extensions: Object.freeze(['mjs', 'js', 'json', 'css', 'html', 'md']),
  // File names no story may create, change or delete, ignoring case; prettier.config.* is matched by prefix.
  protectedNames: Object.freeze(['AGENTS.md', 'CLAUDE.md', 'package.json', 'prettier.config.*']),
  contextFiles,
  // The Node test runner runs every <directory>/*<suffix> file, not those in subfolders.
  tests: Object.freeze({ directory: 'test', suffix: '.test.mjs' }),
  // Integration formats the changed files with this npm package; null skips formatting.
  formatter: Object.freeze({ package: 'prettier@3.3.3', args: Object.freeze(['--write']) }),
  limits,
});

// Studio desk's current profile, its second revision (Decision MP-026, v1.0 item 19b). The new dashboard's
// folder joins the snapshot with its build, type and lint configuration and the lockfile, which stay
// protected root files; stories may write TypeScript; no story may create a package manifest or a tool
// configuration under any name a tool would read, since ESLint uses the configuration nearest each file;
// and every copy the pipeline tests gets the packages installed from the lockfile (`install`).
export const studioDeskProfile = Object.freeze({
  ...studioDeskProfileRevision1,
  directories: Object.freeze([...studioDeskProfileRevision1.directories, 'dashboard']),
  files: Object.freeze([
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'vite.config.mjs',
    'eslint.config.js',
    'AGENTS.md',
    'HANDOFF.md',
    'README.md',
    'start-studio.cmd',
    'start-studio.sh',
  ]),
  extensions: Object.freeze([...studioDeskProfileRevision1.extensions, 'ts', 'tsx']),
  protectedNames: Object.freeze([
    'AGENTS.md',
    'CLAUDE.md',
    'package.json',
    'package-lock.json',
    'npm-shrinkwrap.json',
    'prettier.config.*',
    'eslint.config.*',
    'vite.config.*',
    'vitest.config.*',
    'tsconfig*',
  ]),
  install: 'npm-ci',
});

// Whether a tested copy gets the packages installed from its lockfile: always for Studio desk, whose stories
// planned under the first revision still start from commits that hold the new dashboard and its tests;
// for another project, when its profile says so.
export const installsPackages = profile => profile?.install === 'npm-ci' || profile?.id === studioDeskProfile.id;

// The profile a recorded plan or check was measured with.
export const profileOf = record => record?.profile || studioDeskProfileRevision1;
// What a plan or check records about its profile: nothing for Studio desk's first revision.
export const recordedProfile = profile =>
  !profile || profile === studioDeskProfileRevision1 ? {} : { profile: structuredClone(profile) };

// Every path a snapshot covers, so git checks use the same allowlist.
export const snapshotPaths = profile => [...profile.files, ...profile.directories];

// A top-level file a story may edit or delete: one the profile's snapshot lists, in a repository other than Studio
// desk, whose root files change only by hand. One the snapshot lists already exists, so no story creates a
// top-level file (found in the README-only fresh install: nanoid keeps its code in index.js).
const rootFileAllowed = (file, profile) => profile.id !== studioDeskProfile.id && profile.files.includes(file);
// Whether a story may create, change or delete this path under the profile. Route folders such as
// (group), [id] and [...slug] are allowed; a segment Windows would read as another name is not: a
// trailing dot, a device name, or only dots and brackets, which reads like a dot segment. A protected
// name stays protected with its brackets removed, so [A]GENTS.md is refused as AGENTS.md is.
export function storyPathAllowed(file, profile = studioDeskProfile) {
  if (typeof file !== 'string') return false;
  const parts = file.split('/'),
    name = parts.at(-1),
    extension = name.includes('.') ? name.split('.').at(-1) : '',
    names = [name, name.replace(/[()[\]]/g, '')].map(item => item.toLowerCase());
  return (
    (parts.length > 1 ? profile.directories.includes(parts[0]) : rootFileAllowed(file, profile)) &&
    /^[a-zA-Z0-9_./()[\]-]+$/.test(file) &&
    parts.every(
      part =>
        part &&
        !part.startsWith('.') &&
        !part.endsWith('.') &&
        !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) &&
        !/^[.()[\]]+$/.test(part),
    ) &&
    profile.extensions.includes(extension) &&
    !profile.protectedNames.some(pattern =>
      names.some(item =>
        pattern.endsWith('*') ? item.startsWith(pattern.slice(0, -1).toLowerCase()) : item === pattern.toLowerCase(),
      ),
    )
  );
}
// How the allowed paths read in an error message.
const protectedLabels = {
  'prettier.config.*': 'Prettier configuration',
  'eslint.config.*': 'ESLint configuration',
  'vite.config.*': 'Vite configuration',
  'vitest.config.*': 'Vitest configuration',
  'tsconfig*': 'TypeScript configuration',
};
const list = items => (items.length > 1 ? `${items.slice(0, -1).join(', ')} or ${items.at(-1)}` : items[0]);
export function storyPathRule(profile = studioDeskProfile) {
  return `new files go under ${list(profile.directories)} as ${list(profile.extensions.map(item => '.' + item))}, never in a dot-folder or as ${list(profile.protectedNames.map(name => protectedLabels[name] || name))}`;
}
// The same rule as the planners and editors who choose a story's paths read it.
export function storyPathScope(profile = studioDeskProfile) {
  const roots = profile.files.filter(file => storyPathAllowed(file, profile)),
    rootFiles = roots.length ? ` A story may also edit or delete the top-level files ${list(roots)}.` : '';
  return `Use paths under ${list(profile.directories)} ending in ${list(profile.extensions.map(item => '.' + item))}; never list ${list(profile.protectedNames.map(name => protectedLabels[name] || name))}, or any dot-path.${rootFiles}`;
}
export const isTestFile = (file, profile = studioDeskProfile) =>
  file.startsWith(profile.tests.directory + '/') &&
  !file.slice(profile.tests.directory.length + 1).includes('/') &&
  file.endsWith(profile.tests.suffix);

// Checks a profile other than Studio desk's before anything uses it. Paths are relative, use forward
// slashes and no dot segments.
export function validateSourceProfile(profile) {
  const problems = [];
  const fields = [
    'id',
    'directories',
    'files',
    'extensions',
    'protectedNames',
    'contextFiles',
    'tests',
    'formatter',
    'install',
    'limits',
  ];
  if (!profile || typeof profile !== 'object' || Array.isArray(profile))
    throw new Error('A source profile must be an object.');
  for (const key of Object.keys(profile)) if (!fields.includes(key)) problems.push(`unknown field ${key}`);
  if (typeof profile.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(profile.id))
    problems.push('id must be lowercase letters, digits and dashes');
  const relative = value =>
    typeof value === 'string' && value.split('/').every(part => segment.test(part) && part !== '..' && part !== '.');
  const list = (key, check, { empty = false } = {}) => {
    const value = profile[key];
    if (!Array.isArray(value) || (!empty && !value.length) || value.length > maxProfileEntries || !value.every(check))
      problems.push(`${key} must list ${empty ? 'up to' : '1 to'} ${maxProfileEntries} valid entries`);
    else if (new Set(value).size !== value.length) problems.push(`${key} must not repeat entries`);
  };
  list('directories', value => relative(value) && !value.includes('/'));
  list('files', value => relative(value) && !value.includes('/'), { empty: true });
  list('extensions', value => typeof value === 'string' && /^[a-z0-9]{1,10}$/.test(value));
  list('protectedNames', value => typeof value === 'string' && /^[a-zA-Z0-9_.-]+\*?$/.test(value), { empty: true });
  list('contextFiles', relative, { empty: true });
  const covered = file =>
    profile.files?.includes?.(file) || profile.directories?.includes?.(String(file).split('/')[0]);
  if (Array.isArray(profile.contextFiles) && profile.contextFiles.some(file => !covered(file)))
    problems.push('contextFiles must be files the snapshot covers');
  const tests = profile.tests;
  if (
    !tests ||
    Object.keys(tests).join() !== 'directory,suffix' ||
    !profile.directories?.includes?.(tests.directory) ||
    typeof tests.suffix !== 'string' ||
    !/^[a-zA-Z0-9_.-]+$/.test(tests.suffix)
  )
    problems.push('tests must name a snapshot directory and a file suffix');
  const formatter = profile.formatter;
  if (
    formatter !== null &&
    (!formatter ||
      Object.keys(formatter).join() !== 'package,args' ||
      typeof formatter.package !== 'string' ||
      !/^(@[a-z0-9-]+\/)?[a-z0-9.-]+@[0-9][0-9a-z.+-]*$/.test(formatter.package) ||
      !Array.isArray(formatter.args) ||
      formatter.args.length > 10 ||
      !formatter.args.every(arg => typeof arg === 'string' && /^--?[a-z][a-z0-9-]*(=[a-zA-Z0-9_.-]+)?$/.test(arg)))
  )
    problems.push('formatter must be null or a pinned npm package (name@version) with option arguments');
  // Whether every tested copy gets the packages installed from the repository's lockfile (MP-026).
  if ('install' in profile && ![null, 'npm-ci'].includes(profile.install))
    problems.push('install must be null or npm-ci');
  // What a larger repository needs, and what breaks first (record size, copy time), is decided with
  // step 4b's defaults; here limits only need to be positive whole numbers.
  const limits = profile.limits;
  if (
    !limits ||
    Object.keys(limits).join() !== 'files,fileBytes,totalBytes' ||
    !Object.values(limits).every(value => Number.isSafeInteger(value) && value > 0)
  )
    problems.push('limits must hold positive whole numbers for files, fileBytes and totalBytes');
  if (problems.length) throw new Error(`The source profile is not valid: ${problems.join('; ')}.`);
  return profile;
}

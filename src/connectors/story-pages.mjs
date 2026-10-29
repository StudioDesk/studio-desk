// A story's pages for the visual check (1.2 step 8): each a name, a path on the app's own address and optional steps to
// reach a state. Its own module, with no imports, so a breakdown's stories and the director's edits check them alike.
export const maxPages = 10,
  maxSteps = 10;

const failure = message => Object.assign(new Error(message), { status: 400 });
export const boundedText = (value, max) =>
  typeof value === 'string' && !!value.trim() && value.length <= max && !/[\0-\x1f\x7f]/.test(value);

// At most ten pages, each a distinct name, a path starting with /, and at most ten steps: { click: text },
// { type: text, into: a field's label } or { wait: text }.
export function validateStoryPages(pages, name = 'The pages') {
  if (!Array.isArray(pages) || pages.length > maxPages)
    throw failure(`${name} must be a list of at most ${maxPages} pages.`);
  const names = new Set();
  return pages.map((page, index) => {
    const at = `${name}: page ${index + 1}`;
    if (!page || typeof page !== 'object' || Array.isArray(page)) throw failure(`${at} must be an object.`);
    for (const key of Object.keys(page))
      if (!['name', 'path', 'steps'].includes(key)) throw failure(`${at} has an unknown field, ${key}.`);
    if (!boundedText(page.name, 80)) throw failure(`${at} needs a name of at most 80 characters.`);
    if (names.has(page.name.trim().toLowerCase())) throw failure(`${at} repeats the name ${page.name}.`);
    names.add(page.name.trim().toLowerCase());
    if (
      !boundedText(page.path, 300) ||
      !page.path.startsWith('/') ||
      page.path.startsWith('//') ||
      /\s/.test(page.path)
    )
      throw failure(`${at} needs a path on the app's own address, starting with / (such as /settings).`);
    const steps = page.steps ?? [];
    if (!Array.isArray(steps) || steps.length > maxSteps) throw failure(`${at} may have at most ${maxSteps} steps.`);
    return {
      name: page.name.trim(),
      path: page.path,
      steps: steps.map((step, number) => {
        const keys = step && typeof step === 'object' && !Array.isArray(step) ? Object.keys(step).sort().join() : '';
        if (keys === 'click' && boundedText(step.click, 200)) return { click: step.click };
        if (keys === 'wait' && boundedText(step.wait, 200)) return { wait: step.wait };
        if (keys === 'into,type' && boundedText(step.type, 500) && boundedText(step.into, 200))
          return { type: step.type, into: step.into };
        throw failure(
          `${at}, step ${number + 1} must be one of { "click": text }, { "type": text, "into": a field's label } or { "wait": text }.`,
        );
      }),
    };
  });
}

// An image's own name, from its path in the candidate (visual/01-board-1440-light.png) or its copy among a review's
// inputs (../inputs/T-1/12-01-board-1440-light.png): each check names its images uniquely.
const imageFile = image =>
  String(image)
    .split(/[\\/]/)
    .pop()
    .replace(/^\d+-(?=\d{2}-)/, '');

// The images a review must describe: the candidate's captures, as the review's inputs list them.
export const reviewedImages = review =>
  (review.inputReferences || []).flatMap(ref =>
    (ref.artifacts || []).filter(item => item.kind === 'visual-capture').map(item => item.path),
  );

// A review describes every image for a pass (the director, October 28: "the reviewer must look"): `visual` holds one
// entry per image, { image, note, verdict: match|problem }. Answers the problems, none when it holds.
export function reviewVisualProblems(report, images) {
  if (!images.length) return [];
  const names = images.map(imageFile),
    visual = report.visual;
  if (!Array.isArray(visual) || visual.length > 60)
    return [
      `visual must describe each of the ${images.length} captured images, one entry each: { image, note, verdict: match or problem }`,
    ];
  const problems = [];
  if (
    !visual.every(
      item =>
        item &&
        typeof item === 'object' &&
        names.includes(imageFile(item.image)) &&
        boundedText(item.note, 2000) &&
        ['match', 'problem'].includes(item.verdict),
    )
  )
    problems.push(
      `each visual entry needs an image (one of ${images.join(', ')}), a note of at most 2000 characters and a verdict of match or problem`,
    );
  const described = new Set(visual.map(item => imageFile(item?.image))),
    missing = images.filter(image => !described.has(imageFile(image)));
  if (report.verdict === 'pass' && missing.length)
    problems.push(`a pass describes every captured image; missing: ${missing.join(', ')}`);
  return problems;
}

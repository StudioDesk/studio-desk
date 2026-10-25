// Data formats name what a task consumes and produces (MP-015 G0). A format is a
// versioned identity carried by artifacts of one kind, with an optional synchronous
// content check. Task definitions declare ports as format IDs; the controller checks
// that connected tasks are compatible before anything runs, that results carry
// their produced formats and that dispatched inputs carry consumed ones.
// Undeclared ports are untyped and impose nothing, so existing definitions keep working.
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(value);

export class FormatRegistry {
  constructor() {
    this.formats = new Map();
    this.registered = new Map();
  }
  register(format) {
    if (
      !format ||
      !identifier(format.id) ||
      !identifier(format.artifactKind) ||
      typeof format.label !== 'string' ||
      !format.label.trim() ||
      !['json', 'text', undefined].includes(format.encoding) ||
      (format.validate !== undefined && typeof format.validate !== 'function')
    )
      throw new Error('Invalid data format.');
    // Packs may share a format object; a different definition cannot reuse its ID.
    if (this.registered.has(format.id)) {
      if (this.registered.get(format.id) !== format) throw new Error(`Data format ${format.id} is already registered.`);
      return this;
    }
    this.registered.set(format.id, format);
    this.formats.set(format.id, Object.freeze({ encoding: 'json', ...format }));
    return this;
  }
  get(id) {
    const format = this.formats.get(id);
    if (!format) throw new Error(`Unknown data format: ${id}.`);
    return format;
  }
  list() {
    return [...this.formats.values()];
  }
}

export function validatePorts(formats, task) {
  for (const port of ['consumes', 'produces']) {
    const ids = task[port];
    if (ids === undefined) continue;
    if (!Array.isArray(ids) || ids.length > 10 || new Set(ids).size !== ids.length || !ids.every(identifier))
      throw new Error(`Task ${port} must list distinct registered data format IDs.`);
    ids.forEach(id => formats.get(id));
  }
}

// Formats a typed task consumes that none of its upstream tasks produces.
// Untyped upstream tasks produce nothing that can be checked.
export function unmetConsumes(workflows, kind, upstreamKinds) {
  const produced = new Set(upstreamKinds.flatMap(upstream => workflows.find(upstream)?.produces || []));
  return (workflows.find(kind)?.consumes || []).filter(id => !produced.has(id));
}
export function portMessage(workflows, name, unmet) {
  const labels = unmet.map(id => `${workflows.formats.get(id).label} (${id})`).join(', ');
  return `${name} consumes ${labels}, but none of its prerequisites produces it.`;
}

// Runtime check that a result carries each produced format, with valid contents.
export function producedFormatChecks(formats, definition, attempt, readArtifact) {
  return (definition.produces || []).map(id => {
    const format = formats.get(id),
      items = attempt.artifacts.filter(item => item.kind === format.artifactKind);
    if (!items.length) throw new Error(`Result is missing its produced ${format.label} (${id}).`);
    if (format.validate)
      for (const item of items) {
        const contents = readArtifact(item.path).toString('utf8');
        let value = contents;
        if (format.encoding === 'json')
          try {
            value = JSON.parse(contents);
          } catch {
            throw new Error(`${item.path} is not valid JSON for ${format.label} (${id}).`);
          }
        const checked = format.validate(value);
        if (checked?.then) throw new Error('Data format checks must complete synchronously.');
      }
    return {
      name: `Produced data format ${id}`,
      status: 'pass',
      evidence: `${items.map(item => item.path).join(', ')} ${format.validate ? 'passed the format check' : 'carries the declared artifact kind'}.`,
    };
  });
}

// Dispatch check that the staged inputs carry each consumed format.
export function missingInputFormats(formats, definition, inputs) {
  const kinds = new Set(inputs.flatMap(ref => ref.artifacts.map(item => item.kind)));
  return (definition.consumes || []).filter(id => !kinds.has(formats.get(id).artifactKind));
}

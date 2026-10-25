// Controller transforms (MP-015 G3b): nodes think, edges transform. A join may name a
// registered transform; at dispatch the controller runs it over the join's accepted inputs and
// stages the result as one more input, recording its provenance on the attempt. No model,
// employee or subscription is involved, and the same inputs always give the same bytes.
import fs from 'node:fs';
import { hash } from './contracts.mjs';
import { artifactPath } from './artifacts.mjs';
import { itemListFormat, validateItemList } from './fanout.mjs';

export const collectionFormat = {
  id: 'collection-v1',
  label: 'Collected results',
  artifactKind: 'collection',
};
function json(contents, label) {
  try {
    return JSON.parse(contents.toString('utf8'));
  } catch {
    throw new Error(`${label} is not JSON, so it cannot be transformed.`);
  }
}
export const transforms = Object.freeze({
  // Every accepted JSON result in one document, with where each came from.
  // JSON results keep their parsed data, other UTF-8 text results their text; binary files
  // are listed without contents.
  collect: Object.freeze({
    id: 'collect',
    version: 'collect-v2',
    label: 'Collect accepted results',
    output: collectionFormat,
    accepts: () => true,
    run: inputs => ({
      schemaVersion: 'collection-v1',
      items: inputs.map(({ ref, item, contents }) => ({
        taskId: ref.taskId,
        attemptId: ref.attemptId,
        path: item.path,
        kind: item.kind,
        ...(item.path.endsWith('.json')
          ? { data: json(contents, item.path) }
          : !contents.includes(0) && Buffer.from(contents.toString('utf8')).equals(contents)
            ? { text: contents.toString('utf8') }
            : { binary: true, bytes: contents.length }),
      })),
    }),
  }),
  // One item list from several, keeping the first item for each repeated key.
  'merge-item-lists': Object.freeze({
    id: 'merge-item-lists',
    version: 'merge-item-lists-v1',
    label: 'Merge item lists, dropping repeated keys',
    output: itemListFormat,
    accepts: item => item.kind === itemListFormat.artifactKind,
    run: inputs => {
      const seen = new Set(),
        items = [];
      for (const { item, contents } of inputs)
        for (const entry of validateItemList(json(contents, item.path)).items)
          if (!seen.has(entry.key)) {
            seen.add(entry.key);
            items.push(entry);
          }
      return validateItemList({ schemaVersion: 'item-list-v1', items });
    },
  }),
});

// Runs a transform over hash-checked accepted inputs. Returns the staged file's bytes, the
// input reference the attempt records for it, and its provenance.
export function applyTransform(store, id, references) {
  const transform = transforms[id];
  if (!transform) throw new Error(`Unknown controller transform: ${id}.`);
  const inputs = [];
  for (const ref of references) {
    const attempt = store.attempt(ref.attemptId);
    for (const item of ref.artifacts.filter(transform.accepts)) {
      const contents = fs.readFileSync(artifactPath(store, attempt, item.path));
      if (hash(contents) !== item.hash) throw new Error('Accepted input was modified after acceptance.');
      inputs.push({ ref, item, contents });
    }
  }
  const contents = Buffer.from(JSON.stringify(transform.run(inputs), null, 2) + '\n'),
    output = { path: `../inputs/transform/${id}.json`, kind: transform.output.artifactKind, hash: hash(contents) };
  return {
    contents,
    reference: {
      taskId: `transform:${id}`,
      attemptId: null,
      summary: `${transform.label} (controller transform ${transform.version}).`,
      artifacts: [output],
    },
    provenance: {
      id,
      version: transform.version,
      inputs: inputs.map(({ ref, item }) => ({
        taskId: ref.taskId,
        attemptId: ref.attemptId,
        path: item.path,
        hash: item.hash,
      })),
      output,
    },
  };
}

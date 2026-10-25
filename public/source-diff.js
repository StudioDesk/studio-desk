// Recorded source evidence only. No DOM, I/O, source lookup or controller actions.
// Like runs.js this standalone script exposes one frozen browser namespace.
(() => {
  const limits = Object.freeze({
    diffBytes: 192 * 1024,
    manifestBytes: 1024 * 1024,
    afterBytes: 16 * 1024 * 1024,
    files: 1024,
    rows: 500,
    textBytes: 64 * 1024,
  });
  const encoder = new TextEncoder(),
    models = new WeakMap();
  const bytes = text => encoder.encode(text);
  const hash = async text => {
    if (!globalThis.crypto?.subtle) throw new Error('SHA-256 is unavailable in this environment.');
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(text))), n =>
      n.toString(16).padStart(2, '0'),
    ).join('');
  };
  const fail = reason => {
    throw new Error(reason);
  };
  const unavailable = reason => ({ status: 'unavailable', reason });
  const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const copyArtifact = item => ({ path: item.path, kind: item.kind, hash: item.hash });
  const uniqueArtifact = (attempt, kind, path) => {
    const found = (attempt?.artifacts || []).filter(a => a.kind === kind && (!path || a.path === path));
    return found.length === 1 && digest(found[0].hash) ? copyArtifact(found[0]) : null;
  };
  const implementation = a => a?.assignment?.kind === 'studio-development:change';
  const reviewAttempt = a => a?.assignment?.kind === 'studio-development:change-review';
  const complete = a =>
    ['review', 'accepted', 'revision_requested'].includes(a?.status) && a.result?.outcome === 'completed';
  const stamp = a => Date.parse(a.finishedAt || a.startedAt || '') || 0;
  const compare = (a, b) => stamp(b) - stamp(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  const sameReference = (ref, id) =>
    ref &&
    ref.taskId === id.taskId &&
    ref.attemptId === id.attemptId &&
    ref.path === id.manifest.path &&
    ref.hash === id.manifest.hash &&
    ref.candidateHash === id.candidateHash;

  // Stable across summary/detail hydration, polling and integration formatting.
  function identityKey(id) {
    return JSON.stringify([
      id.projectId,
      id.taskId,
      id.attemptId,
      id.manifest.path,
      id.manifest.hash,
      id.candidateHash,
      id.diff.path,
      id.diff.hash,
    ]);
  }

  // attempts may be dashboardAttempt summaries or full detail records. Explicit
  // selection never falls back. Selecting a review resolves its candidateReview;
  // a default story view always chooses a completed implementation, not lastAttemptId.
  function selectCandidate(task, attempts, { selectedAttemptId, reviewAttemptId } = {}) {
    if (!task || !Array.isArray(attempts)) return unavailable('Task and recorded attempts are required.');
    const inProject = a => !task.projectId || !a.projectId || a.projectId === task.projectId;
    const records = attempts.filter(inProject);
    if (new Set(records.map(a => a.id)).size !== records.length)
      return unavailable('Attempt identities are ambiguous; supply one summary or detail per attempt.');
    let selectedReview = null,
      candidate;
    const explicit = selectedAttemptId || reviewAttemptId;
    if (explicit) {
      const selected = records.find(a => a.id === explicit && a.taskId === task.id);
      if (!selected) return unavailable('The selected historical attempt is unavailable.');
      if (reviewAttempt(selected)) selectedReview = selected;
      else if (implementation(selected) && !reviewAttemptId) candidate = selected;
      else return unavailable('The selected attempt is not an implementation or candidate review.');
    } else if (task.kind === 'studio-development:change-review') {
      selectedReview = records.filter(a => a.taskId === task.id && reviewAttempt(a)).sort(compare)[0];
      if (!selectedReview) return unavailable('The recorded candidate review is unavailable.');
    } else {
      candidate = records.filter(a => a.taskId === task.id && implementation(a) && complete(a)).sort(compare)[0];
    }
    if (selectedReview) {
      const ref = selectedReview.candidateReview;
      candidate = ref && records.find(a => a.id === ref.attemptId && a.taskId === ref.taskId);
    }
    if (!candidate || !implementation(candidate) || !complete(candidate))
      return unavailable('No completed implementation candidate is available for this selection.');
    const manifest = uniqueArtifact(candidate, 'source-change', 'source-change.json'),
      diff = uniqueArtifact(candidate, 'source-change-diff', 'change.diff');
    if (!manifest || !diff || !digest(candidate.sourceCandidate?.sourceHash))
      return unavailable('This historical candidate lacks a registered unified diff or candidate identity.');
    Object.freeze(manifest);
    Object.freeze(diff);
    const identity = Object.freeze({
      projectId: task.projectId || candidate.projectId || '',
      taskId: candidate.taskId,
      attemptId: candidate.id,
      manifest,
      diff,
      candidateHash: candidate.sourceCandidate.sourceHash,
    });
    const pins = [task.sourceStage?.candidate, ...(task.sourceStage?.history || []).map(h => h.candidate)].filter(
      pin => pin?.attemptId === candidate.id,
    );
    if (
      pins.some(pin => !sameReference(pin, identity)) ||
      (selectedReview && !sameReference(selectedReview.candidateReview, identity))
    )
      return unavailable('The recorded candidate reference does not match this implementation.');
    const matching = selectedReview
      ? [selectedReview]
      : records.filter(a => reviewAttempt(a) && sameReference(a.candidateReview, identity)).sort(compare);
    let review = { state: 'awaiting-review', attemptId: null, verdict: null };
    for (const a of matching) {
      const forwarded = a.inputReferences?.find(
        ref => ref.taskId === identity.taskId && ref.attemptId === identity.attemptId,
      );
      // Forwarded paths are ../inputs/<task>/<index>-<basename>, not output paths.
      const supplied = [manifest, diff].every(artifact =>
        forwarded?.artifacts?.some(input => input.kind === artifact.kind && input.hash === artifact.hash),
      );
      const independent = a.workerId && candidate.workerId && a.workerId !== candidate.workerId;
      const report = uniqueArtifact(a, 'source-change-review', 'source-change-review.json');
      const reviewPin = [task.sourceStage, ...(task.sourceStage?.history || [])].find(
        h => h?.candidate?.attemptId === candidate.id && h.review?.attemptId === a.id,
      )?.review;
      const pinned =
        !reviewPin ||
        (reviewPin.taskId === a.taskId &&
          report &&
          reviewPin.path === report.path &&
          reviewPin.hash === report.hash &&
          reviewPin.verdict === a.candidateReviewVerdict);
      const valid = supplied && independent && a.candidateReview?.passed === true;
      const reviewed =
        valid && complete(a) && report && pinned && ['pass', 'needs-work'].includes(a.candidateReviewVerdict);
      review = {
        state: reviewed
          ? 'reviewed'
          : valid && ['running', 'stopping'].includes(a.status)
            ? 'review-in-progress'
            : 'review-evidence-unavailable',
        attemptId: a.id,
        verdict: reviewed ? a.candidateReviewVerdict : null,
      };
      break;
    }
    return Object.freeze({
      status: 'available',
      identity,
      key: identityKey(identity),
      review: Object.freeze(review),
      historical: !!explicit && task.sourceStage?.candidate?.attemptId !== candidate.id,
      artifacts: Object.freeze((candidate.artifacts || []).map(a => Object.freeze(copyArtifact(a)))),
    });
  }

  const boundedText = (text, limit, name) => {
    if (typeof text !== 'string' || text.length > limit || bytes(text).length > limit)
      fail(`${name} exceeds its UTF-8 byte limit or is not text.`);
    if (text.includes('\0') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text))
      fail(`${name} is not valid source text.`);
  };
  const validPath = path =>
    typeof path === 'string' &&
    path.length > 0 &&
    path.length <= 1024 &&
    !/[\x00-\x1f\x7f\\:]/.test(path) &&
    path.split('/').every(part => part && part !== '.' && part !== '..');
  const integer = n => Number.isSafeInteger(n) && n >= 0;
  const lineArray = text => text.match(/[^\n]*\n|[^\n]+$/g) || [];
  function sourceRow(kind, content, oldLine, newLine) {
    const lineEnding = content.endsWith('\r\n') ? '\r\n' : content.endsWith('\n') ? '\n' : '';
    return {
      kind,
      oldLine,
      newLine,
      text: lineEnding ? content.slice(0, -lineEnding.length) : content,
      lineEnding,
      noFinalNewline: !lineEnding,
    };
  }
  const contentOf = row => row.text + row.lineEnding;
  function omitted(file, oldStart, newStart, count) {
    const range = { kind: 'omitted', id: `${file.path}:${file.ranges.length}`, oldStart, newStart, count };
    file.ranges.push(range);
    file.rows.push(range);
  }
  function publish(selection, files) {
    const result = Object.freeze({
      status: files.some(f => f.evidence === 'incomplete') ? 'incomplete' : 'available',
      key: selection.key,
      identity: selection.identity,
      files: Object.freeze(
        files.map(f =>
          Object.freeze({
            path: f.path,
            operation: f.operation,
            added: f.added,
            removed: f.removed,
            evidence: f.evidence,
            reason: f.reason || '',
            rowCount: f.rows.length,
            afterText: f.after ? 'registered' : f.operation === 'deleted' ? 'not-applicable' : 'not-loaded',
            ranges: Object.freeze(f.ranges.map(r => Object.freeze({ ...r }))),
          }),
        ),
      ),
    });
    models.set(result, { selection, files });
    return result;
  }

  // Hash raw artifact bytes (including JSON whitespace), then parse strictly in
  // manifest order and consume each hunk by its declared old/new counts. Source
  // lines resembling headers cannot become file boundaries. Returns explicit
  // invalid/unavailable/incomplete evidence, never a partially plausible diff.
  async function parseDiff({ selection, manifestText, diffText }) {
    try {
      if (selection?.status !== 'available') return unavailable(selection?.reason || 'Select a candidate first.');
      if (selection.key !== identityKey(selection.identity)) fail('Selection identity key does not match.');
      boundedText(manifestText, limits.manifestBytes, 'Manifest');
      boundedText(diffText, limits.diffBytes, 'Diff');
      if (
        (await hash(manifestText)) !== selection.identity.manifest.hash ||
        (await hash(diffText)) !== selection.identity.diff.hash
      )
        fail('Recorded artifact hashes do not match.');
      const manifest = JSON.parse(manifestText);
      if (
        manifest.schemaVersion !== 'source-change-v1' ||
        (manifest.diffFormat !== undefined && manifest.diffFormat !== 'unified-full-deletions-v1')
      )
        return unavailable('This historical evidence format is unsupported.');
      if (manifest.candidateHash !== selection.identity.candidateHash)
        fail('Candidate identity does not match the manifest.');
      if (!Array.isArray(manifest.changes) || !manifest.changes.length || manifest.changes.length > limits.files)
        fail('Manifest needs a bounded nonempty changes list.');
      const names = new Set(),
        files = [],
        lines = diffText.split('\n');
      if (lines.pop() !== '') fail('Diff must end with a newline.');
      let at = 0;
      const expect = value => {
        if (lines[at++] !== value) fail(`Unexpected diff header at line ${at}.`);
      };
      for (const change of manifest.changes) {
        const { path, beforeHash, afterHash } = change;
        if (
          !validPath(path) ||
          names.has(path) ||
          !(beforeHash === null || digest(beforeHash)) ||
          !(afterHash === null || digest(afterHash)) ||
          beforeHash === afterHash ||
          !integer(change.bytes) ||
          change.bytes > limits.afterBytes
        )
          fail('Manifest contains an invalid, duplicate or unchanged file identity.');
        names.add(path);
        const operation = beforeHash === null ? 'created' : afterHash === null ? 'deleted' : 'edited';
        if (
          operation === 'deleted'
            ? change.bytes !== 0 || change.artifact !== undefined
            : change.artifact !== `changes/${path}` ||
              selection.artifacts.filter(a => a.path === change.artifact && a.kind === 'source-file').length !== 1 ||
              !selection.artifacts.some(
                a => a.path === change.artifact && a.kind === 'source-file' && a.hash === afterHash,
              )
        )
          fail(`Missing or mismatched registered staged artifact for ${path}.`);
        const file = {
          ...change,
          operation,
          rows: [],
          ranges: [],
          added: 0,
          removed: 0,
          evidence: 'complete',
          after: null,
        };
        expect(`diff --git a/${path} b/${path}`);
        if (operation === 'created') expect('new file mode 100644');
        if (operation === 'deleted') expect('deleted file mode 100644');
        expect(`--- ${beforeHash === null ? '/dev/null' : 'a/' + path}`);
        expect(`+++ ${afterHash === null ? '/dev/null' : 'b/' + path}`);
        let oldAt = 0,
          newAt = 0,
          oldEOF = false,
          newEOF = false,
          hunks = 0;
        while (at < lines.length && lines[at].startsWith('@@')) {
          const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/.exec(lines[at++]);
          if (!match) fail(`Malformed hunk header for ${path}.`);
          const [os, oc, ns, nc] = [
            Number(match[1]),
            match[2] === undefined ? 1 : Number(match[2]),
            Number(match[3]),
            match[4] === undefined ? 1 : Number(match[4]),
          ];
          if (![os, oc, ns, nc].every(integer) || (!oc && !nc) || (oc && !os) || (nc && !ns))
            fail(`Invalid hunk range for ${path}.`);
          const oldStart = oc ? os - 1 : os,
            newStart = nc ? ns - 1 : ns;
          if (
            !integer(oldStart + oc) ||
            !integer(newStart + nc) ||
            newStart + nc > change.bytes ||
            oldStart < oldAt ||
            newStart < newAt ||
            oldStart - oldAt !== newStart - newAt ||
            (oldEOF && oldStart > oldAt) ||
            (newEOF && newStart > newAt)
          )
            fail(`Overlapping or mismatched hunk positions for ${path}.`);
          if (oldStart > oldAt) omitted(file, oldAt + 1, newAt + 1, oldStart - oldAt);
          oldAt = oldStart;
          newAt = newStart;
          let oldCount = 0,
            newCount = 0;
          while (oldCount < oc || newCount < nc) {
            const raw = lines[at++],
              op = raw?.[0];
            if (!raw || !' +-'.includes(op)) fail(`Hunk ends early for ${path}.`);
            let content = raw.slice(1) + '\n';
            if (lines[at] === '\\ No newline at end of file') {
              content = content.slice(0, -1);
              at++;
            }
            if (content === '' || (op !== '+' && oldEOF) || (op !== '-' && newEOF))
              fail(`Invalid no-final-newline position for ${path}.`);
            if (op !== '+') {
              oldCount++;
              oldAt++;
              oldEOF = !content.endsWith('\n');
            }
            if (op !== '-') {
              newCount++;
              newAt++;
              newEOF = !content.endsWith('\n');
            }
            if (oldCount > oc || newCount > nc) fail(`Hunk counts disagree for ${path}.`);
            const kind = op === '+' ? 'added' : op === '-' ? 'removed' : 'context';
            file.rows.push(sourceRow(kind, content, op === '+' ? null : oldAt, op === '-' ? null : newAt));
            if (op === '+') file.added++;
            if (op === '-') file.removed++;
          }
          hunks++;
        }
        if (operation === 'deleted' && manifest.diffFormat === undefined && !hunks) {
          file.evidence = 'incomplete';
          file.added = null;
          file.removed = null;
          file.reason = 'Historical header-only deletion: removed counts and content are unavailable.';
        } else if (operation !== 'edited') {
          const expectedKind = operation === 'created' ? 'added' : 'removed';
          if (file.ranges.length || file.rows.some(row => row.kind !== expectedKind))
            fail(`Non-complete ${operation} evidence for ${path}.`);
          const text = file.rows.map(contentOf).join('');
          if (
            (await hash(text)) !== (afterHash ?? beforeHash) ||
            (operation === 'created' && bytes(text).length !== change.bytes)
          )
            fail(`Full ${operation} content does not match ${path}.`);
        } else {
          if (!hunks || (!file.added && !file.removed)) fail(`Edited file has no changed rows: ${path}.`);
          // The tail length cannot be known from a context-limited diff alone.
          if (!newEOF) omitted(file, oldAt + 1, newAt + 1, null);
        }
        files.push(file);
      }
      if (at !== lines.length) fail(`Unexpected extra diff text at line ${at + 1}.`);
      return publish(selection, files);
    } catch (error) {
      return { status: globalThis.crypto?.subtle ? 'invalid' : 'unavailable', reason: error.message, files: [] };
    }
  }

  const modelFile = (model, path) => {
    const data = models.get(model),
      file = data?.files.find(f => f.path === path);
    if (!file) fail('Unknown model or file.');
    return { data, file };
  };
  // Caller supplies ONLY text from the selection's registered source-file route.
  // Hash and reverse-application checks reject today's source, formatted integration
  // output, another attempt's text, or content inconsistent with the original diff.
  // Returns a new model; the original remains usable and unchanged.
  async function registerAfterText(model, path, { key, artifact, text }) {
    try {
      const { data, file } = modelFile(model, path);
      if (key !== data.selection.key || artifact !== file.artifact || file.afterHash === null)
        fail('Staged after-text is not registered for this selected file.');
      boundedText(text, limits.afterBytes, 'Staged after-text');
      if (bytes(text).length !== file.bytes || (await hash(text)) !== file.afterHash)
        fail('Staged after-text hash or byte count does not match.');
      const after = lineArray(text),
        before = [],
        ranges = [],
        rows = [];
      let next = 0;
      for (const row of file.rows) {
        if (row.kind === 'omitted') {
          if (next !== row.newStart - 1) fail('Omitted range starts at the wrong line.');
          const count = row.count ?? after.length - next;
          if (count < 0 || next + count > after.length) fail('Omitted range exceeds staged after-text.');
          if (
            row.oldStart - 1 !== before.length ||
            (count && before.length && !before[before.length - 1].endsWith('\n'))
          )
            fail('Omitted context cannot follow the original final line or have mismatched positions.');
          for (let i = 0; i < count; i++) before.push(after[next++]);
          if (count) {
            const range = { ...row, count };
            ranges.push(range);
            rows.push(range);
          }
        } else {
          if (row.newLine !== null && (row.newLine !== next + 1 || after[next++] !== contentOf(row)))
            fail('Diff content differs from staged after-text.');
          if (row.kind !== 'added') before.push(contentOf(row));
          if (row.oldLine !== null && row.oldLine !== before.length) fail('Original line numbers do not match.');
          rows.push(row);
        }
      }
      if (
        next !== after.length ||
        (file.beforeHash === null ? before.length !== 0 : (await hash(before.join(''))) !== file.beforeHash)
      )
        fail('Diff does not reconstruct the recorded original.');
      const updated = { ...file, rows, ranges, after };
      return publish(
        data.selection,
        data.files.map(f => (f === file ? updated : f)),
      );
    } catch (error) {
      return { status: 'invalid', reason: error.message, files: [] };
    }
  }

  // Cursors are {row, offset}; offset is a UTF-16 index at a code-point boundary.
  // A long logical row is returned in multiple chunks, each with the same index
  // and line numbers. Budgets count chunks and UTF-8 source text bytes. Metadata
  // and no-final-newline flags accompany the final chunk without consuming text.
  function sliceRows(
    length,
    getRow,
    { cursor = { row: 0, offset: 0 }, rowBudget = 120, textByteBudget = 16 * 1024 } = {},
  ) {
    if (
      !Number.isInteger(rowBudget) ||
      rowBudget < 1 ||
      rowBudget > limits.rows ||
      !Number.isInteger(textByteBudget) ||
      textByteBudget < 4 ||
      textByteBudget > limits.textBytes
    )
      fail('Slice budgets must be finite and within the published limits.');
    let { row, offset } = cursor;
    if (!integer(row) || row > length || !integer(offset) || (row === length && offset)) fail('Invalid slice cursor.');
    const out = [];
    let used = 0;
    while (row < length && out.length < rowBudget) {
      const source = getRow(row),
        text = source.text || '';
      if (offset > text.length || (offset && /[\uDC00-\uDFFF]/.test(text[offset] || ''))) fail('Invalid text offset.');
      let end = offset;
      while (end < text.length) {
        const cp = text.codePointAt(end),
          width = cp > 0xffff ? 2 : 1;
        const cost = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
        if (used + cost > textByteBudget) break;
        used += cost;
        end += width;
      }
      if (end === offset && end < text.length) break;
      const ending = source.lineEnding || '';
      const done = end === text.length && used + ending.length <= textByteBudget;
      if (done) used += ending.length;
      if (!done && end === offset) break;
      out.push({
        ...source,
        index: row,
        text: text.slice(offset, end),
        textOffset: offset,
        textEnd: end,
        complete: done,
        lineEnding: done ? ending : '',
        noFinalNewline: done && !!source.noFinalNewline,
      });
      if (done) {
        row++;
        offset = 0;
      } else {
        offset = end;
        break;
      }
    }
    return { status: 'available', rows: out, textBytes: used, nextCursor: row < length ? { row, offset } : null };
  }
  function fileSlice(model, path, options) {
    const { file } = modelFile(model, path);
    if (file.evidence === 'incomplete') return unavailable(file.reason);
    return sliceRows(file.rows.length, i => file.rows[i], options);
  }
  function rangeSlice(model, path, rangeId, options) {
    const { file } = modelFile(model, path),
      range = file.ranges.find(r => r.id === rangeId);
    if (!range) return unavailable('The omitted range is unavailable.');
    if (!file.after) return unavailable("Load this file's registered staged after-text to expand unchanged lines.");
    return sliceRows(
      range.count,
      i => sourceRow('context', file.after[range.newStart - 1 + i], range.oldStart + i, range.newStart + i),
      options,
    );
  }
  globalThis.StudioSourceDiff = Object.freeze({
    limits,
    identityKey,
    selectCandidate,
    parseDiff,
    registerAfterText,
    fileSlice,
    rangeSlice,
  });
})();

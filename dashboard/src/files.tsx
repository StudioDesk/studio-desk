// Recorded files read in the dashboard (v1.0 item 14; app-work.js previews and readers): text and Markdown in
// place through the shared reader (public/markdown-reader.js), images and logical layouts as pictures, a review
// as its findings, and any file over the page beside its download. Candidate source is evidence and is read in
// the source diff, never here. Each read is cached by its attempt, path and recorded hash.
import '../../public/markdown-reader.js';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { AttemptSummary } from './api';
import { Dialog } from './design/dialog';
import { useNarrow } from './use-narrow';

const reader = (globalThis as unknown as { StudioMarkdownReader: { markdown(text: string): string } })
  .StudioMarkdownReader;

export interface FileRecord {
  path: string;
  hash: string;
  kind?: string;
}

export const artifactUrl = (projectId: string, attemptId: string, path: string) =>
  `/api/attempts/${encodeURIComponent(attemptId)}/artifact?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`;
export const imageFile = (path: string) => /\.(svg|png|jpe?g|webp|gif)$/i.test(path);
const sourceEvidence = (attempt: AttemptSummary) =>
  ['studio-development:change', 'studio-development:change-review'].includes(
    String((attempt.assignment as { kind?: string } | undefined)?.kind ?? ''),
  );
export const candidateSourceFile = (attempt: AttemptSummary, item: FileRecord) =>
  item.kind === 'source-file' ||
  !!attempt.artifacts?.some(other => other.path === item.path && other.kind === 'source-file') ||
  ((sourceEvidence(attempt) || !!attempt.sourceCandidate) && item.path.startsWith('changes/'));
// Text an agent returned for reading: Markdown, plain text, CSV or a work file.
export const readableFile = (attempt: AttemptSummary, item: FileRecord) =>
  !candidateSourceFile(attempt, item) &&
  !imageFile(item.path) &&
  !/\.json$/i.test(item.path) &&
  (/\.(md|markdown|txt|csv)$/i.test(item.path) || item.kind === 'work-file');
export const previewable = (attempt: AttemptSummary, item: FileRecord) =>
  !candidateSourceFile(attempt, item) && (imageFile(item.path) || item.path.endsWith('layout.json'));

async function fetchFile(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`The recorded file could not be read (${response.status}).`);
  return response;
}

function useFileText(projectId: string, attemptId: string, item: FileRecord, enabled = true) {
  return useQuery({
    enabled,
    queryKey: [projectId, 'file', attemptId, item.path, item.hash],
    queryFn: async ({ signal }) => (await fetchFile(artifactUrl(projectId, attemptId, item.path), signal)).text(),
    staleTime: Infinity,
  });
}

const readerLimit = 8000;

// Recorded text as Markdown or as plain text, the first 8,000 characters until the director asks for the rest. A
// Markdown file, or text an agent wrote as Markdown (`markdown`), such as a task's brief, is read as Markdown.
export function TextReader({ text, path = '', markdown = false }: { text: string; path?: string; markdown?: boolean }) {
  const [expanded, setExpanded] = useState(false),
    long = text.length > readerLimit,
    visible = long && !expanded ? text.slice(0, readerLimit) : text;
  return (
    <div className="sd-reader">
      {markdown || /\.(md|markdown)$/i.test(path) ? (
        // The shared reader turns recorded text into inert markup without an HTML parser.
        <div className="sd-reader__text" dangerouslySetInnerHTML={{ __html: reader.markdown(visible) }} />
      ) : (
        <pre className="sd-reader__plain">{visible}</pre>
      )}
      {long && !expanded && (
        <div className="sd-reader__more">
          <span className="sd-meta">Showing the first {readerLimit} characters.</span>
          <button type="button" className="sd-btn sd-btn--sm" aria-expanded="false" onClick={() => setExpanded(true)}>
            Show the rest
          </button>
        </div>
      )}
    </div>
  );
}

export function FileText({ projectId, attemptId, item }: { projectId: string; attemptId: string; item: FileRecord }) {
  const { data, error } = useFileText(projectId, attemptId, item);
  if (error)
    return (
      <p className="sd-meta" role="status" style={{ margin: 0, color: 'var(--bad)' }}>
        This file could not be read, or it changed since it was recorded: {error.message} Download it to try the
        recorded file.
      </p>
    );
  if (data === undefined)
    return (
      <p className="sd-meta" role="status" style={{ margin: 0 }}>
        Loading the recorded text…
      </p>
    );
  return <TextReader text={data} path={item.path} />;
}

// An SVG shown only when it is plain drawing: no scripts, links, styles or external references.
function safeSvg(text: string) {
  if (/<!DOCTYPE|<!ENTITY|<\?(?!xml\s)/i.test(text)) throw new Error('This SVG cannot be previewed safely.');
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  if (
    doc.querySelector('parsererror') ||
    doc.documentElement.localName !== 'svg' ||
    doc.documentElement.namespaceURI !== 'http://www.w3.org/2000/svg'
  )
    throw new Error('Invalid SVG.');
  const tags = new Set(
    'svg g path rect circle ellipse line polyline polygon title desc defs linearGradient radialGradient stop clipPath mask text tspan'.split(
      ' ',
    ),
  );
  for (const element of doc.querySelectorAll('*')) {
    if (!tags.has(element.localName) || element.namespaceURI !== 'http://www.w3.org/2000/svg')
      throw new Error('This SVG uses unsupported preview content.');
    for (const attribute of element.attributes) {
      if (attribute.namespaceURI === 'http://www.w3.org/2000/xmlns/') continue;
      if (
        /^on|href$|^src$|^style$/i.test(attribute.localName) ||
        /(?:https?:|file:|data:|javascript:|\/\/)/i.test(attribute.value) ||
        (/url\(/i.test(attribute.value) && !/^url\(\s*#[\w.:-]+\s*\)$/i.test(attribute.value))
      )
        throw new Error('This SVG uses external or active content.');
    }
  }
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
}

// A PNG, JPEG, GIF or WebP whose bytes match its name, as a data URL.
export function imageSource(bytes: Uint8Array, name: string) {
  const format =
    /\.png$/i.test(name) && bytes[0] === 137 && bytes[1] === 80
      ? 'png'
      : /\.jpe?g$/i.test(name) && bytes[0] === 255 && bytes[1] === 216
        ? 'jpeg'
        : /\.gif$/i.test(name) && String.fromCharCode(...bytes.slice(0, 3)) === 'GIF'
          ? 'gif'
          : /\.webp$/i.test(name) && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
            ? 'webp'
            : null;
  if (!format) throw new Error('Unsupported image preview.');
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return `data:image/${format};base64,${btoa(binary)}`;
}

interface Layout {
  rooms: { id: string; position: number[] }[];
  links: { from: string; to: string }[];
  objective?: string;
}
type Picture = { image: string } | { layout: Layout };

function checkedLayout(value: Layout) {
  if (!Array.isArray(value.rooms) || value.rooms.length < 1 || value.rooms.length > 40 || !Array.isArray(value.links))
    throw new Error('No layout preview.');
  if (
    value.rooms.some(
      room => !Array.isArray(room.position) || room.position.length !== 3 || !room.position.every(Number.isFinite),
    )
  )
    throw new Error('Invalid layout positions.');
  return value;
}

// A logical room layout drawn from its recorded positions; no engine view.
function LayoutThumbnail({ layout }: { layout: Layout }) {
  const xs = layout.rooms.map(room => room.position[0]!),
    ys = layout.rooms.map(room => room.position[1]!),
    minX = Math.min(...xs),
    minY = Math.min(...ys),
    dx = Math.max(...xs) - minX || 1,
    dy = Math.max(...ys) - minY || 1,
    flat = dy === 1 && ys.every(y => y === minY),
    points = new Map(
      layout.rooms.map((room, index) => [
        room.id,
        [35 + ((xs[index]! - minX) / dx) * 230, flat ? 80 : 35 + ((ys[index]! - minY) / dy) * 90] as const,
      ]),
    );
  return (
    <span className="sd-layoutmap">
      <svg viewBox="0 0 300 160" role="img" aria-label="Logical room layout">
        {layout.links.slice(0, 100).map((link, index) => {
          const p = points.get(link.from),
            q = points.get(link.to);
          return p && q ? <line key={index} x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} /> : null;
        })}
        {layout.rooms.map(room => {
          const [x, y] = points.get(room.id)!;
          return (
            <g key={room.id}>
              <rect
                x={x - 25}
                y={y - 22}
                width="50"
                height="44"
                rx="9"
                data-objective={room.id === layout.objective ? '' : undefined}
              />
              <text x={x} y={y + 4} textAnchor="middle">
                {String(room.id).slice(0, 14)}
              </text>
            </g>
          );
        })}
      </svg>
      <span className="sd-meta">Logical layout · no engine view</span>
    </span>
  );
}

function usePicture(url: string, name: string, key: unknown[]) {
  return useQuery({
    queryKey: key,
    queryFn: async ({ signal }): Promise<Picture> => {
      const bytes = new Uint8Array(await (await fetchFile(url, signal)).arrayBuffer());
      if (name.endsWith('layout.json'))
        return { layout: checkedLayout(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) };
      if (/\.svg$/i.test(name)) return { image: safeSvg(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
      return { image: imageSource(bytes, name) };
    },
    staleTime: Infinity,
    retry: false,
  });
}

function PictureView({ picture, name }: { picture: ReturnType<typeof usePicture>; name: string }) {
  if (picture.error)
    return (
      <span className="sd-picture__pending">
        Preview unavailable
        <br />
        <small>Download it to look at the recorded file.</small>
      </span>
    );
  if (!picture.data) return <span className="sd-picture__pending">Loading the preview…</span>;
  return 'layout' in picture.data ? (
    <LayoutThumbnail layout={picture.data.layout} />
  ) : (
    <img src={picture.data.image} alt={name} decoding="async" />
  );
}

export function Preview({ projectId, attemptId, item }: { projectId: string; attemptId: string; item: FileRecord }) {
  const picture = usePicture(artifactUrl(projectId, attemptId, item.path), item.path, [
    projectId,
    'picture',
    attemptId,
    item.path,
    item.hash,
  ]);
  return <PictureView picture={picture} name={item.path} />;
}

interface Report {
  verdict?: string;
  findings?: string[];
  evidence?: string[];
}
const parsedReport = (text: string) => {
  try {
    return JSON.parse(text) as Report;
  } catch {
    return null;
  }
};

// A review's report: its verdict, findings and evidence.
function ReviewReport({ text, report }: { text: string; report: Report }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-12)' }}>
      <h3 style={{ margin: 0, font: '800 19px/1.25 var(--font-display)' }}>Review · {report.verdict}</h3>
      <span className="sd-eyebrow">Findings</span>
      {report.findings?.length ? (
        <ul className="sd-reader__text" style={{ margin: 0 }}>
          {report.findings.map((finding, index) => (
            <li key={index}>{finding}</li>
          ))}
        </ul>
      ) : (
        <p style={{ margin: 0 }}>No required defects reported.</p>
      )}
      <details className="sd-disclosure">
        <summary>Review evidence</summary>
        <ul className="sd-reader__text">
          {(report.evidence ?? []).map((entry, index) => (
            <li key={index}>{entry}</li>
          ))}
        </ul>
      </details>
      <details className="sd-disclosure">
        <summary>Recorded JSON</summary>
        <pre className="sd-code sd-code--block">{text}</pre>
      </details>
    </section>
  );
}

// A table from CSV text: quoted fields may hold commas, quotes and line breaks. The first row heads it; the first
// 500 rows show.
function csvRows(text: string) {
  const rows: string[][] = [];
  let row: string[] = [],
    field = '',
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) rows.push([...row, field]);
  return rows;
}
function CsvTable({ text }: { text: string }) {
  const [head, ...rows] = csvRows(text);
  if (!head) return <TextReader text={text} />;
  return (
    <div className="sd-reader__text">
      <div className="reader-table">
        <table>
          <thead>
            <tr>
              {head.map((cell, index) => (
                <th key={index} scope="col">
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 500).map((row, index) => (
              <tr key={index}>
                {row.map((cell, at) => (
                  <td key={at}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 500 && <p className="sd-meta">Showing the first 500 of {rows.length} rows.</p>}
    </div>
  );
}

// A recorded file read in place by its type: a picture framed, a review as its findings, other JSON formatted, a CSV
// as a table, and any other text through the reader.
export function FileBody({ projectId, attemptId, item }: { projectId: string; attemptId: string; item: FileRecord }) {
  const picture = imageFile(item.path) || item.path.endsWith('layout.json'),
    text = useFileText(projectId, attemptId, item, !picture);
  if (picture)
    return (
      <div className="sd-picture__frame sd-picture__frame--still">
        <Preview projectId={projectId} attemptId={attemptId} item={item} />
      </div>
    );
  if (text.error)
    return (
      <p className="sd-meta" style={{ margin: 0 }}>
        It cannot be shown here: {text.error.message} Download it to look at the recorded file.
      </p>
    );
  if (text.data === undefined)
    return (
      <p className="sd-meta" role="status" style={{ margin: 0 }}>
        Loading the recorded file…
      </p>
    );
  if (/\.json$/i.test(item.path)) {
    const report = parsedReport(text.data);
    if (report && (report.verdict !== undefined || Array.isArray(report.findings)))
      return <ReviewReport text={text.data} report={report} />;
    return <pre className="sd-code sd-code--block">{report ? JSON.stringify(report, null, 2) : text.data}</pre>;
  }
  if (/\.csv$/i.test(item.path)) return <CsvTable text={text.data} />;
  return <TextReader text={text.data} path={item.path} />;
}

// A recorded file over the page, under its name, with Download and Close.
export function FileDialog({
  projectId,
  attemptId,
  item,
  open,
  onClose,
}: {
  projectId: string;
  attemptId: string;
  item: FileRecord;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} label={item.path} size="wide" onClose={onClose}>
      <div className="sd-dialog__form">
        <h2 className="sd-dialog__title" style={{ overflowWrap: 'anywhere' }}>
          {item.path}
        </h2>
        <div className="sd-dialog__scroll">
          <FileBody projectId={projectId} attemptId={attemptId} item={item} />
        </div>
        <div className="sd-dialog__actions">
          <a
            className="sd-btn sd-btn--sm"
            href={artifactUrl(projectId, attemptId, item.path)}
            download
            aria-label={`Download ${item.path}`}
          >
            Download
          </a>
          <button type="button" className="sd-btn sd-btn--sm sd-btn--primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Dialog>
  );
}

// A recorded file's Download and, for anything but candidate source, View, which opens it over the page.
export function FileActions({
  projectId,
  attempt,
  item,
}: {
  projectId: string;
  attempt: AttemptSummary;
  item: FileRecord;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="sd-returned__actions">
      <a
        className="sd-btn sd-btn--sm"
        href={artifactUrl(projectId, attempt.id, item.path)}
        download
        aria-label={`Download ${item.path}`}
      >
        Download
      </a>
      {!candidateSourceFile(attempt, item) && (
        <>
          <button
            type="button"
            className="sd-btn sd-btn--sm sd-btn--ghost"
            onClick={() => setOpen(true)}
            aria-label={`View ${item.path}`}
          >
            View
          </button>
          <FileDialog
            projectId={projectId}
            attemptId={attempt.id}
            item={item}
            open={open}
            onClose={() => setOpen(false)}
          />
        </>
      )}
    </span>
  );
}

// The file an attempt's card or page shows as a picture: an image it returned, else its logical layout. Code
// stories return source, which is read in their diff.
export function pictureOf(attempt: AttemptSummary | undefined, kind: string) {
  if (
    !attempt ||
    ['studio-development:change', 'studio-development:change-review'].includes(kind) ||
    sourceEvidence(attempt)
  )
    return undefined;
  const files = (attempt.artifacts ?? []).filter(item => !candidateSourceFile(attempt, item));
  return files.find(item => imageFile(item.path)) ?? files.find(item => item.path === 'layout.json');
}

// A deliverable's picture, opening the file over the page (app-work.js visualPreview).
export function Deliverable({
  projectId,
  attempt,
  item,
  context = 'Deliverable',
}: {
  projectId: string;
  attempt: AttemptSummary;
  item: FileRecord;
  context?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <figure className="sd-picture" style={{ margin: 0 }}>
      <button
        type="button"
        className="sd-picture__frame"
        aria-label={`View ${item.path}`}
        onClick={() => setOpen(true)}
      >
        <Preview projectId={projectId} attemptId={attempt.id} item={item} />
        <span className="sd-picture__expand" aria-hidden="true">
          ↗
        </span>
      </button>
      <figcaption className="sd-picture__caption">
        <span>{context}</span>
        <span>{item.path}</span>
      </figcaption>
      <FileDialog projectId={projectId} attemptId={attempt.id} item={item} open={open} onClose={() => setOpen(false)} />
    </figure>
  );
}

export interface IdeaFile {
  id: string;
  name: string;
  mediaType: string;
  byteLength: number;
  sha256?: string;
  projectId: string;
  runId: string;
}
const imageTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(1)} KiB`
      : `${(bytes / 1048576).toFixed(1)} MiB`;

function IdeaPicture({ url, file }: { url: string; file: IdeaFile }) {
  const picture = usePicture(url, file.name, [file.projectId, 'idea-file', file.runId, file.id]);
  return (
    <div className="sd-picture__frame sd-picture__frame--still" style={{ flexBasis: '100%' }}>
      <PictureView picture={picture} name={file.name} />
    </div>
  );
}

// The original files the director gave with the idea, downloadable as they were, images shown.
export function IdeaFiles({ projectId, files }: { projectId: string; files: IdeaFile[] }) {
  if (!files.length) return null;
  return (
    <section
      aria-label="Original idea files"
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-10)', minWidth: 0 }}
    >
      <span className="sd-eyebrow">The files you gave with the idea</span>
      <span className="sd-meta">Every step after it can read them; a download is the original bytes.</span>
      <ul className="sd-returned">
        {files.map(file => {
          const url = `/api/projects/${encodeURIComponent(file.projectId)}/runs/${encodeURIComponent(file.runId)}/inputs/${encodeURIComponent(file.id)}?projectId=${encodeURIComponent(projectId)}`;
          return (
            <li key={file.id}>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', minWidth: 0 }}>
                <span className="sd-returned__name">{file.name}</span>
                <span className="sd-meta">
                  {file.mediaType} · {size(file.byteLength)}
                </span>
              </span>
              <a className="sd-btn sd-btn--sm" href={url} download aria-label={`Download ${file.name}`}>
                Download
              </a>
              {imageTypes.includes(file.mediaType) && <IdeaPicture url={url} file={file} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// The files an idea or a step produced, for the Viewer: what it made (documents, tables, drawings, and a code idea's
// changes), its reviews, and the records of how it was done (a plan, test output, check reports). The result record and candidate source are
// left out: a story's change is read in its diff.
export type FileGroup = 'made' | 'review' | 'record';
const reviewKinds = ['review', 'work-review', 'source-review', 'source-change-review'];
export function fileGroup(attempt: AttemptSummary, item: FileRecord): FileGroup | null {
  if (item.path === 'result.json' || candidateSourceFile(attempt, item) || item.kind === 'source-change-diff')
    return null;
  if (reviewKinds.includes(item.kind ?? '')) return 'review';
  if (['test-log', 'result', 'plan', 'graph-proposal'].includes(item.kind ?? '') || item.kind?.startsWith('source-'))
    return 'record';
  return 'made';
}
// What a file is, in words, beside its name.
const kindWords: Record<string, string> = {
  'work-file': 'Written',
  artwork: 'Drawing',
  metadata: 'Metadata',
  layout: 'Layout',
  plan: 'Plan',
  'graph-proposal': 'Plan',
  review: 'Review',
  'work-review': 'Review',
  'source-review': 'Review',
  'source-change-review': 'Review',
  'test-log': 'Test output',
  'source-check-report': 'Check report',
  'source-context': 'What the checks read',
  'source-breakdown': 'Proposed stories',
  'source-scope': 'Approved files',
  'source-scope-request': 'File request',
  'source-change': 'Change record',
  'source-change-context': 'What the review read',
};
export const fileKind = (item: FileRecord) => kindWords[item.kind ?? ''] ?? (imageFile(item.path) ? 'Picture' : 'File');

// One attempt's files as the Viewer lists them.
export const attemptEntries = (attempt: AttemptSummary): ViewerEntry[] =>
  (attempt.artifacts ?? []).flatMap(item => {
    const group = fileGroup(attempt, item);
    return group
      ? [{ key: `${attempt.id}/${item.path}`, group, name: item.path, meta: fileKind(item), file: { attempt, item } }]
      : [];
  });

export interface ViewerEntry {
  key: string;
  group: FileGroup;
  name: string;
  meta: string;
  // A file opens in the pane; a code idea's change opens its story.
  file?: { attempt: AttemptSummary; item: FileRecord };
  step?: { taskId: string; title: string };
}
const typeOf = (entry: ViewerEntry) =>
  entry.file ? (/\.([a-z0-9]{1,4})$/i.exec(entry.file.item.path)?.[1] ?? 'file') : 'diff';
const groups: [FileGroup, string][] = [
  ['made', 'What it made'],
  ['review', 'Reviews'],
  ['record', 'Records'],
];

// The Viewer: the files in a list beside the one open, which is read in place with Download. On a phone the list
// stands alone and a file opens over the page. Nothing is read until a file is open.
export function FileViewer({ projectId, entries }: { projectId: string; entries: ViewerEntry[] }) {
  const narrow = useNarrow(),
    counts = Object.fromEntries(groups.map(([group]) => [group, entries.filter(e => e.group === group).length])),
    // The filter chosen; until there is one, the first with files, as the files arrive.
    [picked, setGroup] = useState<FileGroup | null>(null),
    group = picked && counts[picked] ? picked : (groups.find(([key]) => counts[key])?.[0] ?? 'made'),
    [openKey, setOpenKey] = useState<string | null>(null),
    [sheet, setSheet] = useState<ViewerEntry | null>(null),
    listed = entries.filter(entry => entry.group === group),
    open = narrow ? undefined : (listed.find(entry => entry.key === openKey) ?? listed.find(entry => entry.file));
  return (
    <div className="sd-viewer">
      <div className="sd-viewer__side">
        <div className="sd-filters sd-viewer__filters" role="group" aria-label="Show">
          {groups
            .filter(([key]) => counts[key])
            .map(([key, label]) => (
              <button
                type="button"
                key={key}
                aria-pressed={group === key}
                onClick={() => {
                  setGroup(key);
                  setOpenKey(null);
                }}
              >
                {label} · {counts[key]}
              </button>
            ))}
        </div>
        <ul className="sd-viewer__list" aria-label="Files">
          {listed.map(entry => {
            const inner = (
              <>
                <span className="sd-viewer__type">{typeOf(entry)}</span>
                <span className="sd-viewer__name">{entry.name}</span>
                <span className="sd-viewer__meta">{entry.meta}</span>
              </>
            );
            return (
              <li key={entry.key}>
                {entry.file ? (
                  <button
                    type="button"
                    className="sd-viewer__item"
                    aria-current={entry === open ? 'true' : undefined}
                    onClick={() => (narrow ? setSheet(entry) : setOpenKey(entry.key))}
                  >
                    {inner}
                  </button>
                ) : (
                  <Link
                    className="sd-viewer__item"
                    to="/p/$projectId/tasks/$taskId"
                    params={{ projectId, taskId: entry.step!.taskId }}
                  >
                    {inner}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      {!narrow && (
        <section className="sd-viewer__pane" aria-label={open?.name ?? 'No file open'}>
          {open?.file ? (
            <>
              <div className="sd-viewer__head">
                <span className="sd-viewer__title">
                  <h3>{open.name}</h3>
                  <span className="sd-meta">
                    {open.meta}
                    {open.step && (
                      <>
                        {' · '}
                        <Link to="/p/$projectId/tasks/$taskId" params={{ projectId, taskId: open.step.taskId }}>
                          Open its step
                        </Link>
                      </>
                    )}
                  </span>
                </span>
                <span className="sd-viewer__actions">
                  <a
                    className="sd-btn sd-btn--sm"
                    href={artifactUrl(projectId, open.file.attempt.id, open.file.item.path)}
                    download
                    aria-label={`Download ${open.name}`}
                  >
                    Download
                  </a>
                </span>
              </div>
              <div className="sd-viewer__body">
                <FileBody key={open.key} projectId={projectId} attemptId={open.file.attempt.id} item={open.file.item} />
              </div>
            </>
          ) : (
            <div className="sd-viewer__empty">Choose a file to read it here.</div>
          )}
        </section>
      )}
      {sheet?.file && (
        <FileDialog
          projectId={projectId}
          attemptId={sheet.file.attempt.id}
          item={sheet.file.item}
          open
          onClose={() => setSheet(null)}
        />
      )}
    </div>
  );
}

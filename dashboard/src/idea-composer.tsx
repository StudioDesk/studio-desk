// An idea's files and drafts (the idea intake's rules): up to ten reference files, checked here as the controller
// checks them, and each project's draft kept in memory, so leaving Today and coming back keeps it; nothing is
// stored in the browser. Today's box (today-idea.tsx) uses these.

export interface IdeaFile {
  id: number;
  file: File;
  mediaType: string;
  url?: string;
}
export interface Draft {
  idea: string;
  files: IdeaFile[];
  error: string;
}

const types: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  json: 'application/json',
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
};
export const drafts = new Map<string, Draft>();
let sequence = 0;

// The intake the controller starts for an idea: source checks and a breakdown, or the planner. The box only says
// which; the controller chooses.
export type IdeaIntake = 'source' | 'plan';
export const wording: Record<IdeaIntake, { submit: string; help: string; queued: string }> = {
  source: {
    submit: 'Break it into stories',
    help: 'Describe the outcome you want. Add reference files to give the team context. Fresh source checks run first, then the product owner breaks your idea into stories for your approval.',
    queued:
      "Idea queued: fresh checks, then the product owner's breakdown. Proposed stories will appear in Planned for your approval.",
  },
  plan: {
    submit: 'Plan the work',
    help: 'Describe the outcome you want. Add reference files to give the team context. The planner then plans the work as tasks for your approval.',
    queued: 'Idea queued: the planner plans the work. Proposed tasks will appear in Planned for your approval.',
  },
};

export const fileSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KiB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

// eslint-disable-next-line no-control-regex
const unsafe = /[\u0000-\u001f\u007f-\u009f<>:"/\\|?*‪-‮⁦-⁩]/u;

// The files a draft gains, or why none can be added; the same checks as the controller's intake.
export function added(draft: Draft, incoming: File[], pasted: boolean): IdeaFile[] {
  if (draft.files.length + incoming.length > 10)
    throw new Error('Choose up to 10 files. Remove a file before adding more.');
  const names = new Set(draft.files.map(item => item.file.name.normalize('NFKC').toLowerCase())),
    additions: IdeaFile[] = [];
  let total = draft.files.reduce((sum, item) => sum + item.file.size, 0);
  for (let file of incoming) {
    if (pasted) {
      const extension = Object.keys(types).find(key => types[key] === file.type);
      if (extension) {
        let count = 1,
          name = `pasted-${count}.${extension}`;
        while (names.has(name)) name = `pasted-${++count}.${extension}`;
        file = new File([file], name, { type: file.type, lastModified: file.lastModified });
      }
    }
    const name = file.name,
      extension = name.match(/^.+\.([^.]+)$/)?.[1]?.toLowerCase(),
      mediaType = extension ? types[extension] : undefined;
    if (
      !name ||
      !name.isWellFormed() ||
      name.length > 180 ||
      new TextEncoder().encode(name).length > 255 ||
      unsafe.test(name) ||
      name.trim() !== name ||
      /[. ]$/.test(name) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
    )
      throw new Error(`Rename “${name}” to a safe filename without paths or special characters.`);
    if (!mediaType) throw new Error(`“${name}” is unsupported. Use PNG, JPEG, WebP, GIF, JSON, Markdown, TXT or CSV.`);
    const key = name.normalize('NFKC').toLowerCase();
    if (names.has(key)) throw new Error(`“${name}” is already selected. Rename duplicate files before adding them.`);
    names.add(key);
    if (file.size > 5 * 1024 * 1024) throw new Error(`“${name}” exceeds 5 MiB. Choose a smaller file.`);
    total += file.size;
    if (total > 20 * 1024 * 1024) throw new Error('Files exceed 20 MiB combined. Remove files or choose smaller ones.');
    additions.push({ id: ++sequence, file, mediaType });
  }
  return additions;
}

export async function encoded(item: IdeaFile) {
  const bytes = new Uint8Array(await item.file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return { name: item.file.name, mediaType: item.mediaType, data: btoa(binary) };
}

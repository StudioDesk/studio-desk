// How a story's carries read (1.1), on its page and on the Releases page: a fix carried forward to a newer line, or
// brought back to an older one at the director's word (`back`), and a carry waiting for another story's turn on its
// line (`after`, the stories it waits for) naming that story, with its title when the page knows it.
export interface CarryRecord {
  line: string;
  state: string;
  back?: boolean;
  after?: string[];
}

export function carryWords(carry: CarryRecord, titleOf?: (storyId: string) => string | undefined): string {
  if (carry.state === 'carried') return `${carry.back ? 'brought back' : 'carried'} to ${carry.line}`;
  if (carry.state === 'skipped') return `not needed on ${carry.line}`;
  if (carry.state === 'waiting' && carry.after?.length) {
    const names = carry.after.map(id => {
      const title = titleOf?.(id);
      return title ? `${id} (“${title}”)` : id;
    });
    return `waits for ${names.join(' and ')}'s turn on ${carry.line}`;
  }
  return `${carry.back ? 'bringing back' : 'carry'} to ${carry.line}: ${carry.state}`;
}

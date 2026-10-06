import type { Memory } from './model';
import { createHash } from 'node:crypto';

function safeBoundary(body: string, position: number) {
  return position > 0 && position < body.length && /[\uD800-\uDBFF]/.test(body[position - 1]) && /[\uDC00-\uDFFF]/.test(body[position]) ? position - 1 : position;
}

export function bodyPages(memories: Memory[], budget: number, offset: number) {
  const starts = memories.map(memory => safeBoundary(memory.body, Math.min(offset, memory.body.length)));
  const lengths = memories.map((memory, i) => memory.body.length - starts[i]);
  const allocated = memories.map(() => 0);
  let remaining = budget;
  while (remaining > 0) {
    const unfinished = lengths.map((length, i) => length > allocated[i] ? i : -1).filter(i => i >= 0);
    if (!unfinished.length) break;
    const share = Math.max(1, Math.floor(remaining / unfinished.length));
    for (const i of unfinished) {
      const take = Math.min(share, lengths[i] - allocated[i], remaining);
      allocated[i] += take; remaining -= take;
    }
  }
  return memories.map((memory, i) => {
    const start = starts[i], end = safeBoundary(memory.body, start + allocated[i]);
    const truncated = end < memory.body.length;
    return { ...memory, body: memory.body.slice(start, end), bodyHash: createHash('sha256').update(memory.body).digest('hex'), offset: start, totalLength: memory.body.length, nextOffset: truncated ? end : null, truncated };
  });
}

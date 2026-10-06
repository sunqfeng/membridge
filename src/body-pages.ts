import type { Memory } from './model';

export function bodyPages(memories: Memory[], budget: number, offset: number) {
  const lengths = memories.map(memory => Math.max(0, memory.body.length - offset));
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
    const start = Math.min(offset, memory.body.length), end = start + allocated[i];
    const truncated = end < memory.body.length;
    return { ...memory, body: memory.body.slice(start, end), offset: start, totalLength: memory.body.length, nextOffset: truncated ? end : null, truncated };
  });
}

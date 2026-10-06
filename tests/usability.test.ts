import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LocalClient } from '../src/client';
import { createMcp } from '../src/mcp';
import { MemoryStore } from '../src/store';
import { sqliteDatabase } from '../src/database';
import { createHandler } from '../src/http';
import { createMemory } from '../src/model';

const draft = (body: string) => ({ project: 'demo', title: 'record', body, kind: 'decision' as const, sources: ['test:source'] });
test('MCP redistributes unused body budget and resumes a selected memory with offset', async () => {
  const local = new LocalClient(':memory:', { agent: 'a' });
  const short = (await local.remember(draft('short'))).memory!;
  const long = (await local.remember(draft('长'.repeat(1900) + '尾'.repeat(100)))).memory!;
  const server = createMcp(local), client = new Client({ name: 'test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair(); await server.connect(right); await client.connect(left);
  const read = async (ids: string[], offset = 0) => {
    const response = await client.callTool({ name: 'get_memories', arguments: { project: 'demo', ids, charBudget: 1000, offset, ...(offset > 0 ? { version: long.version, bodyHash: createHash('sha256').update(long.body).digest('hex') } : {}) } });
    return JSON.parse((response.content as { text: string }[])[0].text);
  };
  try {
    const page = await read([short.id, long.id]);
    expect(page.results.map((m: { body: string }) => m.body.length)).toEqual([5, 995]);
    expect(page.results[0].nextOffset).toBeNull(); expect(page.results[1].nextOffset).toBe(995);
    expect(page.results[1].totalLength).toBe(2000);
    const second = (await read([long.id], 995)).results[0];
    const third = (await read([long.id], second.nextOffset)).results[0];
    expect(page.results[1].body + second.body + third.body).toBe(long.body);
    expect(third.truncated).toBe(false); expect(third.nextOffset).toBeNull();
    expect((await read([long.id], 3000)).results[0].body).toBe('');
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    expect(tools).toContain('recent'); expect(tools).toContain('rebase_pending');
  } finally { await client.close(); await server.close(); local.close(); }
});

test('recent needs no keyword, filters kind/expiry/deletion, scopes access and distinguishes offline cache', async () => {
  const db = sqliteDatabase(':memory:'), store = new MemoryStore(db);
  const actor = { namespace: 'owner', agent: 'a', projects: ['demo'] }, token = 'a'.repeat(40);
  const target = createMemory(draft('decision'));
  await store.put(actor, { operationId: crypto.randomUUID(), memory: target, expectedVersion: 0 });
  await db.run('UPDATE mb_memories SET updated_at=1 WHERE id=?', [target.id]);
  for (let i = 0; i < 105; i++) await store.put(actor, { operationId: crypto.randomUUID(), memory: { ...createMemory(draft('expired')), expiresAt: '2020-01-01T00:00:00Z' }, expectedVersion: 0 });
  const other = createMemory({ ...draft('discovery'), kind: 'discovery' });
  await store.put(actor, { operationId: crypto.randomUUID(), memory: other, expectedVersion: 0 });
  const deleted = createMemory(draft('deleted')); await store.put(actor, { operationId: crypto.randomUUID(), memory: deleted, expectedVersion: 0 });
  await store.forget(actor, { operationId: crypto.randomUUID(), project: 'demo', id: deleted.id, expectedVersion: 1 });
  let online = true, calls = 0;
  const handle = createHandler(store, [{ ...actor, token }]);
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    calls++; if (!online) throw new Error('offline'); return handle(new Request(input, init));
  }) as typeof fetch;
  const client = new LocalClient(':memory:', { agent: 'a', url: 'http://localhost', token, fetch: transport, now: () => Date.now() + 1000 });
  try {
    const found = await client.recent({ project: 'demo', kind: 'decision', limit: 2 });
    expect(found.results.map(entry => entry.id)).toEqual([target.id]); expect(found.source).toBe('cloud');
    const count = calls; expect((await client.recent({ project: 'demo', kind: 'decision', limit: 2 })).source).toBe('local'); expect(calls).toBe(count);
    expect((await client.recent({ project: 'demo', limit: 2 })).results.map(entry => entry.id)).toEqual([other.id, target.id]);
    await expect(client.recent({ project: 'forbidden', limit: 2 })).rejects.toThrow('FORBIDDEN');
    await client.get('demo', [target.id]); // Details cache remains version 1.
    await store.put(actor, { operationId: crypto.randomUUID(), memory: { ...target, body: 'revision 2' }, expectedVersion: 1 });
    await client.recent({ project: 'demo', kind: 'decision', limit: 2 }, true); // Index snapshot has version 2.
    online = false;
    const stale = await client.recent({ project: 'demo', kind: 'decision', limit: 2 }, true);
    expect(stale.cloudStatus).toBe('unavailable'); expect(stale.results[0].version).toBe(2);
    const pending = await client.remember(draft('local pending'));
    const offline = await client.recent({ project: 'demo', kind: 'decision', limit: 2 }, true);
    expect(offline.freshness).toBe('stale'); expect(offline.results[0].id).toBe(pending.memory!.id);
  } finally { client.close(); await store.close(); }
});

test('rebase previews without mutation, requires current confirmation and retains local text', async () => {
  const db = sqliteDatabase(':memory:'), store = new MemoryStore(db);
  const actor = { namespace: 'owner', agent: 'b', projects: ['demo'] }, token = 'a'.repeat(40);
  const handle = createHandler(store, [{ ...actor, agent: 'a', token }]); let online = true, now = Date.now();
  let interleave: { id: string; expectedVersion: number } | undefined;
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!online) throw new Error('offline');
    const response = await handle(new Request(input, init));
    if (String(input).endsWith('/get') && interleave) {
      const next = interleave; interleave = undefined;
      await store.put(actor, { operationId: crypto.randomUUID(), memory: createMemory({ ...draft('concurrent update'), id: next.id }), expectedVersion: next.expectedVersion });
    }
    return response;
  }) as typeof fetch;
  const client = new LocalClient(':memory:', { agent: 'a', url: 'http://localhost', token, fetch: transport, now: () => now });
  try {
    const saved = (await client.remember(draft('original'))).memory!;
    online = false; await client.remember({ ...draft('local revised'), id: saved.id }, 1);
    online = true;
    await store.put(actor, { operationId: crypto.randomUUID(), memory: { ...createMemory(draft('remote revised')), id: saved.id }, expectedVersion: 1 });
    await client.sync(); expect(client.status().conflicts).toBe(1);
    await expect(client.rebasePending('demo', saved.id, 2)).rejects.toThrow('PREVIEW_CONFIRMATION_REQUIRED');
    let preview = await client.rebasePending('demo', saved.id);
    expect(preview.localMemory.body).toBe('local revised'); expect(preview.cloudMemory.body).toBe('remote revised');
    expect(preview.expectedVersion).toBe(2); expect(client.status().conflicts).toBe(1);
    await expect(client.rebasePending('demo', saved.id, 2, 'f'.repeat(64))).rejects.toThrow('INVALID_OR_EXPIRED_CONFIRM_TOKEN');
    const payload = JSON.parse(String((await db.rows('SELECT payload FROM mb_memories WHERE id=?', [saved.id]))[0].payload));
    payload.body = 'changed without version increment';
    await db.run('UPDATE mb_memories SET payload=? WHERE id=?', [JSON.stringify(payload), saved.id]);
    await expect(client.rebasePending('demo', saved.id, 2, preview.confirmToken)).rejects.toThrow('CLOUD_VERSION_CHANGED');
    now += 600001;
    await expect(client.rebasePending('demo', saved.id, 2, preview.confirmToken)).rejects.toThrow('INVALID_OR_EXPIRED_CONFIRM_TOKEN');
    preview = await client.rebasePending('demo', saved.id);
    await store.put(actor, { operationId: crypto.randomUUID(), memory: { ...createMemory(draft('remote changed again')), id: saved.id }, expectedVersion: 2 });
    await expect(client.rebasePending('demo', saved.id, 2, preview.confirmToken)).rejects.toThrow('CLOUD_VERSION_CHANGED');
    const nextPreview = await client.rebasePending('demo', saved.id);
    const confirmed = await client.rebasePending('demo', saved.id, 3, nextPreview.confirmToken);
    expect(confirmed.syncStatus).toBe('synced'); expect(confirmed.localMemory.body).toBe('local revised');
    expect((await store.get(actor, 'demo', [saved.id]))[0].body).toBe('local revised');
    await expect(client.rebasePending('demo', saved.id)).rejects.toThrow('CONFLICTED_PUT_REQUIRED');
    await store.put(actor, { operationId: crypto.randomUUID(), memory: createMemory({ ...draft('remote version 5'), id: saved.id }), expectedVersion: 4 });
    expect((await client.remember({ ...draft('local retry'), id: saved.id }, 4)).syncStatus).toBe('conflict');
    const finalPreview = await client.rebasePending('demo', saved.id);
    interleave = { id: saved.id, expectedVersion: 5 };
    expect((await client.rebasePending('demo', saved.id, 5, finalPreview.confirmToken)).syncStatus).toBe('conflict');
    expect((await store.get(actor, 'demo', [saved.id]))[0].body).toBe('concurrent update');
    await store.forget(actor, { operationId: crypto.randomUUID(), project: 'demo', id: saved.id, expectedVersion: 6 });
    await expect(client.rebasePending('demo', saved.id)).rejects.toThrow('CLOUD_MEMORY_NOT_FOUND_OR_EXPIRED');
    expect(client.status().conflicts).toBe(1);
  } finally { client.close(); await store.close(); }
});

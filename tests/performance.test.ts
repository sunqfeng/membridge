import { test, expect, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sqliteDatabase, type SqlDatabase } from '../src/database';
import { MemoryStore } from '../src/store';
import { LocalClient } from '../src/client';
import { createHandler } from '../src/http';
import { createMemory } from '../src/model';

const actor = { namespace: 'owner', agent: 'a', projects: ['demo'] }, token = 't'.repeat(40);
const draft = (body: string) => createMemory({ project: 'demo', title: 'record', body, kind: 'decision', sources: ['test:performance'] });
const offline = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;

test('handler snapshots token hashes at startup and still rejects invalid Bearer credentials', async () => {
  const store = new MemoryStore(sqliteDatabase(':memory:')), config = [{ ...actor, token }], handle = createHandler(store, config);
  const identity = (bearer: string) => handle(new Request('http://localhost/v1/identity', { method: 'POST', headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json' }, body: '{}' }));
  try {
    expect((await identity(token)).status).toBe(200);
    config[0].token = 'u'.repeat(40);
    expect((await identity(token)).status).toBe(200); expect((await identity(config[0].token)).status).toBe(401);
  } finally { await store.close(); }
});

test.each(['search', 'recent'] as const)('%s empty snapshots obey TTL, explicit refresh and local mutation invalidation', async path => {
  const store = new MemoryStore(sqliteDatabase(':memory:')), handle = createHandler(store, [{ ...actor, token }]);
  let now = Date.now(), calls = 0;
  const transport = (async (input: string | URL | Request, init?: RequestInit) => { if (String(input).endsWith('/' + path)) calls++; return handle(new Request(input, init)); }) as typeof fetch;
  const client = new LocalClient(':memory:', { url: 'http://localhost', token, agent: 'a', fetch: transport, now: () => now, ttlMs: 1000 });
  const read = (refresh = false) => path === 'search' ? client.search({ project: 'demo', query: 'record', limit: 10 }, refresh) : client.recent({ project: 'demo', limit: 10 }, refresh);
  try {
    expect((await read()).results).toEqual([]); expect(calls).toBe(1);
    await store.put(actor, { operationId: crypto.randomUUID(), memory: draft('remote added'), expectedVersion: 0 });
    expect((await read()).results).toEqual([]); expect(calls).toBe(1);
    now += 1001; expect((await read()).results).toHaveLength(1); expect(calls).toBe(2);
    await read(true); expect(calls).toBe(3);
    await client.remember(draft('local change')); await read(); expect(calls).toBe(4);
  } finally { client.close(); await store.close(); }
});

test('batch get prunes once and preserves query snapshots; LEFT JOIN retains cacheless pending deletes', async () => {
  const store = new MemoryStore(sqliteDatabase(':memory:')), handle = createHandler(store, [{ ...actor, token }]);
  const ids: string[] = [];
  for (let i = 0; i < 20; i++) ids.push((await store.put(actor, { operationId: crypto.randomUUID(), memory: draft('body ' + i), expectedVersion: 0 })).id);
  let online = true, searches = 0;
  const transport = (async (input: string | URL | Request, init?: RequestInit) => { if (!online) throw new Error('offline'); if (String(input).endsWith('/search')) searches++; return handle(new Request(input, init)); }) as typeof fetch;
  const client = new LocalClient(':memory:', { url: 'http://localhost', token, agent: 'a', fetch: transport });
  const prune = spyOn(client as unknown as { prune(): void }, 'prune');
  try {
    await client.search({ project: 'demo', query: 'record', limit: 20 }); prune.mockClear();
    expect((await client.get('demo', ids)).results).toHaveLength(20); expect(prune).toHaveBeenCalledTimes(1);
    await client.search({ project: 'demo', query: 'record', limit: 20 }); expect(searches).toBe(1);
    online = false; expect((await client.forget('demo', ids[0], 1)).syncStatus).toBe('pending');
    const result = await client.recent({ project: 'demo', limit: 30 });
    expect(result.pendingIds).toContain(ids[0]); expect(result.results.some(item => item.id === ids[0])).toBe(false);
    expect((await client.get('demo', [ids[0]])).results).toEqual([]);
  } finally { prune.mockRestore(); client.close(); await store.close(); }
});

test('expiry is applied before LIMIT and index queries transfer no bodies or sources; receipt update is indexed', async () => {
  const actual = sqliteDatabase(':memory:');
  const returned: { sql: string; payloads: Record<string, unknown>[] }[] = [];
  const db: SqlDatabase = { ...actual, rows: async (sql, args) => { const rows = await actual.rows(sql, args); if (/FROM mb_memories/.test(sql)) returned.push({ sql, payloads: rows.filter(row => row.payload).map(row => JSON.parse(String(row.payload))) }); return rows; } };
  const store = new MemoryStore(db), clock = spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-06T12:00:00.123Z'));
  try {
    const cases = ['2026-10-06T12:00:00.123Z', '2026-10-06T20:00:00.123+08:00', '2026-10-06T07:00:00.123-05:00', '2026-10-06T12:00:00.1239Z', '2026-10-06T12:00:00.124Z', '2026-10-06T20:00:00.124+08:00', '2026-10-06T07:00:00.124-05:00', '2026-10-06T12:01:00Z', '2026-10-06T12:00:00.2Z'];
    const visible: string[] = [], all: string[] = [];
    for (const expiresAt of cases) {
      const memory = { ...draft('x'.repeat(16000)), expiresAt };
      all.push(memory.id); if (Date.parse(expiresAt) > Date.now()) visible.push(memory.id);
      await store.put(actor, { operationId: crypto.randomUUID(), memory, expectedVersion: 0 });
    }
    const anchor = draft('anchor'); all.push(anchor.id); visible.push(anchor.id);
    await store.put(actor, { operationId: crypto.randomUUID(), memory: anchor, expectedVersion: 0 });
    for (let i = 0; i < 110; i++) await store.put(actor, { operationId: crypto.randomUUID(), memory: { ...draft('expired'), expiresAt: '2020-01-01T00:00:00Z' }, expectedVersion: 0 });
    returned.length = 0;
    expect((await store.get(actor, 'demo', all)).map(item => item.id).sort()).toEqual(visible.slice().sort());
    returned.length = 0;
    expect((await store.recent(actor, { project: 'demo', limit: 30 })).map(item => item.id).sort()).toEqual(visible.slice().sort());
    expect(returned).toHaveLength(1);
    expect(returned.flatMap(query => query.payloads).every(item => !('body' in item) && !('sources' in item))).toBe(true);
    returned.length = 0;
    expect((await store.timeline(actor, 'demo', anchor.id, 10)).map(item => item.id).sort()).toEqual(visible.slice().sort());
    expect(returned.flatMap(query => query.payloads).every(item => !('body' in item) && !('sources' in item))).toBe(true);
    const plan = await actual.rows('EXPLAIN QUERY PLAN UPDATE mb_operations SET result=? WHERE namespace=? AND project=? AND memory_id=?', ['{}', 'owner', 'demo', anchor.id]);
    expect(JSON.stringify(plan)).toContain('mb_operations_memory');
  } finally { clock.mockRestore(); await store.close(); }
});

test('sync overlaps four independent requests and isolates version conflicts', async () => {
  const store = new MemoryStore(sqliteDatabase(':memory:')), handle = createHandler(store, [{ ...actor, token }]);
  let online = false, running = 0, peak = 0;
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!online) throw new Error('offline');
    if (String(input).endsWith('/put')) { running++; peak = Math.max(peak, running); await new Promise(resolve => setTimeout(resolve, 20)); try { return await handle(new Request(input, init)); } finally { running--; } }
    return handle(new Request(input, init));
  }) as typeof fetch;
  const client = new LocalClient(':memory:', { url: 'http://localhost', token, agent: 'a', fetch: transport });
  const memories = Array.from({ length: 12 }, (_, i) => draft('queued ' + i));
  try {
    for (const memory of memories) await client.remember(memory);
    await store.put(actor, { operationId: crypto.randomUUID(), memory: memories[0], expectedVersion: 0 });
    online = true; const state = await client.sync();
    expect(peak).toBe(4); expect(state.pending).toBe(0); expect(state.conflicts).toBe(1);
    expect((await store.recent(actor, { project: 'demo', limit: 30 }))).toHaveLength(12);
  } finally { client.close(); await store.close(); }
});

test('transient batch failure stops dispatch and coalesced automatic sync respects backoff', async () => {
  let online = false, puts = 0;
  const transport = (async (input: unknown) => {
    if (!online) throw new Error('offline');
    if (String(input).endsWith('/identity')) return Response.json({ namespace: 'owner', agent: 'a', access: 'rw' });
    puts++; await new Promise(resolve => setTimeout(resolve, 20)); return Response.json({}, { status: 503 });
  }) as unknown as typeof fetch;
  const client = new LocalClient(':memory:', { url: 'http://localhost', token, agent: 'a', fetch: transport });
  try {
    for (let i = 0; i < 12; i++) await client.remember(draft('pending ' + i));
    online = true; const first = client.sync();
    await new Promise(resolve => setTimeout(resolve, 1));
    const second = client.sync({ retryIdentity: false });
    expect((await first).pending).toBe(12); await second; expect(puts).toBe(4);
    await client.sync({ retryIdentity: false }); expect(puts).toBe(4);
  } finally { client.close(); }
});

test('a discarded in-flight operation cannot overwrite a newer local change', async () => {
  const store = new MemoryStore(sqliteDatabase(':memory:')), handle = createHandler(store, [{ ...actor, token }]);
  let online = false, release!: () => void, entered!: () => void, held = false;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!online) throw new Error('offline');
    if (String(input).endsWith('/put') && !held) { held = true; entered(); await gate; }
    return handle(new Request(input, init));
  }) as typeof fetch;
  const client = new LocalClient(':memory:', { url: 'http://localhost', token, agent: 'a', fetch: transport });
  const memory = draft('original');
  try {
    await client.remember(memory); online = true;
    const syncing = client.sync(); await started;
    client.discardPending('demo', memory.id);
    const replacement = client.remember({ ...memory, body: 'replacement' });
    await new Promise(resolve => setTimeout(resolve, 0)); release();
    const result = await replacement; await syncing;
    expect(result.memory!.body).toBe('replacement'); expect(result.syncStatus).toBe('conflict');
    expect((await client.get('demo', [memory.id])).results[0].body).toBe('replacement');
  } finally { release(); client.close(); await store.close(); }
});

test('remember bounds foreground sync wait and shutdown preserves the unfinished queue', async () => {
  const root = mkdtempSync(join(tmpdir(), 'membridge-sync-budget-')), path = join(root, 'cache.db');
  let online = false, puts = 0;
  const transport = (async (input: unknown, init?: RequestInit) => {
    if (!online) throw new Error('offline');
    if (String(input).endsWith('/identity')) return Response.json({ namespace: 'owner', agent: 'a', access: 'rw' });
    puts++;
    return new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  }) as typeof fetch;
  let client = new LocalClient(path, { url: 'http://localhost', token, agent: 'a', fetch: transport });
  try {
    for (let i = 0; i < 8; i++) await client.remember(draft('old ' + i));
    online = true; const runningSync = client.sync(); const started = performance.now();
    expect((await client.remember(draft('new'))).syncStatus).toBe('pending');
    expect(performance.now() - started).toBeLessThan(4000); expect(puts).toBe(4);
    client.close(); await runningSync;
    client = new LocalClient(path, { url: 'http://localhost', token, agent: 'a', fetch: offline }); expect(client.status().pending).toBe(9);
  } finally { client.close(); rmSync(root, { recursive: true, force: true }); }
}, 8000);

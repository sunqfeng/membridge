import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStore } from '../src/store';
import { sqliteDatabase } from '../src/database';
import { LocalClient } from '../src/client';
import { createHandler } from '../src/http';
import { createMemory, redact } from '../src/model';
import { cacheIdentity, legacyIdentity, selectCachePath } from '../src/cache';
import { createHash } from 'node:crypto';

const actor = { namespace: 'owner', agent: 'a', projects: ['demo'] };
const draft = (body: string) => createMemory({ project: 'demo', title: 'record', body, kind: 'discovery', sources: ['test:synthetic'] });
test('search sees old real matches behind metadata hits and preserves quotes/newlines', async () => {
  const db = sqliteDatabase(':memory:'); const store = new MemoryStore(db);
  const target = draft('kind and "quoted" line\nnext');
  await store.put(actor, { operationId: crypto.randomUUID(), memory: target, expectedVersion: 0 });
  for (let i = 0; i < 310; i++) await store.put(actor, { operationId: crypto.randomUUID(), memory: draft('unrelated ' + i), expectedVersion: 0 });
  await db.run('UPDATE mb_memories SET updated_at=1 WHERE id=?', [target.id]);
  for (const query of ['kind', '"quoted"', 'line\nnext']) expect((await store.search(actor, { project: 'demo', query, limit: 10 }))[0]?.id).toBe(target.id);
  expect(await store.search(actor, { project: 'demo', query: 'discovery', limit: 10 })).toEqual([]);
  for (let i = 0; i < 110; i++) await store.put(actor, { operationId: crypto.randomUUID(), memory: { ...draft('kind expired'), expiresAt: '2020-01-01T00:00:00Z' }, expectedVersion: 0 });
  expect((await store.search(actor, { project: 'demo', query: 'kind', limit: 10 })).map(entry => entry.id)).toEqual([target.id]);
  await store.close();
});

test('authorization bearer, URLs, Tencent IDs and common secret assignments never remain in memory', () => {
  const secret = 'sensitive-example-value';
  for (const input of [
    `Authorization: Bearer ${secret}`, `"Authorization": "Bearer ${secret}"`,
    `mysql://user:${secret}@host/db`, `MYSQL_URL=mysql://user:${secret}@host/db`,
    ...['secret_key', 'private_key', 'token'].map(key => `${key}=${secret}`),
    'AKID' + 'A'.repeat(32),
  ]) {
    const result = redact(input);
    expect(result).not.toContain(secret); expect(result).not.toContain('AKID' + 'A'.repeat(32));
    expect(redact(result)).toBe(result);
  }
});

test('parallel remember flushes both records and explicit retry recovers blocked writes without discard', async () => {
  const store = new MemoryStore(sqliteDatabase(':memory:')); const token = 't'.repeat(40);
  const config = [{ ...actor, token, projects: [] as string[] }];
  const handle = createHandler(store, config);
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    await new Promise(resolve => setTimeout(resolve, 5)); return handle(new Request(input, init));
  }) as typeof fetch;
  const client = new LocalClient(':memory:', { url: 'http://localhost', token, agent: 'a', fetch: transport });
  const blocked = await client.remember(draft('blocked'));
  expect(blocked.syncStatus).toBe('blocked');
  config[0].projects.push('demo');
  // Explicit manual sync must retry permission/configuration failures; no local text discarded.
  expect((await client.sync({ retryFailed: true })).blocked).toBe(0);
  const results = await Promise.all([client.remember(draft('first')), client.remember(draft('second'))]);
  expect(results.map(result => result.syncStatus)).toEqual(['synced', 'synced']);
  client.close(); await store.close();
});

test('offset expiry and timeline skip expired neighbors before limiting', async () => {
  const db = sqliteDatabase(':memory:'); const store = new MemoryStore(db);
  expect(() => createMemory({ ...draft('offset'), expiresAt: '2099-01-01T00:00:00+08:00' })).not.toThrow();
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const memory = { ...draft('neighbor ' + i), ...(i === 2 || i === 3 ? { expiresAt: '2020-01-01T00:00:00Z' } : {}) };
    ids.push(memory.id); await store.put(actor, { operationId: crypto.randomUUID(), memory, expectedVersion: 0 });
    const row = (await db.rows('SELECT payload FROM mb_memories WHERE id=?', [memory.id]))[0];
    const payload = JSON.parse(String(row.payload)); payload.updatedAt = i + 1;
    await db.run('UPDATE mb_memories SET updated_at=?,payload=? WHERE id=?', [i + 1, JSON.stringify(payload), memory.id]);
  }
  expect((await store.timeline(actor, 'demo', ids[4], 2)).map(entry => entry.id)).toEqual([ids[0], ids[1], ids[4]]);
  await store.close();
});

test('token rotation preserves pending data; Unix cache files and parent are owner-only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'membridge-regression-')); const path = join(root, 'private', 'cache.db');
  let client = new LocalClient(path, { url: 'http://localhost', token: 'a'.repeat(40), agent: 'a', fetch: (async () => { throw new Error('offline'); }) as unknown as typeof fetch });
  await client.remember(draft('durable pending')); client.close();
  client = new LocalClient(path, { url: 'http://localhost', token: 'b'.repeat(40), agent: 'a', fetch: (async () => { throw new Error('offline'); }) as unknown as typeof fetch });
  expect(client.status().pending).toBe(1);
  if (process.platform !== 'win32') {
    expect(statSync(join(root, 'private')).mode & 0o777).toBe(0o700);
    for (const file of [path, path + '-wal', path + '-shm']) expect(statSync(file).mode & 0o777).toBe(0o600);
  }
  client.close(); rmSync(root, { recursive: true, force: true });
});

test('legacy default cache import preserves pending data and becomes token-independent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'membridge-legacy-'));
  const options = { url: 'http://localhost', token: 'a'.repeat(40), namespace: 'owner', agent: 'a' };
  const oldPath = join(root, legacyIdentity(options.url, options.token, options.agent).slice(0, 16) + '.db');
  const offline = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
  const oldClient = new LocalClient(oldPath, { ...options, fetch: offline });
  await oldClient.remember(draft('legacy pending')); oldClient.close();
  const oldDB = new Database(oldPath);
  oldDB.query('UPDATE profile SET identity=?').run(legacyIdentity(options.url, options.token, options.agent));
  oldDB.run('DROP TABLE credentials'); oldDB.close();
  const migrated = selectCachePath(root, options);
  expect(migrated).toContain(cacheIdentity(options.url, options.namespace, options.agent).slice(0, 16));
  const client = new LocalClient(migrated, { ...options, fetch: offline });
  expect(client.status().pending).toBe(1); client.close();
  expect(selectCachePath(root, { ...options, token: 'b'.repeat(40) })).toBe(migrated);
  expect(() => new LocalClient(migrated, { ...options, namespace: 'another' })).toThrow('CACHE_IDENTITY_MISMATCH');
  rmSync(root, { recursive: true, force: true });
});

test('hashed read-only credentials can read but cannot mutate', async () => {
  const store = new MemoryStore(sqliteDatabase(':memory:')); const token = 'h'.repeat(40);
  const memory = draft('public evidence');
  await store.put(actor, { operationId: crypto.randomUUID(), memory, expectedVersion: 0 });
  const handle = createHandler(store, [{ ...actor, access: 'ro', tokenSha256: createHash('sha256').update(token).digest('hex') }]);
  const call = (path: string, body: unknown) => handle(new Request('http://localhost/v1/' + path, {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  expect((await call('search', { project: 'demo', query: 'evidence', limit: 10 })).status).toBe(200);
  expect((await call('put', { operationId: crypto.randomUUID(), memory, expectedVersion: 1 })).status).toBe(403);
  expect((await call('forget', { operationId: crypto.randomUUID(), project: 'demo', id: memory.id, expectedVersion: 1 })).status).toBe(403);
  await store.close();
});

test('408/425 remain pending and explicit retry recovers rejected operations', async () => {
  const store = new MemoryStore(sqliteDatabase(':memory:')); const token = 'r'.repeat(40);
  const handle = createHandler(store, [{ ...actor, token }]); let status = 408;
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith('/put') && status) return Response.json({ error: { code: 'TEMPORARY' } }, { status });
    return handle(new Request(input, init));
  }) as typeof fetch;
  const client = new LocalClient(':memory:', { url: 'http://localhost', token, agent: 'a', fetch: transport });
  expect((await client.remember(draft('retry evidence'))).syncStatus).toBe('pending');
  status = 425; expect((await client.sync()).pending).toBe(1);
  status = 422; expect((await client.sync()).blocked).toBe(1);
  status = 0; expect((await client.sync({ retryFailed: true })).operations).toEqual([]);
  client.close(); await store.close();
});

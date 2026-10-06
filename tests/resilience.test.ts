import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalClient } from '../src/client';
import { resolveRuntimeIdentity } from '../src/runtime-identity';
import { selectCachePath } from '../src/cache';
import { clientConfig } from '../src/config';
import { createHandler } from '../src/http';
import { MemoryStore } from '../src/store';
import { sqliteDatabase } from '../src/database';
import { redact } from '../src/model';

const draft = (body: string) => ({ project: 'demo', title: 'offline fact', body, kind: 'decision' as const, sources: ['test:source'] });
const offline = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;

test.each([0, 408, 425, 429, 503])('first bootstrap failure %s allows unbound local writes and later namespace binding', async status => {
  const root = mkdtempSync(join(tmpdir(), 'membridge-resilience-'));
  const config = clientConfig({ MEMBRIDGE_URL: 'http://localhost', MEMBRIDGE_TOKEN: 't'.repeat(40), MEMBRIDGE_AGENT: 'a' });
  const store = new MemoryStore(sqliteDatabase(':memory:'));
  const handle = createHandler(store, [{ namespace: 'team', agent: 'a', projects: ['demo'], token: config.token! }]);
  let online = false, now = 10000, requests = 0;
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    requests++;
    if (!online && status === 0) throw new Error('network unavailable');
    return online ? handle(new Request(input, init)) : Response.json({}, { status });
  }) as typeof fetch;
  let client: LocalClient | undefined;
  try {
    const unresolved = await resolveRuntimeIdentity(config, root, transport);
    expect(unresolved.namespace).toBeUndefined();
    const path = selectCachePath(root, unresolved);
    client = new LocalClient(path, { ...config, identityUnavailable: true, fetch: transport, now: () => now });
    const result = await client.remember(draft('saved before first connection'));
    expect(result.syncStatus).toBe('pending'); expect(client.status().namespace).toBeNull();
    expect(requests).toBe(1);
    expect((await client.get('demo', [result.memory!.id])).results[0].body).toBe('saved before first connection');
    online = true; now += 5001;
    expect((await client.sync()).pending).toBe(0); expect(client.status().namespace).toBe('team');
    client.close(); client = undefined;
    // No runtime hint was created by the later client binding. The DB itself
    // must retain the identity and queue across an offline restart.
    const again = await resolveRuntimeIdentity(config, root, offline);
    expect(selectCachePath(root, again)).toBe(path);
    client = new LocalClient(path, { ...config, fetch: offline });
    expect(client.status().namespace).toBe('team');
    await client.remember(draft('pending across token rotation')); client.close(); client = undefined;
    const rotated = { ...config, token: 'u'.repeat(40), namespace: 'team' };
    expect(selectCachePath(root, rotated)).toBe(path);
    const offlineRotation = await resolveRuntimeIdentity({ ...rotated, namespace: undefined }, root, offline);
    expect(selectCachePath(root, offlineRotation)).toBe(path);
    client = new LocalClient(path, { ...rotated, fetch: offline });
    expect(client.status().pending).toBe(1);
    expect(selectCachePath(root, { ...rotated, namespace: 'another-team' })).not.toBe(path);
  } finally { client?.close(); await store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('failed identity request is single-flight and not repeated by remember sync; manual retry recovers', async () => {
  let requests = 0, now = 10000;
  const store = new MemoryStore(sqliteDatabase(':memory:'));
  const handle = createHandler(store, [{ namespace: 'team', agent: 'a', projects: ['demo'], token: 't'.repeat(40) }]);
  let online = false;
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    requests++;
    if (!online) { await new Promise(resolve => setTimeout(resolve, 25)); throw new Error('timeout'); }
    return handle(new Request(input, init));
  }) as typeof fetch;
  const client = new LocalClient(':memory:', { url: 'http://localhost', token: 't'.repeat(40), agent: 'a', fetch: transport, now: () => now });
  try {
    const results = await Promise.all([client.remember(draft('one')), client.remember(draft('two'))]);
    expect(results.map(result => result.syncStatus)).toEqual(['pending', 'pending']); expect(requests).toBe(1);
    await client.remember(draft('three')); expect(requests).toBe(1);
    now += 5001; await client.remember(draft('four')); expect(requests).toBe(2);
    online = true; expect((await client.sync()).pending).toBe(0); expect(client.status().namespace).toBe('team');
  } finally { client.close(); await store.close(); }
});

test('bootstrap authentication failures remain fatal instead of silently switching identities', async () => {
  const config = clientConfig({ MEMBRIDGE_URL: 'http://localhost', MEMBRIDGE_TOKEN: 't'.repeat(40) });
  for (const status of [401, 403]) await expect(resolveRuntimeIdentity(config, null, (async () => Response.json({}, { status })) as unknown as typeof fetch)).rejects.toThrow('IDENTITY_HTTP_' + status);
});

test('first black-hole identity shares the two-second foreground budget and persists a local draft', async () => {
  let requests = 0;
  const blackHole = ((_: unknown, init?: RequestInit) => {
    requests++;
    return new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }));
  }) as typeof fetch;
  const client = new LocalClient(':memory:', { url: 'http://localhost', token: 't'.repeat(40), agent: 'a', fetch: blackHole });
  try {
    const started = performance.now();
    expect((await client.remember(draft('saved despite timeout'))).syncStatus).toBe('pending');
    expect(requests).toBe(1); expect(performance.now() - started).toBeLessThan(4000);
    expect(client.status().pending).toBe(1); expect(client.status().access).toBe('unknown');
  } finally { client.close(); }
}, 15000);

test('redaction preserves ports and paths containing @ while still removing URL passwords', () => {
  for (const url of ['http://localhost:3000/@vite/client', 'https://example.com:8443/docs/@scope/pkg']) expect(redact(url)).toBe(url);
  for (const url of ['mysql://user:secret@host:3306/db', 'redis://:secret@host:6379/0', 'https://user:secret%2Fvalue@host/path']) {
    expect(redact(url)).not.toContain('secret'); expect(redact(url)).toContain('[redacted]@host');
  }
  expect(redact('https://user:pa/ss@host')).toBe('https://user:pa/ss@host'); // Documented malformed-userinfo boundary.
});

test.each(['rw', 'ro'] as const)('late identity %s gates cloud upload after foreground deadline', async access => {
  const token = 't'.repeat(40), store = new MemoryStore(sqliteDatabase(':memory:'));
  const handle = createHandler(store, [{ namespace: 'team', agent: 'a', projects: ['demo'], token, access }]);
  let release!: () => void, identities = 0, puts = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith('/identity')) { identities++; await gate; }
    if (String(input).endsWith('/put')) puts++;
    return handle(new Request(input, init));
  }) as typeof fetch;
  const client = new LocalClient(':memory:', { url: 'http://localhost', token, agent: 'a', fetch: transport });
  try {
    const started = performance.now(), saved = await client.remember(draft('waiting for identity'));
    expect(performance.now() - started).toBeLessThan(4000); expect(saved.syncStatus).toBe('pending');
    expect(identities).toBe(1); expect(puts).toBe(0);
    const completion = client.sync({ retryIdentity: false }); release(); await completion;
    expect(client.status().access).toBe(access); expect(puts).toBe(access === 'rw' ? 1 : 0);
    expect(client.status().pending).toBe(0); expect(client.status().blocked).toBe(access === 'ro' ? 1 : 0);
    expect((await client.get('demo', [saved.memory!.id])).results[0].body).toBe('waiting for identity');
  } finally { release(); client.close(); await store.close(); }
}, 7000);

test('persisted read-only access rejects offline remember before waiting or queueing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'membridge-ro-budget-')), path = join(root, 'cache.db');
  const config = { url: 'http://localhost', token: 'r'.repeat(40), agent: 'a' };
  let client = new LocalClient(path, { ...config, fetch: (async () => Response.json({ namespace: 'team', agent: 'a', access: 'ro' })) as unknown as typeof fetch });
  try {
    await client.sync(); client.close();
    let calls = 0;
    client = new LocalClient(path, { ...config, fetch: (async () => { calls++; throw new Error('offline'); }) as unknown as typeof fetch });
    await expect(client.remember(draft('read only'))).rejects.toThrow('READ_ONLY_CREDENTIAL');
    expect(calls).toBe(0); expect(client.status().operations).toEqual([]);
  } finally { client.close(); rmSync(root, { recursive: true, force: true }); }
});

test('slow identity and upload consume one shared budget instead of two separate waits', async () => {
  let identities = 0, puts = 0;
  const transport = (async (input: unknown, init?: RequestInit) => {
    if (String(input).endsWith('/identity')) {
      identities++; await new Promise(resolve => setTimeout(resolve, 1100));
      return Response.json({ namespace: 'team', agent: 'a', access: 'rw' });
    }
    puts++;
    return new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('closed')), { once: true }));
  }) as typeof fetch;
  const client = new LocalClient(':memory:', { url: 'http://localhost', token: 't'.repeat(40), agent: 'a', fetch: transport });
  try {
    const started = performance.now(), saved = await client.remember(draft('one budget'));
    expect(performance.now() - started).toBeLessThan(2800); expect(saved.syncStatus).toBe('pending');
    expect(identities).toBe(1); expect(puts).toBe(1);
    const completion = client.sync({ retryIdentity: false }); client.close(); await completion;
  } finally { client.close(); }
}, 6000);

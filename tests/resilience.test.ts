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

test('black-hole identity consumes only one real request timeout per remember', async () => {
  let requests = 0;
  const blackHole = ((_: unknown, init?: RequestInit) => {
    requests++;
    return new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }));
  }) as typeof fetch;
  const client = new LocalClient(':memory:', { url: 'http://localhost', token: 't'.repeat(40), agent: 'a', fetch: blackHole });
  try {
    const started = performance.now();
    expect((await client.remember(draft('saved despite timeout'))).syncStatus).toBe('pending');
    expect(requests).toBe(1); expect(performance.now() - started).toBeLessThan(14000);
  } finally { client.close(); }
}, 15000);

test('redaction preserves ports and paths containing @ while still removing URL passwords', () => {
  for (const url of ['http://localhost:3000/@vite/client', 'https://example.com:8443/docs/@scope/pkg']) expect(redact(url)).toBe(url);
  for (const url of ['mysql://user:secret@host:3306/db', 'redis://:secret@host:6379/0']) {
    expect(redact(url)).not.toContain('secret'); expect(redact(url)).toContain('[redacted]@host');
  }
});

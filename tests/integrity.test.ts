import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LocalClient } from '../src/client';
import { MemoryStore } from '../src/store';
import { sqliteDatabase } from '../src/database';
import { createHandler } from '../src/http';
import { createMcp } from '../src/mcp';
import { createMemory, redact } from '../src/model';
import { bodyPages } from '../src/body-pages';
import { cacheIdentity, selectCachePath } from '../src/cache';
import { clientConfig } from '../src/config';
import { resolveRuntimeIdentity } from '../src/runtime-identity';
import { doctor } from '../src/doctor';
import { VERSION } from '../src/version';

const draft = (body: string) => ({ project: 'demo', title: 'record', body, kind: 'decision' as const, sources: ['test:source'] });
const offline = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
test('body pages never split surrogate pairs at either boundary', () => {
  const memory = { ...createMemory(draft('a'.repeat(999) + '😀𠮷tail')), agent: 'a', version: 1, createdAt: 1, updatedAt: 1 };
  const first = bodyPages([memory], 1000, 0)[0], second = bodyPages([memory], 1000, first.nextOffset!)[0];
  expect(first.body).toBe('a'.repeat(999)); expect(first.nextOffset).toBe(999);
  expect(first.body + second.body).toBe(memory.body);
  const arbitrary = bodyPages([memory], 1000, 1000)[0]; expect(arbitrary.offset).toBe(999); expect(arbitrary.body.startsWith('😀')).toBe(true);
  expect(bodyPages([{ ...memory, body: '😀' }], 1000, 1)[0].body).toBe('😀');
  for (const text of [first.body, second.body]) expect([...text].some(character => character.length === 1 && /[\uD800-\uDFFF]/.test(character))).toBe(false);
});

test('MCP continuation requires a version and rejects changed cloud content', async () => {
  const store = new MemoryStore(sqliteDatabase(':memory:')), token = 'a'.repeat(40);
  const actor = { namespace: 'team', agent: 'a', projects: ['demo'] };
  const handle = createHandler(store, [{ ...actor, token }]);
  let online = true;
  const transport = (async (input: string | URL | Request, init?: RequestInit) => { if (!online) throw new Error('offline'); return handle(new Request(input, init)); }) as typeof fetch;
  const local = new LocalClient(':memory:', { agent: 'a', url: 'http://localhost', token, fetch: transport });
  const memory = (await local.remember(draft('x'.repeat(2000)))).memory!;
  const server = createMcp(local), client = new Client({ name: 'test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair(); await server.connect(right); await client.connect(left);
  const read = async (args: Record<string, unknown>) => {
    const result = await client.callTool({ name: 'get_memories', arguments: { project: 'demo', ids: [memory.id], charBudget: 1000, ...args } });
    return JSON.parse((result.content as { text: string }[])[0].text);
  };
  try {
    expect((await read({ offset: 1000 })).error).toBe('PAGINATION_REQUIRES_SINGLE_ID_AND_VERSION');
    expect((await read({ offset: 1000, version: 1 })).results[0].body).toBe('x'.repeat(1000));
    await store.put(actor, { operationId: crypto.randomUUID(), memory: createMemory({ ...draft('y'.repeat(2000)), id: memory.id }), expectedVersion: 1 });
    expect((await read({ offset: 1000, version: 1 })).error).toBe('PAGINATION_VERSION_CHANGED');
    const cloudPage = (await read({ offset: 0 })).results[0];
    online = false; await local.remember({ ...draft('z'.repeat(2000)), id: memory.id }, 2);
    expect((await read({ offset: 1000, version: 2 })).error).toBe('PAGINATION_PENDING_REQUIRES_BODY_HASH');
    expect((await read({ offset: 1000, version: 2, bodyHash: cloudPage.bodyHash })).error).toBe('PAGINATION_VERSION_CHANGED');
    const pendingPage = (await read({ offset: 0 })).results[0];
    expect((await read({ offset: 1000, version: 2, bodyHash: pendingPage.bodyHash })).results[0].body).toBe('z'.repeat(1000));
  } finally { await client.close(); await server.close(); local.close(); await store.close(); }
});

test.skipIf(process.platform === 'win32')('external directory permissions are never changed; doctor and MCP both reject unsafe directories', async () => {
  const root = mkdtempSync(join(tmpdir(), 'membridge-permissions-')), outside = join(root, 'outside'), path = join(outside, 'cache.db');
  mkdirSync(outside); chmodSync(outside, 0o755);
  try {
    expect(() => new LocalClient(path, { agent: 'a' })).toThrow('UNSAFE_CACHE_DIRECTORY_PERMISSIONS');
    expect(statSync(outside).mode & 0o777).toBe(0o755); expect(existsSync(path)).toBe(false);
    const report = await doctor({ env: { MEMBRIDGE_AGENT: 'a', MEMBRIDGE_CACHE_PATH: path } });
    expect(report.checks.some(check => check.code === 'UNSAFE_CACHE_DIRECTORY_PERMISSIONS')).toBe(true);
    expect(statSync(outside).mode & 0o777).toBe(0o755);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('automatic namespace migrates unbound pending cache and offline restarts retain the resolved identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'membridge-identity-')), token = 'n'.repeat(40);
  const store = new MemoryStore(sqliteDatabase(':memory:')), actor = { namespace: 'team', agent: 'a', projects: ['demo'] };
  const handle = createHandler(store, [{ ...actor, token }]);
  const transport = (async (input: string | URL | Request, init?: RequestInit) => handle(new Request(input, init))) as typeof fetch;
  const config = clientConfig({ MEMBRIDGE_URL: 'http://localhost', MEMBRIDGE_TOKEN: token, MEMBRIDGE_AGENT: 'a' });
  const oldPath = join(root, cacheIdentity(config.url, 'owner', 'a').slice(0, 16) + '.db');
  let local = new LocalClient(oldPath, { ...config, fetch: offline });
  await local.remember(draft('pending before discovery')); local.close();
  const oldCache = new Database(oldPath); oldCache.run("UPDATE outbox SET status='blocked'"); oldCache.close();
  try {
    const resolved = await resolveRuntimeIdentity(config, root, transport);
    expect(resolved.namespace).toBe('team');
    const path = selectCachePath(root, resolved);
    local = new LocalClient(path, { ...config, fetch: transport });
    expect(local.status().blocked).toBe(1); expect((await local.sync()).operations).toEqual([]); expect(local.status().namespace).toBe('team'); local.close();
    const cached = await resolveRuntimeIdentity(config, root, offline); expect(cached.namespace).toBe('team');
    local = new LocalClient(selectCachePath(root, cached), { ...config, fetch: offline });
    expect(local.status().namespace).toBe('team'); await local.remember(draft('offline after discovery')); local.close();
    local = new LocalClient(path, { ...config, fetch: transport }); expect((await local.sync()).pending).toBe(0); local.close();
    await expect(resolveRuntimeIdentity({ ...config, token: 'other'.repeat(8) }, root, offline)).rejects.toThrow('CLOUD_IDENTITY_REQUIRED_FIRST_CONNECTION');
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('read-only credentials fail before changing local memory or queue', async () => {
  const store = new MemoryStore(sqliteDatabase(':memory:')), token = 'r'.repeat(40), actor = { namespace: 'team', agent: 'a', projects: ['demo'] };
  const memory = createMemory(draft('existing evidence')); await store.put(actor, { operationId: crypto.randomUUID(), memory, expectedVersion: 0 });
  const handle = createHandler(store, [{ ...actor, token, access: 'ro' }]);
  const transport = (async (input: string | URL | Request, init?: RequestInit) => handle(new Request(input, init))) as typeof fetch;
  const local = new LocalClient(':memory:', { url: 'http://localhost', token, agent: 'a', fetch: transport });
  try {
    await expect(local.remember(draft('must not appear locally'))).rejects.toThrow('READ_ONLY_CREDENTIAL');
    expect(local.status().operations).toEqual([]); expect(local.status().access).toBe('ro');
    expect((await local.get('demo', [memory.id])).results[0].body).toBe('existing evidence');
    await expect(local.forget('demo', memory.id, 1)).rejects.toThrow('READ_ONLY_CREDENTIAL');
    expect((await local.get('demo', [memory.id])).results).toHaveLength(1);
  } finally { local.close(); await store.close(); }
});

test('recent ordering uses the scope/update index without a temporary sort', async () => {
  const db = sqliteDatabase(':memory:');
  try {
    const plan = await db.rows('EXPLAIN QUERY PLAN SELECT payload FROM mb_memories WHERE namespace=? AND project=? AND deleted=0 ORDER BY updated_at DESC,id DESC LIMIT 100', ['owner', 'demo']);
    expect(JSON.stringify(plan)).toContain('mb_memories_recent'); expect(JSON.stringify(plan)).not.toContain('TEMP B-TREE');
  } finally { await db.close(); }
});

test('additional authorization schemes, empty URL username and Alibaba IDs are redacted', () => {
  for (const input of ['Authorization: Token sensitive-value', 'redis://:sensitive-value@host', 'LTAI' + 'A'.repeat(20)]) {
    const output = redact(input); expect(output).not.toContain('sensitive-value'); expect(output).not.toContain('LTAI'); expect(redact(output)).toBe(output);
  }
});

test.each([['ENOTFOUND', 'CLOUD_DNS_FAILURE'], ['CERT_HAS_EXPIRED', 'CLOUD_TLS_FAILURE'], ['ETIMEDOUT', 'CLOUD_TIMEOUT'], ['ECONNREFUSED', 'CLOUD_CONNECTION_REFUSED']])('doctor classifies %s without exposing error details', async (code, expected) => {
  const result = await doctor({ env: { MEMBRIDGE_URL: 'https://example.com', MEMBRIDGE_TOKEN: 't'.repeat(40) }, fetch: (async () => { throw Object.assign(new Error('sensitive-value'), { cause: { code } }); }) as unknown as typeof fetch });
  expect(result.checks.some(check => check.code === expected)).toBe(true); expect(JSON.stringify(result)).not.toContain('sensitive-value');
});

test('doctor warns about read-only credentials and rejects old server versions', async () => {
  const env = { MEMBRIDGE_URL: 'http://localhost', MEMBRIDGE_TOKEN: 't'.repeat(40), MEMBRIDGE_CACHE_PATH: ':memory:' };
  const transport = (version: string) => (async (input: unknown) => Response.json(String(input).endsWith('/health') ? { service: 'membridge', version } : { namespace: 'team', agent: 'a', access: 'ro' })) as unknown as typeof fetch;
  const old = await doctor({ env, fetch: transport('0.1.2') });
  expect(old.ok).toBe(false); expect(old.checks.some(check => check.code === 'SERVER_VERSION_TOO_OLD')).toBe(true);
  const current = await doctor({ env, fetch: transport(VERSION) });
  expect(current.ok).toBe(true); expect(current.checks.some(check => check.code === 'ACCESS_READ_ONLY')).toBe(true);
});

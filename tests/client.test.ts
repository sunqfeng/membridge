import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalClient } from '../src/client';
import { createHandler } from '../src/http';
import { MemoryStore } from '../src/store';
import { sqliteDatabase } from '../src/database';

test('offline memory persists, syncs to a second agent, caches locally, refreshes and retains conflicts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'membridge-'));
  const store = new MemoryStore(sqliteDatabase(':memory:'));
  const tokenA = 'a'.repeat(40), tokenB = 'b'.repeat(40);
  const handle = createHandler(store, [
    { token: tokenA, namespace: 'owner', agent: 'a', projects: ['shared'] },
    { token: tokenB, namespace: 'owner', agent: 'b', projects: ['shared'] },
  ]);
  let online = false, calls = 0, now = Date.now();
  const transport: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls++;
    if (!online) throw new TypeError('offline');
    return handle(new Request(input, init));
  }) as typeof fetch;
  const opts = { url: 'http://localhost', token: tokenA, agent: 'a', ttlMs: 100, fetch: transport, now: () => now };
  let a = new LocalClient(join(dir, 'a.db'), opts);
  const written = await a.remember({ project: 'shared', title: '共享决策', body: '腾讯云数据库', kind: 'decision', sources: ['test:source'] });
  expect(written.syncStatus).toBe('pending');
  if (!written.memory) throw new Error('Expected local pending memory');
  const memoryId = written.memory.id;
  expect(a.status().pending).toBe(1);
  a.close();
  a = new LocalClient(join(dir, 'a.db'), opts);
  expect((await a.search({ project: 'shared', query: '腾讯云', limit: 10 })).results[0].id).toBe(memoryId);
  online = true;
  expect((await a.sync()).pending).toBe(0);
  const b = new LocalClient(join(dir, 'b.db'), { ...opts, token: tokenB, agent: 'b' });
  const found = await b.search({ project: 'shared', query: '腾讯云', limit: 10 });
  expect(found.source).toBe('cloud');
  expect(found.results[0].id).toBe(memoryId);
  const afterCloud = calls;
  expect((await b.search({ project: 'shared', query: '腾讯云', limit: 10 })).source).toBe('local');
  expect(calls).toBe(afterCloud);
  const details = await b.get('shared', [memoryId]);
  expect(details.results[0].body).toBe('腾讯云数据库');
  online = false;
  await a.remember({ project: 'shared', id: memoryId, title: '共享决策', body: '离线修改', kind: 'decision', sources: ['test:a'] }, 1);
  online = true;
  await b.remember({ project: 'shared', id: memoryId, title: '共享决策', body: '云端修改', kind: 'decision', sources: ['test:b'] }, 1);
  expect((await a.sync()).conflicts).toBe(1);
  now += 101;
  expect((await b.search({ project: 'shared', query: '腾讯云', limit: 10 })).results).toEqual([]);
  a.close(); b.close(); await store.close(); rmSync(dir, { recursive: true, force: true });
});

import { test, expect } from 'bun:test';
import { createHandler } from '../src/http';
import { MemoryStore } from '../src/store';
import { sqliteDatabase } from '../src/database';
import { createMemory } from '../src/model';

test('two authenticated agents share a project, with boundary validation and access isolation', async () => {
  const store = new MemoryStore(sqliteDatabase(':memory:'));
  const tokenA = 'a'.repeat(40), tokenB = 'b'.repeat(40), tokenC = 'c'.repeat(40);
  const handle = createHandler(store, [
    { token: tokenA, namespace: 'owner', agent: 'a', projects: ['shared'] },
    { token: tokenB, namespace: 'owner', agent: 'b', projects: ['shared'] },
    { token: tokenC, namespace: 'owner', agent: 'c', projects: ['private'] },
  ]);
  const call = (path: string, body: unknown, token = tokenA) => handle(new Request('http://localhost/v1/' + path, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  const memory = createMemory({ project: 'shared', title: '腾讯云', body: '共享发现', kind: 'discovery', sources: ['test:evidence'] });
  expect((await call('put', { operationId: crypto.randomUUID(), memory, expectedVersion: 0 })).status).toBe(200);
  const result = await (await call('search', { project: 'shared', query: '共享' }, tokenB)).json();
  expect(result[0].id).toBe(memory.id);
  expect(result[0].body).toBeUndefined();
  expect((await call('get', { project: 'shared', ids: [memory.id] }, tokenC)).status).toBe(403);
  expect((await call('search', { project: 'shared', query: '共享' }, 'invalid')).status).toBe(401);
  expect((await call('search', { project: 'shared', query: '共享', extra: true })).status).toBe(400);
  expect((await call('search', { project: 'shared', query: 'x'.repeat(150000) })).status).toBe(413);
  await store.close();
});

test('authenticated rate limit triggers after 120 requests and recent validates scope/input', async () => {
  const store = new MemoryStore(sqliteDatabase(':memory:')), token = 'r'.repeat(40);
  const handle = createHandler(store, [{ token, namespace: 'owner', agent: 'a', projects: ['demo'], access: 'ro' }]);
  const call = (path: string, body: unknown) => handle(new Request('http://localhost/v1/' + path, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  try {
    expect((await call('recent', { project: 'other' })).status).toBe(403);
    expect((await call('recent', { project: 'demo', kind: 'invalid' })).status).toBe(400);
    for (let i = 0; i < 118; i++) expect((await call('identity', {})).status).toBe(200);
    const limited = await call('identity', {});
    expect(limited.status).toBe(429); expect((await limited.json()).error.code).toBe('RATE_LIMITED');
  } finally { await store.close(); }
});

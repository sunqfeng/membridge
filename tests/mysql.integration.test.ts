import { test, expect } from 'bun:test';
import { mysqlDatabase, schema } from '../src/database';
import mysql from 'mysql2/promise';
import { createHash } from 'node:crypto';
import { MemoryStore } from '../src/store';
import { createMemory } from '../src/model';
import { createHandler } from '../src/http';
import { LocalClient } from '../src/client';

const url = process.env.MEMBRIDGE_TEST_MYSQL_URL;
if (url && !new URL(url).pathname.slice(1).startsWith('membridge_test')) throw new Error('MySQL tests require a dedicated membridge_test* database');

test.skipIf(!url)('real MySQL: shared Chinese memory, concurrent CAS, idempotency, case-sensitive isolation and deletion replay', async () => {
  const namespace = 'test-' + crypto.randomUUID();
  // On a fresh CI database this is exactly the pre-generated-column schema.
  // An old writer and receipt survive startup migration unchanged.
  const fixture = createMemory({ project: 'shared', title: 'legacy', body: '升级前的决策', kind: 'decision', sources: ['test:legacy'] });
  const fixturePut = { operationId: crypto.randomUUID(), memory: fixture, expectedVersion: 0 };
  const fixtureMemory = { ...fixture, version: 1, agent: 'a', createdAt: Date.now(), updatedAt: Date.now() };
  const oldWriter = await mysql.createConnection(url!);
  try {
    for (const sql of schema) await oldWriter.execute(sql.replace(/VARCHAR\((80|36)\)/g, 'VARCHAR($1) CHARACTER SET ascii COLLATE ascii_bin') + ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin');
    await oldWriter.execute('INSERT INTO mb_memories(namespace,project,id,version,updated_at,payload) VALUES(?,?,?,?,?,?)', [namespace, 'shared', fixture.id, 1, fixtureMemory.updatedAt, JSON.stringify(fixtureMemory)]);
    await oldWriter.execute('INSERT INTO mb_operations(namespace,agent,id,project,memory_id,request_hash,result) VALUES(?,?,?,?,?,?,?)', [namespace, 'a', fixturePut.operationId, 'shared', fixture.id, createHash('sha256').update(JSON.stringify({ ...fixturePut, memory: createMemory(fixture) })).digest('hex'), JSON.stringify(fixtureMemory)]);
  } finally { await oldWriter.end(); }
  const db = await mysqlDatabase(url!);
  const store = new MemoryStore(db);
  const actorA = { namespace, agent: 'a', projects: ['shared'] };
  const actorB = { namespace, agent: 'b', projects: ['shared'] };
  const tokenA = 'test-a-' + crypto.randomUUID(), tokenB = 'test-b-' + crypto.randomUUID();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: createHandler(store, [
    { ...actorA, token: tokenA }, { ...actorB, token: tokenB },
  ]) });
  const a = new LocalClient(':memory:', { url: server.url.toString(), token: tokenA, namespace, agent: 'a' });
  const b = new LocalClient(':memory:', { url: server.url.toString(), token: tokenB, namespace, agent: 'b' });
  try {
    const orderIndex = await db.rows("SHOW INDEX FROM mb_memories WHERE Key_name='mb_memories_recent'");
    expect(orderIndex.map(row => row.Column_name)).toEqual(['namespace', 'project', 'deleted', 'updated_at', 'id']);
    expect((await store.put(actorA, fixturePut)).body).toBe(fixture.body);
    expect((await b.recent({ project: 'shared', kind: 'decision', limit: 10 })).results[0].id).toBe(fixture.id);
    let attempts = 0;
    await db.transaction(async conn => {
      await conn.run('INSERT INTO mb_scopes(namespace,project) VALUES(?,?)', [namespace, 'retry-proof']);
      if (++attempts < 3) throw Object.assign(new Error('synthetic lock failure'), { errno: attempts === 1 ? 1213 : 1205 });
    });
    expect(attempts).toBe(3);
    expect(await db.rows('SELECT project FROM mb_scopes WHERE namespace=? AND project=?', [namespace, 'retry-proof'])).toHaveLength(1);
    const shared = await a.remember({ project: 'shared', title: '真实 HTTP', body: '真实云端共享知识', kind: 'discovery', sources: ['test:synthetic-http'] });
    expect(shared.syncStatus).toBe('synced');
    expect((await b.search({ project: 'shared', query: '云端共享', limit: 10 })).results[0].id).toBe(shared.memory!.id);
    const revised = createMemory({ project: 'shared', id: shared.memory!.id, title: 'conflict', body: '云端修改', kind: 'discovery', sources: ['test:remote'] });
    await store.put(actorB, { operationId: crypto.randomUUID(), memory: revised, expectedVersion: 1 });
    expect((await a.remember({ ...revised, body: '保留本地修改' }, 1)).syncStatus).toBe('conflict');
    const preview = await a.rebasePending('shared', revised.id);
    expect(preview.expectedVersion).toBe(2);
    expect((await a.rebasePending('shared', revised.id, preview.expectedVersion, preview.confirmToken)).syncStatus).toBe('synced');
    const memory = createMemory({ project: 'shared', title: '共享 MySQL', body: '腾讯云中文记忆', kind: 'decision', sources: ['test:synthetic'] });
    const original = { operationId: crypto.randomUUID(), memory, expectedVersion: 0 };
    expect((await store.put(actorA, original)).version).toBe(1);
    expect((await store.put(actorA, original)).version).toBe(1);
    expect((await store.search(actorB, { project: 'shared', query: '腾讯云', limit: 10 }))[0].id).toBe(memory.id);
    const concurrent = await Promise.all(Array.from({ length: 8 }, (_, i) => store.put({ ...actorA, projects: ['new-scope'] }, {
      operationId: crypto.randomUUID(), expectedVersion: 0,
      memory: createMemory({ project: 'new-scope', title: 'new scope', body: 'concurrent ' + i, kind: 'discovery', sources: ['test:concurrency'] }),
    })));
    expect(concurrent).toHaveLength(8);
    const escaped = createMemory({ project: 'shared', title: 'kind', body: 'line\n"quoted" 中文', kind: 'discovery', sources: ['test:escaping'] });
    await store.put(actorA, { operationId: crypto.randomUUID(), memory: escaped, expectedVersion: 0 });
    for (const query of ['"quoted"', 'line\n', 'kind']) expect((await store.search(actorB, { project: 'shared', query, limit: 10 }))[0].id).toBe(escaped.id);
    expect(await store.get({ ...actorB, namespace: namespace.toUpperCase() }, 'shared', [memory.id])).toEqual([]);
    const writes = await Promise.allSettled([
      store.put(actorA, { operationId: crypto.randomUUID(), memory: { ...memory, body: 'A 修改' }, expectedVersion: 1 }),
      store.put(actorB, { operationId: crypto.randomUUID(), memory: { ...memory, body: 'B 修改' }, expectedVersion: 1 }),
    ]);
    expect(writes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(writes.filter(result => result.status === 'rejected')).toHaveLength(1);
    const deletion = { operationId: crypto.randomUUID(), project: 'shared', id: memory.id, expectedVersion: 2 };
    expect((await store.forget(actorB, deletion)).deleted).toBe(true);
    expect((await store.forget(actorB, deletion)).deleted).toBe(true);
    expect(await store.get(actorA, 'shared', [memory.id])).toEqual([]);
    await expect(store.put(actorA, original)).rejects.toThrow('MEMORY_DELETED');
    await expect(store.put(actorA, { ...original, operationId: crypto.randomUUID() })).rejects.toThrow('CONFLICT');
  } finally {
    a.close(); b.close(); await server.stop(true);
    for (const table of ['mb_memories', 'mb_operations', 'mb_scopes']) await db.run(`DELETE FROM ${table} WHERE namespace=?`, [namespace]);
    await store.close();
  }
}, 30000);

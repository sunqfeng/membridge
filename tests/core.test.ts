import { test, expect } from 'bun:test';
import { MemoryStore } from '../src/store';
import { sqliteDatabase } from '../src/database';
import { createMemory, redact } from '../src/model';

const actor = { namespace: 'owner', agent: 'researcher', projects: ['demo'] };
const input = () => createMemory({ project: 'demo', title: '中文共享记忆', body: '已经确认采用腾讯云 MySQL。', kind: 'decision', sources: ['user:explicit-request'] });

test('persistent store: Chinese retrieval, scoped reads, replay, revision conflicts and tombstones', async () => {
  const store = new MemoryStore(sqliteDatabase(':memory:'));
  const memory = input();
  const op = { operationId: crypto.randomUUID(), memory, expectedVersion: 0 };
  const saved = await store.put(actor, op);
  expect(saved.version).toBe(1);
  expect((await store.put(actor, op)).version).toBe(1);
  expect((await store.search(actor, { project: 'demo', query: '腾讯云', limit: 10 }))[0].id).toBe(memory.id);
  expect(await store.get({ ...actor, namespace: 'other' }, 'demo', [memory.id])).toEqual([]);
  await expect(store.get({ ...actor, projects: ['private'] }, 'demo', [memory.id])).rejects.toThrow('FORBIDDEN');
  const updated = await store.put(actor, { ...op, operationId: crypto.randomUUID(), expectedVersion: 1, memory: { ...memory, body: '更新事实' } });
  expect(updated.version).toBe(2);
  await expect(store.put(actor, { ...op, operationId: crypto.randomUUID(), expectedVersion: 1 })).rejects.toThrow('CONFLICT');
  await store.forget(actor, { operationId: crypto.randomUUID(), project: 'demo', id: memory.id, expectedVersion: 2 });
  expect(await store.get(actor, 'demo', [memory.id])).toEqual([]);
  await expect(store.put(actor, { ...op, operationId: crypto.randomUUID() })).rejects.toThrow('CONFLICT');
  await store.close();
});

test('expiry and literal wildcard queries do not produce false matches; op IDs cannot be reused for new content', async () => {
  const store = new MemoryStore(sqliteDatabase(':memory:'));
  const expired = { ...input(), expiresAt: '2020-01-01T00:00:00Z' };
  const operation = { operationId: crypto.randomUUID(), memory: expired, expectedVersion: 0 };
  await store.put(actor, operation);
  expect(await store.search(actor, { project: 'demo', query: '腾讯云', limit: 10 })).toEqual([]);
  expect(await store.get(actor, 'demo', [expired.id])).toEqual([]);
  await expect(store.put(actor, { ...operation, memory: { ...expired, body: 'other' } })).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  const literal = createMemory({ project: 'demo', title: '100%_match', body: 'Only this row', kind: 'discovery', sources: ['test:source'] });
  await store.put(actor, { operationId: crypto.randomUUID(), memory: literal, expectedVersion: 0 });
  expect((await store.search(actor, { project: 'demo', query: '%_', limit: 10 }))[0].id).toBe(literal.id);
  await store.close();
});

test('privacy: private blocks, credentials and provenance are sanitized before persistence', () => {
  const secret = 'sk-' + 'x'.repeat(30);
  expect(redact(`safe <private>hidden</private> ${secret}`)).not.toContain('hidden');
  expect(redact(secret)).not.toContain(secret);
  const scrubbed = redact('password=sample-private-value');
  expect(redact(scrubbed)).toBe(scrubbed);
  expect(createMemory({ project: 'demo', title: 'Fact', body: secret, kind: 'discovery', sources: [secret] }).sources[0]).not.toContain(secret);
});

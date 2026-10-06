import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHandler } from '../src/http';
import { MemoryStore } from '../src/store';
import { sqliteDatabase } from '../src/database';

test.each(['mcp.ts', 'cli.ts'])('real stdio %s subprocess responds without corrupting MCP stdout', async entry => {
  const dir = mkdtempSync(join(tmpdir(), 'membridge-stdio-'));
  const client = new Client({ name: 'stdio-test', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [resolve(import.meta.dir, '../src/' + entry), ...(entry === 'cli.ts' ? ['mcp'] : [])],
    env: { MEMBRIDGE_AGENT: 'stdio-test', MEMBRIDGE_CACHE_PATH: join(dir, 'cache.db') }, stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['search', 'recent', 'get_memories', 'remember', 'rebase_pending', 'sync']));
    const status = await client.callTool({ name: 'status', arguments: {} });
    expect(JSON.parse((status.content as { text: string }[])[0].text).configured).toBe(false);
  } finally {
    await client.close();
    if (!resolve(dir).startsWith(resolve(tmpdir()) + '/') && !resolve(dir).startsWith(resolve(tmpdir()) + '\\')) throw new Error('Unsafe cleanup path');
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

test('real MCP runtime discovers team namespace and blocks read-only writes before queueing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'membridge-auto-stdio-')), token = 'r'.repeat(40);
  const store = new MemoryStore(sqliteDatabase(':memory:'));
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: createHandler(store, [{ token, namespace: 'team', agent: 'auto-test', projects: ['demo'], access: 'ro' }]) });
  const client = new Client({ name: 'auto-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(import.meta.dir, '../src/cli.ts'), 'mcp'],
    env: { MEMBRIDGE_URL: server.url.toString(), MEMBRIDGE_TOKEN: token, MEMBRIDGE_AGENT: 'auto-test', MEMBRIDGE_CACHE_PATH: join(dir, 'private', 'cache.db') }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const saved = await client.callTool({ name: 'remember', arguments: { project: 'demo', title: 'readonly', body: 'must not queue', kind: 'decision', sources: ['test:source'] } });
    expect(JSON.parse((saved.content as { text: string }[])[0].text).error).toBe('READ_ONLY_CREDENTIAL');
    const status = await client.callTool({ name: 'status', arguments: {} });
    const report = JSON.parse((status.content as { text: string }[])[0].text);
    expect(report.namespace).toBe('team'); expect(report.access).toBe('ro'); expect(report.operations).toEqual([]);
  } finally { await client.close(); await server.stop(true); await store.close(); rmSync(dir, { recursive: true, force: true }); }
}, 15000);

test.each([429, 503])('real first-start MCP survives identity HTTP %s and serves local memory', async status => {
  const dir = mkdtempSync(join(tmpdir(), 'membridge-offline-stdio-'));
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({}, { status }) });
  const client = new Client({ name: 'offline-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(import.meta.dir, '../src/cli.ts'), 'mcp'],
    env: { MEMBRIDGE_URL: server.url.toString(), MEMBRIDGE_TOKEN: 't'.repeat(40), MEMBRIDGE_AGENT: 'offline-test', MEMBRIDGE_CACHE_PATH: join(dir, 'cache.db') }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const saved = JSON.parse(((await client.callTool({ name: 'remember', arguments: { project: 'demo', title: 'offline', body: 'available locally', kind: 'decision', sources: ['test:source'] } })).content as { text: string }[])[0].text);
    expect(saved.syncStatus).toBe('pending');
    const read = JSON.parse(((await client.callTool({ name: 'get_memories', arguments: { project: 'demo', ids: [saved.memory.id] } })).content as { text: string }[])[0].text);
    expect(read.results[0].body).toBe('available locally');
    const report = JSON.parse(((await client.callTool({ name: 'status', arguments: {} })).content as { text: string }[])[0].text);
    expect(report.namespace).toBeNull(); expect(report.pending).toBe(1);
  } finally { await client.close(); await server.stop(true); rmSync(dir, { recursive: true, force: true }); }
}, 15000);

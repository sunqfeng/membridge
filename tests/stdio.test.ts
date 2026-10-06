import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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

import { test, expect } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LocalClient } from '../src/client';
import { createMcp } from '../src/mcp';

test('MCP initialize, tool discovery and local write/search/detail work through the official protocol', async () => {
  const local = new LocalClient(':memory:', { agent: 'test' });
  const server = createMcp(local);
  const client = new Client({ name: 'test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right);
  await client.connect(left);
  expect((await client.listTools()).tools.map(tool => tool.name)).toContain('remember');
  const saved = await client.callTool({ name: 'remember', arguments: { project: 'demo', title: '协议记忆', body: '中文来源记录', kind: 'discovery', sources: ['test:evidence'] } });
  const written = JSON.parse((saved.content as { text: string }[])[0].text);
  expect(written.syncStatus).toBe('pending');
  const found = await client.callTool({ name: 'search', arguments: { project: 'demo', query: '中文' } });
  expect(JSON.parse((found.content as { text: string }[])[0].text).results[0].id).toBe(written.memory.id);
  const detail = await client.callTool({ name: 'get_memories', arguments: { project: 'demo', ids: [written.memory.id] } });
  expect(JSON.parse((detail.content as { text: string }[])[0].text).results[0].body).toBe('中文来源记录');
  await client.close(); await server.close(); local.close();
});

import { readFileSync } from 'node:fs';
import { mysqlDatabase } from './database';
import { createHandler, tokenSchema } from './http';
import { MemoryStore } from './store';

async function main() {
  if (!process.env.MYSQL_URL || !process.env.MEMBRIDGE_TOKENS_FILE) throw new Error('MYSQL_URL and MEMBRIDGE_TOKENS_FILE are required');
  const tokens = tokenSchema.parse(JSON.parse(readFileSync(process.env.MEMBRIDGE_TOKENS_FILE, 'utf8')));
  if (new Set(tokens.map(item => item.token)).size !== tokens.length) throw new Error('Duplicate agent token');
  const port = Number(process.env.PORT ?? '8787');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  const store = new MemoryStore(await mysqlDatabase(process.env.MYSQL_URL));
  const server = Bun.serve({ hostname: process.env.HOST ?? '127.0.0.1', port, maxRequestBodySize: 131072, fetch: createHandler(store, tokens) });
  console.error(`MemBridge listening on ${server.hostname}:${server.port}`);
  const shutdown = async () => { await server.stop(true); await store.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
main().catch(() => { console.error('MemBridge startup failed. Check database connectivity and token configuration.'); process.exit(1); });

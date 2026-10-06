import { readFileSync } from 'node:fs';
import { mysqlDatabase } from './database';
import { createHandler, tokenSchema } from './http';
import { MemoryStore } from './store';
import { createHash } from 'node:crypto';
import { AppError } from './model';
import { diagnostic } from './diagnostics';

async function main() {
  if (!process.env.MYSQL_URL || !process.env.MEMBRIDGE_TOKENS_FILE) throw new AppError('SERVER_CONFIGURATION_REQUIRED');
  const tokens = tokenSchema.parse(JSON.parse(readFileSync(process.env.MEMBRIDGE_TOKENS_FILE, 'utf8')));
  if (tokens.some(item => item.token?.includes('REPLACE_'))) throw new AppError('PLACEHOLDER_TOKEN');
  if (new Set(tokens.map(item => item.tokenSha256 ?? createHash('sha256').update(item.token!).digest('hex'))).size !== tokens.length) throw new AppError('DUPLICATE_TOKEN');
  if (new Set(tokens.map(item => JSON.stringify([item.namespace,item.agent]))).size !== tokens.length) throw new AppError('DUPLICATE_AGENT_IDENTITY');
  const port = Number(process.env.PORT ?? '8787');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  const store = new MemoryStore(await mysqlDatabase(process.env.MYSQL_URL));
  const server = Bun.serve({ hostname: process.env.HOST ?? '127.0.0.1', port, maxRequestBodySize: 131072, fetch: createHandler(store, tokens) });
  console.error(`MemBridge listening on ${server.hostname}:${server.port}`);
  const shutdown = async () => { await server.stop(true); await store.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
main().catch(error => { diagnostic('MemBridge startup failed', error); process.exit(1); });

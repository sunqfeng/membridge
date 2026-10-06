import { Database } from 'bun:sqlite';
import { existsSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AppError, projectSchema } from './model';
import { clientConfig, type Environment } from './config';
import { cacheIdentity, legacyIdentity } from './cache';

type Check = { code: string; status: 'ok' | 'warning' | 'error' };
type Report = { ok: boolean; checks: Check[]; codexConfig?: string; claudeConfig?: { mcpServers: { membridge: { command: string; args: string[]; env: Record<string, string> } } } };
export async function doctor(options: { env?: Environment; fetch?: typeof fetch } = {}): Promise<Report> {
  const env = options.env ?? process.env, checks: Check[] = [];
  let config: ReturnType<typeof clientConfig>;
  try { config = clientConfig(env); checks.push({ code: 'CLIENT_CONFIG_VALID', status: 'ok' }); }
  catch (error) { return { ok: false, checks: [{ code: error instanceof AppError ? error.code : 'INVALID_CONFIG', status: 'error' }] }; }
  if (config.url && config.token) {
    try {
      const response = await (options.fetch ?? fetch)(config.url.replace(/\/$/, '') + '/v1/identity', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { authorization: 'Bearer ' + config.token, 'content-type': 'application/json' }, body: '{}',
      });
      if (!response.ok) checks.push({ code: 'CLOUD_HTTP_' + response.status, status: 'error' });
      else {
        const identity = z.object({ namespace: projectSchema, agent: projectSchema }).safeParse(await response.json());
        if (!identity.success) checks.push({ code: 'INVALID_CLOUD_IDENTITY', status: 'error' });
        else {
          for (const field of ['namespace', 'agent'] as const) {
            const explicit = env['MEMBRIDGE_' + field.toUpperCase()] !== undefined;
            if (explicit && config[field] !== identity.data[field]) checks.push({ code: 'CLOUD_' + field.toUpperCase() + '_MISMATCH', status: 'error' });
            else { config[field] = identity.data[field]; checks.push({ code: field.toUpperCase() + (explicit ? '_MATCHED' : '_INFERRED'), status: 'ok' }); }
          }
          checks.push({ code: 'CLOUD_AUTHENTICATED', status: 'ok' });
        }
      }
    } catch { checks.push({ code: 'CLOUD_UNAVAILABLE', status: 'error' }); }
  } else checks.push({ code: 'LOCAL_ONLY_NOT_SHARED', status: 'warning' });
  const cachePath = env.MEMBRIDGE_CACHE_PATH ?? join(homedir(), '.membridge', cacheIdentity(config.url, config.namespace, config.agent).slice(0, 16) + '.db');
  const parent = dirname(resolve(cachePath));
  try {
    if (cachePath !== ':memory:') {
      if (existsSync(parent)) {
        const entry = lstatSync(parent);
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new AppError('UNSAFE_CACHE_DIRECTORY');
        if (process.platform !== 'win32' && (entry.uid !== process.getuid?.() || (entry.mode & 0o077) !== 0)) throw new AppError('UNSAFE_CACHE_DIRECTORY_PERMISSIONS');
      }
      for (const file of [cachePath, cachePath + '-wal', cachePath + '-shm']) if (existsSync(file)) {
        const entry = lstatSync(file);
        if (!entry.isFile() || entry.isSymbolicLink()) throw new AppError('UNSAFE_CACHE_FILE');
        if (process.platform !== 'win32' && (entry.uid !== process.getuid?.() || (entry.mode & 0o077) !== 0)) throw new AppError('UNSAFE_CACHE_FILE_PERMISSIONS');
      }
      if (existsSync(cachePath)) {
        const db = new Database(cachePath, { readonly: true });
        try {
          const profile = db.query('SELECT identity FROM profile WHERE id=1').get() as { identity: string } | null;
          if (profile?.identity === legacyIdentity(config.url, config.token, config.agent)) checks.push({ code: 'LEGACY_CACHE_REQUIRES_UPGRADE', status: 'warning' });
          else if (profile?.identity !== cacheIdentity(config.url, config.namespace, config.agent)) throw new AppError('CACHE_IDENTITY_MISMATCH');
        } finally { db.close(); }
      }
      checks.push({ code: existsSync(cachePath) ? 'CACHE_READABLE' : 'CACHE_CREATED_ON_MCP_START', status: 'ok' });
      if (process.platform === 'win32') checks.push({ code: 'WINDOWS_ACL_CHECK_MANUALLY', status: 'warning' });
    }
  } catch (error) { checks.push({ code: error instanceof AppError ? error.code : 'CACHE_CHECK_FAILED', status: 'error' }); }
  const ok = !checks.some(check => check.status === 'error');
  if (!ok) return { ok, checks };
  // Credentials are inherited from the launch environment, never included in reports.
  const snippetEnv: Record<string, string> = { MEMBRIDGE_NAMESPACE: config.namespace, MEMBRIDGE_AGENT: config.agent, MEMBRIDGE_CACHE_TTL_MS: String(config.ttlMs) };
  if (config.url) snippetEnv.MEMBRIDGE_URL = config.url;
  if (env.MEMBRIDGE_CACHE_PATH) snippetEnv.MEMBRIDGE_CACHE_PATH = cachePath === ':memory:' ? cachePath : resolve(cachePath);
  const entry = { command: process.execPath, args: [fileURLToPath(new URL('./cli.ts', import.meta.url)), 'mcp'], env: snippetEnv };
  const codexConfig = ['[mcp_servers.membridge]', 'command = ' + JSON.stringify(entry.command), 'args = ' + JSON.stringify(entry.args), '', '[mcp_servers.membridge.env]', ...Object.entries(snippetEnv).map(([key, value]) => key + ' = ' + JSON.stringify(value))].join('\n');
  return { ok, checks, codexConfig, claudeConfig: { mcpServers: { membridge: entry } } };
}

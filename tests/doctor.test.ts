import { test, expect } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { doctor } from '../src/doctor';
import { LocalClient } from '../src/client';
import { VERSION } from '../src/version';

test('doctor infers cloud namespace/agent, emits portable configs without secrets and never creates cache', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'membridge-doctor-')); const cache = join(dir, 'private', 'cache.db');
  const token = 'private-token-' + 'a'.repeat(32);
  let calls = 0;
  const transport = (async (input: unknown, init: RequestInit) => {
    calls++;
    if (String(input).endsWith('/health')) return Response.json({ service: 'membridge', version: VERSION });
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer ' + token);
    return Response.json({ namespace: 'team', agent: 'research', access: 'rw' });
  }) as unknown as typeof fetch;
  try {
    const result = await doctor({ env: { MEMBRIDGE_URL: 'http://localhost', MEMBRIDGE_TOKEN: token, MEMBRIDGE_CACHE_PATH: cache }, fetch: transport });
    expect(result.ok).toBe(true); expect(calls).toBe(2);
    expect(result.claudeConfig!.mcpServers.membridge.env.MEMBRIDGE_NAMESPACE).toBe('team');
    expect(result.claudeConfig!.mcpServers.membridge.env.MEMBRIDGE_AGENT).toBe('research');
    expect(result.codexConfig).toContain('MEMBRIDGE_NAMESPACE = "team"');
    expect(JSON.stringify(result)).not.toContain(token); expect(existsSync(cache)).toBe(false);
    const mismatch = await doctor({ env: { MEMBRIDGE_URL: 'http://localhost', MEMBRIDGE_TOKEN: token, MEMBRIDGE_NAMESPACE: 'wrong' }, fetch: transport });
    expect(mismatch.ok).toBe(false); expect(mismatch.checks.some(check => check.code === 'CLOUD_NAMESPACE_MISMATCH')).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('doctor checks cache identity and Unix permissions without modifying existing data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'membridge-doctor-cache-')), path = join(root, 'private', 'cache.db');
  const local = new LocalClient(path, { namespace: 'owner', agent: 'a' });
  await local.remember({ project: 'demo', title: 'pending', body: 'private evidence', kind: 'discovery', sources: ['test:source'] }); local.close();
  try {
    const env = { MEMBRIDGE_AGENT: 'a', MEMBRIDGE_CACHE_PATH: path };
    expect((await doctor({ env })).ok).toBe(true);
    expect((await doctor({ env: { ...env, MEMBRIDGE_NAMESPACE: 'other' } })).ok).toBe(false);
    if (process.platform !== 'win32') {
      chmodSync(path, 0o644);
      const unsafe = await doctor({ env });
      expect(unsafe.checks.some(check => check.code === 'UNSAFE_CACHE_FILE_PERMISSIONS')).toBe(true);
      chmodSync(path, 0o600);
    }
    const reopened = new LocalClient(path, { namespace: 'owner', agent: 'a' }); expect(reopened.status().pending).toBe(1); reopened.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor reports unsafe URL, unauthorized and offline cloud without exposing credentials', async () => {
  const token = 'private-token-' + 'b'.repeat(32);
  const offline = (async () => { throw new Error('secret diagnostic ' + token); }) as unknown as typeof fetch;
  const unsafe = await doctor({ env: { MEMBRIDGE_URL: 'https://user:password@example.com', MEMBRIDGE_TOKEN: token }, fetch: offline });
  expect(unsafe.ok).toBe(false); expect(JSON.stringify(unsafe)).not.toContain('password');
  const failed = await doctor({ env: { MEMBRIDGE_URL: 'https://example.com', MEMBRIDGE_TOKEN: token }, fetch: offline });
  expect(failed.ok).toBe(false); expect(JSON.stringify(failed)).not.toContain(token);
  const forbidden = await doctor({ env: { MEMBRIDGE_URL: 'http://localhost', MEMBRIDGE_TOKEN: token }, fetch: (async () => new Response('', { status: 401 })) as unknown as typeof fetch });
  expect(forbidden.checks.some(check => check.code === 'CLOUD_HTTP_401')).toBe(true);
});

test('doctor CLI emits pasteable TOML/JSON and returns failure exit code', async () => {
  const root = mkdtempSync(join(tmpdir(), 'membridge-doctor-cli-')), path = join(root, 'private', 'cache.db');
  const token = 'cli-token-' + 'z'.repeat(32);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => Response.json(new URL(request.url).pathname === '/health' ? { service: 'membridge', version: VERSION } : { namespace: 'team', agent: 'cli-agent', access: 'rw' }) });
  const execute = async (url: string) => {
    const subprocess = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'doctor'], {
      env: { MEMBRIDGE_URL: url, MEMBRIDGE_TOKEN: token, MEMBRIDGE_CACHE_PATH: path }, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([new Response(subprocess.stdout).text(), new Response(subprocess.stderr).text(), subprocess.exited]);
    return { stdout, stderr, code };
  };
  try {
    const result = await execute(server.url.toString());
    expect(result.code).toBe(0); expect(result.stdout).toContain('\n[mcp_servers.membridge]\n');
    expect(result.stdout).toContain('MEMBRIDGE_NAMESPACE = "team"');
    expect(result.stdout + result.stderr).not.toContain(token); expect(existsSync(path)).toBe(false);
    expect((await execute('http://unsafe.example.com')).code).toBe(1);
  } finally { await server.stop(true); rmSync(root, { recursive: true, force: true }); }
});

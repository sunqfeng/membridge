import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, identitySchema } from './model';
import { secureCache } from './cache';
import type { clientConfig } from './config';

export async function resolveRuntimeIdentity(config: ReturnType<typeof clientConfig>, directory: string | null, requestFetch: typeof fetch = fetch) {
  if (config.namespace !== undefined || !config.url || !config.token) return { ...config, namespace: config.namespace ?? 'owner' };
  const fingerprint = createHash('sha256').update(config.token).digest('hex');
  const key = createHash('sha256').update(JSON.stringify([config.url.replace(/\/$/, ''), config.agent, fingerprint])).digest('hex').slice(0, 16);
  const path = directory === null ? undefined : join(directory, key + '.identity.json');
  let identity: ReturnType<typeof identitySchema.parse>;
  try {
    const response = await requestFetch(config.url.replace(/\/$/, '') + '/v1/identity', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { authorization: 'Bearer ' + config.token, 'content-type': 'application/json' }, body: '{}',
    });
    if (!response.ok) throw new AppError('IDENTITY_HTTP_' + response.status, response.status);
    identity = identitySchema.parse(await response.json());
  } catch (error) {
    if (error instanceof AppError && error.status < 500) throw error;
    try {
      if (!path) throw new Error('No persisted identity');
      const hint = JSON.parse(readFileSync(path, 'utf8'));
      if (hint.fingerprint !== fingerprint) throw new Error('Different credentials');
      identity = identitySchema.parse(hint);
    } catch { throw new AppError('CLOUD_IDENTITY_REQUIRED_FIRST_CONNECTION', 503); }
  }
  if (identity.agent !== config.agent) throw new AppError('CLOUD_IDENTITY_MISMATCH', 403);
  if (path) {
    secureCache(path);
    const temporary = path + '.' + crypto.randomUUID() + '.tmp';
    try { writeFileSync(temporary, JSON.stringify({ ...identity, fingerprint }), { mode: 0o600, flag: 'wx' }); renameSync(temporary, path); }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  return { ...config, namespace: identity.namespace };
}

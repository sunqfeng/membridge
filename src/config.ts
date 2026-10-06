import { AppError, projectSchema } from './model';

export type Environment = Record<string, string | undefined>;
export function clientConfig(env: Environment = process.env) {
  const url = env.MEMBRIDGE_URL || undefined, token = env.MEMBRIDGE_TOKEN || undefined;
  if (Boolean(url) !== Boolean(token)) throw new AppError('URL_AND_TOKEN_REQUIRED_TOGETHER');
  if (url) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new AppError('INVALID_CLOUD_URL'); }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new AppError('INVALID_CLOUD_URL');
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) throw new AppError('CLOUD_REQUIRES_HTTPS');
    if (token!.length < 32 || token!.length > 256) throw new AppError('INVALID_TOKEN_LENGTH');
  }
  const agent = projectSchema.safeParse(env.MEMBRIDGE_AGENT ?? 'local-agent');
  const namespace = projectSchema.safeParse(env.MEMBRIDGE_NAMESPACE ?? 'owner');
  if (!agent.success || !namespace.success) throw new AppError('INVALID_AGENT_OR_NAMESPACE');
  const ttlMs = Number(env.MEMBRIDGE_CACHE_TTL_MS ?? '60000');
  if (!Number.isFinite(ttlMs) || ttlMs < 0 || ttlMs > 3600000) throw new AppError('INVALID_CACHE_TTL');
  return { url, token, agent: agent.data, namespace: namespace.data, ttlMs };
}

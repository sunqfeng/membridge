import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError, type Principal, projectSchema, putSchema, searchSchema, getSchema, timelineSchema, forgetSchema } from './model';
import { MemoryStore } from './store';

export const tokenSchema = z.array(z.object({
  token: z.string().min(32).max(256), namespace: projectSchema, agent: projectSchema,
  projects: z.array(projectSchema).min(1),
}).strict()).min(1);
export type TokenConfig = z.infer<typeof tokenSchema>;

export function createHandler(store: MemoryStore, tokens: TokenConfig) {
  const limits = new Map<string, { start: number; count: number }>();
  const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  return async (request: Request) => {
    try {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/health') return response({ status: 'ok', service: 'membridge', version: '0.1.0' });
      if (request.method !== 'POST') throw new AppError('METHOD_NOT_ALLOWED', 405);
      const supplied = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
      const matched = tokens.find(item => {
        const left = Buffer.from(item.token), right = Buffer.from(supplied);
        return left.length === right.length && timingSafeEqual(left, right);
      });
      if (!matched) throw new AppError('UNAUTHORIZED', 401);
      const actor: Principal = matched;
      const key = actor.namespace + ':' + actor.agent;
      const now = Date.now();
      let limit = limits.get(key);
      if (!limit || now - limit.start >= 60000) { limit = { start: now, count: 0 }; limits.set(key, limit); }
      if (++limit.count > 120) throw new AppError('RATE_LIMITED', 429);
      if (!request.headers.get('content-type')?.startsWith('application/json')) throw new AppError('JSON_REQUIRED', 415);
      // Network listener also caps bodies; this protects the directly tested handler.
      const reader = request.body?.getReader();
      if (!reader) throw new AppError('JSON_REQUIRED', 400);
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 131072) { await reader.cancel(); throw new AppError('BODY_TOO_LARGE', 413); }
        chunks.push(value);
      }
      let input: unknown;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new AppError('INVALID_JSON'); }
      switch (url.pathname) {
        case '/v1/put': return response(await store.put(actor, putSchema.parse(input)));
        case '/v1/search': return response(await store.search(actor, searchSchema.parse(input)));
        case '/v1/get': { const args = getSchema.parse(input); return response(await store.get(actor, args.project, args.ids)); }
        case '/v1/timeline': { const args = timelineSchema.parse(input); return response(await store.timeline(actor, args.project, args.anchor, args.depth)); }
        case '/v1/forget': return response(await store.forget(actor, forgetSchema.parse(input)));
        default: throw new AppError('NOT_FOUND', 404);
      }
    } catch (error) {
      if (error instanceof z.ZodError) return response({ error: { code: 'INVALID_INPUT' } }, 400);
      if (error instanceof AppError) return response({ error: { code: error.code } }, error.status);
      console.error('membridge: request failed (details withheld)');
      return response({ error: { code: 'INTERNAL_ERROR' } }, 500);
    }
  };
}

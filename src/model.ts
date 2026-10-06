import { z } from 'zod';

export const projectSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
export const identitySchema = z.object({ namespace: projectSchema, agent: projectSchema, access: z.enum(['ro', 'rw']).optional() });
export const draftSchema = z.object({
  id: z.uuid().optional(), project: projectSchema,
  title: z.string().trim().min(1).max(240), body: z.string().trim().min(1).max(16000),
  kind: z.enum(['decision', 'discovery', 'bugfix', 'summary', 'preference']),
  sources: z.array(z.string().trim().min(1).max(1000)).min(1).max(20),
  evidenceDate: z.iso.date().optional(), expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
}).strict();
export const memoryInputSchema = draftSchema.extend({ id: z.uuid() });
export const putSchema = z.object({ operationId: z.uuid(), memory: memoryInputSchema, expectedVersion: z.number().int().min(0) }).strict();
export const searchSchema = z.object({ project: projectSchema, query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(30).default(10) }).strict();
export const recentSchema = z.object({ project: projectSchema, kind: draftSchema.shape.kind.optional(), limit: z.number().int().min(1).max(30).default(10) }).strict();
export const getSchema = z.object({ project: projectSchema, ids: z.array(z.uuid()).min(1).max(20) }).strict();
export const timelineSchema = z.object({ project: projectSchema, anchor: z.uuid(), depth: z.number().int().min(1).max(10).default(3) }).strict();
export const forgetSchema = z.object({ operationId: z.uuid(), project: projectSchema, id: z.uuid(), expectedVersion: z.number().int().min(1) }).strict();
export type MemoryInput = z.infer<typeof memoryInputSchema>;
export type Memory = MemoryInput & { version: number; agent: string; createdAt: number; updatedAt: number };
export type IndexEntry = Omit<Memory, 'body' | 'sources'>;
export type Principal = { namespace: string; agent: string; projects: string[]; access?: 'ro' | 'rw' };
export type Put = z.infer<typeof putSchema>;
export type Forget = z.infer<typeof forgetSchema>;
export type Search = z.infer<typeof searchSchema>;
export type Recent = z.infer<typeof recentSchema>;
export class AppError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}
export function authorize(actor: Principal, project: string) {
  if (!actor.projects.includes(project)) throw new AppError('FORBIDDEN', 403);
}
export function authorizeWrite(actor: Principal, project: string) {
  authorize(actor, project);
  if (actor.access === 'ro') throw new AppError('READ_ONLY_CREDENTIAL', 403);
}

// Adapted from Claude-Mem src/utils/redaction.ts at 2d68c355 (Apache-2.0).
// Always on in MemBridge; private blocks are excluded before any local write.
export function redact(value: string): string {
  return value
    .replace(/<private\b[^>]*>[\s\S]*?(?:<\/private\s*>|$)/gi, '[private_omitted]')
    .replace(/-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g, '[redacted]')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*:[^\s@]*@/gi, '$1[redacted]@')
    .replace(/\bAKID[A-Za-z0-9]{16,}\b/g, '[redacted]')
    .replace(/\bLTAI[A-Za-z0-9]{12,}\b/g, '[redacted]')
    .replace(/(["']?authorization["']?\s*[:=]\s*["']?)(?:Bearer|Basic|Token)\s+[^\s"',;}]+/gi, '$1[redacted]')
    .replace(/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{20,}|gh[oprs]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|cmem_[A-Za-z0-9_-]{32,}|cm_pro_[A-Za-z0-9_-]{8,})\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/((?:["']?)(?:password|passwd|api[_-]?key|secret(?:[_-]?key)?|private[_-]?key|(?:access[_-]?)?token|authorization)(?:["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[redacted]');
}
export function createMemory(input: z.input<typeof draftSchema>): MemoryInput {
  const parsed = draftSchema.parse(input);
  return { ...parsed, id: parsed.id ?? crypto.randomUUID(), title: redact(parsed.title), body: redact(parsed.body), sources: parsed.sources.map(redact) };
}
export function index(memory: Memory): IndexEntry {
  const { body, sources, ...entry } = memory;
  return entry;
}
export function active(memory: Memory, now = Date.now()): boolean {
  return !memory.expiresAt || Date.parse(memory.expiresAt) > now;
}

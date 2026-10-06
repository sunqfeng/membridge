import { Database } from 'bun:sqlite';
import { cacheIdentity, legacyIdentity, secureCache } from './cache';
import { AppError, active, createMemory, index, type Memory, type IndexEntry, type Search, type Put, type Forget, type draftSchema } from './model';
import type { z } from 'zod';

type Options = { url?: string; token?: string; namespace?: string; agent: string; migrateLegacy?: boolean; ttlMs?: number; fetch?: typeof fetch; now?: () => number };
type QueueRow = { operation_id: string; project: string; memory_id: string; kind: 'put' | 'forget'; payload: string; status: string };
type Cached = { payload: string; fetched_at: number; pending: number };
type SearchReply = { results: IndexEntry[]; source: 'local' | 'cloud'; cloudStatus: 'fresh' | 'not_checked' | 'unavailable' | 'not_configured'; freshness: 'fresh' | 'stale'; pendingIds: string[] };

export class LocalClient {
  private db: Database;
  private requestFetch: typeof fetch;
  private now: () => number;
  private ttlMs: number;
  private syncing?: Promise<ReturnType<LocalClient['status']>>;
  private syncRequested = false;
  private retryFailedRequested = false;
  private verified = false;
  constructor(path: string, private options: Options) {
    secureCache(path);
    this.db = new Database(path);
    this.db.run('PRAGMA busy_timeout=5000');
    this.db.run('PRAGMA journal_mode=WAL');
    this.db.run('CREATE TABLE IF NOT EXISTS profile (id INTEGER PRIMARY KEY, identity TEXT NOT NULL)');
    this.db.run('CREATE TABLE IF NOT EXISTS cache (project TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, fetched_at INTEGER NOT NULL, pending INTEGER NOT NULL, PRIMARY KEY(project,id))');
    this.db.run('CREATE TABLE IF NOT EXISTS snapshots (project TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY(project,key))');
    this.db.run('CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE, project TEXT NOT NULL, memory_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT \'pending\')');
    const identity = cacheIdentity(options.url, options.namespace ?? 'owner', options.agent);
    const previous = this.db.query('SELECT identity FROM profile WHERE id=1').get() as { identity: string } | null;
    const oldIdentity = legacyIdentity(options.url, options.token, options.agent);
    if (previous && previous.identity !== identity && previous.identity !== oldIdentity && !options.migrateLegacy) { this.db.close(); throw new AppError('CACHE_IDENTITY_MISMATCH_USE_EXPLICIT_LEGACY_IMPORT'); }
    if (previous && previous.identity !== identity) this.db.query('UPDATE profile SET identity=? WHERE id=1').run(identity);
    this.db.query('INSERT OR IGNORE INTO profile(id,identity) VALUES(1,?)').run(identity);
    this.db.run('CREATE TABLE IF NOT EXISTS credentials (id INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL)');
    const credential = this.db.query('SELECT fingerprint FROM credentials WHERE id=1').get() as { fingerprint: string } | null;
    if (credential?.fingerprint !== oldIdentity) {
      // Keep unsent work, but never serve synced data cached under previous credentials.
      this.db.run('DELETE FROM cache WHERE pending=0'); this.db.run('DELETE FROM snapshots');
      this.db.run("UPDATE outbox SET status='pending' WHERE status='blocked'");
      this.db.query('INSERT INTO credentials(id,fingerprint) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint').run(oldIdentity);
    }
    secureCache(path);
    this.ttlMs = options.ttlMs ?? 60000;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs < 0 || this.ttlMs > 3600000) { this.db.close(); throw new AppError('INVALID_CACHE_TTL'); }
    this.requestFetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }
  private configured() { return !!this.options.url && !!this.options.token; }
  private async verifyIdentity() {
    if (this.verified || !this.configured()) return;
    const identity = await this.call<{ namespace: string; agent: string }>('identity', {});
    if (identity.namespace !== (this.options.namespace ?? 'owner') || identity.agent !== this.options.agent) throw new AppError('CLOUD_IDENTITY_MISMATCH', 403);
    this.verified = true;
  }
  private prune() {
    this.db.query('DELETE FROM cache WHERE pending=0 AND fetched_at<?').run(this.now() - 30 * 86400000);
    this.db.run('DELETE FROM cache WHERE pending=0 AND rowid NOT IN (SELECT rowid FROM cache WHERE pending=0 ORDER BY fetched_at DESC LIMIT 1000)');
    this.db.query('DELETE FROM snapshots WHERE fetched_at<?').run(this.now() - 86400000);
    this.db.run('DELETE FROM snapshots WHERE rowid NOT IN (SELECT rowid FROM snapshots ORDER BY fetched_at DESC LIMIT 500)');
  }
  private async call<T>(path: string, payload: unknown): Promise<T> {
    if (!this.configured()) throw new AppError('CLOUD_NOT_CONFIGURED', 503);
    let response: Response;
    try {
      response = await this.requestFetch(this.options.url!.replace(/\/$/, '') + '/v1/' + path, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { authorization: 'Bearer ' + this.options.token, 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
    } catch { throw new AppError('CLOUD_UNAVAILABLE', 503); }
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: { code?: string } } | null;
      throw new AppError(body?.error?.code ?? 'CLOUD_ERROR', response.status);
    }
    return response.json() as Promise<T>;
  }
  private local(project: string, id: string) { return this.db.query('SELECT payload,fetched_at,pending FROM cache WHERE project=? AND id=?').get(project, id) as Cached | null; }
  private cachedPut(memory: Memory, pending: boolean) {
    this.db.query('INSERT INTO cache(project,id,payload,fetched_at,pending) VALUES(?,?,?,?,?) ON CONFLICT(project,id) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at,pending=excluded.pending WHERE cache.pending=0 OR excluded.pending=1')
      .run(memory.project, memory.id, JSON.stringify(memory), this.now(), Number(pending));
    this.prune();
  }
  private clearSnapshots(project: string) { this.db.query('DELETE FROM snapshots WHERE project=?').run(project); }
  private unresolved(project: string, id: string) { return !!this.db.query('SELECT operation_id FROM outbox WHERE project=? AND memory_id=? LIMIT 1').get(project, id); }
  async remember(input: z.input<typeof draftSchema>, expectedVersion = 0) {
    const draft = createMemory(input);
    if (this.unresolved(draft.project, draft.id)) throw new AppError('PENDING_WRITE_EXISTS', 409);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new AppError('INVALID_VERSION');
    const old = this.local(draft.project, draft.id);
    const now = this.now();
    const memory: Memory = { ...draft, version: expectedVersion, agent: this.options.agent, createdAt: old ? (JSON.parse(old.payload) as Memory).createdAt : now, updatedAt: now };
    const operation: Put = { operationId: crypto.randomUUID(), memory: draft, expectedVersion };
    this.db.transaction(() => {
      this.cachedPut(memory, true);
      this.db.query('INSERT INTO outbox(operation_id,project,memory_id,kind,payload) VALUES(?,?,?,?,?)').run(operation.operationId, draft.project, draft.id, 'put', JSON.stringify(operation));
      this.clearSnapshots(draft.project);
    })();
    await this.sync();
    const row = this.local(draft.project, draft.id);
    return { memory: row ? JSON.parse(row.payload) as Memory : null, syncStatus: this.syncStatus(draft.project, draft.id) };
  }
  private syncStatus(project: string, id: string) {
    const row = this.db.query('SELECT status FROM outbox WHERE project=? AND memory_id=?').get(project, id) as { status: string } | null;
    return row?.status ?? 'synced';
  }
  async forget(project: string, id: string, expectedVersion: number) {
    if (this.unresolved(project, id)) throw new AppError('PENDING_WRITE_EXISTS', 409);
    const operation: Forget = { operationId: crypto.randomUUID(), project, id, expectedVersion };
    this.db.transaction(() => {
      this.db.query('DELETE FROM cache WHERE project=? AND id=?').run(project, id);
      this.clearSnapshots(project);
      this.db.query('INSERT INTO outbox(operation_id,project,memory_id,kind,payload) VALUES(?,?,?,?,?)').run(operation.operationId, project, id, 'forget', JSON.stringify(operation));
    })();
    await this.sync();
    return { id, syncStatus: this.syncStatus(project, id) };
  }
  sync(options: { retryFailed?: boolean } = {}): Promise<ReturnType<LocalClient['status']>> {
    this.syncRequested = true;
    this.retryFailedRequested ||= options.retryFailed ?? false;
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      do {
        this.syncRequested = false;
        if (this.retryFailedRequested) {
          this.db.run("UPDATE outbox SET status='pending' WHERE status IN ('blocked','rejected')");
          this.retryFailedRequested = false; this.verified = false;
        }
        await this.drain();
      } while (this.syncRequested);
      return this.status();
    })().finally(() => { this.syncing = undefined; });
    return this.syncing;
  }
  private async drain() {
    if (!this.configured()) return this.status();
    const rows = this.db.query("SELECT * FROM outbox WHERE status='pending' ORDER BY seq LIMIT 50").all() as QueueRow[];
    for (const row of rows) {
      try {
        await this.verifyIdentity();
        const result = await this.call<Memory | { deleted: true }>(row.kind, JSON.parse(row.payload));
        this.db.transaction(() => {
          this.db.query('DELETE FROM outbox WHERE operation_id=?').run(row.operation_id);
          this.db.query('DELETE FROM cache WHERE project=? AND id=?').run(row.project, row.memory_id);
          if (row.kind === 'put' && !('deleted' in result)) this.cachedPut(result, false);
          this.clearSnapshots(row.project);
        })();
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        if (error.status === 410) {
          this.db.transaction(() => {
            this.db.query('DELETE FROM outbox WHERE operation_id=?').run(row.operation_id);
            this.db.query('DELETE FROM cache WHERE project=? AND id=?').run(row.project, row.memory_id);
            this.clearSnapshots(row.project);
          })();
        } else if (error.status === 409) {
          this.db.query("UPDATE outbox SET status='conflict' WHERE operation_id=?").run(row.operation_id);
        } else if (error.status === 401 || error.status === 403) {
          this.db.query("UPDATE outbox SET status='blocked' WHERE operation_id=?").run(row.operation_id);
        } else if (error.status >= 400 && error.status < 500 && ![408, 425, 429].includes(error.status)) {
          this.db.query("UPDATE outbox SET status='rejected' WHERE operation_id=?").run(row.operation_id);
        } else break;
      }
    }
    return this.status();
  }
  private overlays(project: string) {
    const rows = this.db.query('SELECT * FROM outbox WHERE project=?').all(project) as QueueRow[];
    const pending = rows.filter(row => row.kind === 'put').map(row => this.local(project, row.memory_id)).filter((row): row is Cached => !!row).map(row => JSON.parse(row.payload) as Memory);
    return { pending, hidden: new Set(rows.map(row => row.memory_id)), pendingIds: rows.map(row => row.memory_id) };
  }
  private offline(error: unknown) {
    if (!(error instanceof AppError) || error.status < 500 && ![408, 425, 429].includes(error.status)) throw error;
  }
  async search(request: Search, refresh = false): Promise<SearchReply> {
    const key = JSON.stringify([request.query, request.limit]);
    const snapshot = this.db.query('SELECT payload,fetched_at FROM snapshots WHERE project=? AND key=?').get(request.project, key) as { payload: string; fetched_at: number } | null;
    let results = snapshot ? JSON.parse(snapshot.payload) as IndexEntry[] : [];
    let source: SearchReply['source'] = 'local';
    let cloudStatus: SearchReply['cloudStatus'] = 'not_checked';
    let fresh = !!snapshot && this.now() - snapshot.fetched_at < this.ttlMs;
    if (refresh || !fresh || results.length === 0) {
      try {
        await this.verifyIdentity();
        results = await this.call<IndexEntry[]>('search', request);
        this.db.query('INSERT INTO snapshots(project,key,payload,fetched_at) VALUES(?,?,?,?) ON CONFLICT(project,key) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at').run(request.project, key, JSON.stringify(results), this.now());
        source = 'cloud'; cloudStatus = 'fresh'; fresh = true;
        this.prune();
      } catch (error) { this.offline(error); cloudStatus = this.configured() ? 'unavailable' : 'not_configured'; }
    }
    const overlay = this.overlays(request.project);
    const query = request.query.toLocaleLowerCase();
    const local = overlay.pending.filter(memory => active(memory, this.now()) && (memory.title + '\n' + memory.body).toLocaleLowerCase().includes(query)).map(index);
    results = [...local, ...results.filter(memory => !overlay.hidden.has(memory.id) && active(memory as Memory, this.now()))].slice(0, request.limit);
    return { results, source, cloudStatus, freshness: fresh ? 'fresh' : 'stale', pendingIds: overlay.pendingIds };
  }
  async get(project: string, ids: string[], refresh = false) {
    const overlay = this.overlays(project);
    const results: Memory[] = [];
    const needed: string[] = [];
    let cloudStatus = 'not_checked';
    for (const id of ids) {
      const row = this.local(project, id);
      if (overlay.hidden.has(id)) { if (row && active(JSON.parse(row.payload) as Memory, this.now())) results.push(JSON.parse(row.payload)); continue; }
      if (row && !refresh && this.now() - row.fetched_at < this.ttlMs && active(JSON.parse(row.payload) as Memory, this.now())) results.push(JSON.parse(row.payload));
      else needed.push(id);
    }
    if (needed.length) {
      try {
        await this.verifyIdentity();
        const remote = await this.call<Memory[]>('get', { project, ids: needed });
        this.db.transaction(() => {
          needed.forEach(id => this.db.query('DELETE FROM cache WHERE project=? AND id=? AND pending=0').run(project, id));
          remote.forEach(memory => this.cachedPut(memory, false));
          this.clearSnapshots(project);
        })();
        results.push(...remote); cloudStatus = 'fresh';
      } catch (error) {
        this.offline(error); cloudStatus = this.configured() ? 'unavailable' : 'not_configured';
        needed.forEach(id => { const row = this.local(project, id); if (row) { const memory = JSON.parse(row.payload) as Memory; if (active(memory, this.now())) results.push(memory); } });
      }
    }
    return { results, cloudStatus, pendingIds: overlay.pendingIds, freshness: ['unavailable', 'not_configured'].includes(cloudStatus) ? 'stale' : 'fresh' };
  }
  async timeline(project: string, anchor: string, depth: number) {
    // Timeline is always cloud refreshed, preventing a partial cache from pretending to be complete.
    await this.verifyIdentity();
    return { results: await this.call<IndexEntry[]>('timeline', { project, anchor, depth }), source: 'cloud' };
  }
  discardPending(project: string, id: string) {
    this.db.transaction(() => {
      this.db.query('DELETE FROM outbox WHERE project=? AND memory_id=?').run(project, id);
      this.db.query('DELETE FROM cache WHERE project=? AND id=?').run(project, id);
      this.clearSnapshots(project);
    })();
    return this.status();
  }
  status() {
    const rows = this.db.query('SELECT project,memory_id,status,kind FROM outbox ORDER BY seq').all() as { project: string; memory_id: string; status: string; kind: string }[];
    return { configured: this.configured(), pending: rows.filter(row => row.status === 'pending').length, conflicts: rows.filter(row => row.status === 'conflict').length, blocked: rows.filter(row => ['blocked', 'rejected'].includes(row.status)).length, operations: rows };
  }
  close() { this.db.close(); }
}

import { Database } from 'bun:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { cacheIdentity, legacyIdentity, secureCache } from './cache';
import { AppError, active, createMemory, index, identitySchema, type Memory, type IndexEntry, type Search, type Recent, type Put, type Forget, type draftSchema } from './model';
import type { z } from 'zod';

type Options = { url?: string; token?: string; namespace?: string; agent: string; migrateLegacy?: boolean; ttlMs?: number; fetch?: typeof fetch; now?: () => number; identityUnavailable?: boolean };
type QueueRow = { operation_id: string; project: string; memory_id: string; kind: 'put' | 'forget'; payload: string; status: string };
type Cached = { payload: string; fetched_at: number; pending: number };
type SearchReply = { results: IndexEntry[]; source: 'local' | 'cloud'; cloudStatus: 'fresh' | 'not_checked' | 'unavailable' | 'not_configured'; freshness: 'fresh' | 'stale'; pendingIds: string[] };
type ClientStatus = { configured: boolean; namespace: string | null; access: 'ro' | 'rw' | 'unknown'; pending: number; conflicts: number; blocked: number; operations: { project: string; memory_id: string; status: string; kind: string }[] };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export class LocalClient {
  private db: Database;
  private requestFetch: typeof fetch;
  private now: () => number;
  private ttlMs: number;
  private syncing?: Promise<ReturnType<LocalClient['status']>>;
  private syncRequested = false;
  private retryFailedRequested = false;
  private verified = false;
  private verifying?: Promise<void>;
  private identityFailure?: { error: AppError; until: number };
  private closedStatus?: ClientStatus;
  private syncBackoffUntil = 0;
  private requests = new Set<AbortController>();
  private currentNamespace: string;
  private namespaceBound: boolean;
  private access: 'ro' | 'rw' | 'unknown' = 'unknown';
  constructor(path: string, private options: Options) {
    secureCache(path);
    this.db = new Database(path);
    this.db.run('PRAGMA busy_timeout=5000');
    this.db.run('PRAGMA journal_mode=WAL');
    this.db.run('CREATE TABLE IF NOT EXISTS profile (id INTEGER PRIMARY KEY, identity TEXT NOT NULL)');
    this.db.run('CREATE TABLE IF NOT EXISTS cache (project TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, fetched_at INTEGER NOT NULL, pending INTEGER NOT NULL, PRIMARY KEY(project,id))');
    this.db.run('CREATE TABLE IF NOT EXISTS snapshots (project TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY(project,key))');
    this.db.run('CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE, project TEXT NOT NULL, memory_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT \'pending\')');
    this.db.run('CREATE TABLE IF NOT EXISTS rebase_previews (operation_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, cloud_hash TEXT NOT NULL, local_hash TEXT NOT NULL, expires_at INTEGER NOT NULL)');
    this.db.run('CREATE TABLE IF NOT EXISTS cloud_identity (id INTEGER PRIMARY KEY, namespace TEXT NOT NULL, access TEXT)');
    const binding = this.db.query('SELECT namespace,access FROM cloud_identity WHERE id=1').get() as { namespace: string; access: 'ro' | 'rw' | null } | null;
    this.currentNamespace = options.namespace ?? binding?.namespace ?? 'owner';
    this.namespaceBound = options.namespace !== undefined || Boolean(binding);
    const identity = cacheIdentity(options.url, this.currentNamespace, options.agent);
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
      this.db.run('DELETE FROM rebase_previews'); this.db.run('UPDATE cloud_identity SET access=NULL');
      this.db.run("UPDATE outbox SET status='pending' WHERE status='blocked'");
      this.db.query('INSERT INTO credentials(id,fingerprint) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint').run(oldIdentity);
    }
    if (credential?.fingerprint === oldIdentity && binding?.access) this.access = binding.access;
    if (options.url && !this.namespaceBound) { this.db.run('DELETE FROM cache WHERE pending=0'); this.db.run('DELETE FROM snapshots'); }
    secureCache(path);
    this.ttlMs = options.ttlMs ?? 60000;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs < 0 || this.ttlMs > 3600000) { this.db.close(); throw new AppError('INVALID_CACHE_TTL'); }
    this.requestFetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    if (options.identityUnavailable) this.identityFailure = { error: new AppError('CLOUD_UNAVAILABLE', 503), until: this.now() + 5000 };
  }
  private configured() { return !!this.options.url && !!this.options.token; }
  private async verifyIdentity() {
    if (this.verified || !this.configured()) return;
    if (this.verifying) return this.verifying;
    if (this.identityFailure && this.now() < this.identityFailure.until) throw this.identityFailure.error;
    this.verifying = this.bindIdentity().catch(error => {
      if (error instanceof AppError && (error.status >= 500 || [408, 425, 429].includes(error.status))) {
        this.identityFailure = { error, until: this.now() + 5000 };
      }
      throw error;
    }).finally(() => { this.verifying = undefined; });
    return this.verifying;
  }
  private async bindIdentity() {
    const identity = identitySchema.parse(await this.call<unknown>('identity', {}));
    if (this.closedStatus) throw new AppError('CLIENT_CLOSED', 503);
    if ((this.namespaceBound && identity.namespace !== this.currentNamespace) || identity.agent !== this.options.agent) throw new AppError('CLOUD_IDENTITY_MISMATCH', 403);
    this.db.transaction(() => {
      if (identity.namespace !== this.currentNamespace) {
        this.db.run('DELETE FROM cache WHERE pending=0'); this.db.run('DELETE FROM snapshots');
        this.db.run("UPDATE outbox SET status='pending' WHERE status='blocked'");
      }
      this.db.query('UPDATE profile SET identity=? WHERE id=1').run(cacheIdentity(this.options.url, identity.namespace, this.options.agent));
      this.db.query('INSERT OR REPLACE INTO cloud_identity VALUES(1,?,?)').run(identity.namespace, identity.access ?? null);
    })();
    this.currentNamespace = identity.namespace; this.namespaceBound = true; this.access = identity.access ?? 'unknown';
    this.verified = true;
    this.identityFailure = undefined;
  }
  private async checkWritable() {
    try { await this.verifyIdentity(); } catch (error) { this.offline(error); }
    if (this.access === 'ro') throw new AppError('READ_ONLY_CREDENTIAL', 403);
    if (this.configured() && this.verified && this.access === 'unknown') throw new AppError('SERVER_ACCESS_UNAVAILABLE', 503);
  }
  private prune() {
    this.db.query('DELETE FROM cache WHERE pending=0 AND fetched_at<?').run(this.now() - 30 * 86400000);
    this.db.run('DELETE FROM cache WHERE pending=0 AND rowid NOT IN (SELECT rowid FROM cache WHERE pending=0 ORDER BY fetched_at DESC LIMIT 1000)');
    this.db.query('DELETE FROM snapshots WHERE fetched_at<?').run(this.now() - 86400000);
    this.db.run('DELETE FROM snapshots WHERE rowid NOT IN (SELECT rowid FROM snapshots ORDER BY fetched_at DESC LIMIT 500)');
  }
  private async call<T>(path: string, payload: unknown): Promise<T> {
    if (this.closedStatus) throw new AppError('CLIENT_CLOSED', 503);
    if (!this.configured()) throw new AppError('CLOUD_NOT_CONFIGURED', 503);
    const controller = new AbortController();
    this.requests.add(controller);
    try {
      let response: Response;
      try {
        response = await this.requestFetch(this.options.url!.replace(/\/$/, '') + '/v1/' + path, {
          method: 'POST', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
          headers: { authorization: 'Bearer ' + this.options.token, 'content-type': 'application/json' }, body: JSON.stringify(payload),
        });
      } catch { throw new AppError('CLOUD_UNAVAILABLE', 503); }
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { code?: string } } | null;
        throw new AppError(body?.error?.code ?? 'CLOUD_ERROR', response.status);
      }
      return await response.json() as T;
    } finally { this.requests.delete(controller); }
  }
  private local(project: string, id: string) { return this.db.query('SELECT payload,fetched_at,pending FROM cache WHERE project=? AND id=?').get(project, id) as Cached | null; }
  private cachedPut(memory: Memory, pending: boolean) {
    this.db.query('INSERT INTO cache(project,id,payload,fetched_at,pending) VALUES(?,?,?,?,?) ON CONFLICT(project,id) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at,pending=excluded.pending WHERE cache.pending=0 OR excluded.pending=1')
      .run(memory.project, memory.id, JSON.stringify(memory), this.now(), Number(pending));
  }
  private clearSnapshots(project: string) { this.db.query('DELETE FROM snapshots WHERE project=?').run(project); }
  private unresolved(project: string, id: string) { return !!this.db.query('SELECT operation_id FROM outbox WHERE project=? AND memory_id=? LIMIT 1').get(project, id); }
  async remember(input: z.input<typeof draftSchema>, expectedVersion = 0) {
    const draft = createMemory(input);
    await this.checkWritable();
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
      this.prune();
    })();
    await this.syncWithBudget({ retryIdentity: false });
    const row = this.local(draft.project, draft.id);
    return { memory: row ? JSON.parse(row.payload) as Memory : null, syncStatus: this.syncStatus(draft.project, draft.id), access: this.access };
  }
  private syncStatus(project: string, id: string) {
    const row = this.db.query('SELECT status FROM outbox WHERE project=? AND memory_id=?').get(project, id) as { status: string } | null;
    return row?.status ?? 'synced';
  }
  async forget(project: string, id: string, expectedVersion: number) {
    await this.checkWritable();
    if (this.unresolved(project, id)) throw new AppError('PENDING_WRITE_EXISTS', 409);
    const operation: Forget = { operationId: crypto.randomUUID(), project, id, expectedVersion };
    this.db.transaction(() => {
      this.db.query('DELETE FROM cache WHERE project=? AND id=?').run(project, id);
      this.clearSnapshots(project);
      this.db.query('INSERT INTO outbox(operation_id,project,memory_id,kind,payload) VALUES(?,?,?,?,?)').run(operation.operationId, project, id, 'forget', JSON.stringify(operation));
    })();
    await this.syncWithBudget({ retryIdentity: false });
    return { id, syncStatus: this.syncStatus(project, id) };
  }
  sync(options: { retryFailed?: boolean; retryIdentity?: boolean } = {}): Promise<ReturnType<LocalClient['status']>> {
    if (this.closedStatus) return Promise.resolve(this.closedStatus);
    // Explicit sync can probe recovery immediately; automatic writes share backoff.
    if (options.retryIdentity !== false) { this.identityFailure = undefined; this.syncBackoffUntil = 0; }
    this.syncRequested = true;
    this.retryFailedRequested ||= options.retryFailed ?? false;
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      do {
        this.syncRequested = false;
        if (this.retryFailedRequested) {
          this.db.run("UPDATE outbox SET status='pending' WHERE status IN ('blocked','rejected')");
          this.retryFailedRequested = false; this.verified = false; this.identityFailure = undefined;
        }
        await this.drain();
      } while (this.syncRequested && !this.closedStatus);
      return this.status();
    })().finally(() => { this.syncing = undefined; });
    return this.syncing;
  }
  async syncWithBudget(options: { retryFailed?: boolean; retryIdentity?: boolean } = {}) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.sync(options), new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]);
    } finally { clearTimeout(timer); }
    return this.status();
  }
  private async drain() {
    if (!this.configured() || this.closedStatus || this.now() < this.syncBackoffUntil) return this.status();
    try {
      await this.verifyIdentity();
      if (this.access === 'ro') throw new AppError('READ_ONLY_CREDENTIAL', 403);
      if (this.access === 'unknown') throw new AppError('SERVER_ACCESS_UNAVAILABLE', 503);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      if (!this.closedStatus && [401, 403].includes(error.status)) this.db.run("UPDATE outbox SET status='blocked' WHERE status='pending'");
      return this.status();
    }
    const rows = this.db.query("SELECT * FROM outbox WHERE status='pending' ORDER BY seq LIMIT 50").all() as QueueRow[];
    // Legacy queues can contain duplicate IDs: never schedule those concurrently.
    const seen = new Set<string>();
    const queue = rows.filter(row => { const key = JSON.stringify([row.project, row.memory_id]); if (seen.has(key)) return false; seen.add(key); return true; });
    let next = 0, stopped = false;
    const worker = async () => {
      while (!stopped && !this.closedStatus && next < queue.length) {
        const row = queue[next++];
        // A foreground discard/rebase may have removed this operation meanwhile.
        if (!this.db.query("SELECT 1 FROM outbox WHERE operation_id=? AND status='pending'").get(row.operation_id)) continue;
        try {
          const result = await this.call<Memory | { deleted: true }>(row.kind, JSON.parse(row.payload));
          if (this.closedStatus) return;
          this.db.transaction(() => {
            if (!this.db.query("SELECT 1 FROM outbox WHERE operation_id=? AND status='pending'").get(row.operation_id)) return;
            this.db.query('DELETE FROM outbox WHERE operation_id=?').run(row.operation_id);
            this.db.query('DELETE FROM cache WHERE project=? AND id=?').run(row.project, row.memory_id);
            if (row.kind === 'put' && !('deleted' in result)) this.cachedPut(result, false);
            this.clearSnapshots(row.project);
          })();
        } catch (error) {
          if (this.closedStatus) return;
          if (!(error instanceof AppError)) { stopped = true; throw error; }
          if (error.status === 410) {
            this.db.transaction(() => {
              if (!this.db.query("SELECT 1 FROM outbox WHERE operation_id=? AND status='pending'").get(row.operation_id)) return;
              this.db.query('DELETE FROM outbox WHERE operation_id=?').run(row.operation_id);
              this.db.query('DELETE FROM cache WHERE project=? AND id=?').run(row.project, row.memory_id);
              this.clearSnapshots(row.project);
            })();
          } else if (error.status === 409) {
            this.db.query("UPDATE outbox SET status='conflict' WHERE operation_id=?").run(row.operation_id);
          } else if (error.status === 401 || error.status === 403) {
            this.db.query("UPDATE outbox SET status='blocked' WHERE operation_id=?").run(row.operation_id);
            stopped = true;
          } else if (error.status >= 400 && error.status < 500 && ![408, 425, 429].includes(error.status)) {
            this.db.query("UPDATE outbox SET status='rejected' WHERE operation_id=?").run(row.operation_id);
          } else { stopped = true; this.syncBackoffUntil = this.now() + 5000; }
        }
      }
    };
    // No awaits inside SQLite transactions: worker completions write back serially.
    const settled = await Promise.allSettled(Array.from({ length: Math.min(4, queue.length) }, () => worker()));
    if (!this.closedStatus) this.prune();
    for (const result of settled) if (result.status === 'rejected') throw result.reason;
    return this.status();
  }
  private overlays(project: string) {
    const rows = this.db.query('SELECT o.memory_id,o.kind,c.payload FROM outbox o LEFT JOIN cache c ON c.project=o.project AND c.id=o.memory_id WHERE o.project=?').all(project) as { memory_id: string; kind: string; payload: string | null }[];
    const pending = rows.filter(row => row.kind === 'put' && row.payload !== null).map(row => JSON.parse(row.payload!) as Memory);
    return { pending, hidden: new Set(rows.map(row => row.memory_id)), pendingIds: rows.map(row => row.memory_id) };
  }
  private offline(error: unknown) {
    if (!(error instanceof AppError) || error.status < 500 && ![408, 425, 429].includes(error.status)) throw error;
  }
  async search(request: Search, refresh = false): Promise<SearchReply> {
    const key = JSON.stringify([request.query, request.limit]);
    const query = request.query.toLocaleLowerCase();
    return this.readIndexes('search', request, key, refresh, memory => (memory.title + '\n' + memory.body).toLocaleLowerCase().includes(query));
  }
  async recent(request: Recent, refresh = false): Promise<SearchReply> {
    return this.readIndexes('recent', request, JSON.stringify(['recent', request.kind ?? null, request.limit]), refresh, memory => !request.kind || memory.kind === request.kind);
  }
  private async readIndexes(path: 'search' | 'recent', request: Search | Recent, key: string, refresh: boolean, matches: (memory: Memory) => boolean): Promise<SearchReply> {
    const snapshot = this.db.query('SELECT payload,fetched_at FROM snapshots WHERE project=? AND key=?').get(request.project, key) as { payload: string; fetched_at: number } | null;
    let results = snapshot ? JSON.parse(snapshot.payload) as IndexEntry[] : [];
    let source: SearchReply['source'] = 'local';
    let cloudStatus: SearchReply['cloudStatus'] = 'not_checked';
    let fresh = !!snapshot && this.now() - snapshot.fetched_at < this.ttlMs;
    if (refresh || !fresh) {
      try {
        await this.verifyIdentity();
        results = await this.call<IndexEntry[]>(path, request);
        this.db.query('INSERT INTO snapshots(project,key,payload,fetched_at) VALUES(?,?,?,?) ON CONFLICT(project,key) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at').run(request.project, key, JSON.stringify(results), this.now());
        source = 'cloud'; cloudStatus = 'fresh'; fresh = true;
        this.prune();
      } catch (error) {
        this.offline(error); cloudStatus = this.configured() ? 'unavailable' : 'not_configured'; fresh = false;
        if (path === 'recent') {
          const cached = this.db.query('SELECT payload FROM cache WHERE project=? AND pending=0').all(request.project) as { payload: string }[];
          const known = new Map(results.map(item => [item.id, item]));
          for (const row of cached) {
            const memory = JSON.parse(row.payload) as Memory;
            if (matches(memory) && (!known.has(memory.id) || known.get(memory.id)!.version < memory.version)) known.set(memory.id, index(memory));
          }
          results = [...known.values()];
        }
      }
    }
    const overlay = this.overlays(request.project);
    const local = overlay.pending.filter(memory => active(memory, this.now()) && matches(memory)).map(index);
    results = [...local, ...results.filter(memory => !overlay.hidden.has(memory.id) && active(memory as Memory, this.now()))];
    if (path === 'recent') results.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    results = results.slice(0, request.limit);
    return { results, source, cloudStatus, freshness: fresh ? 'fresh' : 'stale', pendingIds: overlay.pendingIds };
  }
  async get(project: string, ids: string[], refresh = false) {
    const overlay = this.overlays(project);
    const results: Memory[] = [];
    const needed: string[] = [];
    let cloudStatus = 'not_checked';
    for (const id of ids) {
      const row = this.local(project, id);
      const memory = row ? JSON.parse(row.payload) as Memory : null;
      if (overlay.hidden.has(id)) { if (memory && active(memory, this.now())) results.push(memory); continue; }
      if (row && memory && !refresh && this.now() - row.fetched_at < this.ttlMs && active(memory, this.now())) results.push(memory);
      else needed.push(id);
    }
    if (needed.length) {
      try {
        await this.verifyIdentity();
        const remote = await this.call<Memory[]>('get', { project, ids: needed });
        this.db.transaction(() => {
          needed.forEach(id => this.db.query('DELETE FROM cache WHERE project=? AND id=? AND pending=0').run(project, id));
          remote.forEach(memory => this.cachedPut(memory, false));
          this.prune();
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
  async rebasePending(project: string, id: string, confirmVersion?: number, confirmToken?: string) {
    if ((confirmVersion === undefined) !== (confirmToken === undefined)) throw new AppError('PREVIEW_CONFIRMATION_REQUIRED');
    const row = this.db.query("SELECT * FROM outbox WHERE project=? AND memory_id=? AND kind='put' AND status='conflict'").get(project, id) as QueueRow | null;
    const cached = this.local(project, id);
    if (!row || !cached) throw new AppError('CONFLICTED_PUT_REQUIRED', 409);
    const localMemory = JSON.parse(cached.payload) as Memory;
    const preview = this.db.query('SELECT * FROM rebase_previews WHERE operation_id=?').get(row.operation_id) as { token_hash: string; cloud_hash: string; local_hash: string; expires_at: number } | null;
    if (confirmToken !== undefined && (!preview || preview.token_hash !== digest(confirmToken) || preview.expires_at < this.now() || preview.local_hash !== digest(row.payload))) throw new AppError('INVALID_OR_EXPIRED_CONFIRM_TOKEN', 409);
    await this.verifyIdentity();
    // Bypass get()'s local overlay: review the actual cloud revision.
    const cloudMemory = (await this.call<Memory[]>('get', { project, ids: [id] }))[0];
    if (!cloudMemory) throw new AppError('CLOUD_MEMORY_NOT_FOUND_OR_EXPIRED', 404);
    if (confirmVersion === undefined) {
      const token = randomBytes(32).toString('hex');
      this.db.query('DELETE FROM rebase_previews WHERE expires_at<? OR operation_id NOT IN (SELECT operation_id FROM outbox)').run(this.now());
      this.db.query('INSERT OR REPLACE INTO rebase_previews VALUES(?,?,?,?,?)').run(row.operation_id, digest(token), digest(JSON.stringify(cloudMemory)), digest(row.payload), this.now() + 600000);
      return { localMemory, cloudMemory, expectedVersion: cloudMemory.version, confirmToken: token, requiresConfirmation: true };
    }
    if (confirmVersion !== cloudMemory.version || preview!.cloud_hash !== digest(JSON.stringify(cloudMemory))) throw new AppError('CLOUD_VERSION_CHANGED', 409);
    await this.checkWritable();
    const operation = { ...JSON.parse(row.payload) as Put, expectedVersion: cloudMemory.version, operationId: crypto.randomUUID() };
    this.db.transaction(() => {
      const current = this.db.query('SELECT status FROM outbox WHERE operation_id=?').get(row.operation_id) as { status: string } | null;
      if (current?.status !== 'conflict') throw new AppError('PENDING_OPERATION_CHANGED', 409);
      this.db.query('DELETE FROM rebase_previews WHERE operation_id=?').run(row.operation_id);
      this.db.query("UPDATE outbox SET operation_id=?,payload=?,status='pending' WHERE operation_id=?").run(operation.operationId, JSON.stringify(operation), row.operation_id);
      this.cachedPut({ ...localMemory, version: cloudMemory.version, createdAt: cloudMemory.createdAt, updatedAt: this.now() }, true);
      this.clearSnapshots(project);
      this.prune();
    })();
    await this.syncWithBudget();
    return { localMemory: JSON.parse(this.local(project, id)?.payload ?? JSON.stringify(localMemory)) as Memory, cloudMemory, expectedVersion: cloudMemory.version, requiresConfirmation: false, syncStatus: this.syncStatus(project, id) };
  }
  discardPending(project: string, id: string) {
    this.db.transaction(() => {
      this.db.query('DELETE FROM rebase_previews WHERE operation_id IN (SELECT operation_id FROM outbox WHERE project=? AND memory_id=?)').run(project, id);
      this.db.query('DELETE FROM outbox WHERE project=? AND memory_id=?').run(project, id);
      this.db.query('DELETE FROM cache WHERE project=? AND id=?').run(project, id);
      this.clearSnapshots(project);
    })();
    return this.status();
  }
  status(): ClientStatus {
    if (this.closedStatus) return this.closedStatus;
    const rows = this.db.query('SELECT project,memory_id,status,kind FROM outbox ORDER BY seq').all() as { project: string; memory_id: string; status: string; kind: string }[];
    return { configured: this.configured(), namespace: this.namespaceBound || !this.configured() ? this.currentNamespace : null, access: this.access, pending: rows.filter(row => row.status === 'pending').length, conflicts: rows.filter(row => row.status === 'conflict').length, blocked: rows.filter(row => ['blocked', 'rejected'].includes(row.status)).length, operations: rows };
  }
  close() {
    if (this.closedStatus) return;
    this.closedStatus = this.status();
    for (const controller of this.requests) controller.abort();
    this.db.close();
  }
}

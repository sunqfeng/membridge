import { createHash } from 'node:crypto';
import { type SqlDatabase, type SqlConnection } from './database';
import { AppError, active, authorize, authorizeWrite, createMemory, index, type Principal, type Memory, type Put, type Forget, type Search } from './model';

export class MemoryStore {
  constructor(private db: SqlDatabase) {}
  private async scopeLock(conn: SqlConnection, actor: Principal, project: string) {
    const insert = this.db.dialect === 'mysql' ? 'INSERT IGNORE' : 'INSERT OR IGNORE';
    await conn.run(`${insert} INTO mb_scopes(namespace, project) VALUES (?, ?)`, [actor.namespace, project]);
    await conn.rows(`SELECT project FROM mb_scopes WHERE namespace=? AND project=?${this.db.dialect === 'mysql' ? ' FOR UPDATE' : ''}`, [actor.namespace, project]);
  }
  private async operation<T>(actor: Principal, project: string, memoryId: string, operationId: string, request: unknown, apply: (conn: SqlConnection) => Promise<T>): Promise<T> {
    authorizeWrite(actor, project);
    const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    return this.db.transaction(async conn => {
      await this.scopeLock(conn, actor, project);
      const old = await conn.rows('SELECT request_hash, result FROM mb_operations WHERE namespace=? AND agent=? AND id=?', [actor.namespace, actor.agent, operationId]);
      if (old[0]) {
        if (old[0].request_hash !== hash) throw new AppError('IDEMPOTENCY_CONFLICT', 409);
        const result = JSON.parse(String(old[0].result));
        if (result.deleted && typeof request === 'object' && request !== null && 'memory' in request) throw new AppError('MEMORY_DELETED', 410);
        return result as T;
      }
      const result = await apply(conn);
      await conn.run('INSERT INTO mb_operations(namespace, agent, id, project, memory_id, request_hash, result) VALUES (?, ?, ?, ?, ?, ?, ?)', [actor.namespace, actor.agent, operationId, project, memoryId, hash, JSON.stringify(result)]);
      return result;
    });
  }
  async put(actor: Principal, request: Put): Promise<Memory> {
    const draft = createMemory(request.memory);
    return this.operation(actor, draft.project, draft.id, request.operationId, { ...request, memory: draft }, async conn => {
      const old = (await conn.rows('SELECT version, deleted, payload FROM mb_memories WHERE namespace=? AND project=? AND id=?', [actor.namespace, draft.project, draft.id]))[0];
      if ((old ? Number(old.version) : 0) !== request.expectedVersion || old?.deleted === 1) throw new AppError('VERSION_CONFLICT', 409);
      const now = Date.now();
      const memory: Memory = { ...draft, agent: actor.agent, version: request.expectedVersion + 1, createdAt: old ? (JSON.parse(String(old.payload)) as Memory).createdAt : now, updatedAt: now };
      if (old) await conn.run('UPDATE mb_memories SET version=?, updated_at=?, payload=? WHERE namespace=? AND project=? AND id=?', [memory.version, now, JSON.stringify(memory), actor.namespace, draft.project, draft.id]);
      else await conn.run('INSERT INTO mb_memories(namespace, project, id, version, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?)', [actor.namespace, draft.project, draft.id, memory.version, now, JSON.stringify(memory)]);
      return memory;
    });
  }
  async forget(actor: Principal, request: Forget): Promise<{ id: string; version: number; deleted: true }> {
    return this.operation(actor, request.project, request.id, request.operationId, request, async conn => {
      const row = (await conn.rows('SELECT version, deleted FROM mb_memories WHERE namespace=? AND project=? AND id=?', [actor.namespace, request.project, request.id]))[0];
      if (!row || Number(row.version) !== request.expectedVersion || Number(row.deleted) === 1) throw new AppError('VERSION_CONFLICT', 409);
      const version = request.expectedVersion + 1;
      await conn.run("UPDATE mb_memories SET version=?, deleted=1, updated_at=?, payload='{}' WHERE namespace=? AND project=? AND id=?", [version, Date.now(), actor.namespace, request.project, request.id]);
      // Operation receipts keep only IDs/versions, never deleted text.
      await conn.run('UPDATE mb_operations SET result=? WHERE namespace=? AND project=? AND memory_id=?', [JSON.stringify({ id: request.id, version, deleted: true }), actor.namespace, request.project, request.id]);
      return { id: request.id, version, deleted: true };
    });
  }
  async get(actor: Principal, project: string, ids: string[]): Promise<Memory[]> {
    authorize(actor, project);
    const rows = await this.db.rows(`SELECT payload FROM mb_memories WHERE namespace=? AND project=? AND deleted=0 AND id IN (${ids.map(() => '?').join(',')})`, [actor.namespace, project, ...ids]);
    return rows.map(row => JSON.parse(String(row.payload)) as Memory).filter(memory => active(memory));
  }
  async search(actor: Principal, request: Search) {
    authorize(actor, request.project);
    const query = request.query.toLocaleLowerCase();
    const escaped = query.replace(/[!%_]/g, character => '!' + character);
    const text = this.db.dialect === 'mysql' ? "CONCAT(COALESCE(search_title,''),CHAR(10),COALESCE(search_body,''))" : "COALESCE(search_title,'') || char(10) || COALESCE(search_body,'')";
    const results: Memory[] = [];
    let cursor: { time: number; id: string } | undefined;
    const now = Date.now();
    while (results.length < request.limit) {
      const where = cursor ? ' AND (updated_at<? OR (updated_at=? AND id<?))' : '';
      const args: (string | number)[] = [actor.namespace, request.project, '%' + escaped + '%'];
      if (cursor) args.push(cursor.time, cursor.time, cursor.id);
      const rows = await this.db.rows(`SELECT payload,updated_at,id FROM mb_memories WHERE namespace=? AND project=? AND deleted=0 AND LOWER(${text}) LIKE ? ESCAPE '!'${where} ORDER BY updated_at DESC,id DESC LIMIT 100`, args);
      if (!rows.length) break;
      for (const row of rows) {
        const memory = JSON.parse(String(row.payload)) as Memory;
        if (active(memory, now) && (memory.title + '\n' + memory.body).toLocaleLowerCase().includes(query)) results.push(memory);
        if (results.length === request.limit) break;
      }
      const last = rows[rows.length - 1]; cursor = { time: Number(last.updated_at), id: String(last.id) };
    }
    return results.map(index);
  }
  async timeline(actor: Principal, project: string, anchor: string, depth: number) {
    const memory = (await this.get(actor, project, [anchor]))[0];
    if (!memory) return [];
    const neighbors = async (direction: 'before' | 'after') => {
      const results: Memory[] = []; let time = memory.updatedAt, id = anchor;
      const comparison = direction === 'before' ? '<' : '>';
      const order = direction === 'before' ? 'DESC' : 'ASC';
      const now = Date.now();
      while (results.length < depth) {
        const rows = await this.db.rows(`SELECT payload,updated_at,id FROM mb_memories WHERE namespace=? AND project=? AND deleted=0 AND (updated_at${comparison}? OR (updated_at=? AND id${comparison}?)) ORDER BY updated_at ${order},id ${order} LIMIT 100`, [actor.namespace, project, time, time, id]);
        if (!rows.length) break;
        for (const row of rows) { const item = JSON.parse(String(row.payload)) as Memory; if (active(item, now)) results.push(item); if (results.length === depth) break; }
        const last = rows[rows.length - 1]; time = Number(last.updated_at); id = String(last.id);
      }
      return results;
    };
    const before = await neighbors('before'), after = await neighbors('after');
    return [...before.reverse(), memory, ...after].map(index);
  }
  close() { return this.db.close(); }
}

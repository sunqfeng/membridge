import { Database } from 'bun:sqlite';
import mysql, { type Pool, type PoolConnection } from 'mysql2/promise';

export type Row = Record<string, unknown>;
export interface SqlConnection {
  rows(sql: string, values?: (string | number)[]): Promise<Row[]>;
  run(sql: string, values?: (string | number)[]): Promise<void>;
}
export interface SqlDatabase extends SqlConnection {
  dialect: 'sqlite' | 'mysql';
  transaction<T>(fn: (connection: SqlConnection) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export const schema = [
  `CREATE TABLE IF NOT EXISTS mb_scopes (namespace VARCHAR(80) NOT NULL, project VARCHAR(80) NOT NULL, PRIMARY KEY(namespace, project))`,
  `CREATE TABLE IF NOT EXISTS mb_memories (namespace VARCHAR(80) NOT NULL, project VARCHAR(80) NOT NULL, id VARCHAR(36) NOT NULL, version INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL, payload MEDIUMTEXT NOT NULL, PRIMARY KEY(namespace, project, id))`,
  `CREATE TABLE IF NOT EXISTS mb_operations (namespace VARCHAR(80) NOT NULL, agent VARCHAR(80) NOT NULL, id VARCHAR(36) NOT NULL, project VARCHAR(80) NOT NULL, memory_id VARCHAR(36) NOT NULL, request_hash VARCHAR(64) NOT NULL, result MEDIUMTEXT NOT NULL, PRIMARY KEY(namespace, agent, id))`,
];

// Generated columns stay correct even while a previous writer still updates only payload.
function sqliteSearchColumns(db: Database) {
  const columns = db.query('PRAGMA table_xinfo(mb_memories)').all() as { name: string }[];
  for (const [name, field] of [['search_title', 'title'], ['search_body', 'body']]) {
    if (!columns.some(column => column.name === name)) db.run(`ALTER TABLE mb_memories ADD COLUMN ${name} TEXT GENERATED ALWAYS AS (json_extract(payload, '$.${field}')) VIRTUAL`);
  }
}

export function sqliteDatabase(path: string): SqlDatabase {
  const db = new Database(path);
  db.run('PRAGMA busy_timeout=5000');
  db.run('PRAGMA journal_mode=WAL');
  schema.forEach(sql => db.run(sql));
  sqliteSearchColumns(db);
  const connection: SqlConnection = {
    rows: async (sql, args = []) => db.query(sql).all(...args) as Row[],
    run: async (sql, args = []) => { db.query(sql).run(...args); },
  };
  let previous = Promise.resolve();
  return {
    ...connection, dialect: 'sqlite',
    async transaction(fn) {
      const waiting = previous;
      let release!: () => void;
      previous = new Promise(resolve => { release = resolve; });
      await waiting;
      try {
        db.run('BEGIN IMMEDIATE');
        try { const result = await fn(connection); db.run('COMMIT'); return result; }
        catch (error) { db.run('ROLLBACK'); throw error; }
      } finally { release(); }
    },
    close: async () => { db.close(); },
  };
}
function mysqlConnection(connection: Pool | PoolConnection): SqlConnection {
  return {
    rows: async (sql, args = []) => (await connection.execute(sql, args))[0] as Row[],
    run: async (sql, args = []) => { await connection.execute(sql, args); },
  };
}
export async function mysqlDatabase(url: string): Promise<SqlDatabase> {
  const pool = mysql.createPool({ uri: url, connectionLimit: 5, charset: 'utf8mb4', supportBigNumbers: true });
  const connection = mysqlConnection(pool);
  try {
    for (const sql of schema) await connection.run(sql.replace(/VARCHAR\((80|36)\)/g, 'VARCHAR($1) CHARACTER SET ascii COLLATE ascii_bin') + ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin');
    const columns = await connection.rows("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mb_memories'");
    for (const [name, field] of [['search_title', 'title'], ['search_body', 'body']]) {
      if (!columns.some(column => column.COLUMN_NAME === name)) {
        try { await connection.run(`ALTER TABLE mb_memories ADD COLUMN ${name} MEDIUMTEXT GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(payload, '$.${field}'))) VIRTUAL`); }
        catch (error) { if ((error as { errno?: number }).errno !== 1060) throw error; }
      }
    }
  }
  catch (error) { await pool.end(); throw error; }
  return {
    ...connection, dialect: 'mysql',
    async transaction(fn) {
      for (let attempt = 0; ; attempt++) {
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          try { const result = await fn(mysqlConnection(conn)); await conn.commit(); return result; }
          catch (error) { await conn.rollback(); throw error; }
        } catch (error) {
          if (attempt >= 2 || ![1213, 1205].includes((error as { errno?: number }).errno ?? 0)) throw error;
        } finally { conn.release(); }
        // Retry the whole transaction after rollback, including scope locking and CAS.
        await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1) + Math.random() * 30));
      }
    },
    close: async () => { await pool.end(); },
  };
}

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

export function sqliteDatabase(path: string): SqlDatabase {
  const db = new Database(path);
  db.run('PRAGMA journal_mode=WAL');
  db.run('PRAGMA busy_timeout=5000');
  schema.forEach(sql => db.run(sql));
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
  }
  catch (error) { await pool.end(); throw error; }
  return {
    ...connection, dialect: 'mysql',
    async transaction(fn) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        try { const result = await fn(mysqlConnection(conn)); await conn.commit(); return result; }
        catch (error) { await conn.rollback(); throw error; }
      } finally { conn.release(); }
    },
    close: async () => { await pool.end(); },
  };
}

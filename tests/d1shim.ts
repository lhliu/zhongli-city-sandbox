/**
 * 測試用 D1 介面：以 Node 內建 SQLite 實作 prepare/bind/first/all/run/batch。
 * batch 包在交易內，任何一句失敗即整批回滾（與 D1 batch 語意一致）。
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

class Stmt {
  params: unknown[] = [];
  constructor(private db: DatabaseSync, public sql: string) {}
  bind(...p: unknown[]) {
    const s = new Stmt(this.db, this.sql);
    s.params = p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
    return s;
  }
  async first<T>(col?: string): Promise<T | null> {
    const r = this.db.prepare(this.sql).get(...(this.params as never[])) as Record<string, unknown> | undefined;
    if (!r) return null;
    return (col ? r[col] : { ...r }) as T;
  }
  async all<T>() {
    const rows = this.db.prepare(this.sql).all(...(this.params as never[])) as T[];
    return { results: rows.map((r) => ({ ...(r as object) })) as T[], success: true, meta: {} };
  }
  runSync() {
    const r = this.db.prepare(this.sql).run(...(this.params as never[]));
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async run() {
    return this.runSync();
  }
}

export function createTestDb(): D1Database {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  const dir = join(__dirname, '..', 'migrations');
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) db.exec(readFileSync(join(dir, f), 'utf8'));
  const api = {
    prepare: (sql: string) => new Stmt(db, sql),
    async batch(stmts: Stmt[]) {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => {
          const isRead = /^\s*select/i.test(s.sql);
          if (isRead) {
            const rows = db.prepare(s.sql).all(...(s.params as never[]));
            return { results: rows, success: true, meta: { changes: 0 } };
          }
          return s.runSync();
        });
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    async exec(sql: string) {
      db.exec(sql);
      return { count: 1, duration: 0 };
    },
    raw: db,
  };
  return api as unknown as D1Database;
}

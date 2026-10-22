import type { Role } from '../src/lib/model/types';
import { forbidden, notFound } from './errors';

export const newId = () => crypto.randomUUID();

export async function all<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const r = await db.prepare(sql).bind(...params).all<T>();
  return r.results;
}

export async function first<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  return (await db.prepare(sql).bind(...params).first<T>()) ?? null;
}

export const stmt = (db: D1Database, sql: string, ...params: unknown[]) => db.prepare(sql).bind(...params);

/**
 * 版本守衛：放在 batch 第一句。條件不成立時 CHECK 失敗，整個 batch 回滾。
 * D1 沒有互動式交易，用此方式讓「檢查版本＋寫入」原子化。
 */
export function guard(db: D1Database, conditionSql: string, ...params: unknown[]) {
  return db.prepare(`INSERT INTO _guards (ok) SELECT CASE WHEN (${conditionSql}) THEN 1 ELSE 0 END`).bind(...params);
}
export const clearGuards = (db: D1Database) => db.prepare('DELETE FROM _guards');

export function isGuardFailure(e: unknown): boolean {
  return e instanceof Error && /CHECK constraint failed/i.test(e.message) && /_guards|ok/i.test(e.message);
}

const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export async function roleFor(db: D1Database, projectId: string, user: string): Promise<Role | null> {
  const r = await first<{ role: Role }>(db, 'SELECT role FROM project_members WHERE project_id = ? AND user_email = ?', projectId, user);
  return r?.role ?? null;
}

/** 非成員一律回 404，不透露專案是否存在 */
export async function requireRole(db: D1Database, projectId: string, user: string, min: Role): Promise<Role> {
  const role = await roleFor(db, projectId, user);
  if (!role) throw notFound('專案');
  if (RANK[role] < RANK[min]) throw forbidden(min === 'owner' ? '只有擁有者可以執行此操作' : '檢視者不能修改資料');
  return role;
}

/** 由實體 ID 取得所屬專案並檢查權限 */
export async function requireEntityRole(db: D1Database, table: string, id: string, user: string, min: Role, label: string) {
  if (!/^[a-z_]+$/.test(table)) throw new Error('bad table');
  const r = await first<{ project_id: string }>(db, `SELECT project_id FROM ${table} WHERE id = ?`, id);
  if (!r) throw notFound(label);
  const role = await roleFor(db, r.project_id, user);
  if (!role) throw notFound(label);
  if (RANK[role] < RANK[min]) throw forbidden('檢視者不能修改資料');
  return { projectId: r.project_id, role };
}

export function audit(db: D1Database, projectId: string, actor: string, entityType: string, entityId: string, action: string, before: unknown, after: unknown) {
  return stmt(
    db,
    'INSERT INTO audit_events (id, project_id, actor, entity_type, entity_id, action, before_json, after_json) VALUES (?,?,?,?,?,?,?,?)',
    newId(), projectId, actor, entityType, entityId, action,
    before == null ? null : JSON.stringify(before),
    after == null ? null : JSON.stringify(after),
  );
}

/**
 * CSV 匯入 API（規格 §7.2、§10.5）：
 * preview 不改正式資料 → commit 交易式套用（D1 batch）→ 可整批 rollback。
 */
import { Hono } from 'hono';
import Papa from 'papaparse';
import type { AppEnv } from './env';
import { ApiFailure, notFound } from './errors';
import { all, first, newId, requireEntityRole, requireRole, stmt } from './db';
import { buildPlan, checkHeaders, parseRow, type Action, type Existing, type ImportPlan, type RawRow } from '../src/lib/import/csv';
import { ImportCommitSchema } from '../src/lib/model/schemas';

export const importRoutes = new Hono<AppEnv>();

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 5000;

async function sha256Hex(text: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function loadExisting(db: D1Database, projectId: string): Promise<Existing> {
  const [parcels, developments, developers, links, devDevelopers] = await Promise.all([
    all<Existing['parcels'][number]>(db, `SELECT id, county, district, section_code AS sectionCode, land_main AS landMain, land_sub AS landSub
      FROM parcels WHERE project_id = ? AND kind = 'cadastral' AND valid_to IS NULL`, projectId),
    all<Existing['developments'][number]>(db, `SELECT id, code, name, status, completion_kind AS completionKind, completion_date AS completionDate,
      completion_precision AS completionPrecision, data_date AS dataDate, verification, version FROM developments WHERE project_id = ?`, projectId),
    all<Existing['developers'][number]>(db, 'SELECT id, company_name AS companyName, brand_name AS brandName, tax_id AS taxId FROM developers WHERE project_id = ?', projectId),
    all<Existing['links'][number]>(db, 'SELECT development_id AS developmentId, parcel_id AS parcelId FROM development_parcels WHERE project_id = ?', projectId),
    all<Existing['devDevelopers'][number]>(db, 'SELECT development_id AS developmentId, developer_id AS developerId FROM development_developers WHERE project_id = ?', projectId),
  ]);
  return { parcels, developments, developers, links, devDevelopers };
}

export async function planCsv(db: D1Database, projectId: string, text: string): Promise<ImportPlan> {
  const parsed = Papa.parse<RawRow>(text.replace(/^﻿/, ''), { header: true, skipEmptyLines: 'greedy', transformHeader: (h) => h.replace(/^﻿/, '').trim() });
  const headerErrors = checkHeaders(parsed.meta.fields ?? []);
  if (headerErrors.some((e) => e.startsWith('缺少'))) return { headerErrors, rows: [], summary: { create: 0, update: 0, unchanged: 0, error: 0, needs_review: 0 } };
  if (parsed.data.length > MAX_ROWS) throw new ApiFailure(422, 'too_many_rows', `一次最多匯入 ${MAX_ROWS} 列`);
  const rows = await Promise.all(parsed.data.map((r, i) => parseRow(r, i + 2)));
  const plan = buildPlan(rows, await loadExisting(db, projectId));
  plan.headerErrors = headerErrors;
  return plan;
}

const actionsFingerprint = (plan: ImportPlan) => JSON.stringify(plan.rows.map((r) => [r.rowHash, r.outcome, r.actions]));

importRoutes.post('/projects/:pid/imports/preview', async (c) => {
  const pid = c.req.param('pid');
  const user = c.get('user');
  await requireRole(c.env.DB, pid, user, 'editor');
  const text = await c.req.text();
  if (new TextEncoder().encode(text).length > MAX_BYTES) throw new ApiFailure(422, 'file_too_large', 'CSV 檔案超過 2MB');
  const filename = c.req.header('X-Filename') ? decodeURIComponent(c.req.header('X-Filename')!) : null;
  const plan = await planCsv(c.env.DB, pid, text);
  const id = newId();
  const contentHash = await sha256Hex(text);
  await stmt(c.env.DB, `INSERT INTO import_batches (id, project_id, filename, content_sha256, status, preview_json, created_by) VALUES (?,?,?,?, 'previewed', ?, ?)`,
    id, pid, filename, contentHash, JSON.stringify({ plan, csv: text }), user).run();
  return c.json({ batchId: id, previewToken: `${id}.${contentHash.slice(0, 16)}`, plan });
});

importRoutes.get('/imports/:id', async (c) => {
  const id = c.req.param('id');
  await requireEntityRole(c.env.DB, 'import_batches', id, c.get('user'), 'viewer', '匯入批次');
  const b = await first<Record<string, unknown>>(c.env.DB, 'SELECT id, filename, status, preview_json, report_json, created_at, committed_at, rolled_back_at FROM import_batches WHERE id = ?', id);
  const preview = JSON.parse(String(b!.preview_json)) as { plan: ImportPlan };
  return c.json({ ...b, preview_json: undefined, plan: preview.plan, report: b!.report_json ? JSON.parse(String(b!.report_json)) : null });
});

importRoutes.get('/projects/:pid/imports', async (c) => {
  const pid = c.req.param('pid');
  await requireRole(c.env.DB, pid, c.get('user'), 'viewer');
  const rows = await all(c.env.DB, `SELECT id, filename, status, report_json, created_at, committed_at, rolled_back_at, created_by
    FROM import_batches WHERE project_id = ? ORDER BY created_at DESC LIMIT 50`, pid);
  return c.json({ batches: rows });
});

importRoutes.post('/imports/:id/commit', async (c) => {
  const id = c.req.param('id');
  const user = c.get('user');
  const db = c.env.DB;
  const { projectId } = await requireEntityRole(db, 'import_batches', id, user, 'editor', '匯入批次');
  const { mode, idempotencyKey } = ImportCommitSchema.parse(await c.req.json());
  const batch = await first<{ status: string; preview_json: string; report_json: string | null; idempotency_key: string | null }>(
    db, 'SELECT status, preview_json, report_json, idempotency_key FROM import_batches WHERE id = ?', id);
  if (!batch) throw notFound('匯入批次');
  // 冪等：同一批重送回傳先前結果，不重複套用
  if (batch.status === 'committed') return c.json({ report: JSON.parse(batch.report_json!), replayed: true });
  if (batch.status !== 'previewed') throw new ApiFailure(409, 'batch_not_committable', `此批次狀態為 ${batch.status}，不能套用`);

  const stored = JSON.parse(batch.preview_json) as { plan: ImportPlan; csv: string };
  const fresh = await planCsv(db, projectId, stored.csv);
  if (actionsFingerprint(fresh) !== actionsFingerprint(stored.plan)) {
    throw new ApiFailure(409, 'preview_stale', '預覽之後資料已有變動，請重新預覽再套用');
  }
  const bad = fresh.rows.filter((r) => r.outcome === 'error' || r.outcome === 'needs_review');
  if (mode === 'all_or_nothing' && bad.length) {
    throw new ApiFailure(422, 'rows_invalid', `有 ${bad.length} 列錯誤或待確認；請修正，或選「只套用有效列」`);
  }
  const applyRows = fresh.rows.filter((r) => r.outcome === 'create' || r.outcome === 'update');

  const refMap = new Map<string, string>();
  const resolve = (ref: string) => (ref.startsWith('new:') ? refMap.get(ref)! : ref);
  const stmts: D1PreparedStatement[] = [];
  const effectRows: { rowNumber: number; rowHash: string; effects: unknown[] }[] = [];

  for (const row of applyRows) {
    const effects: unknown[] = [];
    for (const a of row.actions) stmts.push(...applyAction(db, projectId, id, a, refMap, resolve, effects));
    effectRows.push({ rowNumber: row.rowNumber, rowHash: row.rowHash, effects });
  }
  for (const e of effectRows) {
    stmts.push(stmt(db, 'INSERT INTO import_row_effects (batch_id, project_id, row_number, row_hash, effect_json) VALUES (?,?,?,?,?)',
      id, projectId, e.rowNumber, e.rowHash, JSON.stringify(e.effects)));
  }
  const report = {
    mode,
    applied: applyRows.length,
    skipped: fresh.rows.length - applyRows.length,
    summary: fresh.summary,
    skippedRows: bad.map((r) => ({ rowNumber: r.rowNumber, outcome: r.outcome, messages: r.messages })),
  };
  stmts.push(stmt(db, `UPDATE import_batches SET status = 'committed', committed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), report_json = ?, idempotency_key = ?
                       WHERE id = ? AND status = 'previewed'`, JSON.stringify(report), idempotencyKey, id));
  stmts.push(stmt(db, 'INSERT INTO audit_events (id, project_id, actor, entity_type, entity_id, action, after_json) VALUES (?,?,?,?,?,?,?)',
    newId(), projectId, user, 'import_batch', id, 'commit', JSON.stringify(report)));
  await db.batch(stmts);
  return c.json({ report });
});

function applyAction(
  db: D1Database, projectId: string, batchId: string, a: Action, refMap: Map<string, string>, resolve: (r: string) => string, effects: unknown[],
): D1PreparedStatement[] {
  switch (a.type) {
    case 'create_parcel': {
      const id = newId();
      refMap.set(a.ref, id);
      effects.push({ type: 'created_parcel', id });
      return [stmt(db, `INSERT INTO parcels (id, project_id, kind, county, district, section_code, section_name, land_main, land_sub, land_raw, verification, note)
                        VALUES (?,?,'cadastral',?,?,?,?,?,?,?,?,?)`,
        id, projectId, a.county, a.district, a.sectionCode, a.sectionName || null, a.landMain, a.landSub, a.landRaw, a.verification, a.note || null)];
    }
    case 'create_development': {
      const id = newId();
      refMap.set(a.ref, id);
      effects.push({ type: 'created_development', id });
      const f = a.fields;
      return [stmt(db, `INSERT INTO developments (id, project_id, code, name, status, completion_kind, completion_date, completion_precision, data_date, verification)
                        VALUES (?,?,?,?,?,?,?,?,?,?)`,
        id, projectId, a.code, f.name, f.status, f.completionKind, f.completionDate, f.completionPrecision, f.dataDate, f.verification)];
    }
    case 'update_development': {
      const cols: Record<string, string> = {
        name: 'name', status: 'status', completionKind: 'completion_kind', completionDate: 'completion_date', completionPrecision: 'completion_precision',
        dataDate: 'data_date', verification: 'verification',
      };
      const entries = Object.entries(a.changes);
      effects.push({ type: 'updated_development', id: a.developmentId, before: a.before, versionAfter: a.expectedVersion + 1 });
      return [stmt(db, `UPDATE developments SET ${entries.map(([k]) => `${cols[k]} = ?`).join(', ')}, version = version + 1 WHERE id = ? AND version = ?`,
        ...entries.map(([, v]) => v), a.developmentId, a.expectedVersion)];
    }
    case 'create_developer': {
      const id = newId();
      refMap.set(a.ref, id);
      effects.push({ type: 'created_developer', id });
      return [stmt(db, 'INSERT INTO developers (id, project_id, company_name, brand_name, tax_id) VALUES (?,?,?,?,?)', id, projectId, a.companyName, a.brandName, a.taxId)];
    }
    case 'link_developer': {
      const d = resolve(a.developmentRef);
      const dev = resolve(a.developerRef);
      effects.push({ type: 'linked_developer', developmentId: d, developerId: dev });
      return [stmt(db, 'INSERT INTO development_developers (development_id, developer_id, project_id, role) VALUES (?,?,?,?)', d, dev, projectId, a.role)];
    }
    case 'link_parcel': {
      const d = resolve(a.developmentRef);
      const p = resolve(a.parcelRef);
      effects.push({ type: 'linked_parcel', developmentId: d, parcelId: p });
      return [stmt(db, `INSERT INTO development_parcels (development_id, parcel_id, project_id, valid_from, valid_to, evidence_note, import_batch_id)
                        VALUES (?,?,?,?,?,?,?)`, d, p, projectId, a.validFrom, a.validTo, a.evidenceNote || null, batchId)];
    }
  }
}

/** 整批撤回：反向刪除新建資料、還原更新欄位；被後續資料引用的物件保留並回報 */
importRoutes.post('/imports/:id/rollback', async (c) => {
  const id = c.req.param('id');
  const user = c.get('user');
  const db = c.env.DB;
  const { projectId } = await requireEntityRole(db, 'import_batches', id, user, 'editor', '匯入批次');
  const batch = await first<{ status: string }>(db, 'SELECT status FROM import_batches WHERE id = ?', id);
  if (batch?.status !== 'committed') throw new ApiFailure(409, 'batch_not_committed', '只有已套用的批次可以撤回');
  const effectRows = await all<{ effect_json: string }>(db, 'SELECT effect_json FROM import_row_effects WHERE batch_id = ? ORDER BY row_number DESC', id);
  const effects = effectRows.flatMap((r) => JSON.parse(r.effect_json) as Record<string, unknown>[]).reverse();
  const kept: string[] = [];
  const stmts: D1PreparedStatement[] = [];
  const cols: Record<string, string> = {
    name: 'name', status: 'status', completionKind: 'completion_kind', completionDate: 'completion_date', completionPrecision: 'completion_precision',
    dataDate: 'data_date', verification: 'verification',
  };
  for (const e of [...effects].reverse()) {
    if (e.type === 'linked_parcel') stmts.push(stmt(db, 'DELETE FROM development_parcels WHERE development_id = ? AND parcel_id = ? AND import_batch_id = ?', e.developmentId, e.parcelId, id));
    if (e.type === 'linked_developer') stmts.push(stmt(db, 'DELETE FROM development_developers WHERE development_id = ? AND developer_id = ?', e.developmentId, e.developerId));
  }
  for (const e of effects) {
    if (e.type === 'updated_development') {
      const before = e.before as Record<string, unknown>;
      const cur = await first<{ version: number }>(db, 'SELECT version FROM developments WHERE id = ?', e.developmentId ?? e.id);
      if (cur?.version !== e.versionAfter) {
        kept.push(`建案 ${String(e.id)} 匯入後已再被修改，未還原欄位`);
        continue;
      }
      const entries = Object.entries(before);
      stmts.push(stmt(db, `UPDATE developments SET ${entries.map(([k]) => `${cols[k]} = ?`).join(', ')}, version = version + 1 WHERE id = ?`, ...entries.map(([, v]) => v), e.id));
    }
  }
  for (const e of effects) {
    if (e.type === 'created_development') {
      const used = await first<{ n: number }>(db, `SELECT (SELECT COUNT(*) FROM buildings WHERE development_id = ?) +
        (SELECT COUNT(*) FROM development_parcels WHERE development_id = ? AND (import_batch_id IS NULL OR import_batch_id <> ?)) AS n`, e.id, e.id, id);
      if (used && used.n > 0) kept.push(`建案 ${String(e.id)} 已有棟別或其他關聯，保留`);
      else stmts.push(stmt(db, 'DELETE FROM developments WHERE id = ?', e.id));
    }
    if (e.type === 'created_parcel') {
      const used = await first<{ n: number }>(db, `SELECT (SELECT COUNT(*) FROM parcel_versions WHERE parcel_id = ?) +
        (SELECT COUNT(*) FROM development_parcels WHERE parcel_id = ? AND (import_batch_id IS NULL OR import_batch_id <> ?)) AS n`, e.id, e.id, id);
      if (used && used.n > 0) kept.push(`土地 ${String(e.id)} 已有圖形或其他關聯，保留`);
      else stmts.push(stmt(db, 'DELETE FROM parcels WHERE id = ?', e.id));
    }
    if (e.type === 'created_developer') {
      const used = await first<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM development_developers WHERE developer_id = ?', e.id);
      // 本批的建商關聯已在前面刪除；剩下的是其他來源的引用
      const ownLinks = effects.filter((x) => x.type === 'linked_developer' && x.developerId === e.id).length;
      if (used && used.n > ownLinks) kept.push(`建商 ${String(e.id)} 已被其他建案引用，保留`);
      else stmts.push(stmt(db, 'DELETE FROM developers WHERE id = ?', e.id));
    }
  }
  stmts.push(stmt(db, `UPDATE import_batches SET status = 'rolled_back', rolled_back_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, id));
  stmts.push(stmt(db, 'INSERT INTO audit_events (id, project_id, actor, entity_type, entity_id, action, after_json) VALUES (?,?,?,?,?,?,?)',
    newId(), projectId, user, 'import_batch', id, 'rollback', JSON.stringify({ kept })));
  await db.batch(stmts);
  return c.json({ ok: true, kept });
});

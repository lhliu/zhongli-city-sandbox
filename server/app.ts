import { Hono } from 'hono';
import type { Context } from 'hono';
import { z, ZodError } from 'zod';
import type { AppEnv } from './env';
import { resolveUser } from './auth';
import { ApiFailure, conflict, notFound } from './errors';
import { all, audit, clearGuards, first, guard, isGuardFailure, newId, requireEntityRole, requireRole, stmt } from './db';
import { loadScene, BUILDING_SELECT, buildingDTO } from './scene';
import { importRoutes } from './imports';
import {
  BookmarkCreateSchema, BuildingCreateSchema, BuildingVersionSchema, DeveloperInputSchema, DevelopmentCreateSchema, DevelopmentDevelopersSchema,
  DevelopmentParcelsSchema, DevelopmentPatchSchema, ParcelCreateSchema, completionMismatch, ParcelGeometrySchema, ScenarioCreateSchema, type BuildingInput,
} from '../src/lib/model/schemas';
import { validatePolygon, footprintInSites, polygonArea, type PolygonRings } from '../src/lib/geometry/polygon';
import { parseLandNumber } from '../src/lib/parcel/key';

export const app = new Hono<AppEnv>().basePath('/api');

app.use('*', async (c, next) => {
  c.set('requestId', crypto.randomUUID());
  c.set('user', await resolveUser(c));
  await next();
});

app.onError((err, c) => {
  const requestId = c.get('requestId') ?? crypto.randomUUID();
  if (err instanceof ApiFailure) {
    return c.json({ error_code: err.code, message: err.message, request_id: requestId, details: err.details }, err.status);
  }
  if (err instanceof ZodError) {
    return c.json(
      { error_code: 'validation_failed', message: '輸入資料格式不正確', request_id: requestId, details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
      422,
    );
  }
  if (isGuardFailure(err)) {
    return c.json({ error_code: 'version_conflict', message: '資料已被其他頁面或裝置修改，請重新載入後再編輯', request_id: requestId }, 409);
  }
  if (err instanceof Error && /cross_project_link/.test(err.message)) {
    return c.json({ error_code: 'cross_project_link', message: '不能連結其他專案的資料', request_id: requestId }, 422);
  }
  if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) {
    return c.json({ error_code: 'duplicate', message: '資料重複（代碼或地籍鍵已存在）', request_id: requestId }, 409);
  }
  console.error(requestId, err);
  return c.json({ error_code: 'internal_error', message: '伺服器發生錯誤，請稍後再試', request_id: requestId }, 500);
});

const body = async <T extends z.ZodTypeAny>(c: Context<AppEnv>, schema: T): Promise<z.infer<T>> => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiFailure(400, 'invalid_json', '請求內容不是有效的 JSON');
  }
  return schema.parse(raw);
};

function geometryOrThrow(p: PolygonRings, label: string) {
  const issues = validatePolygon(p);
  if (issues.length) throw new ApiFailure(422, 'invalid_geometry', `${label}圖形不合法`, issues);
}

// ───────────── 使用者與專案 ─────────────

app.get('/me', (c) => c.json({ email: c.get('user') }));

app.get('/projects', async (c) => {
  const rows = await all<{ id: string; name: string; role: string }>(
    c.env.DB,
    'SELECT p.id, p.name, m.role FROM projects p JOIN project_members m ON m.project_id = p.id WHERE m.user_email = ? ORDER BY p.created_at',
    c.get('user'),
  );
  return c.json({ projects: rows });
});

app.get('/projects/:pid/scene', async (c) => {
  const pid = c.req.param('pid');
  const role = await requireRole(c.env.DB, pid, c.get('user'), 'viewer');
  return c.json(await loadScene(c.env.DB, pid, role, c.req.query('scenario_id') ?? null));
});

// ───────────── 土地 ─────────────

/** 搜尋：完整地籍鍵唯一定位；查不到回空陣列，不回預設土地 */
app.get('/projects/:pid/parcels/search', async (c) => {
  const pid = c.req.param('pid');
  await requireRole(c.env.DB, pid, c.get('user'), 'viewer');
  const q = (c.req.query('q') ?? '').trim();
  if (!q) return c.json({ matches: [] });
  const ln = parseLandNumber(q.split(/\s+/).pop() ?? '');
  const section = q.includes(' ') ? q.slice(0, q.lastIndexOf(' ')).trim() : null;
  const rows = await all<Record<string, unknown>>(
    c.env.DB,
    `SELECT p.id, p.kind, p.block_id, p.section_code, p.section_name, p.land_main, p.land_sub, p.label
     FROM parcels p WHERE p.project_id = ? AND p.valid_to IS NULL AND (
       p.block_id = ? OR p.label = ? OR (? = 1 AND p.land_main = ? AND p.land_sub = ? AND (? IS NULL OR p.section_code = ? OR p.section_name = ?))
     ) LIMIT 20`,
    pid, q, q, ln.ok ? 1 : 0, ln.ok ? ln.value.main : '', ln.ok ? ln.value.sub : '', section, section, section,
  );
  return c.json({ matches: rows, ambiguous: rows.length > 1 });
});

app.post('/projects/:pid/parcels', async (c) => {
  const pid = c.req.param('pid');
  const user = c.get('user');
  await requireRole(c.env.DB, pid, user, 'editor');
  const input = await body(c, ParcelCreateSchema);
  const id = newId();
  const db = c.env.DB;
  const stmts: D1PreparedStatement[] = [];
  let versionId: string | null = null;
  if (input.geometry) {
    geometryOrThrow(input.geometry, '土地');
    versionId = newId();
  }
  if (input.kind === 'reference_block') {
    stmts.push(stmt(db, `INSERT INTO parcels (id, project_id, kind, block_id, label, zoning, verification, current_version_id) VALUES (?,?,?,?,?,?, 'pending', ?)`,
      id, pid, 'reference_block', input.blockId, input.label, input.zoning, versionId));
  } else {
    const ln = parseLandNumber(input.landRaw);
    if (!ln.ok) throw new ApiFailure(422, 'invalid_land_number', ln.error);
    stmts.push(stmt(db, `INSERT INTO parcels (id, project_id, kind, county, district, section_code, section_name, land_main, land_sub, land_raw, zoning, verification, current_version_id)
                         VALUES (?,?,?,?,?,?,?,?,?,?,?, 'pending', ?)`,
      id, pid, 'cadastral', input.county, input.district, input.sectionCode, input.sectionName, ln.value.main, ln.value.sub, input.landRaw, input.zoning, versionId));
  }
  if (versionId && input.geometry) {
    stmts.push(stmt(db, `INSERT INTO parcel_versions (id, parcel_id, project_id, version, coord_space, geometry_json, source_px_json, source_id, quality_note, created_by)
                         VALUES (?,?,?,1,'local_m',?,?,?,?,?)`,
      versionId, id, pid, JSON.stringify(input.geometry), input.kind === 'reference_block' && input.sourcePx ? JSON.stringify(input.sourcePx) : null,
      input.sourceId, input.qualityNote, user));
  }
  stmts.push(audit(db, pid, user, 'parcel', id, 'create', null, input));
  await db.batch(stmts);
  return c.json({ id }, 201);
});

/** 發布新的幾何版本；舊版本保留 */
app.post('/parcels/:id/geometry', async (c) => {
  const id = c.req.param('id');
  const user = c.get('user');
  const db = c.env.DB;
  const { projectId } = await requireEntityRole(db, 'parcels', id, user, 'editor', '土地');
  const input = await body(c, ParcelGeometrySchema);
  geometryOrThrow(input.geometry, '土地');
  const versionId = newId();
  const nextGeomVersion = ((await first<{ v: number }>(db, 'SELECT MAX(version) AS v FROM parcel_versions WHERE parcel_id = ?', id))?.v ?? 0) + 1;
  await db.batch([
    guard(db, 'SELECT COUNT(*) FROM parcels WHERE id = ? AND version = ?', id, input.expectedVersion),
    stmt(db, `INSERT INTO parcel_versions (id, parcel_id, project_id, version, coord_space, geometry_json, source_px_json, quality_note, created_by)
              VALUES (?,?,?,?,'local_m',?,?,?,?)`,
      versionId, id, projectId, nextGeomVersion, JSON.stringify(input.geometry), input.sourcePx ? JSON.stringify(input.sourcePx) : null, input.qualityNote, user),
    stmt(db, `UPDATE parcels SET current_version_id = ?, version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, versionId, id),
    audit(db, projectId, user, 'parcel', id, 'geometry', { expectedVersion: input.expectedVersion }, { versionId, areaM2: polygonArea(input.geometry) }),
    clearGuards(db),
  ]);
  return c.json({ versionId, version: input.expectedVersion + 1 });
});

// ───────────── 建商 ─────────────

app.post('/projects/:pid/developers', async (c) => {
  const pid = c.req.param('pid');
  const user = c.get('user');
  await requireRole(c.env.DB, pid, user, 'editor');
  const d = await body(c, DeveloperInputSchema);
  const id = newId();
  await c.env.DB.batch([
    stmt(c.env.DB, 'INSERT INTO developers (id, project_id, company_name, brand_name, tax_id, note) VALUES (?,?,?,?,?,?)', id, pid, d.companyName, d.brandName, d.taxId, d.note),
    audit(c.env.DB, pid, user, 'developer', id, 'create', null, d),
  ]);
  return c.json({ id }, 201);
});

// ───────────── 建案 ─────────────

const DEV_COLUMNS: Record<string, string> = {
  code: 'code', name: 'name', description: 'description', status: 'status', completionKind: 'completion_kind', completionDate: 'completion_date',
  completionPrecision: 'completion_precision', color: 'color', dataDate: 'data_date', verification: 'verification',
};

app.post('/projects/:pid/developments', async (c) => {
  const pid = c.req.param('pid');
  const user = c.get('user');
  await requireRole(c.env.DB, pid, user, 'editor');
  const d = await body(c, DevelopmentCreateSchema);
  const id = newId();
  const cols = Object.entries(d).filter(([k, v]) => DEV_COLUMNS[k] && v !== undefined);
  await c.env.DB.batch([
    stmt(c.env.DB, `INSERT INTO developments (id, project_id, ${cols.map(([k]) => DEV_COLUMNS[k]).join(', ')}) VALUES (?, ?, ${cols.map(() => '?').join(', ')})`,
      id, pid, ...cols.map(([, v]) => v)),
    audit(c.env.DB, pid, user, 'development', id, 'create', null, d),
  ]);
  return c.json({ id, version: 1 }, 201);
});

app.patch('/developments/:id', async (c) => {
  const id = c.req.param('id');
  const user = c.get('user');
  const db = c.env.DB;
  const { projectId } = await requireEntityRole(db, 'developments', id, user, 'editor', '建案');
  const { expectedVersion, patch } = await body(c, DevelopmentPatchSchema);
  const entries = Object.entries(patch).filter(([k, v]) => DEV_COLUMNS[k] && v !== undefined);
  if (!entries.length) return c.json({ version: expectedVersion });
  const before = await first<Record<string, unknown>>(db, 'SELECT * FROM developments WHERE id = ?', id);
  const mismatch = completionMismatch({
    completionDate: patch.completionDate !== undefined ? patch.completionDate : (before?.completion_date as string | null),
    completionPrecision: patch.completionPrecision !== undefined ? patch.completionPrecision : (before?.completion_precision as string | null),
  });
  if (mismatch) throw new ApiFailure(422, 'validation_failed', mismatch);
  const res = await db.batch([
    stmt(db, `UPDATE developments SET ${entries.map(([k]) => `${DEV_COLUMNS[k]} = ?`).join(', ')}, version = version + 1,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND version = ?`, ...entries.map(([, v]) => v), id, expectedVersion),
  ]);
  if (!res[0]?.meta.changes) throw conflict();
  await audit(db, projectId, user, 'development', id, 'update', before, patch).run();
  return c.json({ version: expectedVersion + 1 });
});

/** 設定建案關聯土地（多對多）；以建案 version 做樂觀鎖 */
app.put('/developments/:id/parcels', async (c) => {
  const id = c.req.param('id');
  const user = c.get('user');
  const db = c.env.DB;
  const { projectId } = await requireEntityRole(db, 'developments', id, user, 'editor', '建案');
  const { expectedVersion, parcelIds } = await body(c, DevelopmentParcelsSchema);
  const current = await all<{ parcel_id: string }>(db, 'SELECT parcel_id FROM development_parcels WHERE development_id = ?', id);
  const cur = new Set(current.map((r) => r.parcel_id));
  const want = new Set(parcelIds);
  const stmts = [guard(db, 'SELECT COUNT(*) FROM developments WHERE id = ? AND version = ?', id, expectedVersion)];
  for (const p of cur) if (!want.has(p)) stmts.push(stmt(db, 'DELETE FROM development_parcels WHERE development_id = ? AND parcel_id = ?', id, p));
  for (const p of want) if (!cur.has(p)) stmts.push(stmt(db, 'INSERT INTO development_parcels (development_id, parcel_id, project_id) VALUES (?,?,?)', id, p, projectId));
  stmts.push(stmt(db, 'UPDATE developments SET version = version + 1 WHERE id = ?', id));
  stmts.push(audit(db, projectId, user, 'development', id, 'parcels', [...cur], parcelIds));
  stmts.push(clearGuards(db));
  await db.batch(stmts);
  return c.json({ version: expectedVersion + 1 });
});

app.put('/developments/:id/developers', async (c) => {
  const id = c.req.param('id');
  const user = c.get('user');
  const db = c.env.DB;
  const { projectId } = await requireEntityRole(db, 'developments', id, user, 'editor', '建案');
  const { expectedVersion, developers } = await body(c, DevelopmentDevelopersSchema);
  const stmts = [
    guard(db, 'SELECT COUNT(*) FROM developments WHERE id = ? AND version = ?', id, expectedVersion),
    stmt(db, 'DELETE FROM development_developers WHERE development_id = ?', id),
    ...developers.map((d) => stmt(db, 'INSERT INTO development_developers (development_id, developer_id, project_id, role) VALUES (?,?,?,?)', id, d.developerId, projectId, d.role)),
    stmt(db, 'UPDATE developments SET version = version + 1 WHERE id = ?', id),
    audit(db, projectId, user, 'development', id, 'developers', null, developers),
    clearGuards(db),
  ];
  await db.batch(stmts);
  return c.json({ version: expectedVersion + 1 });
});

// ───────────── 棟別與版本 ─────────────

async function siteCheck(db: D1Database, developmentId: string, b: BuildingInput) {
  geometryOrThrow(b.footprint, '建物 footprint ');
  const rows = await all<{ geometry_json: string }>(
    db,
    `SELECT v.geometry_json FROM development_parcels dp JOIN parcels p ON p.id = dp.parcel_id
     JOIN parcel_versions v ON v.id = p.current_version_id WHERE dp.development_id = ?`,
    developmentId,
  );
  return footprintInSites(b.footprint, rows.map((r) => JSON.parse(r.geometry_json) as PolygonRings));
}

function versionInsert(db: D1Database, versionId: string, buildingId: string, projectId: string, version: number, b: BuildingInput, user: string) {
  return stmt(
    db,
    `INSERT INTO building_versions (id, building_id, project_id, version, footprint_json, footprint_is_assumed, base_elevation_m, segments_json,
       floors_above_ground, floors_below_ground, assumption_json, attribute, note, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    versionId, buildingId, projectId, version, JSON.stringify(b.footprint), b.footprintIsAssumed ? 1 : 0, b.baseElevationM, JSON.stringify(b.segments),
    b.floorsAboveGround, b.floorsBelowGround, b.assumption ? JSON.stringify(b.assumption) : null, b.attribute, b.note, user,
  );
}

async function requireScenarioInProject(db: D1Database, scenarioId: string, projectId: string) {
  const s = await first<{ id: string }>(db, 'SELECT id FROM scenarios WHERE id = ? AND project_id = ?', scenarioId, projectId);
  if (!s) throw notFound('情境');
}

app.post('/developments/:id/buildings', async (c) => {
  const devId = c.req.param('id');
  const user = c.get('user');
  const db = c.env.DB;
  const { projectId } = await requireEntityRole(db, 'developments', devId, user, 'editor', '建案');
  const { scenarioId, building } = await body(c, BuildingCreateSchema);
  await requireScenarioInProject(db, scenarioId, projectId);
  const site = await siteCheck(db, devId, building);
  const id = newId();
  const versionId = newId();
  await db.batch([
    stmt(db, 'INSERT INTO buildings (id, project_id, development_id, label, current_version_id, version) VALUES (?,?,?,?,?,1)', id, projectId, devId, building.label, versionId),
    versionInsert(db, versionId, id, projectId, 1, building, user),
    stmt(db, 'INSERT INTO scenario_items (scenario_id, project_id, building_id, building_version_id) VALUES (?,?,?,?)', scenarioId, projectId, id, versionId),
    stmt(db, 'UPDATE scenarios SET revision = revision + 1 WHERE id = ?', scenarioId),
    audit(db, projectId, user, 'building', id, 'create', null, { scenarioId, building }),
  ]);
  const row = await first<Record<string, unknown>>(db, `${BUILDING_SELECT} WHERE si.scenario_id = ? AND b.id = ?`, scenarioId, id);
  return c.json({ building: buildingDTO(row!), site }, 201);
});

/**
 * 修改棟別：建立新版本並只更新目前情境的引用；其他情境仍指向原版本。
 * expectedVersionId＝此情境目前引用的版本，防止兩頁同時修改互相覆蓋。
 */
app.post('/buildings/:id/versions', async (c) => {
  const id = c.req.param('id');
  const user = c.get('user');
  const db = c.env.DB;
  const { projectId } = await requireEntityRole(db, 'buildings', id, user, 'editor', '棟別');
  const { scenarioId, expectedVersionId, building } = await body(c, BuildingVersionSchema);
  await requireScenarioInProject(db, scenarioId, projectId);
  const b = await first<{ development_id: string; version: number }>(db, 'SELECT development_id, version FROM buildings WHERE id = ?', id);
  const site = await siteCheck(db, b!.development_id, building);
  const versionId = newId();
  const nextVersion = ((await first<{ v: number }>(db, 'SELECT MAX(version) AS v FROM building_versions WHERE building_id = ?', id))?.v ?? 0) + 1;
  await db.batch([
    guard(db, 'SELECT COUNT(*) FROM scenario_items WHERE scenario_id = ? AND building_id = ? AND building_version_id = ?', scenarioId, id, expectedVersionId),
    versionInsert(db, versionId, id, projectId, nextVersion, building, user),
    stmt(db, 'UPDATE scenario_items SET building_version_id = ? WHERE scenario_id = ? AND building_id = ?', versionId, scenarioId, id),
    stmt(db, 'UPDATE buildings SET label = ?, current_version_id = ?, version = version + 1 WHERE id = ?', building.label, versionId, id),
    stmt(db, 'UPDATE scenarios SET revision = revision + 1 WHERE id = ?', scenarioId),
    audit(db, projectId, user, 'building', id, 'version', { versionId: expectedVersionId }, { versionId, scenarioId }),
    clearGuards(db),
  ]);
  const row = await first<Record<string, unknown>>(db, `${BUILDING_SELECT} WHERE si.scenario_id = ? AND b.id = ?`, scenarioId, id);
  return c.json({ building: buildingDTO(row!), site });
});

/** 從情境移除（版本與其他情境不受影響） */
app.delete('/buildings/:id/scenarios/:sid', async (c) => {
  const id = c.req.param('id');
  const sid = c.req.param('sid');
  const user = c.get('user');
  const db = c.env.DB;
  const { projectId } = await requireEntityRole(db, 'buildings', id, user, 'editor', '棟別');
  const res = await db.batch([
    stmt(db, 'DELETE FROM scenario_items WHERE scenario_id = ? AND building_id = ? AND project_id = ?', sid, id, projectId),
    stmt(db, 'UPDATE scenarios SET revision = revision + 1 WHERE id = ? AND project_id = ?', sid, projectId),
    audit(db, projectId, user, 'building', id, 'remove_from_scenario', { scenarioId: sid }, null),
  ]);
  if (!res[0]?.meta.changes) throw notFound('此情境中的棟別');
  return c.json({ ok: true });
});

// ───────────── 情境與鏡頭 ─────────────

app.post('/projects/:pid/scenarios', async (c) => {
  const pid = c.req.param('pid');
  const user = c.get('user');
  const db = c.env.DB;
  await requireRole(db, pid, user, 'editor');
  const s = await body(c, ScenarioCreateSchema);
  if (s.baseScenarioId) await requireScenarioInProject(db, s.baseScenarioId, pid);
  const id = newId();
  const stmts = [
    stmt(db, `INSERT INTO scenarios (id, project_id, kind, name, data_as_of, target_date, target_precision, base_scenario_id) VALUES (?,?,?,?,?,?,?,?)`,
      id, pid, s.kind, s.name, s.dataAsOf, s.targetDate, s.targetPrecision, s.baseScenarioId),
  ];
  // 複製情境只複製版本引用，不複製模型資料
  if (s.baseScenarioId) {
    stmts.push(stmt(db, `INSERT INTO scenario_items (scenario_id, project_id, building_id, building_version_id)
                         SELECT ?, project_id, building_id, building_version_id FROM scenario_items WHERE scenario_id = ?`, id, s.baseScenarioId));
  }
  stmts.push(audit(db, pid, user, 'scenario', id, 'create', null, s));
  await db.batch(stmts);
  return c.json({ id }, 201);
});

app.post('/projects/:pid/bookmarks', async (c) => {
  const pid = c.req.param('pid');
  const user = c.get('user');
  const db = c.env.DB;
  await requireRole(db, pid, user, 'editor');
  const b = await body(c, BookmarkCreateSchema);
  let revision: number | null = null;
  if (b.scenarioId) {
    await requireScenarioInProject(db, b.scenarioId, pid);
    revision = (await first<{ revision: number }>(db, 'SELECT revision FROM scenarios WHERE id = ?', b.scenarioId))?.revision ?? null;
  }
  const id = newId();
  await stmt(db, 'INSERT INTO camera_bookmarks (id, project_id, scenario_id, scenario_revision, name, mode, camera_json, created_by) VALUES (?,?,?,?,?,?,?,?)',
    id, pid, b.scenarioId, revision, b.name, b.mode, JSON.stringify(b.camera), user).run();
  return c.json({ id, scenarioRevision: revision }, 201);
});

app.delete('/bookmarks/:id', async (c) => {
  const id = c.req.param('id');
  const { projectId } = await requireEntityRole(c.env.DB, 'camera_bookmarks', id, c.get('user'), 'editor', '鏡頭');
  await stmt(c.env.DB, 'DELETE FROM camera_bookmarks WHERE id = ? AND project_id = ?', id, projectId).run();
  return c.json({ ok: true });
});

app.route('/', importRoutes);

app.all('*', (c) => c.json({ error_code: 'not_found', message: '找不到此 API', request_id: c.get('requestId') }, 404));

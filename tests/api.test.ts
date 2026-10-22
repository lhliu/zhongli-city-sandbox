import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../server/app';
import { createTestDb } from './d1shim';
import { TEMPLATE_HEADERS } from '../src/lib/import/csv';
import type { SceneDTO } from '../src/lib/model/types';

let db: D1Database;
const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const S_OBS = 'aaaaaaaa-0000-4000-8000-000000000001';
const S_PLAN = 'aaaaaaaa-0000-4000-8000-000000000002';
const S_P2 = 'aaaaaaaa-0000-4000-8000-000000000003';

const env = () => ({ DB: db, DEV_AUTH: '1' });
const call = (method: string, path: string, user: string | null, body?: unknown, raw?: string) =>
  app.request(
    `/api${path}`,
    {
      method,
      headers: { ...(user ? { 'X-Dev-User': user } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: raw ?? (body ? JSON.stringify(body) : undefined),
    },
    env(),
  );

const sq = (x: number, z: number, s: number) => [[[x, z], [x + s, z], [x + s, z + s], [x, z + s]]];
const building = (label: string, footprint = sq(5, 5, 10), floors: number | null = 15) => ({
  label, footprint, footprintIsAssumed: true, baseElevationM: 0,
  segments: [{ baseHeightM: 0, heightM: floors ? 4.2 + (floors - 1) * 3.3 : null, heightSource: floors ? 'estimated' : null }],
  floorsAboveGround: floors, floorsBelowGround: null, attribute: 'planned', assumption: null, note: null,
});

beforeEach(async () => {
  db = createTestDb();
  const frame = JSON.stringify({ kind: 'image', sourceId: 'S2', metersPerPixel: 2, originPx: [0, 0], northUp: true });
  await db.batch([
    db.prepare('INSERT INTO projects (id, name, frame_json, default_scenario_id, created_by) VALUES (?,?,?,?,?)').bind(P1, '測試專案', frame, S_OBS, 'owner@x'),
    db.prepare('INSERT INTO projects (id, name, frame_json, default_scenario_id, created_by) VALUES (?,?,?,?,?)').bind(P2, '其他專案', frame, S_P2, 'other@x'),
    db.prepare("INSERT INTO project_members VALUES (?, 'owner@x', 'owner', '')").bind(P1),
    db.prepare("INSERT INTO project_members VALUES (?, 'editor@x', 'editor', '')").bind(P1),
    db.prepare("INSERT INTO project_members VALUES (?, 'viewer@x', 'viewer', '')").bind(P1),
    db.prepare("INSERT INTO project_members VALUES (?, 'other@x', 'owner', '')").bind(P2),
    db.prepare("INSERT INTO scenarios (id, project_id, kind, name) VALUES (?, ?, 'observed', '現況')").bind(S_OBS, P1),
    db.prepare("INSERT INTO scenarios (id, project_id, kind, name) VALUES (?, ?, 'planned', '公開規劃')").bind(S_PLAN, P1),
    db.prepare("INSERT INTO scenarios (id, project_id, kind, name) VALUES (?, ?, 'observed', '現況')").bind(S_P2, P2),
  ]);
});

async function json<T = any>(r: Response): Promise<T> {
  return (await r.json()) as T;
}

async function makeBlocks() {
  const a = await json(await call('POST', `/projects/${P1}/parcels`, 'editor@x', { kind: 'reference_block', blockId: 'B01', geometry: sq(0, 0, 20) }));
  const b = await json(await call('POST', `/projects/${P1}/parcels`, 'editor@x', { kind: 'reference_block', blockId: 'B02', geometry: sq(20, 0, 20) }));
  return [a.id as string, b.id as string];
}

describe('權限與專案隔離', () => {
  it('正式環境未設定 Access 時 API 一律 401（fail closed）', async () => {
    const r = await app.request('/api/projects', {}, { DB: db });
    expect(r.status).toBe(401);
    expect((await json(r)).error_code).toBe('auth_not_configured');
  });

  it('非成員讀別人的專案得到 404，不透露存在', async () => {
    expect((await call('GET', `/projects/${P1}/scene`, 'stranger@x')).status).toBe(404);
    expect((await call('GET', `/projects/${P2}/scene`, 'owner@x')).status).toBe(404);
  });

  it('viewer 可讀不可改', async () => {
    expect((await call('GET', `/projects/${P1}/scene`, 'viewer@x')).status).toBe(200);
    const r = await call('POST', `/projects/${P1}/developments`, 'viewer@x', { code: 'X', name: 'x' });
    expect(r.status).toBe(403);
  });

  it('不能把其他專案的土地連到本專案建案（API 與資料庫雙重擋）', async () => {
    const other = await json(await call('POST', `/projects/${P2}/parcels`, 'other@x', { kind: 'reference_block', blockId: 'X1', geometry: sq(0, 0, 5) }));
    const dev = await json(await call('POST', `/projects/${P1}/developments`, 'editor@x', { code: 'D1', name: '測試案' }));
    const r = await call('PUT', `/developments/${dev.id}/parcels`, 'editor@x', { expectedVersion: 1, parcelIds: [other.id] });
    expect(r.status).toBe(422);
    expect((await json(r)).error_code).toBe('cross_project_link');
  });

  it('不能在其他專案的情境建立棟別', async () => {
    const dev = await json(await call('POST', `/projects/${P1}/developments`, 'editor@x', { code: 'D1', name: '測試案' }));
    const r = await call('POST', `/developments/${dev.id}/buildings`, 'editor@x', { scenarioId: S_P2, building: building('A棟') });
    expect(r.status).toBe(404);
  });
});

describe('建案、多地號、多建商、多棟', () => {
  it('一案多地號＋多建商＋兩棟，基地面積不重複加總', async () => {
    const [a, b] = await makeBlocks();
    const dev = await json(await call('POST', `/projects/${P1}/developments`, 'editor@x', { code: 'D1', name: '測試案' }));
    let r = await call('PUT', `/developments/${dev.id}/parcels`, 'editor@x', { expectedVersion: 1, parcelIds: [a, b] });
    expect(r.status).toBe(200);
    const d1 = await json(await call('POST', `/projects/${P1}/developers`, 'editor@x', { companyName: '甲建設股份有限公司', brandName: null, taxId: null }));
    const d2 = await json(await call('POST', `/projects/${P1}/developers`, 'editor@x', { companyName: '乙營造', brandName: null, taxId: null }));
    r = await call('PUT', `/developments/${dev.id}/developers`, 'editor@x', {
      expectedVersion: 2, developers: [{ developerId: d1.id, role: 'main' }, { developerId: d2.id, role: 'co' }],
    });
    expect(r.status).toBe(200);
    // A 棟跨兩筆地號（x=15..25 跨 x=20）
    r = await call('POST', `/developments/${dev.id}/buildings`, 'editor@x', { scenarioId: S_OBS, building: building('A棟', sq(15, 5, 10)) });
    expect(r.status).toBe(201);
    expect((await json(r)).site).toEqual({ status: 'inside' });
    r = await call('POST', `/developments/${dev.id}/buildings`, 'editor@x', { scenarioId: S_OBS, building: building('B棟', sq(2, 2, 8)) });
    expect(r.status).toBe(201);

    const scene = await json<SceneDTO>(await call('GET', `/projects/${P1}/scene`, 'viewer@x'));
    const d = scene.developments.find((x) => x.code === 'D1')!;
    expect(d.parcelIds.sort()).toEqual([a, b].sort());
    expect(d.developers).toHaveLength(2);
    expect(scene.buildings.filter((x) => x.developmentId === dev.id)).toHaveLength(2);
    expect(scene.parcels.find((p) => p.id === a)!.developmentIds).toEqual([dev.id]);
  });

  it('超出基地聯集時回報 outside（只提示，不改地界）', async () => {
    const [a] = await makeBlocks();
    const dev = await json(await call('POST', `/projects/${P1}/developments`, 'editor@x', { code: 'D1', name: '測試案' }));
    await call('PUT', `/developments/${dev.id}/parcels`, 'editor@x', { expectedVersion: 1, parcelIds: [a] });
    const r = await json(await call('POST', `/developments/${dev.id}/buildings`, 'editor@x', { scenarioId: S_OBS, building: building('A棟', sq(15, 5, 10)) }));
    expect(r.site.status).toBe('outside');
  });

  it('自交 footprint 被拒；未知樓高保持 null', async () => {
    const dev = await json(await call('POST', `/projects/${P1}/developments`, 'editor@x', { code: 'D1', name: '測試案' }));
    const bow = [[[0, 0], [10, 10], [10, 0], [0, 10]]];
    expect((await call('POST', `/developments/${dev.id}/buildings`, 'editor@x', { scenarioId: S_OBS, building: building('X', bow) })).status).toBe(422);
    const r = await json(await call('POST', `/developments/${dev.id}/buildings`, 'editor@x', { scenarioId: S_OBS, building: building('C棟', sq(0, 0, 5), null) }));
    expect(r.building.segments[0].heightM).toBeNull();
    expect(r.building.floorsAboveGround).toBeNull();
  });

  it('只有年份的預計完工不能塞成完整日期', async () => {
    const r = await call('POST', `/projects/${P1}/developments`, 'editor@x', { code: 'D2', name: 'x', completionKind: 'estimated', completionDate: '2028-01-01', completionPrecision: 'year' });
    expect(r.status).toBe(422);
    const ok = await call('POST', `/projects/${P1}/developments`, 'editor@x', { code: 'D3', name: 'y', completionKind: 'estimated', completionDate: '2028', completionPrecision: 'year' });
    expect(ok.status).toBe(201);
  });
});

describe('版本、情境與並行修改', () => {
  it('修改棟別建立新版本，只影響目前情境，不產生幽靈棟', async () => {
    const dev = await json(await call('POST', `/projects/${P1}/developments`, 'editor@x', { code: 'D1', name: '測試案' }));
    const created = await json(await call('POST', `/developments/${dev.id}/buildings`, 'editor@x', { scenarioId: S_OBS, building: building('A棟') }));
    const bid = created.building.id;
    // 複製現況為規劃情境（只複製引用）
    const plan = await json(await call('POST', `/projects/${P1}/scenarios`, 'editor@x', {
      kind: 'planned', name: '2028 規劃', dataAsOf: null, targetDate: '2028', targetPrecision: 'year', baseScenarioId: S_OBS,
    }));
    const r = await call('POST', `/buildings/${bid}/versions`, 'editor@x', { scenarioId: plan.id, expectedVersionId: created.building.versionId, building: building('A棟', sq(5, 5, 10), 25) });
    expect(r.status).toBe(200);

    const obs = await json<SceneDTO>(await call('GET', `/projects/${P1}/scene?scenario_id=${S_OBS}`, 'viewer@x'));
    const pl = await json<SceneDTO>(await call('GET', `/projects/${P1}/scene?scenario_id=${plan.id}`, 'viewer@x'));
    expect(obs.buildings).toHaveLength(1);
    expect(pl.buildings).toHaveLength(1);
    expect(obs.buildings[0]!.floorsAboveGround).toBe(15);
    expect(pl.buildings[0]!.floorsAboveGround).toBe(25);
    expect(pl.buildings[0]!.id).toBe(obs.buildings[0]!.id);
  });

  it('兩頁同時修改：後送出的得到 409', async () => {
    const dev = await json(await call('POST', `/projects/${P1}/developments`, 'editor@x', { code: 'D1', name: '測試案' }));
    const created = await json(await call('POST', `/developments/${dev.id}/buildings`, 'editor@x', { scenarioId: S_OBS, building: building('A棟') }));
    const body = (f: number) => ({ scenarioId: S_OBS, expectedVersionId: created.building.versionId, building: building('A棟', sq(5, 5, 10), f) });
    expect((await call('POST', `/buildings/${created.building.id}/versions`, 'editor@x', body(20))).status).toBe(200);
    const late = await call('POST', `/buildings/${created.building.id}/versions`, 'owner@x', body(30));
    expect(late.status).toBe(409);
    expect((await json(late)).error_code).toBe('version_conflict');
    const s = await json<SceneDTO>(await call('GET', `/projects/${P1}/scene`, 'viewer@x'));
    expect(s.buildings).toHaveLength(1);
    expect(s.buildings[0]!.floorsAboveGround).toBe(20);
  });

  it('建案 PATCH 版本衝突回 409', async () => {
    const dev = await json(await call('POST', `/projects/${P1}/developments`, 'editor@x', { code: 'D1', name: '測試案' }));
    expect((await call('PATCH', `/developments/${dev.id}`, 'editor@x', { expectedVersion: 1, patch: { name: '新名' } })).status).toBe(200);
    expect((await call('PATCH', `/developments/${dev.id}`, 'editor@x', { expectedVersion: 1, patch: { name: '舊頁面' } })).status).toBe(409);
  });

  it('版本列不可修改（資料庫層）', async () => {
    const dev = await json(await call('POST', `/projects/${P1}/developments`, 'editor@x', { code: 'D1', name: '測試案' }));
    const created = await json(await call('POST', `/developments/${dev.id}/buildings`, 'editor@x', { scenarioId: S_OBS, building: building('A棟') }));
    await expect(db.prepare('UPDATE building_versions SET note = ? WHERE id = ?').bind('x', created.building.versionId).run()).rejects.toThrow(/immutable_version/);
  });
});

describe('搜尋', () => {
  it('完整地籍鍵唯一定位；查不到回空陣列', async () => {
    await call('POST', `/projects/${P1}/parcels`, 'editor@x', { kind: 'cadastral', county: '桃園市', district: '中壢區', sectionCode: 'TEST01', sectionName: '測試段', landRaw: '123-4' });
    await call('POST', `/projects/${P1}/parcels`, 'editor@x', { kind: 'cadastral', county: '桃園市', district: '中壢區', sectionCode: 'TEST02', sectionName: '另一段', landRaw: '123-4' });
    const one = await json(await call('GET', `/projects/${P1}/parcels/search?q=${encodeURIComponent('測試段 123-4')}`, 'viewer@x'));
    expect(one.matches).toHaveLength(1);
    const amb = await json(await call('GET', `/projects/${P1}/parcels/search?q=${encodeURIComponent('123-4')}`, 'viewer@x'));
    expect(amb.matches).toHaveLength(2);
    expect(amb.ambiguous).toBe(true);
    const none = await json(await call('GET', `/projects/${P1}/parcels/search?q=999`, 'viewer@x'));
    expect(none.matches).toEqual([]);
  });
});

describe('CSV 匯入', () => {
  const csv = (rows: Partial<Record<(typeof TEMPLATE_HEADERS)[number], string>>[]) =>
    '﻿' + [TEMPLATE_HEADERS.join(','), ...rows.map((r) => TEMPLATE_HEADERS.map((h) => r[h] ?? '').join(','))].join('\r\n');
  const base = { 縣市: '桃園市', 行政區: '中壢區', 地段代碼: 'TEST01', 地段名稱: '測試段' };

  async function preview(text: string) {
    return json(await call('POST', `/projects/${P1}/imports/preview`, 'editor@x', undefined, text));
  }

  it('逐列驗證＋預覽不改正式資料', async () => {
    const p = await preview(csv([
      { ...base, 地號母號: '100', 建案代碼: 'T-1', 建案名稱: '測試建案', 開發商公司名稱: '甲建設', 開發角色: '主要開發', 預計完工年份: '2028' },
      { ...base, 地號母號: '101', 地號子號: '2', 建案代碼: 'T-1', 建案名稱: '測試建案', 開發商公司名稱: '甲建設' },
      { ...base, 地號母號: 'abc', 建案代碼: 'T-2', 建案名稱: 'x' },
      { 縣市: '桃園市', 行政區: '中壢區', 地號母號: '5', 建案代碼: 'T-3', 建案名稱: 'y' },
      { ...base, 地號母號: '7', 建案代碼: 'T-4', 建案名稱: 'z', 開發角色: '共同開發' },
      { ...base, 地號母號: '8', 建案代碼: 'T-5', 建案名稱: 'w', 資料日期: '2026/10/22' },
    ]));
    expect(p.plan.summary).toEqual({ create: 2, update: 0, unchanged: 0, error: 3, needs_review: 1 });
    const errRow = p.plan.rows.find((r: any) => r.rowNumber === 4);
    expect(errRow.messages[0]).toMatchObject({ column: '地號母號' });
    expect(p.plan.rows.find((r: any) => r.rowNumber === 5).outcome).toBe('needs_review');
    const scene = await json<SceneDTO>(await call('GET', `/projects/${P1}/scene`, 'viewer@x'));
    expect(scene.developments).toHaveLength(0);
  });

  it('all_or_nothing 有錯誤列時拒絕；valid_only 只套有效列；重送冪等；撤回乾淨', async () => {
    const p = await preview(csv([
      { ...base, 地號母號: '100', 建案代碼: 'T-1', 建案名稱: '測試建案', 開發商公司名稱: '甲建設', 開發角色: '主要開發', 預計完工年份: '2028' },
      { ...base, 地號母號: '101', 建案代碼: 'T-1', 建案名稱: '測試建案', 開發商公司名稱: '甲建設' },
      { ...base, 地號母號: 'abc', 建案代碼: 'T-2', 建案名稱: 'x' },
    ]));
    expect((await call('POST', `/imports/${p.batchId}/commit`, 'editor@x', { mode: 'all_or_nothing', idempotencyKey: 'key-00001' })).status).toBe(422);
    const c1 = await json(await call('POST', `/imports/${p.batchId}/commit`, 'editor@x', { mode: 'valid_only', idempotencyKey: 'key-00001' }));
    expect(c1.report.applied).toBe(2);
    const c2 = await json(await call('POST', `/imports/${p.batchId}/commit`, 'editor@x', { mode: 'valid_only', idempotencyKey: 'key-00001' }));
    expect(c2.replayed).toBe(true);

    let scene = await json<SceneDTO>(await call('GET', `/projects/${P1}/scene`, 'viewer@x'));
    expect(scene.developments).toHaveLength(1);
    expect(scene.developments[0]).toMatchObject({ code: 'T-1', completionDate: '2028', completionPrecision: 'year' });
    expect(scene.developments[0]!.parcelIds).toHaveLength(2);
    expect(scene.parcels.filter((x) => x.kind === 'cadastral').every((x) => x.geometry === null)).toBe(true);
    expect(scene.developers).toHaveLength(1);

    // 同一份 CSV 再匯一次：全部 unchanged，不新增重複關聯
    const again = await preview(csv([
      { ...base, 地號母號: '100', 建案代碼: 'T-1', 建案名稱: '測試建案', 開發商公司名稱: '甲建設', 開發角色: '主要開發', 預計完工年份: '2028' },
      { ...base, 地號母號: '101', 建案代碼: 'T-1', 建案名稱: '測試建案', 開發商公司名稱: '甲建設' },
    ]));
    expect(again.plan.summary.unchanged).toBe(2);

    const rb = await json(await call('POST', `/imports/${p.batchId}/rollback`, 'editor@x', {}));
    expect(rb.kept).toEqual([]);
    scene = await json<SceneDTO>(await call('GET', `/projects/${P1}/scene`, 'viewer@x'));
    expect(scene.developments).toHaveLength(0);
    expect(scene.parcels).toHaveLength(0);
    expect(scene.developers).toHaveLength(0);
  });

  it('空白欄不覆蓋既有值；同建案代碼案名不一致顯示衝突', async () => {
    const p = await preview(csv([{ ...base, 地號母號: '100', 建案代碼: 'T-1', 建案名稱: '測試建案', 建案狀態: '施工' }]));
    await call('POST', `/imports/${p.batchId}/commit`, 'editor@x', { mode: 'all_or_nothing', idempotencyKey: 'key-00002' });
    const p2 = await preview(csv([{ ...base, 地號母號: '100', 建案代碼: 'T-1', 建案名稱: '' }]));
    expect(p2.plan.rows[0].outcome).toBe('unchanged');
    const p3 = await preview(csv([
      { ...base, 地號母號: '100', 建案代碼: 'T-9', 建案名稱: '甲' },
      { ...base, 地號母號: '101', 建案代碼: 'T-9', 建案名稱: '乙' },
    ]));
    expect(p3.plan.rows.every((r: any) => r.outcome === 'error')).toBe(true);
  });

  it('預覽後資料變動 → commit 要求重新預覽', async () => {
    const p = await preview(csv([{ ...base, 地號母號: '100', 建案代碼: 'T-1', 建案名稱: '測試建案' }]));
    await call('POST', `/projects/${P1}/developments`, 'editor@x', { code: 'T-1', name: '別人先建了' });
    const r = await call('POST', `/imports/${p.batchId}/commit`, 'editor@x', { mode: 'valid_only', idempotencyKey: 'key-00003' });
    expect(r.status).toBe(409);
    expect((await json(r)).error_code).toBe('preview_stale');
  });

  it('缺欄位的 CSV 回報標題錯誤', async () => {
    const p = await preview('縣市,地號\n桃園市,1');
    expect(p.plan.headerErrors[0]).toMatch(/缺少欄位/);
  });
});

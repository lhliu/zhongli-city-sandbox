// 產生 D1 種子 SQL。
//   node seed/build_seed.mjs [擁有者email]
// 輸出：
//   seed/seed_reference.sql  官方圖資＋參考描繪（可用於正式環境）
//   seed/seed_demo.sql       DEMO 示範資料（只供本機開發，is_demo=1，不可發布）
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const owner = (process.argv[2] ?? 'dev@local').toLowerCase();
const trace = JSON.parse(readFileSync(join(here, 's2_trace.json'), 'utf8'));
const registry = JSON.parse(readFileSync(join(root, 'sources', 'registry.json'), 'utf8'));

const PROJECT = '5a1e0000-0000-4000-8000-000000000001';
const SCN_OBSERVED = '5a1e0000-0000-4000-8000-0000000000a1';
const SCN_PLANNED = '5a1e0000-0000-4000-8000-0000000000a2';
const LAYER_S2 = '5a1e0000-0000-4000-8000-0000000000b1';
const CAL_S2 = '5a1e0000-0000-4000-8000-0000000000c1';
const srcId = (code) => `5a1e0000-0000-4000-8000-0000000005${code.slice(1).padStart(2, '0')}`;

// S2 比例尺量測：4 格 × 40m = 72px
const MPP = 160 / 72;
// 局部原點：範圍界線像素重心（取整數）
const ring = trace.boundary;
let a = 0, cx = 0, cy = 0;
for (let i = 0; i < ring.length; i++) {
  const [x1, y1] = ring[i];
  const [x2, y2] = ring[(i + 1) % ring.length];
  const f = x1 * y2 - x2 * y1;
  a += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f;
}
const ORIGIN = [Math.round(cx / (3 * a)), Math.round(cy / (3 * a))];
const toLocal = ([x, y]) => [round2((x - ORIGIN[0]) * MPP), round2((y - ORIGIN[1]) * MPP)];
const round2 = (n) => Math.round(n * 100) / 100;
const q = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const uuid = (prefix, i) => `5a1e0000-0000-4000-8000-${prefix}${String(i).padStart(12 - prefix.length, '0')}`;

const frame = { kind: 'image', sourceId: 'S2', metersPerPixel: round6(MPP), originPx: ORIGIN, northUp: true };
function round6(n) { return Math.round(n * 1e6) / 1e6; }

const out = [];
out.push('-- 由 seed/build_seed.mjs 產生；請勿手改');
out.push('PRAGMA foreign_keys = ON;');
out.push(`INSERT INTO projects (id, name, frame_json, default_scenario_id, created_by) VALUES (${q(PROJECT)}, ${q('中壢體育園區（中壢運動公園區段徵收開發案）')}, ${q(JSON.stringify(frame))}, ${q(SCN_OBSERVED)}, ${q(owner)});`);
out.push(`INSERT INTO project_members (project_id, user_email, role) VALUES (${q(PROJECT)}, ${q(owner)}, 'owner');`);

for (const s of registry.sources) {
  const meta = { ...s };
  out.push(`INSERT INTO source_documents (id, project_id, code, title, publisher, url, retrieved_at, sha256, local_path, page_ref, license_status, license_note, license_checked_at, is_latest_note, meta_json) VALUES (${[
    srcId(s.id), PROJECT, s.id, s.title, s.publisher ?? null, s.url, s.retrieved_at ?? null, s.sha256 ?? null, s.local_file ?? null,
    s.page_used ?? s.page_version ?? null, s.license_status, s.license_note ?? s.status ?? null, s.retrieved_at ? '2026-10-22' : null,
    s.is_latest ?? null, JSON.stringify(meta),
  ].map(q).join(', ')});`);
}

const s2 = registry.sources.find((s) => s.id === 'S2');
out.push(`INSERT INTO map_layers (id, project_id, source_id, kind, title, asset_url, pixel_w, pixel_h, status, sort_order, default_opacity) VALUES (${[
  LAYER_S2, PROJECT, srcId('S2'), 'image', 'S2 官方範圍圖（參考底圖）', '/basemaps/S2.jpg', s2.pixel_size[0], s2.pixel_size[1], 'reference', 0, 1,
].map(q).join(', ')});`);
// 像素 → 局部公尺：x = s·(px − ox)，z = s·(py − oy)
const transform = [round6(MPP), 0, round6(-MPP * ORIGIN[0]), 0, round6(MPP), round6(-MPP * ORIGIN[1])];
out.push(`INSERT INTO map_calibrations (id, project_id, layer_id, method, control_points_json, transform_json, passes_threshold, note, created_by) VALUES (${[
  CAL_S2, PROJECT, LAYER_S2, 'scale_bar', '[]', JSON.stringify(transform), 0,
  '比例尺量測 160m/72px ≈ 2.222 m/px（±5.6%）；圖面座標模式，未做地理校準，不能輸出經緯度', owner,
].map(q).join(', ')});`);
out.push(`UPDATE map_layers SET calibration_id = ${q(CAL_S2)} WHERE id = ${q(LAYER_S2)};`);

out.push(`INSERT INTO map_features (id, project_id, kind, label, coord_space, geometry_json, source_id, verification, note) VALUES (${[
  uuid('f', 0), PROJECT, 'boundary', '區段徵收範圍（S2 紅色虛線，參考描繪）', 'local_m', JSON.stringify([ring.map(toLocal)]), srcId('S2'), 'pending',
  `由 S2 人工描 ${ring.length} 點；面積約 ${Math.round(polyArea(ring.map(toLocal)) / 1000) / 10} 公頃（官方區徵 72.97、都計 74.2 公頃）`,
].map(q).join(', ')});`);
trace.features.forEach((f, i) => {
  out.push(`INSERT INTO map_features (id, project_id, kind, label, coord_space, geometry_json, source_id, verification, note) VALUES (${[
    uuid('f', i + 1), PROJECT, f.kind, f.label, 'local_m', JSON.stringify([f.px.map(toLocal)]), srcId('S2'), 'pending', '參考描繪，待複核',
  ].map(q).join(', ')});`);
});

trace.blocks.forEach((b, i) => {
  const pid = uuid('d', i + 1);
  const vid = uuid('e', i + 1);
  out.push(`INSERT INTO parcels (id, project_id, kind, block_id, label, zoning, verification, current_version_id, note) VALUES (${[
    pid, PROJECT, 'reference_block', b.block_id, `${b.block_id}（${b.zoning}）`, b.zoning, 'pending', vid,
    '參考區塊：S2 街廓描繪，沒有地號；不可用於精準面積、退縮或權界判斷',
  ].map(q).join(', ')});`);
  out.push(`INSERT INTO parcel_versions (id, parcel_id, project_id, version, coord_space, geometry_json, source_px_json, source_id, quality_note, created_by) VALUES (${[
    vid, pid, PROJECT, 1, 'local_m', JSON.stringify([b.px.map(toLocal)]), JSON.stringify([b.px]), srcId('S2'),
    '人工判讀 S2 像素描點；比例尺誤差約 ±5.6%，描點誤差約 1–2px（2–4m）', owner,
  ].map(q).join(', ')});`);
});

out.push(`INSERT INTO scenarios (id, project_id, kind, name, data_as_of, target_date, target_precision) VALUES (${[SCN_OBSERVED, PROJECT, 'observed', '已確認現況', null, null, null].map(q).join(', ')});`);
out.push(`INSERT INTO scenarios (id, project_id, kind, name, data_as_of, target_date, target_precision) VALUES (${[SCN_PLANNED, PROJECT, 'planned', '公開規劃', null, null, null].map(q).join(', ')});`);

writeFileSync(join(here, 'seed_reference.sql'), out.join('\n') + '\n');

// ───────── DEMO（只供本機開發） ─────────
const demo = [];
const SCN_DEMO = '5a1e0000-0000-4000-8000-0000000000af';
const DEV = '5a1e0000-0000-4000-8000-00000000de01';
demo.push('-- DEMO 示範資料：虛構建案，僅供本機開發與功能驗收；is_demo=1，不可發布、不可當真實資料');
demo.push(`INSERT INTO scenarios (id, project_id, kind, name, is_demo) VALUES (${[SCN_DEMO, PROJECT, 'assumption', 'DEMO 假設情境（非真實）', 1].map(q).join(', ')});`);
demo.push(`INSERT INTO developments (id, project_id, code, name, description, status, is_demo, verification) VALUES (${[
  DEV, PROJECT, 'DEMO-001', 'DEMO 示範建案（虛構）', '功能驗收用：一案跨兩個參考區塊、兩棟量體。名稱、樓高、位置皆為虛構。', 'planned', 1, 'estimated',
].map(q).join(', ')});`);
const r06 = uuid('d', trace.blocks.findIndex((b) => b.block_id === 'S2-R06') + 1);
const r07 = uuid('d', trace.blocks.findIndex((b) => b.block_id === 'S2-R07') + 1);
demo.push(`INSERT INTO development_parcels (development_id, parcel_id, project_id, evidence_note) VALUES (${q(DEV)}, ${q(r06)}, ${q(PROJECT)}, 'DEMO');`);
demo.push(`INSERT INTO development_parcels (development_id, parcel_id, project_id, evidence_note) VALUES (${q(DEV)}, ${q(r07)}, ${q(PROJECT)}, 'DEMO');`);
const center = (pts) => toLocal([pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length]);
const rect = ([x, z], w, d) => [[[x - w / 2, z - d / 2], [x + w / 2, z - d / 2], [x + w / 2, z + d / 2], [x - w / 2, z + d / 2]].map(([a, b]) => [round2(a), round2(b)])];
const blocksById = Object.fromEntries(trace.blocks.map((b) => [b.block_id, b]));
[
  { label: 'A棟', at: center(blocksById['S2-R06'].px), floors: 15 },
  { label: 'B棟', at: center(blocksById['S2-R07'].px), floors: 22 },
].forEach((b, i) => {
  const bid = uuid('b', i + 1);
  const vid = uuid('c', i + 1);
  const h = round2(4.2 + (b.floors - 1) * 3.3);
  demo.push(`INSERT INTO buildings (id, project_id, development_id, label, current_version_id) VALUES (${[bid, PROJECT, DEV, b.label, vid].map(q).join(', ')});`);
  demo.push(`INSERT INTO building_versions (id, building_id, project_id, version, footprint_json, footprint_is_assumed, segments_json, floors_above_ground, assumption_json, attribute, note, created_by) VALUES (${[
    vid, bid, PROJECT, 1, JSON.stringify(rect(b.at, 24, 18)), 1, JSON.stringify([{ baseHeightM: 0, heightM: h, heightSource: 'estimated' }]), b.floors,
    JSON.stringify({ firstFloorHeightM: 4.2, typicalFloorHeightM: 3.3, roofExtraHeightM: 0 }), 'assumption', 'DEMO：虛構量體', owner,
  ].map(q).join(', ')});`);
  demo.push(`INSERT INTO scenario_items (scenario_id, project_id, building_id, building_version_id) VALUES (${[SCN_DEMO, PROJECT, bid, vid].map(q).join(', ')});`);
});
writeFileSync(join(here, 'seed_demo.sql'), demo.join('\n') + '\n');

console.log(`origin px ${ORIGIN}, m/px ${MPP.toFixed(4)}, blocks ${trace.blocks.length}, boundary ≈ ${(polyArea(ring.map(toLocal)) / 1e4).toFixed(2)} ha`);

function polyArea(r) {
  let s = 0;
  for (let i = 0; i < r.length; i++) {
    const [x1, y1] = r[i];
    const [x2, y2] = r[(i + 1) % r.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s / 2);
}

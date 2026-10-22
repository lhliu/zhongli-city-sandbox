-- KC 城市沙盤 P0 資料模型（規格 §7.3）
-- D1（SQLite）沒有 PostGIS：幾何以 JSON 保存於 *_json 欄位，coord_space 標明座標空間；
-- 權威幾何檢查在 API 層（src/lib/geometry）。D1 沒有 RLS：權限在 API 層檢查，
-- 跨專案連結由下方 trigger 在資料庫層拒絕。
PRAGMA foreign_keys = ON;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- 專案座標框架（src/lib/geo/frame.ts ProjectFrame）
  frame_json TEXT NOT NULL,
  frame_version INTEGER NOT NULL DEFAULT 1,
  default_scenario_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL
);

CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (project_id, user_email)
);

CREATE TABLE source_documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  publisher TEXT,
  url TEXT,
  published_note TEXT,
  retrieved_at TEXT,
  sha256 TEXT,
  local_path TEXT,
  page_ref TEXT,
  license_status TEXT NOT NULL DEFAULT 'unknown' CHECK (license_status IN ('unknown','internal_only','redistributable','restricted')),
  license_note TEXT,
  license_checked_at TEXT,
  is_latest_note TEXT,
  meta_json TEXT,
  UNIQUE (project_id, code)
);

CREATE TABLE map_layers (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_id TEXT REFERENCES source_documents(id),
  kind TEXT NOT NULL CHECK (kind IN ('image','vector')),
  title TEXT NOT NULL,
  asset_url TEXT NOT NULL,
  pixel_w INTEGER,
  pixel_h INTEGER,
  calibration_id TEXT,
  -- reference＝參考底圖；calibrated＝通過顯示門檻
  status TEXT NOT NULL DEFAULT 'reference' CHECK (status IN ('reference','calibrated')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  default_opacity REAL NOT NULL DEFAULT 1
);

CREATE TABLE map_calibrations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  layer_id TEXT NOT NULL REFERENCES map_layers(id) ON DELETE CASCADE,
  -- scale_bar：比例尺量測（圖面座標）；affine：控制點擬合到專案局部座標
  method TEXT NOT NULL CHECK (method IN ('scale_bar','affine')),
  control_points_json TEXT NOT NULL DEFAULT '[]',
  transform_json TEXT NOT NULL,
  fit_rmse_m REAL,
  check_rmse_m REAL,
  check_max_m REAL,
  passes_threshold INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL
);

-- 地籍土地與參考區塊。地號文字不是主鍵；參考區塊沒有地號，用 block_id。
CREATE TABLE parcels (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('cadastral','reference_block')),
  block_id TEXT,
  county TEXT,
  district TEXT,
  section_code TEXT,
  section_name TEXT,
  land_main TEXT,
  land_sub TEXT,
  land_raw TEXT,
  label TEXT,
  zoning TEXT,
  registered_area_m2 REAL,
  registered_area_source TEXT,
  verification TEXT NOT NULL DEFAULT 'pending' CHECK (verification IN ('pending','verified','estimated')),
  valid_from TEXT,
  valid_to TEXT,
  current_version_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (kind <> 'reference_block' OR (block_id IS NOT NULL AND land_main IS NULL)),
  CHECK (kind <> 'cadastral' OR (land_main IS NOT NULL AND land_sub IS NOT NULL))
);
CREATE UNIQUE INDEX parcels_active_cadastral_key ON parcels (project_id, county, district, section_code, land_main, land_sub)
  WHERE kind = 'cadastral' AND valid_to IS NULL;
CREATE UNIQUE INDEX parcels_block_id ON parcels (project_id, block_id) WHERE kind = 'reference_block';
CREATE INDEX parcels_land_main ON parcels (project_id, land_main, land_sub);

CREATE TABLE parcel_versions (
  id TEXT PRIMARY KEY,
  parcel_id TEXT NOT NULL REFERENCES parcels(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  coord_space TEXT NOT NULL CHECK (coord_space IN ('local_m','wgs84')),
  -- PolygonRings（[[x,z],...][]）或 MultiPolygon
  geometry_json TEXT NOT NULL,
  -- 原始像素描點（圖面座標模式），保留追溯
  source_px_json TEXT,
  source_id TEXT REFERENCES source_documents(id),
  quality_note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL,
  UNIQUE (parcel_id, version)
);

CREATE TABLE parcel_lineage (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  predecessor_id TEXT NOT NULL REFERENCES parcels(id),
  successor_id TEXT NOT NULL REFERENCES parcels(id),
  relation TEXT NOT NULL CHECK (relation IN ('split','merge','renumber')),
  evidence_source_id TEXT REFERENCES source_documents(id),
  note TEXT
);

-- 範圍、分區、道路、公園、公共設施；與 parcels 分開保存
CREATE TABLE map_features (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('boundary','zone','road','park','public_facility','landmark')),
  label TEXT,
  coord_space TEXT NOT NULL CHECK (coord_space IN ('local_m','wgs84')),
  geometry_json TEXT NOT NULL,
  source_id TEXT REFERENCES source_documents(id),
  verification TEXT NOT NULL DEFAULT 'pending' CHECK (verification IN ('pending','verified','estimated')),
  note TEXT,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE developers (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  company_name TEXT,
  brand_name TEXT,
  tax_id TEXT,
  note TEXT,
  CHECK (company_name IS NOT NULL OR brand_name IS NOT NULL)
);

CREATE TABLE developments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown','vacant','site_prep','construction','completed','demolished','planned')),
  completion_kind TEXT CHECK (completion_kind IN ('actual','estimated')),
  completion_date TEXT,
  completion_precision TEXT CHECK (completion_precision IN ('day','month','year')),
  color TEXT,
  visibility TEXT NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal','public')),
  is_demo INTEGER NOT NULL DEFAULT 0,
  data_date TEXT,
  verification TEXT NOT NULL DEFAULT 'pending' CHECK (verification IN ('pending','verified','estimated')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (project_id, code),
  -- 只有年份就不補造日期：completion_date 長度須符合精度
  CHECK (completion_date IS NULL OR completion_precision IS NOT NULL),
  CHECK (completion_precision IS NULL OR
         (completion_precision = 'year' AND length(completion_date) = 4) OR
         (completion_precision = 'month' AND length(completion_date) = 7) OR
         (completion_precision = 'day' AND length(completion_date) = 10))
);

CREATE TABLE development_parcels (
  development_id TEXT NOT NULL REFERENCES developments(id) ON DELETE CASCADE,
  parcel_id TEXT NOT NULL REFERENCES parcels(id),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  valid_from TEXT,
  valid_to TEXT,
  evidence_source_id TEXT REFERENCES source_documents(id),
  evidence_note TEXT,
  import_batch_id TEXT,
  PRIMARY KEY (development_id, parcel_id)
);

CREATE TABLE development_developers (
  development_id TEXT NOT NULL REFERENCES developments(id) ON DELETE CASCADE,
  developer_id TEXT NOT NULL REFERENCES developers(id),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('main','co','pending')),
  since TEXT,
  PRIMARY KEY (development_id, developer_id)
);

CREATE TABLE buildings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  development_id TEXT NOT NULL REFERENCES developments(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  current_version_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 不可變版本；情境固定引用版本 ID
CREATE TABLE building_versions (
  id TEXT PRIMARY KEY,
  building_id TEXT NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  -- 局部公尺 PolygonRings
  footprint_json TEXT NOT NULL,
  footprint_is_assumed INTEGER NOT NULL DEFAULT 1,
  base_elevation_m REAL NOT NULL DEFAULT 0,
  -- Segment[]（src/lib/geometry/height.ts）；heightM 可為 null（未知）
  segments_json TEXT NOT NULL,
  floors_above_ground INTEGER,
  floors_below_ground INTEGER,
  assumption_json TEXT,
  -- verified 已核對／planned 公開規劃／estimated AI 推估／assumption KC 假設
  attribute TEXT NOT NULL CHECK (attribute IN ('verified','planned','estimated','assumption')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL,
  UNIQUE (building_id, version)
);

CREATE TABLE scenarios (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('observed','planned','assumption')),
  name TEXT NOT NULL,
  data_as_of TEXT,
  target_date TEXT,
  target_precision TEXT CHECK (target_precision IN ('day','month','year')),
  base_scenario_id TEXT REFERENCES scenarios(id),
  is_demo INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE scenario_items (
  scenario_id TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  building_id TEXT NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  building_version_id TEXT NOT NULL REFERENCES building_versions(id),
  PRIMARY KEY (scenario_id, building_id)
);

CREATE TABLE camera_bookmarks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scenario_id TEXT REFERENCES scenarios(id) ON DELETE SET NULL,
  scenario_revision INTEGER,
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('top','orbit','walk')),
  camera_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL
);

CREATE TABLE import_batches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  filename TEXT,
  content_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('previewed','committed','rolled_back','cancelled')),
  preview_json TEXT NOT NULL,
  report_json TEXT,
  idempotency_key TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL,
  committed_at TEXT,
  rolled_back_at TEXT,
  UNIQUE (project_id, idempotency_key)
);

-- 每列套用的效果，供冪等與回滾
CREATE TABLE import_row_effects (
  batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL,
  row_hash TEXT NOT NULL,
  effect_json TEXT NOT NULL,
  PRIMARY KEY (batch_id, row_hash)
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX audit_entity ON audit_events (project_id, entity_type, entity_id);

-- ── 跨專案連結防護 ──────────────────────────────────────────
CREATE TRIGGER dp_same_project BEFORE INSERT ON development_parcels
WHEN (SELECT project_id FROM developments WHERE id = NEW.development_id) IS NOT NEW.project_id
  OR (SELECT project_id FROM parcels WHERE id = NEW.parcel_id) IS NOT NEW.project_id
BEGIN SELECT RAISE(ABORT, 'cross_project_link'); END;

CREATE TRIGGER dd_same_project BEFORE INSERT ON development_developers
WHEN (SELECT project_id FROM developments WHERE id = NEW.development_id) IS NOT NEW.project_id
  OR (SELECT project_id FROM developers WHERE id = NEW.developer_id) IS NOT NEW.project_id
BEGIN SELECT RAISE(ABORT, 'cross_project_link'); END;

CREATE TRIGGER b_same_project BEFORE INSERT ON buildings
WHEN (SELECT project_id FROM developments WHERE id = NEW.development_id) IS NOT NEW.project_id
BEGIN SELECT RAISE(ABORT, 'cross_project_link'); END;

CREATE TRIGGER bv_same_project BEFORE INSERT ON building_versions
WHEN (SELECT project_id FROM buildings WHERE id = NEW.building_id) IS NOT NEW.project_id
BEGIN SELECT RAISE(ABORT, 'cross_project_link'); END;

CREATE TRIGGER pv_same_project BEFORE INSERT ON parcel_versions
WHEN (SELECT project_id FROM parcels WHERE id = NEW.parcel_id) IS NOT NEW.project_id
BEGIN SELECT RAISE(ABORT, 'cross_project_link'); END;

CREATE TRIGGER si_same_project BEFORE INSERT ON scenario_items
WHEN (SELECT project_id FROM scenarios WHERE id = NEW.scenario_id) IS NOT NEW.project_id
  OR (SELECT project_id FROM buildings WHERE id = NEW.building_id) IS NOT NEW.project_id
  OR (SELECT building_id FROM building_versions WHERE id = NEW.building_version_id) IS NOT NEW.building_id
BEGIN SELECT RAISE(ABORT, 'cross_project_link'); END;

CREATE TRIGGER si_same_project_u BEFORE UPDATE ON scenario_items
WHEN (SELECT building_id FROM building_versions WHERE id = NEW.building_version_id) IS NOT NEW.building_id
BEGIN SELECT RAISE(ABORT, 'cross_project_link'); END;

-- 版本列不可修改（情境版本不變性）
CREATE TRIGGER bv_immutable BEFORE UPDATE ON building_versions
BEGIN SELECT RAISE(ABORT, 'immutable_version'); END;
CREATE TRIGGER pv_immutable BEFORE UPDATE ON parcel_versions
BEGIN SELECT RAISE(ABORT, 'immutable_version'); END;

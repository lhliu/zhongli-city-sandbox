import type {
  BookmarkDTO, BuildingDTO, DeveloperDTO, DevelopmentDTO, FeatureDTO, LayerDTO, ParcelDTO, Role, SceneDTO, ScenarioDTO, SourceDTO,
} from '../src/lib/model/types';
import { all, first } from './db';
import { notFound } from './errors';

type Row = Record<string, unknown>;
const j = <T>(v: unknown): T => JSON.parse(String(v)) as T;
const s = (v: unknown) => (v == null ? null : String(v));
const n = (v: unknown) => (v == null ? null : Number(v));

export function scenarioDTO(r: Row): ScenarioDTO {
  return {
    id: String(r.id), kind: r.kind as ScenarioDTO['kind'], name: String(r.name), dataAsOf: s(r.data_as_of), targetDate: s(r.target_date),
    targetPrecision: s(r.target_precision) as ScenarioDTO['targetPrecision'], isDemo: !!r.is_demo, revision: Number(r.revision),
  };
}

export function buildingDTO(r: Row): BuildingDTO {
  return {
    id: String(r.building_id), developmentId: String(r.development_id), label: String(r.label), versionId: String(r.version_id),
    versionNumber: Number(r.version_number), footprint: j(r.footprint_json), footprintIsAssumed: !!r.footprint_is_assumed,
    baseElevationM: Number(r.base_elevation_m), segments: j(r.segments_json), floorsAboveGround: n(r.floors_above_ground),
    floorsBelowGround: n(r.floors_below_ground), assumption: r.assumption_json ? j(r.assumption_json) : null,
    attribute: r.attribute as BuildingDTO['attribute'], note: s(r.note),
  };
}

export const BUILDING_SELECT = `
  SELECT b.id AS building_id, b.development_id, b.label, v.id AS version_id, v.version AS version_number, v.footprint_json,
         v.footprint_is_assumed, v.base_elevation_m, v.segments_json, v.floors_above_ground, v.floors_below_ground,
         v.assumption_json, v.attribute, v.note
  FROM scenario_items si
  JOIN buildings b ON b.id = si.building_id
  JOIN building_versions v ON v.id = si.building_version_id`;

export async function loadScene(db: D1Database, projectId: string, role: Role, scenarioId: string | null): Promise<SceneDTO> {
  const p = await first<Row>(db, 'SELECT * FROM projects WHERE id = ?', projectId);
  if (!p) throw notFound('專案');
  const scenarioRows = await all<Row>(db, 'SELECT * FROM scenarios WHERE project_id = ? ORDER BY created_at', projectId);
  const scenarios = scenarioRows.map(scenarioDTO);
  const wanted = scenarioId ?? s(p.default_scenario_id);
  const scenario = scenarios.find((x) => x.id === wanted) ?? scenarios[0];
  if (!scenario) throw notFound('情境');
  if (scenarioId && scenario.id !== scenarioId) throw notFound('情境');

  const [sourceRows, layerRows, featureRows, parcelRows, linkRows, devRows, developerRows, ddRows, buildingRows, bookmarkRows] = await Promise.all([
    all<Row>(db, 'SELECT * FROM source_documents WHERE project_id = ? ORDER BY code', projectId),
    all<Row>(db, `SELECT l.*, c.method, c.transform_json, c.fit_rmse_m, c.check_rmse_m, c.check_max_m, c.passes_threshold, c.note AS cal_note
                  FROM map_layers l LEFT JOIN map_calibrations c ON c.id = l.calibration_id
                  WHERE l.project_id = ? ORDER BY l.sort_order`, projectId),
    all<Row>(db, 'SELECT * FROM map_features WHERE project_id = ?', projectId),
    all<Row>(db, `SELECT p.*, v.geometry_json, v.version AS geometry_version, v.source_id AS geometry_source_id, v.quality_note
                  FROM parcels p LEFT JOIN parcel_versions v ON v.id = p.current_version_id
                  WHERE p.project_id = ? AND p.valid_to IS NULL ORDER BY p.kind, p.block_id, p.land_main, p.land_sub`, projectId),
    all<Row>(db, 'SELECT development_id, parcel_id FROM development_parcels WHERE project_id = ?', projectId),
    all<Row>(db, 'SELECT * FROM developments WHERE project_id = ? ORDER BY code', projectId),
    all<Row>(db, 'SELECT * FROM developers WHERE project_id = ? ORDER BY company_name, brand_name', projectId),
    all<Row>(db, 'SELECT development_id, developer_id, role FROM development_developers WHERE project_id = ?', projectId),
    all<Row>(db, `${BUILDING_SELECT} WHERE si.scenario_id = ? AND si.project_id = ? ORDER BY b.label`, scenario.id, projectId),
    all<Row>(db, 'SELECT * FROM camera_bookmarks WHERE project_id = ? ORDER BY created_at', projectId),
  ]);

  const sourceCode = new Map(sourceRows.map((r) => [String(r.id), String(r.code)]));
  const sources: SourceDTO[] = sourceRows.map((r) => ({
    id: String(r.id), code: String(r.code), title: String(r.title), publisher: s(r.publisher), url: s(r.url), retrievedAt: s(r.retrieved_at),
    sha256: s(r.sha256), pageRef: s(r.page_ref), licenseStatus: r.license_status as SourceDTO['licenseStatus'], licenseNote: s(r.license_note),
    isLatestNote: s(r.is_latest_note),
  }));
  const layers: LayerDTO[] = layerRows.map((r) => ({
    id: String(r.id), title: String(r.title), assetUrl: String(r.asset_url), pixelW: n(r.pixel_w), pixelH: n(r.pixel_h),
    status: r.status as LayerDTO['status'], sourceCode: r.source_id ? sourceCode.get(String(r.source_id)) ?? null : null,
    defaultOpacity: Number(r.default_opacity),
    calibration: r.method
      ? {
          method: r.method as 'scale_bar' | 'affine', transform: j(r.transform_json), fitRmseM: n(r.fit_rmse_m), checkRmseM: n(r.check_rmse_m),
          checkMaxM: n(r.check_max_m), passesThreshold: !!r.passes_threshold, note: s(r.cal_note),
        }
      : null,
  }));
  const features: FeatureDTO[] = featureRows.map((r) => ({
    id: String(r.id), kind: r.kind as FeatureDTO['kind'], label: s(r.label), geometry: j(r.geometry_json),
    verification: r.verification as FeatureDTO['verification'], sourceCode: r.source_id ? sourceCode.get(String(r.source_id)) ?? null : null, note: s(r.note),
  }));
  const devsByParcel = new Map<string, string[]>();
  const parcelsByDev = new Map<string, string[]>();
  for (const l of linkRows) {
    const d = String(l.development_id);
    const pId = String(l.parcel_id);
    devsByParcel.set(pId, [...(devsByParcel.get(pId) ?? []), d]);
    parcelsByDev.set(d, [...(parcelsByDev.get(d) ?? []), pId]);
  }
  const parcels: ParcelDTO[] = parcelRows.map((r) => ({
    id: String(r.id), kind: r.kind as ParcelDTO['kind'], blockId: s(r.block_id), label: s(r.label), county: s(r.county), district: s(r.district),
    sectionCode: s(r.section_code), sectionName: s(r.section_name), landMain: s(r.land_main), landSub: s(r.land_sub), landRaw: s(r.land_raw),
    zoning: s(r.zoning), registeredAreaM2: n(r.registered_area_m2), verification: r.verification as ParcelDTO['verification'], version: Number(r.version),
    geometry: r.geometry_json ? j(r.geometry_json) : null, geometryVersion: n(r.geometry_version),
    sourceCode: r.geometry_source_id ? sourceCode.get(String(r.geometry_source_id)) ?? null : null, qualityNote: s(r.quality_note), note: s(r.note),
    developmentIds: devsByParcel.get(String(r.id)) ?? [],
  }));
  const ddByDev = new Map<string, DevelopmentDTO['developers']>();
  for (const r of ddRows) {
    const d = String(r.development_id);
    ddByDev.set(d, [...(ddByDev.get(d) ?? []), { developerId: String(r.developer_id), role: r.role as 'main' | 'co' | 'pending' }]);
  }
  const developments: DevelopmentDTO[] = devRows.map((r) => ({
    id: String(r.id), code: String(r.code), name: String(r.name), description: s(r.description), status: r.status as DevelopmentDTO['status'],
    completionKind: s(r.completion_kind) as DevelopmentDTO['completionKind'], completionDate: s(r.completion_date),
    completionPrecision: s(r.completion_precision) as DevelopmentDTO['completionPrecision'], color: s(r.color), isDemo: !!r.is_demo,
    dataDate: s(r.data_date), verification: r.verification as DevelopmentDTO['verification'], version: Number(r.version),
    parcelIds: parcelsByDev.get(String(r.id)) ?? [], developers: ddByDev.get(String(r.id)) ?? [],
  }));
  const developers: DeveloperDTO[] = developerRows.map((r) => ({ id: String(r.id), companyName: s(r.company_name), brandName: s(r.brand_name), taxId: s(r.tax_id) }));
  const bookmarks: BookmarkDTO[] = bookmarkRows.map((r) => ({
    id: String(r.id), name: String(r.name), mode: r.mode as BookmarkDTO['mode'], scenarioId: s(r.scenario_id), scenarioRevision: n(r.scenario_revision),
    camera: j(r.camera_json),
  }));

  return {
    project: { id: String(p.id), name: String(p.name), frame: j(p.frame_json), defaultScenarioId: s(p.default_scenario_id) },
    role, scenario, scenarios, layers, features, parcels, developments, developers, buildings: buildingRows.map(buildingDTO), bookmarks, sources,
  };
}

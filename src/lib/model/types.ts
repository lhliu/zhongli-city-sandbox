/** API 回傳的場景資料（GET /api/projects/:id/scene） */
import type { ProjectFrame } from '../geo/frame';
import type { PolygonRings } from '../geometry/polygon';
import type { Segment, FloorAssumption } from '../geometry/height';
import type { CameraState } from './schemas';

export type Role = 'owner' | 'editor' | 'viewer';
export type Verification = 'pending' | 'verified' | 'estimated';
export type BuildingAttribute = 'verified' | 'planned' | 'estimated' | 'assumption';
export type DevelopmentStatus = 'unknown' | 'vacant' | 'site_prep' | 'construction' | 'completed' | 'demolished' | 'planned';
export type ScenarioKind = 'observed' | 'planned' | 'assumption';

export type SourceDTO = {
  id: string;
  code: string;
  title: string;
  publisher: string | null;
  url: string | null;
  retrievedAt: string | null;
  sha256: string | null;
  pageRef: string | null;
  licenseStatus: 'unknown' | 'internal_only' | 'redistributable' | 'restricted';
  licenseNote: string | null;
  isLatestNote: string | null;
};

export type LayerDTO = {
  id: string;
  title: string;
  assetUrl: string;
  pixelW: number | null;
  pixelH: number | null;
  status: 'reference' | 'calibrated';
  sourceCode: string | null;
  defaultOpacity: number;
  /** 圖面像素 → 專案局部公尺 的仿射；scale_bar 亦以仿射表示 */
  calibration: {
    method: 'scale_bar' | 'affine';
    transform: [number, number, number, number, number, number];
    fitRmseM: number | null;
    checkRmseM: number | null;
    checkMaxM: number | null;
    passesThreshold: boolean;
    note: string | null;
  } | null;
};

export type FeatureDTO = {
  id: string;
  kind: 'boundary' | 'zone' | 'road' | 'park' | 'public_facility' | 'landmark';
  label: string | null;
  geometry: PolygonRings;
  verification: Verification;
  sourceCode: string | null;
  note: string | null;
};

export type ParcelDTO = {
  id: string;
  kind: 'cadastral' | 'reference_block';
  blockId: string | null;
  label: string | null;
  county: string | null;
  district: string | null;
  sectionCode: string | null;
  sectionName: string | null;
  landMain: string | null;
  landSub: string | null;
  landRaw: string | null;
  zoning: string | null;
  registeredAreaM2: number | null;
  verification: Verification;
  version: number;
  /** null＝待定位 */
  geometry: PolygonRings | null;
  geometryVersion: number | null;
  sourceCode: string | null;
  qualityNote: string | null;
  note: string | null;
  developmentIds: string[];
};

export type DeveloperDTO = { id: string; companyName: string | null; brandName: string | null; taxId: string | null };

export type DevelopmentDTO = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: DevelopmentStatus;
  completionKind: 'actual' | 'estimated' | null;
  completionDate: string | null;
  completionPrecision: 'day' | 'month' | 'year' | null;
  color: string | null;
  isDemo: boolean;
  dataDate: string | null;
  verification: Verification;
  version: number;
  parcelIds: string[];
  developers: { developerId: string; role: 'main' | 'co' | 'pending' }[];
};

export type BuildingDTO = {
  id: string;
  developmentId: string;
  label: string;
  versionId: string;
  versionNumber: number;
  footprint: PolygonRings;
  footprintIsAssumed: boolean;
  baseElevationM: number;
  segments: Segment[];
  floorsAboveGround: number | null;
  floorsBelowGround: number | null;
  assumption: FloorAssumption | null;
  attribute: BuildingAttribute;
  note: string | null;
};

export type ScenarioDTO = {
  id: string;
  kind: ScenarioKind;
  name: string;
  dataAsOf: string | null;
  targetDate: string | null;
  targetPrecision: 'day' | 'month' | 'year' | null;
  isDemo: boolean;
  revision: number;
};

export type BookmarkDTO = {
  id: string;
  name: string;
  mode: 'top' | 'orbit' | 'walk';
  scenarioId: string | null;
  scenarioRevision: number | null;
  camera: CameraState;
};

export type SceneDTO = {
  project: { id: string; name: string; frame: ProjectFrame; defaultScenarioId: string | null };
  role: Role;
  scenario: ScenarioDTO;
  scenarios: ScenarioDTO[];
  layers: LayerDTO[];
  features: FeatureDTO[];
  parcels: ParcelDTO[];
  developments: DevelopmentDTO[];
  developers: DeveloperDTO[];
  buildings: BuildingDTO[];
  bookmarks: BookmarkDTO[];
  sources: SourceDTO[];
};

export type ApiError = { error_code: string; message: string; request_id: string; details?: unknown };

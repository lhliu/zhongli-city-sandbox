/**
 * 高度計算（規格 §5.3）。未知高度一律 null，不用 0 代表未知。
 */
export type HeightSource = 'verified' | 'documented' | 'user' | 'estimated';

export type Segment = {
  /** 段底相對地面高度（裙樓為 0，塔樓可接在裙樓頂） */
  baseHeightM: number;
  /** 段身高度；null＝未知 */
  heightM: number | null;
  heightSource: HeightSource | null;
};

/** 本工具示意預設，非建案規格或法定數值 */
export const DEFAULT_FLOOR_ASSUMPTION = {
  firstFloorHeightM: 4.2,
  typicalFloorHeightM: 3.3,
  roofExtraHeightM: 0,
} as const;

export type FloorAssumption = {
  firstFloorHeightM: number;
  typicalFloorHeightM: number;
  roofExtraHeightM: number;
};

/** H = 首層 + max(地上層數 − 1, 0) × 標準層 + 屋突；層數未知回 null */
export function estimateHeightFromFloors(
  floorsAboveGround: number | null,
  a: FloorAssumption = DEFAULT_FLOOR_ASSUMPTION,
): number | null {
  if (floorsAboveGround == null || !Number.isFinite(floorsAboveGround) || floorsAboveGround < 1) return null;
  const floors = Math.floor(floorsAboveGround);
  return round2(a.firstFloorHeightM + Math.max(floors - 1, 0) * a.typicalFloorHeightM + a.roofExtraHeightM);
}

/** 模型總高＝各段頂標高最大值（不重複累加裙樓）；任一段未知則回 null */
export function totalHeight(segments: Segment[]): number | null {
  if (segments.length === 0) return null;
  let top = 0;
  for (const s of segments) {
    if (s.heightM == null) return null;
    top = Math.max(top, s.baseHeightM + s.heightM);
  }
  return round2(top);
}

const RANK: Record<HeightSource, number> = { verified: 4, documented: 3, user: 2, estimated: 1 };

/** 依優先級選高度：核對 > 文件 > 使用者 > 估算 */
export function pickHeight(
  candidates: { value: number | null; source: HeightSource }[],
): { value: number; source: HeightSource } | null {
  const valid = candidates.filter((c): c is { value: number; source: HeightSource } => c.value != null && Number.isFinite(c.value) && c.value > 0);
  valid.sort((a, b) => RANK[b.source] - RANK[a.source]);
  return valid[0] ?? null;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

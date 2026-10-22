/**
 * 局部公尺平面上的多邊形檢查（規格 §6.1 第 7 點、§5.2）。
 * 座標為 [x東, z南]；平面運算，不使用經緯度球面公式。
 */
import { polygon as turfPolygon, featureCollection } from '@turf/helpers';
import kinks from '@turf/kinks';
import union from '@turf/union';
import booleanWithin from '@turf/boolean-within';
import type { Feature, MultiPolygon, Polygon } from 'geojson';

export type Ring = [number, number][];
/** 外環＋洞 */
export type PolygonRings = Ring[];

export type GeometryIssue =
  | { code: 'too_few_points' }
  | { code: 'non_finite' }
  | { code: 'zero_area' }
  | { code: 'self_intersection'; at: [number, number][] }
  | { code: 'hole_outside_shell'; holeIndex: number }
  | { code: 'too_many_points'; max: number };

export const MAX_RING_POINTS = 2000;

/** 去掉結尾重複點，回傳開放環 */
export function openRing(r: Ring): Ring {
  if (r.length > 1) {
    const a = r[0]!;
    const b = r[r.length - 1]!;
    if (a[0] === b[0] && a[1] === b[1]) return r.slice(0, -1);
  }
  return r;
}

export function closeRing(r: Ring): Ring {
  const o = openRing(r);
  return o.length ? [...o, o[0]!] : o;
}

/** 有號面積（鞋帶公式）；局部 X東Z南 下，由上看逆時針為負 */
export function signedArea(r: Ring): number {
  const o = openRing(r);
  let a = 0;
  for (let i = 0; i < o.length; i++) {
    const [x1, y1] = o[i]!;
    const [x2, y2] = o[(i + 1) % o.length]!;
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/** 幾何計算面積（m²）＝外環 − 洞 */
export function polygonArea(p: PolygonRings): number {
  if (!p.length) return 0;
  const [shell, ...holes] = p;
  return Math.abs(signedArea(shell!)) - holes.reduce((s, h) => s + Math.abs(signedArea(h)), 0);
}

export function validatePolygon(p: PolygonRings): GeometryIssue[] {
  const issues: GeometryIssue[] = [];
  if (!p.length) return [{ code: 'too_few_points' }];
  for (const r of p) {
    const o = openRing(r);
    if (o.length > MAX_RING_POINTS) issues.push({ code: 'too_many_points', max: MAX_RING_POINTS });
    if (o.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) return [{ code: 'non_finite' }];
    const distinct = new Set(o.map(([x, y]) => `${x},${y}`));
    if (distinct.size < 3) return [{ code: 'too_few_points' }];
  }
  if (Math.abs(signedArea(p[0]!)) < 1e-6) issues.push({ code: 'zero_area' });
  const feat = toFeature(p);
  const k = kinks(feat);
  if (k.features.length) {
    issues.push({ code: 'self_intersection', at: k.features.map((f) => f.geometry.coordinates as [number, number]) });
  }
  const shell = turfPolygon([closeRing(p[0]!)]);
  p.slice(1).forEach((h, i) => {
    if (!booleanWithin(turfPolygon([closeRing(h)]), shell)) issues.push({ code: 'hole_outside_shell', holeIndex: i + 1 });
  });
  return issues;
}

export function toFeature(p: PolygonRings): Feature<Polygon> {
  return turfPolygon(p.map(closeRing));
}

/** 多筆基地的聯集（規格 §5.2：判斷建物是否超出基地要以所有關聯土地 union 檢查） */
export function unionSites(sites: PolygonRings[]): Feature<Polygon | MultiPolygon> | null {
  if (!sites.length) return null;
  if (sites.length === 1) return toFeature(sites[0]!);
  const u = union(featureCollection(sites.map(toFeature)));
  return u;
}

export type ContainmentResult =
  | { status: 'inside' }
  | { status: 'outside'; outsideAreaM2: number }
  | { status: 'no_site' };

/**
 * footprint 是否落在關聯基地聯集內。容差：超出面積 ≤ toleranceM2 視為在內
 * （描圖誤差；超出時只提示人工檢核，不自動修改地界）。
 */
export function footprintInSites(footprint: PolygonRings, sites: PolygonRings[], toleranceM2 = 0.5): ContainmentResult {
  const site = unionSites(sites);
  if (!site) return { status: 'no_site' };
  const fp = toFeature(footprint);
  const fpArea = polygonArea(footprint);
  const merged = union(featureCollection<Polygon | MultiPolygon>([site, fp]));
  if (!merged) return { status: 'no_site' };
  const outside = featureArea(merged) - featureArea(site);
  if (outside <= toleranceM2 || outside <= fpArea * 1e-6) return { status: 'inside' };
  return { status: 'outside', outsideAreaM2: Math.round(outside * 100) / 100 };
}

function featureArea(f: Feature<Polygon | MultiPolygon>): number {
  const g = f.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  return polys.reduce((s, rings) => s + polygonArea(rings as PolygonRings), 0);
}



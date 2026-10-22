/**
 * 局部公尺座標 → Three.js 幾何。X 東、Y 上、Z 南。
 * Shape 平面 (x, y) 以 rotateX(−π/2) 映到世界 (x, 0, −y)，因此 shape.y = −z。
 */
import * as THREE from 'three';
import type { PolygonRings } from '../geometry/polygon';
import { openRing } from '../geometry/polygon';

export function shapeFromRings(rings: PolygonRings): THREE.Shape {
  const [shell, ...holes] = rings;
  const toV = (r: [number, number][]) => openRing(r).map(([x, z]) => new THREE.Vector2(x, -z));
  const shape = new THREE.Shape(toV(shell!));
  for (const h of holes) shape.holes.push(new THREE.Path(toV(h)));
  return shape;
}

/** 平面填色（y 固定） */
export function flatGeometry(rings: PolygonRings, y: number): THREE.BufferGeometry {
  const g = new THREE.ShapeGeometry(shapeFromRings(rings));
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  return g;
}

/** 由 base 拉高 height 的實體量體 */
export function extrudeGeometry(rings: PolygonRings, baseY: number, height: number): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(shapeFromRings(rings), { depth: height, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  g.translate(0, baseY, 0);
  return g;
}

/** 外框線（含洞） */
export function outlinePoints(rings: PolygonRings, y: number): THREE.Vector3[][] {
  return rings.map((r) => {
    const o = openRing(r);
    return [...o, o[0]!].map(([x, z]) => new THREE.Vector3(x, y, z));
  });
}

export function ringCentroid(rings: PolygonRings): [number, number] {
  const o = openRing(rings[0]!);
  let a = 0, cx = 0, cz = 0;
  for (let i = 0; i < o.length; i++) {
    const [x1, z1] = o[i]!;
    const [x2, z2] = o[(i + 1) % o.length]!;
    const f = x1 * z2 - x2 * z1;
    a += f;
    cx += (x1 + x2) * f;
    cz += (z1 + z2) * f;
  }
  if (Math.abs(a) < 1e-9) return [o[0]![0], o[0]![1]];
  return [cx / (3 * a), cz / (3 * a)];
}

export function ringBounds(rings: PolygonRings) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const [x, z] of rings[0]!) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  return { minX, minZ, maxX, maxZ };
}

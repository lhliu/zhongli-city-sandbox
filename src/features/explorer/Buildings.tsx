import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { Line } from '@react-three/drei';
import type { ThreeEvent } from '@react-three/fiber';
import type { BuildingDTO } from '../../lib/model/types';
import { extrudeGeometry, outlinePoints } from '../../lib/three/geometry';
import { ATTR_COLOR } from '../../lib/model/labels';
import { totalHeight } from '../../lib/geometry/height';

type Props = { building: BuildingDTO; selected: boolean; opacity: number; onPick: (id: string, e: ThreeEvent<MouseEvent>) => void };

/**
 * 棟別量體：每段 segment 依 base/height 拉高；未知高度不拉高，只畫地面輪廓（不把未知當 0 層，也不假裝有高度）。
 * 狀態以外框顏色＋線型表示：已核對實線、規劃藍、推估橘虛線、假設紫虛線。
 */
export function BuildingMass({ building, selected, opacity, onPick }: Props) {
  const segments = useMemo(
    () =>
      building.segments
        .filter((s) => s.heightM != null)
        .map((s) => ({
          geom: extrudeGeometry(building.footprint, building.baseElevationM + s.baseHeightM, s.heightM!),
          top: building.baseElevationM + s.baseHeightM + s.heightM!,
          base: building.baseElevationM + s.baseHeightM,
        })),
    [building],
  );
  useEffect(() => () => segments.forEach((s) => s.geom.dispose()), [segments]);
  const edges = useMemo(() => segments.map((s) => withDashDistances(new THREE.EdgesGeometry(s.geom, 20))), [segments]);
  const padGeom = useMemo(() => extrudeGeometry(building.footprint, 0.4, 0.2), [building.footprint]);
  useEffect(() => () => padGeom.dispose(), [padGeom]);
  useEffect(() => () => edges.forEach((e) => e.dispose()), [edges]);
  const color = ATTR_COLOR[building.attribute];
  const dashed = building.attribute === 'estimated' || building.attribute === 'assumption';
  const groundOutline = useMemo(() => outlinePoints(building.footprint, 0.5), [building.footprint]);
  const unknown = totalHeight(building.segments) == null;

  const handlers = {
    onClick: (e: ThreeEvent<MouseEvent>) => {
      e.stopPropagation();
      onPick(building.id, e);
    },
    onPointerOver: (e: ThreeEvent<PointerEvent>) => {
      e.stopPropagation();
      document.body.style.cursor = 'pointer';
    },
    onPointerOut: () => (document.body.style.cursor = ''),
  };

  return (
    <group userData={{ buildingId: building.id }}>
      {segments.map((s, i) => (
        <group key={i}>
          <mesh geometry={s.geom} castShadow receiveShadow {...handlers} userData={{ collider: true }}>
            <meshStandardMaterial color={selected ? '#efe3c6' : '#d9d9d6'} roughness={0.85} metalness={0} transparent={opacity < 1} opacity={opacity} />
          </mesh>
          <lineSegments geometry={edges[i]} renderOrder={3}>
            {dashed ? (
              <lineDashedMaterial color={selected ? '#a4874b' : color} dashSize={2} gapSize={1.2} />
            ) : (
              <lineBasicMaterial color={selected ? '#a4874b' : color} />
            )}
          </lineSegments>
        </group>
      ))}
      {/* 地面輪廓：未知高度時是唯一的表示；有高度時作為落點提示 */}
      {groundOutline.map((pts, i) => (
        <Line key={i} points={pts} color={selected ? '#a4874b' : color} lineWidth={unknown ? 3 : 1.5} dashed={dashed || unknown} dashSize={2} gapSize={1.2} />
      ))}
      {unknown && (
        <mesh {...handlers} geometry={padGeom}>
          <meshBasicMaterial color={color} transparent opacity={0.25} />
        </mesh>
      )}
    </group>
  );
}

/** LineDashedMaterial 需要 lineDistance；EdgesGeometry 本身沒有，這裡補算（每段線獨立起算） */
function withDashDistances(geom: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = geom.getAttribute('position');
  const d = new Float32Array(pos.count);
  for (let i = 0; i + 1 < pos.count; i += 2) {
    d[i] = 0;
    d[i + 1] = Math.hypot(pos.getX(i + 1) - pos.getX(i), pos.getY(i + 1) - pos.getY(i), pos.getZ(i + 1) - pos.getZ(i));
  }
  geom.setAttribute('lineDistance', new THREE.BufferAttribute(d, 1));
  return geom;
}

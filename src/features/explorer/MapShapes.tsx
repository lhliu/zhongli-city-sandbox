import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { Line } from '@react-three/drei';
import type { ThreeEvent } from '@react-three/fiber';
import type { FeatureDTO, ParcelDTO } from '../../lib/model/types';
import { flatGeometry, outlinePoints } from '../../lib/three/geometry';

const FEATURE_COLOR: Record<FeatureDTO['kind'], string> = {
  boundary: '#c62828', zone: '#999', road: '#bbb', park: '#4caf50', public_facility: '#9c6bd6', landmark: '#666',
};

export function Boundary({ feature, opacity }: { feature: FeatureDTO; opacity: number }) {
  const lines = useMemo(() => outlinePoints(feature.geometry, 0.3), [feature]);
  return (
    <>
      {lines.map((pts, i) => (
        <Line key={i} points={pts} color="#c62828" lineWidth={2.5} dashed dashSize={8} gapSize={5} transparent opacity={opacity} />
      ))}
    </>
  );
}

export function FlatFeature({ feature, opacity }: { feature: FeatureDTO; opacity: number }) {
  const geom = useMemo(() => flatGeometry(feature.geometry, 0.15), [feature]);
  useEffect(() => () => geom.dispose(), [geom]);
  return (
    <mesh geometry={geom} renderOrder={1}>
      <meshBasicMaterial color={FEATURE_COLOR[feature.kind]} transparent opacity={opacity * 0.6} depthWrite={false} />
    </mesh>
  );
}

type ParcelProps = {
  parcel: ParcelDTO;
  selected: boolean;
  linked: boolean;
  opacity: number;
  onPick: (id: string, e: ThreeEvent<MouseEvent>) => void;
};

export function ParcelShape({ parcel, selected, linked, opacity, onPick }: ParcelProps) {
  const geom = useMemo(() => flatGeometry(parcel.geometry!, 0.2), [parcel.geometry]);
  const lines = useMemo(() => outlinePoints(parcel.geometry!, 0.35), [parcel.geometry]);
  useEffect(() => () => geom.dispose(), [geom]);
  // 參考區塊：虛線；正式地籍已核對：實線
  const isRef = parcel.kind === 'reference_block' || parcel.verification !== 'verified';
  const fill = selected ? '#c2a878' : linked ? '#d9c9a3' : '#ffffff';
  return (
    <group>
      <mesh
        geometry={geom}
        renderOrder={2}
        onClick={(e) => {
          e.stopPropagation();
          onPick(parcel.id, e);
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => (document.body.style.cursor = '')}
      >
        <meshBasicMaterial color={fill} transparent opacity={selected ? Math.max(opacity, 0.7) : opacity * 0.5} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      {lines.map((pts, i) => (
        <Line key={i} points={pts} color={selected ? '#a4874b' : '#5d5446'} lineWidth={selected ? 3 : 1.5} dashed={isRef} dashSize={3} gapSize={2} />
      ))}
    </group>
  );
}

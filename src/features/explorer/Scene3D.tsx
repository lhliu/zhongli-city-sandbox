import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useStore } from '../../store';
import type { SceneDTO } from '../../lib/model/types';
import { BaseMap } from './BaseMap';
import { Boundary, FlatFeature, ParcelShape } from './MapShapes';
import { BuildingMass } from './Buildings';
import { CameraRig, type Bounds } from './CameraRig';
import { Label } from './Label';
import { bridge } from './bridge';
import { DrawLayer } from './DrawLayer';
import { ringBounds, ringCentroid } from '../../lib/three/geometry';
import { totalHeight } from '../../lib/geometry/height';
import { formatLandNumber } from '../../lib/parcel/key';
import { ATTR_LABEL } from '../../lib/model/labels';

function sceneBounds(scene: SceneDTO): Bounds {
  const boundary = scene.features.find((f) => f.kind === 'boundary');
  const rings = boundary ? [boundary.geometry] : scene.parcels.filter((p) => p.geometry).map((p) => p.geometry!);
  if (!rings.length) return { cx: 0, cz: 0, radius: 500 };
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const r of rings) {
    const b = ringBounds(r);
    minX = Math.min(minX, b.minX); minZ = Math.min(minZ, b.minZ); maxX = Math.max(maxX, b.maxX); maxZ = Math.max(maxZ, b.maxZ);
  }
  return { cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, radius: Math.max(maxX - minX, maxZ - minZ) / 2 };
}

/** 把 renderer／scene／camera 交給 Canvas 外的輸出功能 */
function Bridge() {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    bridge.gl = gl;
    bridge.scene = scene;
    bridge.camera = camera;
  }, [gl, scene, camera]);
  return null;
}

type Level = 'far' | 'mid' | 'near';

/** 依畫面涵蓋的公尺數切換標籤層級：遠景地標、中景建案、近景地號與棟別 */
function useViewLevel(): Level {
  const [level, setLevel] = useState<Level>('far');
  const frame = useRef(0);
  useFrame(({ camera, size }) => {
    if (frame.current++ % 10) return;
    let span: number;
    if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
      const c = camera as THREE.OrthographicCamera;
      span = (c.top - c.bottom) / c.zoom;
      if (!Number.isFinite(span) || span <= 0) span = size.height / c.zoom;
    } else {
      const c = camera as THREE.PerspectiveCamera;
      const t = bridge.getTarget();
      const d = camera.position.distanceTo(new THREE.Vector3(...t));
      span = 2 * d * Math.tan((c.fov * Math.PI) / 360);
      if (c.position.y < 30) span = Math.min(span, 300);
    }
    const next: Level = span > 1100 ? 'far' : span > 380 ? 'mid' : 'near';
    if (next !== level) setLevel(next);
  });
  return level;
}

function Labels({ scene }: { scene: SceneDTO }) {
  const level = useViewLevel();
  const sel = useStore((s) => s.selection);
  const devById = useMemo(() => new Map(scene.developments.map((d) => [d.id, d])), [scene.developments]);
  const items: React.ReactElement[] = [];
  for (const f of scene.features) {
    if (f.kind === 'park' || f.kind === 'public_facility' || f.kind === 'landmark') {
      if (level === 'far' && !/體育場/.test(f.label ?? '')) continue;
      const [x, z] = ringCentroid(f.geometry);
      items.push(<Label key={f.id} text={f.label ?? ''} position={[x, 2, z]} color="#2e5d32" size={level === 'far' ? 0.03 : 0.026} />);
    }
  }
  if (level !== 'far') {
    // 中景：建案名稱標在其棟別或基地中心
    for (const d of scene.developments) {
      const bs = scene.buildings.filter((b) => b.developmentId === d.id);
      const anchors = bs.length ? bs.map((b) => b.footprint) : d.parcelIds.map((id) => scene.parcels.find((p) => p.id === id)?.geometry).filter(Boolean);
      if (!anchors.length) continue;
      const cs = anchors.map((g) => ringCentroid(g!));
      const x = cs.reduce((s, c) => s + c[0], 0) / cs.length;
      const z = cs.reduce((s, c) => s + c[1], 0) / cs.length;
      const top = Math.max(0, ...bs.map((b) => b.baseElevationM + (totalHeight(b.segments) ?? 0)));
      const text = `${d.isDemo ? '【DEMO】' : ''}${d.name}`;
      items.push(<Label key={`d-${d.id}`} text={text} position={[x, top + 6, z]} color={d.isDemo ? '#c62828' : '#1f3a33'} size={0.03} renderOrder={12} />);
    }
  }
  if (level === 'near') {
    for (const p of scene.parcels) {
      if (!p.geometry) continue;
      const [x, z] = ringCentroid(p.geometry);
      const text = p.kind === 'reference_block' ? `${p.blockId}（參考）` : `${p.sectionName ?? p.sectionCode} ${formatLandNumber({ main: p.landMain!, sub: p.landSub! })}`;
      const selected = sel?.type === 'parcel' && sel.ids.includes(p.id);
      items.push(<Label key={`p-${p.id}`} text={text} position={[x, 1, z]} size={0.022} color={selected ? '#7a5f22' : '#5d5446'} />);
    }
    for (const b of scene.buildings) {
      const [x, z] = ringCentroid(b.footprint);
      const h = totalHeight(b.segments);
      const tag = `${b.label}｜${h == null ? '樓高未知' : `${h}m`}｜${ATTR_LABEL[b.attribute]}`;
      items.push(<Label key={`b-${b.id}`} text={tag} position={[x, b.baseElevationM + (h ?? 0) + 2, z]} size={0.022} />);
    }
  }
  void devById;
  return <>{items}</>;
}

function Content({ scene }: { scene: SceneDTO }) {
  const layers = useStore((s) => s.layers);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const toggleParcel = useStore((s) => s.toggleParcel);
  const base = scene.layers.find((l) => l.calibration);
  const linkedParcels = useMemo(() => {
    if (selection?.type === 'development') return new Set(scene.developments.find((d) => d.id === selection.id)?.parcelIds ?? []);
    if (selection?.type === 'building') {
      const b = scene.buildings.find((x) => x.id === selection.id);
      return new Set(scene.developments.find((d) => d.id === b?.developmentId)?.parcelIds ?? []);
    }
    return new Set<string>();
  }, [selection, scene]);

  // 平視防穿模用的碰撞資料
  useEffect(() => {
    bridge.colliders = scene.buildings
      .map((b) => ({ footprint: b.footprint[0]!, top: b.baseElevationM + (totalHeight(b.segments) ?? 0) }))
      .filter((c) => c.top > 0);
  }, [scene.buildings]);

  return (
    <>
      <ambientLight intensity={0.75} />
      <hemisphereLight args={['#ffffff', '#b9b2a2', 0.5]} />
      <directionalLight position={[300, 600, 200]} intensity={1.1} />
      {base && layers.basemap.visible && (
        <Suspense fallback={null}>
          <BaseMap layer={base} opacity={layers.basemap.opacity} />
        </Suspense>
      )}
      {!base && (
        <mesh rotation-x={-Math.PI / 2}>
          <planeGeometry args={[4000, 4000]} />
          <meshBasicMaterial color="#efece4" />
        </mesh>
      )}
      {layers.boundary.visible &&
        scene.features.filter((f) => f.kind === 'boundary').map((f) => <Boundary key={f.id} feature={f} opacity={layers.boundary.opacity} />)}
      {layers.parks.visible &&
        scene.features.filter((f) => f.kind === 'park' || f.kind === 'public_facility').map((f) => <FlatFeature key={f.id} feature={f} opacity={layers.parks.opacity} />)}
      {layers.parcels.visible &&
        scene.parcels
          .filter((p) => p.geometry)
          .map((p) => (
            <ParcelShape
              key={p.id}
              parcel={p}
              opacity={layers.parcels.opacity}
              selected={selection?.type === 'parcel' && selection.ids.includes(p.id)}
              linked={linkedParcels.has(p.id)}
              onPick={(id, e) => !useStore.getState().draw.active && toggleParcel(id, e.shiftKey || e.metaKey || e.ctrlKey)}
            />
          ))}
      {layers.buildings.visible &&
        scene.buildings.map((b) => (
          <BuildingMass
            key={b.id}
            building={b}
            opacity={layers.buildings.opacity}
            selected={selection?.type === 'building' && selection.id === b.id}
            onPick={(id) => !useStore.getState().draw.active && select({ type: 'building', id })}
          />
        ))}
      {layers.labels.visible && <Labels scene={scene} />}
      <DrawLayer />
    </>
  );
}

export function Scene3D({ scene }: { scene: SceneDTO }) {
  const bounds = useMemo(() => sceneBounds(scene), [scene.project.id, scene.features, scene.parcels.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const select = useStore((s) => s.select);
  return (
    <Canvas
      gl={{ antialias: true, preserveDrawingBuffer: false }}
      dpr={[1, 2]}
      onPointerMissed={(e) => {
        if (e.type === 'click' && useStore.getState().cameraMode !== 'walk' && !useStore.getState().draw.active) select(null);
      }}
      style={{ position: 'absolute', inset: 0 }}
    >
      <color attach="background" args={['#e8e4da']} />
      <Bridge />
      <CameraRig bounds={bounds} />
      <Content scene={scene} />
    </Canvas>
  );
}

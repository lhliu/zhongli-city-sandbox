import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { MapControls, OrbitControls, OrthographicCamera, PerspectiveCamera } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl, MapControls as MapControlsImpl } from 'three-stdlib';
import { useStore } from '../../store';
import { bridge } from './bridge';
import { WalkControls } from './WalkControls';
import { ringCentroid } from '../../lib/three/geometry';

export type Bounds = { cx: number; cz: number; radius: number };

/** 平視起點：有選取物件時站在其南方 60m 面向它；否則站在目前目標點面向北 */
function walkStart(fallback: [number, number, number]): { start: [number, number, number]; lookAt: [number, number] | null } {
  const { selection, scene } = useStore.getState();
  let focus: [number, number] | null = null;
  if (scene && selection?.type === 'building') {
    const b = scene.buildings.find((x) => x.id === selection.id);
    if (b) focus = ringCentroid(b.footprint);
  } else if (scene && selection?.type === 'parcel') {
    const p = scene.parcels.find((x) => x.id === selection.ids[0]);
    if (p?.geometry) focus = ringCentroid(p.geometry);
  } else if (scene && selection?.type === 'development') {
    const b = scene.buildings.find((x) => x.developmentId === selection.id);
    const d = scene.developments.find((x) => x.id === selection.id);
    const p = scene.parcels.find((x) => d?.parcelIds.includes(x.id) && x.geometry);
    if (b) focus = ringCentroid(b.footprint);
    else if (p?.geometry) focus = ringCentroid(p.geometry);
  }
  if (!focus) return { start: fallback, lookAt: null };
  return { start: [focus[0], 0, focus[1] + 60], lookAt: focus };
}

/**
 * 三種相機：
 * - 俯視：正交相機，正北朝上（camera.up = −Z），只能平移縮放
 * - 鳥瞰：透視相機＋OrbitControls（左鍵旋轉、右鍵平移、滾輪縮放），不能鑽到地面下
 * - 平視：透視相機＋自製 WalkControls（視高預設 1.6m，拖曳環視、WASD 移動）
 */
export function CameraRig({ bounds }: { bounds: Bounds }) {
  const mode = useStore((s) => s.cameraMode);
  const resetTick = useStore((s) => s.resetCameraTick);
  const pending = useStore((s) => s.pendingCamera);
  const orbitRef = useRef<OrbitControlsImpl>(null);
  const mapRef = useRef<MapControlsImpl>(null);
  const orthoRef = useRef<THREE.OrthographicCamera>(null);
  const perspRef = useRef<THREE.PerspectiveCamera>(null);
  const lastTarget = useRef<[number, number, number]>([bounds.cx, 0, bounds.cz]);
  const { size } = useThree();

  const fitZoom = useMemo(() => Math.min(size.width, size.height) / (bounds.radius * 2.2), [size, bounds.radius]);

  useEffect(() => {
    bridge.getTarget = () => {
      const c = (mode === 'top' ? mapRef.current : orbitRef.current) as unknown as { target?: THREE.Vector3 } | null;
      if (c?.target) return [c.target.x, c.target.y, c.target.z];
      return lastTarget.current;
    };
  }, [mode]);

  // 進入模式或重設時擺好相機
  useEffect(() => {
    const t = lastTarget.current;
    if (mode === 'top' && orthoRef.current) {
      const cam = orthoRef.current;
      cam.up.set(0, 0, -1);
      cam.position.set(t[0], 3000, t[2]);
      cam.lookAt(t[0], 0, t[2]);
      cam.zoom = fitZoom;
      cam.updateProjectionMatrix();
      mapRef.current?.target.set(t[0], 0, t[2]);
      mapRef.current?.update();
    }
    if (mode === 'orbit' && perspRef.current) {
      const cam = perspRef.current;
      cam.up.set(0, 1, 0);
      const r = bounds.radius * 1.6;
      cam.position.set(t[0] + r * 0.35, r * 0.75, t[2] + r * 0.9);
      orbitRef.current?.target.set(t[0], 0, t[2]);
      orbitRef.current?.update();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(() => {
    if (resetTick === 0) return;
    lastTarget.current = [bounds.cx, 0, bounds.cz];
    if (mode === 'top' && orthoRef.current) {
      orthoRef.current.position.set(bounds.cx, 3000, bounds.cz);
      orthoRef.current.zoom = fitZoom;
      orthoRef.current.updateProjectionMatrix();
      mapRef.current?.target.set(bounds.cx, 0, bounds.cz);
      mapRef.current?.update();
    } else if (mode === 'orbit' && perspRef.current) {
      const r = bounds.radius * 1.6;
      perspRef.current.position.set(bounds.cx + r * 0.35, r * 0.75, bounds.cz + r * 0.9);
      orbitRef.current?.target.set(bounds.cx, 0, bounds.cz);
      orbitRef.current?.update();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetTick]);

  // 套用鏡頭書籤
  useEffect(() => {
    if (!pending || pending.mode !== mode) return;
    const { position, target, zoom, fov } = pending.camera;
    if (mode === 'top' && orthoRef.current) {
      orthoRef.current.position.set(position[0], 3000, position[2]);
      orthoRef.current.zoom = zoom;
      orthoRef.current.updateProjectionMatrix();
      mapRef.current?.target.set(target[0], 0, target[2]);
      mapRef.current?.update();
    } else if (mode === 'orbit' && perspRef.current) {
      perspRef.current.position.set(...position);
      perspRef.current.fov = fov;
      perspRef.current.updateProjectionMatrix();
      orbitRef.current?.target.set(...target);
      orbitRef.current?.update();
    }
    useStore.getState().applyBookmark(null);
  }, [pending, mode]);

  // 持續記住目前目標點，切換模式時沿用
  useFrame(() => {
    const c = (mode === 'top' ? mapRef.current : mode === 'orbit' ? orbitRef.current : null) as unknown as { target?: THREE.Vector3 } | null;
    if (c?.target) lastTarget.current = [c.target.x, 0, c.target.z];
  });

  return (
    <>
      {mode === 'top' && (
        <>
          <OrthographicCamera ref={orthoRef} makeDefault near={1} far={10000} position={[bounds.cx, 3000, bounds.cz]} zoom={fitZoom} up={[0, 0, -1]} />
          <MapControls ref={mapRef} enableRotate={false} screenSpacePanning makeDefault target={[bounds.cx, 0, bounds.cz]} minZoom={0.05} maxZoom={60} />
        </>
      )}
      {mode === 'orbit' && (
        <>
          <PerspectiveCamera ref={perspRef} makeDefault fov={45} near={1} far={20000} position={[bounds.cx + bounds.radius * 0.5, bounds.radius * 1.2, bounds.cz + bounds.radius * 1.4]} />
          <OrbitControls
            ref={orbitRef}
            makeDefault
            target={[bounds.cx, 0, bounds.cz]}
            maxPolarAngle={Math.PI / 2 - 0.03}
            minDistance={10}
            maxDistance={bounds.radius * 8}
            enableDamping
            dampingFactor={0.12}
          />
        </>
      )}
      {mode === 'walk' && <WalkControls {...walkStart(lastTarget.current)} />}
    </>
  );
}

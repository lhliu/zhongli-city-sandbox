/** Canvas 內外溝通：輸出 PNG、儲存鏡頭時需要目前的 renderer／scene／camera。 */
import type * as THREE from 'three';
import type { CameraState } from '../../lib/model/schemas';

export const bridge: {
  gl: THREE.WebGLRenderer | null;
  scene: THREE.Scene | null;
  camera: THREE.Camera | null;
  getTarget: () => [number, number, number];
  colliders: { footprint: [number, number][]; top: number }[];
} = {
  gl: null,
  scene: null,
  camera: null,
  getTarget: () => [0, 0, 0],
  colliders: [],
};

export function currentCameraState(eyeHeightM: number | null): CameraState | null {
  const cam = bridge.camera as (THREE.PerspectiveCamera & THREE.OrthographicCamera) | null;
  if (!cam) return null;
  const p = cam.position;
  return {
    position: [round(p.x), round(p.y), round(p.z)],
    target: bridge.getTarget().map(round) as [number, number, number],
    fov: 'fov' in cam && cam.isPerspectiveCamera ? cam.fov : 45,
    zoom: cam.zoom ?? 1,
    eyeHeightM,
  };
}
const round = (n: number) => Math.round(n * 100) / 100;

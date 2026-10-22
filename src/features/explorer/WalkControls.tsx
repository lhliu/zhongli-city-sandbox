/**
 * 平視（行人視角）：不是把地圖傾斜，而是相機在視高水平看出去。
 * - 拖曳滑鼠環視；可選擇鎖定滑鼠（Esc 退出）
 * - WASD／方向鍵移動、Shift 加速；自由飛行模式可用 Q／E 升降
 * - 地面為平地模型（y=0），視高固定於 eyeHeightM；簡單包圍盒防穿模
 * - 雙擊地面：移動到該點
 */
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { PerspectiveCamera } from '@react-three/drei';
import { useStore } from '../../store';
import { bridge } from './bridge';

export const walkInput = { forward: 0, right: 0, freeFly: false };

function insidePolygon(x: number, z: number, poly: [number, number][], margin: number) {
  // 射線法；margin 以外擴的包圍盒近似
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [px, pz] of poly) {
    minX = Math.min(minX, px); maxX = Math.max(maxX, px); minZ = Math.min(minZ, pz); maxZ = Math.max(maxZ, pz);
  }
  if (x < minX - margin || x > maxX + margin || z < minZ - margin || z > maxZ + margin) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]!;
    const [xj, zj] = poly[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  if (inside) return true;
  // 邊界附近 margin 內也視為碰撞
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, az] = poly[j]!;
    const [bx, bz] = poly[i]!;
    const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / ((bx - ax) ** 2 + (bz - az) ** 2 || 1)));
    if (Math.hypot(x - (ax + t * (bx - ax)), z - (az + t * (bz - az))) < margin) return true;
  }
  return false;
}

export function blocked(x: number, z: number, eyeY: number) {
  return bridge.colliders.some((c) => eyeY < c.top + 0.2 && insidePolygon(x, z, c.footprint, 0.6));
}

export function WalkControls({ start, lookAt }: { start: [number, number, number]; lookAt: [number, number] | null }) {
  const camRef = useRef<THREE.PerspectiveCamera>(null);
  const eye = useStore((s) => s.eyeHeightM);
  const { gl } = useThree();
  const yaw = useRef(0); // 0＝面向北（−Z）
  const pitch = useRef(0);
  const keys = useRef(new Set<string>());
  const pos = useRef(new THREE.Vector3(start[0], eye, start[2]));

  useEffect(() => {
    // 起點若在建物內，往南退到空地
    let [x, z] = [start[0], start[2]];
    for (let i = 0; i < 200 && blocked(x, z, eye); i++) z += 2;
    pos.current.set(x, eye, z);
    if (lookAt) {
      yaw.current = Math.atan2(lookAt[0] - x, -(lookAt[1] - z));
      // 面向目標並略為仰視，看得到建物
      pitch.current = 0.12;
    }
    bridge.getTarget = () => {
      const d = new THREE.Vector3(Math.sin(yaw.current), 0, -Math.cos(yaw.current));
      return [pos.current.x + d.x * 10, eye, pos.current.z + d.z * 10];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!walkInput.freeFly) pos.current.y = eye;
  }, [eye]);

  useEffect(() => {
    const el = gl.domElement;
    let dragging = false;
    let last = [0, 0];
    const look = (dx: number, dy: number) => {
      yaw.current += dx * 0.0035;
      pitch.current = Math.max(-1.2, Math.min(1.2, pitch.current - dy * 0.0035));
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      dragging = true;
      last = [e.clientX, e.clientY];
    };
    const move = (e: PointerEvent) => {
      if (document.pointerLockElement === el) return look(e.movementX, e.movementY);
      if (!dragging) return;
      look(e.clientX - last[0]!, e.clientY - last[1]!);
      last = [e.clientX, e.clientY];
    };
    const up = () => (dragging = false);
    const kd = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, select')) return;
      keys.current.add(e.code);
    };
    const ku = (e: KeyboardEvent) => keys.current.delete(e.code);
    const dbl = (e: MouseEvent) => {
      // 雙擊地面移動
      const rect = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, camRef.current!);
      const hit = new THREE.Vector3();
      if (ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit) && !blocked(hit.x, hit.z, eye)) {
        pos.current.set(hit.x, walkInput.freeFly ? pos.current.y : eye, hit.z);
      }
    };
    el.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    el.addEventListener('dblclick', dbl);
    return () => {
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
      el.removeEventListener('dblclick', dbl);
      if (document.pointerLockElement === el) document.exitPointerLock();
    };
  }, [gl, eye]);

  useFrame((_, dt) => {
    const cam = camRef.current;
    if (!cam) return;
    const k = keys.current;
    const speed = (k.has('ShiftLeft') || k.has('ShiftRight') ? 15 : 5) * Math.min(dt, 0.1);
    const f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) + walkInput.forward;
    const r = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0) + walkInput.right;
    const fwd = new THREE.Vector2(Math.sin(yaw.current), -Math.cos(yaw.current));
    const right = new THREE.Vector2(Math.cos(yaw.current), Math.sin(yaw.current));
    const nx = pos.current.x + (fwd.x * f + right.x * r) * speed;
    const nz = pos.current.z + (fwd.y * f + right.y * r) * speed;
    // 分軸檢查，貼牆時可沿牆滑動
    if (!blocked(nx, pos.current.z, pos.current.y)) pos.current.x = nx;
    if (!blocked(pos.current.x, nz, pos.current.y)) pos.current.z = nz;
    if (walkInput.freeFly) {
      const v = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);
      pos.current.y = Math.max(eye, pos.current.y + v * speed);
    } else pos.current.y = eye;
    cam.position.copy(pos.current);
    const dir = new THREE.Vector3(Math.sin(yaw.current) * Math.cos(pitch.current), Math.sin(pitch.current), -Math.cos(yaw.current) * Math.cos(pitch.current));
    cam.up.set(0, 1, 0);
    cam.lookAt(pos.current.clone().add(dir));
  });

  return <PerspectiveCamera ref={camRef} makeDefault fov={70} near={0.1} far={20000} position={[start[0], eye, start[2]]} />;
}

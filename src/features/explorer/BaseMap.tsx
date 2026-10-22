import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useLoader } from '@react-three/fiber';
import type { LayerDTO } from '../../lib/model/types';
import { applyAffine } from '../../lib/calibration/affine';

/** 官方圖面依校準仿射（像素 → 局部公尺）貼到地面 y=0 */
export function BaseMap({ layer, opacity }: { layer: LayerDTO; opacity: number }) {
  const texture = useLoader(THREE.TextureLoader, layer.assetUrl);
  useEffect(() => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    texture.needsUpdate = true;
  }, [texture]);
  const geometry = useMemo(() => {
    const t = layer.calibration!.transform;
    const W = layer.pixelW!;
    const H = layer.pixelH!;
    const c = ([px, py]: [number, number]) => applyAffine(t, [px, py]);
    const corners = [c([0, 0]), c([W, 0]), c([W, H]), c([0, H])];
    const g = new THREE.BufferGeometry();
    const pos = corners.flatMap(([x, z]) => [x, 0, z]);
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2));
    g.setIndex([0, 3, 1, 1, 3, 2]);
    g.computeVertexNormals();
    return g;
  }, [layer]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh geometry={geometry} receiveShadow renderOrder={0}>
      <meshBasicMaterial map={texture} transparent={opacity < 1} opacity={opacity} toneMapped={false} side={THREE.DoubleSide} />
    </mesh>
  );
}

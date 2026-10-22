/** 描圖：俯視時在地面點擊加點；拖曳（平移地圖）不會加點 */
import { Line } from '@react-three/drei';
import { useStore } from '../../store';

export function DrawLayer() {
  const draw = useStore((s) => s.draw);
  const add = useStore((s) => s.addDrawPoint);
  if (!draw.active) return null;
  const pts = draw.points.map(([x, z]) => [x, 1, z] as [number, number, number]);
  return (
    <>
      <mesh
        rotation-x={-Math.PI / 2}
        position={[0, 0.8, 0]}
        onClick={(e) => {
          if (e.delta > 4) return;
          e.stopPropagation();
          add([Math.round(e.point.x * 100) / 100, Math.round(e.point.z * 100) / 100]);
        }}
      >
        <planeGeometry args={[20000, 20000]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      {pts.length >= 2 && <Line points={pts.length >= 3 ? [...pts, pts[0]!] : pts} color="#c2a878" lineWidth={3} />}
      {pts.map((p, i) => (
        <mesh key={i} position={p}>
          <sphereGeometry args={[1.6, 12, 12]} />
          <meshBasicMaterial color={i === 0 ? '#c62828' : '#1f3a33'} />
        </mesh>
      ))}
    </>
  );
}

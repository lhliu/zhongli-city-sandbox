/**
 * 方位角（由北向順時針，度）與引擎旋轉的唯一換算處（規格 §6.2）。
 * 局部座標 X 東、Z 南；Three.js rotation.y 正值為由上往下看逆時針。
 */
export function azimuthToRotationY(azimuthDeg: number): number {
  return (-azimuthDeg * Math.PI) / 180;
}

/** 方位角對應的局部水平單位向量 [x, z] */
export function azimuthToVector(azimuthDeg: number): [number, number] {
  const a = (azimuthDeg * Math.PI) / 180;
  return [Math.sin(a), -Math.cos(a)];
}

/** 局部向量的方位角（0–360） */
export function vectorToAzimuth(v: [number, number]): number {
  const deg = (Math.atan2(v[0], -v[1]) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** 以中心、寬（沿方位角右手方向）、深（沿方位角方向）建立矩形 footprint，逆時針（由上看）順序無關 */
export function rectangleFootprint(
  center: [number, number],
  widthM: number,
  depthM: number,
  azimuthDeg: number,
): [number, number][] {
  const f = azimuthToVector(azimuthDeg);
  const r = azimuthToVector(azimuthDeg + 90);
  const hw = widthM / 2;
  const hd = depthM / 2;
  const pt = (a: number, b: number): [number, number] => [
    center[0] + r[0] * a + f[0] * b,
    center[1] + r[1] * a + f[1] * b,
  ];
  return [pt(-hw, -hd), pt(hw, -hd), pt(hw, hd), pt(-hw, hd)];
}

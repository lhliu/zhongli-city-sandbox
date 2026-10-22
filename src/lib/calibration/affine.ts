/**
 * 控制點仿射校準（規格 §6.1 第 3–5 點）。
 * 以最小平方擬合 src→dst：x' = a·x + b·y + c；y' = d·x + e·y + f。
 * 至少 3 個非共線控制點；另以不參與擬合的檢核點計算 RMSE 與最大誤差。
 */
export type ControlPoint = { id: string; src: [number, number]; dst: [number, number]; role: 'fit' | 'check' };

export type Affine = [number, number, number, number, number, number];

export type CalibrationReport = {
  transform: Affine;
  fitResiduals: { id: string; errorM: number }[];
  checkResiduals: { id: string; errorM: number }[];
  fitRmse: number;
  checkRmse: number | null;
  checkMax: number | null;
  /** 檢核點 RMSE ≤ 3m 且最大誤差 ≤ 5m 才可作沙盤顯示底圖（產品暫定容差） */
  passesDisplayThreshold: boolean;
  warnings: string[];
};

export const DISPLAY_THRESHOLD = { rmseM: 3, maxM: 5 } as const;

export function applyAffine(t: Affine, p: [number, number]): [number, number] {
  return [t[0] * p[0] + t[1] * p[1] + t[2], t[3] * p[0] + t[4] * p[1] + t[5]];
}

export function fitAffine(points: ControlPoint[]): CalibrationReport {
  const fit = points.filter((p) => p.role === 'fit');
  const check = points.filter((p) => p.role === 'check');
  if (fit.length < 3) throw new Error('仿射校準至少需要 3 個擬合控制點');
  if (isDegenerate(fit.map((p) => p.src))) throw new Error('控制點共線或過於集中，無法擬合');

  // 正規方程 (AᵀA) x = Aᵀb，分別解 x' 與 y'
  const ata = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const atbx = [0, 0, 0];
  const atby = [0, 0, 0];
  for (const p of fit) {
    const row = [p.src[0], p.src[1], 1];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) ata[i]![j]! += row[i]! * row[j]!;
      atbx[i]! += row[i]! * p.dst[0];
      atby[i]! += row[i]! * p.dst[1];
    }
  }
  const [a, b, c] = solve3(ata, atbx);
  const [d, e, f] = solve3(ata, atby);
  const transform: Affine = [a, b, c, d, e, f];

  const err = (p: ControlPoint) => {
    const q = applyAffine(transform, p.src);
    return Math.hypot(q[0] - p.dst[0], q[1] - p.dst[1]);
  };
  const fitResiduals = fit.map((p) => ({ id: p.id, errorM: round3(err(p)) }));
  const checkResiduals = check.map((p) => ({ id: p.id, errorM: round3(err(p)) }));
  const rmse = (xs: number[]) => Math.sqrt(xs.reduce((s, x) => s + x * x, 0) / xs.length);
  const fitRmse = round3(rmse(fitResiduals.map((r) => r.errorM)));
  const checkRmse = checkResiduals.length ? round3(rmse(checkResiduals.map((r) => r.errorM))) : null;
  const checkMax = checkResiduals.length ? Math.max(...checkResiduals.map((r) => r.errorM)) : null;

  const warnings: string[] = [];
  if (fit.length === 3) warnings.push('只有 3 個擬合點，殘差必為 0，無法評估擬合品質；建議 6–10 點');
  if (check.length < 3) warnings.push('檢核點少於 3 個，不能宣稱地理精準');
  const passesDisplayThreshold =
    check.length >= 3 && checkRmse != null && checkMax != null && checkRmse <= DISPLAY_THRESHOLD.rmseM && checkMax <= DISPLAY_THRESHOLD.maxM;

  return { transform, fitResiduals, checkResiduals, fitRmse, checkRmse, checkMax, passesDisplayThreshold, warnings };
}

function isDegenerate(pts: [number, number][]): boolean {
  // 以三角形最大面積相對於點分布尺度判斷
  let maxArea = 0;
  let span = 0;
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) {
      span = Math.max(span, Math.hypot(pts[i]![0] - pts[j]![0], pts[i]![1] - pts[j]![1]));
      for (let k = j + 1; k < pts.length; k++) {
        const [a, b, c] = [pts[i]!, pts[j]!, pts[k]!];
        maxArea = Math.max(maxArea, Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2);
      }
    }
  return span === 0 || maxArea < span * span * 1e-4;
}

function solve3(m: number[][], v: number[]): [number, number, number] {
  const A = m.map((r, i) => [...r, v[i]!]);
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(A[r]![col]!) > Math.abs(A[piv]![col]!)) piv = r;
    [A[col], A[piv]] = [A[piv]!, A[col]!];
    const p = A[col]![col]!;
    if (Math.abs(p) < 1e-12) throw new Error('控制點矩陣奇異，無法擬合');
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = A[r]![col]! / p;
      for (let c = col; c < 4; c++) A[r]![c]! -= f * A[col]![c]!;
    }
  }
  return [A[0]![3]! / A[0]![0]!, A[1]![3]! / A[1]![1]!, A[2]![3]! / A[2]![2]!];
}

function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}

/**
 * PNG 輸出：以獨立 render target 依指定解析度重繪（不截螢幕），
 * 標籤是 WebGL Sprite 所以一定在畫面中；再以 2D canvas 疊上情境／資料日期／推估標記。
 * 同時輸出一份 JSON 紀錄（情境 revision、相機、資料日期、來源）。
 */
import * as THREE from 'three';
import { bridge, currentCameraState } from './bridge';
import type { SceneDTO } from '../../lib/model/types';
import { SCENARIO_KIND_LABEL } from '../../lib/model/labels';

export type ExportSize = { w: number; h: number; label: string };
export const EXPORT_SIZES: ExportSize[] = [
  { w: 1920, h: 1080, label: '1920×1080（16:9）' },
  { w: 3840, h: 2160, label: '3840×2160（4K）' },
  { w: 1080, h: 1920, label: '1080×1920（9:16 直式）' },
];

export async function exportPng(scene: SceneDTO, size: ExportSize, eyeHeightM: number | null): Promise<{ png: Blob; meta: object }> {
  const { gl, scene: s3, camera } = bridge;
  if (!gl || !s3 || !camera) throw new Error('3D 畫面尚未就緒');
  const glc = gl.getContext();
  const maxSize = Math.min(glc.getParameter(glc.MAX_RENDERBUFFER_SIZE) as number, glc.getParameter(glc.MAX_TEXTURE_SIZE) as number);
  if (size.w > maxSize || size.h > maxSize) {
    throw new Error(`此裝置的 GPU 最大輸出 ${maxSize}px，無法輸出 ${size.w}×${size.h}；請改用較小尺寸`);
  }
  const cam = camera.clone() as THREE.PerspectiveCamera | THREE.OrthographicCamera;
  const aspect = size.w / size.h;
  if ((cam as THREE.PerspectiveCamera).isPerspectiveCamera) {
    (cam as THREE.PerspectiveCamera).aspect = aspect;
  } else {
    // 正交：保持目前垂直範圍，依新比例調整左右
    const o = cam as THREE.OrthographicCamera;
    const halfH = (o.top - o.bottom) / 2;
    o.left = -halfH * aspect;
    o.right = halfH * aspect;
  }
  cam.updateProjectionMatrix();

  const target = new THREE.WebGLRenderTarget(size.w, size.h, { samples: 4, colorSpace: THREE.SRGBColorSpace });
  const prevTarget = gl.getRenderTarget();
  gl.setRenderTarget(target);
  gl.clear();
  gl.render(s3, cam);
  const pixels = new Uint8Array(size.w * size.h * 4);
  gl.readRenderTargetPixels(target, 0, 0, size.w, size.h, pixels);
  gl.setRenderTarget(prevTarget);
  target.dispose();

  // 檢查是否為空白圖（全部同色）
  let distinct = false;
  for (let i = 4; i < pixels.length; i += 4 * 97) {
    if (pixels[i] !== pixels[0] || pixels[i + 1] !== pixels[1] || pixels[i + 2] !== pixels[2]) {
      distinct = true;
      break;
    }
  }
  if (!distinct) throw new Error('輸出結果是空白圖，已取消下載；請降低解析度或重新整理後再試');

  const canvas = document.createElement('canvas');
  canvas.width = size.w;
  canvas.height = size.h;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size.w, size.h);
  // WebGL 讀出的列順序是由下往上
  for (let y = 0; y < size.h; y++) {
    img.data.set(pixels.subarray((size.h - 1 - y) * size.w * 4, (size.h - y) * size.w * 4), y * size.w * 4);
  }
  ctx.putImageData(img, 0, 0);

  // 安全框內的資訊列
  const unit = Math.round(Math.min(size.w, size.h) / 40);
  const margin = Math.round(Math.min(size.w, size.h) * 0.05);
  const sc = scene.scenario;
  const hasEstimate = scene.buildings.some((b) => b.attribute === 'estimated' || b.attribute === 'assumption' || b.footprintIsAssumed);
  const lines = [
    `${SCENARIO_KIND_LABEL[sc.kind]}${sc.name !== SCENARIO_KIND_LABEL[sc.kind] ? `｜${sc.name}` : ''}${sc.isDemo && !sc.name.includes('DEMO') ? '（DEMO 非真實）' : ''}`,
    `資料截至：${sc.dataAsOf ?? '未設定'}　情境目標：${sc.targetDate ?? '未設定'}`,
    hasEstimate ? '含推估／假設量體，非實際建築' : null,
    `底圖：${scene.layers.map((l) => l.sourceCode).filter(Boolean).join('、')}（官方圖面，參考描繪）`,
  ].filter(Boolean) as string[];
  ctx.font = `600 ${unit}px system-ui, "PingFang TC", "Noto Sans TC", sans-serif`;
  const boxW = Math.max(...lines.map((l) => ctx.measureText(l).width)) + unit * 1.4;
  const boxH = lines.length * unit * 1.45 + unit * 0.8;
  ctx.fillStyle = 'rgba(255,253,248,0.88)';
  ctx.fillRect(margin, size.h - margin - boxH, boxW, boxH);
  ctx.fillStyle = '#1f2a26';
  lines.forEach((l, i) => {
    ctx.fillStyle = i === 2 ? '#b85c00' : '#1f2a26';
    ctx.fillText(l, margin + unit * 0.7, size.h - margin - boxH + unit * 1.3 + i * unit * 1.45);
  });

  const png = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('PNG 編碼失敗'))), 'image/png'));
  const meta = {
    exported_at: new Date().toISOString(),
    size: [size.w, size.h],
    project: scene.project.name,
    scenario: { id: sc.id, name: sc.name, kind: sc.kind, revision: sc.revision, data_as_of: sc.dataAsOf, target_date: sc.targetDate, is_demo: sc.isDemo },
    camera: currentCameraState(eyeHeightM),
    camera_type: (camera as THREE.OrthographicCamera).isOrthographicCamera ? 'orthographic' : 'perspective',
    buildings: scene.buildings.map((b) => ({ id: b.id, label: b.label, version_id: b.versionId, version: b.versionNumber, attribute: b.attribute })),
    sources: scene.sources.filter((x) => scene.layers.some((l) => l.sourceCode === x.code)).map((x) => ({ code: x.code, title: x.title, url: x.url, sha256: x.sha256, license: x.licenseStatus })),
  };
  return { png, meta };
}

export function download(blob: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

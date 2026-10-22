/**
 * 文字標籤以 Canvas 貼圖的 Sprite 繪製（在 WebGL 內），PNG 輸出時一併渲染，
 * 不會漏掉 HTML overlay。depthTest 開啟，建物後方的標籤會被遮住。
 */
import { useMemo, useEffect } from 'react';
import * as THREE from 'three';

type Props = {
  text: string;
  position: [number, number, number];
  color?: string;
  bg?: string;
  border?: string;
  /** 螢幕高度比例 */
  size?: number;
  depthTest?: boolean;
  renderOrder?: number;
};

const FONT = '600 40px system-ui, -apple-system, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif';

export function Label({ text, position, color = '#1f2a26', bg = 'rgba(255,253,248,0.92)', border = 'rgba(0,0,0,0.15)', size = 0.028, depthTest = true, renderOrder = 10 }: Props) {
  const { texture, aspect } = useMemo(() => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    ctx.font = FONT;
    const w = Math.ceil(ctx.measureText(text).width) + 28;
    const h = 60;
    canvas.width = w;
    canvas.height = h;
    ctx.font = FONT;
    ctx.fillStyle = bg;
    ctx.strokeStyle = border;
    ctx.lineWidth = 3;
    roundRect(ctx, 1.5, 1.5, w - 3, h - 3, 14);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 14, h / 2 + 1);
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return { texture: t, aspect: w / h };
  }, [text, color, bg, border]);
  useEffect(() => () => texture.dispose(), [texture]);
  return (
    <sprite position={position} scale={[size * aspect, size, 1]} renderOrder={renderOrder} center={new THREE.Vector2(0.5, 0)}>
      <spriteMaterial map={texture} sizeAttenuation={false} depthTest={depthTest} depthWrite={false} transparent />
    </sprite>
  );
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

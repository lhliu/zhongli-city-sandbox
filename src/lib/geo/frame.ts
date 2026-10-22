/**
 * 專案座標框架（規格 §6.2）。唯一的座標轉換入口，其他模組不得自行換算。
 *
 * 局部公尺座標：X 向東、Y 向上、Z 向南。
 * - image：未完成地理校準的官方圖面；只保存像素與比例，不能輸出 WGS84。
 * - geo：已知 CRS（TWD97/TM2, EPSG:3826）的地理框架。
 */
import { twd97ToWgs84, wgs84ToTwd97 } from './crs';

export type ImageFrame = {
  kind: 'image';
  /** 底圖來源 ID（source_documents） */
  sourceId: string;
  metersPerPixel: number;
  /** 局部原點所在像素 */
  originPx: [number, number];
  /** 圖面北方朝上；false 時須先校正，不允許直接建模 */
  northUp: true;
};

export type GeoFrame = {
  kind: 'geo';
  crs: 'EPSG:3826';
  /** 局部原點（TWD97 E/N，公尺） */
  originEN: [number, number];
  /** 局部原點高程；沒有可靠地形時為 0 並標示平地模型 */
  originH: number;
};

export type ProjectFrame = ImageFrame | GeoFrame;

/** 局部平面座標 [x東, z南]（公尺） */
export type LocalXZ = [number, number];

export function pixelToLocal(frame: ImageFrame, px: [number, number]): LocalXZ {
  const s = frame.metersPerPixel;
  // 影像 y 向下＝向南，與局部 Z 同向
  return [(px[0] - frame.originPx[0]) * s, (px[1] - frame.originPx[1]) * s];
}

export function localToPixel(frame: ImageFrame, p: LocalXZ): [number, number] {
  const s = frame.metersPerPixel;
  return [p[0] / s + frame.originPx[0], p[1] / s + frame.originPx[1]];
}

export function enToLocal(frame: GeoFrame, en: [number, number]): LocalXZ {
  return [en[0] - frame.originEN[0], -(en[1] - frame.originEN[1])];
}

export function localToEn(frame: GeoFrame, p: LocalXZ): [number, number] {
  return [p[0] + frame.originEN[0], frame.originEN[1] - p[1]];
}

/** GeoJSON 順序 [lon, lat] */
export function lonLatToLocal(frame: GeoFrame, lonLat: [number, number]): LocalXZ {
  return enToLocal(frame, wgs84ToTwd97(lonLat));
}

export function localToLonLat(frame: ProjectFrame, p: LocalXZ): [number, number] {
  if (frame.kind !== 'geo') {
    throw new Error('圖面座標模式不能輸出 WGS84：請先完成地理校準');
  }
  return twd97ToWgs84(localToEn(frame, p));
}

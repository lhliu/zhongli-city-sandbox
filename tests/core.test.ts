import { describe, expect, it } from 'vitest';
import { wgs84ToTwd97, twd97ToWgs84 } from '../src/lib/geo/crs';
import { enToLocal, localToEn, localToLonLat, pixelToLocal, localToPixel, type GeoFrame, type ImageFrame } from '../src/lib/geo/frame';
import { azimuthToRotationY, azimuthToVector, rectangleFootprint, vectorToAzimuth } from '../src/lib/geo/azimuth';
import { parseLandNumber, parseLandNumberParts, formatLandNumber, cadastralKeyString } from '../src/lib/parcel/key';
import { estimateHeightFromFloors, totalHeight, pickHeight } from '../src/lib/geometry/height';
import { validatePolygon, polygonArea, footprintInSites, unionSites } from '../src/lib/geometry/polygon';
import { fitAffine, applyAffine, type ControlPoint } from '../src/lib/calibration/affine';

describe('CRS 與局部座標', () => {
  it('EPSG:3826 中央經線 121°E 落在 E=250000', () => {
    const [e, n] = wgs84ToTwd97([121, 24.95]);
    expect(e).toBeCloseTo(250000, 3);
    expect(n).toBeGreaterThan(2_700_000);
    expect(n).toBeLessThan(2_770_000);
  });

  it('WGS84 ↔ TWD97 往返誤差 < 1mm', () => {
    const p: [number, number] = [121.2311, 24.9566];
    const back = twd97ToWgs84(wgs84ToTwd97(p));
    expect(Math.abs(back[0] - p[0])).toBeLessThan(1e-8);
    expect(Math.abs(back[1] - p[1])).toBeLessThan(1e-8);
  });

  it('局部座標：往北為 −Z、往東為 +X', () => {
    const f: GeoFrame = { kind: 'geo', crs: 'EPSG:3826', originEN: [270000, 2760000], originH: 0 };
    expect(enToLocal(f, [270010, 2760000])).toEqual([10, -0]);
    expect(enToLocal(f, [270000, 2760025])).toEqual([0, -25]);
    expect(localToEn(f, enToLocal(f, [270123.4, 2759876.5]))).toEqual([270123.4, 2759876.5]);
  });

  it('圖面座標：像素 y 向下對應 +Z（南），比例正確', () => {
    const f: ImageFrame = { kind: 'image', sourceId: 'S2', metersPerPixel: 2, originPx: [100, 100], northUp: true };
    expect(pixelToLocal(f, [110, 90])).toEqual([20, -20]);
    expect(localToPixel(f, pixelToLocal(f, [333, 444]))).toEqual([333, 444]);
  });

  it('圖面座標模式拒絕輸出 WGS84', () => {
    const f: ImageFrame = { kind: 'image', sourceId: 'S2', metersPerPixel: 2, originPx: [0, 0], northUp: true };
    expect(() => localToLonLat(f, [0, 0])).toThrow(/圖面座標模式/);
  });
});

describe('方位角（北＝0，順時針）', () => {
  it('向量對應北東南西', () => {
    const near = (v: [number, number], e: [number, number]) => {
      expect(v[0]).toBeCloseTo(e[0], 9);
      expect(v[1]).toBeCloseTo(e[1], 9);
    };
    near(azimuthToVector(0), [0, -1]);
    near(azimuthToVector(90), [1, 0]);
    near(azimuthToVector(180), [0, 1]);
    near(azimuthToVector(270), [-1, 0]);
    expect(vectorToAzimuth([1, 0])).toBeCloseTo(90);
  });

  it('rotation.y 將物件北面（−Z）轉向方位角', () => {
    const t = azimuthToRotationY(90);
    // 以 Three.js 繞 Y 軸旋轉公式旋轉 (0,0,−1)
    const x = 0 * Math.cos(t) + -1 * Math.sin(t);
    const z = -0 * Math.sin(t) + -1 * Math.cos(t);
    expect(x).toBeCloseTo(1);
    expect(z).toBeCloseTo(0);
  });

  it('矩形 footprint 尺寸與方位正確', () => {
    const r = rectangleFootprint([0, 0], 20, 10, 90);
    expect(polygonArea([r])).toBeCloseTo(200);
    // 方位 90° 時深度沿東西向
    const xs = r.map((p) => p[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(10);
  });
});

describe('地號正規化', () => {
  it('多種寫法得到相同 canonical', () => {
    for (const raw of ['123-4', '0123-0004', '１２３－４', ' 123-4 ', '01230004']) {
      const r = parseLandNumber(raw);
      expect(r.ok, raw).toBe(true);
      if (r.ok) expect([r.value.main, r.value.sub]).toEqual(['0123', '0004']);
    }
  });

  it('無子號視為 0000，顯示回 123', () => {
    const r = parseLandNumber('123');
    expect(r.ok && r.value.sub).toBe('0000');
    expect(formatLandNumber({ main: '0123', sub: '0000' })).toBe('123');
  });

  it('拒絕非地號（道路寬度、街廓代號、日期）', () => {
    for (const raw of ['30M', '住(再)', '2026/1/2', '12345-1', '0', 'A20']) {
      expect(parseLandNumber(raw).ok, raw).toBe(false);
    }
  });

  it('母號／子號欄位組合', () => {
    const r = parseLandNumberParts('46', '');
    expect(r.ok && r.value.main + r.value.sub).toBe('00460000');
  });

  it('沒有地段代碼不能組成地籍鍵', () => {
    expect(() => cadastralKeyString({ county: '桃園市', district: '中壢區', sectionCode: '', main: '0123', sub: '0000' })).toThrow();
  });
});

describe('高度', () => {
  it('層數估算公式', () => {
    expect(estimateHeightFromFloors(1)).toBe(4.2);
    expect(estimateHeightFromFloors(15)).toBe(4.2 + 14 * 3.3);
    expect(estimateHeightFromFloors(null)).toBeNull();
    expect(estimateHeightFromFloors(0)).toBeNull();
  });

  it('裙樓＋塔樓取最高頂標高，不重複累加', () => {
    expect(
      totalHeight([
        { baseHeightM: 0, heightM: 12, heightSource: 'user' },
        { baseHeightM: 12, heightM: 60, heightSource: 'user' },
      ]),
    ).toBe(72);
  });

  it('任一段未知 → 總高未知（null，不是 0）', () => {
    expect(totalHeight([{ baseHeightM: 0, heightM: null, heightSource: null }])).toBeNull();
  });

  it('優先級：核對 > 文件 > 使用者 > 估算', () => {
    expect(
      pickHeight([
        { value: 50, source: 'estimated' },
        { value: 48.5, source: 'documented' },
        { value: 49, source: 'user' },
      ]),
    ).toEqual({ value: 48.5, source: 'documented' });
    expect(pickHeight([{ value: null, source: 'verified' }])).toBeNull();
  });
});

describe('多邊形檢查與基地聯集', () => {
  const sq = (x: number, z: number, s: number): [number, number][] => [
    [x, z],
    [x + s, z],
    [x + s, z + s],
    [x, z + s],
  ];

  it('合法多邊形無問題，含洞面積正確', () => {
    expect(validatePolygon([sq(0, 0, 10)])).toEqual([]);
    expect(polygonArea([sq(0, 0, 10), sq(2, 2, 2)])).toBeCloseTo(96);
  });

  it('偵測自交（蝴蝶結）', () => {
    const bow: [number, number][] = [
      [0, 0],
      [10, 10],
      [10, 0],
      [0, 10],
    ];
    expect(validatePolygon([bow]).map((i) => i.code)).toContain('self_intersection');
  });

  it('偵測洞在外環外、非有限數、點數不足', () => {
    expect(validatePolygon([sq(0, 0, 10), sq(20, 20, 2)]).map((i) => i.code)).toContain('hole_outside_shell');
    expect(validatePolygon([[[0, 0], [1, NaN], [2, 2]]]).map((i) => i.code)).toEqual(['non_finite']);
    expect(validatePolygon([[[0, 0], [1, 1], [0, 0]]]).map((i) => i.code)).toEqual(['too_few_points']);
  });

  it('建物跨兩筆相鄰地號但在聯集內 → inside', () => {
    const a = sq(0, 0, 20);
    const b = sq(20, 0, 20);
    const fp = sq(15, 5, 10); // 跨越 x=20 交界
    expect(footprintInSites([fp], [[a]])).toMatchObject({ status: 'outside' });
    expect(footprintInSites([fp], [[a], [b]])).toEqual({ status: 'inside' });
    expect(unionSites([[a], [b]])!.geometry.type).toBe('Polygon');
  });

  it('超出聯集回報超出面積；沒有基地回 no_site', () => {
    const r = footprintInSites([sq(15, 15, 10)], [[sq(0, 0, 20)]]);
    expect(r).toEqual({ status: 'outside', outsideAreaM2: 75 });
    expect(footprintInSites([sq(0, 0, 1)], [])).toEqual({ status: 'no_site' });
  });
});

describe('仿射校準', () => {
  const truth = (p: [number, number]): [number, number] => [2.2 * p[0] - 0.1 * p[1] + 5, 0.1 * p[0] + 2.2 * p[1] - 7];
  const pts = (list: [number, number][], role: 'fit' | 'check', noise = 0): ControlPoint[] =>
    list.map((src, i) => {
      const d = truth(src);
      return { id: `${role}${i}`, src, dst: [d[0] + (i % 2 ? noise : -noise), d[1] + (i % 3 ? noise : -noise)], role };
    });

  it('無雜訊時還原轉換，檢核點誤差 ~0', () => {
    const r = fitAffine([...pts([[0, 0], [100, 0], [0, 100], [100, 100], [50, 20], [20, 80]], 'fit'), ...pts([[30, 30], [70, 60], [90, 10]], 'check')]);
    expect(r.checkRmse).toBeLessThan(1e-6);
    expect(applyAffine(r.transform, [10, 10])[0]).toBeCloseTo(truth([10, 10])[0], 6);
    expect(r.passesDisplayThreshold).toBe(true);
  });

  it('雜訊大時不通過顯示門檻', () => {
    const r = fitAffine([...pts([[0, 0], [100, 0], [0, 100], [100, 100], [50, 20], [20, 80]], 'fit', 4), ...pts([[30, 30], [70, 60], [90, 10]], 'check', 6)]);
    expect(r.passesDisplayThreshold).toBe(false);
  });

  it('沒有檢核點不能通過；共線點拒絕', () => {
    expect(fitAffine(pts([[0, 0], [100, 0], [0, 100], [80, 90]], 'fit')).passesDisplayThreshold).toBe(false);
    expect(() => fitAffine(pts([[0, 0], [10, 10], [20, 20], [30, 30]], 'fit'))).toThrow(/共線/);
  });
});

import { useState } from 'react';
import { useStore } from '../../store';
import { api, errorText } from '../../api';
import type { SceneDTO } from '../../lib/model/types';
import { validatePolygon, polygonArea } from '../../lib/geometry/polygon';
import type { Affine } from '../../lib/calibration/affine';

const ISSUE_TEXT: Record<string, string> = {
  too_few_points: '至少要 3 個不同的點', non_finite: '座標無效', zero_area: '面積為 0',
  self_intersection: '邊線自我交叉，請調整點的順序', hole_outside_shell: '洞在外框外', too_many_points: '點數過多',
};

/** 局部公尺 → 底圖像素（校準仿射的反算），保留原始描點供追溯 */
function toPixels(t: Affine, pts: [number, number][]): [number, number][] {
  const [a, b, c, d, e, f] = t;
  const det = a * e - b * d;
  return pts.map(([x, z]) => [Math.round(((e * (x - c) - b * (z - f)) / det) * 10) / 10, Math.round(((-d * (x - c) + a * (z - f)) / det) * 10) / 10]);
}

export function DrawPanel({ scene }: { scene: SceneDTO }) {
  const draw = useStore((s) => s.draw);
  const { startDraw, undoDrawPoint, endDraw, reload, select, setSave } = useStore();
  const [kind, setKind] = useState<'reference_block' | 'cadastral'>('reference_block');
  const [f, setF] = useState({ blockId: '', zoning: '', county: '桃園市', district: '中壢區', sectionCode: '', sectionName: '', landRaw: '', note: '' });
  const [err, setErr] = useState<string | null>(null);
  if (scene.role === 'viewer') return null;
  const base = scene.layers.find((l) => l.calibration);
  const issues = draw.points.length >= 3 ? validatePolygon([draw.points]) : [];

  async function finish() {
    setErr(null);
    const geometry = [draw.points];
    const sourcePx = base?.calibration ? [toPixels(base.calibration.transform, draw.points)] : null;
    const sourceId = scene.sources.find((s) => s.code === base?.sourceCode)?.id ?? null;
    setSave({ kind: 'saving' });
    try {
      if (draw.target.type === 'parcel') {
        await api(`/parcels/${draw.target.id}/geometry`, { method: 'POST', json: { expectedVersion: draw.target.expectedVersion, geometry, sourcePx, qualityNote: f.note || '人工於底圖重描' } });
        select({ type: 'parcel', ids: [draw.target.id] });
      } else {
        const body = kind === 'reference_block'
          ? { kind, blockId: f.blockId.trim(), label: null, zoning: f.zoning || null, geometry, sourcePx, sourceId, qualityNote: f.note || `人工於 ${base?.sourceCode ?? '底圖'} 描繪` }
          : { kind, county: f.county, district: f.district, sectionCode: f.sectionCode.trim(), sectionName: f.sectionName || null, landRaw: f.landRaw.trim(), zoning: f.zoning || null, geometry, sourceId, qualityNote: f.note || `人工於 ${base?.sourceCode ?? '底圖'} 描繪（地號待核對）` };
        const r = await api<{ id: string }>(`/projects/${scene.project.id}/parcels`, { method: 'POST', json: body });
        select({ type: 'parcel', ids: [r.id] });
      }
      endDraw();
      await reload();
      setSave({ kind: 'saved', at: Date.now() });
    } catch (e) {
      setErr(errorText(e));
      setSave({ kind: 'error', message: errorText(e) });
    }
  }

  if (!draw.active)
    return (
      <div style={{ marginTop: 14 }}>
        <h2>描圖</h2>
        <button onClick={() => startDraw({ type: 'new' })}>在底圖描新地塊</button>
        <p className="hint">切到俯視後依序點擊街廓角點，完成後填區塊代號或地號。拖曳是平移地圖，不會加點。</p>
      </div>
    );
  const valid = draw.points.length >= 3 && issues.length === 0;
  const formOk = draw.target.type === 'parcel' || (kind === 'reference_block' ? !!f.blockId.trim() : !!f.sectionCode.trim() && !!f.landRaw.trim());
  return (
    <div style={{ marginTop: 14 }} className="card">
      <h2>{draw.target.type === 'parcel' ? '重描圖形（建立新版本）' : '描新地塊'}</h2>
      <div className="hint">已點 {draw.points.length} 點{valid ? `｜面積約 ${Math.round(polygonArea([draw.points])).toLocaleString()} m²` : ''}</div>
      {issues.map((i) => <div key={i.code} className="err">{ISSUE_TEXT[i.code]}</div>)}
      <div className="row" style={{ margin: '6px 0' }}>
        <button disabled={!draw.points.length} onClick={undoDrawPoint}>復原一點</button>
        <button className="danger" onClick={endDraw}>取消</button>
      </div>
      {draw.target.type === 'new' && (
        <>
          <label>類型
            <select value={kind} onChange={(e) => setKind(e.target.value as 'cadastral')}>
              <option value="reference_block">參考區塊（沒有地號）</option>
              <option value="cadastral">地籍土地（有地號）</option>
            </select>
          </label>
          {kind === 'reference_block' ? (
            <label>區塊代號<input value={f.blockId} onChange={(e) => setF({ ...f, blockId: e.target.value })} placeholder="例如 S2-R20" /></label>
          ) : (
            <>
              <div className="row">
                <label>縣市<input value={f.county} onChange={(e) => setF({ ...f, county: e.target.value })} /></label>
                <label>行政區<input value={f.district} onChange={(e) => setF({ ...f, district: e.target.value })} /></label>
              </div>
              <div className="row">
                <label>地段代碼（必填）<input value={f.sectionCode} onChange={(e) => setF({ ...f, sectionCode: e.target.value })} /></label>
                <label>地段名稱<input value={f.sectionName} onChange={(e) => setF({ ...f, sectionName: e.target.value })} /></label>
              </div>
              <label>地號（母號-子號）<input value={f.landRaw} onChange={(e) => setF({ ...f, landRaw: e.target.value })} placeholder="例如 123-4" /></label>
              <div className="warn">不可填造假地號；不確定就改用參考區塊。</div>
            </>
          )}
          <label>分區<input value={f.zoning} onChange={(e) => setF({ ...f, zoning: e.target.value })} placeholder="例如 住宅區" /></label>
        </>
      )}
      <label>品質說明<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="例如 依 S2 描繪，角點誤差約 2px" /></label>
      {err && <div className="err" style={{ marginTop: 6 }}>{err}</div>}
      <button className="primary" style={{ marginTop: 8 }} disabled={!valid || !formOk} onClick={finish}>完成並儲存</button>
    </div>
  );
}

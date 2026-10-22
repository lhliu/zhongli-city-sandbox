import { useEffect, useState } from 'react';
import { NavLink, useParams } from 'react-router-dom';
import { useStore, type LayerKey } from '../../store';
import { api, errorText } from '../../api';
import { Scene3D } from './Scene3D';
import { RightPanel } from './RightPanel';
import { DrawPanel } from './DrawPanel';
import { currentCameraState } from './bridge';
import { EXPORT_SIZES, download, exportPng } from './exportPng';
import { walkInput } from './WalkControls';
import { SCENARIO_KIND_LABEL } from '../../lib/model/labels';
import type { SceneDTO } from '../../lib/model/types';
import { formatLandNumber, parseLandNumber } from '../../lib/parcel/key';

export function TopBar({ scene, projectId, extra }: { scene: SceneDTO | null; projectId: string; extra?: React.ReactNode }) {
  const save = useStore((s) => s.save);
  return (
    <header className="topbar">
      <span className="title">KC 城市沙盤｜中壢體育園區</span>
      <NavLink to={`/projects/${projectId}/explore`}>3D 沙盤</NavLink>
      <NavLink to={`/projects/${projectId}/data`} className="edit-only">資料表</NavLink>
      <NavLink to={`/projects/${projectId}/sources`} className="edit-only">資料來源</NavLink>
      {extra}
      <span className="spacer" />
      {scene && <span className="savestate">{scene.role === 'viewer' ? '檢視者' : scene.role === 'owner' ? '擁有者' : '編輯者'}</span>}
      <span className={`savestate ${save.kind}`}>
        {save.kind === 'saving' && '儲存中…'}
        {save.kind === 'saved' && '已儲存'}
        {save.kind === 'conflict' && `衝突：${save.message}`}
        {save.kind === 'error' && `儲存失敗：${save.message}`}
      </span>
    </header>
  );
}

const LAYER_LABEL: Record<LayerKey, string> = {
  basemap: '官方底圖（S2）', boundary: '區段徵收範圍', parcels: '地塊／參考區塊', parks: '公園／公共設施', buildings: '建築量體', labels: '標籤',
};

function LayerPanel() {
  const layers = useStore((s) => s.layers);
  const setLayer = useStore((s) => s.setLayer);
  return (
    <div>
      <h2>圖層</h2>
      {(Object.keys(LAYER_LABEL) as LayerKey[]).map((k) => (
        <div className="layerrow" key={k}>
          <input type="checkbox" checked={layers[k].visible} onChange={(e) => setLayer(k, { visible: e.target.checked })} aria-label={LAYER_LABEL[k]} />
          <span>{LAYER_LABEL[k]}</span>
          <input type="range" min={0} max={1} step={0.05} value={layers[k].opacity} onChange={(e) => setLayer(k, { opacity: Number(e.target.value) })} aria-label={`${LAYER_LABEL[k]}透明度`} />
        </div>
      ))}
      <h3>圖例</h3>
      <div style={{ display: 'grid', gap: 4 }}>
        <span className="tag verified">已核對（實線）</span>
        <span className="tag planned">規劃（藍）</span>
        <span className="tag estimated">推估（橘虛線）</span>
        <span className="tag assumption">假設（紫虛線）</span>
        <span className="tag reference">參考描繪（虛線地塊）</span>
      </div>
      <p className="hint" style={{ marginTop: 10 }}>底圖為官方範圍圖，以比例尺量測換算公尺（約 2.22 m/px，誤差約 ±5.6%），未做地理校準。平地模型，地面高程 0。</p>
    </div>
  );
}

function Search({ scene }: { scene: SceneDTO }) {
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const select = useStore((s) => s.select);
  async function go() {
    const text = q.trim();
    if (!text) return;
    // 建案名稱或代碼、建商
    const devs = scene.developments.filter((d) => d.name.includes(text) || d.code === text);
    const devByDeveloper = scene.developments.filter((d) =>
      d.developers.some((l) => {
        const dv = scene.developers.find((x) => x.id === l.developerId);
        return dv && ((dv.companyName ?? '').includes(text) || (dv.brandName ?? '').includes(text));
      }),
    );
    const allDevs = [...new Map([...devs, ...devByDeveloper].map((d) => [d.id, d])).values()];
    if (allDevs.length === 1) {
      select({ type: 'development', id: allDevs[0]!.id });
      setMsg(null);
      return;
    }
    try {
      const r = await api<{ matches: { id: string }[]; ambiguous: boolean }>(`/projects/${scene.project.id}/parcels/search?q=${encodeURIComponent(text)}`);
      if (r.matches.length === 1) {
        select({ type: 'parcel', ids: [r.matches[0]!.id] });
        setMsg(null);
      } else if (r.matches.length > 1 || allDevs.length > 1) {
        const ln = parseLandNumber(text);
        setMsg(`有 ${r.matches.length + allDevs.length} 筆符合${ln.ok ? `（地號 ${formatLandNumber(ln.value)} 在多個地段）` : ''}，請加上地段名稱，例如「中興段 ${text}」`);
      } else setMsg('沒有匹配資料');
    } catch (e) {
      setMsg(errorText(e));
    }
  }
  return (
    <span style={{ position: 'relative' }}>
      <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} placeholder="搜尋 地段 地號／區塊／案名／建商" style={{ width: 230 }} />
      {msg && (
        <span style={{ position: 'absolute', top: 34, left: 0, zIndex: 5, background: '#fff', color: '#1f2a26', border: '1px solid #ddd', borderRadius: 6, padding: '4px 8px', fontSize: 12, width: 260 }}>
          {msg} <button style={{ padding: '0 6px' }} onClick={() => setMsg(null)}>×</button>
        </span>
      )}
    </span>
  );
}

function BottomBar({ scene }: { scene: SceneDTO }) {
  const mode = useStore((s) => s.cameraMode);
  const setMode = useStore((s) => s.setCameraMode);
  const eye = useStore((s) => s.eyeHeightM);
  const setEye = useStore((s) => s.setEyeHeight);
  const reload = useStore((s) => s.reload);
  const resetCamera = useStore((s) => s.resetCamera);
  const applyBookmark = useStore((s) => s.applyBookmark);
  const videoMode = useStore((s) => s.videoMode);
  const setVideoMode = useStore((s) => s.setVideoMode);
  const setScenario = useStore((s) => s.setScenario);
  const [bmName, setBmName] = useState('');
  const [sizeIdx, setSizeIdx] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [freeFly, setFreeFly] = useState(false);
  const canEdit = scene.role !== 'viewer';
  const sc = scene.scenario;

  async function saveBookmark() {
    const cam = currentCameraState(mode === 'walk' ? eye : null);
    if (!cam) return;
    try {
      await api(`/projects/${scene.project.id}/bookmarks`, { method: 'POST', json: { name: bmName.trim(), mode, scenarioId: sc.id, camera: cam } });
      setBmName('');
      await reload();
    } catch (e) {
      alert(errorText(e));
    }
  }

  async function doExport() {
    setBusy('輸出中…');
    try {
      const size = EXPORT_SIZES[sizeIdx]!;
      const { png, meta } = await exportPng(scene, size, mode === 'walk' ? eye : null);
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
      // 檔名用 ASCII（部分瀏覽器不支援中文下載檔名）；情境中文名稱記在 JSON
      const base = `zhongli_${sc.kind}${sc.isDemo ? '_DEMO' : ''}_r${sc.revision}_${size.w}x${size.h}_${stamp}`;
      download(png, `${base}.png`);
      download(new Blob([JSON.stringify(meta, null, 2)], { type: 'application/json' }), `${base}.json`);
      setBusy(null);
    } catch (e) {
      setBusy(null);
      alert(errorText(e));
    }
  }

  return (
    <footer className="bottombar">
      <div className="group">
        <span>情境</span>
        <select value={sc.id} onChange={(e) => setScenario(e.target.value)} aria-label="情境">
          {scene.scenarios.map((s) => (
            <option key={s.id} value={s.id}>{s.name === SCENARIO_KIND_LABEL[s.kind] ? s.name : `${SCENARIO_KIND_LABEL[s.kind]}｜${s.name}`}</option>
          ))}
        </select>
      </div>
      <div className="group">
        <span>資料截至</span><strong>{sc.dataAsOf ?? '未設定'}</strong>
        <span>目標日</span><strong>{sc.targetDate ?? '未設定'}</strong>
      </div>
      <div className="group">
        <span>視角</span>
        <button className={mode === 'top' ? 'on' : ''} onClick={() => setMode('top')}>俯視</button>
        <button className={mode === 'orbit' ? 'on' : ''} onClick={() => setMode('orbit')}>鳥瞰</button>
        <button className={mode === 'walk' ? 'on' : ''} onClick={() => setMode('walk')}>平視</button>
        <button onClick={resetCamera} disabled={mode === 'walk'}>回到全區</button>
      </div>
      {mode === 'walk' && (
        <div className="group">
          <span>視高 m</span>
          <input type="number" min={0.5} max={300} step={0.1} value={eye} onChange={(e) => setEye(Math.max(0.5, Number(e.target.value) || 1.6))} style={{ width: 70 }} aria-label="視高" />
          <label style={{ display: 'flex', gap: 4, alignItems: 'center', color: 'inherit' }}>
            <input type="checkbox" checked={freeFly} onChange={(e) => { walkInput.freeFly = e.target.checked; setFreeFly(e.target.checked); }} /> 自由飛行（Q/E 升降）
          </label>
          <button onClick={() => document.querySelector('canvas')?.requestPointerLock()}>鎖定滑鼠（Esc 退出）</button>
        </div>
      )}
      <div className="group edit-only">
        <span>收藏視角</span>
        <select value="" onChange={(e) => {
          const b = scene.bookmarks.find((x) => x.id === e.target.value);
          if (b) applyBookmark({ mode: b.mode, camera: b.camera });
          if (b?.camera.eyeHeightM) setEye(b.camera.eyeHeightM);
        }} aria-label="套用收藏視角">
          <option value="">套用…</option>
          {scene.bookmarks.map((b) => <option key={b.id} value={b.id}>{b.name}（{b.mode === 'top' ? '俯視' : b.mode === 'orbit' ? '鳥瞰' : '平視'}）</option>)}
        </select>
        {canEdit && (
          <>
            <input value={bmName} onChange={(e) => setBmName(e.target.value)} placeholder="視角名稱" style={{ width: 100 }} />
            <button disabled={!bmName.trim()} onClick={saveBookmark}>收藏目前視角</button>
          </>
        )}
      </div>
      <div className="group edit-only">
        <span>輸出</span>
        <select value={sizeIdx} onChange={(e) => setSizeIdx(Number(e.target.value))} aria-label="輸出尺寸">
          {EXPORT_SIZES.map((s, i) => <option key={s.label} value={i}>{s.label}</option>)}
        </select>
        <button onClick={doExport} disabled={!!busy}>{busy ?? '下載 PNG'}</button>
      </div>
      <div className="group">
        <button className={videoMode ? 'on' : ''} onClick={() => setVideoMode(!videoMode)}>{videoMode ? '離開影片模式' : '影片模式'}</button>
      </div>
    </footer>
  );
}

function TouchPad() {
  const hold = (f: number, r: number) => ({
    onPointerDown: () => { walkInput.forward = f; walkInput.right = r; },
    onPointerUp: () => { walkInput.forward = 0; walkInput.right = 0; },
    onPointerLeave: () => { walkInput.forward = 0; walkInput.right = 0; },
  });
  return (
    <div className="overlay" style={{ right: 12, bottom: 12, display: 'grid', gridTemplateColumns: 'repeat(3, 40px)', gap: 4 }}>
      <span />
      <button aria-label="前進" {...hold(1, 0)}>▲</button>
      <span />
      <button aria-label="左移" {...hold(0, -1)}>◀</button>
      <button aria-label="後退" {...hold(-1, 0)}>▼</button>
      <button aria-label="右移" {...hold(0, 1)}>▶</button>
    </div>
  );
}

export function ExplorePage() {
  const { id = '' } = useParams();
  const { scene, load, loadError, loading, cameraMode, videoMode } = useStore();
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [safe, setSafe] = useState<'none' | '16:9' | '9:16'>('none');

  useEffect(() => {
    if (useStore.getState().projectId !== id || !useStore.getState().scene) void load(id);
  }, [id, load]);

  if (loadError) return <div className="page"><div className="err">{loadError}</div></div>;
  if (!scene || loading) return <div className="page"><div className="empty">載入中…</div></div>;
  const sc = scene.scenario;
  const hasEstimate = scene.buildings.some((b) => b.attribute === 'estimated' || b.attribute === 'assumption' || b.footprintIsAssumed);

  return (
    <div className={`app ${videoMode ? 'video' : ''}`}>
      <TopBar scene={scene} projectId={id} extra={<span className="edit-only"><Search scene={scene} /></span>} />
      <div className="workspace">
        <aside className={`left ${leftOpen ? '' : 'collapsed'}`}><LayerPanel /><DrawPanel scene={scene} /></aside>
        <div className="canvaswrap">
          <Scene3D scene={scene} />
          <button className="paneltoggle" style={{ left: 0 }} onClick={() => setLeftOpen(!leftOpen)} aria-label="切換圖層面板">{leftOpen ? '◀' : '▶'}</button>
          <button className="paneltoggle" style={{ right: 0 }} onClick={() => setRightOpen(!rightOpen)} aria-label="切換資訊面板">{rightOpen ? '▶' : '◀'}</button>
          <div className="overlay hud-tags">
            <span className={`tag ${sc.kind === 'observed' ? 'verified' : sc.kind === 'planned' ? 'planned' : 'assumption'}`}>{SCENARIO_KIND_LABEL[sc.kind]}{sc.name !== SCENARIO_KIND_LABEL[sc.kind] ? `｜${sc.name}` : ''}</span>
            {sc.isDemo && <span className="tag demo">DEMO 非真實資料</span>}
            <span className="tag pending">資料截至 {sc.dataAsOf ?? '未設定'}</span>
            {hasEstimate && <span className="tag estimated">含推估／假設</span>}
            <span className="tag reference">底圖：S2 參考描繪</span>
          </div>
          <div className="overlay compass" aria-label="指北針">
            <svg width="44" height="44" viewBox="0 0 44 44" style={{ display: cameraMode === 'top' ? 'block' : 'none' }}>
              <circle cx="22" cy="22" r="20" fill="rgba(255,253,248,0.9)" stroke="#ddd6c8" />
              <path d="M22 6 L27 24 L22 21 L17 24 Z" fill="#c62828" />
              <text x="22" y="38" textAnchor="middle" fontSize="10" fill="#1f2a26">N</text>
            </svg>
          </div>
          {cameraMode === 'top' && <ScaleBar />}
          {cameraMode === 'walk' && <TouchPad />}
          {cameraMode === 'walk' && <div className="overlay hud" style={{ bottom: 12 }}>平視｜拖曳環視、WASD 移動、Shift 加速、雙擊地面移動｜平地模型</div>}
          {safe !== 'none' && <SafeFrame ratio={safe} />}
          <div className="overlay" style={{ right: 12, top: 60 }}>
            <select value={safe} onChange={(e) => setSafe(e.target.value as 'none')} aria-label="安全框">
              <option value="none">安全框：無</option><option value="16:9">16:9</option><option value="9:16">9:16</option>
            </select>
          </div>
        </div>
        <aside className={`right ${rightOpen ? '' : 'collapsed'}`}><RightPanel scene={scene} /></aside>
      </div>
      <BottomBar scene={scene} />
    </div>
  );
}

function SafeFrame({ ratio }: { ratio: '16:9' | '9:16' }) {
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = document.querySelector('.canvaswrap');
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  if (!box) return null;
  const r = ratio === '16:9' ? 16 / 9 : 9 / 16;
  let w = box.w * 0.9;
  let h = w / r;
  if (h > box.h * 0.9) { h = box.h * 0.9; w = h * r; }
  return <div className="safe-frame" style={{ width: w, height: h, left: (box.w - w) / 2, top: (box.h - h) / 2 }} />;
}

/** 俯視比例尺：依正交相機縮放換算 */
function ScaleBar() {
  const [label, setLabel] = useState<{ px: number; m: number } | null>(null);
  useEffect(() => {
    const t = setInterval(async () => {
      const { bridge } = await import('./bridge');
      const cam = bridge.camera as import('three').OrthographicCamera | null;
      if (!cam || !cam.isOrthographicCamera) return;
      const el = document.querySelector('.canvaswrap canvas') as HTMLCanvasElement | null;
      if (!el) return;
      const metersPerPx = (cam.top - cam.bottom) / cam.zoom / el.clientHeight;
      const nice = [10, 20, 50, 100, 200, 500, 1000];
      const m = nice.find((n) => n / metersPerPx > 60) ?? 1000;
      setLabel({ px: m / metersPerPx, m });
    }, 300);
    return () => clearInterval(t);
  }, []);
  if (!label) return null;
  return (
    <div className="overlay hud" style={{ right: 12, bottom: 12, left: 'auto' }}>
      <div style={{ width: label.px, height: 6, border: '2px solid #1f2a26', borderTop: 0 }} />
      {label.m} m（圖面比例換算）
    </div>
  );
}

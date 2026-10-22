import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import { api, ApiCallError, errorText } from '../../api';
import type { BuildingDTO, DevelopmentDTO, ParcelDTO, SceneDTO } from '../../lib/model/types';
import { ATTR_LABEL, STATUS_LABEL, VERIFY_LABEL, formatPartialDate } from '../../lib/model/labels';
import { formatLandNumber } from '../../lib/parcel/key';
import { polygonArea, unionSites, footprintInSites } from '../../lib/geometry/polygon';
import { DEFAULT_FLOOR_ASSUMPTION, estimateHeightFromFloors, totalHeight } from '../../lib/geometry/height';
import { rectangleFootprint, vectorToAzimuth } from '../../lib/geo/azimuth';
import { ringCentroid } from '../../lib/three/geometry';
import type { BuildingInput } from '../../lib/model/schemas';

function parcelTitle(p: ParcelDTO) {
  if (p.kind === 'reference_block') return `${p.blockId}（參考區塊）`;
  return `${p.sectionName ?? p.sectionCode} ${formatLandNumber({ main: p.landMain!, sub: p.landSub! })}`;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T | undefined> {
  const { setSave, reload } = useStore.getState();
  setSave({ kind: 'saving' });
  try {
    const r = await fn();
    await reload();
    setSave({ kind: 'saved', at: Date.now() });
    return r;
  } catch (e) {
    if (e instanceof ApiCallError && e.status === 409) {
      setSave({ kind: 'conflict', message: e.body.message });
      await reload();
    } else setSave({ kind: 'error', message: errorText(e) });
    return undefined;
  }
}

export function RightPanel({ scene }: { scene: SceneDTO }) {
  const sel = useStore((s) => s.selection);
  const canEdit = scene.role !== 'viewer';
  if (!sel)
    return (
      <div>
        <h2>操作提示</h2>
        <ul className="hint" style={{ paddingLeft: 18 }}>
          <li>點選地塊查看資料；按住 Shift 可多選，再「以選取土地建立建案」。</li>
          <li>點選建物可編輯棟別樓層、高度與位置。</li>
          <li>底部切換俯視／鳥瞰／平視。平視：拖曳環視、WASD 移動、雙擊地面移動。</li>
          <li>虛線地塊＝參考描繪（S2 官方範圍圖），不是地籍資料。</li>
        </ul>
        <DevelopmentList scene={scene} />
        {!canEdit && <div className="warn">你是檢視者，只能瀏覽。</div>}
      </div>
    );
  if (sel.type === 'parcel') return <ParcelPanel scene={scene} ids={sel.ids} canEdit={canEdit} />;
  if (sel.type === 'development') {
    const d = scene.developments.find((x) => x.id === sel.id);
    return d ? <DevelopmentPanel scene={scene} dev={d} canEdit={canEdit} /> : <div className="empty">建案不存在</div>;
  }
  const b = scene.buildings.find((x) => x.id === sel.id);
  return b ? <BuildingPanel scene={scene} building={b} canEdit={canEdit} /> : <div className="empty">此情境沒有這棟</div>;
}

function DevelopmentList({ scene }: { scene: SceneDTO }) {
  const select = useStore((s) => s.select);
  return (
    <>
      <h3>建案（{scene.developments.length}）</h3>
      {scene.developments.length === 0 && <div className="hint">尚無建案。選取地塊後可建立。</div>}
      {scene.developments.map((d) => (
        <div key={d.id} className="card" style={{ cursor: 'pointer', padding: 8 }} onClick={() => select({ type: 'development', id: d.id })}>
          {d.isDemo && <span className="tag demo">DEMO</span>} <strong>{d.name}</strong> <span className="hint">{d.code}</span>
          <div className="hint">{STATUS_LABEL[d.status]}｜{d.parcelIds.length} 筆土地｜{scene.buildings.filter((b) => b.developmentId === d.id).length} 棟（本情境）</div>
        </div>
      ))}
    </>
  );
}

function ParcelPanel({ scene, ids, canEdit }: { scene: SceneDTO; ids: string[]; canEdit: boolean }) {
  const parcels = ids.map((id) => scene.parcels.find((p) => p.id === id)).filter(Boolean) as ParcelDTO[];
  const select = useStore((s) => s.select);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const geomArea = useMemo(() => {
    const geoms = parcels.filter((p) => p.geometry).map((p) => p.geometry!);
    const u = unionSites(geoms);
    if (!u) return null;
    const g = u.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    return polys.reduce((s, r) => s + polygonArea(r as [number, number][][]), 0);
  }, [parcels]);

  async function create() {
    const r = await guarded(async () => {
      const d = await api<{ id: string; version: number }>(`/projects/${scene.project.id}/developments`, { method: 'POST', json: { code: code.trim(), name: name.trim() } });
      await api(`/developments/${d.id}/parcels`, { method: 'PUT', json: { expectedVersion: d.version, parcelIds: ids } });
      return d;
    });
    if (r) select({ type: 'development', id: r.id });
  }

  if (parcels.length === 1) {
    const p = parcels[0]!;
    return (
      <div>
        <h2>{parcelTitle(p)}</h2>
        {p.kind === 'reference_block' && <div className="warn">參考區塊：由官方圖面描繪的街廓，沒有地號；不可用於精準面積、退縮或權界判斷。</div>}
        <dl className="kv">
          <dt>分區</dt><dd>{p.zoning ?? '未知'}</dd>
          {p.kind === 'cadastral' && (<><dt>地段代碼</dt><dd>{p.sectionCode}</dd><dt>原始地號</dt><dd>{p.landRaw}</dd></>)}
          <dt>核對狀態</dt><dd><span className={`tag ${p.verification}`}>{VERIFY_LABEL[p.verification]}</span></dd>
          <dt>登記面積</dt><dd>{p.registeredAreaM2 != null ? `${p.registeredAreaM2} m²` : '未知'}</dd>
          <dt>圖形計算</dt><dd>{p.geometry ? `約 ${Math.round(polygonArea(p.geometry)).toLocaleString()} m²（描圖估算，非登記面積）` : '待定位（尚無圖形）'}</dd>
          <dt>圖形來源</dt><dd>{p.sourceCode ?? '—'}{p.geometryVersion ? `｜第 ${p.geometryVersion} 版` : ''}</dd>
          <dt>品質說明</dt><dd className="hint">{p.qualityNote ?? '—'}</dd>
        </dl>
        <h3>關聯建案</h3>
        {p.developmentIds.length === 0 && <div className="hint">無</div>}
        {p.developmentIds.map((id) => {
          const d = scene.developments.find((x) => x.id === id);
          return d ? (
            <button key={id} onClick={() => select({ type: 'development', id })} style={{ marginRight: 6 }}>
              {d.isDemo ? '【DEMO】' : ''}{d.name}
            </button>
          ) : null;
        })}
        {canEdit && (
          <div style={{ marginTop: 10 }}>
            <button onClick={() => useStore.getState().startDraw({ type: 'parcel', id: p.id, expectedVersion: p.version })}>{p.geometry ? '重描圖形（新版本）' : '描繪圖形（定位）'}</button>
          </div>
        )}
        {canEdit && <CreateDevForm code={code} name={name} setCode={setCode} setName={setName} onCreate={create} count={1} />}
      </div>
    );
  }
  return (
    <div>
      <h2>已選 {parcels.length} 筆土地</h2>
      <ul>{parcels.map((p) => <li key={p.id}>{parcelTitle(p)}</li>)}</ul>
      <div className="hint">聯集圖形約 {geomArea != null ? Math.round(geomArea).toLocaleString() : '—'} m²（不重複計算重疊部分；描圖估算）</div>
      {canEdit && <CreateDevForm code={code} name={name} setCode={setCode} setName={setName} onCreate={create} count={parcels.length} />}
    </div>
  );
}

function CreateDevForm(p: { code: string; name: string; setCode: (s: string) => void; setName: (s: string) => void; onCreate: () => void; count: number }) {
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <h3 style={{ marginTop: 0 }}>以選取的 {p.count} 筆土地建立建案</h3>
      <div className="row">
        <label>建案代碼（不會變的內部代碼）<input value={p.code} onChange={(e) => p.setCode(e.target.value)} placeholder="例如 ZL-001" /></label>
        <label>案名<input value={p.name} onChange={(e) => p.setName(e.target.value)} /></label>
      </div>
      <div className="hint" style={{ margin: '6px 0' }}>建商未知可留白，之後再補。</div>
      <button className="primary" disabled={!p.code.trim() || !p.name.trim()} onClick={p.onCreate}>建立建案</button>
    </div>
  );
}

function DevelopmentPanel({ scene, dev, canEdit }: { scene: SceneDTO; dev: DevelopmentDTO; canEdit: boolean }) {
  const select = useStore((s) => s.select);
  const [form, setForm] = useState(dev);
  useEffect(() => setForm(dev), [dev]);
  const buildings = scene.buildings.filter((b) => b.developmentId === dev.id);
  const sites = dev.parcelIds.map((id) => scene.parcels.find((p) => p.id === id)).filter(Boolean) as ParcelDTO[];
  const [newDeveloper, setNewDeveloper] = useState('');
  const [pickDeveloper, setPickDeveloper] = useState('');

  async function saveFields() {
    await guarded(() =>
      api(`/developments/${dev.id}`, {
        method: 'PATCH',
        json: {
          expectedVersion: dev.version,
          patch: {
            name: form.name, code: form.code, status: form.status, completionKind: form.completionKind, completionDate: form.completionDate || null,
            completionPrecision: form.completionDate ? form.completionPrecision : null, dataDate: form.dataDate || null, verification: form.verification,
            description: form.description,
          },
        },
      }),
    );
  }

  async function addBuilding() {
    // 沒有 footprint 時先放一棟示意矩形，標示為假設
    const geoms = sites.filter((s) => s.geometry).map((s) => s.geometry!);
    const center = geoms.length ? ringCentroid(geoms[0]!) : ([0, 0] as [number, number]);
    const offset = buildings.length * 12;
    const label = `${String.fromCharCode(65 + buildings.length)}棟`;
    const b: BuildingInput = {
      label, footprint: [rectangleFootprint([center[0] + offset, center[1]], 20, 15, 0)], footprintIsAssumed: true, baseElevationM: 0,
      segments: [{ baseHeightM: 0, heightM: null, heightSource: null }], floorsAboveGround: null, floorsBelowGround: null,
      attribute: scene.scenario.kind === 'observed' ? 'verified' : scene.scenario.kind === 'planned' ? 'planned' : 'assumption', assumption: null, note: null,
    };
    const r = await guarded(() => api<{ building: BuildingDTO }>(`/developments/${dev.id}/buildings`, { method: 'POST', json: { scenarioId: scene.scenario.id, building: b } }));
    if (r) select({ type: 'building', id: r.building.id });
  }

  async function setDevelopers(list: DevelopmentDTO['developers']) {
    await guarded(() => api(`/developments/${dev.id}/developers`, { method: 'PUT', json: { expectedVersion: dev.version, developers: list } }));
  }

  async function createAndLinkDeveloper() {
    await guarded(async () => {
      const d = await api<{ id: string }>(`/projects/${scene.project.id}/developers`, { method: 'POST', json: { companyName: newDeveloper.trim(), brandName: null, taxId: null } });
      await api(`/developments/${dev.id}/developers`, { method: 'PUT', json: { expectedVersion: dev.version, developers: [...dev.developers, { developerId: d.id, role: dev.developers.length ? 'co' : 'main' }] } });
    });
    setNewDeveloper('');
  }

  async function unlinkParcel(id: string) {
    await guarded(() => api(`/developments/${dev.id}/parcels`, { method: 'PUT', json: { expectedVersion: dev.version, parcelIds: dev.parcelIds.filter((x) => x !== id) } }));
  }

  const ro = !canEdit;
  const overdue = form.completionKind === 'estimated' && form.completionDate && form.status !== 'completed' && Number(form.completionDate.slice(0, 4)) < new Date().getFullYear();

  return (
    <div>
      <h2>{dev.isDemo && <span className="tag demo">DEMO</span>} {dev.name}</h2>
      {dev.isDemo && <div className="warn">示範資料：虛構建案，僅供功能驗收，不可發布或當作真實資料。</div>}
      {overdue && <div className="warn">預計完工日期已過／待更新（沒有完工證據，不自動改為完工）</div>}
      <div className="row">
        <label>建案代碼<input disabled={ro} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></label>
        <label>案名<input disabled={ro} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
      </div>
      <div className="row">
        <label>工程狀態
          <select disabled={ro} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as DevelopmentDTO['status'] })}>
            {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label>核對狀態
          <select disabled={ro} value={form.verification} onChange={(e) => setForm({ ...form, verification: e.target.value as DevelopmentDTO['verification'] })}>
            {Object.entries(VERIFY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
      </div>
      <div className="row">
        <label>完工
          <select disabled={ro} value={form.completionKind ?? ''} onChange={(e) => setForm({ ...form, completionKind: (e.target.value || null) as DevelopmentDTO['completionKind'] })}>
            <option value="">未知</option><option value="estimated">預計</option><option value="actual">實際</option>
          </select>
        </label>
        <label>精度
          <select disabled={ro} value={form.completionPrecision ?? 'year'} onChange={(e) => setForm({ ...form, completionPrecision: e.target.value as 'year' })}>
            <option value="year">年</option><option value="month">月</option><option value="day">日</option>
          </select>
        </label>
        <label>日期<input disabled={ro} value={form.completionDate ?? ''} placeholder="2028 或 2028-06 或 2028-06-30" onChange={(e) => setForm({ ...form, completionDate: e.target.value || null })} /></label>
      </div>
      <div className="row">
        <label>資料日期（來源反映的日期）<input disabled={ro} type="date" value={form.dataDate ?? ''} onChange={(e) => setForm({ ...form, dataDate: e.target.value || null })} /></label>
      </div>
      {canEdit && <button className="primary" style={{ marginTop: 8 }} onClick={saveFields}>儲存建案資料</button>}
      <div className="hint">完工：{formatPartialDate(dev.completionDate, dev.completionPrecision)}（{dev.completionKind === 'actual' ? '實際' : dev.completionKind === 'estimated' ? '預計' : '未知'}）</div>

      <h3>建商（{dev.developers.length}）</h3>
      {dev.developers.length === 0 && <div className="hint">未知（留白）</div>}
      {dev.developers.map((l) => {
        const d = scene.developers.find((x) => x.id === l.developerId);
        return (
          <div key={l.developerId} className="row" style={{ alignItems: 'center' }}>
            <span style={{ flex: 1 }}>{d?.companyName ?? d?.brandName}{d?.brandName && d?.companyName ? `（${d.brandName}）` : ''}</span>
            <select disabled={ro} value={l.role} onChange={(e) => setDevelopers(dev.developers.map((x) => (x.developerId === l.developerId ? { ...x, role: e.target.value as 'main' } : x)))}>
              <option value="main">主要開發</option><option value="co">共同開發</option><option value="pending">待確認</option>
            </select>
            {canEdit && <button className="danger" onClick={() => setDevelopers(dev.developers.filter((x) => x.developerId !== l.developerId))}>移除</button>}
          </div>
        );
      })}
      {canEdit && (
        <div className="row" style={{ marginTop: 6 }}>
          <select value={pickDeveloper} onChange={(e) => setPickDeveloper(e.target.value)}>
            <option value="">選擇既有建商…</option>
            {scene.developers.filter((d) => !dev.developers.some((l) => l.developerId === d.id)).map((d) => <option key={d.id} value={d.id}>{d.companyName ?? d.brandName}</option>)}
          </select>
          <button disabled={!pickDeveloper} onClick={() => { setDevelopers([...dev.developers, { developerId: pickDeveloper, role: dev.developers.length ? 'co' : 'main' }]); setPickDeveloper(''); }}>加入</button>
        </div>
      )}
      {canEdit && (
        <div className="row" style={{ marginTop: 6 }}>
          <label>新增建商（公司名稱）<input value={newDeveloper} onChange={(e) => setNewDeveloper(e.target.value)} /></label>
          <button disabled={!newDeveloper.trim()} onClick={createAndLinkDeveloper}>新增並加入</button>
        </div>
      )}

      <h3>基地（{sites.length} 筆土地）</h3>
      {sites.map((p) => (
        <div key={p.id} className="row" style={{ alignItems: 'center' }}>
          <span style={{ flex: 1 }}>{parcelTitle(p)}</span>
          {canEdit && <button className="danger" onClick={() => unlinkParcel(p.id)}>解除</button>}
        </div>
      ))}
      <div className="hint">在 3D 畫面 Shift＋點選其他地塊，再到地塊面板建立，或在資料表批次匯入。</div>

      <h3>棟別（本情境 {buildings.length} 棟）</h3>
      {buildings.map((b) => (
        <button key={b.id} style={{ marginRight: 6, marginBottom: 6 }} onClick={() => select({ type: 'building', id: b.id })}>
          {b.label}｜{totalHeight(b.segments) ?? '?'}m｜{ATTR_LABEL[b.attribute]}
        </button>
      ))}
      {canEdit && <div><button onClick={addBuilding}>＋新增一棟（示意矩形，待確認）</button></div>}
    </div>
  );
}

function BuildingPanel({ scene, building, canEdit }: { scene: SceneDTO; building: BuildingDTO; canEdit: boolean }) {
  const select = useStore((s) => s.select);
  const dev = scene.developments.find((d) => d.id === building.developmentId);
  const fp = building.footprint[0]!;
  // 由 footprint 反推矩形參數（只對 4 點矩形有意義）
  const rect = useMemo(() => {
    const c = ringCentroid(building.footprint);
    if (fp.length !== 4) return { cx: c[0], cz: c[1], w: 0, d: 0, az: 0, isRect: false };
    const [a, b, , dd] = fp as [[number, number], [number, number], [number, number], [number, number]];
    const w = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const d = Math.hypot(dd[0] - a[0], dd[1] - a[1]);
    const az = vectorToAzimuth([dd[0] - a[0], dd[1] - a[1]]);
    return { cx: c[0], cz: c[1], w, d, az, isRect: true };
  }, [building.footprint, fp]);

  const [label, setLabel] = useState(building.label);
  const [floors, setFloors] = useState<string>(building.floorsAboveGround?.toString() ?? '');
  const [heightMode, setHeightMode] = useState<'floors' | 'manual'>(building.segments[0]?.heightSource === 'estimated' || !building.segments[0]?.heightM ? 'floors' : 'manual');
  const [manualH, setManualH] = useState<string>(building.segments[0]?.heightM?.toString() ?? '');
  const [heightSource, setHeightSource] = useState(building.segments[0]?.heightSource ?? 'user');
  const [assume, setAssume] = useState(building.assumption ?? DEFAULT_FLOOR_ASSUMPTION);
  const [geo, setGeo] = useState({ cx: round1(rect.cx), cz: round1(rect.cz), w: round1(rect.w || 20), d: round1(rect.d || 15), az: round1(rect.az) });
  const [attribute, setAttribute] = useState(building.attribute);
  const [footprintAssumed, setFootprintAssumed] = useState(building.footprintIsAssumed);
  const [site, setSite] = useState<string | null>(null);

  useEffect(() => {
    setLabel(building.label);
    setFloors(building.floorsAboveGround?.toString() ?? '');
    setManualH(building.segments[0]?.heightM?.toString() ?? '');
    setAttribute(building.attribute);
    setFootprintAssumed(building.footprintIsAssumed);
    setGeo({ cx: round1(rect.cx), cz: round1(rect.cz), w: round1(rect.w || 20), d: round1(rect.d || 15), az: round1(rect.az) });
  }, [building, rect]);

  const floorsNum = floors.trim() ? Number(floors) : null;
  const estimated = estimateHeightFromFloors(floorsNum, assume);
  const height = heightMode === 'floors' ? estimated : manualH.trim() ? Number(manualH) : null;
  const footprint = rect.isRect || geo.w > 0 ? [rectangleFootprint([geo.cx, geo.cz], geo.w, geo.d, geo.az)] : building.footprint;

  // 即時預覽基地檢查（伺服器會再檢查一次）
  useEffect(() => {
    const sites = (dev?.parcelIds ?? []).map((id) => scene.parcels.find((p) => p.id === id)?.geometry).filter(Boolean) as [number, number][][][];
    const r = footprintInSites(footprint, sites);
    setSite(r.status === 'outside' ? `超出關聯基地約 ${r.outsideAreaM2} m²，需人工檢核（不會自動修改地界）` : r.status === 'no_site' ? '建案尚未關聯有圖形的土地，無法檢查是否落在基地內' : null);
  }, [JSON.stringify(footprint), dev?.parcelIds]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    const input: BuildingInput = {
      label: label.trim() || building.label,
      footprint,
      footprintIsAssumed: footprintAssumed,
      baseElevationM: building.baseElevationM,
      segments: [{ baseHeightM: 0, heightM: height && height > 0 ? height : null, heightSource: height ? (heightMode === 'floors' ? 'estimated' : heightSource) : null }],
      floorsAboveGround: floorsNum && floorsNum >= 1 ? Math.floor(floorsNum) : null,
      floorsBelowGround: building.floorsBelowGround,
      attribute,
      assumption: heightMode === 'floors' && height ? assume : null,
      note: building.note,
    };
    await guarded(() => api(`/buildings/${building.id}/versions`, { method: 'POST', json: { scenarioId: scene.scenario.id, expectedVersionId: building.versionId, building: input } }));
  }

  async function removeFromScenario() {
    if (!confirm(`從「${scene.scenario.name}」移除 ${building.label}？其他情境與歷史版本不受影響。`)) return;
    await guarded(() => api(`/buildings/${building.id}/scenarios/${scene.scenario.id}`, { method: 'DELETE' }));
    select(null);
  }

  const ro = !canEdit;
  return (
    <div>
      <h2>{building.label} <span className={`tag ${building.attribute}`}>{ATTR_LABEL[building.attribute]}</span></h2>
      <div className="hint">
        建案：<a href="#" onClick={(e) => { e.preventDefault(); dev && select({ type: 'development', id: dev.id }); }}>{dev?.isDemo ? '【DEMO】' : ''}{dev?.name}</a>
        ｜第 {building.versionNumber} 版｜情境「{scene.scenario.name}」
      </div>
      {building.footprintIsAssumed && <div className="warn" style={{ marginTop: 6 }}>位置與輪廓為假設（示意），待確認。</div>}
      <div className="row" style={{ marginTop: 8 }}>
        <label>棟別<input disabled={ro} value={label} onChange={(e) => setLabel(e.target.value)} /></label>
        <label>資料屬性
          <select disabled={ro} value={attribute} onChange={(e) => setAttribute(e.target.value as BuildingDTO['attribute'])}>
            {Object.entries(ATTR_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
      </div>

      <h3>高度</h3>
      <div className="row">
        <label>地上層數<input disabled={ro} type="number" min={1} max={200} value={floors} onChange={(e) => setFloors(e.target.value)} placeholder="未知" /></label>
        <label>計算方式
          <select disabled={ro} value={heightMode} onChange={(e) => setHeightMode(e.target.value as 'floors')}>
            <option value="floors">依層數估算</option>
            <option value="manual">直接輸入總高</option>
          </select>
        </label>
      </div>
      {heightMode === 'floors' ? (
        <>
          <div className="row">
            <label>首層 m<input disabled={ro} type="number" step={0.1} value={assume.firstFloorHeightM} onChange={(e) => setAssume({ ...assume, firstFloorHeightM: Number(e.target.value) })} /></label>
            <label>標準層 m<input disabled={ro} type="number" step={0.1} value={assume.typicalFloorHeightM} onChange={(e) => setAssume({ ...assume, typicalFloorHeightM: Number(e.target.value) })} /></label>
            <label>屋突 m<input disabled={ro} type="number" step={0.1} value={assume.roofExtraHeightM} onChange={(e) => setAssume({ ...assume, roofExtraHeightM: Number(e.target.value) })} /></label>
          </div>
          <div className="hint">估算總高：{estimated == null ? '未知（未填層數）' : `${estimated} m`}。這是本工具的示意假設，不是建案規格或法定數值。</div>
        </>
      ) : (
        <div className="row">
          <label>總高 m<input disabled={ro} type="number" step={0.1} value={manualH} onChange={(e) => setManualH(e.target.value)} placeholder="未知" /></label>
          <label>高度來源
            <select disabled={ro} value={heightSource} onChange={(e) => setHeightSource(e.target.value as 'user')}>
              <option value="verified">已核對</option><option value="documented">有文件</option><option value="user">使用者設定</option>
            </select>
          </label>
        </div>
      )}

      <h3>位置與輪廓（矩形）</h3>
      <div className="row">
        <label>中心 X（東）m<input disabled={ro} type="number" step={1} value={geo.cx} onChange={(e) => setGeo({ ...geo, cx: Number(e.target.value) })} /></label>
        <label>中心 Z（南）m<input disabled={ro} type="number" step={1} value={geo.cz} onChange={(e) => setGeo({ ...geo, cz: Number(e.target.value) })} /></label>
      </div>
      <div className="row">
        <label>面寬 m<input disabled={ro} type="number" step={0.5} min={1} value={geo.w} onChange={(e) => setGeo({ ...geo, w: Number(e.target.value) })} /></label>
        <label>進深 m<input disabled={ro} type="number" step={0.5} min={1} value={geo.d} onChange={(e) => setGeo({ ...geo, d: Number(e.target.value) })} /></label>
        <label>方位角°<input disabled={ro} type="number" step={1} value={geo.az} onChange={(e) => setGeo({ ...geo, az: Number(e.target.value) })} /></label>
      </div>
      {!rect.isRect && <div className="hint">此棟輪廓不是矩形；修改矩形參數會改為矩形輪廓。</div>}
      <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
        <input disabled={ro} type="checkbox" checked={footprintAssumed} onChange={(e) => setFootprintAssumed(e.target.checked)} /> 輪廓為假設（示意）
      </label>
      <div className="hint">輪廓面積約 {Math.round(polygonArea(footprint)).toLocaleString()} m²。方位角由北向順時針。</div>
      {site && <div className="warn" style={{ marginTop: 6 }}>{site}</div>}
      {canEdit && (
        <div className="row" style={{ marginTop: 10 }}>
          <button className="primary" onClick={save}>儲存為新版本</button>
          <button className="danger" onClick={removeFromScenario}>從此情境移除</button>
        </div>
      )}
      <div className="hint" style={{ marginTop: 6 }}>儲存會建立新版本並只更新目前情境；其他情境仍保留原本版本。</div>
    </div>
  );
}

const round1 = (n: number) => Math.round(n * 10) / 10;

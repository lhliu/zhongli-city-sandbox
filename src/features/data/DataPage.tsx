import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useStore } from '../../store';
import { api, errorText } from '../../api';
import { TopBar } from '../explorer/ExplorePage';
import { STATUS_LABEL, VERIFY_LABEL, formatPartialDate } from '../../lib/model/labels';
import { formatLandNumber } from '../../lib/parcel/key';
import { escapeCsvCell, TEMPLATE_HEADERS, type ImportPlan } from '../../lib/import/csv';
import type { SceneDTO } from '../../lib/model/types';

type Row = {
  key: string;
  parcelId: string | null;
  land: string;
  developerNames: string;
  devName: string;
  devCode: string;
  devId: string | null;
  isDemo: boolean;
  buildings: string;
  status: string;
  dataDate: string;
  verification: string;
  located: boolean;
};

function buildRows(scene: SceneDTO): Row[] {
  const rows: Row[] = [];
  const devNames = (devId: string) => {
    const d = scene.developments.find((x) => x.id === devId)!;
    return d.developers.map((l) => {
      const v = scene.developers.find((x) => x.id === l.developerId);
      return `${v?.companyName ?? v?.brandName ?? ''}${l.role === 'co' ? '（共同）' : l.role === 'pending' ? '（待確認）' : ''}`;
    }).join('、') || '未知';
  };
  for (const p of scene.parcels) {
    const land = p.kind === 'reference_block' ? `${p.blockId}（參考區塊）` : `${p.sectionName ?? p.sectionCode} ${formatLandNumber({ main: p.landMain!, sub: p.landSub! })}`;
    const devs = p.developmentIds.length ? p.developmentIds : [null];
    for (const devId of devs) {
      const d = devId ? scene.developments.find((x) => x.id === devId) : null;
      const bs = d ? scene.buildings.filter((b) => b.developmentId === d.id) : [];
      rows.push({
        key: `${p.id}|${devId}`, parcelId: p.id, land, devId: d?.id ?? null, devName: d?.name ?? '', devCode: d?.code ?? '', isDemo: !!d?.isDemo,
        developerNames: d ? devNames(d.id) : '',
        buildings: bs.map((b) => `${b.label} ${b.floorsAboveGround ?? '?'}F`).join('、'),
        status: d ? STATUS_LABEL[d.status] : '', dataDate: d?.dataDate ?? '', verification: VERIFY_LABEL[d?.verification ?? p.verification], located: !!p.geometry,
      });
    }
  }
  // 沒有土地的建案也要列出
  for (const d of scene.developments.filter((x) => x.parcelIds.length === 0)) {
    rows.push({
      key: `none|${d.id}`, parcelId: null, land: '（尚未關聯土地）', devId: d.id, devName: d.name, devCode: d.code, isDemo: d.isDemo, developerNames: devNames(d.id),
      buildings: scene.buildings.filter((b) => b.developmentId === d.id).map((b) => b.label).join('、'), status: STATUS_LABEL[d.status],
      dataDate: d.dataDate ?? '', verification: VERIFY_LABEL[d.verification], located: false,
    });
  }
  return rows;
}

export function DataPage() {
  const { id = '' } = useParams();
  const { scene, load, loadError, reload, select } = useStore();
  const navigate = useNavigate();
  const [filter, setFilter] = useState('');
  useEffect(() => {
    if (useStore.getState().projectId !== id || !useStore.getState().scene) void load(id);
  }, [id, load]);
  const rows = useMemo(() => (scene ? buildRows(scene) : []), [scene]);
  const shown = rows.filter((r) => !filter || `${r.land} ${r.devName} ${r.devCode} ${r.developerNames}`.includes(filter));

  function exportCsv() {
    if (!scene) return;
    const header = ['地段／地號', '建商', '建案', '建案代碼', '棟別', '狀態', '資料日期', '確認狀態', '已定位'];
    const lines = [header, ...shown.map((r) => [r.land, r.developerNames, r.devName, r.devCode, r.buildings, r.status, r.dataDate, r.verification, r.located ? '是' : '待定位'])];
    const csv = '﻿' + lines.map((l) => l.map((c) => escapeCsvCell(String(c))).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `中壢體育園區_資料表_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  }

  if (loadError) return <div className="page"><div className="err">{loadError}</div></div>;
  if (!scene) return <div className="page"><div className="empty">載入中…</div></div>;
  const canEdit = scene.role !== 'viewer';
  return (
    <div className="app" style={{ gridTemplateRows: '56px 1fr' }}>
      <TopBar scene={scene} projectId={id} />
      <main className="page">
        <div className="page-inner">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ margin: 0 }}>地號／建商／建案（{shown.length} 列）</h2>
            <div className="row">
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="篩選" />
              <button onClick={exportCsv}>匯出 CSV</button>
            </div>
          </div>
          <p className="hint">一列＝一筆土地與一個建案的關聯。點列可在 3D 沙盤定位。情境「{scene.scenario.name}」的棟別。</p>
          <div className="tablewrap">
            <table>
              <thead><tr><th>地段／地號</th><th>建商</th><th>建案</th><th>棟別</th><th>狀態</th><th>資料日期</th><th>確認</th></tr></thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.key} style={{ cursor: 'pointer' }} onClick={() => {
                    if (r.parcelId && r.located) select({ type: 'parcel', ids: [r.parcelId] });
                    else if (r.devId) select({ type: 'development', id: r.devId });
                    navigate(`/projects/${id}/explore`);
                  }}>
                    <td>{r.land}{!r.located && r.parcelId && <span className="tag pending" style={{ marginLeft: 4 }}>待定位</span>}</td>
                    <td>{r.developerNames}</td>
                    <td>{r.isDemo && <span className="tag demo">DEMO</span>} {r.devName} <span className="hint">{r.devCode}</span></td>
                    <td>{r.buildings}</td>
                    <td>{r.status}</td>
                    <td>{r.dataDate}</td>
                    <td>{r.verification}</td>
                  </tr>
                ))}
                {shown.length === 0 && <tr><td colSpan={7} className="empty">沒有資料</td></tr>}
              </tbody>
            </table>
          </div>
          {canEdit && <ImportPanel projectId={id} onDone={reload} />}
        </div>
      </main>
    </div>
  );
}

const OUTCOME_LABEL = { create: '新增', update: '更新', unchanged: '不變', error: '錯誤', needs_review: '待確認' } as const;

function ImportPanel({ projectId, onDone }: { projectId: string; onDone: () => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<{ batchId: string; plan: ImportPlan } | null>(null);
  const [report, setReport] = useState<unknown>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<{ id: string; filename: string | null; status: string; created_at: string }[]>([]);

  const loadHistory = () => api<{ batches: typeof history }>(`/projects/${projectId}/imports`).then((r) => setHistory(r.batches)).catch(() => {});
  useEffect(() => void loadHistory(), [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function doPreview() {
    if (!file) return;
    setErr(null); setReport(null); setBusy(true);
    try {
      const text = await file.text();
      const r = await api<{ batchId: string; plan: ImportPlan }>(`/projects/${projectId}/imports/preview`, {
        method: 'POST', body: text, headers: { 'Content-Type': 'text/csv', 'X-Filename': encodeURIComponent(file.name) },
      });
      setPreview(r);
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  }

  async function commit(mode: 'valid_only' | 'all_or_nothing') {
    if (!preview) return;
    setErr(null); setBusy(true);
    try {
      const r = await api<{ report: unknown }>(`/imports/${preview.batchId}/commit`, { method: 'POST', json: { mode, idempotencyKey: `${preview.batchId}-${mode}` } });
      setReport(r.report);
      setPreview(null);
      await onDone();
      await loadHistory();
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  }

  async function rollback(id: string) {
    if (!confirm('撤回此批匯入？會刪除這批新建的關聯與資料（已被其他資料使用的會保留並列出）。')) return;
    try {
      const r = await api<{ kept: string[] }>(`/imports/${id}/rollback`, { method: 'POST', json: {} });
      alert(r.kept.length ? `已撤回；以下保留：\n${r.kept.join('\n')}` : '已撤回');
      await onDone();
      await loadHistory();
    } catch (e) { alert(errorText(e)); }
  }

  const s = preview?.plan.summary;
  const bad = s ? s.error + s.needs_review : 0;
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2>CSV 匯入</h2>
      <p className="hint">
        使用「地號建商建案匯入模板_v01.csv」（UTF-8 BOM，{TEMPLATE_HEADERS.length} 欄）。地段代碼、地號母號／子號、統編請先設為文字格式。
        匯入先預覽，不會直接改資料；套用後可整批撤回。<a href="/templates/地號建商建案匯入模板_v01.csv" download>下載模板</a>
      </p>
      <div className="row">
        <input type="file" accept=".csv,text/csv" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); setReport(null); }} />
        <button className="primary" disabled={!file || busy} onClick={doPreview}>預覽</button>
      </div>
      {err && <div className="err" style={{ marginTop: 8 }}>{err}</div>}
      {preview && (
        <>
          {preview.plan.headerErrors.map((h) => <div className="err" key={h} style={{ marginTop: 8 }}>{h}</div>)}
          {s && (
            <p>新增 {s.create}｜更新 {s.update}｜不變 {s.unchanged}｜<span style={{ color: 'var(--danger)' }}>錯誤 {s.error}</span>｜待確認 {s.needs_review}</p>
          )}
          <div className="tablewrap">
            <table>
              <thead><tr><th>列</th><th>結果</th><th>地號</th><th>建案</th><th>建商</th><th>說明與修正方式</th></tr></thead>
              <tbody>
                {preview.plan.rows.map((r) => (
                  <tr key={r.rowNumber} className={`oc-${r.outcome}`}>
                    <td>{r.rowNumber}</td>
                    <td>{OUTCOME_LABEL[r.outcome]}</td>
                    <td>{r.display.land}</td>
                    <td>{r.display.devCode} {r.display.devName}</td>
                    <td>{r.display.developer}</td>
                    <td>{r.messages.map((m, i) => <div key={i}>{m.column ? `【${m.column}】` : ''}{m.reason}{m.fix ? ` → ${m.fix}` : ''}</div>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary" disabled={busy || bad > 0 || !s || s.create + s.update === 0} onClick={() => commit('all_or_nothing')}>全部套用</button>
            <button disabled={busy || !s || s.create + s.update === 0} onClick={() => commit('valid_only')}>只套用有效列（略過 {bad} 列）</button>
            <button onClick={() => setPreview(null)}>取消</button>
          </div>
          {bad > 0 && <div className="warn" style={{ marginTop: 6 }}>有 {bad} 列錯誤或待確認，這些列不會匯入。請修正 CSV 後重新預覽，或選「只套用有效列」。</div>}
        </>
      )}
      {report != null && <div className="ok" style={{ marginTop: 8 }}>已套用：{JSON.stringify((report as { applied: number }).applied)} 列；略過 {(report as { skipped: number }).skipped} 列。</div>}
      <h3>匯入紀錄</h3>
      <table>
        <thead><tr><th>時間</th><th>檔名</th><th>狀態</th><th /></tr></thead>
        <tbody>
          {history.map((h) => (
            <tr key={h.id}>
              <td>{h.created_at.replace('T', ' ').slice(0, 16)}</td>
              <td>{h.filename}</td>
              <td>{{ previewed: '只預覽', committed: '已套用', rolled_back: '已撤回', cancelled: '已取消' }[h.status] ?? h.status}</td>
              <td>{h.status === 'committed' && <button className="danger" onClick={() => rollback(h.id)}>撤回此批</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export { formatPartialDate };

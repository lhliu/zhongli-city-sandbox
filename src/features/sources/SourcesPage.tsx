import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useStore } from '../../store';
import { TopBar } from '../explorer/ExplorePage';
import { LICENSE_LABEL } from '../../lib/model/labels';

export function SourcesPage() {
  const { id = '' } = useParams();
  const { scene, load, loadError } = useStore();
  useEffect(() => {
    if (useStore.getState().projectId !== id || !useStore.getState().scene) void load(id);
  }, [id, load]);
  if (loadError) return <div className="page"><div className="err">{loadError}</div></div>;
  if (!scene) return <div className="page"><div className="empty">載入中…</div></div>;
  return (
    <div className="app" style={{ gridTemplateRows: '56px 1fr' }}>
      <TopBar scene={scene} projectId={id} />
      <main className="page">
        <div className="page-inner">
          <h2>資料來源與授權</h2>
          <p className="hint">政府網站可閱讀不代表可公開再利用。標示「授權未知／僅內部使用」的來源，在完成授權核對前不可用於公開版。</p>
          {scene.sources.map((s) => (
            <div className="card" key={s.id}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong>{s.code}　{s.title}</strong>
                <span className={`tag ${s.licenseStatus === 'redistributable' ? 'verified' : 'pending'}`}>{LICENSE_LABEL[s.licenseStatus]}</span>
              </div>
              <dl className="kv" style={{ marginTop: 6 }}>
                <dt>提供單位</dt><dd>{s.publisher ?? '—'}</dd>
                <dt>網址</dt><dd>{s.url ? <a href={s.url} target="_blank" rel="noreferrer noopener">{s.url}</a> : '—'}</dd>
                <dt>擷取時間</dt><dd>{s.retrievedAt ?? '尚未取得'}</dd>
                <dt>版本／頁碼</dt><dd>{s.pageRef ?? '—'}</dd>
                <dt>是否最新</dt><dd>{s.isLatestNote ?? '—'}</dd>
                <dt>SHA-256</dt><dd className="mono">{s.sha256 ?? '—'}</dd>
                <dt>備註</dt><dd>{s.licenseNote ?? '—'}</dd>
              </dl>
            </div>
          ))}
          <h2 style={{ marginTop: 20 }}>底圖校準</h2>
          {scene.layers.map((l) => (
            <div className="card" key={l.id}>
              <strong>{l.title}</strong> <span className="tag reference">{l.status === 'calibrated' ? '已校準' : '參考底圖'}</span>
              <dl className="kv" style={{ marginTop: 6 }}>
                <dt>方法</dt><dd>{l.calibration?.method === 'scale_bar' ? '比例尺量測（圖面座標模式）' : l.calibration?.method === 'affine' ? '控制點仿射' : '未校準'}</dd>
                <dt>檢核 RMSE</dt><dd>{l.calibration?.checkRmseM != null ? `${l.calibration.checkRmseM} m` : '無檢核點（不聲稱地理精準）'}</dd>
                <dt>說明</dt><dd>{l.calibration?.note ?? '—'}</dd>
              </dl>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}

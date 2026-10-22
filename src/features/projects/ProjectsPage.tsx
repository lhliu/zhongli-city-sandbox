import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorText } from '../../api';

type P = { id: string; name: string; role: string };

export function ProjectsPage() {
  const [projects, setProjects] = useState<P[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [me, setMe] = useState<string>('');
  useEffect(() => {
    api<{ projects: P[] }>('/projects').then((r) => setProjects(r.projects)).catch((e) => setError(errorText(e)));
    api<{ email: string }>('/me').then((r) => setMe(r.email)).catch(() => {});
  }, []);
  return (
    <div className="app" style={{ gridTemplateRows: '56px 1fr' }}>
      <header className="topbar">
        <span className="title">KC 城市沙盤</span>
        <span className="spacer" />
        <span className="savestate">{me}</span>
      </header>
      <main className="page">
        <div className="page-inner">
          <h2>園區</h2>
          {error && <div className="err">{error}</div>}
          {projects?.length === 0 && <div className="empty">你還不是任何專案的成員。請專案擁有者把你的 email 加入成員。</div>}
          {projects?.map((p) => (
            <div className="card" key={p.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <strong>{p.name}</strong>
                <span className="hint">角色：{p.role === 'owner' ? '擁有者' : p.role === 'editor' ? '編輯者' : '檢視者'}</span>
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <Link to={`/projects/${p.id}/explore`}><button className="primary">開啟 3D 沙盤</button></Link>
                <Link to={`/projects/${p.id}/data`}><button>資料表與匯入</button></Link>
                <Link to={`/projects/${p.id}/sources`}><button>資料來源</button></Link>
              </div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}

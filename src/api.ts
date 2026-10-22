import type { ApiError, SceneDTO } from './lib/model/types';

export class ApiCallError extends Error {
  constructor(public status: number, public body: ApiError) {
    super(body.message);
  }
}

/** 本機開發可在網址加 ?as=viewer@x 模擬其他使用者（僅 DEV_AUTH=1 的伺服器接受） */
const devUser = new URLSearchParams(location.search).get('as');

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (devUser) headers['X-Dev-User'] = devUser;
  let body = init.body;
  if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`/api${path}`, { ...init, headers, body });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiCallError(res.status, { error_code: 'bad_response', message: `伺服器回應格式錯誤（HTTP ${res.status}）`, request_id: '' });
  }
  if (!res.ok) throw new ApiCallError(res.status, data as ApiError);
  return data as T;
}

export const fetchScene = (projectId: string, scenarioId?: string | null) =>
  api<SceneDTO>(`/projects/${projectId}/scene${scenarioId ? `?scenario_id=${scenarioId}` : ''}`);

export function errorText(e: unknown): string {
  if (e instanceof ApiCallError) return `${e.body.message}${e.body.request_id ? `（代碼 ${e.body.error_code}）` : ''}`;
  return e instanceof Error ? e.message : String(e);
}

/**
 * 使用者辨識。正式環境：Cloudflare Access 簽發的 JWT（Cf-Access-Jwt-Assertion），
 * 以團隊公鑰驗證簽章、aud 與到期時間。未設定 Access 時一律拒絕（fail closed）。
 * 本機：DEV_AUTH=1 時接受 X-Dev-User。
 */
import type { Context } from 'hono';
import type { AppEnv } from './env';
import { ApiFailure } from './errors';

type Jwk = JsonWebKey & { kid: string };
let jwksCache: { domain: string; keys: Jwk[]; at: number } | null = null;

export async function resolveUser(c: Context<AppEnv>): Promise<string> {
  const env = c.env;
  if (env.DEV_AUTH === '1') {
    return (c.req.header('X-Dev-User') ?? 'dev@local').toLowerCase();
  }
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    throw new ApiFailure(401, 'auth_not_configured', '伺服器尚未設定 Cloudflare Access，API 已停用');
  }
  const token = c.req.header('Cf-Access-Jwt-Assertion');
  if (!token) throw new ApiFailure(401, 'unauthenticated', '請先登入');
  const payload = await verifyAccessJwt(token, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD);
  if (typeof payload.email !== 'string') throw new ApiFailure(401, 'unauthenticated', '登入資訊缺少 email');
  return payload.email.toLowerCase();
}

async function verifyAccessJwt(token: string, teamDomain: string, aud: string): Promise<Record<string, unknown>> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new ApiFailure(401, 'invalid_token', '登入憑證格式錯誤');
  const [h, p, s] = parts as [string, string, string];
  const header = JSON.parse(b64urlText(h)) as { kid?: string; alg?: string };
  if (header.alg !== 'RS256') throw new ApiFailure(401, 'invalid_token', '登入憑證演算法不符');
  const keys = await getKeys(teamDomain);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new ApiFailure(401, 'invalid_token', '登入憑證金鑰不符');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new ApiFailure(401, 'invalid_token', '登入憑證簽章無效');
  const payload = JSON.parse(b64urlText(p)) as Record<string, unknown>;
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) throw new ApiFailure(401, 'invalid_token', '登入憑證 aud 不符');
  if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) throw new ApiFailure(401, 'token_expired', '登入已過期，請重新登入');
  if (payload.iss !== `https://${teamDomain}`) throw new ApiFailure(401, 'invalid_token', '登入憑證簽發者不符');
  return payload;
}

async function getKeys(teamDomain: string): Promise<Jwk[]> {
  if (jwksCache && jwksCache.domain === teamDomain && Date.now() - jwksCache.at < 10 * 60_000) return jwksCache.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new ApiFailure(401, 'auth_unavailable', '無法取得登入驗證金鑰');
  const body = (await res.json()) as { keys: Jwk[] };
  jwksCache = { domain: teamDomain, keys: body.keys, at: Date.now() };
  return body.keys;
}

function b64urlBytes(s: string): Uint8Array<ArrayBuffer> {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
  return Uint8Array.from(b, (ch) => ch.charCodeAt(0));
}
function b64urlText(s: string): string {
  return new TextDecoder().decode(b64urlBytes(s));
}

/**
 * 地號正規化（規格 §7.1、§7.2）。地號一律以字串保存。
 * canonical：母號 4 碼＋子號 4 碼，例如「123-4」→ main "0123"、sub "0004"。
 * 無子號視為 "0000"（此規則為本 adapter 定義，見 README）。
 */
export type LandNumber = { main: string; sub: string; raw: string };

export type ParseResult = { ok: true; value: LandNumber } | { ok: false; error: string };

export function parseLandNumber(raw: string): ParseResult {
  const text = raw.trim().replace(/[－—–]/g, '-').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  if (!text) return { ok: false, error: '地號空白' };
  const m = /^(\d{1,4})(?:-(\d{1,4}))?$/.exec(text) ?? /^(\d{4})(\d{4})$/.exec(text);
  if (!m) return { ok: false, error: `無法辨識的地號格式「${raw}」；請填母號-子號，例如 123-4` };
  const main = m[1]!.padStart(4, '0');
  const sub = (m[2] ?? '0').padStart(4, '0');
  if (main === '0000') return { ok: false, error: '母號不能為 0' };
  return { ok: true, value: { main, sub, raw } };
}

/** 由 CSV 的母號／子號欄位組合 */
export function parseLandNumberParts(main: string, sub: string): ParseResult {
  const m = main.trim();
  const s = sub.trim();
  if (!m) return { ok: false, error: '地號母號空白' };
  return parseLandNumber(s ? `${m}-${s}` : m);
}

export function formatLandNumber(n: { main: string; sub: string }): string {
  const main = String(Number(n.main));
  const sub = Number(n.sub);
  return sub ? `${main}-${sub}` : main;
}

export type CadastralKey = {
  county: string;
  district: string;
  sectionCode: string;
  main: string;
  sub: string;
};

/** 完整地籍鍵；缺地段代碼時不可組成（避免同名地段混淆） */
export function cadastralKeyString(k: CadastralKey): string {
  if (!k.sectionCode.trim()) throw new Error('缺地段代碼，不能組成地籍鍵');
  return [k.county.trim(), k.district.trim(), k.sectionCode.trim(), k.main, k.sub].join('|');
}

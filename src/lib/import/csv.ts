/**
 * 地號建商建案 CSV 匯入（規格 §7.2）。純函式：解析 → 驗證 → 比對既有資料 → 產生預覽計畫。
 * 一列＝「建案與一筆地號的關聯」，不是一棟建築。
 */
import { parseLandNumberParts, parseLandNumber } from '../parcel/key';

export const TEMPLATE_HEADERS = [
  '縣市', '行政區', '地段代碼', '地段名稱', '小段', '地號母號', '地號子號', '原始地號文字',
  '建案代碼', '建案名稱', '開發商公司名稱', '建商品牌名稱', '開發商統一編號', '開發角色',
  '關聯有效起日', '關聯有效迄日', '建案狀態', '預計完工年份', '實際完工日期', '資料日期',
  '來源URL', '來源頁碼', '核對狀態', '備註',
] as const;
export type Header = (typeof TEMPLATE_HEADERS)[number];
export type RawRow = Record<string, string>;

export const STATUS_MAP: Record<string, string> = {
  未知: 'unknown', 空地: 'vacant', 整地: 'site_prep', 施工: 'construction', 完工: 'completed', 拆除: 'demolished', 規劃: 'planned',
};
export const VERIFY_MAP: Record<string, string> = { 待核對: 'pending', 已核對: 'verified', 推估: 'estimated' };
const ROLE_MAP: Record<string, 'main' | 'pending'> = { 主要開發: 'main', 待確認: 'pending' };

export type RowMessage = { column: Header | null; reason: string; fix: string };

export type ParsedRow = {
  rowNumber: number;
  rowHash: string;
  county: string;
  district: string;
  sectionCode: string;
  sectionName: string;
  subsection: string;
  landMain: string;
  landSub: string;
  landRaw: string;
  devCode: string;
  devName: string;
  companyName: string;
  brandName: string;
  taxId: string;
  role: 'main' | 'pending' | null;
  linkFrom: string;
  linkTo: string;
  status: string | null;
  estimatedYear: string;
  actualDate: string;
  dataDate: string;
  sourceUrl: string;
  sourcePage: string;
  verification: string;
  note: string;
};

export type ExistingParcel = { id: string; county: string; district: string; sectionCode: string; landMain: string; landSub: string };
export type ExistingDevelopment = {
  id: string;
  code: string;
  name: string;
  status: string;
  completionKind: string | null;
  completionDate: string | null;
  completionPrecision: string | null;
  dataDate: string | null;
  verification: string;
  version: number;
};
export type ExistingDeveloper = { id: string; companyName: string | null; brandName: string | null; taxId: string | null };
export type Existing = {
  parcels: ExistingParcel[];
  developments: ExistingDevelopment[];
  developers: ExistingDeveloper[];
  links: { developmentId: string; parcelId: string }[];
  devDevelopers: { developmentId: string; developerId: string }[];
};

/** 計畫中的動作；ref 以「new:xxx」指向同批新建物件 */
export type Action =
  | { type: 'create_parcel'; ref: string; county: string; district: string; sectionCode: string; sectionName: string; landMain: string; landSub: string; landRaw: string; verification: string; note: string }
  | { type: 'create_development'; ref: string; code: string; fields: DevFields }
  | { type: 'update_development'; developmentId: string; expectedVersion: number; changes: Partial<DevFields>; before: Partial<DevFields> }
  | { type: 'create_developer'; ref: string; companyName: string | null; brandName: string | null; taxId: string | null }
  | { type: 'link_developer'; developmentRef: string; developerRef: string; role: 'main' | 'pending' }
  | { type: 'link_parcel'; developmentRef: string; parcelRef: string; validFrom: string | null; validTo: string | null; evidenceNote: string };

export type DevFields = {
  name: string;
  status: string;
  completionKind: string | null;
  completionDate: string | null;
  completionPrecision: string | null;
  dataDate: string | null;
  verification: string;
};

export type RowPlan = {
  rowNumber: number;
  rowHash: string;
  outcome: 'create' | 'update' | 'unchanged' | 'error' | 'needs_review';
  messages: RowMessage[];
  /** 此列帶來的動作（共享的建案／建商建立動作只掛在第一個需要它的列） */
  actions: Action[];
  display: { land: string; devCode: string; devName: string; developer: string };
};

export type ImportPlan = {
  headerErrors: string[];
  rows: RowPlan[];
  summary: Record<RowPlan['outcome'], number>;
};

// ───────────────────────── 解析與驗證 ─────────────────────────

export function checkHeaders(headers: string[]): string[] {
  const clean = headers.map((h) => h.replace(/^﻿/, '').trim());
  const missing = TEMPLATE_HEADERS.filter((h) => !clean.includes(h));
  const unknown = clean.filter((h) => h && !(TEMPLATE_HEADERS as readonly string[]).includes(h));
  const errs: string[] = [];
  if (missing.length) errs.push(`缺少欄位：${missing.join('、')}。請使用「地號建商建案匯入模板_v01.csv」的標題列`);
  if (unknown.length) errs.push(`無法辨識的欄位：${unknown.join('、')}（不會匯入）`);
  return errs;
}

const ymd = /^\d{4}-\d{2}-\d{2}$/;

function validDate(s: string): boolean {
  if (!ymd.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export async function hashRow(values: string[]): Promise<string> {
  const data = new TextEncoder().encode(values.join('\u001f'));
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function parseRow(raw: RawRow, rowNumber: number): Promise<{ row: ParsedRow; messages: RowMessage[] }> {
  const g = (h: Header) => (raw[h] ?? '').trim();
  const messages: RowMessage[] = [];
  const err = (column: Header | null, reason: string, fix: string) => messages.push({ column, reason, fix });

  let landMain = '';
  let landSub = '';
  const mainIn = g('地號母號');
  const rawText = g('原始地號文字');
  if (mainIn) {
    const r = parseLandNumberParts(mainIn, g('地號子號'));
    if (r.ok) [landMain, landSub] = [r.value.main, r.value.sub];
    else err('地號母號', r.error, '母號、子號填純數字；儲存格先設為文字，避免被轉成日期');
  } else if (rawText) {
    const r = parseLandNumber(rawText);
    if (r.ok) [landMain, landSub] = [r.value.main, r.value.sub];
    else err('原始地號文字', r.error, '填「母號-子號」，或直接填地號母號／子號欄');
  } else {
    err('地號母號', '地號空白', '填寫地號母號（子號可空白）');
  }

  const roleIn = g('開發角色');
  let role: 'main' | 'pending' | null = null;
  if (roleIn === '共同開發') err('開發角色', '首版 CSV 只接受主要開發或待確認', '共同開發商請在網站的建案→建商子表新增');
  else if (roleIn && !(roleIn in ROLE_MAP)) err('開發角色', `無法辨識「${roleIn}」`, '填「主要開發」或「待確認」，或留白');
  else if (roleIn) role = ROLE_MAP[roleIn]!;

  const statusIn = g('建案狀態');
  let status: string | null = null;
  if (statusIn) {
    if (statusIn in STATUS_MAP) status = STATUS_MAP[statusIn]!;
    else err('建案狀態', `無法辨識「${statusIn}」`, '填：未知、空地、整地、施工、完工、拆除、規劃');
  }

  const verifyIn = g('核對狀態') || '待核對';
  const verification = VERIFY_MAP[verifyIn];
  if (!verification) err('核對狀態', `無法辨識「${verifyIn}」`, '填：待核對、已核對、推估；空白預設待核對');

  const year = g('預計完工年份');
  if (year && !/^\d{4}$/.test(year)) err('預計完工年份', `「${year}」不是西元四位數年份`, '例如 2028；民國年請換算成西元');
  for (const h of ['實際完工日期', '資料日期', '關聯有效起日', '關聯有效迄日'] as const) {
    const v = g(h);
    if (v && !validDate(v)) err(h, `「${v}」不是有效日期`, '日期填 YYYY-MM-DD，例如 2026-10-22');
  }
  const taxId = g('開發商統一編號');
  if (taxId && !/^\d{8}$/.test(taxId)) err('開發商統一編號', `「${taxId}」不是 8 碼數字`, '儲存格先設為文字，避免遺失前導零');
  if (!g('建案代碼')) err('建案代碼', '建案代碼空白', '每個建案給一個不會變的代碼，例如 ZL-001');
  const url = g('來源URL');
  if (url && !/^https?:\/\//i.test(url)) err('來源URL', '來源 URL 須以 http(s):// 開頭', '貼完整網址；系統不會自動下載');

  const values = TEMPLATE_HEADERS.map((h) => g(h));
  const row: ParsedRow = {
    rowNumber,
    rowHash: await hashRow(values),
    county: g('縣市'),
    district: g('行政區'),
    sectionCode: g('地段代碼'),
    sectionName: g('地段名稱'),
    subsection: g('小段'),
    landMain,
    landSub,
    landRaw: rawText || (mainIn ? `${mainIn}${g('地號子號') ? `-${g('地號子號')}` : ''}` : ''),
    devCode: g('建案代碼'),
    devName: g('建案名稱'),
    companyName: g('開發商公司名稱'),
    brandName: g('建商品牌名稱'),
    taxId,
    role,
    linkFrom: g('關聯有效起日'),
    linkTo: g('關聯有效迄日'),
    status,
    estimatedYear: year,
    actualDate: g('實際完工日期'),
    dataDate: g('資料日期'),
    sourceUrl: url,
    sourcePage: g('來源頁碼'),
    verification: verification ?? 'pending',
    note: g('備註'),
  };
  return { row, messages };
}

// ───────────────────────── 計畫 ─────────────────────────

function devFieldsFromRow(r: ParsedRow): Partial<DevFields> {
  const f: Partial<DevFields> = {};
  if (r.devName) f.name = r.devName;
  if (r.status) f.status = r.status;
  if (r.actualDate) {
    f.completionKind = 'actual';
    f.completionDate = r.actualDate;
    f.completionPrecision = 'day';
  } else if (r.estimatedYear) {
    // 只有年份：精度 year，不補造 1 月 1 日
    f.completionKind = 'estimated';
    f.completionDate = r.estimatedYear;
    f.completionPrecision = 'year';
  }
  if (r.dataDate) f.dataDate = r.dataDate;
  f.verification = r.verification;
  return f;
}

export function buildPlan(rows: { row: ParsedRow; messages: RowMessage[] }[], existing: Existing): ImportPlan {
  const plans: RowPlan[] = [];
  const parcelKey = (c: string, d: string, s: string, m: string, sub: string) => [c, d, s, m, sub].join('|');
  const parcelIndex = new Map<string, ExistingParcel[]>();
  for (const p of existing.parcels) {
    const k = parcelKey(p.county, p.district, p.sectionCode, p.landMain, p.landSub);
    parcelIndex.set(k, [...(parcelIndex.get(k) ?? []), p]);
  }
  const devByCode = new Map(existing.developments.map((d) => [d.code, d]));
  const linkSet = new Set(existing.links.map((l) => `${l.developmentId}|${l.parcelId}`));
  const devDevSet = new Set(existing.devDevelopers.map((l) => `${l.developmentId}|${l.developerId}`));

  // 同建案代碼的列：案名與建商須一致
  const groups = new Map<string, ParsedRow[]>();
  for (const { row } of rows) if (row.devCode) groups.set(row.devCode, [...(groups.get(row.devCode) ?? []), row]);
  const conflictCodes = new Map<string, string>();
  for (const [code, rs] of groups) {
    const names = new Set(rs.map((r) => r.devName).filter(Boolean));
    const devs = new Set(rs.map((r) => `${r.companyName}|${r.brandName}|${r.taxId}`).filter((s) => s !== '||'));
    if (names.size > 1) conflictCodes.set(code, `同一建案代碼 ${code} 的建案名稱不一致：${[...names].join('／')}`);
    else if (devs.size > 1) conflictCodes.set(code, `同一建案代碼 ${code} 的開發商資料不一致`);
  }

  const createdParcels = new Map<string, string>();
  const createdDevs = new Map<string, string>(); // code → ref
  const devChangesDone = new Set<string>();
  const createdDevelopers = new Map<string, string>(); // key → ref
  const linkedInBatch = new Set<string>();
  const devDevInBatch = new Set<string>();
  const seenHashes = new Set<string>();
  let seq = 0;

  for (const { row: r, messages } of rows) {
    const msgs = [...messages];
    const actions: Action[] = [];
    const display = {
      land: r.landMain ? `${r.sectionName || r.sectionCode} ${Number(r.landMain)}${Number(r.landSub) ? `-${Number(r.landSub)}` : ''}` : r.landRaw,
      devCode: r.devCode,
      devName: r.devName,
      developer: r.companyName || r.brandName,
    };
    const push = (outcome: RowPlan['outcome']) => plans.push({ rowNumber: r.rowNumber, rowHash: r.rowHash, outcome, messages: msgs, actions, display });

    if (seenHashes.has(r.rowHash)) {
      msgs.push({ column: null, reason: '與前面某列完全相同', fix: '刪除重複列（不影響結果）' });
      push('unchanged');
      continue;
    }
    seenHashes.add(r.rowHash);

    if (conflictCodes.has(r.devCode)) msgs.push({ column: '建案名稱', reason: conflictCodes.get(r.devCode)!, fix: '統一同一建案代碼各列的案名與開發商' });
    if (msgs.length) {
      push('error');
      continue;
    }

    // 地籍比對：缺縣市／行政區／地段代碼不猜測
    if (!r.county || !r.district || !r.sectionCode) {
      msgs.push({ column: '地段代碼', reason: '缺縣市、行政區或地段代碼，無法唯一比對土地', fix: '補齊地段代碼（官方代碼，避免同名地段混淆）' });
      push('needs_review');
      continue;
    }
    const pk = parcelKey(r.county, r.district, r.sectionCode, r.landMain, r.landSub);
    const matches = parcelIndex.get(pk) ?? [];
    if (matches.length > 1) {
      msgs.push({ column: '地號母號', reason: `此地籍鍵對應 ${matches.length} 筆有效土地`, fix: '到土地資料表確認是否重複後再匯入' });
      push('needs_review');
      continue;
    }
    let parcelRef: string;
    let isNewRow = false;
    if (matches[0]) parcelRef = matches[0].id;
    else if (createdParcels.has(pk)) parcelRef = createdParcels.get(pk)!;
    else {
      parcelRef = `new:parcel:${++seq}`;
      createdParcels.set(pk, parcelRef);
      actions.push({
        type: 'create_parcel', ref: parcelRef, county: r.county, district: r.district, sectionCode: r.sectionCode, sectionName: r.sectionName,
        landMain: r.landMain, landSub: r.landSub, landRaw: r.landRaw, verification: r.verification, note: r.note,
      });
      msgs.push({ column: null, reason: '新土地沒有圖形，將標記「待定位」', fix: '到圖資導入頁描圖或匯入 GeoJSON' });
      isNewRow = true;
    }

    // 建案
    const existingDev = devByCode.get(r.devCode);
    let devRef: string;
    if (existingDev) {
      devRef = existingDev.id;
      if (!devChangesDone.has(r.devCode)) {
        devChangesDone.add(r.devCode);
        const want = devFieldsFromRow(r);
        const changes: Partial<DevFields> = {};
        const before: Partial<DevFields> = {};
        for (const [k, v] of Object.entries(want) as [keyof DevFields, string | null][]) {
          // 空白不覆蓋；核對狀態只有明確填寫才更新
          if (k === 'verification' && !r.verification) continue;
          const cur = (existingDev as unknown as Record<string, string | null>)[k] ?? null;
          if (v != null && v !== cur) {
            (changes as Record<string, unknown>)[k] = v;
            (before as Record<string, unknown>)[k] = cur;
          }
        }
        if (Object.keys(changes).length) {
          actions.push({ type: 'update_development', developmentId: existingDev.id, expectedVersion: existingDev.version, changes, before });
          isNewRow = true;
        }
      }
    } else if (createdDevs.has(r.devCode)) {
      devRef = createdDevs.get(r.devCode)!;
    } else {
      if (!r.devName) {
        msgs.push({ column: '建案名稱', reason: `建案代碼 ${r.devCode} 是新建案，但案名空白`, fix: '新建案須填建案名稱' });
        push('error');
        continue;
      }
      devRef = `new:dev:${++seq}`;
      createdDevs.set(r.devCode, devRef);
      const f = devFieldsFromRow(r);
      actions.push({
        type: 'create_development', ref: devRef, code: r.devCode,
        fields: {
          name: r.devName, status: f.status ?? 'unknown', completionKind: f.completionKind ?? null, completionDate: f.completionDate ?? null,
          completionPrecision: f.completionPrecision ?? null, dataDate: f.dataDate ?? null, verification: r.verification,
        },
      });
      isNewRow = true;
    }

    // 建商（未知建商留白，不建立）
    if (r.companyName || r.brandName || r.taxId) {
      const found = existing.developers.find((d) =>
        r.taxId ? d.taxId === r.taxId : (r.companyName ? d.companyName === r.companyName : d.brandName === r.brandName),
      );
      const key = r.taxId || r.companyName || r.brandName;
      let developerRef = found?.id ?? createdDevelopers.get(key);
      if (!developerRef) {
        developerRef = `new:developer:${++seq}`;
        createdDevelopers.set(key, developerRef);
        actions.push({ type: 'create_developer', ref: developerRef, companyName: r.companyName || null, brandName: r.brandName || null, taxId: r.taxId || null });
        isNewRow = true;
      }
      const dk = `${devRef}|${developerRef}`;
      if (!devDevSet.has(dk) && !devDevInBatch.has(dk)) {
        devDevInBatch.add(dk);
        actions.push({ type: 'link_developer', developmentRef: devRef, developerRef, role: r.role ?? 'pending' });
        isNewRow = true;
      }
    }

    const lk = `${devRef}|${parcelRef}`;
    if (!linkSet.has(lk) && !linkedInBatch.has(lk)) {
      linkedInBatch.add(lk);
      const evidence = [r.sourceUrl, r.sourcePage, r.note].filter(Boolean).join('｜');
      actions.push({ type: 'link_parcel', developmentRef: devRef, parcelRef, validFrom: r.linkFrom || null, validTo: r.linkTo || null, evidenceNote: evidence });
      isNewRow = true;
    }

    const hasCreate = actions.some((a) => a.type.startsWith('create') || a.type.startsWith('link'));
    push(!isNewRow ? 'unchanged' : hasCreate ? 'create' : 'update');
  }

  const summary = { create: 0, update: 0, unchanged: 0, error: 0, needs_review: 0 };
  for (const p of plans) summary[p.outcome]++;
  return { headerErrors: [], rows: plans, summary };
}

/** CSV 匯出時防公式注入：=、+、-、@ 起始的文字前置單引號 */
export function escapeCsvCell(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

import type { BuildingAttribute, DevelopmentStatus, Verification } from './types';

export const STATUS_LABEL: Record<DevelopmentStatus, string> = {
  unknown: '未知', vacant: '空地', site_prep: '整地', construction: '施工', completed: '完工', demolished: '拆除', planned: '規劃',
};
export const VERIFY_LABEL: Record<Verification, string> = { pending: '待核對', verified: '已核對', estimated: '推估' };
export const ATTR_LABEL: Record<BuildingAttribute, string> = { verified: '已核對', planned: '規劃', estimated: '推估', assumption: '假設' };
export const ATTR_COLOR: Record<BuildingAttribute, string> = { verified: '#2f6b4f', planned: '#2f6fd1', estimated: '#e07b1f', assumption: '#8a4fc8' };
export const SCENARIO_KIND_LABEL = { observed: '已確認現況', planned: '公開規劃', assumption: 'KC 假設' } as const;
export const LICENSE_LABEL = { unknown: '授權未知', internal_only: '僅內部使用', redistributable: '可公開', restricted: '限制使用' } as const;

export function formatPartialDate(date: string | null, precision: 'day' | 'month' | 'year' | null): string {
  if (!date) return '未知';
  if (precision === 'year') return `${date} 年`;
  if (precision === 'month') return date.replace('-', ' 年 ') + ' 月';
  return date;
}

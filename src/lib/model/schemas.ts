/**
 * 前後端共用的輸入驗證（zod）。拒絕不明欄位、非有限數、越界值與過量點數。
 */
import { z } from 'zod';

const finite = z.number().finite();
export const PointXZ = z.tuple([finite, finite]);
export const Ring = z.array(PointXZ).min(3).max(2000);
export const PolygonRingsSchema = z.array(Ring).min(1).max(50);

export const HeightSourceSchema = z.enum(['verified', 'documented', 'user', 'estimated']);

export const SegmentSchema = z
  .object({
    baseHeightM: finite.min(0).max(1000),
    heightM: finite.gt(0).max(1000).nullable(),
    heightSource: HeightSourceSchema.nullable(),
  })
  .strict();

export const BuildingAttributeSchema = z.enum(['verified', 'planned', 'estimated', 'assumption']);

export const FloorAssumptionSchema = z
  .object({
    firstFloorHeightM: finite.gt(0).max(20),
    typicalFloorHeightM: finite.gt(0).max(10),
    roofExtraHeightM: finite.min(0).max(50),
  })
  .strict();

export const BuildingInputSchema = z
  .object({
    label: z.string().trim().min(1).max(40),
    footprint: PolygonRingsSchema,
    footprintIsAssumed: z.boolean(),
    baseElevationM: finite.min(-50).max(500).default(0),
    segments: z.array(SegmentSchema).min(1).max(10),
    floorsAboveGround: z.number().int().min(1).max(200).nullable(),
    floorsBelowGround: z.number().int().min(0).max(20).nullable(),
    attribute: BuildingAttributeSchema,
    assumption: FloorAssumptionSchema.nullable().default(null),
    note: z.string().max(2000).nullable().default(null),
  })
  .strict();
export type BuildingInput = z.infer<typeof BuildingInputSchema>;

export const DevelopmentStatusSchema = z.enum(['unknown', 'vacant', 'site_prep', 'construction', 'completed', 'demolished', 'planned']);
export const VerificationSchema = z.enum(['pending', 'verified', 'estimated']);
export const DatePrecisionSchema = z.enum(['day', 'month', 'year']);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式須為 YYYY-MM-DD');

export const DevelopmentFieldsSchema = z
  .object({
    code: z.string().trim().min(1).max(40),
    name: z.string().trim().min(1).max(80),
    description: z.string().max(4000).nullable(),
    status: DevelopmentStatusSchema,
    completionKind: z.enum(['actual', 'estimated']).nullable(),
    completionDate: z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/).nullable(),
    completionPrecision: DatePrecisionSchema.nullable(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
    dataDate: isoDate.nullable(),
    verification: VerificationSchema,
  })
  .strict();

/** 完工日期須與精度一致：只有年份就只存年份，不補造 1 月 1 日 */
export function completionMismatch(d: { completionDate?: string | null; completionPrecision?: string | null }): string | null {
  const date = d.completionDate ?? null;
  const prec = d.completionPrecision ?? null;
  if (date == null && prec == null) return null;
  if (date == null || prec == null) return '完工日期與日期精度須同時填寫';
  const len = { year: 4, month: 7, day: 10 }[prec];
  return date.length === len ? null : `日期精度為 ${prec} 時，日期須為 ${prec === 'year' ? 'YYYY' : prec === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD'}`;
}

export const DevelopmentCreateSchema = DevelopmentFieldsSchema.partial()
  .extend({
    code: z.string().trim().min(1).max(40),
    name: z.string().trim().min(1).max(80),
  })
  .superRefine((d, ctx) => {
    const m = completionMismatch(d);
    if (m) ctx.addIssue({ code: 'custom', message: m, path: ['completionDate'] });
  });
export const DevelopmentPatchSchema = z
  .object({ expectedVersion: z.number().int().min(1), patch: DevelopmentFieldsSchema.partial() })
  .strict();

export const DeveloperInputSchema = z
  .object({
    companyName: z.string().trim().max(120).nullable(),
    brandName: z.string().trim().max(120).nullable(),
    taxId: z.string().regex(/^\d{8}$/, '統一編號須為 8 碼數字').nullable(),
    note: z.string().max(2000).nullable().default(null),
  })
  .strict()
  .refine((d) => d.companyName || d.brandName, '公司名稱與品牌名稱至少填一項');

export const DevelopmentDevelopersSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    developers: z.array(z.object({ developerId: z.string().uuid(), role: z.enum(['main', 'co', 'pending']) }).strict()).max(20),
  })
  .strict();

export const DevelopmentParcelsSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    parcelIds: z.array(z.string().uuid()).max(200),
  })
  .strict();

export const ParcelCreateSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('reference_block'),
      blockId: z.string().trim().min(1).max(40),
      label: z.string().max(80).nullable().default(null),
      zoning: z.string().max(40).nullable().default(null),
      geometry: PolygonRingsSchema,
      sourcePx: PolygonRingsSchema.nullable().default(null),
      sourceId: z.string().uuid().nullable().default(null),
      qualityNote: z.string().max(2000).nullable().default(null),
    })
    .strict(),
  z
    .object({
      kind: z.literal('cadastral'),
      county: z.string().trim().min(1),
      district: z.string().trim().min(1),
      sectionCode: z.string().trim().min(1, '地段代碼必填，避免同名地段混淆'),
      sectionName: z.string().trim().nullable().default(null),
      landRaw: z.string().trim().min(1),
      zoning: z.string().max(40).nullable().default(null),
      geometry: PolygonRingsSchema.nullable().default(null),
      sourceId: z.string().uuid().nullable().default(null),
      qualityNote: z.string().max(2000).nullable().default(null),
    })
    .strict(),
]);

export const ParcelGeometrySchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    geometry: PolygonRingsSchema,
    sourcePx: PolygonRingsSchema.nullable().default(null),
    qualityNote: z.string().max(2000).nullable().default(null),
  })
  .strict();

export const BuildingCreateSchema = z.object({ scenarioId: z.string().uuid(), building: BuildingInputSchema }).strict();
export const BuildingVersionSchema = z
  .object({ scenarioId: z.string().uuid(), expectedVersionId: z.string().uuid(), building: BuildingInputSchema })
  .strict();

export const CameraSchema = z
  .object({
    position: z.tuple([finite, finite, finite]),
    target: z.tuple([finite, finite, finite]),
    fov: finite.min(10).max(120),
    zoom: finite.gt(0).max(1000),
    eyeHeightM: finite.min(0).max(1000).nullable(),
  })
  .strict();
export type CameraState = z.infer<typeof CameraSchema>;

export const BookmarkCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    mode: z.enum(['top', 'orbit', 'walk']),
    scenarioId: z.string().uuid().nullable(),
    camera: CameraSchema,
  })
  .strict();

export const ScenarioCreateSchema = z
  .object({
    kind: z.enum(['observed', 'planned', 'assumption']),
    name: z.string().trim().min(1).max(60),
    dataAsOf: isoDate.nullable(),
    targetDate: z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/).nullable(),
    targetPrecision: DatePrecisionSchema.nullable(),
    baseScenarioId: z.string().uuid().nullable(),
  })
  .strict();

export const ImportCommitSchema = z
  .object({
    mode: z.enum(['valid_only', 'all_or_nothing']),
    idempotencyKey: z.string().min(8).max(100),
  })
  .strict();

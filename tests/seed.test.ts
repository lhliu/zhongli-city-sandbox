import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb } from './d1shim';
import { loadScene } from '../server/scene';
import { validatePolygon, polygonArea, unionSites } from '../src/lib/geometry/polygon';
import intersect from '@turf/intersect';
import { featureCollection } from '@turf/helpers';
import { toFeature } from '../src/lib/geometry/polygon';

const P = '5a1e0000-0000-4000-8000-000000000001';

async function seeded(withDemo: boolean) {
  const db = createTestDb();
  const raw = (db as unknown as { raw: { exec(s: string): void } }).raw;
  raw.exec(readFileSync(join(__dirname, '..', 'seed', 'seed_reference.sql'), 'utf8'));
  if (withDemo) raw.exec(readFileSync(join(__dirname, '..', 'seed', 'seed_demo.sql'), 'utf8'));
  return db;
}

describe('種子資料品質', () => {
  it('參考區塊幾何合法、沒有地號、彼此不重疊', async () => {
    const scene = await loadScene(await seeded(false), P, 'owner', null);
    expect(scene.parcels.length).toBeGreaterThanOrEqual(10);
    for (const p of scene.parcels) {
      expect(p.kind).toBe('reference_block');
      expect(p.landMain).toBeNull();
      expect(validatePolygon(p.geometry!)).toEqual([]);
    }
    for (let i = 0; i < scene.parcels.length; i++)
      for (let j = i + 1; j < scene.parcels.length; j++) {
        const x = intersect(featureCollection([toFeature(scene.parcels[i]!.geometry!), toFeature(scene.parcels[j]!.geometry!)]));
        const overlap = x ? polygonArea(x.geometry.type === 'Polygon' ? (x.geometry.coordinates as [number, number][][]) : (x.geometry.coordinates[0] as [number, number][][])) : 0;
        expect(overlap, `${scene.parcels[i]!.blockId} × ${scene.parcels[j]!.blockId}`).toBeLessThan(15);
      }
  });

  it('範圍面積與官方 72.97–74.2 公頃相差 < 6%', async () => {
    const scene = await loadScene(await seeded(false), P, 'owner', null);
    const b = scene.features.find((f) => f.kind === 'boundary')!;
    const ha = polygonArea(b.geometry) / 1e4;
    expect(Math.abs(ha - 73.6) / 73.6).toBeLessThan(0.06);
  });

  it('所有參考區塊位於範圍界線內', async () => {
    const scene = await loadScene(await seeded(false), P, 'owner', null);
    const b = scene.features.find((f) => f.kind === 'boundary')!;
    const u = unionSites([b.geometry]);
    expect(u).not.toBeNull();
    const booleanWithin = (await import('@turf/boolean-within')).default;
    for (const p of scene.parcels) expect(booleanWithin(toFeature(p.geometry!), u!), p.blockId!).toBe(true);
  });

  it('正式種子沒有 demo 資料；demo 種子全部標記 is_demo', async () => {
    const ref = await loadScene(await seeded(false), P, 'owner', null);
    expect(ref.developments).toHaveLength(0);
    expect(ref.buildings).toHaveLength(0);
    const withDemo = await seeded(true);
    const demoScenario = (await loadScene(withDemo, P, 'owner', null)).scenarios.find((s) => s.isDemo)!;
    const demo = await loadScene(withDemo, P, 'owner', demoScenario.id);
    expect(demo.developments.every((d) => d.isDemo)).toBe(true);
    expect(demo.buildings).toHaveLength(2);
    expect(demo.developments[0]!.parcelIds).toHaveLength(2);
    // 現況情境看不到 demo 棟
    expect((await loadScene(withDemo, P, 'owner', null)).buildings).toHaveLength(0);
  });
});

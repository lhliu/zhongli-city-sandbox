// 端到端煙霧測試：npm run pages:dev 起來後執行 node e2e/smoke.mjs
// 截圖存到 e2e/out/
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8788';
const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));

const step = async (name, fn) => {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    console.log(`✗ ${name}: ${e.message.split('\n')[0]}`);
    await page.screenshot({ path: `${OUT}fail_${name.replace(/\W+/g, '_')}.png` });
  }
};

await step('專案列表', async () => {
  await page.goto(`${BASE}/projects`);
  await page.getByText('開啟 3D 沙盤').click();
  await page.waitForSelector('canvas');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}01_orbit.png` });
});

await step('俯視', async () => {
  await page.getByRole('button', { name: '俯視' }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}02_top.png` });
});

await step('切 DEMO 情境＋選建物', async () => {
  const sel = page.getByLabel('情境');
  const demo = await sel.locator('option', { hasText: 'DEMO' }).getAttribute('value');
  await sel.selectOption(demo);
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: '鳥瞰' }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}03_demo_orbit.png` });
});

await step('選建案→選棟→改層數→儲存', async () => {
  await page.locator('.right .card', { hasText: 'DEMO 示範建案' }).click();
  await page.getByRole('button', { name: /^A棟/ }).click();
  await page.getByLabel('地上層數').fill('30');
  await page.getByRole('button', { name: '儲存為新版本' }).click();
  await page.waitForSelector('text=已儲存', { timeout: 8000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${OUT}04_after_edit.png` });
});

await step('平視', async () => {
  await page.getByRole('button', { name: '平視' }).click();
  await page.waitForTimeout(800);
  await page.keyboard.down('KeyS');
  await page.waitForTimeout(1500);
  await page.keyboard.up('KeyS');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}05_walk.png` });
});

await step('選棟後平視（站在南方面向建物）', async () => {
  await page.getByRole('button', { name: '鳥瞰' }).click();
  await page.locator('.right .card', { hasText: 'DEMO 示範建案' }).click().catch(() => {});
  await page.getByRole('button', { name: /^B棟/ }).click().catch(() => {});
  await page.getByRole('button', { name: '平視' }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}05b_walk_selected.png` });
});

await step('描新參考區塊', async () => {
  await page.getByRole('button', { name: '在底圖描新地塊' }).click();
  await page.waitForTimeout(1200);
  const box = await page.locator('.canvaswrap canvas').boundingBox();
  const cx = box.x + box.width * 0.62, cy = box.y + box.height * 0.62;
  for (const [dx, dy] of [[0, 0], [40, 0], [40, 30], [0, 30]]) {
    await page.mouse.click(cx + dx, cy + dy);
    await page.waitForTimeout(150);
  }
  const bid = `E2E-${Date.now() % 100000}`;
  await page.getByLabel('區塊代號').fill(bid);
  await page.screenshot({ path: `${OUT}07_draw.png` });
  await page.getByRole('button', { name: '完成並儲存' }).click();
  await page.waitForSelector(`text=${bid}（參考區塊）`, { timeout: 8000 });
});

await step('PNG 輸出', async () => {
  await page.getByRole('button', { name: '鳥瞰' }).click();
  await page.waitForTimeout(1200);
  const [d1] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.getByRole('button', { name: '下載 PNG' }).click()]);
  await d1.saveAs(`${OUT}export_${d1.suggestedFilename()}`);
  console.log('   下載：', d1.suggestedFilename());
});

await step('資料表', async () => {
  await page.getByRole('link', { name: '資料表' }).click();
  await page.waitForSelector('table');
  await page.screenshot({ path: `${OUT}06_data.png`, fullPage: true });
});

await step('viewer 不能編輯', async () => {
  const v = await ctx.newPage();
  await v.goto(`${BASE}/projects?as=viewer@x`);
  await v.waitForSelector('.empty, .card', { timeout: 8000 });
  const txt = await v.textContent('body');
  if (!txt.includes('不是任何專案的成員')) throw new Error('非成員應看到提示');
  await v.close();
});

console.log(errors.length ? `瀏覽器錯誤：\n${errors.slice(0, 10).join('\n')}` : '瀏覽器無錯誤');
await browser.close();

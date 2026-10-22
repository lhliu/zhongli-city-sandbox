# KC 城市沙盤｜中壢體育園區

以官方圖面為骨架、由 KC 維護資料、可切換現況／規劃／假設情境的 3D 沙盤網站。
規格：《中壢體育園區_3D網站開發規格_Opus交付_v01.md》（Google Drive：璞園中運安彊 合作案/AI_Output）。

## 技術架構

| 層 | 選擇 | 說明 |
|---|---|---|
| 前端 | Vite＋React 19＋TypeScript | 桌面優先；`/projects/:id/explore｜data｜sources` |
| 3D | Three.js＋React Three Fiber／Drei | 俯視（正交、正北朝上）／鳥瞰（Orbit）／平視（自製 WalkControls） |
| API | Cloudflare Pages Functions（Hono） | `functions/api/[[route]].ts` → `server/app.ts` |
| 資料 | Cloudflare D1（SQLite） | `migrations/`；幾何以 JSON 保存，權威檢查在 API（`src/lib/geometry`） |
| 檔案 | Cloudflare R2（已綁定，P1 上傳素材用） | P0 底圖放 `public/basemaps` |
| 登入 | Cloudflare Access | API 驗證 Access JWT；未設定時 API 一律 401（fail closed） |

**與規格的差異（KC 指定部署在 Cloudflare）**：規格建議 Supabase／PostGIS＋RLS。D1 沒有 PostGIS 與 RLS，因此：
- 空間運算（自交、洞、跨地號基地聯集、面積）在 TypeScript 以 turf 處理，前後端共用同一套程式。
- 權限由 API 檢查（`server/db.ts requireRole`），跨專案連結另由資料庫 trigger 拒絕；兩者都有測試。
- 日後若需要大量空間查詢，可用 Hyperdrive 接外部 PostGIS，不影響前端。

## 本機啟動

需要 Node 22。全部在本機模擬，不需要 Cloudflare 帳號或任何憑證。

```bash
npm ci
npm run build
npm run db:migrate:local            # 建立本機 D1
node seed/build_seed.mjs dev@local  # 產生種子 SQL（擁有者 email 可換）
npm run db:seed:local               # 匯入官方圖資與參考描繪
npx wrangler d1 execute zhongli-sandbox --local --file=seed/seed_demo.sql   # （選用）DEMO 示範資料
npm run pages:dev                   # http://localhost:8788
```

前端開發熱更新：另開一個終端 `npm run dev`（5173，/api 轉到 8788）。
本機可在網址加 `?as=viewer@x` 模擬其他使用者（只有 `DEV_AUTH=1` 的本機伺服器接受）。

## 測試

```bash
npm test             # 單元＋API＋種子品質（vitest，用 Node 內建 SQLite 跑真實 migrations）
npm run typecheck
# 端到端（需先 npm run pages:dev，並載入 DEMO 種子）
CHROMIUM=/path/to/chrome node e2e/smoke.mjs     # 截圖輸出到 e2e/out/
```

## 部署（Cloudflare Pages 連 GitHub 自動部署）

容器與 repo 內不放任何憑證。

**已完成（2026-10-22，經 Cloudflare 連接器）**
- D1 `zhongli-sandbox`（APAC，ID 已寫入 `wrangler.toml`）：已套用 0001、0002 migrations（`d1_migrations` 表已記錄，之後 `wrangler d1 migrations apply --remote` 只會跑新的），已匯入正式參考種子（擁有者 lhliu.tw@gmail.com），**未匯入 DEMO**。
- R2 `zhongli-sandbox-assets`。

**需在 Cloudflare 後台操作**
1. **Pages**：Workers & Pages → Create → Pages → Connect to Git → `lhliu/zhongli-city-sandbox`，Production branch `main`，Framework preset `None`，Build command `npm run build`，Build output `dist`。綁定（D1、R2）自動讀 `wrangler.toml`。
2. **Cloudflare Access（必要，否則 API 全部 401）**：Zero Trust → Access → Applications → Add → Self-hosted；Application domain 填 Pages 網址（`zhongli-city-sandbox.pages.dev`，以及 `*.zhongli-city-sandbox.pages.dev` 預覽網址）；Policy：Include → Emails → 你的 email。
3. 回到 Pages → Settings → Variables and Secrets，新增兩個 **Secret**：`ACCESS_TEAM_DOMAIN`（例如 `yourteam.cloudflareaccess.com`）、`ACCESS_AUD`（Access 應用程式的 Application Audience (AUD) Tag）。重新部署一次。
4. 新增成員：`INSERT INTO project_members (project_id, user_email, role) VALUES ('5a1e0000-0000-4000-8000-000000000001', 'someone@example.com', 'viewer');`

本機另建資料庫時：`npm run db:migrate:local`、`node seed/build_seed.mjs <email>`、`npm run db:seed:local`。**不要**把 `seed_demo.sql` 匯入正式環境。

## 備份與還原

- 備份：`npx wrangler d1 export zhongli-sandbox --remote --output=backup_YYYYMMDD.sql`（D1 另有 Time Travel，可還原 30 天內任一時間點：`npx wrangler d1 time-travel restore`）。
- 原始圖檔已在 repo `sources/raw/`，雜湊記在 `sources/registry.json`。
- 還原演練：建立空白 D1 → `wrangler d1 execute <新庫> --remote --file=backup.sql` → Pages 預覽環境綁新庫驗證。**尚未實際演練**（需要正式帳號）。

## 資料規則（摘要）

- 地號以字串保存，canonical＝母號 4 碼＋子號 4 碼；無子號＝`0000`。沒有地段代碼不組成地籍鍵、不猜測。
- 參考區塊（`reference_block`）是官方圖面描繪的街廓，沒有地號，不可用於精準面積、退縮或權界判斷。
- 未知樓高存 `null`，不以 0 代表；未知高度的棟別只畫地面輪廓。
- 只有年份的完工日期只存年份（`date_precision=year`），不補造 1 月 1 日。
- 棟別每次修改建立不可變版本；情境只引用版本 ID，修改只影響目前情境。
- DEMO 資料一律 `is_demo=1`，介面紅色標示，正式種子不含 DEMO。

## 專案結構

```
src/lib/geo          唯一座標轉換（EPSG:3826、圖面座標、方位角）
src/lib/geometry     多邊形檢查、基地聯集、高度計算
src/lib/calibration  控制點仿射與檢核點 RMSE
src/lib/parcel       地號正規化
src/lib/import       CSV 匯入計畫（純函式）
src/features/        explorer（3D）、data（表格與匯入）、sources、projects
server/              API、權限、場景、匯入
migrations/          D1 schema
seed/                種子產生器、S2 描點、DEMO
sources/             來源登錄與原始圖檔
templates/           地號建商建案匯入模板_v01.csv（KC 提供）
docs/                里程碑報告與資料品質報告
```

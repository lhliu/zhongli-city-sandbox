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

容器與 repo 內不放任何憑證。以下在 Cloudflare 後台由 KC 操作一次：

1. **D1**：Workers & Pages → D1 → 建立資料庫 `zhongli-sandbox`，把 database_id 填進 `wrangler.toml`（或交給 Claude 透過 Cloudflare 連接器建立）。
2. **套用 schema 與種子**（任選一）：
   - Mac 上：`npx wrangler login` 後執行 `npx wrangler d1 migrations apply zhongli-sandbox --remote`，再 `node seed/build_seed.mjs <你的登入email>`、`npx wrangler d1 execute zhongli-sandbox --remote --file=seed/seed_reference.sql`
   - 或請 Claude 透過 Cloudflare 連接器執行同樣的 SQL。
   - **不要**把 `seed_demo.sql` 匯入正式環境。
3. **R2**：建立 bucket `zhongli-sandbox-assets`。
4. **Pages**：Workers & Pages → 建立 → Pages → 連接 GitHub `lhliu/zhongli-city-sandbox`，Build command `npm run build`，Output `dist`。綁定由 `wrangler.toml` 讀取。
5. **Cloudflare Access（必要）**：Zero Trust → Access → Applications → Self-hosted，網域填 Pages 網址，政策只允許 KC 的 email。把 Team domain（如 `kc.cloudflareaccess.com`）與 Application Audience (AUD) 填到 Pages 環境變數 `ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`。未設定前 API 一律拒絕。
6. 新增成員：`INSERT INTO project_members (project_id, user_email, role) VALUES ('5a1e0000-0000-4000-8000-000000000001', 'someone@example.com', 'viewer');`

環境變數見 `.dev.vars.example`。

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

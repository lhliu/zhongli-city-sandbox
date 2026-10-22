export type Env = {
  DB: D1Database;
  ASSETS_BUCKET?: R2Bucket;
  /** 只在本機 wrangler pages dev 設為 "1"；允許以 X-Dev-User 指定使用者 */
  DEV_AUTH?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
};

export type Vars = { user: string; requestId: string };
export type AppEnv = { Bindings: Env; Variables: Vars };

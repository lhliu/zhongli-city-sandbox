-- batch 內的樂觀鎖守衛（server/db.ts guard()）
CREATE TABLE _guards (ok INTEGER NOT NULL CHECK (ok = 1));

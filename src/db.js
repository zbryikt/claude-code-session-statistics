/**
 * SQLite schema 與連線。
 *
 * 資料庫放在 ~/.local/state/ccstat/ccstat.db，刻意不放 ~/.claude 底下——
 * 那是 Claude Code 自己的地盤，清掉或重裝都可能連帶消失。
 */
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DB_PATH = join(homedir(), '.local/state/ccstat/ccstat.db');

const SCHEMA = `
-- 增量掃描狀態：transcript 是 append-only，記住上次讀到的 byte offset，
-- 下次只讀新增的部分，不必重掃（也不必算整檔 hash）
CREATE TABLE IF NOT EXISTS files (
  path       TEXT PRIMARY KEY,
  sid        TEXT,
  size       INTEGER NOT NULL,   -- 上次讀到的位元組數 = 下次的起讀點
  mtime      REAL,
  scanned_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  sid         TEXT PRIMARY KEY,
  path        TEXT,
  cwd         TEXT,
  project     TEXT,              -- cwd 的最後一段，給統計分組用
  branch      TEXT,
  started_at  REAL,
  last_at     REAL,
  n_user      INTEGER DEFAULT 0,
  n_assistant INTEGER DEFAULT 0,
  last_prompt TEXT,
  kind        TEXT DEFAULT 'interactive'   -- interactive | sdk（claude -p 自己留下的）
);
CREATE INDEX IF NOT EXISTS idx_sessions_last ON sessions(last_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_proj ON sessions(project);

-- 逐則 assistant 訊息的 token 用量；uuid 當主鍵讓重掃是冪等的
CREATE TABLE IF NOT EXISTS usage (
  uuid         TEXT PRIMARY KEY,
  sid          TEXT NOT NULL,
  ts           REAL,
  day          TEXT,             -- YYYY-MM-DD，本地時區
  model        TEXT,
  input        INTEGER DEFAULT 0,
  output       INTEGER DEFAULT 0,
  cache_read   INTEGER DEFAULT 0,
  cache_create INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_usage_sid   ON usage(sid);
CREATE INDEX IF NOT EXISTS idx_usage_day   ON usage(day);
CREATE INDEX IF NOT EXISTS idx_usage_model ON usage(model);

-- LLM 摘要。key = 餵給模型那段文字的 hash，變了才重算
CREATE TABLE IF NOT EXISTS summaries (
  sid        TEXT PRIMARY KEY,
  key        TEXT NOT NULL,
  doing      TEXT,
  next_step  TEXT,
  raw        TEXT,
  model      TEXT,
  created_at INTEGER
);

-- 設定，目前用來記住備份目的地
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

export function connect(path = DB_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL');      // 讀寫不互卡
  db.exec('PRAGMA synchronous=NORMAL');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** 舊資料庫補上後來才加的欄位。 */
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
  if (!cols.includes('kind')) {
    db.exec("ALTER TABLE sessions ADD COLUMN kind TEXT DEFAULT 'interactive'");
  }
}

export function getConfig(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM config WHERE key=?').get(key);
  return row ? row.value : fallback;
}

export function setConfig(db, key, value) {
  db.prepare(`INSERT INTO config (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, value);
}

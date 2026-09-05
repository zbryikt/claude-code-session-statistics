"""SQLite schema 與存取.

資料庫預設放在 ~/.local/state/ccstat/ccstat.db, 刻意不放 ~/.claude 底下 ——
那個目錄是 Claude Code 自己的地盤, 清掉或重裝都可能連帶消失.
"""
import sqlite3
from pathlib import Path

DB_PATH = Path.home() / ".local/state/ccstat/ccstat.db"

SCHEMA = """
-- 增量掃描狀態: transcript 是 append-only, 記住上次讀到的 byte offset,
-- 下次只讀新增的部分, 不必重掃 (也不必算整檔 hash)
CREATE TABLE IF NOT EXISTS files (
  path       TEXT PRIMARY KEY,
  sid        TEXT,
  size       INTEGER NOT NULL,   -- 上次掃到的位元組數 = 下次的起讀點
  mtime      REAL,
  scanned_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  sid         TEXT PRIMARY KEY,
  path        TEXT,
  cwd         TEXT,
  project     TEXT,              -- cwd 的最後一段, 給統計分組用
  branch      TEXT,
  started_at  REAL,
  last_at     REAL,
  n_user      INTEGER DEFAULT 0,
  n_assistant INTEGER DEFAULT 0,
  last_prompt TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_last ON sessions(last_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_proj ON sessions(project);

-- 逐則 assistant 訊息的 token 用量; uuid 當主鍵讓重掃可以冪等
CREATE TABLE IF NOT EXISTS usage (
  uuid         TEXT PRIMARY KEY,
  sid          TEXT NOT NULL,
  ts           REAL,
  day          TEXT,             -- YYYY-MM-DD, 本地時區
  model        TEXT,
  input        INTEGER DEFAULT 0,
  output       INTEGER DEFAULT 0,
  cache_read   INTEGER DEFAULT 0,
  cache_create INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_usage_sid   ON usage(sid);
CREATE INDEX IF NOT EXISTS idx_usage_day   ON usage(day);
CREATE INDEX IF NOT EXISTS idx_usage_model ON usage(model);

-- LLM 摘要. key = 餵給模型那段文字的 hash, 變了才重算
CREATE TABLE IF NOT EXISTS summaries (
  sid        TEXT PRIMARY KEY,
  key        TEXT NOT NULL,
  doing      TEXT,
  next_step  TEXT,
  raw        TEXT,
  model      TEXT,
  created_at INTEGER
);
"""


def connect(path=None):
    p = Path(path or DB_PATH)
    p.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(p, timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")      # 讀寫不互卡
    con.execute("PRAGMA synchronous=NORMAL")
    con.executescript(SCHEMA)
    return con

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.FLOW_DATA_DIR || path.join(process.cwd(), 'data');
mkdirSync(DATA_DIR, { recursive: true });
export const DB_PATH = path.join(DATA_DIR, 'flow.db');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  folder_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL,
  bank TEXT, account_no TEXT, account_name TEXT,
  period_start TEXT, period_end TEXT,
  status TEXT NOT NULL DEFAULT 'scanned',
  tx_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, rel_path)
);
CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_id);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  page INTEGER NOT NULL DEFAULT 0,
  line_no INTEGER NOT NULL DEFAULT 0,
  date TEXT, summary TEXT,
  amount REAL NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  balance REAL,
  counterparty TEXT, counterparty_account TEXT, channel TEXT,
  category TEXT, category_src TEXT,
  subject_id INTEGER,
  risk_flags TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 1,
  raw_text TEXT,
  status TEXT NOT NULL DEFAULT 'ok'
);
CREATE INDEX IF NOT EXISTS idx_tx_file ON transactions(file_id);
CREATE INDEX IF NOT EXISTS idx_tx_counterparty ON transactions(counterparty);
CREATE TABLE IF NOT EXISTS subjects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global','project')),
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  entity_type TEXT NOT NULL DEFAULT 'related_party',
  account_kind TEXT NOT NULL DEFAULT 'unknown',
  note TEXT
);
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  severity TEXT NOT NULL DEFAULT 'medium',
  enabled INTEGER NOT NULL DEFAULT 1,
  builtin INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS rule_hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id INTEGER NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

/** 内置规则种子（M5 启用；先建好避免重复插入） */
const seeded = (db.prepare('SELECT COUNT(*) c FROM rules').get() as { c: number }).c;
if (seeded === 0) {
  const ins = db.prepare(
    'INSERT INTO rules(name, type, params, severity, enabled, builtin) VALUES(?,?,?,?,1,1)',
  );
  ins.run('募集资金转自身/子公司一般户', 'R1_dedicated_to_general', '{}', 'high');
  ins.run('关联方资金往来', 'R2_related_party', '{}', 'medium');
  ins.run('大额整额转账', 'R3_large_round', '{"threshold": 1000000}', 'medium');
  ins.run('非工作时段交易', 'R4_off_hours', '{}', 'low');
  ins.run('当日快进快出', 'R5_fast_roundtrip', '{"withinDays": 3, "ratio": 0.7}', 'medium');
}

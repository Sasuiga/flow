import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.FLOW_DATA_DIR || path.join(process.cwd(), 'data');
mkdirSync(DATA_DIR, { recursive: true });
export const DB_PATH = path.join(DATA_DIR, 'flow.db');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const now = () => new Date().toISOString();
const tableCols = (t: string): string[] =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((r) => r.name);

db.exec(`
-- 客户（xx 上市公司）：一家公司会有多次融资
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  folder_path TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','done','archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- 融资项目（IPO/再融资/可转债…）：属客户
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  folder_path TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','done','archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(client_id, name)
);
-- 报告期任务（流水分析单元）：属项目，PDF 放任务目录，报告输出任务目录 flow-output/
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  folder_path TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','done','archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, name)
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL,
  bank TEXT, account_no TEXT, account_name TEXT,
  period_start TEXT, period_end TEXT,
  status TEXT NOT NULL DEFAULT 'scanned',
  tx_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(task_id, rel_path)
);
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
-- 主体登记（v1.1 启用）：客户层基础清单 + 报告期任务差异（本期新增/排除）
CREATE TABLE IF NOT EXISTS subjects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'client' CHECK (scope IN ('client','task')),
  client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  excluded INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  entity_type TEXT NOT NULL DEFAULT 'related_party',
  account_kind TEXT NOT NULL DEFAULT 'unknown',
  note TEXT
);
CREATE TABLE IF NOT EXISTS name_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  counterparty TEXT NOT NULL,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  method TEXT NOT NULL DEFAULT 'exact'
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

/* ---------- M1 兼容迁移（旧库：projects 无 client_id/status，files 挂 project_id） ---------- */

if (!tableCols('projects').includes('client_id')) {
  db.exec('ALTER TABLE projects ADD COLUMN client_id INTEGER');
}
if (!tableCols('projects').includes('status')) {
  db.exec("ALTER TABLE projects ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
}
if (!tableCols('files').includes('task_id')) {
  // M1 的 files 尚无解析结果（M2 才产出交易），直接重建挂 task_id
  db.exec('DROP TABLE IF EXISTS files');
  db.exec(`
CREATE TABLE files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL,
  bank TEXT, account_no TEXT, account_name TEXT,
  period_start TEXT, period_end TEXT,
  status TEXT NOT NULL DEFAULT 'scanned',
  tx_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(task_id, rel_path)
);
CREATE INDEX IF NOT EXISTS idx_files_task ON files(task_id);
`);
}
// 索引统一在迁移之后创建：旧库的 files 表重建前没有 task_id 列，projects 表补列前没有 client_id
db.exec('CREATE INDEX IF NOT EXISTS idx_files_task ON files(task_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_projects_client ON projects(client_id)');
// 遗留项目（client_id 为空）挂到自动创建的「遗留客户」下，避免 NULL 外键
const legacy = db.prepare('SELECT COUNT(*) AS c FROM projects WHERE client_id IS NULL').get() as { c: number };
if (legacy.c > 0) {
  const first = db.prepare(
    'SELECT folder_path FROM projects WHERE client_id IS NULL ORDER BY id LIMIT 1',
  ).get() as { folder_path: string };
  let cid: number;
  try {
    const r = db
      .prepare('INSERT INTO clients(name, folder_path, created_at, updated_at) VALUES(?,?,?,?)')
      .run('遗留客户', path.dirname(first.folder_path), now(), now());
    cid = Number(r.lastInsertRowid);
  } catch {
    cid = (db.prepare("SELECT id FROM clients WHERE name = '遗留客户'").get() as { id: number }).id;
  }
  db.prepare('UPDATE projects SET client_id = ? WHERE client_id IS NULL').run(cid);
}

/* ---------- 内置规则种子（M5 启用；R1/R2 默认关闭，v1.1 随主体登记启用） ---------- */

const seeded = (db.prepare('SELECT COUNT(*) c FROM rules').get() as { c: number }).c;
if (seeded === 0) {
  const ins = db.prepare(
    'INSERT INTO rules(name, type, params, severity, enabled, builtin) VALUES(?,?,?,?,?,1)',
  );
  ins.run('募集资金转自身/子公司一般户', 'R1_dedicated_to_general', '{}', 'high', 0);
  ins.run('关联方资金往来', 'R2_related_party', '{}', 'medium', 0);
  ins.run('大额整额转账', 'R3_large_round', '{"threshold": 1000000}', 'medium', 1);
  ins.run('非工作时段交易', 'R4_off_hours', '{}', 'low', 1);
  ins.run('当日快进快出', 'R5_fast_roundtrip', '{"withinDays": 3, "ratio": 0.7}', 'medium', 1);
}

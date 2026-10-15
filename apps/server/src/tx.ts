/**
 * 交易浏览器与解析触发路由（M2）
 *  GET /api/transactions          跨任务交易表（过滤/排序/分页 + 聚合）
 *  GET /api/transactions/options  过滤器选项（任务/银行/账户/分类）
 *  POST /api/files/:id/parse     单文件解析/重解析（入队）
 *  POST /api/files/:id/refresh   任务级重扫+解析（chokidar 之外的手动通道）
 *  DELETE /api/files/:id         删除文件登记（含其交易；磁盘 PDF 不动）
 */
import { Router } from 'express';
import { db } from './db.js';
import { parseQueue, recomputeFileBalanceReviews, refreshTaskFilesAuto } from './parse.js';
import { TaskListItem, TxOptions, TxPageResult, TxQuery, TxRow } from '@flow/shared';

function toTxRow(r: Record<string, unknown>): TxRow {
  return {
    id: Number(r.id),
    fileId: Number(r.file_id),
    fileName: String(r.file_name ?? ''),
    taskName: String(r.task_name ?? ''),
    projectName: String(r.project_name ?? ''),
    clientName: String(r.client_name ?? ''),
    bank: (r.bank as string | null) ?? undefined,
    accountNo: (r.account_no as string | null) ?? undefined,
    page: Number(r.page),
    lineNo: Number(r.line_no),
    date: (r.date as string | null) ?? undefined,
    summary: (r.summary as string | null) ?? undefined,
    amount: Number(r.amount),
    direction: r.direction as 'in' | 'out',
    balance: r.balance == null ? undefined : Number(r.balance),
    counterparty: (r.counterparty as string | null) ?? undefined,
    counterpartyAccount: (r.counterparty_account as string | null) ?? undefined,
    channel: (r.channel as string | null) ?? undefined,
    category: (r.category as string | null) ?? undefined,
    categorySrc: (r.category_src as 'llm' | 'manual' | null) ?? undefined,
    riskFlags: JSON.parse((r.risk_flags as string | null) ?? '[]'),
    confidence: Number(r.confidence),
    reviewNote: (r.review_note as string | null) ?? undefined,
    rawText: (r.raw_text as string | null) ?? undefined,
    status: r.status as TxRow['status'],
  };
}

const BASE_SELECT = `
SELECT t.id, t.file_id, t.page, t.line_no, t.date, t.summary, t.amount, t.direction, t.balance,
       t.counterparty, t.counterparty_account, t.channel, t.category, t.category_src,
       t.risk_flags, t.confidence, t.review_note, t.raw_text, t.status,
       f.rel_path AS file_name, f.bank, f.account_no,
       tk.name AS task_name, p.name AS project_name, c.name AS client_name
FROM transactions t
JOIN files f ON f.id = t.file_id
JOIN tasks tk ON tk.id = f.task_id
JOIN projects p ON p.id = tk.project_id
JOIN clients c ON c.id = p.client_id`;

export const transactionsRouter = Router();

/** 修正队列（M3）：待复核行，按流水印刷顺序。余额问题只在 reviewNote，不改交易数字。 */
transactionsRouter.get('/review', (req, res) => {
  const taskId = req.query.taskId ? Number(req.query.taskId) : undefined;
  const where = ["t.status = 'needs_review'"];
  const args: number[] = [];
  if (taskId && Number.isFinite(taskId)) {
    where.push('f.task_id = ?');
    args.push(taskId);
  }
  const rows = db
    .prepare(`${BASE_SELECT} WHERE ${where.join(' AND ')} ORDER BY f.rel_path, t.page, t.line_no, t.id LIMIT 1000`)
    .all(...args) as Record<string, unknown>[];
  res.json({ rows: rows.map(toTxRow), total: rows.length });
});

/** 人工修正一行，然后只重算该文件的复核提示 */
transactionsRouter.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT id, file_id FROM transactions WHERE id = ?').get(id) as
    | { id: number; file_id: number }
    | undefined;
  if (!existing) return res.status(404).json({ error: '交易不存在' });
  const b = (req.body ?? {}) as {
    date?: string | null;
    summary?: string | null;
    amount?: number;
    direction?: string;
    balance?: number | null;
    counterparty?: string | null;
  };
  if (b.direction !== 'in' && b.direction !== 'out') return res.status(400).json({ error: '方向只能是收入或支出' });
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: '金额需为大于 0 的数字' });
  const balance =
    b.balance == null || (typeof b.balance === 'string' && (b.balance as string) === '') ? null : Number(b.balance);
  if (balance != null && !Number.isFinite(balance)) return res.status(400).json({ error: '余额需为数字' });
  db.prepare(
    `UPDATE transactions SET date = ?, summary = ?, amount = ?, direction = ?, balance = ?, counterparty = ? WHERE id = ?`,
  ).run(
    typeof b.date === 'string' && b.date.trim() ? b.date.trim() : null,
    typeof b.summary === 'string' && b.summary.trim() ? b.summary.trim() : null,
    Math.round(amount * 100) / 100,
    b.direction,
    balance == null ? null : Math.round(balance * 100) / 100,
    typeof b.counterparty === 'string' && b.counterparty.trim() ? b.counterparty.trim() : null,
    id,
  );
  const reviewCount = recomputeFileBalanceReviews(existing.file_id, id);
  const updated = db.prepare(`${BASE_SELECT} WHERE t.id = ?`).get(id) as Record<string, unknown>;
  res.json({ row: toTxRow(updated), reviewCount });
});

transactionsRouter.get('/', (req, res) => {
  const q = req.query as unknown as Record<string, string | undefined>;
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (q.taskId) {
    where.push('f.task_id = ?');
    args.push(Number(q.taskId));
  }
  if (q.fileId) {
    where.push('f.id = ?');
    args.push(Number(q.fileId));
  }
  if (q.bank) {
    where.push('f.bank = ?');
    args.push(q.bank);
  }
  if (q.accountNo) {
    where.push('f.account_no LIKE ?');
    args.push(`%${q.accountNo}%`);
  }
  if (q.from) {
    where.push('t.date >= ?');
    args.push(q.from);
  }
  if (q.to) {
    where.push('t.date <= ?');
    args.push(q.to);
  }
  if (q.counterparty) {
    where.push('t.counterparty LIKE ?');
    args.push(`%${q.counterparty}%`);
  }
  if (q.q) {
    where.push('t.summary LIKE ?');
    args.push(`%${q.q}%`);
  }
  if (q.status) {
    where.push('t.status = ?');
    args.push(q.status);
  }
  if (q.category === '__none__') where.push('t.category IS NULL');
  else if (q.category) {
    where.push('t.category = ?');
    args.push(q.category);
  }
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const sort =
    q.sort === 'date_asc'
      ? 'ORDER BY t.date IS NULL, t.date ASC, f.rel_path, t.page, t.line_no, t.id'
      : q.sort === 'date_desc'
        ? 'ORDER BY t.date IS NULL, t.date DESC, f.rel_path, t.page, t.line_no, t.id'
        : q.sort === 'amount_desc'
          ? 'ORDER BY t.amount DESC, f.rel_path, t.page, t.line_no, t.id'
          : 'ORDER BY f.rel_path, t.page, t.line_no, t.id';
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(200, Math.max(10, Number(q.pageSize) || 50));

  const total = Number(
    (db.prepare(`SELECT COUNT(*) AS c FROM transactions t JOIN files f ON f.id = t.file_id${whereSql}`).get(...args) as { c: number }).c,
  );
  const agg = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN t.direction = 'in' THEN t.amount ELSE 0 END), 0) AS inflow,
              COALESCE(SUM(CASE WHEN t.direction = 'out' THEN t.amount ELSE 0 END), 0) AS outflow
       FROM transactions t JOIN files f ON f.id = t.file_id${whereSql}`,
    )
    .get(...args) as { inflow: number; outflow: number };
  const rows = db
    .prepare(`${BASE_SELECT}${whereSql} ${sort} LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize) as Record<string, unknown>[];

  const result: TxPageResult = { rows: rows.map(toTxRow), total, inflow: agg.inflow, outflow: agg.outflow };
  res.json(result);
});

/** 过滤器选项：任务（带层级名）/ 银行 / 账户 / 已用分类 */
transactionsRouter.get('/options', (_req, res) => {
  const taskRows = (
    db.prepare(
      `SELECT tk.id, tk.name, c.name AS client_name, p.name AS project_name,
              (SELECT COALESCE(SUM(f2.tx_count), 0) FROM files f2 WHERE f2.task_id = tk.id) AS tx_count
       FROM tasks tk JOIN projects p ON p.id = tk.project_id JOIN clients c ON c.id = p.client_id
       ORDER BY tk.updated_at DESC`,
    ).all() as Array<Record<string, unknown>>
  );
  const tasks = taskRows.map((t) => ({
    id: Number(t.id),
    name: String(t.name),
    clientName: String(t.client_name),
    projectName: String(t.project_name),
    txCount: Number(t.tx_count),
  }));
  const banks = (db.prepare('SELECT DISTINCT bank FROM files WHERE bank IS NOT NULL AND bank != \'\' ORDER BY bank').all() as { bank: string }[]).map((r) => r.bank);
  const accounts = (db.prepare('SELECT DISTINCT account_no FROM files WHERE account_no IS NOT NULL AND account_no != \'\' ORDER BY account_no').all() as { account_no: string }[]).map((r) => r.account_no);
  const categories = (
    db.prepare('SELECT DISTINCT category FROM transactions WHERE category IS NOT NULL AND category != \'\' ORDER BY category').all() as { category: string }[]
  ).map((r) => r.category);
  const options: TxOptions = { tasks, banks, accounts, categories };
  res.json(options);
});

/* ---------- 文件：解析/重解析/删登记 ---------- */

export const filesRouter = Router();

/** 单文件解析/重解析（入队；状态置 parsing 由队列负责） */
filesRouter.post('/:id/parse', (req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare('SELECT id, status FROM files WHERE id = ?').get(id) as { id: number; status: string } | undefined;
  if (!r) return res.status(404).json({ error: '文件不存在' });
  const queued = parseQueue.enqueue(id);
  res.json({ ok: true, queued, alreadyRunning: !queued });
});

/** 任务级：重扫目录，并把尚未在解析中的 PDF 全部入队（含已完成/待复核，按当前规则重抽） */
filesRouter.post('/task/:taskId/parse', (req, res) => {
  const taskId = Number(req.params.taskId);
  const task = db.prepare('SELECT id, folder_path FROM tasks WHERE id = ?').get(taskId) as
    | { id: number; folder_path: string }
    | undefined;
  if (!task) return res.status(404).json({ error: '任务不存在' });
  const added = refreshTaskFilesAuto(taskId, task.folder_path);
  let queued = 0;
  for (const r of db.prepare(`SELECT id FROM files WHERE task_id = ? AND status != 'parsing'`).all(taskId) as {
    id: number;
  }[]) {
    if (parseQueue.enqueue(r.id)) queued++;
  }
  res.json({ ok: true, added, queued });
});

/** 删除文件登记（其交易/命中级联删除；磁盘 PDF 不动，可重扫恢复） */
filesRouter.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM rule_hits WHERE transaction_id IN (SELECT id FROM transactions WHERE file_id = ?)').run(id);
  db.prepare('DELETE FROM transactions WHERE file_id = ?').run(id);
  const r = db.prepare('DELETE FROM files WHERE id = ?').run(id);
  if (r.changes === 0) return res.status(404).json({ error: '文件不存在' });
  res.json({ ok: true });
});

/* ---------- 任务列表（交易浏览器过滤器 / 顶栏上下文切换器用） ---------- */

export const taskListRouter = Router();

taskListRouter.get('/', (_req, res) => {
  const rows = (
    db.prepare(
      `SELECT tk.*, c.name AS client_name, p.name AS project_name,
              (SELECT COUNT(*) FROM files f WHERE f.task_id = tk.id) AS file_count,
              (SELECT COALESCE(SUM(f2.tx_count), 0) FROM files f2 WHERE f2.task_id = tk.id) AS tx_count
       FROM tasks tk
       JOIN projects p ON p.id = tk.project_id
       JOIN clients c ON c.id = p.client_id
       ORDER BY tk.updated_at DESC`,
    ).all() as Array<Record<string, unknown>>
  );
  const out: TaskListItem[] = rows.map((r) => ({
    id: Number(r.id),
    projectId: Number(r.project_id),
    name: String(r.name),
    folderPath: String(r.folder_path),
    status: r.status as TaskListItem['status'],
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    clientName: String(r.client_name),
    projectName: String(r.project_name),
    fileCount: Number(r.file_count),
    txCount: Number(r.tx_count),
  }));
  res.json(out);
});

/** 顶栏「当前任务」上下文切换器：最近 5 个任务 */
taskListRouter.get('/recent', (_req, res) => {
  const rows = (
    db.prepare(
      `SELECT tk.id, tk.name, tk.updated_at, c.name AS client_name, p.name AS project_name,
              (SELECT COUNT(*) FROM files f WHERE f.task_id = tk.id) AS file_count,
              (SELECT COALESCE(SUM(f2.tx_count), 0) FROM files f2 WHERE f2.task_id = tk.id) AS tx_count
       FROM tasks tk
       JOIN projects p ON p.id = tk.project_id
       JOIN clients c ON c.id = p.client_id
       ORDER BY tk.updated_at DESC LIMIT 5`,
    ).all() as Array<Record<string, unknown>>
  );
  res.json(
    rows.map((r) => ({
      id: Number(r.id),
      name: String(r.name),
      clientName: String(r.client_name),
      projectName: String(r.project_name),
      fileCount: Number(r.file_count),
      txCount: Number(r.tx_count),
      updatedAt: String(r.updated_at),
    })),
  );
});

export type { TxQuery };

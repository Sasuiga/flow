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
import { bulkCategory, setTxCategory } from './categorize.js';
import { TaskListItem, TxOptions, TxPageResult, TxQuery, TxRow } from '@flow/shared';

export function toTxRow(r: Record<string, unknown>): TxRow {
  return {
    id: Number(r.id),
    fileId: Number(r.file_id),
    fileName: String(r.file_name ?? ''),
    taskName: String(r.task_name ?? ''),
    projectName: String(r.project_name ?? ''),
    clientName: String(r.client_name ?? ''),
    bank: (r.bank as string | null) ?? undefined,
    accountNo: (r.account_no as string | null) ?? undefined,
    fundUseId: r.fund_use_id == null ? undefined : Number(r.fund_use_id),
    fundUse: (r.fund_use_name as string | null) || undefined,
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
    watched: Number(r.watched) === 1,
  };
}

const TX_FROM = `
FROM transactions t
JOIN files f ON f.id = t.file_id
JOIN tasks tk ON tk.id = f.task_id
JOIN projects p ON p.id = tk.project_id
JOIN clients c ON c.id = p.client_id
LEFT JOIN fund_use_accounts fua
  ON fua.project_id = tk.project_id
 AND fua.account_key != ''
 AND fua.account_key = UPPER(REPLACE(REPLACE(REPLACE(REPLACE(IFNULL(f.account_no, ''), ' ', ''), char(9), ''), '-', ''), '　', ''))
LEFT JOIN fund_uses fu ON fu.id = fua.fund_use_id
LEFT JOIN tx_watch w ON w.transaction_id = t.id`;

export const BASE_SELECT = `
SELECT t.id, t.file_id, t.page, t.line_no, t.date, t.summary, t.amount, t.direction, t.balance,
       t.counterparty, t.counterparty_account, t.channel, t.category, t.category_src,
       t.risk_flags, t.confidence, t.review_note, t.raw_text, t.status,
       COALESCE(w.marked, 0) AS watched,
       f.rel_path AS file_name, f.bank, f.account_no,
       fu.id AS fund_use_id, fu.name AS fund_use_name,
       tk.name AS task_name, p.name AS project_name, c.name AS client_name
${TX_FROM}`;

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

/** 分析页按线路批量改判（M4）：整条线路的交易一起打标，写的是交易级 category */
transactionsRouter.post('/bulk-category', (req, res) => {
  const b = (req.body ?? {}) as { ids?: unknown; category?: unknown };
  if (!Array.isArray(b.ids)) return res.status(400).json({ error: 'ids 需为数组' });
  const category = b.category == null || b.category === '' ? null : String(b.category).trim();
  res.json({ updated: bulkCategory(b.ids as number[], category) });
});

/** 人工修正一行（解析字段 + M4 的改判）。保存后按印刷顺序重算该文件全部前后余额，含原先标为正常的行 */
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
    /** M4 改判：string=改判成该分类，null=清除（只在请求体显式携带 category 时生效） */
    category?: string | null;
  };
  const hasNumbers = b.amount != null || b.balance != null || b.date != null || b.counterparty != null;
  if (hasNumbers) {
    if (b.direction !== 'in' && b.direction !== 'out') return res.status(400).json({ error: '方向只能是收入或支出' });
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: '金额需为大于 0 的数字' });
    const balance =
      b.balance == null || (typeof b.balance === 'string' && (b.balance as string) === '')
        ? null
        : Number(b.balance);
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
  }
  if ('category' in b && b.category !== undefined) {
    if (!setTxCategory(id, b.category == null ? null : String(b.category).trim() || null)) {
      return res.status(404).json({ error: '交易不存在' });
    }
  }
  const balance = recomputeFileBalanceReviews(existing.file_id, id);
  const updated = db.prepare(`${BASE_SELECT} WHERE t.id = ?`).get(id) as Record<string, unknown>;
  res.json({
    row: toTxRow(updated),
    reviewCount: balance.reviewCount,
    balance: { selfGap: balance.selfGap, nextGap: balance.nextGap, hasNext: balance.hasNext },
  });
});

transactionsRouter.get('/', (req, res) => {
  const q = req.query as unknown as Record<string, string | undefined>;
  const { whereSql, args } = buildWhere(q);
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

  const total = Number((db.prepare(`SELECT COUNT(*) AS c ${TX_FROM}${whereSql}`).get(...args) as { c: number }).c);
  const agg = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN t.direction = 'in' THEN t.amount ELSE 0 END), 0) AS inflow,
              COALESCE(SUM(CASE WHEN t.direction = 'out' THEN t.amount ELSE 0 END), 0) AS outflow
       ${TX_FROM}${whereSql}`,
    )
    .get(...args) as { inflow: number; outflow: number };
  const rows = db
    .prepare(`${BASE_SELECT}${whereSql} ${sort} LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize) as Record<string, unknown>[];

  const result: TxPageResult = { rows: rows.map(toTxRow), total, inflow: agg.inflow, outflow: agg.outflow };
  res.json(result);
});

/**
 * 过滤器选项。
 * 银行、募投始终是当前任务的全部，不因已选账户收窄，方便直接换银行。
 * 账户按所选银行和募投收窄。
 */
transactionsRouter.get('/options', (req, res) => {
  const q = req.query as unknown as Record<string, string | undefined>;
  const from = TX_FROM;
  const scope = { taskId: q.taskId, fileId: q.fileId };

  const taskWhere = buildWhere(q, ['taskId']);
  const taskRows = db
    .prepare(
      `SELECT tk.id, tk.name, c.name AS client_name, p.name AS project_name, COUNT(*) AS tx_count
       ${from}${taskWhere.whereSql}
       GROUP BY tk.id
       ORDER BY MAX(tk.updated_at) DESC`,
    )
    .all(...taskWhere.args) as Array<Record<string, unknown>>;
  const tasks = taskRows.map((t) => ({
    id: Number(t.id),
    name: String(t.name),
    clientName: String(t.client_name),
    projectName: String(t.project_name),
    txCount: Number(t.tx_count),
  }));

  const bankWhere = buildWhere(scope);
  const banks = (
    db
      .prepare(
        `SELECT DISTINCT f.bank AS bank ${from}${andWhere(bankWhere.whereSql, "f.bank IS NOT NULL AND f.bank != ''")} ORDER BY f.bank`,
      )
      .all(...bankWhere.args) as { bank: string }[]
  ).map((r) => r.bank);

  const accountWhere = buildWhere({ ...scope, bank: q.bank, fundUse: q.fundUse });
  const accounts = (
    db
      .prepare(
        `SELECT DISTINCT f.account_no AS account_no ${from}${andWhere(accountWhere.whereSql, "f.account_no IS NOT NULL AND f.account_no != ''")} ORDER BY f.account_no`,
      )
      .all(...accountWhere.args) as { account_no: string }[]
  ).map((r) => r.account_no);

  const categoryWhere = buildWhere(q, ['category']);
  const categories = (
    db
      .prepare(
        `SELECT DISTINCT t.category AS category ${from}${andWhere(categoryWhere.whereSql, "t.category IS NOT NULL AND t.category != ''")} ORDER BY t.category`,
      )
      .all(...categoryWhere.args) as { category: string }[]
  ).map((r) => r.category);

  const useWhere = buildWhere(scope);
  const fundUses = (
    db
      .prepare(
        `SELECT DISTINCT fu.id AS id, fu.name AS name ${from}${andWhere(useWhere.whereSql, 'fu.id IS NOT NULL')} ORDER BY fu.name`,
      )
      .all(...useWhere.args) as { id: number; name: string }[]
  ).map((r) => ({ id: Number(r.id), name: r.name }));
  const unassigned = db
    .prepare(
      `SELECT 1 AS x ${from}${andWhere(useWhere.whereSql, "fu.id IS NULL AND f.account_no IS NOT NULL AND TRIM(f.account_no) != ''")} LIMIT 1`,
    )
    .get(...useWhere.args);

  const options: TxOptions = { tasks, banks, accounts, categories, fundUses, hasUnassignedFundUse: !!unassigned };
  res.json(options);
});

/** 交易列表和筛选项共用。omit 掉的字段不参与约束，这样当前下拉仍能改选。 */
function buildWhere(
  q: Record<string, string | undefined>,
  omit: string[] = [],
): { whereSql: string; args: (string | number)[] } {
  const skip = new Set(omit);
  const where: string[] = [];
  const args: (string | number)[] = [];
  const has = (k: string) => !skip.has(k) && q[k] !== undefined && q[k] !== '';
  if (has('taskId')) {
    where.push('f.task_id = ?');
    args.push(Number(q.taskId));
  }
  if (has('fileId')) {
    where.push('f.id = ?');
    args.push(Number(q.fileId));
  }
  if (has('bank')) {
    where.push('f.bank = ?');
    args.push(q.bank!);
  }
  if (has('accountNo')) {
    where.push('f.account_no LIKE ?');
    args.push(`%${q.accountNo}%`);
  }
  if (!skip.has('fundUse') && q.fundUse === '__none__') where.push('fu.id IS NULL');
  else if (has('fundUse')) {
    where.push('fu.id = ?');
    args.push(Number(q.fundUse));
  }
  if (has('from')) {
    where.push('t.date >= ?');
    args.push(q.from!);
  }
  if (has('to')) {
    where.push('t.date <= ?');
    args.push(q.to!);
  }
  if (has('counterparty')) {
    where.push('t.counterparty LIKE ?');
    args.push(`%${q.counterparty}%`);
  }
  if (has('q')) {
    where.push('t.summary LIKE ?');
    args.push(`%${q.q}%`);
  }
  if (has('status')) {
    where.push('t.status = ?');
    args.push(q.status!);
  }
  if (!skip.has('category') && q.category === '__none__') where.push('t.category IS NULL');
  else if (has('category')) {
    where.push('t.category = ?');
    args.push(q.category!);
  }
  return { whereSql: where.length ? ` WHERE ${where.join(' AND ')}` : '', args };
}

function andWhere(whereSql: string, extra: string): string {
  return whereSql ? `${whereSql} AND ${extra}` : ` WHERE ${extra}`;
}

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

/** 把这份流水的本方账号改成已登记的募资专户。只改文件上的银行、账号、户名，不动每一笔交易。 */
filesRouter.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT id FROM files WHERE id = ?').get(id) as { id: number } | undefined;
  if (!existing) return res.status(404).json({ error: '文件不存在' });
  const b = (req.body ?? {}) as { bank?: string; accountNo?: string; accountName?: string };
  const accountNo = String(b.accountNo ?? '').replace(/[\s\u3000\-]/g, '').toUpperCase();
  if (!accountNo) return res.status(400).json({ error: '账号不能为空' });
  const bank = String(b.bank ?? '').trim() || null;
  const accountName = String(b.accountName ?? '').trim() || null;
  db.prepare('UPDATE files SET bank = ?, account_no = ?, account_name = ?, updated_at = ? WHERE id = ?').run(
    bank,
    accountNo,
    accountName,
    new Date().toISOString(),
    id,
  );
  res.json({ ok: true, bank, accountNo, accountName });
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

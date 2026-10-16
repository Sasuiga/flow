import { Router } from 'express';
import { db } from './db.js';
import { dirExists, friendlyFsError, openFolder, resolveEntityLocation, scanPdfFiles } from './fsutil.js';
import { toProjectView } from './clients.js';
import { refreshTaskFilesAuto } from './parse.js';
import { categoryFocus } from './categoryFocus.js';
import { dedicatedBalances } from './reports.js';
import { cashLots } from './cashLots.js';
import { getCashMandate, saveCashMandate } from './cashMandate.js';
import { getFlow, runFlow } from './flow.js';
import { syncTaskWatchers } from './watch.js';
import { BankFile, ClientBrief, CreateEntityInput, FlowTask, FundUse, FundUseKind, normAccountNo, ParseStep, ProjectAccount, ProjectBrief, TaskView } from '@flow/shared';

const now = () => new Date().toISOString();

function taskCounts(taskId: number) {
  const fileCount = (db.prepare('SELECT COUNT(*) AS c FROM files WHERE task_id = ?').get(taskId) as { c: number }).c;
  const txCount = (
    db.prepare('SELECT COALESCE(SUM(tx_count), 0) AS c FROM files WHERE task_id = ?').get(taskId) as { c: number }
  ).c;
  return { fileCount, txCount };
}

export function toTaskView(row: Record<string, unknown>): TaskView {
  const id = Number(row.id);
  return {
    id,
    projectId: Number(row.project_id),
    name: row.name as string,
    folderPath: row.folder_path as string,
    status: row.status as FlowTask['status'],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    dirMissing: !dirExists(row.folder_path as string),
    ...taskCounts(id),
  };
}

function parseProgress(raw: unknown): ParseStep[] | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  try {
    const v = JSON.parse(raw) as ParseStep[];
    return Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

function toBankFile(row: Record<string, unknown>): BankFile {
  return {
    id: Number(row.id),
    taskId: Number(row.task_id),
    relPath: row.rel_path as string,
    bank: (row.bank as string | undefined) ?? undefined,
    accountNo: (row.account_no as string | undefined) ?? undefined,
    accountName: (row.account_name as string | undefined) ?? undefined,
    periodStart: (row.period_start as string | undefined) ?? undefined,
    periodEnd: (row.period_end as string | undefined) ?? undefined,
    status: row.status as BankFile['status'],
    txCount: Number(row.tx_count),
    error: (row.error as string | undefined) ?? undefined,
    progress: parseProgress(row.progress),
    updatedAt: row.updated_at as string,
  };
}

/** 扫描任务目录 PDF，登记新文件（幂等），返回新增数量 */
function refreshTaskFiles(taskId: number, folderPath: string): number {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO files(task_id, rel_path, status, updated_at) VALUES(?, ?, 'scanned', ?)`,
  );
  let added = 0;
  for (const rel of scanPdfFiles(folderPath)) {
    const r = ins.run(taskId, rel, now());
    if (r.changes > 0) added++;
  }
  return added;
}
void refreshTaskFiles;

const FUND_KINDS: FundUseKind[] = ['原始项目', '新增项目'];

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function toFundUse(r: Record<string, unknown>): FundUse {
  const kind = String(r.kind ?? '');
  const addedOn = String(r.added_on ?? '');
  const amount = r.adjusted_amount == null || r.adjusted_amount === '' ? undefined : Number(r.adjusted_amount);
  return {
    id: Number(r.id),
    projectId: Number(r.project_id),
    name: String(r.name),
    kind: FUND_KINDS.includes(kind as FundUseKind) ? (kind as FundUseKind) : undefined,
    addedOn: addedOn || undefined,
    adjustedAmount: amount != null && Number.isFinite(amount) ? amount : undefined,
  };
}

function readFundUseBody(
  body: unknown,
): { name: string; kind: FundUseKind; addedOn: string; adjustedAmount: number } | { error: string } {
  const b = (body ?? {}) as { name?: unknown; kind?: unknown; addedOn?: unknown; adjustedAmount?: unknown };
  const name = String(b.name ?? '').trim();
  if (!name) return { error: '请填写募投项目名称' };
  const kind = String(b.kind ?? '');
  if (!FUND_KINDS.includes(kind as FundUseKind)) return { error: '请选择项目性质' };
  const addedOn = String(b.addedOn ?? '').trim();
  if (kind === '新增项目') {
    if (!isIsoDate(addedOn)) return { error: '请填写新增时间' };
  } else if (addedOn) {
    return { error: '原始项目不用填写新增时间' };
  }
  const adjustedAmount = Number(b.adjustedAmount);
  if (!Number.isFinite(adjustedAmount) || adjustedAmount <= 0) return { error: '请填写调整后投资总额' };
  return { name, kind: kind as FundUseKind, addedOn: kind === '新增项目' ? addedOn : '', adjustedAmount };
}

function listFundUses(projectId: number): FundUse[] {
  return (
    db.prepare('SELECT * FROM fund_uses WHERE project_id = ? ORDER BY name').all(projectId) as Record<string, unknown>[]
  ).map(toFundUse);
}

function toProjectAccount(r: Record<string, unknown>): ProjectAccount {
  return {
    id: Number(r.id),
    holder: String(r.holder ?? ''),
    bank: String(r.bank ?? ''),
    accountNo: String(r.account_no),
    fundUseId: r.fund_use_id == null ? undefined : Number(r.fund_use_id),
    fundUse: (r.fund_use_name as string | null) || undefined,
    openedOn: String(r.opened_on ?? '') || undefined,
  };
}

function listProjectAccounts(projectId: number): ProjectAccount[] {
  return (
    db
      .prepare(
        `SELECT fua.*, fu.name AS fund_use_name
         FROM fund_use_accounts fua
         LEFT JOIN fund_uses fu ON fu.id = fua.fund_use_id
         WHERE fua.project_id = ?
         ORDER BY fua.bank, fua.account_no`,
      )
      .all(projectId) as Record<string, unknown>[]
  ).map(toProjectAccount);
}

function resolveFundUseId(projectId: number, raw: unknown): number | null | { error: string } {
  if (raw == null || raw === '') return null;
  const id = Number(raw);
  if (!Number.isFinite(id)) return { error: '募投项目不存在' };
  const use = db.prepare('SELECT id FROM fund_uses WHERE id = ? AND project_id = ?').get(id, projectId);
  if (!use) return { error: '募投项目不存在' };
  return id;
}

function readAccountBody(
  body: unknown,
): { holder: string; bank: string; accountNo: string; openedOn: string; key: string } | { error: string } {
  const b = (body ?? {}) as { holder?: string; bank?: string; accountNo?: string; openedOn?: string };
  const holder = String(b.holder ?? '').trim();
  const bank = String(b.bank ?? '').trim();
  const accountNo = String(b.accountNo ?? '').trim();
  const openedOn = String(b.openedOn ?? '').trim();
  if (!holder || !bank || !accountNo) return { error: '请填写账户主体、开户行和账号' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(openedOn)) return { error: '请填写开户时间' };
  const [y, m, d] = openedOn.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return { error: '请填写开户时间' };
  }
  const key = normAccountNo(accountNo);
  if (!key) return { error: '请填写账户主体、开户行和账号' };
  return { holder, bank, accountNo, openedOn, key };
}

export const projectsRouter = Router();

projectsRouter.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: '项目不存在' });
  const tasks = (
    db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC').all(id) as Record<string, unknown>[]
  ).map(toTaskView);
  const clientRow = db.prepare('SELECT id, name FROM clients WHERE id = ?').get(row.client_id) as
    | { id: number; name: string }
    | undefined;
  const client: ClientBrief = clientRow
    ? { id: Number(clientRow.id), name: clientRow.name }
    : { id: Number(row.client_id), name: '未知客户' };
  res.json({ project: toProjectView(row), client, tasks, fundUses: listFundUses(id), accounts: listProjectAccounts(id) });
});

projectsRouter.post('/:id/uses', (req, res) => {
  const projectId = Number(req.params.id);
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) return res.status(404).json({ error: '项目不存在' });
  const parsed = readFundUseBody(req.body);
  if ('error' in parsed) return res.status(400).json({ error: parsed.error });
  try {
    const r = db
      .prepare(
        `INSERT INTO fund_uses(project_id, name, kind, added_on, adjusted_amount, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?)`,
      )
      .run(projectId, parsed.name, parsed.kind, parsed.addedOn, parsed.adjustedAmount, now(), now());
    const saved = db.prepare('SELECT * FROM fund_uses WHERE id = ?').get(Number(r.lastInsertRowid)) as Record<string, unknown>;
    res.json(toFundUse(saved));
  } catch {
    res.status(409).json({ error: '已有同名募投项目' });
  }
});

projectsRouter.patch('/:id/uses/:useId', (req, res) => {
  const projectId = Number(req.params.id);
  const useId = Number(req.params.useId);
  const name = String((req.body as { name?: string })?.name ?? '').trim();
  if (!name) return res.status(400).json({ error: '请填写募投项目名称' });
  const row = db.prepare('SELECT id FROM fund_uses WHERE id = ? AND project_id = ?').get(useId, projectId);
  if (!row) return res.status(404).json({ error: '募投项目不存在' });
  try {
    db.prepare('UPDATE fund_uses SET name = ?, updated_at = ? WHERE id = ?').run(name, now(), useId);
    const saved = db.prepare('SELECT * FROM fund_uses WHERE id = ?').get(useId) as Record<string, unknown>;
    res.json(toFundUse(saved));
  } catch {
    res.status(409).json({ error: '已有同名募投项目' });
  }
});

projectsRouter.delete('/:id/uses/:useId', (req, res) => {
  const projectId = Number(req.params.id);
  const useId = Number(req.params.useId);
  const r = db.prepare('DELETE FROM fund_uses WHERE id = ? AND project_id = ?').run(useId, projectId);
  if (r.changes === 0) return res.status(404).json({ error: '募投项目不存在' });
  res.json({ ok: true });
});

projectsRouter.post('/:id/accounts', (req, res) => {
  const projectId = Number(req.params.id);
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) return res.status(404).json({ error: '项目不存在' });
  const parsed = readAccountBody(req.body);
  if ('error' in parsed) return res.status(400).json({ error: parsed.error });
  const fundUseId = resolveFundUseId(projectId, (req.body as { fundUseId?: unknown })?.fundUseId);
  if (typeof fundUseId === 'object' && fundUseId) return res.status(400).json({ error: fundUseId.error });
  const taken = db
    .prepare('SELECT id FROM fund_use_accounts WHERE project_id = ? AND account_key = ?')
    .get(projectId, parsed.key);
  if (taken) return res.status(409).json({ error: '已有这个账号' });
  try {
    const r = db
      .prepare(
        `INSERT INTO fund_use_accounts(project_id, holder, bank, account_no, account_key, opened_on, fund_use_id, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
      )
      .run(projectId, parsed.holder, parsed.bank, parsed.accountNo, parsed.key, parsed.openedOn, fundUseId, now(), now());
    const row = db
      .prepare(
        `SELECT fua.*, fu.name AS fund_use_name FROM fund_use_accounts fua
         LEFT JOIN fund_uses fu ON fu.id = fua.fund_use_id WHERE fua.id = ?`,
      )
      .get(Number(r.lastInsertRowid)) as Record<string, unknown>;
    res.json(toProjectAccount(row));
  } catch {
    res.status(409).json({ error: '已有这个账号' });
  }
});

projectsRouter.patch('/:id/accounts/:accountId', (req, res) => {
  const projectId = Number(req.params.id);
  const accountId = Number(req.params.accountId);
  const existing = db
    .prepare('SELECT id FROM fund_use_accounts WHERE id = ? AND project_id = ?')
    .get(accountId, projectId);
  if (!existing) return res.status(404).json({ error: '募资专户不存在' });
  const parsed = readAccountBody(req.body);
  if ('error' in parsed) return res.status(400).json({ error: parsed.error });
  const fundUseId = resolveFundUseId(projectId, (req.body as { fundUseId?: unknown })?.fundUseId);
  if (typeof fundUseId === 'object' && fundUseId) return res.status(400).json({ error: fundUseId.error });
  const taken = db
    .prepare('SELECT id FROM fund_use_accounts WHERE project_id = ? AND account_key = ? AND id != ?')
    .get(projectId, parsed.key, accountId);
  if (taken) return res.status(409).json({ error: '已有这个账号' });
  try {
    db.prepare(
      `UPDATE fund_use_accounts
       SET holder = ?, bank = ?, account_no = ?, account_key = ?, opened_on = ?, fund_use_id = ?, updated_at = ?
       WHERE id = ?`,
    ).run(parsed.holder, parsed.bank, parsed.accountNo, parsed.key, parsed.openedOn, fundUseId, now(), accountId);
  } catch {
    return res.status(409).json({ error: '已有这个账号' });
  }
  const row = db
    .prepare(
      `SELECT fua.*, fu.name AS fund_use_name FROM fund_use_accounts fua
       LEFT JOIN fund_uses fu ON fu.id = fua.fund_use_id WHERE fua.id = ?`,
    )
    .get(accountId) as Record<string, unknown>;
  res.json(toProjectAccount(row));
});

projectsRouter.delete('/:id/accounts/:accountId', (req, res) => {
  const r = db
    .prepare('DELETE FROM fund_use_accounts WHERE id = ? AND project_id = ?')
    .run(Number(req.params.accountId), Number(req.params.id));
  if (r.changes === 0) return res.status(404).json({ error: '募资专户不存在' });
  res.json({ ok: true });
});

projectsRouter.put('/:id/accounts', (req, res) => {
  const projectId = Number(req.params.id);
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) return res.status(404).json({ error: '项目不存在' });
  const body = (req.body ?? {}) as { accountNo?: string; fundUseId?: number | null | '' };
  const key = normAccountNo(body.accountNo);
  if (!key) return res.status(400).json({ error: '缺少账号' });
  const fundUseId = body.fundUseId == null || body.fundUseId === '' ? null : Number(body.fundUseId);
  if (fundUseId != null && !Number.isFinite(fundUseId)) return res.status(400).json({ error: '募投项目不存在' });
  if (fundUseId != null) {
    const use = db.prepare('SELECT id FROM fund_uses WHERE id = ? AND project_id = ?').get(fundUseId, projectId);
    if (!use) return res.status(400).json({ error: '募投项目不存在' });
  }
  const row = db
    .prepare('SELECT id FROM fund_use_accounts WHERE project_id = ? AND account_key = ?')
    .get(projectId, key) as { id: number } | undefined;
  if (!row) return res.status(404).json({ error: '请先新建募资专户' });
  db.prepare('UPDATE fund_use_accounts SET fund_use_id = ?, updated_at = ? WHERE id = ?').run(fundUseId, now(), row.id);
  res.json({ ok: true });
});

/** 在项目下新建报告期任务（目录默认创建在项目目录内） */
projectsRouter.post('/:id/tasks', (req, res) => {
  const projectRow = db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(req.params.id)) as
    | Record<string, unknown>
    | undefined;
  if (!projectRow) return res.status(404).json({ error: '项目不存在' });
  const body = req.body as CreateEntityInput;
  const name = (body?.name ?? '').trim();
  if (!name || !body?.location) return res.status(400).json({ error: 'name 与 location 必填' });
  try {
    const folderPath = resolveEntityLocation(body.location, name, 'task');
    const r = db
      .prepare(
        'INSERT INTO tasks(project_id, name, folder_path, status, created_at, updated_at) VALUES(?,?,?,?,?,?)',
      )
      .run(Number(projectRow.id), name, folderPath, 'active', now(), now());
    const taskId = Number(r.lastInsertRowid);
    refreshTaskFilesAuto(taskId, folderPath); // M2：目录里已有 PDF 自动登记 + 解析
    void syncTaskWatchers(); // M2：chokidar 监听新任务目录
    res.json(toTaskView(db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown>));
  } catch (e) {
    res.status(409).json({ error: friendlyFsError(e).message });
  }
});

projectsRouter.post('/:id/open', (req, res) => {
  const row = db.prepare('SELECT folder_path FROM projects WHERE id = ?').get(Number(req.params.id)) as
    | { folder_path: string }
    | undefined;
  if (!row) return res.status(404).json({ error: '项目不存在' });
  res.json({ ok: openFolder(row.folder_path) });
});

projectsRouter.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  void syncTaskWatchers(); // 任务级联删除 → 释放监听
  res.json({ ok: true });
});

/* ---------- 任务路由（挂在 /api/tasks 下，由 main.ts 单独 mount） ---------- */

export const tasksRouter = Router();

tasksRouter.get('/:id/flow', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: '任务不存在' });
  res.json(getFlow(id));
});

tasksRouter.get('/:id/dedicated-balances', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: '任务不存在' });
  const rows = dedicatedBalances(id);
  if (!rows) return res.status(404).json({ error: '任务不存在' });
  res.json({ rows });
});

tasksRouter.get('/:id/cash-lots', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: '任务不存在' });
  const report = cashLots(id);
  if (!report) return res.status(404).json({ error: '任务不存在' });
  res.json(report);
});

tasksRouter.get('/:id/cash-mandate', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: '任务不存在' });
  const mandate = getCashMandate(id);
  if (!mandate) return res.status(404).json({ error: '任务不存在' });
  res.json(mandate);
});

tasksRouter.put('/:id/cash-mandate', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: '任务不存在' });
  const saved = saveCashMandate(id, (req.body ?? {}) as { opening?: unknown; openingAsOf?: unknown; boards?: unknown });
  if ('error' in saved) return res.status(400).json({ error: saved.error });
  res.json(saved.mandate);
});

tasksRouter.get('/:id/category-focus', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || !db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(id)) {
    return res.status(404).json({ error: '任务不存在' });
  }
  res.json(categoryFocus(id));
});

tasksRouter.post('/:id/flow', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: '任务不存在' });
  const force = Boolean((req.body as { force?: boolean } | undefined)?.force);
  void runFlow(id, force)
    .then((out) => res.json(out))
    .catch((e: Error) => res.status(500).json({ error: e.message || '分析失败' }));
});

tasksRouter.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: '任务不存在' });
  const projectRow = db.prepare('SELECT * FROM projects WHERE id = ?').get(row.project_id) as Record<string, unknown> | undefined;
  const clientRow = projectRow
    ? (db.prepare('SELECT id, name FROM clients WHERE id = ?').get(projectRow.client_id) as { id: number; name: string } | undefined)
    : undefined;
  const files = (
    db.prepare('SELECT * FROM files WHERE task_id = ? ORDER BY rel_path').all(id) as Record<string, unknown>[]
  ).map(toBankFile);
  const project: ProjectBrief = projectRow
    ? { id: Number(projectRow.id), name: projectRow.name as string, taskCount: 0 }
    : { id: Number(row.project_id), name: '未知项目', taskCount: 0 };
  const client: ClientBrief = clientRow ? { id: Number(clientRow.id), name: clientRow.name } : { id: 0, name: '未知客户' };
  res.json({
    task: toTaskView(row),
    project,
    client,
    files,
    accounts: listProjectAccounts(Number(row.project_id)),
  });
});

/** 重新扫描任务目录 PDF（放入新文件后调用，幂等；M2 起新文件自动入解析队列） */
tasksRouter.post('/:id/refresh', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: '任务不存在' });
  const added = refreshTaskFilesAuto(id, row.folder_path as string);
  db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now(), id);
  res.json({ ok: true, added });
});

tasksRouter.post('/:id/open', (req, res) => {
  const row = db.prepare('SELECT folder_path FROM tasks WHERE id = ?').get(Number(req.params.id)) as
    | { folder_path: string }
    | undefined;
  if (!row) return res.status(404).json({ error: '任务不存在' });
  res.json({ ok: openFolder(row.folder_path) });
});

tasksRouter.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  void syncTaskWatchers();
  res.json({ ok: true });
});

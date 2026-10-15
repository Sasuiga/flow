import { Router } from 'express';
import { db } from './db.js';
import { dirExists, friendlyFsError, openFolder, resolveEntityLocation, scanPdfFiles } from './fsutil.js';
import { toProjectView } from './clients.js';
import { refreshTaskFilesAuto } from './parse.js';
import { syncTaskWatchers } from './watch.js';
import { BankFile, ClientBrief, CreateEntityInput, FlowTask, ParseStep, ProjectBrief, TaskView } from '@flow/shared';

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
  res.json({ project: toProjectView(row), client, tasks });
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
  res.json({ task: toTaskView(row), project, client, files });
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

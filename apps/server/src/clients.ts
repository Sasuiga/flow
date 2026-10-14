import { Router } from 'express';
import { db } from './db.js';
import {
  dirExists,
  friendlyFsError,
  openFolder,
  resolveEntityLocation,
} from './fsutil.js';
import { syncTaskWatchers } from './watch.js';
import {
  Client,
  ClientView,
  CreateEntityInput,
  Project,
  ProjectView,
} from '@flow/shared';

const now = () => new Date().toISOString();

function clientCounts(clientId: number) {
  const projectCount = (
    db.prepare('SELECT COUNT(*) AS c FROM projects WHERE client_id = ?').get(clientId) as { c: number }
  ).c;
  const taskCount = (
    db.prepare(
      'SELECT COUNT(*) AS c FROM tasks WHERE project_id IN (SELECT id FROM projects WHERE client_id = ?)',
    ).get(clientId) as { c: number }
  ).c;
  const txCount = (
    db.prepare(
      'SELECT COALESCE(SUM(tx_count), 0) AS c FROM files WHERE task_id IN (SELECT id FROM tasks WHERE project_id IN (SELECT id FROM projects WHERE client_id = ?))',
    ).get(clientId) as { c: number }
  ).c;
  return { projectCount, taskCount, txCount };
}

export function toClientView(row: Record<string, unknown>): ClientView {
  const id = Number(row.id);
  return {
    id,
    name: row.name as string,
    folderPath: row.folder_path as string,
    status: row.status as ClientView['status'],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    dirMissing: !dirExists(row.folder_path as string),
    ...clientCounts(id),
  };
}

export function toProjectView(row: Record<string, unknown>): ProjectView {
  const id = Number(row.id);
  const taskCount = (db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE project_id = ?').get(id) as { c: number }).c;
  const fileCount = (
    db.prepare(
      'SELECT COUNT(*) AS c FROM files WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)',
    ).get(id) as { c: number }
  ).c;
  const txCount = (
    db.prepare(
      'SELECT COALESCE(SUM(tx_count), 0) AS c FROM files WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)',
    ).get(id) as { c: number }
  ).c;
  return {
    id,
    clientId: Number(row.client_id),
    name: row.name as string,
    folderPath: row.folder_path as string,
    status: row.status as ProjectView['status'],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    dirMissing: !dirExists(row.folder_path as string),
    taskCount,
    fileCount,
    txCount,
  };
}

export function getProjectRow(id: number): Record<string, unknown> | null {
  return (db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown> | undefined) ?? null;
}

export const clientsRouter = Router();

clientsRouter.get('/', (_req, res) => {
  const rows = db.prepare('SELECT * FROM clients ORDER BY updated_at DESC').all() as Record<string, unknown>[];
  res.json(rows.map(toClientView));
});

clientsRouter.post('/', (req, res) => {
  const body = req.body as CreateEntityInput;
  const name = (body?.name ?? '').trim();
  if (!name || !body?.location) return res.status(400).json({ error: 'name 与 location 必填' });
  try {
    const folderPath = resolveEntityLocation(body.location, name, 'client');
    const r = db
      .prepare('INSERT INTO clients(name, folder_path, status, created_at, updated_at) VALUES(?,?,?,?,?)')
      .run(name, folderPath, 'active', now(), now());
    const client: Client = {
      id: Number(r.lastInsertRowid),
      name,
      folderPath,
      status: 'active',
      createdAt: now(),
      updatedAt: now(),
    };
    res.json(client);
  } catch (e) {
    res.status(409).json({ error: friendlyFsError(e).message });
  }
});

clientsRouter.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM clients WHERE id = ?').get(Number(req.params.id)) as
    | Record<string, unknown>
    | undefined;
  if (!row) return res.status(404).json({ error: '客户不存在' });
  const projects = (
    db.prepare('SELECT * FROM projects WHERE client_id = ? ORDER BY created_at DESC').all(row.id) as Record<string, unknown>[]
  ).map(toProjectView);
  res.json({ client: toClientView(row), projects });
});

/** 在客户下新建融资项目（目录默认创建在客户目录内） */
clientsRouter.post('/:id/projects', (req, res) => {
  const clientRow = db.prepare('SELECT * FROM clients WHERE id = ?').get(Number(req.params.id)) as
    | Record<string, unknown>
    | undefined;
  if (!clientRow) return res.status(404).json({ error: '客户不存在' });
  const body = req.body as CreateEntityInput;
  const name = (body?.name ?? '').trim();
  if (!name || !body?.location) return res.status(400).json({ error: 'name 与 location 必填' });
  try {
    const folderPath = resolveEntityLocation(body.location, name, 'project');
    const r = db
      .prepare(
        'INSERT INTO projects(client_id, name, folder_path, status, created_at, updated_at) VALUES(?,?,?,?,?,?)',
      )
      .run(Number(clientRow.id), name, folderPath, 'active', now(), now());
    res.json(toProjectView(getProjectRow(Number(r.lastInsertRowid)) as Record<string, unknown>));
  } catch (e) {
    res.status(409).json({ error: friendlyFsError(e).message });
  }
});

clientsRouter.post('/:id/open', (req, res) => {
  const row = db.prepare('SELECT folder_path FROM clients WHERE id = ?').get(Number(req.params.id)) as
    | { folder_path: string }
    | undefined;
  if (!row) return res.status(404).json({ error: '客户不存在' });
  res.json({ ok: openFolder(row.folder_path) });
});

clientsRouter.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM projects WHERE client_id = ?').run(req.params.id); // 刷新项目列表排序
  db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
  void syncTaskWatchers(); // 其下任务级联删除 → 释放监听
  res.json({ ok: true });
});

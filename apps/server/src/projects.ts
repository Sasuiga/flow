import { Router } from 'express';
import path from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import { db } from './db.js';
import { Project } from '@flow/shared';

export const projectsRouter = Router();

const now = () => new Date().toISOString();

/** 扫描项目文件夹下的 PDF（递归），登记新文件，返回新增数量 */
function scanProjectFiles(p: Project): number {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO files(project_id, rel_path, status, updated_at) VALUES(?, ?, 'scanned', ?)`,
  );
  let added = 0;
  try {
    const walk = (dir: string, prefix: string): void => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        const rel = prefix ? `${prefix}/${name}` : name;
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) walk(full, rel);
        else if (/\.pdf$/i.test(name)) {
          const r = ins.run(p.id, rel, now());
          if (r.changes > 0) added++;
        }
      }
    };
    walk(p.folderPath, '');
  } catch {
    /* 文件夹尚不存在等情况，稍后再扫 */
  }
  return added;
}

/** 获取项目并刷新文件清单（幂等） */
export function refreshProject(id: number): Project {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as Project;
  if (!p) throw new Error('project not found');
  const added = scanProjectFiles(p);
  db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now(), id);
  return { ...p, updatedAt: now(), ...( { added } as object) } as Project;
}

projectsRouter.get('/', (_req, res) => {
  const projects = db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as unknown as Project[];
  const stats = db
    .prepare('SELECT project_id, COUNT(*) AS c, COALESCE(SUM(tx_count), 0) AS tx FROM files GROUP BY project_id')
    .all() as { project_id: number; c: number; tx: number }[];
  const map = new Map(stats.map((r) => [r.project_id, r]));
  res.json(
    projects.map((p) => ({
      ...p,
      fileCount: map.get(p.id)?.c ?? 0,
      txCount: map.get(p.id)?.tx ?? 0,
    })),
  );
});

projectsRouter.post('/', (req, res) => {
  const { name, folderPath } = req.body as { name?: string; folderPath?: string };
  if (!name || !folderPath) return res.status(400).json({ error: 'name 与 folderPath 必填' });
  try {
    const r = db
      .prepare('INSERT INTO projects(name, folder_path, created_at, updated_at) VALUES(?,?,?,?)')
      .run(name, folderPath, now(), now());
    const p = { id: Number(r.lastInsertRowid), name, folderPath, createdAt: now(), updatedAt: now() } as Project;
    const added = scanProjectFiles(p);
    res.json({ ...p, added });
  } catch (e) {
    res.status(409).json({ error: (e as Error).message });
  }
});

projectsRouter.post('/:id/refresh', (req, res) => {
  try {
    const p = refreshProject(Number(req.params.id));
    const added = (p as unknown as { added?: number }).added ?? 0;
    res.json({ ok: true, added });
  } catch (e) {
    res.status(404).json({ error: (e as Error).message });
  }
});

projectsRouter.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

projectsRouter.get('/:id/files', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM files WHERE project_id = ? ORDER BY updated_at DESC')
    .all(req.params.id) as Record<string, unknown>[];
  res.json(rows);
});

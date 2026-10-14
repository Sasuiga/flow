/**
 * 任务目录监听（M2）：chokidar 递归监听各任务目录，
 * 新 PDF 自动登记 + 自动解析；已解析文件被删除时清理登记。
 */
import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { db } from './db.js';
import { enqueueNewFile, refreshTaskFilesAuto } from './parse.js';
import { FLOW_DIR, OUTPUT_DIR } from './fsutil.js';

const watchers = new Map<number, { dir: string; w: FSWatcher }>();

/** 任务目录内的相对路径是否要处理（PDF + 跳过 .flow / flow-output） */
function relOf(dir: string, full: string): string | null {
  const rel = path.relative(dir, full).split(path.sep).join('/');
  if (!rel || rel.startsWith('../')) return null;
  if (!rel.toLowerCase().endsWith('.pdf')) return null;
  if (rel.startsWith(`${FLOW_DIR}/`) || rel.startsWith(`${OUTPUT_DIR}/`)) return null;
  return rel;
}

async function ensureWatcher(taskId: number, dir: string): Promise<void> {
  const old = watchers.get(taskId);
  if (old && old.dir === dir) return;
  if (old) await old.w.close().catch(() => undefined);
  const w = watch(dir, { ignoreInitial: true, persistent: true, followSymlinks: false });
  w.on('add', (p) => {
    const rel = relOf(dir, p);
    if (!rel) return;
    if (enqueueNewFile(taskId, rel)) {
      console.log(`[watch] task#${taskId} 新 PDF 已登记并自动解析：${rel}`);
    }
  });
  w.on('unlink', (p) => {
    const rel = relOf(dir, p);
    if (!rel) return;
    // 未解析（scanned 且无交易）→ 清登记；已解析 → 数据保留（用户可删登记）
    const r = db
      .prepare(`SELECT id, tx_count FROM files WHERE task_id = ? AND rel_path = ?`)
      .get(taskId, rel) as { id: number; tx_count: number } | undefined;
    if (r && r.tx_count === 0) {
      db.prepare('DELETE FROM files WHERE id = ?').run(r.id);
      console.log(`[watch] task#${taskId} PDF 已移除且未解析，清登记：${rel}`);
    }
  });
  w.on('error', (e) => console.warn(`[watch] task#${taskId} 监听异常：`, (e as Error).message));
  watchers.set(taskId, { dir, w });
}

/** 与 tasks 表对齐：新任务加监听、删任务去监听、目录变化换监听。任务新建/删除/启动时调用 */
export async function syncTaskWatchers(): Promise<void> {
  const rows = (db.prepare('SELECT id, folder_path FROM tasks').all() as Array<{ id: number; folder_path: string }>).map(
    (r) => ({ id: r.id, dir: r.folder_path }),
  );
  const ids = new Set(rows.map((r) => r.id));
  for (const [id] of watchers) {
    if (!ids.has(id)) {
      const old = watchers.get(id)!;
      await old.w.close().catch(() => undefined);
      watchers.delete(id);
    }
  }
  for (const { id, dir } of rows) await ensureWatcher(id, dir);
}

/** 服务启动：对齐监听 + 补扫（chokidar 只追增量，启动时目录里已有 PDF 要登记一次） */
export async function initWatchers(): Promise<void> {
  await syncTaskWatchers();
  const tasks = db.prepare('SELECT id, folder_path FROM tasks').all() as Array<{ id: number; folder_path: string }>;
  for (const t of tasks) refreshTaskFilesAuto(t.id, t.folder_path);
}

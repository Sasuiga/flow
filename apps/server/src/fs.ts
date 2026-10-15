import { Router } from 'express';
import { readdirSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { FLOW_DIR, OUTPUT_DIR, friendlyFsError, fsRoot, isWindowsDriveRoot, listWindowsDrives } from './fsutil.js';
import { FS_DRIVES_PATH, FsListing, FsMkdirInput } from '@flow/shared';

/** 目录浏览器 API（对齐 Avalon fs:doc-root / fs:list / fs:create-dir 语义） */
export const fsRouter = Router();

fsRouter.get('/root', (_req, res) => {
  res.json({ root: fsRoot(), canListDrives: process.platform === 'win32' });
});

fsRouter.get('/list', (req, res) => {
  const raw = String(req.query.path ?? '').trim() || fsRoot();
  if (raw === FS_DRIVES_PATH || raw === '此电脑') {
    const listing: FsListing = { path: FS_DRIVES_PATH, parent: null, entries: listWindowsDrives() };
    return res.json(listing);
  }
  // `D:` 没有斜杠时 path.resolve 会粘上当前工作目录，先收成盘符根
  const normalized = process.platform === 'win32' && /^[A-Za-z]:$/.test(raw) ? `${raw[0].toUpperCase()}:\\` : raw;
  const p = path.resolve(normalized);
  let names;
  try {
    names = readdirSync(p, { withFileTypes: true });
  } catch (e) {
    return res.status(400).json({ error: friendlyFsError(e).message });
  }
  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, 'zh-Hans-CN');
  const entries = names
    .filter(
      (e) =>
        e.isDirectory() &&
        e.name !== FLOW_DIR &&
        e.name !== OUTPUT_DIR &&
        !e.name.startsWith('.'),
    )
    .map((e) => ({ name: e.name, path: path.join(p, e.name) }))
    .sort(byName);
  const dirParent = path.dirname(p);
  const parent = isWindowsDriveRoot(p) ? FS_DRIVES_PATH : dirParent === p ? null : dirParent;
  const listing: FsListing = { path: p, parent, entries };
  res.json(listing);
});

fsRouter.post('/mkdir', (req, res) => {
  const body = req.body as FsMkdirInput;
  const name = (body?.name ?? '').trim();
  if (!name) return res.status(400).json({ error: '请填写文件夹名称' });
  if (name === '.' || name === '..' || name === FLOW_DIR) return res.status(400).json({ error: '文件夹名称无效' });
  if (!body?.parent?.trim()) return res.status(400).json({ error: '上级目录不能为空' });
  if (body.parent.trim() === FS_DRIVES_PATH || body.parent.trim() === '此电脑') {
    return res.status(400).json({ error: '请先进入一个磁盘再新建文件夹' });
  }
  try {
    const target = path.join(path.resolve(body.parent.trim()), name);
    mkdirSync(target);
    res.json({ path: target });
  } catch (e) {
    res.status(409).json({ error: friendlyFsError(e).message });
  }
});

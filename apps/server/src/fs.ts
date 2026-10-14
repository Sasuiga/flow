import { Router } from 'express';
import { readdirSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { FLOW_DIR, OUTPUT_DIR, friendlyFsError, fsRoot } from './fsutil.js';
import { FsListing, FsMkdirInput } from '@flow/shared';

/** 目录浏览器 API（对齐 Avalon fs:doc-root / fs:list / fs:create-dir 语义） */
export const fsRouter = Router();

fsRouter.get('/root', (_req, res) => {
  res.json({ root: fsRoot() });
});

fsRouter.get('/list', (req, res) => {
  const raw = String(req.query.path ?? '').trim() || fsRoot();
  const p = path.resolve(raw);
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
  const parent = path.dirname(p);
  const listing: FsListing = { path: p, parent: parent === p ? null : parent, entries };
  res.json(listing);
});

fsRouter.post('/mkdir', (req, res) => {
  const body = req.body as FsMkdirInput;
  const name = (body?.name ?? '').trim();
  if (!name) return res.status(400).json({ error: '请填写文件夹名称' });
  if (name === '.' || name === '..' || name === FLOW_DIR) return res.status(400).json({ error: '文件夹名称无效' });
  if (!body?.parent?.trim()) return res.status(400).json({ error: '上级目录不能为空' });
  try {
    const target = path.join(path.resolve(body.parent.trim()), name);
    mkdirSync(target);
    res.json({ path: target });
  } catch (e) {
    res.status(409).json({ error: friendlyFsError(e).message });
  }
});

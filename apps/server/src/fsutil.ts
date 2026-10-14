import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EntityLocation } from '@flow/shared';

/** 目录标记（对齐 Avalon 的 .avalon/project.md 模式：目录是真身，SQLite 只是索引） */
export const FLOW_DIR = '.flow';
export const OUTPUT_DIR = 'flow-output';

export type MarkerKind = 'client' | 'project' | 'task';

export function markerPath(dir: string, kind: MarkerKind): string {
  return path.join(dir, FLOW_DIR, `${kind}.json`);
}

export interface Marker {
  schema: number;
  kind: MarkerKind;
  name: string;
  createdAt: string;
}

export function readMarker(dir: string, kind: MarkerKind): Marker | null {
  try {
    const raw = readFileSync(markerPath(dir, kind), 'utf8');
    const m = JSON.parse(raw) as Marker;
    return m && typeof m.name === 'string' ? m : null;
  } catch {
    return null;
  }
}

/** 写/更新标记：缺失则建（createdAt 取当前），已存在且名称不一致则更新 name（保留 createdAt） */
export function writeMarker(dir: string, kind: MarkerKind, name: string): void {
  const existing = readMarker(dir, kind);
  const marker: Marker = {
    schema: 1,
    kind,
    name,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  mkdirSync(path.join(dir, FLOW_DIR), { recursive: true });
  writeFileSync(markerPath(dir, kind), JSON.stringify(marker, null, 2) + '\n', 'utf8');
}

/** ENOENT/EACCES/ENOTDIR/EEXIST → 友好中文（对齐 Avalon fsHandlers 文案） */
export function friendlyFsError(e: unknown): Error {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return new Error('目录不存在或已被删除');
  if (code === 'EACCES' || code === 'EPERM') return new Error('目录不可访问（权限不足）');
  if (code === 'ENOTDIR') return new Error('不是一个目录');
  if (code === 'EEXIST') return new Error('该位置已存在同名文件夹');
  if (code === 'SQLITE_CONSTRAINT') return new Error('同名记录已存在');
  return e instanceof Error ? e : new Error(String(e));
}

/** 解析实体创建位置 → 实际目录（create=在 parentPath 下建 name 目录；use=直接用已有目录），并写标记 */
export function resolveEntityLocation(location: EntityLocation, name: string, kind: MarkerKind): string {
  let dir: string;
  if (location.kind === 'create') {
    const parent = path.resolve(location.parentPath.trim());
    if (!existsSync(parent)) throw new Error(`上级目录不存在：${parent}`);
    dir = path.join(parent, name);
    mkdirSync(dir, { recursive: false }); // EEXIST → friendly
  } else {
    dir = path.resolve(location.dirPath.trim());
    if (!statSync(dir).isDirectory()) throw new Error('不是一个目录');
  }
  writeMarker(dir, kind, name);
  return dir;
}

/** 扫描目录下 PDF（递归；跳过 .flow 标记与 flow-output 输出目录），返回相对路径列表 */
export function scanPdfFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, prefix: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name === FLOW_DIR || entry.name === OUTPUT_DIR) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(d, entry.name), rel);
      else if (entry.isFile() && /\.pdf$/i.test(entry.name)) out.push(rel);
    }
  };
  try {
    walk(dir, '');
  } catch {
    /* 目录缺失等情况，返回空 */
  }
  return out;
}

/** 在资源管理器/Finder 中打开目录（Windows 本地版核心动作） */
export function openFolder(dir: string): boolean {
  try {
    const cmd =
      process.platform === 'win32'
        ? 'explorer'
        : process.platform === 'darwin'
          ? 'open'
          : 'xdg-open';
    const child = spawn(cmd, [dir], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function dirExists(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** 目录浏览器根：FLOW_DOC_ROOT（微服部署=网盘工作目录）> 用户主目录 */
export function fsRoot(): string {
  return process.env.FLOW_DOC_ROOT?.trim() || os.homedir();
}

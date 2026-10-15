import { ArrowUp, Folder, FolderPlus, HardDrive } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { FS_DRIVES_PATH, FsListing } from '@flow/shared';
import { api } from '../api';
import { Modal } from './Modal';

type DirectoryPickerProps = {
  title: string;
  lead?: string;
  /** 默认打开目录；未传时从服务端 fs root 打开 */
  initialPath?: string;
  onPick: (path: string) => void;
  onClose: () => void;
};

/**
 * Avalon Web 目录选择器的 React 化（对标 showPathPickerModal）：
 * 路径输入框（monospace，Enter 进入）+ ↑ 上级 + 新建文件夹 + 子目录列表 +「打开此目录」。
 * 目录缺失/未探测到根时退回纯输入框兜底。
 */
function shownPath(p: string): string {
  return p === FS_DRIVES_PATH ? '此电脑' : p;
}

export function DirectoryPicker({ title, lead, initialPath, onPick, onClose }: DirectoryPickerProps) {
  const [pathInput, setPathInput] = useState(initialPath ?? '');
  const [listing, setListing] = useState<FsListing | null>(null);
  const [canListDrives, setCanListDrives] = useState(false);
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [mkdirName, setMkdirName] = useState('');
  const atDrives = listing?.path === FS_DRIVES_PATH;

  const navigate = useCallback(
    async (dir: string) => {
      let target = dir.trim();
      if (target === '此电脑') target = FS_DRIVES_PATH;
      if (!target) {
        setStatus({ text: '请输入路径', error: true });
        return;
      }
      setLoading(true);
      try {
        const r = await api.fsList(target);
        setListing(r);
        setPathInput(shownPath(r.path));
        setStatus(r.path === FS_DRIVES_PATH ? { text: '选择一个盘符进入，例如 D: 或 F:' } : null);
      } catch (e) {
        setListing(null);
        setStatus({ text: `无法打开目录：${(e as Error).message}`, error: true });
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // 起始目录：调用方指定 > 服务端 root。Windows 同时记下能否列盘符。
  useEffect(() => {
    void (async () => {
      let root = initialPath;
      try {
        const info = await api.fsRoot();
        setCanListDrives(!!info.canListDrives);
        if (!root) root = info.root;
      } catch {
        if (!root) {
          setStatus({ text: '未探测到根目录，请手动输入绝对路径', error: true });
          return;
        }
      }
      if (root) await navigate(root);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createFolder() {
    const name = mkdirName.trim();
    if (!name || !listing) return;
    try {
      const r = await api.fsMkdir({ parent: listing.path, name });
      setMkdirOpen(false);
      setMkdirName('');
      await navigate(r.path); // 创建后直接进入新文件夹（Avalon 行为）
    } catch (e) {
      setStatus({ text: (e as Error).message, error: true });
    }
  }

  const confirm = () => {
    const raw = listing?.path ?? pathInput.trim();
    if (!raw || raw === FS_DRIVES_PATH || raw === '此电脑') return;
    const value = raw.replace(/\/+$/, '');
    if (!value) return;
    onPick(value);
  };

  return (
    <Modal title={title} lead={lead} onClose={onClose} width={560}>
      <div className="dir-picker">
        <input
          className="dir-picker-input"
          value={pathInput}
          spellCheck={false}
          placeholder="绝对路径，如 D:\数据 或 F:\Project（Enter 进入）"
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void navigate(pathInput);
          }}
        />
        <div className="dir-picker-toolbar">
          <button
            type="button"
            className="secondary-button"
            disabled={!listing?.parent}
            onClick={() => listing?.parent && void navigate(listing.parent)}
          >
            <ArrowUp size={13} /> 上级
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={!listing || atDrives}
            onClick={() => setMkdirOpen((v) => !v)}
          >
            <FolderPlus size={13} /> 新建文件夹
          </button>
          {canListDrives ? (
            <button type="button" className="secondary-button" onClick={() => void navigate(FS_DRIVES_PATH)}>
              <HardDrive size={13} /> 此电脑
            </button>
          ) : null}
        </div>
        {mkdirOpen ? (
          <div className="dir-picker-mkdir">
            <input
              value={mkdirName}
              placeholder="文件夹名称"
              onChange={(e) => setMkdirName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createFolder();
                if (e.key === 'Escape') setMkdirOpen(false);
              }}
            />
            <button type="button" className="primary-button" disabled={!mkdirName.trim()} onClick={() => void createFolder()}>
              创建并进入
            </button>
          </div>
        ) : null}

        {listing ? (
          listing.entries.length > 0 ? (
            <div className="dir-picker-list">
              {listing.entries.map((entry) => (
                <div key={entry.path} className="dir-picker-row" onClick={() => void navigate(entry.path)}>
                  <span className="dir-picker-row-name">
                    <Folder size={13} style={{ marginRight: 6, verticalAlign: -2, color: 'var(--ui-icon)' }} /> {entry.name}
                  </span>
                  <span className="dir-picker-row-path" title={entry.path}>
                    {entry.path}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="dir-picker-empty">当前目录没有子文件夹（可用「新建文件夹」创建一个）</div>
          )
        ) : null}

        {loading ? (
          <div className="dir-picker-status">加载中…</div>
        ) : status ? (
          <div className={`dir-picker-status${status.error ? ' error' : ''}`}>{status.text}</div>
        ) : null}

        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button" disabled={atDrives || (!listing && !pathInput.trim())} onClick={confirm}>
            打开此目录
          </button>
        </div>
      </div>
    </Modal>
  );
}

import { ArrowUp, Folder, FolderPlus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { FsListing } from '@flow/shared';
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
export function DirectoryPicker({ title, lead, initialPath, onPick, onClose }: DirectoryPickerProps) {
  const [pathInput, setPathInput] = useState(initialPath ?? '');
  const [listing, setListing] = useState<FsListing | null>(null);
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [mkdirName, setMkdirName] = useState('');

  const navigate = useCallback(
    async (dir: string) => {
      const target = dir.trim();
      if (!target) {
        setStatus({ text: '请输入路径', error: true });
        return;
      }
      setLoading(true);
      try {
        const r = await api.fsList(target);
        setListing(r);
        setPathInput(r.path);
        setStatus(null);
      } catch (e) {
        setListing(null);
        setStatus({ text: `无法打开目录：${(e as Error).message}`, error: true });
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // 起始目录：调用方指定 > 服务端 root
  useEffect(() => {
    if (initialPath) {
      void navigate(initialPath);
      return;
    }
    void (async () => {
      try {
        const r = await api.fsRoot();
        await navigate(r.root);
      } catch {
        setStatus({ text: '未探测到根目录，请手动输入绝对路径', error: true });
      }
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
    const value = (listing?.path ?? pathInput.trim()).replace(/\/+$/, '');
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
          placeholder="/绝对路径（Enter 进入，Esc 取消）"
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
            disabled={!listing}
            onClick={() => setMkdirOpen((v) => !v)}
          >
            <FolderPlus size={13} /> 新建文件夹
          </button>
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
          <button className="primary-button" disabled={!listing && !pathInput.trim()} onClick={confirm}>
            打开此目录
          </button>
        </div>
      </div>
    </Modal>
  );
}

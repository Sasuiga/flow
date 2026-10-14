import { FolderOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CreateEntityInput, EntityLocation } from '@flow/shared';
import { DirectoryPicker } from './DirectoryPicker';
import { Modal } from './Modal';

type CreateDialogProps = {
  /** 如「新建客户」「新建融资项目」「新建报告期任务」 */
  title: string;
  lead?: string;
  namePlaceholder: string;
  /** “新建目录”模式的位置：客户=工作根目录，项目=客户目录，任务=项目目录 */
  resolveParent: () => Promise<string>;
  busy?: boolean;
  error?: string;
  onClose: () => void;
  onCreate: (input: CreateEntityInput) => Promise<void>;
};

/**
 * Avalon 式创建对话框（对标 ProjectFormDialog 的 task-create-location 区）：
 * 名称 + 位置（新建目录 / 使用已有目录）+「将创建」预览。
 */
export function CreateDialog({
  title,
  lead,
  namePlaceholder,
  resolveParent,
  busy,
  error,
  onClose,
  onCreate,
}: CreateDialogProps) {
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'create' | 'use'>('create');
  const [parent, setParent] = useState('');
  const [useDir, setUseDir] = useState('');
  const [picker, setPicker] = useState<'parent' | 'use' | null>(null);

  useEffect(() => {
    void resolveParent().then(setParent).catch(() => setParent(''));
  }, [resolveParent]);

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (mode === 'create' && !parent.trim()) return;
    if (mode === 'use' && !useDir.trim()) return;
    const location: EntityLocation =
      mode === 'create'
        ? { kind: 'create', parentPath: parent.trim() }
        : { kind: 'use', dirPath: useDir.trim() };
    void onCreate({ name: trimmed, location });
  }

  const preview =
    mode === 'create' && name.trim() && parent.trim()
      ? `${parent.replace(/[\\/]+$/, '')}/${name.trim()}`
      : null;

  return (
    <Modal title={title} lead={lead} onClose={onClose} disableDismiss={busy} width={520}>
      <div className="field">
        <span className="field-label">名称</span>
        <input
          className="input"
          value={name}
          placeholder={namePlaceholder}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
      </div>

      <div className="field">
        <span className="field-label">位置</span>
        <label className={`radio-row${mode === 'create' ? ' active' : ''}`}>
          <input type="radio" name="loc-mode" checked={mode === 'create'} onChange={() => setMode('create')} />
          <span className="radio-row-label">新建目录</span>
          <span className="radio-row-hint">flow 在此位置创建文件夹并写入标记</span>
        </label>
        {mode === 'create' ? (
          <>
            <div className="path-row">
              <input
                className="input mono"
                value={parent}
                readOnly
                placeholder="点击右侧按钮选择父文件夹"
                title={parent}
              />
              <button type="button" className="secondary-button" disabled={busy} onClick={() => setPicker('parent')}>
                <FolderOpen size={14} /> 选择文件夹
              </button>
            </div>
            {preview ? (
              <p className="path-preview">
                将创建：<code>{preview}</code>
              </p>
            ) : null}
          </>
        ) : null}

        <label className={`radio-row${mode === 'use' ? ' active' : ''}`}>
          <input type="radio" name="loc-mode" checked={mode === 'use'} onChange={() => setMode('use')} />
          <span className="radio-row-label">使用已有目录</span>
          <span className="radio-row-hint">直接登记该目录（缺标记时补写）</span>
        </label>
        {mode === 'use' ? (
          <div className="path-row">
            <input
              className="input mono"
              value={useDir}
              readOnly
              placeholder="点击右侧按钮选择文件夹"
              title={useDir}
            />
            <button type="button" className="secondary-button" disabled={busy} onClick={() => setPicker('use')}>
              <FolderOpen size={14} /> 选择文件夹
            </button>
          </div>
        ) : null}
      </div>

      {error ? <div className="flow-error">{error}</div> : null}

      <div className="modal-actions">
        <button className="secondary-button" onClick={onClose} disabled={busy}>
          取消
        </button>
        <button
          className="primary-button"
          disabled={busy || !name.trim() || (mode === 'create' ? !parent.trim() : !useDir.trim())}
          onClick={submit}
        >
          创建
        </button>
      </div>

      {picker === 'parent' ? (
        <DirectoryPicker
          title="选择父文件夹"
          lead="新建目录将创建在该文件夹下"
          initialPath={parent || undefined}
          onPick={(p) => {
            setParent(p);
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      ) : null}
      {picker === 'use' ? (
        <DirectoryPicker
          title="选择文件夹"
          lead="选择要直接使用的目录（建议先创建空文件夹，再选它）"
          initialPath={parent || undefined}
          onPick={(p) => {
            setUseDir(p);
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      ) : null}
    </Modal>
  );
}

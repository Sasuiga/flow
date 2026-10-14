import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';

/**
 * Avalon 风格确认弹窗（模态 + 取消/确认，Esc 取消）。
 * 桌面版 Avalon 用 window.confirm，Web 统一走模态观感。
 */
export function confirmDialog(
  message: string,
  opts?: { title?: string; confirmLabel?: string; danger?: boolean },
): Promise<boolean> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);

  return new Promise((resolve) => {
    function finish(result: boolean): void {
      root.unmount();
      host.remove();
      resolve(result);
    }
    root.render(<ConfirmView message={message} opts={opts} onResult={finish} />);
  });
}

function ConfirmView({
  message,
  opts,
  onResult,
}: {
  message: string;
  opts?: { title?: string; confirmLabel?: string; danger?: boolean };
  onResult: (ok: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onResult(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onResult]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onResult(false)}>
      <div className="modal-dialog" style={{ width: 'min(400px, calc(100vw - 36px))' }} role="dialog" aria-modal="true">
        <h3>{opts?.title ?? '确认操作'}</h3>
        <p className="modal-lead">{message}</p>
        <div className="modal-actions">
          <button className="secondary-button" disabled={busy} onClick={() => onResult(false)}>
            取消
          </button>
          <button
            className="primary-button"
            style={opts?.danger ? { background: 'var(--ui-danger)', borderColor: 'var(--ui-danger)' } : undefined}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              onResult(true);
            }}
          >
            {opts?.confirmLabel ?? (opts?.danger ? '删除' : '确认')}
          </button>
        </div>
      </div>
    </div>
  );
}

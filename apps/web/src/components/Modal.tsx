import { useEffect, type ReactNode } from 'react';

type ModalProps = {
  title?: string;
  lead?: string;
  onClose: () => void;
  disableDismiss?: boolean;
  width?: number;
  children: ReactNode;
};

/** Avalon 模态：深蓝 38% 模糊蒙层 + 白底 12px 圆角对话框（Esc/点蒙层关闭，可禁用） */
export function Modal({ title, lead, onClose, disableDismiss = false, width, children }: ModalProps) {
  useEffect(() => {
    if (disableDismiss) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [disableDismiss, onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !disableDismiss && onClose()}>
      <div
        className="modal-dialog"
        role="dialog"
        aria-modal="true"
        style={width ? { width: `min(${width}px, calc(100vw - 36px))` } : undefined}
      >
        {title ? <h3>{title}</h3> : null}
        {lead ? <p className="modal-lead">{lead}</p> : null}
        {children}
      </div>
    </div>
  );
}

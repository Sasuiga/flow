import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type ModalProps = {
  title?: string;
  lead?: string;
  onClose: () => void;
  disableDismiss?: boolean;
  width?: number;
  children: ReactNode;
};

/**
 * Avalon 模态：深蓝 38% 模糊蒙层 + 白底 12px 圆角对话框（Esc/点蒙层关闭，可禁用）。
 *
 * 用 portal 挂到 body：弹窗套弹窗（新建对话框里再开目录选择器）时不会被外层
 * 的 overflow 裁掉；手机端也由 CSS 统一改造成全屏面板。
 */
export function Modal({ title, lead, onClose, disableDismiss = false, width, children }: ModalProps) {
  useEffect(() => {
    if (disableDismiss) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [disableDismiss, onClose]);

  return createPortal(
    <div
      className="modal-backdrop modal-backdrop-sheet"
      onMouseDown={(e) => e.target === e.currentTarget && !disableDismiss && onClose()}
    >
      <div
        className="modal-dialog modal-dialog-sheet"
        role="dialog"
        aria-modal="true"
        style={width ? ({ '--modal-w': `${width}px` } as CSSProperties) : undefined}
      >
        {title || lead ? (
          <div className="modal-head">
            {title ? <h3>{title}</h3> : null}
            {lead ? <p className="modal-lead">{lead}</p> : null}
          </div>
        ) : null}
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

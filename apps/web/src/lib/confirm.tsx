import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import type { LlmProfile } from '@flow/shared';

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

/** 解析前选择一套已保存的模型。取消返回 null。 */
export function pickLlmDialog(profiles: LlmProfile[], defaultId: string): Promise<LlmProfile | null> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);

  return new Promise((resolve) => {
    function finish(result: LlmProfile | null): void {
      root.unmount();
      host.remove();
      resolve(result);
    }
    root.render(<PickLlmView profiles={profiles} defaultId={defaultId} onResult={finish} />);
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
      <div className="modal-dialog modal-dialog-confirm" role="dialog" aria-modal="true">
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

export function parsePageSpec(text: string, total: number): number[] | string {
  const parts = text
    .split(/[,，、\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return [];
  const pages = new Set<number>();
  for (const part of parts) {
    const range = part.match(/^(\d+)\s*[-~～到至]\s*(\d+)$/);
    if (range) {
      let a = Number(range[1]);
      let b = Number(range[2]);
      if (a > b) [a, b] = [b, a];
      if (b - a >= 40) return '一次最多 40 页';
      for (let p = a; p <= b; p++) pages.add(p);
      continue;
    }
    if (/^\d+$/.test(part)) {
      pages.add(Number(part));
      continue;
    }
    return `无法识别「${part}」`;
  }
  const list = [...pages].sort((a, b) => a - b);
  if (list.length > 40) return '一次最多 40 页';
  const bad = list.filter((p) => p < 1 || p > total);
  if (bad.length) return `没有第 ${bad.join('、')} 页，这份 PDF 共 ${total} 页`;
  return list;
}

/** 选择要重读的 PDF 页。取消返回 null。 */
export function pickPagesDialog(info: {
  total: number;
  gaps: number[];
  byPage: { page: number; n: number }[];
  suggest?: number;
}): Promise<number[] | null> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  return new Promise((resolve) => {
    function finish(result: number[] | null): void {
      root.unmount();
      host.remove();
      resolve(result);
    }
    root.render(<PickPagesView info={info} onResult={finish} />);
  });
}

function PickPagesView({
  info,
  onResult,
}: {
  info: { total: number; gaps: number[]; byPage: { page: number; n: number }[]; suggest?: number };
  onResult: (pages: number[] | null) => void;
}) {
  const initial = [...info.gaps];
  if (info.suggest && info.suggest > 0 && !initial.includes(info.suggest)) initial.push(info.suggest);
  const [checked, setChecked] = useState<number[]>(initial.sort((a, b) => a - b));
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onResult(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onResult]);

  const countOf = (page: number) => info.byPage.find((p) => p.page === page)?.n ?? 0;

  function submit(): void {
    const extra = parsePageSpec(text, info.total);
    if (typeof extra === 'string') {
      setErr(extra);
      return;
    }
    const pages = [...new Set([...checked, ...extra])].sort((a, b) => a - b);
    if (pages.length === 0) {
      setErr('请勾选或填写要重读的页码');
      return;
    }
    if (pages.length > 40) {
      setErr('一次最多 40 页');
      return;
    }
    onResult(pages);
  }

  const chosenPreview = [...new Set([...checked, ...(typeof parsePageSpec(text, info.total) === 'string' ? [] : (parsePageSpec(text, info.total) as number[]))])];
  const replacing = chosenPreview.filter((p) => countOf(p) > 0);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onResult(null)}>
      <div className="modal-dialog modal-dialog-llm" role="dialog" aria-modal="true" aria-labelledby="page-pick-title">
        <h3 id="page-pick-title">解析指定页</h3>
        <p className="modal-lead">
          这份 PDF 共 {info.total} 页。点选要重读的页，读出来的交易替换进原记录，其它页不动。页码是 PDF 阅读器上的页码。笔数很少的页，常常是这一页没读全。
        </p>
        <div className="page-chip-list">
          {Array.from({ length: info.total }, (_, i) => i + 1).map((page) => {
            const n = countOf(page);
            const on = checked.includes(page);
            const thin = info.gaps.includes(page) || (n > 0 && n <= 3);
            return (
              <button
                key={page}
                type="button"
                className={`page-chip${on ? ' on' : ''}${thin ? ' thin' : ''}`}
                aria-pressed={on}
                onClick={() =>
                  setChecked((cur) => (cur.includes(page) ? cur.filter((p) => p !== page) : [...cur, page].sort((a, b) => a - b)))
                }
              >
                <span>第 {page} 页</span>
                <span>{n > 0 ? `${n} 笔` : '没有交易'}</span>
              </button>
            );
          })}
        </div>
        <label className="page-gap-field">
          <span>或直接填写</span>
          <input
            className="page-pick-input"
            value={text}
            placeholder="例如 6 或 6,8-10"
            onChange={(e) => {
              setText(e.target.value);
              setErr('');
            }}
          />
        </label>
        {replacing.length > 0 ? (
          <p className="page-gap-warn">
            第 {replacing.join('、')} 页已有交易，会被换掉，含这些页上的人工修改和关注。
          </p>
        ) : null}
        {err ? <p className="page-gap-warn">{err}</p> : null}
        <div className="modal-actions">
          <button className="secondary-button" onClick={() => onResult(null)}>
            取消
          </button>
          <button className="primary-button" onClick={submit}>
            重读这些页
          </button>
        </div>
      </div>
    </div>
  );
}

function PickLlmView({
  profiles,
  defaultId,
  onResult,
}: {
  profiles: LlmProfile[];
  defaultId: string;
  onResult: (picked: LlmProfile | null) => void;
}) {
  const initial = profiles.some((p) => p.id === defaultId) ? defaultId : profiles[0]?.id ?? '';
  const [picked, setPicked] = useState(initial);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onResult(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onResult]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onResult(null)}>
      <div className="modal-dialog modal-dialog-llm" role="dialog" aria-modal="true" aria-labelledby="llm-pick-title">
        <h3 id="llm-pick-title">用哪个模型解析</h3>
        <p className="modal-lead">选一套已保存的模型。这次解析，以及解析完的自动分类，都用它。</p>
        <div className="llm-pick-list" role="radiogroup" aria-labelledby="llm-pick-title">
          {profiles.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={picked === p.id}
              className={`llm-pick-item${picked === p.id ? ' on' : ''}`}
              onClick={() => setPicked(p.id)}
            >
              <span>
                <span className="llm-pick-name">
                  {p.name}
                  {p.id === defaultId ? <span className="llm-pick-tag">默认</span> : null}
                </span>
                <span className="llm-pick-meta">
                  {p.model} · {p.base}
                </span>
              </span>
            </button>
          ))}
        </div>
        <div className="modal-actions">
          <button className="secondary-button" onClick={() => onResult(null)}>
            取消
          </button>
          <button
            className="primary-button"
            disabled={!picked}
            onClick={() => onResult(profiles.find((p) => p.id === picked) ?? null)}
          >
            用这个解析
          </button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { TxRow } from '@flow/shared';
import { api } from '../api';
import { formatMoney } from '../lib/format';

type Draft = {
  date: string;
  direction: 'in' | 'out';
  amount: string;
  balance: string;
  summary: string;
  counterparty: string;
  category: string;
};

function draftOf(r: TxRow): Draft {
  return {
    date: r.date ?? '',
    direction: r.direction,
    amount: String(r.amount),
    balance: r.balance == null ? '' : String(r.balance),
    summary: r.summary ?? '',
    counterparty: r.counterparty ?? '',
    category: r.category ?? '',
  };
}

/**
 * 修正队列（M3）：待复核行按流水顺序展开。
 * 交易数字保持识别原文或人工填写的值；余额复算只更新复核提示。
 */
export default function ReviewQueue({ taskId }: { taskId?: number }) {
  const [rows, setRows] = useState<TxRow[]>([]);
  const [catSet, setCatSet] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  /** 分类下拉被动过才随保存写库，不碰就不动（避免把 LLM 分类清掉） */
  const [catTouched, setCatTouched] = useState(false);

  async function load() {
    const r = await api.reviewQueue(taskId);
    setRows(r.rows);
  }

  useEffect(() => {
    void load().catch((e) => setError((e as Error).message));
    // taskId 变化时重载
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  useEffect(() => {
    void api
      .getCategories()
      .then((r) => setCatSet(r.categories))
      .catch(() => undefined);
  }, []);

  function open(r: TxRow) {
    setEditing(r.id);
    setDraft(draftOf(r));
    setCatTouched(false);
    setNotice(undefined);
    setError(undefined);
  }

  async function save(id: number) {
    if (!draft) return;
    const amount = Number(draft.amount.replace(/,/g, ''));
    const balance = draft.balance.trim() === '' ? null : Number(draft.balance.replace(/,/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('金额需为大于 0 的数字');
      return;
    }
    if (balance != null && !Number.isFinite(balance)) {
      setError('余额需为数字，或留空');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.patchTransaction(id, {
        date: draft.date,
        summary: draft.summary,
        amount,
        direction: draft.direction,
        balance,
        counterparty: draft.counterparty,
        ...(catTouched ? { category: draft.category === '' ? null : draft.category } : {}),
      });
      setNotice(
        r.row.status === 'needs_review'
          ? `已保存。这行仍有复核提示：${r.row.reviewNote ?? ''}`
          : `已保存，并重算了该文件的复核提示（仍待复核 ${r.reviewCount} 笔）。`,
      );
      setEditing(null);
      setDraft(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page" style={{ maxWidth: 1100 }}>
      <div className="page-header" style={{ marginBottom: 12 }}>
        <div>
          <h1 style={{ fontSize: 18, marginBottom: 2 }}>修正队列</h1>
          <p>按流水原文顺序。金额和方向保持识别结果；余额对不上只写在复核提示里。改完保存后，重算该文件的提示，不改其它行的数字。</p>
        </div>
      </div>
      {error ? <div className="flow-error">{error}</div> : null}
      {notice ? <div className="flow-notice">{notice}</div> : null}
      {rows.length === 0 ? (
        <div className="flow-empty">
          <h3>没有待复核的交易</h3>
          <p>重新解析后，余额对不上或字段拿不准的行会出现在这里。已经入库的旧结果要重新解析才会按「照抄原文」重抽。</p>
        </div>
      ) : (
        <div className="review-list">
          {rows.map((r) => (
            <article key={r.id} className="review-card">
              <header className="review-card-head">
                <span className="tx-date">{r.date ?? '—'}</span>
                <span className={`tx-amount ${r.direction}`}>
                  {r.direction === 'in' ? '+' : '−'} {formatMoney(r.amount)}
                </span>
                <span className="tx-balance">余额 {r.balance == null ? '—' : formatMoney(r.balance)}</span>
                <span className="review-summary">{r.summary ?? '—'}</span>
                <span className="tx-file" title={r.fileName}>
                  {r.fileName} · 第 {r.page} 页 · 行 {r.lineNo}
                </span>
              </header>
              {r.reviewNote ? <div className="tx-detail-review">复核：{r.reviewNote}</div> : null}
              <div className="review-cat-line">
                <span className="review-cat-label">分类</span>
                <select
                  className="input review-cat-select"
                  value={r.category ?? ''}
                  onChange={(e) =>
                    void api
                      .patchTransaction(r.id, {
                        date: r.date ?? '',
                        summary: r.summary ?? '',
                        amount: r.amount,
                        direction: r.direction,
                        balance: r.balance ?? null,
                        counterparty: r.counterparty ?? '',
                        category: e.target.value === '' ? null : e.target.value,
                      })
                      .then((res) => {
                        setRows((rs) => rs.map((x) => (x.id === res.row.id ? res.row : x)));
                      })
                      .catch((err) => setError((err as Error).message))
                  }
                >
                  <option value="">未分类</option>
                  {catSet.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                  {r.category && !catSet.includes(r.category) ? <option value={r.category}>{r.category}</option> : null}
                </select>
                {r.category ? (
                  <span className="review-cat-src">{r.categorySrc === 'manual' ? '人工改判' : 'LLM 分类'}</span>
                ) : null}
              </div>
              {r.rawText ? <pre className="tx-raw">{r.rawText}</pre> : null}
              {editing === r.id && draft ? (
                <div className="review-form">
                  <input className="input" type="date" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} />
                  <select
                    className="input"
                    value={draft.direction}
                    onChange={(e) => setDraft({ ...draft, direction: e.target.value as 'in' | 'out' })}
                  >
                    <option value="out">支出</option>
                    <option value="in">收入</option>
                  </select>
                  <input className="input" value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} placeholder="金额" />
                  <input className="input" value={draft.balance} onChange={(e) => setDraft({ ...draft, balance: e.target.value })} placeholder="余额，可空" />
                  <input className="input" value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} placeholder="摘要" />
                  <input
                    className="input"
                    value={draft.counterparty}
                    onChange={(e) => setDraft({ ...draft, counterparty: e.target.value })}
                    placeholder="对手方"
                  />
                  <select
                    className="input"
                    value={draft.category}
                    title="M4 改判：保存后作为人工示例，后续同类摘要自动按这个口径"
                    onChange={(e) => {
                      setCatTouched(true);
                      setDraft({ ...draft, category: e.target.value });
                    }}
                  >
                    <option value="">未分类</option>
                    {catSet.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <button className="primary-button" disabled={busy} onClick={() => void save(r.id)}>
                    保存并复算
                  </button>
                  <button className="secondary-button" disabled={busy} onClick={() => setEditing(null)}>
                    取消
                  </button>
                </div>
              ) : (
                <button className="secondary-button" onClick={() => open(r)}>
                  修改此行
                </button>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

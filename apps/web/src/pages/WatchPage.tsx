import { Bookmark, Inbox } from 'lucide-react';
import { useEffect, useState } from 'react';
import { WatchItem, WatchVerdict } from '@flow/shared';
import { api } from '../api';
import { formatByUnit, MoneyUnit, MoneyUnitSelect } from '../lib/moneyUnit';

const VERDICT_CHIP: Record<WatchVerdict | '待处理', string> = {
  待处理: 'chip-muted',
  有问题: 'chip-danger',
  无问题: 'chip-success',
  已处理: 'chip-primary',
};

/**
 * 关注页：只列交易页仍标记着的流水。
 * 每条下面是一条可保存、再编辑的备忘。判定无问题会取消关注，这条不再显示。
 */
export default function WatchPage({ taskId }: { taskId?: number; taskName?: string }) {
  const [items, setItems] = useState<WatchItem[]>([]);
  const [unit, setUnit] = useState<MoneyUnit>('yuan');
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [mode, setMode] = useState<Record<number, 'edit' | 'view'>>({});
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState<string | undefined>();

  async function load() {
    const r = await api.watchList(taskId);
    setItems(r.items);
  }

  useEffect(() => {
    if (taskId == null) {
      setItems([]);
      return;
    }
    setError(undefined);
    void load().catch((e) => setError((e as Error).message));
    // taskId 变化时重载
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  async function saveMemo(item: WatchItem) {
    const id = item.tx.id;
    const text = (drafts[id] ?? '').trim();
    if (busy) return;
    if (!text && !item.memo) return;
    setBusy(`${id}:note`);
    setError(undefined);
    try {
      await api.watchNote(id, text);
      setDrafts((d) => ({ ...d, [id]: text }));
      setMode((m) => ({ ...m, [id]: text ? 'view' : 'edit' }));
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  function startEdit(item: WatchItem) {
    const id = item.tx.id;
    setDrafts((d) => ({ ...d, [id]: item.memo }));
    setMode((m) => ({ ...m, [id]: 'edit' }));
  }

  async function chooseVerdict(id: number, verdict: WatchVerdict) {
    if (busy) return;
    setBusy(`${id}:verdict`);
    setError(undefined);
    try {
      await api.watchVerdict(id, verdict);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="page" style={{ maxWidth: 980 }}>
      <div className="page-header">
        <div>
          <h1>关注</h1>
        </div>
        <MoneyUnitSelect value={unit} onChange={setUnit} />
      </div>

      {error ? <div className="flow-error">{error}</div> : null}

      {taskId == null ? (
        <div className="flow-empty">
          <h3>先在右上角打开一个任务</h3>
          <p>关注只汇集当前任务里标记过的交易。</p>
        </div>
      ) : items.length === 0 && !error ? (
        <div className="flow-empty">
          <h3>
            <Inbox size={18} style={{ verticalAlign: '-3px', marginRight: 8 }} />
            还没有关注的交易
          </h3>
          <p>在交易页逐行审阅时，点书签标出有疑问的流水。它们会出现在这里，方便集中记录和判定。</p>
        </div>
      ) : (
        <div className="review-list">
          {items.map((item) => {
            const r = item.tx;
            const verdict = item.verdict ?? '待处理';
            return (
              <article key={r.id} className="review-card watch-card">
                <div className="review-card-head">
                  <span className={`chip ${VERDICT_CHIP[verdict]}`}>{verdict}</span>
                  <span className="tx-date">{r.date ?? '—'}</span>
                  <span className={`tx-amount ${r.direction}`}>
                    {r.direction === 'in' ? '+' : '−'} {formatByUnit(r.amount, unit)}
                  </span>
                  <span className="review-summary" title={r.summary}>
                    {r.summary || '—'}
                  </span>
                  <span title={r.counterparty}>{r.counterparty || '—'}</span>
                </div>
                <div className="watch-meta">
                  <span>
                    {r.clientName} / {r.projectName} / {r.taskName}
                  </span>
                  <span>
                    {r.bank ?? '—'}
                    {r.accountNo ? ` · ${r.accountNo.slice(-4)}` : ''}
                  </span>
                  <span>
                    {r.fileName} · 第 {r.page} 页 · 行 {r.lineNo}
                  </span>
                  {r.category ? <span>分类：{r.category}</span> : null}
                  <span className="watch-mark">
                    <Bookmark size={12} /> 交易页仍标记着
                  </span>
                </div>

                <div className="watch-actions">
                  {(['无问题', '已处理'] as WatchVerdict[]).map((v) => (
                    <button
                      key={v}
                      type="button"
                      className={`watch-verdict${item.verdict === v ? ' on' : ''}`}
                      disabled={busy === `${r.id}:verdict`}
                      onClick={() => void chooseVerdict(r.id, v)}
                    >
                      {v}
                    </button>
                  ))}
                </div>

                <div className="watch-note">
                  {(mode[r.id] ?? (item.memo ? 'view' : 'edit')) === 'edit' ? (
                    <>
                      <textarea
                        className="input"
                        rows={2}
                        maxLength={2000}
                        placeholder="记下这笔交易的情况"
                        value={drafts[r.id] ?? ''}
                        onChange={(e) => setDrafts((d) => ({ ...d, [r.id]: e.target.value }))}
                      />
                      <button
                        type="button"
                        className="primary-button"
                        disabled={(!(drafts[r.id] ?? '').trim() && !item.memo) || busy === `${r.id}:note`}
                        onClick={() => void saveMemo(item)}
                      >
                        {busy === `${r.id}:note` ? '保存中…' : '保存'}
                      </button>
                    </>
                  ) : (
                    <>
                      <p className="watch-memo">{item.memo}</p>
                      <button type="button" className="secondary-button" onClick={() => startEdit(item)}>
                        编辑
                      </button>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

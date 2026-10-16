import { Bookmark, FilterX, Inbox } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Table } from 'antd';
import { TxOptions, TxPageResult, TxQuery, TxRow } from '@flow/shared';
import { api } from '../api';
import { formatByUnit, MoneyUnit, MoneyUnitSelect } from '../lib/moneyUnit';
type TxPageProps = {
  /** 右上角当前任务。交易页只看这一份资料 */
  taskId?: number;
  /** 从某个流水文件进来时带上它的银行和账户 */
  initialBank?: string;
  initialAccountNo?: string;
};

const STATUS_CHIP: Record<string, { cls: string; label: string }> = {
  ok: { cls: 'chip-muted', label: '正常' },
  needs_review: { cls: 'chip-warning', label: '待复核' },
  fixed: { cls: 'chip-success', label: '已修正' },
};

function fmtAmount(n: number | undefined, unit: MoneyUnit): string {
  return n == null ? '—' : formatByUnit(n, unit);
}

/**
 * 交易浏览器：只看当前任务。
 * 银行和募投列出该任务的全部；账户随银行、募投收窄。
 */
export function TransactionsPage({ taskId, initialBank, initialAccountNo }: TxPageProps) {
  const [options, setOptions] = useState<TxOptions | null>(null);
  const [catSet, setCatSet] = useState<string[]>([]);
  const [query, setQuery] = useState<TxQuery>({
    taskId,
    bank: initialBank,
    accountNo: initialAccountNo,
    sort: 'stmt',
    page: 1,
    pageSize: 50,
  });
  const [data, setData] = useState<TxPageResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [unit, setUnit] = useState<MoneyUnit>('yuan');
  const [bulkCat, setBulkCat] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    if (query.taskId == null) {
      setOptions(null);
      return;
    }
    let cancelled = false;
    const facet: TxQuery = {
      taskId: query.taskId,
      fileId: query.fileId,
      bank: query.bank,
      accountNo: query.accountNo,
      from: query.from,
      to: query.to,
      counterparty: query.counterparty,
      q: query.q,
      status: query.status,
      category: query.category,
      fundUse: query.fundUse,
    };
    void api
      .txOptions(facet)
      .then((opts) => {
        if (cancelled) return;
        setOptions(opts);
        setQuery((q) => {
          const next = { ...q };
          let changed = false;
          if (q.bank && !opts.banks.includes(q.bank)) {
            next.bank = undefined;
            changed = true;
          }
          if (q.accountNo && !opts.accounts.includes(q.accountNo)) {
            next.accountNo = undefined;
            changed = true;
          }
          if (q.category && q.category !== '__none__' && !opts.categories.includes(q.category)) {
            next.category = undefined;
            changed = true;
          }
          if (q.fundUse === '__none__' && !opts.hasUnassignedFundUse) {
            next.fundUse = undefined;
            changed = true;
          } else if (q.fundUse && q.fundUse !== '__none__' && !opts.fundUses.some((u) => String(u.id) === q.fundUse)) {
            next.fundUse = undefined;
            changed = true;
          }
          return changed ? { ...next, page: 1 } : q;
        });
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [
    query.taskId,
    query.fileId,
    query.bank,
    query.accountNo,
    query.from,
    query.to,
    query.counterparty,
    query.q,
    query.status,
    query.category,
    query.fundUse,
  ]);

  useEffect(() => {
    void api
      .getCategories()
      .then((r) => setCatSet(r.categories))
      .catch(() => undefined);
  }, []);

  // 换任务，或从某个流水文件进来时，带上它的银行和账户。
  useEffect(() => {
    setSelectedIds([]);
    setQuery((q) => ({
      ...q,
      taskId,
      fileId: undefined,
      bank: initialBank,
      accountNo: initialAccountNo,
      page: 1,
    }));
  }, [taskId, initialBank, initialAccountNo]);

  useEffect(() => {
    if (query.taskId == null) {
      setData(null);
      setLoading(false);
      return;
    }
    const my = ++seq.current;
    setLoading(true);
    api
      .listTransactions(query)
      .then((r) => {
        if (seq.current === my) {
          setData(r);
          setError(undefined);
        }
      })
      .catch((e) => {
        if (seq.current === my) setError((e as Error).message);
      })
      .finally(() => {
        if (seq.current === my) setLoading(false);
      });
  }, [query, reloadKey]);

  const patch = (p: Partial<TxQuery>) => {
    setSelectedIds([]);
    setNotice(undefined);
    setQuery((q) => ({ ...q, ...p, page: 1 }));
  };

  /** 当前页勾选并入已选，其它页的勾选保留 */
  function onSelectChange(keys: Array<string | number>) {
    const pageIds = new Set((data?.rows ?? []).map((r) => r.id));
    const picked = keys.map(Number).filter((id) => pageIds.has(id));
    setSelectedIds((prev) => [...prev.filter((id) => !pageIds.has(id)), ...picked]);
  }

  /** 多选改判：写交易级 category（src=manual），之后 LLM 分类不会覆盖 */
  async function applyBulk() {
    if (selectedIds.length === 0 || !bulkCat || bulkBusy) return;
    const category = bulkCat === '__clear__' ? null : bulkCat;
    setBulkBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const res = await api.bulkCategory(selectedIds, category);
      setNotice(`已把 ${res.updated} 笔改判为${category ?? '未分类'}`);
      setSelectedIds([]);
      setBulkCat('');
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError((e as Error).message);
      setNotice(undefined);
    } finally {
      setBulkBusy(false);
    }
  }

  /** 只改关注标记。记录和判定在关注页追加，这里不碰 */
  async function toggleWatch(r: TxRow) {
    const next = !r.watched;
    try {
      const res = await api.setWatch(r.id, next);
      setData((d) =>
        d ? { ...d, rows: d.rows.map((x) => (x.id === r.id ? { ...x, watched: res.watched } : x)) } : d,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /** M4 改判：写交易级 category（src=manual），下一批 LLM 分类会自动带上这个口径 */
  async function recategorize(r: TxRow, category: string | null) {
    try {
      const res = await api.patchTransaction(r.id, {
        date: r.date ?? '',
        summary: r.summary ?? '',
        amount: r.amount,
        direction: r.direction,
        balance: r.balance ?? null,
        counterparty: r.counterparty ?? '',
        category,
      });
      setData((d) =>
        d
          ? { ...d, rows: d.rows.map((x) => (x.id === res.row.id ? res.row : x)) }
          : d,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const activeFilterCount = [
    query.bank, query.accountNo, query.fundUse, query.from, query.to,
    query.counterparty, query.status, query.category,
  ].filter((v) => v !== undefined && v !== '').length;

  return (
    <div className="tx-page">
      <div className="tx-page-inner">
      <div className="page-header" style={{ marginBottom: 12 }}>
        <div>
          <h1 style={{ fontSize: 18, marginBottom: 2 }}>交易</h1>
        </div>
        <MoneyUnitSelect value={unit} onChange={setUnit} />
      </div>

      {taskId == null ? (
        <div className="flow-empty">
          <h3>先在右上角打开一个任务</h3>
          <p>交易只显示当前任务的流水。</p>
        </div>
      ) : options ? (
        <div className="tx-filters">
          <div className="tx-filter-row primary">
            <select
              className="input filter-control"
              title={query.bank || '全部银行'}
              value={query.bank ?? ''}
              onChange={(e) => {
                const bank = e.target.value || undefined;
                patch(bank ? { bank, accountNo: undefined } : { bank: undefined });
              }}
            >
              <option value="">全部银行</option>
              {options.banks.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
            <select
              className="input filter-control"
              title={options.fundUses.find((u) => String(u.id) === query.fundUse)?.name || '全部募投'}
              value={query.fundUse ?? ''}
              onChange={(e) => {
                const fundUse = e.target.value || undefined;
                patch(fundUse ? { fundUse, accountNo: undefined } : { fundUse: undefined });
              }}
            >
              <option value="">全部募投</option>
              {options.hasUnassignedFundUse ? <option value="__none__">未归集</option> : null}
              {options.fundUses.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
            <select
              className="input filter-control"
              title={query.accountNo || '全部账户'}
              value={query.accountNo ?? ''}
              onChange={(e) => patch({ accountNo: e.target.value || undefined })}
            >
              <option value="">全部账户</option>
              {options.accounts.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <select
              className="input filter-control"
              value={query.status ?? ''}
              onChange={(e) => patch({ status: (e.target.value || undefined) as TxQuery['status'] })}
            >
              <option value="">全部状态</option>
              <option value="ok">正常</option>
              <option value="needs_review">待复核</option>
              <option value="fixed">已修正</option>
            </select>
            <select
              className="input filter-control"
              title={query.category || '全部分类'}
              value={query.category ?? ''}
              onChange={(e) => patch({ category: e.target.value || undefined })}
            >
              <option value="">全部分类</option>
              <option value="__none__">未分类</option>
              {options.categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="tx-filter-row secondary">
            <input
              type="date"
              className="input filter-control"
              value={query.from ?? ''}
              onChange={(e) => patch({ from: e.target.value || undefined })}
              title="起始日期"
            />
            <span className="filter-sep">至</span>
            <input
              type="date"
              className="input filter-control"
              value={query.to ?? ''}
              onChange={(e) => patch({ to: e.target.value || undefined })}
              title="结束日期"
            />
            <input
              className="input filter-control"
              placeholder="对手方"
              value={query.counterparty ?? ''}
              onChange={(e) => patch({ counterparty: e.target.value || undefined })}
            />
            {activeFilterCount > 0 ? (
              <button
                className="filter-reset"
                onClick={() => {
                  setSelectedIds([]);
                  setNotice(undefined);
                  setQuery({
                    taskId: query.taskId,
                    sort: query.sort,
                    page: 1,
                    pageSize: 50,
                  });
                }}
              >
                <FilterX size={13} /> 清除（{activeFilterCount}）
              </button>
            ) : (
              <span />
            )}
          </div>
        </div>
      ) : (
        <div className="flow-notice">加载过滤器选项…</div>
      )}

      {error ? <div className="flow-error">{error}</div> : null}
      {notice ? <div className="flow-notice">{notice}</div> : null}

      {data ? (
        <div className="tx-summary">
          <span>共 {data.total.toLocaleString()} 笔</span>
          <span className="tx-summary-in">流入 {data.inflow.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}</span>
          <span className="tx-summary-out">流出 {data.outflow.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}</span>
          <span className="tx-summary-page">
            第 {query.page} 页 · 每页 {query.pageSize} 笔
          </span>
        </div>
      ) : null}

      {data && data.rows.length === 0 ? (
        <div className="flow-empty">
          <h3>
            <Inbox size={18} style={{ verticalAlign: '-3px', marginRight: 8 }} />
            暂无交易
          </h3>
          <p>把流水 PDF 放进任务目录后自动解析入库；或到任务页点「重新扫描」。</p>
        </div>
      ) : null}

      <div className="tx-table">
        <Table
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={data?.rows ?? []}
          rowSelection={{
            selectedRowKeys: selectedIds,
            onChange: onSelectChange,
            columnWidth: 36,
          }}
          pagination={{
            current: query.page ?? 1,
            pageSize: query.pageSize ?? 50,
            total: data?.total ?? 0,
            showSizeChanger: false,
            hideOnSinglePage: false,
            onChange: (p) => setQuery((q) => ({ ...q, page: p })),
          }}
          expandable={{
            rowExpandable: () => true,
            expandedRowRender: (r: TxRow) => <TxDetailRow r={r} />,
          }}
          columns={[
            {
              title: '关注',
              width: 52,
              align: 'center',
              render: (_: unknown, r: TxRow) => (
                <button
                  type="button"
                  className={`tx-watch${r.watched ? ' on' : ''}`}
                  title={r.watched ? '取消关注。已记下的内容和判定会留着' : '标记关注，之后到关注页处理'}
                  onClick={() => void toggleWatch(r)}
                >
                  <Bookmark size={14} />
                </button>
              ),
            },
            {
              title: '日期',
              dataIndex: 'date',
              width: 96,
              render: (v: unknown) => <span className="tx-date">{typeof v === 'string' ? v : '—'}</span>,
            },
            {
              title: '金额',
              dataIndex: 'amount',
              width: 150,
              align: 'right',
              render: (_: unknown, r: TxRow) => (
                <span className={`tx-amount ${r.direction}`}>
                  {r.direction === 'in' ? '+' : '−'} {fmtAmount(r.amount, unit)}
                </span>
              ),
            },
            {
              title: '余额',
              dataIndex: 'balance',
              width: 118,
              align: 'right',
              render: (v: unknown) => <span className="tx-balance">{fmtAmount(typeof v === 'number' ? v : undefined, unit)}</span>,
            },
            {
              title: '摘要',
              dataIndex: 'summary',
              ellipsis: true,
              render: (v: unknown, r: TxRow) => <span title={r.rawText ?? (typeof v === 'string' ? v : undefined)}>{typeof v === 'string' ? v : '—'}</span>,
            },
            {
              title: '对手方',
              dataIndex: 'counterparty',
              width: 170,
              ellipsis: true,
              render: (v: unknown) => (typeof v === 'string' && v ? v : '—'),
            },
            {
              title: '分类',
              width: 170,
              render: (_: unknown, r: TxRow) => {
                const extra = r.category && !catSet.includes(r.category) ? [r.category] : [];
                return (
                  <div className="tx-cat">
                    <select
                      className="input tx-cat-select"
                      value={r.category ?? ''}
                      onChange={(e) => void recategorize(r, e.target.value || null)}
                    >
                      <option value="">未分类</option>
                      {catSet.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                      {extra.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                    {r.category ? (
                      <span className={`tx-cat-src${r.categorySrc === 'manual' ? ' manual' : ''}`}>
                        {r.categorySrc === 'manual' ? '人工改判' : 'LLM'}
                      </span>
                    ) : null}
                  </div>
                );
              },
            },
            {
              title: '银行 / 账户',
              width: 160,
              ellipsis: true,
              render: (_: unknown, r: TxRow) =>
                r.bank || r.accountNo ? (
                  <span className="tx-bankaccount" title={`${r.bank ?? ''} ${r.accountNo ?? ''}`}>
                    {r.bank ?? '—'} {r.accountNo ? `· ${r.accountNo.slice(-4)}` : ''}
                  </span>
                ) : (
                  '—'
                ),
            },
            {
              title: '募投项目',
              dataIndex: 'fundUse',
              width: 140,
              ellipsis: true,
              render: (v: unknown) => (typeof v === 'string' && v ? v : '—'),
            },
            {
              title: '文件',
              width: 150,
              ellipsis: true,
              render: (_: unknown, r: TxRow) => <span className="tx-file" title={r.fileName}>{r.fileName}</span>,
            },
            {
              title: '状态',
              width: 88,
              render: (_: unknown, r: TxRow) => {
                const chip = STATUS_CHIP[r.status] ?? { cls: 'chip-muted', label: r.status };
                return (
                  <span
                    className={`chip ${chip.cls}`}
                    title={r.reviewNote || (r.confidence < 0.99 ? `置信度 ${(r.confidence * 100).toFixed(0)}%` : undefined)}
                  >
                    {chip.label}
                    {r.confidence < 0.99 ? ` ${(r.confidence * 100).toFixed(0)}%` : ''}
                  </span>
                );
              },
            },
          ] as never}
        />
      </div>

      {selectedIds.length > 0 ? (
        <div className="tx-bulk">
          <span className="tx-bulk-count">已选 {selectedIds.length} 笔</span>
          <span className="tx-bulk-hint">可跨页勾选。改判后记为人工，自动分类不会覆盖。</span>
          <select
            className="input filter-control tx-bulk-select"
            value={bulkCat}
            disabled={bulkBusy}
            onChange={(e) => setBulkCat(e.target.value)}
          >
            <option value="">选择分类</option>
            <option value="__clear__">未分类</option>
            {catSet.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <button className="primary-button" disabled={!bulkCat || bulkBusy} onClick={() => void applyBulk()}>
            {bulkBusy ? '改判中…' : '改判'}
          </button>
          <button
            className="secondary-button"
            disabled={bulkBusy}
            onClick={() => {
              setSelectedIds([]);
              setBulkCat('');
            }}
          >
            取消
          </button>
        </div>
      ) : null}
      </div>
    </div>
  );
}

/** 展开行：原始文本 + 定位（页/行号）+ 上下文 */
function TxDetailRow({ r }: { r: TxRow }) {
  return (
    <div className="tx-detail">
      {r.reviewNote ? <div className="tx-detail-review">复核：{r.reviewNote}</div> : null}
      <div className="tx-detail-meta">
        <span>
          {r.clientName} / {r.projectName} / {r.taskName}
        </span>
        <span>
          {r.fileName} · 第 {r.page} 页 · 行 {r.lineNo}
        </span>
        {r.channel ? <span>渠道：{r.channel}</span> : null}
        {r.counterpartyAccount ? <span>对方账号：{r.counterpartyAccount}</span> : null}
        {r.category ? (
          <span>
            分类：{r.category}（{r.categorySrc === 'manual' ? '人工' : 'LLM'}）
          </span>
        ) : null}
      </div>
      {r.rawText ? <pre className="tx-raw">{r.rawText}</pre> : <div className="tx-raw-empty">（无原始行文本）</div>}
    </div>
  );
}

export default TransactionsPage;

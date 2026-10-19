import { Fragment, useEffect, useMemo, useState, type FocusEvent } from 'react';
import { CashLot, CashLotReport, DedicatedBalance } from '@flow/shared';
import { api } from '../api';
import { formatByUnit, MoneyUnit, MoneyUnitSelect } from '../lib/moneyUnit';

const ROLE_LABEL = { purchase: '购买', redemption: '赎回', interest: '收益' } as const;

const EMPTY_HOLDER = '\u0000';

function holderKey(lot: CashLot): string {
  return lot.holder || EMPTY_HOLDER;
}

function holderLabel(key: string): string {
  return key === EMPTY_HOLDER ? '未填主体' : key;
}

function accountKey(lot: CashLot): string {
  return `${lot.bank ?? ''}\u0001${lot.accountNo ?? ''}`;
}

function accountLabel(lot: CashLot): string {
  if (lot.bank && lot.accountNo) return `${lot.bank} · ${lot.accountNo}`;
  return lot.bank || lot.accountNo || '—';
}

function purchaseKey(lot: CashLot): string {
  if (lot.purchaseMissing) return 'missing';
  return lot.purchaseDate || 'none';
}

function purchaseLabel(key: string): string {
  if (key === 'missing') return '未在本期';
  if (key === 'none') return '无购买日期';
  return key;
}

function redemptionKey(lot: CashLot): string {
  if (lot.open) return 'open';
  if (!lot.redemptionDate) return 'none';
  return lot.redemptionDate;
}

function redemptionLabel(key: string): string {
  if (key === 'open') return '未赎回';
  if (key === 'none') return '无赎回日期';
  return key;
}

function sortKeys(keys: string[], specials: string[]): string[] {
  const lead = specials.filter((key) => keys.includes(key));
  const rest = keys.filter((key) => !specials.includes(key)).sort();
  return [...lead, ...rest];
}

function canSplit(lot: CashLot): boolean {
  return (lot.interestUnknown || lot.manualSplit) && lot.redemptionAmount != null;
}

function formatField(yuan: number, unit: MoneyUnit): string {
  if (unit === 'yuan') return yuan.toFixed(2);
  const text = (yuan / 10000).toFixed(6).replace(/\.?0+$/, '');
  return text === '' ? '0' : text;
}

function parseField(text: string, unit: MoneyUnit): number | null {
  const trimmed = text.replace(/,/g, '').trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return unit === 'yuan' ? Math.round(n * 100) / 100 : Math.round(n * 10000 * 100) / 100;
}

/**
 * 报表。只看当前任务。募集资金专户余额，以及按账户配出来的现金管理期末余额。
 */
export default function ReportPage({ taskId }: { taskId?: number; taskName?: string }) {
  const [rows, setRows] = useState<DedicatedBalance[]>([]);
  const [lots, setLots] = useState<CashLotReport | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [balanceUnit, setBalanceUnit] = useState<MoneyUnit>('yuan');
  const [lotUnit, setLotUnit] = useState<MoneyUnit>('yuan');
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, { principal: string; interest: string }>>({});
  const [splitError, setSplitError] = useState<string | undefined>();
  const [holderFilter, setHolderFilter] = useState('');
  const [accountFilter, setAccountFilter] = useState('');
  const [purchaseFilter, setPurchaseFilter] = useState('');
  const [redemptionFilter, setRedemptionFilter] = useState('');

  useEffect(() => {
    if (taskId == null) {
      setRows([]);
      setLots(null);
      setOpen(null);
      return;
    }
    let cancelled = false;
    setError(undefined);
    setSplitError(undefined);
    setHolderFilter('');
    setAccountFilter('');
    setPurchaseFilter('');
    setRedemptionFilter('');
    setOpen(null);
    void Promise.all([api.dedicatedBalances(taskId), api.cashLots(taskId)])
      .then(([balances, cash]) => {
        if (cancelled) return;
        setRows(balances.rows);
        setLots(cash);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  useEffect(() => {
    if (!lots) {
      setDraft({});
      return;
    }
    const next: Record<string, { principal: string; interest: string }> = {};
    for (const lot of lots.rows) {
      if (!canSplit(lot)) continue;
      next[lot.id] = {
        principal: lot.manualSplit && lot.purchaseAmount != null ? formatField(lot.purchaseAmount, lotUnit) : '',
        interest: lot.manualSplit && lot.interest != null ? formatField(lot.interest, lotUnit) : '',
      };
    }
    setDraft(next);
  }, [lots, lotUnit]);

  const lotRows = lots?.rows ?? [];
  const holderOptions = useMemo(
    () => [...new Set(lotRows.map(holderKey))].sort((a, b) => holderLabel(a).localeCompare(holderLabel(b), 'zh')),
    [lotRows],
  );
  const accountOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const lot of lotRows) {
      if (holderFilter && holderKey(lot) !== holderFilter) continue;
      const key = accountKey(lot);
      if (!seen.has(key)) seen.set(key, accountLabel(lot));
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1], 'zh'));
  }, [lotRows, holderFilter]);
  const purchaseOptions = useMemo(
    () =>
      sortKeys(
        [...new Set(lotRows.filter((lot) => !holderFilter || holderKey(lot) === holderFilter).filter((lot) => !accountFilter || accountKey(lot) === accountFilter).map(purchaseKey))],
        ['missing', 'none'],
      ),
    [lotRows, holderFilter, accountFilter],
  );
  const redemptionOptions = useMemo(
    () =>
      sortKeys(
        [
          ...new Set(
            lotRows
              .filter((lot) => !holderFilter || holderKey(lot) === holderFilter)
              .filter((lot) => !accountFilter || accountKey(lot) === accountFilter)
              .filter((lot) => !purchaseFilter || purchaseKey(lot) === purchaseFilter)
              .map(redemptionKey),
          ),
        ],
        ['open', 'none'],
      ),
    [lotRows, holderFilter, accountFilter, purchaseFilter],
  );
  const visibleLots = useMemo(
    () =>
      lotRows.filter((lot) => {
        if (holderFilter && holderKey(lot) !== holderFilter) return false;
        if (accountFilter && accountKey(lot) !== accountFilter) return false;
        if (purchaseFilter && purchaseKey(lot) !== purchaseFilter) return false;
        if (redemptionFilter && redemptionKey(lot) !== redemptionFilter) return false;
        return true;
      }),
    [lotRows, holderFilter, accountFilter, purchaseFilter, redemptionFilter],
  );
  const filtering = !!(holderFilter || accountFilter || purchaseFilter || redemptionFilter);

  function editSplit(lot: CashLot, field: 'principal' | 'interest', text: string) {
    const redemption = lot.redemptionAmount ?? 0;
    const yuan = parseField(text, lotUnit);
    setDraft((prev) => {
      const current = prev[lot.id] ?? { principal: '', interest: '' };
      const next = { ...current, [field]: text };
      const other = field === 'principal' ? 'interest' : 'principal';
      if (yuan == null || yuan - redemption > 0.001) next[other] = '';
      else next[other] = formatField(Math.round((redemption - yuan) * 100) / 100, lotUnit);
      return { ...prev, [lot.id]: next };
    });
  }

  async function commitSplit(lot: CashLot, principalText: string, interestText: string) {
    if (taskId == null || lot.redemptionAmount == null) return;
    const txId = lot.lines.find((line) => line.role === 'redemption')?.id;
    if (txId == null) return;
    const principalBlank = principalText.trim() === '';
    const interestBlank = interestText.trim() === '';
    if (principalBlank && interestBlank) {
      if (!lot.manualSplit) return;
      try {
        setLots(await api.saveCashSplit(taskId, txId, { principal: null, interest: null }));
        setSplitError(undefined);
      } catch (e) {
        setSplitError((e as Error).message);
      }
      return;
    }
    const principal = parseField(principalText, lotUnit);
    const interest = parseField(interestText, lotUnit);
    if (principal == null || interest == null) {
      setSplitError('本金和利息需为大于等于 0 的数字');
      return;
    }
    if (Math.abs(principal + interest - lot.redemptionAmount) > 0.02) {
      setSplitError('本金加利息需要等于赎回金额');
      return;
    }
    if (lot.manualSplit && lot.purchaseAmount === principal && lot.interest === interest) return;
    try {
      setLots(await api.saveCashSplit(taskId, txId, { principal, interest }));
      setSplitError(undefined);
    } catch (e) {
      setSplitError((e as Error).message);
    }
  }

  function onSplitBlur(lot: CashLot, event: FocusEvent<HTMLInputElement>) {
    const row = event.currentTarget.closest('tr');
    const next = event.relatedTarget;
    if (next instanceof Node && row?.contains(next)) return;
    const fields = row?.querySelectorAll('input.report-split');
    const principalText = fields?.[0] instanceof HTMLInputElement ? fields[0].value : '';
    const interestText = fields?.[1] instanceof HTMLInputElement ? fields[1].value : '';
    void commitSplit(lot, principalText, interestText);
  }

  return (
    <div className="page" style={{ maxWidth: 1360 }}>
      <div className="page-header">
        <div>
          <h1>报表</h1>
        </div>
      </div>

      {error ? <div className="flow-error">{error}</div> : null}

      {taskId == null ? (
        <div className="flow-empty">
          <h3>先在右上角打开一个任务</h3>
          <p>报表只汇总当前任务的资料。</p>
        </div>
      ) : (
        <>
          <section className="page-section">
            <div className="page-header">
              <div>
                <h1 style={{ fontSize: 18, marginBottom: 2 }}>募集资金专户余额</h1>
              </div>
              <MoneyUnitSelect value={balanceUnit} onChange={setBalanceUnit} />
            </div>
            {rows.length === 0 ? (
              <div className="flow-empty">
                <h3>还没有登记募集资金专户</h3>
                <p>在项目里登记专户后，这里会列出每个专户的最终余额。</p>
              </div>
            ) : (
              <table className="flow-sheet report-sheet">
                <thead>
                  <tr>
                    <th>账户主体</th>
                    <th>开户银行</th>
                    <th>银行账号</th>
                    <th className="report-money">余额（{balanceUnit === 'yuan' ? '元' : '万元'}）</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={`${row.bank}-${row.accountNo}`}>
                      <td>{row.holder || '—'}</td>
                      <td>{row.bank || '—'}</td>
                      <td className="report-account">{row.accountNo || '—'}</td>
                      <td className="report-money">{row.balance == null ? '—' : formatByUnit(row.balance, balanceUnit)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>合计</td>
                    <td />
                    <td />
                    <td className="report-money">
                      {rows.some((row) => row.balance != null)
                        ? formatByUnit(
                            rows.reduce((sum, row) => sum + (row.balance ?? 0), 0),
                            balanceUnit,
                          )
                        : '—'}
                    </td>
                  </tr>
                </tfoot>
              </table>
            )}
          </section>

          <section className="page-section">
            <div className="page-header">
              <div>
                <h1 style={{ fontSize: 18, marginBottom: 2 }}>现金管理期末余额</h1>
              </div>
              <MoneyUnitSelect value={lotUnit} onChange={setLotUnit} />
            </div>
            <p className="flow-note">
              同一专户内，金额相同且购买日不晚于赎回日的，按流水顺序配成一对。多笔金额和日期都相同的，换一组配对，这几列不变。赎回比还没配上的购买多出一截、而且不超过购买金额的 15% 时，多出的部分记为利息。收益单独入账、且和当天赎回笔数相同的，按顺序挂上。购买不在本期流水里的，购买日期写「未在本期」。收益没单独入账、又减不出本金的，可在购买金额和利息金额里手填，本金加利息需等于赎回金额，单位跟右上角一致。手填后按本金减期末未赎回、按利息计入合计；没填的仍按整笔赎回从余额中减掉。期末未赎回含上期购买、本期尚未赎回的金额合计。
            </p>
            {splitError ? <div className="flow-error">{splitError}</div> : null}
            {lots != null && lots.rows.length > 0 ? (
              <>
                <div className="focus-stats">
                  <div>
                    <span>期末未赎回</span>
                    <b>{formatByUnit(lots.ending, lotUnit)}</b>
                    <em>其中上期购买尚未赎回 {formatByUnit(lots.priorOpen, lotUnit)}</em>
                  </div>
                  <div>
                    <span>已分开的利息</span>
                    <b>{formatByUnit(lots.interest, lotUnit)}</b>
                  </div>
                </div>
                <div className="lot-filters">
                  <select
                    className="input filter-control"
                    value={holderFilter}
                    onChange={(e) => {
                      setHolderFilter(e.target.value);
                      setAccountFilter('');
                      setPurchaseFilter('');
                      setRedemptionFilter('');
                    }}
                  >
                    <option value="">全部账户主体</option>
                    {holderOptions.map((holder) => (
                      <option key={holder} value={holder}>
                        {holderLabel(holder)}
                      </option>
                    ))}
                  </select>
                  <select
                    className="input filter-control"
                    value={accountFilter}
                    onChange={(e) => {
                      setAccountFilter(e.target.value);
                      setPurchaseFilter('');
                      setRedemptionFilter('');
                    }}
                  >
                    <option value="">全部账户</option>
                    {accountOptions.map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <select
                    className="input filter-control"
                    value={purchaseFilter}
                    onChange={(e) => {
                      setPurchaseFilter(e.target.value);
                      setRedemptionFilter('');
                    }}
                  >
                    <option value="">全部购买日期</option>
                    {purchaseOptions.map((key) => (
                      <option key={key} value={key}>
                        {purchaseLabel(key)}
                      </option>
                    ))}
                  </select>
                  <select className="input filter-control" value={redemptionFilter} onChange={(e) => setRedemptionFilter(e.target.value)}>
                    <option value="">全部赎回日期</option>
                    {redemptionOptions.map((key) => (
                      <option key={key} value={key}>
                        {redemptionLabel(key)}
                      </option>
                    ))}
                  </select>
                  {filtering ? (
                    <button
                      className="filter-reset"
                      onClick={() => {
                        setHolderFilter('');
                        setAccountFilter('');
                        setPurchaseFilter('');
                        setRedemptionFilter('');
                      }}
                    >
                      清除
                    </button>
                  ) : null}
                </div>
                <table className="flow-sheet report-sheet">
                  <thead>
                    <tr>
                      <th>账户主体</th>
                      <th>账户</th>
                      <th>购买日期</th>
                      <th className="report-money">购买金额</th>
                      <th>赎回日期</th>
                      <th className="report-money">赎回金额</th>
                      <th className="report-money">利息金额</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleLots.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="report-muted">
                          没有符合筛选的记录
                        </td>
                      </tr>
                    ) : null}
                    {visibleLots.map((lot) => {
                      const opened = open === lot.id;
                      return (
                        <Fragment key={lot.id}>
                          <tr
                            className={`hit${opened ? ' open' : ''}${lot.open ? ' open-lot' : ''}`}
                            onClick={() => setOpen(opened ? null : lot.id)}
                          >
                            <td>{lot.holder || '—'}</td>
                            <td>
                              {lot.bank || '—'}
                              {lot.accountNo ? <span className="flow-sub report-account">{lot.accountNo}</span> : null}
                            </td>
                            <td>
                              {lot.purchaseMissing ? <span className="report-muted">未在本期</span> : lot.purchaseDate || '—'}
                              {lot.ambiguous ? <span className="flow-sub">按先买先赎</span> : null}
                            </td>
                            <td className="report-money">
                              {canSplit(lot) ? (
                                <input
                                  className="input report-split"
                                  inputMode="decimal"
                                  placeholder="本金"
                                  aria-label="本金"
                                  value={draft[lot.id]?.principal ?? ''}
                                  onChange={(e) => editSplit(lot, 'principal', e.target.value)}
                                  onMouseDown={(e) => e.stopPropagation()}
                                  onClick={(e) => e.stopPropagation()}
                                  onBlur={(e) => onSplitBlur(lot, e)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') e.currentTarget.blur();
                                  }}
                                />
                              ) : lot.purchaseAmount == null ? (
                                '—'
                              ) : (
                                formatByUnit(lot.purchaseAmount, lotUnit)
                              )}
                            </td>
                            <td>
                              {lot.open ? (
                                <span className="report-pending">未赎回</span>
                              ) : lot.interestOnly ? (
                                '—'
                              ) : (
                                lot.redemptionDate || '—'
                              )}
                              {lot.interestOnly ? <span className="flow-sub">未挂到赎回</span> : null}
                            </td>
                            <td className="report-money">
                              {lot.redemptionAmount == null ? '—' : formatByUnit(lot.redemptionAmount, lotUnit)}
                            </td>
                            <td className="report-money">
                              {canSplit(lot) ? (
                                <input
                                  className="input report-split"
                                  inputMode="decimal"
                                  placeholder="利息"
                                  aria-label="利息"
                                  value={draft[lot.id]?.interest ?? ''}
                                  onChange={(e) => editSplit(lot, 'interest', e.target.value)}
                                  onMouseDown={(e) => e.stopPropagation()}
                                  onClick={(e) => e.stopPropagation()}
                                  onBlur={(e) => onSplitBlur(lot, e)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') e.currentTarget.blur();
                                  }}
                                />
                              ) : lot.interest != null ? (
                                formatByUnit(lot.interest, lotUnit)
                              ) : (
                                '—'
                              )}
                            </td>
                          </tr>
                          {opened ? (
                            <tr className="flow-lines-row">
                              <td colSpan={7}>
                                <table className="flow-lines">
                                  <thead>
                                    <tr>
                                      <th>角色</th>
                                      <th>日期</th>
                                      <th>方向</th>
                                      <th>金额</th>
                                      <th>摘要</th>
                                      <th>对手方</th>
                                      <th>对手账号</th>
                                      <th>分类</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {lot.lines.map((line) => (
                                      <tr key={`${line.role}-${line.id}`}>
                                        <td>{ROLE_LABEL[line.role]}</td>
                                        <td>{line.date || '—'}</td>
                                        <td className={line.direction === 'in' ? 'in' : 'out'}>
                                          {line.direction === 'in' ? '收' : '支'}
                                        </td>
                                        <td>{formatByUnit(line.amount, lotUnit)}</td>
                                        <td>{line.summary || '—'}</td>
                                        <td>{line.counterparty || '—'}</td>
                                        <td>{line.counterpartyAccount || '—'}</td>
                                        <td className={line.category ? undefined : 'flow-cat-muted'}>{line.category || '未分类'}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </>
            ) : lots != null ? (
              <div className="flow-empty">
                <h3>还没有现金管理流水</h3>
                <p>把申购、赎回标成现金管理，把单独入账的收益标成现金管理投资收益后，这里会按笔列出。</p>
              </div>
            ) : null}
          </section>
        </>
      )}
    </div>
  );
}

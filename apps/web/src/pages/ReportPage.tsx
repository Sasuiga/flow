import { Fragment, useEffect, useState } from 'react';
import { CashLot, CashLotReport, DedicatedBalance } from '@flow/shared';
import { api } from '../api';
import { formatByUnit, MoneyUnit, MoneyUnitSelect } from '../lib/moneyUnit';

const ROLE_LABEL = { purchase: '购买', redemption: '赎回', interest: '收益' } as const;

function accountLabel(lot: CashLot): string {
  const tail = lot.accountNo ? lot.accountNo.slice(-4) : '';
  if (lot.bank && tail) return `${lot.bank} · ${tail}`;
  return lot.bank || tail || '—';
}

/**
 * 报表。只看当前任务。募集资金专户余额，以及按账户配出来的现金管理期末余额。
 */
export default function ReportPage({ taskId, taskName }: { taskId?: number; taskName?: string }) {
  const [rows, setRows] = useState<DedicatedBalance[]>([]);
  const [lots, setLots] = useState<CashLotReport | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [balanceUnit, setBalanceUnit] = useState<MoneyUnit>('yuan');
  const [lotUnit, setLotUnit] = useState<MoneyUnit>('yuan');
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (taskId == null) {
      setRows([]);
      setLots(null);
      setOpen(null);
      return;
    }
    let cancelled = false;
    setError(undefined);
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

  return (
    <div className="page" style={{ maxWidth: 1200 }}>
      <div className="page-header">
        <div>
          <h1>报表</h1>
          <p>{taskName ? `当前任务「${taskName}」。` : ''}募集资金专户余额取自本任务流水里日期最晚、且印有余额的那一笔。</p>
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
              同一专户内，金额相同且购买日不晚于赎回日的，按流水顺序配成一对。多笔金额和日期都相同的，换一组配对，这几列不变。赎回比还没配上的购买多出一截、而且不超过购买金额的 15% 时，多出的部分记为利息。收益单独入账、且和当天赎回笔数相同的，按顺序挂上。购买不在本期流水里的，购买日期写「未在本期」。收益没单独入账、又减不出本金的，利息写「未分开」。期末未赎回只加总本期买了、还没赎回的本金。
            </p>
            {lots != null && lots.rows.length > 0 ? (
              <>
                <div className="focus-stats">
                  <div>
                    <span>期末未赎回</span>
                    <b>{formatByUnit(lots.ending, lotUnit)}</b>
                  </div>
                  <div>
                    <span>已分开的利息</span>
                    <b>{formatByUnit(lots.interest, lotUnit)}</b>
                  </div>
                </div>
                <table className="flow-sheet report-sheet">
                  <thead>
                    <tr>
                      <th>账户</th>
                      <th>购买日期</th>
                      <th className="report-money">购买金额</th>
                      <th>赎回日期</th>
                      <th className="report-money">赎回金额</th>
                      <th className="report-money">利息金额</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lots.rows.map((lot) => {
                      const opened = open === lot.id;
                      return (
                        <Fragment key={lot.id}>
                          <tr
                            className={`hit${opened ? ' open' : ''}${lot.open ? ' open-lot' : ''}`}
                            onClick={() => setOpen(opened ? null : lot.id)}
                          >
                            <td>
                              {accountLabel(lot)}
                              {lot.fundUse ? <span className="flow-sub">{lot.fundUse}</span> : null}
                            </td>
                            <td>
                              {lot.purchaseMissing ? <span className="report-muted">未在本期</span> : lot.purchaseDate || '—'}
                              {lot.ambiguous ? <span className="flow-sub">按先买先赎</span> : null}
                            </td>
                            <td className="report-money">
                              {lot.purchaseAmount == null ? '—' : formatByUnit(lot.purchaseAmount, lotUnit)}
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
                              {lot.interest != null ? (
                                formatByUnit(lot.interest, lotUnit)
                              ) : lot.interestUnknown ? (
                                <span className="report-muted">未分开</span>
                              ) : (
                                '—'
                              )}
                            </td>
                          </tr>
                          {opened ? (
                            <tr className="flow-lines-row">
                              <td colSpan={6}>
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

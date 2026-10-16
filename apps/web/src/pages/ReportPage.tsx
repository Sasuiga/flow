import { useEffect, useState } from 'react';
import { DedicatedBalance } from '@flow/shared';
import { api } from '../api';
import { formatMoney } from '../lib/format';

type MoneyUnit = 'yuan' | 'wan';

function formatBalance(n: number, unit: MoneyUnit): string {
  if (unit === 'yuan') return formatMoney(n);
  return (n / 10000).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * 报表。只看当前任务。第一张表是募集资金专户在本任务流水里的最终余额。
 */
export default function ReportPage({ taskId, taskName }: { taskId?: number; taskName?: string }) {
  const [rows, setRows] = useState<DedicatedBalance[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [unit, setUnit] = useState<MoneyUnit>('yuan');

  useEffect(() => {
    if (taskId == null) {
      setRows([]);
      return;
    }
    let cancelled = false;
    setError(undefined);
    void api
      .dedicatedBalances(taskId)
      .then((r) => {
        if (!cancelled) setRows(r.rows);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  return (
    <div className="page" style={{ maxWidth: 1100 }}>
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
        <section className="page-section">
          <div className="page-header">
            <div>
              <h1 style={{ fontSize: 18, marginBottom: 2 }}>募集资金专户余额</h1>
            </div>
            <label className="report-unit">
              单位
              <select className="input" value={unit} onChange={(e) => setUnit(e.target.value as MoneyUnit)}>
                <option value="yuan">元</option>
                <option value="wan">万元</option>
              </select>
            </label>
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
                  <th className="report-balance">余额（{unit === 'yuan' ? '元' : '万元'}）</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.bank}-${row.accountNo}`}>
                    <td>{row.holder || '—'}</td>
                    <td>{row.bank || '—'}</td>
                    <td className="report-account">{row.accountNo || '—'}</td>
                    <td className="report-balance">{row.balance == null ? '—' : formatBalance(row.balance, unit)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>合计</td>
                  <td />
                  <td />
                  <td className="report-balance">
                    {rows.some((row) => row.balance != null)
                      ? formatBalance(
                          rows.reduce((sum, row) => sum + (row.balance ?? 0), 0),
                          unit,
                        )
                      : '—'}
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
        </section>
      )}
    </div>
  );
}

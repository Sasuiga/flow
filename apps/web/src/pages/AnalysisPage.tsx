import { Fragment, useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { FlowLine, FlowLink, FlowNode, FlowPartyLine, FlowResponse, FlowResult, TaskBrief } from '@flow/shared';
import { api } from '../api';
import { formatDateTime, formatMoney } from '../lib/format';

const COLOR: Record<FlowLink['kind'], string> = {
  dedicated: '#3d5ccc',
  own: '#c2410c',
  external: '#64748b',
  treasury: '#0f766e',
};

function compactMoney(n: number): string {
  const v = Math.abs(n);
  const trim = (x: number) => {
    const s = x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2);
    return s.replace(/\.0+$/, '').replace(/(\.\d)0$/, '$1');
  };
  if (v >= 1e8) return trim(v / 1e8) + '亿';
  if (v >= 1e4) return trim(v / 1e4) + '万';
  return formatMoney(v);
}

const KIND_LABEL: Record<FlowLink['kind'], string> = {
  dedicated: '专户间',
  own: '其他账户',
  external: '对外',
  treasury: '现金管理',
};

function netText(out: number, inn: number): string {
  const d = out - inn;
  if (Math.abs(d) < 0.005) return '相抵';
  return `${d > 0 ? '净付' : '净收'} ${formatMoney(Math.abs(d))}`;
}

function checkText(amount: number, both: number): string {
  if (amount <= 0) return '—';
  if (both >= amount - 0.01) return '双方流水';
  if (both > 0) return '部分双方';
  return '仅一方';
}

function nodeName(n?: FlowNode): string {
  if (!n) return '';
  if (n.tail) return `${n.title} ${n.tail}`;
  return n.title;
}

export default function AnalysisPage({ task }: { task: TaskBrief | null }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<FlowResponse['status'] | ''>('');
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<FlowResult | null>(null);

  const apply = (res: FlowResponse) => {
    setStatus(res.status);
    setMessage(res.message ?? '');
    setResult(res.result ?? null);
  };

  useEffect(() => {
    if (!task) return;
    let cancel = false;
    setLoading(true);
    setError('');
    setResult(null);
    void api
      .getFlow(task.id)
      .then(async (res) => {
        if (cancel) return;
        if (res.status === 'ready' && res.result?.moves) {
          apply(res);
          return;
        }
        if (res.status === 'empty') {
          apply(res);
          return;
        }
        apply(await api.runFlow(task.id, true));
      })
      .catch((e: Error) => {
        if (!cancel) setError(e.message);
      })
      .finally(() => {
        if (!cancel) setLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, [task?.id]);

  const rerun = () => {
    if (!task) return;
    setLoading(true);
    setError('');
    void api
      .runFlow(task.id, true)
      .then(apply)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  };

  return (
    <div className="page">
      <section className="page-section">
        <div className="page-header">
          <div>
            <h1 style={{ fontSize: 18, marginBottom: 2 }}>资金流向</h1>
            <p>{task ? `${task.clientName} / ${task.projectName} / ${task.name}` : '按当前任务的流水'}</p>
          </div>
          {task && result ? (
            <div className="page-header-actions">
              <button type="button" className="secondary-button" onClick={rerun} disabled={loading}>
                {loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
                重新分析
              </button>
            </div>
          ) : null}
        </div>

        {!task ? (
          <div className="flow-empty">
            <h3>先选择一个任务</h3>
          </div>
        ) : null}

        {error ? <div className="flow-error">{error}</div> : null}

        {task && loading && !result ? (
          <div className="flow-empty">
            <h3>正在结合交易时间和对手方判断资金关系</h3>
          </div>
        ) : null}

        {task && !loading && !result && message ? (
          <div className="flow-empty">
            <h3>{message}</h3>
          </div>
        ) : null}

        {result ? (
          <>
            {status === 'stale' ? <div className="flow-error">流水有变化，可以重新分析。</div> : null}
            {result.fallback ? <div className="flow-error">模型没有返回，这次只按账号和摘要归类。</div> : null}
            {result.skipped > 0 ? (
              <p className="flow-note">{result.skipped} 笔流水对不上募资专户，没有画进去。</p>
            ) : null}
            {result.moves ? <FlowTimeline result={result} /> : null}
            <p className="flow-note">生成于 {formatDateTime(result.generatedAt)} · 余额为当日最后一笔之后的余额</p>
          </>
        ) : null}
      </section>

      {result ? <FlowTables result={result} /> : null}
    </div>
  );
}

function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  let t = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(t) || Number.isNaN(end)) return [from];
  const pad = (n: number) => String(n).padStart(2, '0');
  while (t <= end && out.length < 800) {
    const d = new Date(t);
    out.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`);
    t += 86_400_000;
  }
  return out;
}

function carried(points: { date: string; balance: number }[] | undefined, day: string): number | null {
  if (!points?.length) return null;
  let last: number | null = null;
  for (const p of points) {
    if (p.date > day) break;
    last = p.balance;
  }
  return last;
}

function FlowTimeline({ result }: { result: FlowResult }) {
  const moves = result.moves ?? [];
  const days = useMemo(() => {
    const dates = [
      ...moves.map((m) => m.date),
      ...(result.balances ?? []).flatMap((b) => b.points.map((p) => p.date)),
    ].filter(Boolean).sort();
    if (dates.length === 0) return [];
    return eachDay(dates[0], dates[dates.length - 1]);
  }, [moves, result.balances]);
  const tradeAt = useMemo(() => {
    const has = new Set(moves.map((m) => m.date));
    return days.map((d, i) => (has.has(d) ? i : -1)).filter((i) => i >= 0);
  }, [moves, days]);
  const [index, setIndex] = useState(() => tradeAt[0] ?? 0);
  const day = days[Math.min(index, Math.max(days.length - 1, 0))] ?? '';
  const prevTrade = [...tradeAt].reverse().find((i) => i < index) ?? -1;
  const nextTrade = tradeAt.find((i) => i > index) ?? -1;
  const accounts = useMemo(() => {
    const weight = new Map<string, number>();
    for (const m of moves) weight.set(m.accountId, (weight.get(m.accountId) ?? 0) + m.amount);
    return result.nodes
      .filter((n) => n.role === 'dedicated')
      .sort((a, b) => (weight.get(b.id) ?? 0) - (weight.get(a.id) ?? 0));
  }, [result.nodes, moves]);
  const dayMoves = moves.filter((m) => m.date === day);
  const pick = (i: number) => setIndex(Math.max(0, Math.min(days.length - 1, i)));

  return (
    <div className="tl">
      <div className="flow-legend">
        <span><i style={{ background: COLOR.dedicated }} />专户间</span>
        <span><i style={{ background: COLOR.own }} />客户其他账户</span>
        <span><i style={{ background: COLOR.external }} />对外</span>
        <span><i style={{ background: COLOR.treasury }} />现金管理</span>
      </div>
      <div className="tl-bar">
        <button type="button" className="secondary-button" onClick={() => pick(prevTrade)} disabled={prevTrade < 0}>前一天</button>
        <div className="tl-bar-main">
          <div className="tl-date">{day || '—'}</div>
          <input
            className="tl-slider"
            type="range"
            min={0}
            max={Math.max(days.length - 1, 0)}
            value={Math.min(index, Math.max(days.length - 1, 0))}
            onChange={(e) => pick(Number(e.target.value))}
            aria-label="时间"
          />
          <div className="tl-ends">
            <span>{days[0]}</span>
            <span>{dayMoves.length === 0 ? '这一天没有进出' : `这一天 ${dayMoves.length} 笔`}</span>
            <span>{days[days.length - 1]}</span>
          </div>
        </div>
        <button type="button" className="secondary-button" onClick={() => pick(nextTrade)} disabled={nextTrade < 0}>后一天</button>
      </div>
      <div className="tl-rows">
        {accounts.map((acct) => {
          const points = result.balances?.find((b) => b.accountId === acct.id)?.points ?? [];
          const bal = carried(points, day);
          const prev = index > 0 ? carried(points, days[index - 1]) : null;
          const delta = bal != null && prev != null ? bal - prev : null;
          const mine = dayMoves.filter((m) => m.accountId === acct.id);
          const values = days.map((d) => carried(points, d));
          return (
            <div key={acct.id} className={`tl-row${mine.length ? ' active' : ''}`}>
              <div className="tl-acct">
                <b>{acct.title} {acct.tail}</b>
                <span>{acct.sub}</span>
              </div>
              <Sparkline days={days} values={values} index={Math.min(index, days.length - 1)} onPick={pick} />
              <div className="tl-bal">
                <b>{bal == null ? '—' : compactMoney(bal)}</b>
                <span>{delta == null ? '' : Math.abs(delta) < 0.005 ? '与前一日相同' : `较前一日 ${delta > 0 ? '+' : '−'}${compactMoney(Math.abs(delta))}`}</span>
              </div>
              {mine.length > 0 ? (
                <ul className="tl-moves">
                  {mine.map((m, i) => (
                    <li key={`${m.peer}-${m.direction}-${i}`}>
                      <em className={m.direction === 'in' ? 'in' : 'out'}>{m.direction === 'in' ? '收' : '支'}</em>
                      <b>{compactMoney(m.amount)}{m.count > 1 ? ` · ${m.count} 笔` : ''}</b>
                      <span className="tl-arrow">{m.direction === 'in' ? '←' : '→'}</span>
                      <span className="tl-peer">{m.peer}</span>
                      <i className={`tl-kind ${m.kind}`}>{KIND_LABEL[m.kind]}</i>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Sparkline({
  days,
  values,
  index,
  onPick,
}: {
  days: string[];
  values: (number | null)[];
  index: number;
  onPick: (i: number) => void;
}) {
  const w = 640;
  const h = 46;
  const nums = values.filter((v): v is number => v != null);
  if (nums.length === 0 || days.length === 0) return <div className="tl-spark" />;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const pad = (max - min) * 0.12 || Math.abs(max) * 0.04 || 1;
  const lo = min - pad;
  const hi = max + pad;
  const x = (i: number) => (days.length <= 1 ? w / 2 : (i / (days.length - 1)) * w);
  const y = (v: number) => 4 + (1 - (v - lo) / (hi - lo)) * (h - 8);
  let d = '';
  values.forEach((v, i) => {
    if (v == null) return;
    d += `${d ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
  });
  const px = x(Math.max(0, Math.min(index, days.length - 1)));
  return (
    <svg
      className="tl-spark"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const ratio = (e.clientX - rect.left) / rect.width;
        onPick(Math.round(ratio * (days.length - 1)));
      }}
    >
      <path d={d} fill="none" stroke="#3d5ccc" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <line x1={px} x2={px} y1={0} y2={h} stroke="#c2410c" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function FlowTables({ result }: { result: FlowResult }) {
  const [open, setOpen] = useState<string | null>(null);
  const byId = new Map(result.nodes.map((n) => [n.id, n]));
  const dedicated = result.links.filter((l) => l.kind === 'dedicated');
  const own = result.links.filter((l) => l.kind === 'own');
  return (
    <>
      {dedicated.length > 0 ? (
        <section className="page-section">
          <div className="page-header">
            <div>
              <h1 style={{ fontSize: 18, marginBottom: 2 }}>专户间划转</h1>
            </div>
          </div>
          <table className="flow-sheet">
            <thead>
              <tr>
                <th>转出</th>
                <th>转入</th>
                <th>支出</th>
                <th>收入</th>
                <th>净额</th>
                <th>核对</th>
              </tr>
            </thead>
            <tbody>
              {dedicated.map((l) => (
                <tr key={l.id}>
                  <td>{nodeName(byId.get(l.from))}</td>
                  <td>{nodeName(byId.get(l.to))}</td>
                  <td>{l.outAmount ? `${formatMoney(l.outAmount)} · ${l.outCount} 笔` : '—'}</td>
                  <td>{l.inAmount ? `${formatMoney(l.inAmount)} · ${l.inCount} 笔` : '—'}</td>
                  <td>{netText(l.outAmount, l.inAmount)}</td>
                  <td>
                    {[l.outAmount > 0 ? `支 ${checkText(l.outAmount, l.outBoth)}` : '', l.inAmount > 0 ? `收 ${checkText(l.inAmount, l.inBoth)}` : '']
                      .filter(Boolean)
                      .join(' · ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {own.length > 0 ? (
        <section className="page-section">
          <div className="page-header">
            <div>
              <h1 style={{ fontSize: 18, marginBottom: 2 }}>客户其他账户</h1>
            </div>
          </div>
          <table className="flow-sheet">
            <thead>
              <tr>
                <th>募资专户</th>
                <th>对方账户</th>
                <th>转出</th>
                <th>转入</th>
                <th>净额</th>
              </tr>
            </thead>
            <tbody>
              {own.map((l) => {
                const acct = l.from.startsWith('acct:') ? byId.get(l.from) : byId.get(l.to);
                const other = l.from.startsWith('acct:') ? byId.get(l.to) : byId.get(l.from);
                const out = l.from.startsWith('acct:') ? l.outAmount : l.inAmount;
                const inn = l.from.startsWith('acct:') ? l.inAmount : l.outAmount;
                const outN = l.from.startsWith('acct:') ? l.outCount : l.inCount;
                const inN = l.from.startsWith('acct:') ? l.inCount : l.outCount;
                const opened = open === l.id;
                const lines = [...(l.lines ?? [])].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.id - b.id);
                return (
                  <Fragment key={l.id}>
                    <tr className={`hit${opened ? ' open' : ''}`} onClick={() => setOpen(opened ? null : l.id)}>
                      <td>{nodeName(acct)}</td>
                      <td>
                        {other?.title}
                        {other?.tail ? ` · ${other.tail}` : ''}
                        {other?.sub && other.sub !== other.tail ? <span className="flow-sub">{other.sub}</span> : null}
                      </td>
                      <td>{out ? `${formatMoney(out)} · ${outN} 笔` : '—'}</td>
                      <td>{inn ? `${formatMoney(inn)} · ${inN} 笔` : '—'}</td>
                      <td>{netText(out, inn)}</td>
                    </tr>
                    {opened ? (
                      <tr className="flow-lines-row">
                        <td colSpan={5}>
                          <LineList lines={lines} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </section>
      ) : null}

      {result.externalLines.length > 0 ? (
        <section className="page-section">
          <div className="page-header">
            <div>
              <h1 style={{ fontSize: 18, marginBottom: 2 }}>对外支付</h1>
            </div>
          </div>
          <PartyTable lines={result.externalLines} showGroup />
        </section>
      ) : null}

      {result.treasuryLines.length > 0 ? (
        <section className="page-section">
          <div className="page-header">
            <div>
              <h1 style={{ fontSize: 18, marginBottom: 2 }}>现金管理</h1>
            </div>
          </div>
          <PartyTable lines={result.treasuryLines} />
        </section>
      ) : null}
    </>
  );
}

function LineList({ lines }: { lines: FlowLine[] }) {
  if (lines.length === 0) return <div className="flow-lines-empty">没有可展开的流水</div>;
  return (
    <table className="flow-lines">
      <thead>
        <tr>
          <th>日期</th>
          <th>方向</th>
          <th>金额</th>
          <th>摘要</th>
          <th>对手方</th>
          <th>对手账号</th>
          <th>余额</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line) => (
          <tr key={line.id}>
            <td>{line.date || '—'}</td>
            <td className={line.direction === 'in' ? 'in' : 'out'}>{line.direction === 'in' ? '收' : '支'}</td>
            <td>{formatMoney(line.amount)}</td>
            <td>{line.summary || '—'}</td>
            <td>{line.counterparty || '—'}</td>
            <td>{line.counterpartyAccount || '—'}</td>
            <td>{line.balance == null ? '—' : formatMoney(line.balance)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PartyTable({ lines, showGroup }: { lines: FlowPartyLine[]; showGroup?: boolean }) {
  return (
    <table className="flow-sheet">
      <thead>
        <tr>
          {lines.some((l) => l.accountTitle) ? <th>募资专户</th> : null}
          <th>对手方</th>
          <th>笔数</th>
          <th>转出</th>
          <th>转入</th>
          {showGroup ? <th>归类</th> : null}
        </tr>
      </thead>
      <tbody>
        {lines.map((l, i) => (
          <tr key={`${l.name}-${l.accountTitle ?? ''}-${i}`}>
            {lines.some((x) => x.accountTitle) ? <td>{l.accountTitle}</td> : null}
            <td>
              {l.name}
              {l.accountNo ? <span className="flow-sub">{l.accountNo}</span> : null}
            </td>
            <td>{l.count}</td>
            <td>{l.outAmount ? formatMoney(l.outAmount) : '—'}</td>
            <td>{l.inAmount ? formatMoney(l.inAmount) : '—'}</td>
            {showGroup ? <td>{l.grouped ? '归入对外转出' : '单独列出'}</td> : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

import { Fragment, useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import {
  CategoryFocus,
  FlowLine,
  FlowLink,
  FlowNode,
  FlowPartyLine,
  FlowResponse,
  FlowResult,
  TaskBrief,
} from '@flow/shared';
import { api } from '../api';
import { pickLlmDialog } from '../lib/confirm';
import { formatDateTime } from '../lib/format';
import { formatByUnit, MoneyUnit, MoneyUnitSelect, parseMoneyInput, rescaleMoneyInput } from '../lib/moneyUnit';
import CashMandatePanel from './CashMandatePanel';

const KIND_LABEL: Record<FlowLink['kind'], string> = {
  dedicated: '专户间',
  own: '其他账户',
  external: '对外',
  treasury: '现金管理',
};

function netText(out: number, inn: number, unit: MoneyUnit): string {
  const d = out - inn;
  if (Math.abs(d) < 0.005) return '相抵';
  return `${d > 0 ? '净付' : '净收'} ${formatByUnit(Math.abs(d), unit)}`;
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
  const [tab, setTab] = useState<'flow' | CategoryFocus['category']>('flow');
  const [focus, setFocus] = useState<CategoryFocus[]>([]);
  const [flowUnit, setFlowUnit] = useState<MoneyUnit>('yuan');

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
        // 需要现算时先让用户选模型，不同模型的资金关系判断可能差很多
        const settings = await api.getSettings();
        if (cancel) return;
        const profiles = (settings.llmProfiles ?? []).filter((p) => p.base?.trim() && p.model?.trim());
        if (profiles.length === 0) {
          setError('请先在设置里添加模型，并填好端点和模型名');
          return;
        }
        const picked = await pickLlmDialog(profiles, settings.defaultLlmId || profiles[0].id);
        if (cancel) return;
        if (!picked) {
          setMessage('已取消分析。点右上角「选择模型并分析」可以重来。');
          return;
        }
        apply(await api.runFlow(task.id, true, picked.id));
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

  useEffect(() => {
    if (!task) {
      setFocus([]);
      setTab('flow');
      return;
    }
    let cancel = false;
    setTab('flow');
    void api
      .categoryFocus(task.id)
      .then((r) => {
        if (!cancel) setFocus(r.views);
      })
      .catch(() => {
        if (!cancel) setFocus([]);
      });
    return () => {
      cancel = true;
    };
  }, [task?.id]);

  /** 重新分析前先选模型：不同模型的资金关系判断可能差很多 */
  const rerun = async () => {
    if (!task || loading) return;
    setError('');
    setLoading(true);
    try {
      const settings = await api.getSettings();
      const profiles = (settings.llmProfiles ?? []).filter((p) => p.base?.trim() && p.model?.trim());
      if (profiles.length === 0) {
        setError('请先在设置里添加模型，并填好端点和模型名');
        return;
      }
      const picked = await pickLlmDialog(profiles, settings.defaultLlmId || profiles[0].id);
      if (!picked) return;
      apply(await api.runFlow(task.id, true, picked.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const focusView = focus.find((v) => v.category === tab);
  return (
    <div className="page">
      {focus.length > 0 ? (
        <div className="analysis-tabs" role="tablist">
          <button type="button" className={`analysis-tab${tab === 'flow' ? ' active' : ''}`} onClick={() => setTab('flow')}>
            资金流向
          </button>
          {focus.map((v) => (
            <button
              key={v.category}
              type="button"
              className={`analysis-tab${tab === v.category ? ' active' : ''}`}
              onClick={() => setTab(v.category)}
            >
              {v.category}
              <span>{v.outCount + v.inCount}</span>
            </button>
          ))}
        </div>
      ) : null}
      {focusView ? (
        <FocusView view={focusView} taskId={task?.id} />
      ) : (
      <>
      <section className="page-section">
        <div className="page-header">
          <div>
            <h1 style={{ fontSize: 18, marginBottom: 0 }}>资金流向</h1>
          </div>
          {task ? (
            <div className="page-header-actions">
              <button type="button" className="secondary-button" onClick={() => void rerun()} disabled={loading}>
                {loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
                {result ? '重新分析' : '选择模型并分析'}
              </button>
              <MoneyUnitSelect value={flowUnit} onChange={setFlowUnit} />
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
            {result.fallback ? (
              <div className="flow-error">模型没有返回，这次只按账号和摘要归类。点「重新分析」可以换一个模型再试。</div>
            ) : null}
            {result.skipped > 0 ? (
              <p className="flow-note">{result.skipped} 笔流水对不上募资专户，没有画进去。</p>
            ) : null}
            {result.moves ? <FlowTimeline result={result} unit={flowUnit} /> : null}
            <p className="flow-note">生成于 {formatDateTime(result.generatedAt)} · 余额为当日最后一笔之后的余额</p>
          </>
        ) : null}
      </section>

      {result ? <FlowTables result={result} /> : null}
      </>
      )}
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

function FlowTimeline({ result, unit }: { result: FlowResult; unit: MoneyUnit }) {
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
                <b>{bal == null ? '—' : formatByUnit(bal, unit)}</b>
                <span>{delta == null ? '' : Math.abs(delta) < 0.005 ? '与前一日相同' : `较前一日 ${delta > 0 ? '+' : '−'}${formatByUnit(Math.abs(delta), unit)}`}</span>
              </div>
              {mine.length > 0 ? (
                <ul className="tl-moves">
                  {mine.map((m, i) => (
                    <li key={`${m.peer}-${m.direction}-${i}`}>
                      <em className={m.direction === 'in' ? 'in' : 'out'}>{m.direction === 'in' ? '收' : '支'}</em>
                      <b>{formatByUnit(m.amount, unit)}{m.count > 1 ? ` · ${m.count} 笔` : ''}</b>
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
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  function toggle(id: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const [dedicatedUnit, setDedicatedUnit] = useState<MoneyUnit>('yuan');
  const [ownUnit, setOwnUnit] = useState<MoneyUnit>('yuan');
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
            <MoneyUnitSelect value={dedicatedUnit} onChange={setDedicatedUnit} />
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
              {dedicated.map((l) => {
                const opened = open.has(l.id);
                const lines = [...(l.lines ?? [])].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.id - b.id);
                return (
                  <Fragment key={l.id}>
                    <tr className={`hit${opened ? ' open' : ''}`} onClick={() => toggle(l.id)}>
                      <td>{nodeName(byId.get(l.from))}</td>
                      <td>{nodeName(byId.get(l.to))}</td>
                      <td>{l.outAmount ? `${formatByUnit(l.outAmount, dedicatedUnit)} · ${l.outCount} 笔` : '—'}</td>
                      <td>{l.inAmount ? `${formatByUnit(l.inAmount, dedicatedUnit)} · ${l.inCount} 笔` : '—'}</td>
                      <td>{netText(l.outAmount, l.inAmount, dedicatedUnit)}</td>
                      <td>
                        {[l.outAmount > 0 ? `支 ${checkText(l.outAmount, l.outBoth)}` : '', l.inAmount > 0 ? `收 ${checkText(l.inAmount, l.inBoth)}` : '']
                          .filter(Boolean)
                          .join(' · ')}
                      </td>
                    </tr>
                    {opened ? (
                      <tr className="flow-lines-row">
                        <td colSpan={6}>
                          <LineList lines={lines} unit={dedicatedUnit} />
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

      {own.length > 0 ? (
        <section className="page-section">
          <div className="page-header">
            <div>
              <h1 style={{ fontSize: 18, marginBottom: 2 }}>客户其他账户</h1>
            </div>
            <MoneyUnitSelect value={ownUnit} onChange={setOwnUnit} />
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
                const opened = open.has(l.id);
                const lines = [...(l.lines ?? [])].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.id - b.id);
                return (
                  <Fragment key={l.id}>
                    <tr className={`hit${opened ? ' open' : ''}`} onClick={() => toggle(l.id)}>
                      <td>{nodeName(acct)}</td>
                      <td>
                        {other?.title}
                        {other?.tail ? ` · ${other.tail}` : ''}
                        {other?.sub && other.sub !== other.tail ? <span className="flow-sub">{other.sub}</span> : null}
                      </td>
                      <td>{out ? `${formatByUnit(out, ownUnit)} · ${outN} 笔` : '—'}</td>
                      <td>{inn ? `${formatByUnit(inn, ownUnit)} · ${inN} 笔` : '—'}</td>
                      <td>{netText(out, inn, ownUnit)}</td>
                    </tr>
                    {opened ? (
                      <tr className="flow-lines-row">
                        <td colSpan={5}>
                          <LineList lines={lines} unit={ownUnit} />
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

      {result.externalLines.length > 0 ? <ExternalPay result={result} /> : null}
    </>
  );
}

function ExternalPay({ result }: { result: FlowResult }) {
  const [minText, setMinText] = useState('');
  const [unit, setUnit] = useState<MoneyUnit>('yuan');
  const minYuan = parseMoneyInput(minText, unit);
  const active = minYuan != null && minYuan > 0;
  const lines = useMemo(
    () => (active && minYuan != null ? externalAtLeast(result, minYuan) : result.externalLines),
    [result, active, minYuan],
  );
  function changeUnit(next: MoneyUnit) {
    setMinText((text) => rescaleMoneyInput(text, unit, next));
    setUnit(next);
  }
  return (
    <section className="page-section">
      <div className="page-header">
        <div>
          <h1 style={{ fontSize: 18, marginBottom: 0 }}>对外支付</h1>
        </div>
        <label className="flow-min-label">
          不低于
          <input
            className="input flow-min"
            inputMode="decimal"
            value={minText}
            placeholder="金额"
            onChange={(e) => setMinText(e.target.value)}
          />
        </label>
        <MoneyUnitSelect value={unit} onChange={changeUnit} />
      </div>
      {lines.length > 0 ? (
        <PartyTable lines={lines} showGroup unit={unit} />
      ) : (
        <div className="flow-lines-empty">没有达到这个金额的交易</div>
      )}
    </section>
  );
}

function externalAtLeast(result: FlowResult, min: number): FlowPartyLine[] {
  const rows = new Map<string, FlowPartyLine>();
  for (const m of result.moves ?? []) {
    if (m.kind !== 'external' || m.count <= 0) continue;
    const unit = m.amount / m.count;
    if (unit < min) continue;
    const src = matchExternal(m.peer, result.externalLines);
    const name = src?.name ?? m.peer;
    const hit = rows.get(name) ?? {
      name,
      accountNo: src?.accountNo,
      count: 0,
      outAmount: 0,
      inAmount: 0,
    };
    hit.count += m.count;
    if (m.direction === 'out') hit.outAmount += m.amount;
    else hit.inAmount += m.amount;
    rows.set(name, hit);
  }
  return [...rows.values()]
    .map((row) => ({ ...row, grouped: row.count < 3 || row.outAmount + row.inAmount < 50_000 }))
    .sort((a, b) => b.outAmount + b.inAmount - (a.outAmount + a.inAmount));
}

function matchExternal(peer: string, lines: FlowPartyLine[]): FlowPartyLine | undefined {
  const exact = lines.find((l) => l.name === peer);
  if (exact) return exact;
  if (peer.endsWith('…')) {
    const prefix = peer.slice(0, -1);
    return lines.find((l) => l.name.startsWith(prefix));
  }
  return undefined;
}

function LineList({ lines, unit }: { lines: FlowLine[]; unit: MoneyUnit }) {
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
          <th>分类</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line) => (
          <tr key={line.id}>
            <td>{line.date || '—'}</td>
            <td className={line.direction === 'in' ? 'in' : 'out'}>{line.direction === 'in' ? '收' : '支'}</td>
            <td>{formatByUnit(line.amount, unit)}</td>
            <td>{line.summary || '—'}</td>
            <td>{line.counterparty || '—'}</td>
            <td>{line.counterpartyAccount || '—'}</td>
            <td className={line.category ? undefined : 'flow-cat-muted'}>{line.category || '未分类'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 逐笔改判（M4）：写交易级 category，整条线路批量打标后单笔仍可单独改 */
function TxCatRow({ line }: { line: FlowLine }) {
  const [cats, setCats] = useState<string[]>([]);
  const [value, setValue] = useState(line.category ?? '');
  useEffect(() => {
    void api.getCategories().then((r) => setCats(r.categories)).catch(() => undefined);
  }, []);
  const opts = cats.length ? cats : line.category ? [line.category] : [];
  if (line.category && !cats.includes(line.category)) opts.unshift(line.category);
  return (
    <tr>
      <td>{line.date || '—'}</td>
      <td className={line.direction === 'in' ? 'in' : 'out'}>{line.direction === 'in' ? '收' : '支'}</td>
      <td>{formatByUnit(line.amount, 'yuan')}</td>
      <td>{line.summary || '—'}</td>
      <td>{line.counterparty || '—'}</td>
      <td>{line.counterpartyAccount || '—'}</td>
      <td>{line.balance == null ? '—' : formatByUnit(line.balance, 'yuan')}</td>
      <td>
        <select
          className="input flow-cat-select"
          value={value}
          onChange={(e) => {
            const v = e.target.value === '' ? null : e.target.value;
            setValue(e.target.value);
            void api.bulkCategory([line.id], v).catch(() => undefined);
          }}
        >
          <option value="">未分类</option>
          {opts.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </td>
    </tr>
  );
}

function PartyTable({ lines, showGroup, unit }: { lines: FlowPartyLine[]; showGroup?: boolean; unit: MoneyUnit }) {
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
            <td>{l.outAmount ? formatByUnit(l.outAmount, unit) : '—'}</td>
            <td>{l.inAmount ? formatByUnit(l.inAmount, unit) : '—'}</td>
            {showGroup ? <td>{l.grouped ? '归入对外转出' : '单独列出'}</td> : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ownAccount(line: CategoryFocus['lines'][number]): string {
  const tail = line.accountNo ? line.accountNo.slice(-4) : '';
  if (line.bank && tail) return `${line.bank} · ${tail}`;
  return line.bank || tail || '—';
}

/** 分类专题。数字来自当前分类，打开页面即更新，不重跑资金流向。 */
function focusCopy(category: CategoryFocus['category'], netOut: number): { backLabel: string; netLabel: string; note: string } {
  if (category === '临时补流') {
    return {
      backLabel: '转回',
      netLabel: netOut > 0.005 ? '尚未归还' : netOut < -0.005 ? '转回超出' : '已轧平',
      note: '转出是补流，同一分类里的转入当作转回。转回如果没标成临时补流，不会算进尚未归还。',
    };
  }
  if (category === '实施中置换') {
    return {
      backLabel: '转入',
      netLabel: netOut > 0.005 ? '已置换' : netOut < -0.005 ? '转入超出' : '已轧平',
      note: '转出是用募集资金置换实施期间已经投入的资金。同一分类里的转入会从已置换金额里扣掉。',
    };
  }
  return {
    backLabel: '转入',
    netLabel: netOut > 0.005 ? '仍在运作' : netOut < -0.005 ? '收回超出' : '已轧平',
    note: '购买是存放或申购，赎回是到期收回。按募资专户汇总报告期内各账户的发生额。',
  };
}

function FocusView({ view, taskId }: { view: CategoryFocus; taskId?: number }) {
  const { backLabel, netLabel, note } = focusCopy(view.category, view.netOut);
  const cash = view.category === '现金管理';
  const swap = view.category === '实施中置换';
  const [summaryUnit, setSummaryUnit] = useState<MoneyUnit>('yuan');
  const [detailUnit, setDetailUnit] = useState<MoneyUnit>('yuan');
  return (
    <>
      {view.category === '现金管理' && taskId ? <CashMandatePanel taskId={taskId} lines={view.lines} /> : null}
      <section className="page-section">
        <div className="page-header">
          <div>
            <h1 style={{ fontSize: 18, marginBottom: 2 }}>{view.category}</h1>
          </div>
          <MoneyUnitSelect value={summaryUnit} onChange={setSummaryUnit} />
        </div>
        <p className="flow-note">{note}</p>
        <div className="focus-stats">
          {swap ? (
            <div>
              <span>已置换</span>
              <b>{formatByUnit(Math.max(view.netOut, 0), summaryUnit)}</b>
              <em>{view.outCount + view.inCount} 笔</em>
            </div>
          ) : (
            <>
              <div>
                <span>{cash ? '购买' : '转出'}</span>
                <b>{formatByUnit(view.outAmount, summaryUnit)}</b>
                <em>{view.outCount} 笔</em>
              </div>
              <div>
                <span>{cash ? '赎回' : backLabel}</span>
                <b>{formatByUnit(view.inAmount, summaryUnit)}</b>
                <em>{view.inCount} 笔</em>
              </div>
              {cash ? null : (
                <div>
                  <span>{netLabel}</span>
                  <b>{formatByUnit(Math.abs(view.netOut), summaryUnit)}</b>
                </div>
              )}
            </>
          )}
        </div>
        <table className="flow-sheet">
          <thead>
            <tr>
              <th>{view.category === '实施中置换' || cash ? '募资专户' : '对手方'}</th>
              <th>{cash ? '购买' : '转出'}</th>
              <th>{cash ? '赎回' : backLabel}</th>
              <th>净额</th>
              <th>起止</th>
            </tr>
          </thead>
          <tbody>
            {view.parties.map((p) => (
              <tr key={`${p.name}-${p.accountNo ?? ''}`}>
                <td>
                  {p.name}
                  {p.accountNo ? <span className="flow-sub">{p.accountNo}</span> : null}
                </td>
                <td>{p.outAmount ? `${formatByUnit(p.outAmount, summaryUnit)} · ${p.outCount} 笔` : '—'}</td>
                <td>{p.inAmount ? `${formatByUnit(p.inAmount, summaryUnit)} · ${p.inCount} 笔` : '—'}</td>
                <td>{netText(p.outAmount, p.inAmount, summaryUnit)}</td>
                <td>{p.firstDate ? (p.lastDate && p.lastDate !== p.firstDate ? `${p.firstDate} ~ ${p.lastDate}` : p.firstDate) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="page-section">
        <div className="page-header">
          <div>
            <h1 style={{ fontSize: 18, marginBottom: 2 }}>明细</h1>
          </div>
          <MoneyUnitSelect value={detailUnit} onChange={setDetailUnit} />
        </div>
        {view.category === '现金管理' ? (
          <CashDetailLines lines={view.lines} unit={detailUnit} />
        ) : (
          <FocusLines lines={view.lines} unit={detailUnit} />
        )}
      </section>
    </>
  );
}

function accountKey(line: CategoryFocus['lines'][number]): string {
  return `${line.bank ?? ''}\n${line.accountNo ?? ''}`;
}

function CashDetailLines({ lines, unit }: { lines: CategoryFocus['lines']; unit: MoneyUnit }) {
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const [holder, setHolder] = useState('');
  const [account, setAccount] = useState('');
  const [date, setDate] = useState('');
  const [direction, setDirection] = useState<'' | 'in' | 'out'>('');
  const [amount, setAmount] = useState('');
  function toggle(id: number) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const holders = useMemo(
    () => [...new Set(lines.map((line) => line.holder || '').filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh')),
    [lines],
  );
  const accounts = useMemo(() => {
    const map = new Map<string, string>();
    for (const line of lines) {
      if (holder && (line.holder || '') !== holder) continue;
      const key = accountKey(line);
      if (!map.has(key)) map.set(key, ownAccount(line));
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], 'zh'));
  }, [lines, holder]);
  const dates = useMemo(() => {
    const set = new Set<string>();
    for (const line of lines) {
      if (holder && (line.holder || '') !== holder) continue;
      if (account && accountKey(line) !== account) continue;
      if (line.date) set.add(line.date);
    }
    return [...set].sort();
  }, [lines, holder, account]);
  const amounts = useMemo(() => {
    const set = new Set<number>();
    for (const line of lines) {
      if (holder && (line.holder || '') !== holder) continue;
      if (account && accountKey(line) !== account) continue;
      if (date && (line.date || '') !== date) continue;
      if (direction && line.direction !== direction) continue;
      set.add(line.amount);
    }
    return [...set].sort((a, b) => b - a);
  }, [lines, holder, account, date, direction]);
  const shown = lines.filter((line) => {
    if (holder && (line.holder || '') !== holder) return false;
    if (account && accountKey(line) !== account) return false;
    if (date && (line.date || '') !== date) return false;
    if (direction && line.direction !== direction) return false;
    if (amount !== '' && line.amount !== Number(amount)) return false;
    return true;
  });
  const filtering = !!(holder || account || date || direction || amount);
  function clearFilters() {
    setHolder('');
    setAccount('');
    setDate('');
    setDirection('');
    setAmount('');
  }
  return (
    <>
      <div className="lot-filters">
        <select
          className="input filter-control"
          value={holder}
          onChange={(e) => {
            setHolder(e.target.value);
            setAccount('');
            setDate('');
            setAmount('');
          }}
        >
          <option value="">全部购买主体</option>
          {holders.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <select
          className="input filter-control"
          value={account}
          onChange={(e) => {
            setAccount(e.target.value);
            setDate('');
            setAmount('');
          }}
        >
          <option value="">全部购买账户</option>
          {accounts.map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <select
          className="input filter-control"
          value={date}
          onChange={(e) => {
            setDate(e.target.value);
            setAmount('');
          }}
        >
          <option value="">全部日期</option>
          {dates.map((day) => (
            <option key={day} value={day}>
              {day}
            </option>
          ))}
        </select>
        <select
          className="input filter-control"
          value={direction}
          onChange={(e) => {
            setDirection(e.target.value as '' | 'in' | 'out');
            setAmount('');
          }}
        >
          <option value="">全部方向</option>
          <option value="out">购买</option>
          <option value="in">赎回</option>
        </select>
        <select className="input filter-control" value={amount} onChange={(e) => setAmount(e.target.value)}>
          <option value="">全部金额</option>
          {amounts.map((value) => (
            <option key={value} value={String(value)}>
              {formatByUnit(value, unit)}
            </option>
          ))}
        </select>
        {filtering ? (
          <button className="filter-reset" onClick={clearFilters}>
            清除
          </button>
        ) : null}
      </div>
    <table className="flow-sheet">
      <thead>
        <tr>
          <th>购买主体</th>
          <th>购买账户</th>
          <th>日期</th>
          <th>方向</th>
          <th>金额</th>
        </tr>
      </thead>
      <tbody>
        {shown.length === 0 ? (
          <tr>
            <td colSpan={5} className="report-muted">
              没有符合筛选的记录
            </td>
          </tr>
        ) : null}
        {shown.map((line) => {
          const opened = open.has(line.id);
          const buy = line.direction === 'out';
          return (
            <Fragment key={line.id}>
              <tr className={`hit${opened ? ' open' : ''}`} onClick={() => toggle(line.id)}>
                <td>{line.holder || '—'}</td>
                <td>{ownAccount(line)}</td>
                <td>{line.date || '—'}</td>
                <td className={buy ? 'out' : 'in'}>{buy ? '购买' : '赎回'}</td>
                <td>{formatByUnit(line.amount, unit)}</td>
              </tr>
              {opened ? (
                <tr className="flow-lines-row">
                  <td colSpan={5}>
                    <table className="flow-lines">
                      <thead>
                        <tr>
                          <th>日期</th>
                          <th>方向</th>
                          <th>金额</th>
                          <th>摘要</th>
                          <th>对手方</th>
                          <th>对手账号</th>
                          <th>募投项目</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td>{line.date || '—'}</td>
                          <td className={line.direction === 'in' ? 'in' : 'out'}>{line.direction === 'in' ? '收' : '支'}</td>
                          <td>{formatByUnit(line.amount, unit)}</td>
                          <td>{line.summary || '—'}</td>
                          <td>{line.counterparty || '—'}</td>
                          <td>{line.counterpartyAccount || '—'}</td>
                          <td>{line.fundUse || '—'}</td>
                        </tr>
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
  );
}

function FocusLines({ lines, unit }: { lines: CategoryFocus['lines']; unit: MoneyUnit }) {
  return (
    <table className="flow-sheet">
      <thead>
        <tr>
          <th>日期</th>
          <th>方向</th>
          <th>金额</th>
          <th>摘要</th>
          <th>对手方</th>
          <th>本方账户</th>
          <th>募投项目</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line) => (
          <tr key={line.id}>
            <td>{line.date || '—'}</td>
            <td className={line.direction === 'in' ? 'in' : 'out'}>{line.direction === 'in' ? '收' : '支'}</td>
            <td>{formatByUnit(line.amount, unit)}</td>
            <td>{line.summary || '—'}</td>
            <td>
              {line.counterparty || '—'}
              {line.counterpartyAccount ? <span className="flow-sub">{line.counterpartyAccount}</span> : null}
            </td>
            <td>{ownAccount(line)}</td>
            <td>{line.fundUse || '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

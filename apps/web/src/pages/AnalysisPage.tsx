import { useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { FlowLink, FlowNode, FlowPartyLine, FlowResponse, FlowResult, TaskBrief } from '@flow/shared';
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

function edgeText(l: FlowLink): string {
  const parts: string[] = [];
  if (l.outAmount > 0) parts.push(`支 ${compactMoney(l.outAmount)}`);
  if (l.inAmount > 0) parts.push(`收 ${compactMoney(l.inAmount)}`);
  if (l.outAmount > 0 && l.inAmount > 0) {
    const net = l.outAmount - l.inAmount;
    parts.push(`${net >= 0 ? '净付' : '净收'} ${compactMoney(Math.abs(net))}`);
  }
  return parts.join(' / ');
}

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

function touches(l: FlowLink, id: string): boolean {
  return l.from === id || l.to === id;
}

export default function AnalysisPage({ task }: { task: TaskBrief | null }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<FlowResponse['status'] | ''>('');
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<FlowResult | null>(null);
  const [focus, setFocus] = useState<string | null>(null);

  const apply = (res: FlowResponse) => {
    setStatus(res.status);
    setMessage(res.message ?? '');
    setResult(res.result ?? null);
    setFocus(null);
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
        if (res.status === 'missing') {
          apply(await api.runFlow(task.id, false));
          return;
        }
        apply(res);
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
            <FlowChart result={result} focus={focus} onFocus={setFocus} />
            <p className="flow-note">生成于 {formatDateTime(result.generatedAt)}</p>
          </>
        ) : null}
      </section>

      {result ? <FlowTables result={result} focus={focus} /> : null}
    </div>
  );
}

function FlowChart({
  result,
  focus,
  onFocus,
}: {
  result: FlowResult;
  focus: string | null;
  onFocus: (id: string | null) => void;
}) {
  const layout = useMemo(() => buildLayout(result), [result]);
  const maxAmt = Math.max(1, ...result.links.map((l) => Math.max(l.outAmount, l.inAmount)));
  return (
    <div className="flow-chart-wrap">
      <div className="flow-legend">
        <span><i style={{ background: COLOR.dedicated }} />专户间</span>
        <span><i style={{ background: COLOR.own }} />客户其他账户</span>
        <span><i style={{ background: COLOR.external }} />对外</span>
        <span><i style={{ background: COLOR.treasury }} />现金管理</span>
      </div>
      <svg
        className="flow-chart"
        viewBox={`0 0 ${layout.w} ${layout.h}`}
        role="img"
        onClick={() => onFocus(null)}
      >
        <defs>
          {(Object.keys(COLOR) as FlowLink['kind'][]).map((k) => (
            <marker key={k} id={`arr-${k}`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 Z" fill={COLOR[k]} />
            </marker>
          ))}
        </defs>
        {layout.links.map((item) => {
          const dim = focus != null && !touches(item.link, focus);
          const amt = Math.max(item.link.outAmount, item.link.inAmount);
          const sw = 1.4 + 6.5 * (Math.log10(1 + amt) / Math.log10(1 + maxAmt));
          const both = item.link.outAmount > 0 && item.link.inAmount > 0;
          return (
            <g key={item.link.id} opacity={dim ? 0.12 : 1}>
              <path
                d={item.d}
                fill="none"
                stroke={COLOR[item.link.kind]}
                strokeWidth={sw}
                strokeDasharray={item.link.to.startsWith('bucket:out') || item.link.from.startsWith('bucket:out') ? '5 4' : undefined}
                markerEnd={`url(#arr-${item.link.kind})`}
                markerStart={both ? `url(#arr-${item.link.kind})` : undefined}
              />
              <text x={item.lx} y={item.ly} textAnchor="middle" className="flow-edge-label">
                {edgeText(item.link)}
              </text>
            </g>
          );
        })}
        {layout.nodes.map((n) => {
          const dim = focus != null && focus !== n.node.id && !result.links.some((l) => touches(l, focus) && touches(l, n.node.id));
          const circle = n.node.role === 'dedicated' || n.node.role === 'own';
          return (
            <g key={n.node.id} transform={`translate(${n.x} ${n.y})`} opacity={dim ? 0.28 : 1} onClick={(e) => { e.stopPropagation(); onFocus(focus === n.node.id ? null : n.node.id); }} style={{ cursor: 'pointer' }}>
              {circle ? (
                <circle r="26" className={`flow-node flow-node-${n.node.role}`} />
              ) : (
                <rect x="-54" y="-18" width="108" height="36" rx="18" className={`flow-node flow-node-${n.node.role}`} />
              )}
              {circle ? (
                <>
                  <text textAnchor="middle" dy={n.node.role === 'own' ? 4 : n.node.tail ? -2 : 4} className="flow-node-title">
                    {n.node.role === 'own' ? n.node.tail || n.node.title.slice(0, 4) : n.node.title.slice(0, 4)}
                  </text>
                  {n.node.role !== 'own' && n.node.tail ? (
                    <text textAnchor="middle" dy="12" className="flow-node-tail">{n.node.tail}</text>
                  ) : null}
                  {n.node.role === 'own' ? (
                    <text x="34" dy="4" className="flow-side-label">{n.node.title.slice(0, 18)}</text>
                  ) : null}
                </>
              ) : (
                <text textAnchor="middle" dy="4" className="flow-node-title">{n.node.title.slice(0, 8)}</text>
              )}
              <title>{`${nodeName(n.node)}${n.node.sub ? ` · ${n.node.sub}` : ''}`}</title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function buildLayout(result: FlowResult) {
  const weight = (id: string) =>
    result.links.filter((l) => l.from === id || l.to === id).reduce((s, l) => s + l.outAmount + l.inAmount, 0);
  const left = result.nodes.filter((n) => n.role === 'dedicated').sort((a, b) => weight(b.id) - weight(a.id));
  const right = result.nodes.filter((n) => n.role !== 'dedicated').sort((a, b) => {
    const rank = (n: FlowNode) => (n.role === 'own' ? 0 : n.role === 'external' ? 1 : n.role === 'bucket' ? 2 : 3);
    return rank(a) - rank(b) || weight(b.id) - weight(a.id);
  });
  const row = 76;
  const top = 40;
  const leftX = 168;
  const rightX = 620;
  const h = Math.max(left.length, right.length, 1) * row + top;
  const w = 980;
  const pos = new Map<string, { x: number; y: number; side: 'L' | 'R' }>();
  left.forEach((n, i) => pos.set(n.id, { x: leftX, y: top + i * row, side: 'L' }));
  right.forEach((n, i) => pos.set(n.id, { x: rightX, y: top + i * row, side: 'R' }));

  const links = result.links.flatMap((link) => {
    const a = pos.get(link.from);
    const b = pos.get(link.to);
    if (!a || !b) return [];
    const internal = a.side === 'L' && b.side === 'L';
    let d: string;
    let lx: number;
    let ly: number;
    if (internal) {
      const x1 = a.x - 28;
      const x2 = b.x - 28;
      const c = leftX - 120;
      d = `M ${x1} ${a.y} C ${c} ${a.y}, ${c} ${b.y}, ${x2} ${b.y}`;
      lx = c + 16;
      ly = (a.y + b.y) / 2 - 6;
    } else {
      const x1 = a.x + (a.side === 'L' ? 28 : -56);
      const x2 = b.x + (b.side === 'L' ? 28 : -56);
      d = `M ${x1} ${a.y} C ${(x1 + x2) / 2} ${a.y}, ${(x1 + x2) / 2} ${b.y}, ${x2} ${b.y}`;
      lx = (x1 + x2) / 2;
      ly = (a.y + b.y) / 2 - 6;
    }
    return [{ link, d, lx, ly }];
  });
  return {
    w,
    h,
    links,
    nodes: [...left, ...right].map((node) => ({ node, ...pos.get(node.id)! })),
  };
}

function FlowTables({ result, focus }: { result: FlowResult; focus: string | null }) {
  const byId = new Map(result.nodes.map((n) => [n.id, n]));
  const dedicated = result.links.filter((l) => l.kind === 'dedicated');
  const own = result.links.filter((l) => l.kind === 'own');
  const dim = (l: FlowLink) => focus != null && !touches(l, focus);
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
                <tr key={l.id} className={dim(l) ? 'dim' : ''}>
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
                return (
                  <tr key={l.id} className={dim(l) ? 'dim' : ''}>
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
          {showGroup ? <th>图上</th> : null}
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
            {showGroup ? <td>{l.grouped ? '对外转出' : '单独'}</td> : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

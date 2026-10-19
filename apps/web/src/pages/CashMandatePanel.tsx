import { useEffect, useMemo, useRef, useState } from 'react';
import { CashBoard, CategoryFocusLine } from '@flow/shared';
import { api } from '../api';
import { formatByUnit, formatMoneyInput, MoneyUnit, moneyUnitName, MoneyUnitSelect, parseMoneyInput, rescaleMoneyInput } from '../lib/moneyUnit';

type DraftBoard = {
  key: string;
  startDate: string;
  endDate: string;
  limitText: string;
  note: string;
};

type Point = { date: string; balance: number };

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function spanDays(a: string, b: string): number {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

function winner(date: string, boards: CashBoard[]): CashBoard | undefined {
  const hits = boards.filter((b) => b.startDate <= date && date <= b.endDate);
  hits.sort((a, b) => b.startDate.localeCompare(a.startDate) || b.id - a.id);
  return hits[0];
}

function buildPoints(lines: CategoryFocusLine[], opening: number, asOf: string, boards: CashBoard[]): Point[] {
  const deltas = new Map<string, number>();
  for (const line of lines) {
    if (!line.date) continue;
    if (asOf && line.date <= asOf) continue;
    const sign = line.direction === 'out' ? 1 : -1;
    deltas.set(line.date, (deltas.get(line.date) ?? 0) + sign * line.amount);
  }
  const txDates = [...deltas.keys()].sort();
  const bounds = boards.flatMap((b) => [b.startDate, b.endDate]).filter((d) => !asOf || d >= asOf);
  const seed = asOf || (txDates[0] ? addDays(txDates[0], -1) : bounds[0]);
  if (!seed) return [];
  const dates = [...new Set([seed, ...txDates, ...bounds])].filter((d) => d >= seed).sort();
  let balance = opening;
  return dates.map((date) => {
    balance += deltas.get(date) ?? 0;
    return { date, balance };
  });
}

function balanceAt(date: string, points: Point[], opening: number): number {
  let balance = opening;
  for (const point of points) {
    if (point.date <= date) balance = point.balance;
    else break;
  }
  return balance;
}

function compactAxis(n: number): string {
  const v = Math.abs(n);
  const trim = (x: number) => {
    const s = x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2);
    return s.replace(/\.0+$/, '').replace(/(\.\d)0$/, '$1');
  };
  const sign = n < 0 ? '-' : '';
  if (v >= 1e8) return sign + trim(v / 1e8) + '亿';
  if (v >= 1e4) return sign + trim(v / 1e4) + '万';
  return sign + trim(v);
}

/**
 * 现金管理额度。上期末余额和历次董事会审议由用户手填。
 * 余额 = 上期末仍在运作 + 截止日之后的申购 − 赎回。同一天若有更新的审议，按新额度判定。
 */
export default function CashMandatePanel({ taskId, lines }: { taskId: number; lines: CategoryFocusLine[] }) {
  const [openingText, setOpeningText] = useState('0');
  const [asOf, setAsOf] = useState('');
  const [drafts, setDrafts] = useState<DraftBoard[]>([]);
  const [seq, setSeq] = useState(1);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [unit, setUnit] = useState<MoneyUnit>('yuan');
  const unitRef = useRef(unit);
  unitRef.current = unit;

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    void api
      .cashMandate(taskId)
      .then((m) => {
        if (cancelled) return;
        setOpeningText(formatMoneyInput(m.opening, unitRef.current));
        setAsOf(m.openingAsOf);
        setDrafts(
          m.boards.map((b) => ({
            key: `s${b.id}`,
            startDate: b.startDate,
            endDate: b.endDate,
            limitText: formatMoneyInput(b.limitAmount, unitRef.current),
            note: b.note,
          })),
        );
        setSeq(m.boards.reduce((n, b) => Math.max(n, b.id), 0) + 1);
        setLoaded(true);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  const boards = useMemo(() => {
    const rows: CashBoard[] = [];
    drafts.forEach((d, i) => {
      const limit = parseMoneyInput(d.limitText, unit);
      if (!d.startDate || !d.endDate || d.endDate < d.startDate || limit == null || limit <= 0) return;
      rows.push({ id: i + 1, startDate: d.startDate, endDate: d.endDate, limitAmount: limit, note: d.note.trim() });
    });
    return rows;
  }, [drafts, unit]);

  const opening = parseMoneyInput(openingText, unit) ?? 0;
  const points = useMemo(() => buildPoints(lines, opening, asOf, boards), [lines, opening, asOf, boards]);
  const undated = lines.filter((l) => !l.date).length;
  const outside = lines.filter((l) => l.date && (!asOf || l.date > asOf) && !winner(l.date, boards)).length;

  const rulings = boards.map((board) => {
    const covered = points.filter(
      (p) => p.date >= board.startDate && p.date <= board.endDate && winner(p.date, boards)?.id === board.id,
    );
    const carried =
      covered.length > 0 && winner(board.startDate, boards)?.id === board.id
        ? balanceAt(board.startDate, points, opening)
        : undefined;
    const samples = carried == null ? covered.map((p) => p.balance) : [carried, ...covered.map((p) => p.balance)];
    const peak = samples.length ? Math.max(...samples) : undefined;
    const over = peak == null ? 0 : peak - board.limitAmount;
    return { board, peak, over };
  });

  function addBoard() {
    setDrafts((rows) => [...rows, { key: `n${seq}`, startDate: '', endDate: '', limitText: '', note: '' }]);
    setSeq((n) => n + 1);
    setNotice(undefined);
  }

  function changeUnit(next: MoneyUnit) {
    setOpeningText((text) => rescaleMoneyInput(text, unit, next));
    setDrafts((rows) => rows.map((d) => ({ ...d, limitText: rescaleMoneyInput(d.limitText, unit, next) })));
    setUnit(next);
  }

  async function save() {
    const openingYuan = parseMoneyInput(openingText, unit);
    if (openingYuan == null) {
      setError('上期末余额需为大于等于 0 的数字');
      return;
    }
    for (const d of drafts) {
      if (!d.startDate && !d.endDate && !d.limitText.trim() && !d.note.trim()) continue;
      const limit = parseMoneyInput(d.limitText, unit);
      if (!d.startDate || !d.endDate) {
        setError('每条审议都要填写起止日期');
        return;
      }
      if (d.endDate < d.startDate) {
        setError('审议截止日期不能早于起始日期');
        return;
      }
      if (limit == null || limit <= 0) {
        setError('审议额度需大于 0');
        return;
      }
    }
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const saved = await api.saveCashMandate(taskId, {
        opening: openingYuan,
        openingAsOf: asOf,
        boards: drafts
          .filter((d) => d.startDate && d.endDate && (parseMoneyInput(d.limitText, unit) ?? 0) > 0)
          .map((d) => ({
            startDate: d.startDate,
            endDate: d.endDate,
            limitAmount: parseMoneyInput(d.limitText, unit) ?? 0,
            note: d.note.trim(),
          })),
      });
      setOpeningText(formatMoneyInput(saved.opening, unit));
      setAsOf(saved.openingAsOf);
      setDrafts(
        saved.boards.map((b) => ({
          key: `s${b.id}`,
          startDate: b.startDate,
          endDate: b.endDate,
          limitText: formatMoneyInput(b.limitAmount, unit),
          note: b.note,
        })),
      );
      setNotice('已记下');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page-section">
      <div className="page-header">
        <div>
          <h1 style={{ fontSize: 18, marginBottom: 2 }}>额度合规</h1>
        </div>
        <MoneyUnitSelect value={unit} onChange={changeUnit} />
      </div>
      <p className="flow-note">
        上期末仍在运作的本金手填。截止日之后，申购增加余额，赎回减少余额。一次审议只管自己的起止日期；日期重叠时，按起始日更晚的那次额度判定。
      </p>

      <div className="cash-form">
        <label>
          上期末余额（{moneyUnitName(unit)}）
          <input className="input" inputMode="decimal" value={openingText} onChange={(e) => setOpeningText(e.target.value)} />
        </label>
        <label>
          截止日
          <input className="input" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </label>
        <span className="cash-form-hint">截止日当天的余额已经含在上期末里，这一天及之前的流水不再重复计算。</span>
      </div>

      <div className="cash-boards">
        {drafts.map((d) => (
          <div className="cash-board" key={d.key}>
            <input
              className="input"
              placeholder="说明，如 2025 年度审议"
              value={d.note}
              maxLength={80}
              onChange={(e) => setDrafts((rows) => rows.map((x) => (x.key === d.key ? { ...x, note: e.target.value } : x)))}
            />
            <input
              className="input"
              type="date"
              value={d.startDate}
              title="起始日期"
              onChange={(e) => setDrafts((rows) => rows.map((x) => (x.key === d.key ? { ...x, startDate: e.target.value } : x)))}
            />
            <input
              className="input"
              type="date"
              value={d.endDate}
              title="截止日期"
              onChange={(e) => setDrafts((rows) => rows.map((x) => (x.key === d.key ? { ...x, endDate: e.target.value } : x)))}
            />
            <input
              className="input"
              inputMode="decimal"
              placeholder={`额度（${moneyUnitName(unit)}）`}
              value={d.limitText}
              onChange={(e) => setDrafts((rows) => rows.map((x) => (x.key === d.key ? { ...x, limitText: e.target.value } : x)))}
            />
            <button
              type="button"
              className="secondary-button"
              onClick={() => setDrafts((rows) => rows.filter((x) => x.key !== d.key))}
            >
              删除
            </button>
          </div>
        ))}
        <div className="cash-board-actions">
          <button type="button" className="secondary-button" onClick={addBoard}>
            添加一次审议
          </button>
          <button type="button" className="primary-button" disabled={busy || !loaded} onClick={() => void save()}>
            {busy ? '保存中…' : '保存'}
          </button>
          {notice ? <span className="cash-form-hint">{notice}</span> : null}
        </div>
      </div>

      {error ? <div className="flow-error">{error}</div> : null}
      {undated > 0 ? <p className="flow-note">{undated} 笔没有日期，没有画进余额曲线。</p> : null}
      {boards.length > 0 && outside > 0 ? (
        <p className="flow-note">{outside} 笔申购或赎回不在任何审议区间里，这些日子没有额度可对照。</p>
      ) : null}

      {points.length > 0 ? <CashChart points={points} boards={boards} unit={unit} /> : null}

      {rulings.length > 0 ? (
        <div className="cash-rulings">
          {rulings.map(({ board, peak, over }) => (
            <div key={`${board.startDate}-${board.endDate}-${board.id}`} className={`cash-ruling${over > 0.005 ? ' over' : ''}`}>
              {peak == null ? (
                <span className="chip chip-muted">本期未覆盖</span>
              ) : (
                <span className={`chip ${over > 0.005 ? 'chip-danger' : 'chip-success'}`}>{over > 0.005 ? '超标' : '未超标'}</span>
              )}
              <b>{board.note || '董事会审议'}</b>
              <em>
                {board.startDate} ~ {board.endDate}
              </em>
              <span>额度 {formatByUnit(board.limitAmount, unit)}</span>
              {peak == null ? (
                <span>截止日之后，余额没有落在这个区间</span>
              ) : (
                <span>最高余额 {formatByUnit(peak, unit)}</span>
              )}
              {over > 0.005 ? <span>超出 {formatByUnit(over, unit)}</span> : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="flow-note">加上董事会审议的时间和额度后，这里会标出余额有没有超过当时的额度。</p>
      )}
    </section>
  );
}

function axisTick(n: number, unit: MoneyUnit): string {
  if (unit === 'yuan') return compactAxis(n);
  const abs = Math.abs(n / 10000);
  const sign = n < 0 ? '-' : '';
  if (abs >= 100) return sign + Math.round(abs).toLocaleString('zh-CN');
  return sign + (Math.round(abs * 100) / 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function CashChart({ points, boards, unit }: { points: Point[]; boards: CashBoard[]; unit: MoneyUnit }) {
  const width = 720;
  const height = 240;
  const pad = { l: unit === 'wan' ? 68 : 58, r: 16, t: 16, b: 32 };
  const start = points[0].date;
  const end = points[points.length - 1].date;
  const span = Math.max(1, spanDays(start, end));
  const limits = boards.map((b) => b.limitAmount);
  const balances = points.map((p) => p.balance);
  const yMax = Math.max(1, ...limits, ...balances, 0) * 1.12;
  const yMin = Math.min(0, ...balances);
  const x = (date: string) => pad.l + ((width - pad.l - pad.r) * spanDays(start, date)) / span;
  const y = (value: number) => pad.t + ((height - pad.t - pad.b) * (yMax - value)) / (yMax - yMin);

  const ceiling: { x1: number; x2: number; limit: number }[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const hit = winner(points[i].date, boards);
    if (!hit) continue;
    ceiling.push({ x1: x(points[i].date), x2: x(points[i + 1].date), limit: hit.limitAmount });
  }
  const lastHit = winner(points[points.length - 1].date, boards);

  const steps: { x1: number; x2: number; y: number; over: boolean }[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const hit = winner(points[i].date, boards);
    steps.push({
      x1: x(points[i].date),
      x2: x(points[i + 1].date),
      y: y(points[i].balance),
      over: Boolean(hit && points[i].balance > hit.limitAmount + 0.005),
    });
  }

  const ticks = yMin < -1 && yMax > 1 ? [yMax, 0, yMin] : [0, 0.5, 1].map((t) => yMin + (yMax - yMin) * t);
  const boundary = [...new Set([start, end, ...boards.flatMap((b) => [b.startDate, b.endDate])])]
    .filter((date) => date >= start && date <= end)
    .sort();
  const candidates = boundary.length <= 6 ? boundary : [start, points[Math.floor((points.length - 1) / 2)].date, end];
  const spaced: string[] = [];
  for (const date of candidates) {
    if (spaced.every((kept) => Math.abs(x(kept) - x(date)) > 64)) spaced.push(date);
  }
  const xTicks = spaced.map((date) => ({ date }));

  return (
    <div className="cash-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="现金管理余额与董事会额度">
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={pad.l} x2={width - pad.r} y1={y(tick)} y2={y(tick)} className={Math.abs(tick) < 1 ? 'cash-grid zero' : 'cash-grid'} />
            <text x={pad.l - 6} y={y(tick) + 4} className="cash-axis" textAnchor="end">
              {axisTick(tick, unit)}
            </text>
          </g>
        ))}
        {ceiling.map((seg, i) => (
          <g key={i}>
            <rect x={seg.x1} y={y(seg.limit)} width={Math.max(0, seg.x2 - seg.x1)} height={Math.max(0, y(0) - y(seg.limit))} className="cash-cap" />
            <line x1={seg.x1} x2={seg.x2} y1={y(seg.limit)} y2={y(seg.limit)} className="cash-cap-edge" />
          </g>
        ))}
        {lastHit ? <line x1={x(end)} x2={x(end)} y1={y(lastHit.limitAmount)} y2={y(0)} className="cash-cap-edge" /> : null}
        {steps.map((seg, i) => (
          <line key={i} x1={seg.x1} x2={seg.x2} y1={seg.y} y2={seg.y} className={seg.over ? 'cash-line over' : 'cash-line'} />
        ))}
        {points.slice(1).map((point, i) => (
          <line
            key={point.date}
            x1={x(point.date)}
            x2={x(point.date)}
            y1={y(points[i].balance)}
            y2={y(point.balance)}
            className={
              winner(point.date, boards) && point.balance > (winner(point.date, boards)?.limitAmount ?? Infinity) + 0.005
                ? 'cash-line over'
                : 'cash-line'
            }
          />
        ))}
        {points.map((point) => {
          const hit = winner(point.date, boards);
          const over = Boolean(hit && point.balance > hit.limitAmount + 0.005);
          if (!over) return null;
          return <circle key={point.date} cx={x(point.date)} cy={y(point.balance)} r={3.5} className="cash-dot" />;
        })}
        {xTicks.map((point) => (
          <text key={point.date} x={x(point.date)} y={height - 8} className="cash-axis" textAnchor="middle">
            {point.date.slice(2)}
          </text>
        ))}
      </svg>
      <div className="cash-legend">
        <span><i className="cash-swatch line" /> 余额</span>
        <span><i className="cash-swatch cap" /> 当时额度</span>
        <span><i className="cash-swatch over" /> 超标</span>
        <span>纵轴：{moneyUnitName(unit)}</span>
      </div>
    </div>
  );
}

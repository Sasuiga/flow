/**
 * 分析页专题（临时补流 / 现金管理 / 实施中置换）
 *
 * 只读交易上的分类，现算现给。不写入 flow_analyses，改分类不会让资金流向重算。
 * 临时补流：转出是补流，同分类的转入当作转回，差额是尚未归还。
 * 现金管理：转出是存放或申购，转入是赎回或到期，差额是仍在运作。投资收益单独列出，不冲减本金。
 * 实施中置换：转出是用募集资金置换实施期间已投入的资金，同分类转入从已置换金额里扣掉。
 */
import { db } from './db.js';
import { CategoryFocus, CategoryFocusLine, CategoryFocusParty } from '@flow/shared';

const FOCUS = ['临时补流', '现金管理', '实施中置换'] as const;

interface Raw {
  id: number;
  date: string | null;
  amount: number;
  direction: string;
  summary: string | null;
  counterparty: string | null;
  counterparty_account: string | null;
  bank: string | null;
  account_no: string | null;
  fund_use: string | null;
  category: string;
}

function toLine(r: Raw): CategoryFocusLine {
  const text = (v: string | null) => {
    const s = (v ?? '').trim();
    return s || undefined;
  };
  return {
    id: Number(r.id),
    date: (r.date ?? '').slice(0, 10) || undefined,
    direction: r.direction === 'in' ? 'in' : 'out',
    amount: Number(r.amount) || 0,
    summary: text(r.summary),
    counterparty: text(r.counterparty),
    counterpartyAccount: text(r.counterparty_account),
    bank: text(r.bank),
    accountNo: text(r.account_no),
    fundUse: text(r.fund_use),
  };
}

function summarize(category: (typeof FOCUS)[number], lines: CategoryFocusLine[]): CategoryFocus {
  let outAmount = 0;
  let outCount = 0;
  let inAmount = 0;
  let inCount = 0;
  const parties = new Map<string, CategoryFocusParty>();
  for (const line of lines) {
    if (line.direction === 'out') {
      outAmount += line.amount;
      outCount++;
    } else {
      inAmount += line.amount;
      inCount++;
    }
    const name = line.counterparty || '（无对手方）';
    const accountNo = line.counterpartyAccount || '';
    const key = `${name}\n${accountNo}`;
    let party = parties.get(key);
    if (!party) {
      party = {
        name,
        accountNo: accountNo || undefined,
        outAmount: 0,
        outCount: 0,
        inAmount: 0,
        inCount: 0,
      };
      parties.set(key, party);
    }
    if (line.direction === 'out') {
      party.outAmount += line.amount;
      party.outCount++;
    } else {
      party.inAmount += line.amount;
      party.inCount++;
    }
    if (line.date && (!party.firstDate || line.date < party.firstDate)) party.firstDate = line.date;
    if (line.date && (!party.lastDate || line.date > party.lastDate)) party.lastDate = line.date;
  }
  return {
    category,
    outAmount,
    outCount,
    inAmount,
    inCount,
    netOut: outAmount - inAmount,
    parties: [...parties.values()].sort((a, b) => b.outAmount + b.inAmount - (a.outAmount + a.inAmount)),
    lines,
  };
}

export function categoryFocus(taskId: number): { views: CategoryFocus[] } {
  const rows = db
    .prepare(
      `SELECT t.id, t.date, t.amount, t.direction, t.summary, t.counterparty, t.counterparty_account, t.category,
              f.bank, f.account_no, fu.name AS fund_use
       FROM transactions t
       JOIN files f ON f.id = t.file_id
       JOIN tasks tk ON tk.id = f.task_id
       LEFT JOIN fund_use_accounts fua
         ON fua.project_id = tk.project_id
        AND fua.account_key != ''
        AND fua.account_key = UPPER(REPLACE(REPLACE(REPLACE(REPLACE(IFNULL(f.account_no, ''), ' ', ''), char(9), ''), '-', ''), '　', ''))
       LEFT JOIN fund_uses fu ON fu.id = fua.fund_use_id
       WHERE f.task_id = ? AND t.category IN ('临时补流', '现金管理', '现金管理投资收益', '实施中置换')
       ORDER BY t.date IS NULL, t.date, t.id`,
    )
    .all(taskId) as Raw[];

  const byCat = new Map<string, CategoryFocusLine[]>();
  for (const row of rows) {
    const list = byCat.get(row.category) ?? [];
    list.push(toLine(row));
    byCat.set(row.category, list);
  }

  const views: CategoryFocus[] = [];
  for (const category of FOCUS) {
    const lines = byCat.get(category) ?? [];
    if (lines.length === 0) continue;
    const view = summarize(category, lines);
    if (category === '现金管理') {
      const income = byCat.get('现金管理投资收益') ?? [];
      if (income.length > 0) {
        view.incomeLines = income;
        view.incomeCount = income.length;
        view.incomeAmount = income.reduce((s, l) => s + l.amount, 0);
      }
    }
    views.push(view);
  }
  return { views };
}

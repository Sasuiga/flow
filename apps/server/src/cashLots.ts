/**
 * 报表「现金管理期末余额」。
 *
 * 流水没有存单号，不能认定某一笔赎回就是某一笔购买。同一专户内按下面的顺序配对，换一组金额和日期都相同的流水，四列结果不变：
 * 1. 金额相同，且购买日不晚于赎回日，按日期和流水顺序一一对应。
 * 2. 赎回大于尚未配对的购买、差额不超过购买金额的 15%，差额记为利息，优先差额更小的那笔购买。
 * 3. 收益单独入账时，只在同一天、产品代码一致、笔数也一致时按顺序挂上。笔数对不上就不挂，避免把一笔利息安到错误的本金上。
 * 购买不在本期流水里的，不拿别的账户或其他金额去凑。收益没单独入账、又减不出本金的，利息留空，整笔赎回从余额中减掉；用户手填本金和利息后，按本金减余额、按利息计入合计。
 * 期末未赎回 = 上期末余额 − 本期赎回的上期本金 + 本期购买尚未赎回。上期尚未赎回只给合计，不拆成单笔。
 * 上期购买、本期赎回、且收益已经能分开的，计入利息合计。活期「利息」不是现金管理收益，不进这张表。
 */
import { CashLot, CashLotLine, CashLotReport } from '@flow/shared';
import { getCashMandate } from './cashMandate.js';
import { db } from './db.js';

const YIELD_CAP = 0.15;

interface Raw {
  id: number;
  date?: string;
  amount: number;
  direction: 'in' | 'out';
  summary?: string;
  counterparty?: string;
  counterpartyAccount?: string;
  category: string;
  bank?: string;
  accountNo?: string;
  holder?: string;
  fundUse?: string;
}

interface Work {
  purchase?: Raw;
  redemption?: Raw;
  interests: Raw[];
  bundled: number;
  ambiguous: boolean;
}

function cents(n: number): number {
  return Math.round(n * 100) / 100;
}

function sameMoney(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}

function productCode(summary?: string): string | undefined {
  const matched = (summary ?? '').match(/产品代码[:：]\s*([A-Za-z0-9]+(?:\s+[A-Za-z0-9]+)*)/);
  const code = matched?.[1]?.trim().toUpperCase();
  return code || undefined;
}

function datesAllow(purchase?: string, redemption?: string): boolean {
  if (!purchase || !redemption) return true;
  return redemption >= purchase;
}

function textAllow(a?: string, b?: string): boolean {
  const left = (a ?? '').trim();
  const right = (b ?? '').trim();
  if (!left || !right) return true;
  return left === right;
}

function codeAllow(a?: string, b?: string): boolean {
  const left = productCode(a);
  const right = productCode(b);
  if (!left || !right) return true;
  return left === right;
}

function byTime(a: Raw, b: Raw): number {
  const da = a.date ?? '9999-99-99';
  const db = b.date ?? '9999-99-99';
  if (da !== db) return da < db ? -1 : 1;
  return a.id - b.id;
}

function accountKey(row: Raw): string {
  return `${(row.bank ?? '').trim()}\n${(row.accountNo ?? '').trim()}`;
}

function toLine(row: Raw, role: CashLotLine['role']): CashLotLine {
  return {
    id: row.id,
    date: row.date,
    direction: row.direction,
    amount: row.amount,
    summary: row.summary,
    counterparty: row.counterparty,
    counterpartyAccount: row.counterpartyAccount,
    category: row.category,
    role,
  };
}

function eligible(purchase: Raw, redemption: Raw, exact: boolean): boolean {
  if (!datesAllow(purchase.date, redemption.date)) return false;
  if (!textAllow(purchase.counterparty, redemption.counterparty)) return false;
  if (!codeAllow(purchase.summary, redemption.summary)) return false;
  if (exact) return sameMoney(purchase.amount, redemption.amount);
  if (redemption.amount <= purchase.amount + 0.005) return false;
  return (redemption.amount - purchase.amount) / purchase.amount <= YIELD_CAP;
}

function distinctDates(rows: Raw[]): boolean {
  return new Set(rows.map((row) => row.date ?? '')).size > 1;
}

function pairAccount(rows: Raw[]): Work[] {
  const purchases = rows.filter((row) => row.category === '现金管理' && row.direction === 'out').sort(byTime);
  const redemptions = rows.filter((row) => row.category === '现金管理' && row.direction === 'in').sort(byTime);
  const interests = rows.filter((row) => row.category === '现金管理投资收益' && row.direction === 'in').sort(byTime);
  const usedP = new Set<number>();
  const usedR = new Set<number>();
  const works: Work[] = [];

  for (const purchase of purchases) {
    const candidates = redemptions.filter((row) => !usedR.has(row.id) && eligible(purchase, row, true));
    const redemption = candidates[0];
    if (!redemption) continue;
    usedP.add(purchase.id);
    usedR.add(redemption.id);
    const rivals = purchases.filter((row) => !usedP.has(row.id) && eligible(row, redemption, true));
    works.push({
      purchase,
      redemption,
      interests: [],
      bundled: 0,
      ambiguous: distinctDates([purchase, ...rivals]),
    });
  }

  for (const redemption of redemptions) {
    if (usedR.has(redemption.id)) continue;
    let bestExcess = Infinity;
    let ties: Raw[] = [];
    for (const purchase of purchases) {
      if (usedP.has(purchase.id) || !eligible(purchase, redemption, false)) continue;
      const excess = redemption.amount - purchase.amount;
      if (excess < bestExcess - 0.005) {
        bestExcess = excess;
        ties = [purchase];
      } else if (Math.abs(excess - bestExcess) < 0.005) {
        ties.push(purchase);
      }
    }
    const purchase = ties.sort(byTime)[0];
    if (!purchase) continue;
    usedP.add(purchase.id);
    usedR.add(redemption.id);
    works.push({
      purchase,
      redemption,
      interests: [],
      bundled: cents(redemption.amount - purchase.amount),
      ambiguous: distinctDates(ties),
    });
  }

  for (const purchase of purchases) {
    if (usedP.has(purchase.id)) continue;
    works.push({ purchase, interests: [], bundled: 0, ambiguous: false });
  }
  for (const redemption of redemptions) {
    if (usedR.has(redemption.id)) continue;
    works.push({ redemption, interests: [], bundled: 0, ambiguous: false });
  }

  const usedI = new Set<number>();
  const buckets = new Map<string, { lots: Work[]; interests: Raw[] }>();
  const bucketKey = (date?: string, summary?: string) => `${date ?? ''}|${productCode(summary) ?? ''}`;
  for (const work of works) {
    if (!work.redemption) continue;
    const key = bucketKey(work.redemption.date, work.redemption.summary);
    const bucket = buckets.get(key) ?? { lots: [], interests: [] };
    bucket.lots.push(work);
    buckets.set(key, bucket);
  }
  for (const interest of interests) {
    const bucket = buckets.get(bucketKey(interest.date, interest.summary));
    if (bucket) bucket.interests.push(interest);
  }
  for (const bucket of buckets.values()) {
    if (bucket.lots.length === 0 || bucket.lots.length !== bucket.interests.length) continue;
    const lots = [...bucket.lots].sort((a, b) => a.redemption!.id - b.redemption!.id);
    const gains = [...bucket.interests].sort((a, b) => a.id - b.id);
    lots.forEach((lot, index) => {
      lot.interests.push(gains[index]);
      usedI.add(gains[index].id);
    });
  }
  for (const interest of interests) {
    if (usedI.has(interest.id)) continue;
    works.push({ interests: [interest], bundled: 0, ambiguous: false });
  }
  return works;
}

function toLot(work: Work, index: number): CashLot {
  const anchor = work.purchase ?? work.redemption ?? work.interests[0];
  const interestOnly = !work.purchase && !work.redemption;
  const separated = work.interests.reduce((sum, row) => sum + row.amount, 0);
  const interest = separated > 0 || work.bundled > 0 ? cents(separated + work.bundled) : undefined;
  const interestUnknown = !work.purchase && !!work.redemption && interest == null;
  const purchaseAmount = work.purchase ? work.purchase.amount : work.redemption && !interestUnknown ? work.redemption.amount : undefined;
  const lines: CashLotLine[] = [];
  if (work.purchase) lines.push(toLine(work.purchase, 'purchase'));
  if (work.redemption) lines.push(toLine(work.redemption, 'redemption'));
  for (const row of work.interests) lines.push(toLine(row, 'interest'));
  return {
    id: `${anchor?.id ?? index}`,
    bank: anchor?.bank,
    accountNo: anchor?.accountNo,
    holder: work.purchase?.holder || work.redemption?.holder || work.interests[0]?.holder,
    fundUse: work.purchase?.fundUse || work.redemption?.fundUse || work.interests[0]?.fundUse,
    purchaseAmount,
    purchaseDate: work.purchase?.date,
    purchaseMissing: !work.purchase && !!work.redemption,
    redemptionAmount: work.redemption?.amount,
    redemptionDate: work.redemption?.date,
    open: !!work.purchase && !work.redemption,
    interest,
    interestUnknown,
    manualSplit: false,
    ambiguous: work.ambiguous,
    interestOnly,
    lines,
  };
}

export function pairCashLots(rows: Raw[]): CashLotReport {
  const groups = new Map<string, Raw[]>();
  for (const row of rows) {
    const list = groups.get(accountKey(row)) ?? [];
    list.push(row);
    groups.set(accountKey(row), list);
  }
  const lots = [...groups.values()].flatMap((group) => pairAccount(group).map(toLot));
  lots.sort((a, b) => {
    const account = `${a.bank ?? ''}|${a.accountNo ?? ''}`.localeCompare(`${b.bank ?? ''}|${b.accountNo ?? ''}`, 'zh');
    if (account) return account;
    const da = a.purchaseDate ?? a.redemptionDate ?? '9999-99-99';
    const db = b.purchaseDate ?? b.redemptionDate ?? '9999-99-99';
    if (da !== db) return da < db ? -1 : 1;
    return a.id.localeCompare(b.id, undefined, { numeric: true });
  });
  return {
    rows: lots,
    ending: cents(lots.reduce((sum, lot) => sum + (lot.open ? lot.purchaseAmount ?? 0 : 0), 0)),
    interest: cents(lots.reduce((sum, lot) => sum + (lot.interest ?? 0), 0)),
    priorOpen: 0,
  };
}

/** 上期赎回的本金。能分开或用户手填时用本金；本息仍未分开时按整笔赎回计。 */
function priorRedeemedPrincipal(lots: CashLot[]): number {
  return lots.reduce((sum, lot) => {
    if (!lot.purchaseMissing || lot.redemptionAmount == null) return sum;
    return sum + (lot.purchaseAmount ?? lot.redemptionAmount);
  }, 0);
}

function withOpening(report: CashLotReport, opening: number): CashLotReport {
  const priorOpen = cents(opening - priorRedeemedPrincipal(report.rows));
  return {
    ...report,
    priorOpen,
    ending: cents(report.ending + priorOpen),
  };
}

function redemptionId(lot: CashLot): number | undefined {
  return lot.lines.find((line) => line.role === 'redemption')?.id;
}

function applySplits(lots: CashLot[], splits: Map<number, { principal: number; interest: number }>): CashLot[] {
  return lots.map((lot) => {
    if (!lot.interestUnknown) return lot;
    const id = redemptionId(lot);
    const split = id == null ? undefined : splits.get(id);
    if (!split) return lot;
    return {
      ...lot,
      purchaseAmount: split.principal,
      interest: split.interest,
      interestUnknown: false,
      manualSplit: true,
    };
  });
}

function loadSplits(taskId: number): Map<number, { principal: number; interest: number }> {
  const rows = db
    .prepare(
      `SELECT s.transaction_id, s.principal, s.interest
         FROM cash_lot_split s
         JOIN transactions t ON t.id = s.transaction_id
         JOIN files f ON f.id = t.file_id
        WHERE f.task_id = ?`,
    )
    .all(taskId) as { transaction_id: number; principal: number; interest: number }[];
  return new Map(rows.map((row) => [Number(row.transaction_id), { principal: Number(row.principal) || 0, interest: Number(row.interest) || 0 }]));
}

export function cashLots(taskId: number): CashLotReport | null {
  const task = db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(taskId) as { project_id: number } | undefined;
  if (!task) return null;
  const accountKeySql = `UPPER(REPLACE(REPLACE(REPLACE(REPLACE(IFNULL(f.account_no, ''), ' ', ''), char(9), ''), '-', ''), '　', ''))`;
  const rows = db
    .prepare(
      `SELECT t.id, t.date, t.amount, t.direction, t.summary, t.counterparty, t.counterparty_account, t.category,
              f.bank, f.account_no, f.account_name,
              (SELECT fu.name
                 FROM fund_use_accounts fua
                 JOIN fund_uses fu ON fu.id = fua.fund_use_id
                WHERE fua.project_id = ?
                  AND fua.account_key != ''
                  AND fua.account_key = ${accountKeySql}
                ORDER BY fu.id
                LIMIT 1) AS fund_use,
              (SELECT fua.holder
                 FROM fund_use_accounts fua
                WHERE fua.project_id = ?
                  AND fua.account_key != ''
                  AND fua.account_key = ${accountKeySql}
                  AND TRIM(fua.holder) != ''
                ORDER BY fua.id
                LIMIT 1) AS holder
         FROM transactions t
         JOIN files f ON f.id = t.file_id
        WHERE f.task_id = ?
          AND t.category IN ('现金管理', '现金管理投资收益')
        ORDER BY t.date IS NULL, t.date, t.id`,
    )
    .all(task.project_id, task.project_id, taskId) as {
    id: number;
    date: string | null;
    amount: number;
    direction: string;
    summary: string | null;
    counterparty: string | null;
    counterparty_account: string | null;
    category: string;
    bank: string | null;
    account_no: string | null;
    account_name: string | null;
    fund_use: string | null;
    holder: string | null;
  }[];
  const text = (value: string | null) => {
    const trimmed = (value ?? '').trim();
    return trimmed || undefined;
  };
  const mandate = getCashMandate(taskId);
  const asOf = mandate?.openingAsOf ?? '';
  const mapped = rows.map((row) => ({
      id: Number(row.id),
      date: (row.date ?? '').slice(0, 10) || undefined,
      amount: Number(row.amount) || 0,
      direction: row.direction === 'in' ? 'in' : 'out',
      summary: text(row.summary),
      counterparty: text(row.counterparty),
      counterpartyAccount: text(row.counterparty_account),
      category: row.category,
      bank: text(row.bank),
      accountNo: text(row.account_no),
      holder: text(row.holder) || text(row.account_name),
      fundUse: text(row.fund_use),
    }));
  const period = asOf ? mapped.filter((row) => !row.date || row.date > asOf) : mapped;
  const paired = pairCashLots(period);
  paired.rows = applySplits(paired.rows, loadSplits(taskId));
  paired.interest = cents(paired.rows.reduce((sum, lot) => sum + (lot.interest ?? 0), 0));
  return withOpening(paired, mandate?.opening ?? 0);
}

export function saveCashSplit(
  taskId: number,
  txId: number,
  body: { principal?: unknown; interest?: unknown },
): { report: CashLotReport } | { error: string } {
  const current = cashLots(taskId);
  if (!current) return { error: '任务不存在' };
  const lot = current.rows.find((row) => redemptionId(row) === txId);
  if (!lot || lot.redemptionAmount == null || (!lot.interestUnknown && !lot.manualSplit)) {
    return { error: '这笔赎回已经能分开，不用手填' };
  }
  const blank = (value: unknown) => value == null || (typeof value === 'string' && value.trim() === '');
  if (blank(body.principal) && blank(body.interest)) {
    db.prepare('DELETE FROM cash_lot_split WHERE transaction_id = ?').run(txId);
    const report = cashLots(taskId);
    return report ? { report } : { error: '任务不存在' };
  }
  const principal = Number(body.principal);
  const interest = Number(body.interest);
  if (!Number.isFinite(principal) || !Number.isFinite(interest) || principal < 0 || interest < 0) {
    return { error: '本金和利息需为大于等于 0 的数字' };
  }
  if (Math.abs(cents(principal + interest) - lot.redemptionAmount) > 0.02) {
    return { error: '本金加利息需要等于赎回金额' };
  }
  db.prepare(
    `INSERT INTO cash_lot_split(transaction_id, principal, interest, updated_at) VALUES(?,?,?,?)
     ON CONFLICT(transaction_id) DO UPDATE SET
       principal = excluded.principal,
       interest = excluded.interest,
       updated_at = excluded.updated_at`,
  ).run(txId, cents(principal), cents(interest), new Date().toISOString());
  const report = cashLots(taskId);
  return report ? { report } : { error: '任务不存在' };
}

/**
 * 现金管理合规参数。只存用户手填的上期末余额和董事会审议，不改交易。
 */
import { CashBoard, CashMandate } from '@flow/shared';
import { db } from './db.js';

const now = () => new Date().toISOString();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function getCashMandate(taskId: number): CashMandate | null {
  const task = db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(taskId);
  if (!task) return null;
  const opening = db.prepare('SELECT amount, as_of FROM cash_opening WHERE task_id = ?').get(taskId) as
    | { amount: number; as_of: string }
    | undefined;
  const boards = db
    .prepare(
      `SELECT id, start_date, end_date, limit_amount, note
       FROM cash_board WHERE task_id = ? ORDER BY start_date, id`,
    )
    .all(taskId) as { id: number; start_date: string; end_date: string; limit_amount: number; note: string }[];
  return {
    opening: opening ? Number(opening.amount) || 0 : 0,
    openingAsOf: opening?.as_of ?? '',
    boards: boards.map(toBoard),
  };
}

function toBoard(row: { id: number; start_date: string; end_date: string; limit_amount: number; note: string }): CashBoard {
  return {
    id: row.id,
    startDate: row.start_date,
    endDate: row.end_date,
    limitAmount: Number(row.limit_amount) || 0,
    note: row.note ?? '',
  };
}

export function saveCashMandate(
  taskId: number,
  body: { opening?: unknown; openingAsOf?: unknown; boards?: unknown },
): { mandate: CashMandate } | { error: string } {
  if (!db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(taskId)) return { error: '任务不存在' };
  const opening = Number(body.opening ?? 0);
  if (!Number.isFinite(opening) || opening < 0) return { error: '上期末余额需为大于等于 0 的数字' };
  const openingAsOf = String(body.openingAsOf ?? '').trim();
  if (openingAsOf && !DATE_RE.test(openingAsOf)) return { error: '上期末截止日格式应为 YYYY-MM-DD' };
  if (!Array.isArray(body.boards)) return { error: '审议需为列表' };
  const boards: { startDate: string; endDate: string; limitAmount: number; note: string }[] = [];
  for (const raw of body.boards) {
    const row = raw as { startDate?: unknown; endDate?: unknown; limitAmount?: unknown; note?: unknown };
    const startDate = String(row.startDate ?? '').trim();
    const endDate = String(row.endDate ?? '').trim();
    const limitAmount = Number(row.limitAmount);
    const note = String(row.note ?? '').trim();
    if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) return { error: '审议起止日期格式应为 YYYY-MM-DD' };
    if (endDate < startDate) return { error: '审议截止日期不能早于起始日期' };
    if (!Number.isFinite(limitAmount) || limitAmount <= 0) return { error: '审议额度需大于 0' };
    if (note.length > 80) return { error: '审议说明请控制在 80 字以内' };
    boards.push({ startDate, endDate, limitAmount, note });
  }
  const ts = now();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO cash_opening(task_id, amount, as_of, updated_at) VALUES(?,?,?,?)
       ON CONFLICT(task_id) DO UPDATE SET amount = excluded.amount, as_of = excluded.as_of, updated_at = excluded.updated_at`,
    ).run(taskId, opening, openingAsOf, ts);
    db.prepare('DELETE FROM cash_board WHERE task_id = ?').run(taskId);
    const insert = db.prepare(
      `INSERT INTO cash_board(task_id, start_date, end_date, limit_amount, note, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?)`,
    );
    for (const board of boards) {
      insert.run(taskId, board.startDate, board.endDate, board.limitAmount, board.note, ts, ts);
    }
  });
  tx();
  return { mandate: getCashMandate(taskId)! };
}

/**
 * 报表。只读当前任务的流水和项目上登记的募资专户，不改交易。
 * 余额取该专户在本任务流水里日期最晚、且印有余额的那一笔。
 */
import { DedicatedBalance } from '@flow/shared';
import { db } from './db.js';

const ACCOUNT_KEY = `UPPER(REPLACE(REPLACE(REPLACE(REPLACE(IFNULL(f.account_no, ''), ' ', ''), char(9), ''), '-', ''), '　', ''))`;

export function dedicatedBalances(taskId: number): DedicatedBalance[] | null {
  const task = db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(taskId) as
    | { project_id: number }
    | undefined;
  if (!task) return null;
  const accounts = db
    .prepare(
      `SELECT holder, bank, account_no, account_key
       FROM fund_use_accounts
       WHERE project_id = ?
       ORDER BY bank, account_no, id`,
    )
    .all(task.project_id) as { holder: string; bank: string; account_no: string; account_key: string }[];
  const latest = db
    .prepare(
      `WITH keyed AS (
         SELECT ${ACCOUNT_KEY} AS account_key, t.balance AS balance, t.date AS date,
                f.rel_path AS rel_path, t.page AS page, t.line_no AS line_no, t.id AS id
         FROM transactions t
         JOIN files f ON f.id = t.file_id
         WHERE f.task_id = ? AND t.balance IS NOT NULL
       )
       SELECT account_key, balance
       FROM keyed k
       WHERE k.id = (
         SELECT k2.id FROM keyed k2
         WHERE k2.account_key = k.account_key
         ORDER BY k2.date IS NULL, k2.date DESC, k2.rel_path DESC, k2.page DESC, k2.line_no DESC, k2.id DESC
         LIMIT 1
       )
       GROUP BY account_key`,
    )
    .all(taskId) as { account_key: string; balance: number }[];
  const byKey = new Map(latest.map((row) => [row.account_key, Number(row.balance)]));
  return accounts.map((account) => {
    const balance = byKey.get(account.account_key);
    return {
      holder: account.holder.trim(),
      bank: account.bank.trim(),
      accountNo: account.account_no.trim(),
      balance: balance == null || Number.isNaN(balance) ? undefined : balance,
    };
  });
}

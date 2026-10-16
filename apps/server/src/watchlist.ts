/**
 * 关注：交易页标记是源头，关注页只追加记录和判定。
 * 取消标记也只能在交易页做。关注页不写 tx_watch.marked，也不改交易字段。
 */
import { Router } from 'express';
import { WatchItem, WatchLog, WatchVerdict, WATCH_VERDICTS } from '@flow/shared';
import { db } from './db.js';
import { BASE_SELECT, toTxRow } from './tx.js';

const now = () => new Date().toISOString();

export const watchRouter = Router();

function txExists(id: number): boolean {
  return Boolean(db.prepare('SELECT 1 FROM transactions WHERE id = ?').get(id));
}

function isMarked(id: number): boolean {
  const row = db.prepare('SELECT marked FROM tx_watch WHERE transaction_id = ?').get(id) as
    | { marked: number }
    | undefined;
  return Boolean(row && row.marked === 1);
}

function appendLog(transactionId: number, kind: WatchLog['kind'], body: string) {
  db.prepare('INSERT INTO tx_watch_log(transaction_id, kind, body, created_at) VALUES(?,?,?,?)').run(
    transactionId,
    kind,
    body,
    now(),
  );
}

watchRouter.get('/', (req, res) => {
  const taskId = req.query.taskId ? Number(req.query.taskId) : undefined;
  const where = ['COALESCE(w.marked, 0) = 1'];
  const args: number[] = [];
  if (taskId && Number.isFinite(taskId)) {
    where.push('f.task_id = ?');
    args.push(taskId);
  }
  const rows = db
    .prepare(
      `${BASE_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.date IS NULL, t.date, f.rel_path, t.page, t.line_no, t.id`,
    )
    .all(...args) as Record<string, unknown>[];
  const ids = rows.map((r) => Number(r.id));
  const logsByTx = new Map<number, WatchLog[]>();
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    const logs = db
      .prepare(
        `SELECT id, transaction_id, kind, body, created_at FROM tx_watch_log
         WHERE transaction_id IN (${placeholders}) ORDER BY id`,
      )
      .all(...ids) as { id: number; transaction_id: number; kind: WatchLog['kind']; body: string; created_at: string }[];
    for (const log of logs) {
      const list = logsByTx.get(log.transaction_id) ?? [];
      list.push({ id: log.id, kind: log.kind, body: log.body, createdAt: log.created_at });
      logsByTx.set(log.transaction_id, list);
    }
  }
  const items: WatchItem[] = rows.map((r) => {
    const logs = logsByTx.get(Number(r.id)) ?? [];
    const verdictLog = [...logs].reverse().find((l) => l.kind === 'verdict');
    const verdict = WATCH_VERDICTS.find((v) => v === verdictLog?.body);
    return { tx: toTxRow(r), verdict, logs };
  });
  res.json({ items, total: items.length });
});

/** 只改交易页标记，并留下标记/取消记录 */
watchRouter.post('/:id/mark', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || !txExists(id)) return res.status(404).json({ error: '交易不存在' });
  const marked = Boolean((req.body as { marked?: boolean } | undefined)?.marked);
  const already = isMarked(id);
  if (marked === already) return res.json({ watched: already });
  const ts = now();
  if (marked) {
    db.prepare(
      `INSERT INTO tx_watch(transaction_id, marked, updated_at) VALUES(?, 1, ?)
       ON CONFLICT(transaction_id) DO UPDATE SET marked = 1, updated_at = excluded.updated_at`,
    ).run(id, ts);
    appendLog(id, 'mark', '在交易页标记');
  } else {
    db.prepare('UPDATE tx_watch SET marked = 0, updated_at = ? WHERE transaction_id = ?').run(ts, id);
    appendLog(id, 'unmark', '在交易页取消标记');
  }
  res.json({ watched: marked });
});

watchRouter.post('/:id/note', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || !txExists(id)) return res.status(404).json({ error: '交易不存在' });
  if (!isMarked(id)) return res.status(400).json({ error: '这笔还没在交易页标记' });
  const text = String((req.body as { text?: unknown } | undefined)?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: '记录不能为空' });
  if (text.length > 2000) return res.status(400).json({ error: '记录请控制在 2000 字以内' });
  appendLog(id, 'note', text);
  res.json({ ok: true });
});

watchRouter.post('/:id/verdict', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || !txExists(id)) return res.status(404).json({ error: '交易不存在' });
  if (!isMarked(id)) return res.status(400).json({ error: '这笔还没在交易页标记' });
  const verdict = String((req.body as { verdict?: unknown } | undefined)?.verdict ?? '').trim();
  if (!WATCH_VERDICTS.includes(verdict as WatchVerdict)) {
    return res.status(400).json({ error: '判定需为有问题、无问题或已处理' });
  }
  const latest = db
    .prepare(`SELECT body FROM tx_watch_log WHERE transaction_id = ? AND kind = 'verdict' ORDER BY id DESC LIMIT 1`)
    .get(id) as { body: string } | undefined;
  if (latest?.body === verdict) return res.json({ ok: true, verdict });
  appendLog(id, 'verdict', verdict);
  res.json({ ok: true, verdict });
});

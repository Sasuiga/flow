/**
 * 逐笔交易分类（M4，§5.4）
 *
 * 分类集（可配，默认专户集）→ LLM 批量分类（30 笔/批 + 项目背景 + 分类定义 + 最近 20 条人工改判示例）
 * → 低置信进修正队列（review_note 追加「分类未确认」）→ 人工改判写 category_src='manual'，
 * 改判作为最高优先示例复用（下一批自动带上）。
 *
 * 数据事实源是 transactions.category / category_src；分析页的按线路批量打标也是写这里（bulkCategory）。
 */
import { Router } from 'express';
import { db } from './db.js';
import { extractJson, llmChat } from './ai.js';
import { getSettings } from './settings.js';
import { bankShort } from './flow.js';
import { CATEGORY_DEFS, ClassifyOutcome, DEDICATED_CATEGORIES, TRANSIT_FUND_USE_LABEL, TRANSIT_USE_ROLE } from '@flow/shared';

/* ---------- 分类集（settings 表存 JSON 数组；缺省用专户默认集） ---------- */

export function getCategorySet(): string[] {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'categorySet'").get() as
    | { value: string }
    | undefined;
  if (row) {
    try {
      const v = JSON.parse(row.value) as unknown;
      if (Array.isArray(v) && v.length > 0) return v.map((c) => String(c).trim()).filter(Boolean);
    } catch {
      /* 落回默认集 */
    }
  }
  return [...DEDICATED_CATEGORIES];
}

export function saveCategorySet(categories: string[]): string[] {
  const seen = new Set<string>();
  const cleaned = categories
    .map((c) => String(c ?? '').trim())
    .filter((c) => c && !seen.has(c) && seen.add(c));
  if (cleaned.length === 0) throw new Error('分类集不能为空');
  const up = db.prepare(
    "INSERT INTO settings(key, value) VALUES('categorySet', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  up.run(JSON.stringify(cleaned));
  return cleaned;
}

export const categoriesRouter = Router();
categoriesRouter.get('/', (_req, res) => {
  res.json({ categories: getCategorySet(), defs: CATEGORY_DEFS });
});
categoriesRouter.put('/', (req, res) => {
  const body = (req.body ?? {}) as { categories?: unknown };
  if (!Array.isArray(body.categories)) return res.status(400).json({ error: 'categories 需为字符串数组' });
  try {
    const saved = saveCategorySet(body.categories as string[]);
    res.json({ categories: saved });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/* ---------- 分类执行 ---------- */

const BATCH_SIZE = 30;
/** 低于这个置信度的分类进修正队列待人工确认 */
const LOW_CONF = 0.7;
/** 改判示例窗口（§5.4：最近 20 条人工改判） */
const EXAMPLE_LIMIT = 20;

interface CatTx {
  id: number;
  date?: string;
  summary?: string;
  amount: number;
  direction: 'in' | 'out';
  counterparty?: string;
  counterpartyAccount?: string;
  channel?: string;
  fundUse?: string;
  reviewNote?: string;
  status?: string;
}

function taskContext(taskId: number): {
  clientName: string;
  projectName: string;
  taskName: string;
  fundUses: string[];
  accounts: { bank: string; accountNo: string; holder: string }[];
} | null {
  const head = db
    .prepare(
      `SELECT tk.name AS task_name, p.name AS project_name, c.name AS client_name, tk.project_id
       FROM tasks tk
       JOIN projects p ON p.id = tk.project_id
       JOIN clients c ON c.id = p.client_id
       WHERE tk.id = ?`,
    )
    .get(taskId) as { task_name: string; project_name: string; client_name: string; project_id: number } | undefined;
  if (!head) return null;
  const fundUses = (
    db.prepare('SELECT name FROM fund_uses WHERE project_id = ? ORDER BY name').all(head.project_id) as {
      name: string;
    }[]
  ).map((r) => r.name);
  const accounts = (
    db
      .prepare("SELECT bank, account_no, holder FROM fund_use_accounts WHERE project_id = ? AND account_no != '' ORDER BY bank, account_no")
      .all(head.project_id) as { bank: string; account_no: string; holder: string }[]
  ).map((a) => ({ bank: a.bank, accountNo: a.account_no, holder: a.holder }));
  return {
    clientName: head.client_name,
    projectName: head.project_name,
    taskName: head.task_name,
    fundUses,
    accounts,
  };
}

/** 最近的人工改判（改判 = 最高优先示例，§5.4） */
function manualExamples(): { summary?: string; counterparty?: string; category: string }[] {
  return (
    db
      .prepare(
        `SELECT summary, counterparty, category FROM transactions
         WHERE category_src = 'manual' AND category IS NOT NULL AND category != ''
         ORDER BY id DESC LIMIT ?`,
      )
      .all(EXAMPLE_LIMIT) as { summary?: string; counterparty?: string; category: string }[]
  );
}

function txLine(t: CatTx): string {
  const s = (v: string | undefined) => (v && v.trim() ? v.trim() : '—');
  return [
    t.id,
    s(t.date),
    t.direction === 'out' ? '支出' : '收入',
    t.amount.toFixed(2),
    s(t.counterparty),
    s(t.counterpartyAccount),
    s(t.summary),
    s(t.channel),
    s(t.fundUse),
  ].join('\t');
}

export interface ClassifyOptions {
  /** 连 LLM 已分类的一起重分（人工改判的仍不动） */
  force?: boolean;
  /** 只分这个文件的交易（解析后自动分类用） */
  fileId?: number;
}

/** 项目背景 + 分类定义 + 改判示例 + 一批交易 → 分类（§5.4） */
export async function classifyTask(taskId: number, opts: ClassifyOptions = {}): Promise<ClassifyOutcome> {
  const ctx = taskContext(taskId);
  if (!ctx) return { total: 0, classified: 0, lowConfidence: 0, message: '任务不存在' };
  const cats = getCategorySet();

  const fileClause = opts.fileId ? 'AND t.file_id = ?' : '';
  const srcClause = opts.force
    ? "AND (t.category IS NULL OR t.category_src != 'manual')"
    : 'AND t.category IS NULL';
  const args: unknown[] = [taskId];
  if (opts.fileId) args.push(opts.fileId);
  const rows = db
    .prepare(
      `SELECT t.id, t.date, t.summary, t.amount, t.direction, t.counterparty, t.counterparty_account,
              t.channel, t.review_note, t.status, fua.fund_use_id, f.account_no,
              CASE WHEN fua.use_role = '${TRANSIT_USE_ROLE}' THEN '${TRANSIT_FUND_USE_LABEL}' ELSE fu.name END AS fund_use_name
       FROM transactions t
       JOIN files f ON f.id = t.file_id
       LEFT JOIN fund_use_accounts fua
         ON fua.account_key = UPPER(REPLACE(REPLACE(REPLACE(REPLACE(IFNULL(f.account_no, ''), ' ', ''), char(9), ''), '-', ''), '　', ''))
        AND fua.project_id = (SELECT project_id FROM tasks WHERE id = f.task_id)
       LEFT JOIN fund_uses fu ON fu.id = fua.fund_use_id
       WHERE f.task_id = ? ${fileClause} ${srcClause}
       ORDER BY t.date IS NULL, t.date, f.rel_path, t.page, t.line_no, t.id`,
    )
    .all(...args) as Array<Record<string, unknown>>;
  if (rows.length === 0) {
    return { total: 0, classified: 0, lowConfidence: 0, message: '没有待分类的交易' };
  }

  const settings = getSettings();
  const examples = manualExamples();
  const catDefs = cats
    .map((c) => `- ${c}：${CATEGORY_DEFS[c] ?? '自定义分类，按名称含义归类'}`)
    .join('\n');
  const acctLines = ctx.accounts.length
    ? ctx.accounts.map((a) => `- ${bankShort(a.bank)} ${a.accountNo.replace(/.(?=.{4}$)/g, '*')} 开户主体=${a.holder || '未填'}`).join('\n')
    : '（未登记）';
  const exampleLines = examples.length
    ? examples
        .map((e, i) => `${i + 1}. 对手=${e.counterparty || '—'} 摘要=${e.summary || '—'} → ${e.category}`)
        .join('\n')
    : '';

  const system = `你是上市公司募集资金专户的银行流水分类助手。对每笔交易从分类集中选唯一最贴切的一项，依据是摘要、对手方、渠道、方向和金额；涉及募投项目的，结合所属募投项目判断是否项目投入。拿不准时选最接近的一项并把 confidence 降低。输出严格 JSON，不要代码块：{"results":[{"id":1,"category":"分类名","confidence":0.9}]}`;

  const up = db.prepare(`UPDATE transactions SET category = ?, category_src = 'llm' WHERE id = ?`);
  const noteUp = db.prepare('UPDATE transactions SET review_note = ?, status = ? WHERE id = ?');
  let classified = 0;
  let lowConfidence = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const txLines = batch.map((r) =>
      txLine({
        id: Number(r.id),
        date: String(r.date ?? '').trim() || undefined,
        summary: String(r.summary ?? '').trim() || undefined,
        amount: Number(r.amount),
        direction: r.direction === 'in' ? 'in' : 'out',
        counterparty: String(r.counterparty ?? '').trim() || undefined,
        counterpartyAccount: String(r.counterparty_account ?? '').trim() || undefined,
        channel: String(r.channel ?? '').trim() || undefined,
        fundUse: String(r.fund_use_name ?? '').trim() || undefined,
      }),
    );
    const user = `客户：${ctx.clientName}
融资项目：${ctx.projectName}
报告期任务：${ctx.taskName}
募投项目：${ctx.fundUses.length ? ctx.fundUses.join('、') : '（未登记）'}
已登记募资专户：
${acctLines}

分类集（只能从这里选）：
${catDefs}
${exampleLines ? `\n人工改判示例（最近 ${examples.length} 条，优先按这个口径）：\n${exampleLines}\n` : ''}
待分类交易（id\t日期\t收付\t金额\t对手户名\t对手账号\t摘要\t渠道\t所属募投项目）：
${txLines.join('\n')}

输出 JSON（每笔一条，id 必须与输入一致）：`;

    const content = await llmChat(
      settings.llmBase,
      settings.llmModel,
      settings.llmExtraHeader || undefined,
      system,
      user,
      { jsonMode: true, maxTokens: 4000, timeoutMs: 300_000 },
    );
    const parsed = extractJson<{ results?: Array<{ id?: unknown; category?: unknown; confidence?: unknown }> }>(content);
    const byId = new Map(batch.map((r) => [Number(r.id), r]));
    for (const item of parsed.results ?? []) {
      const id = Number(item.id);
      const row = byId.get(id);
      if (!row) continue;
      let category = String(item.category ?? '').trim();
      if (!cats.includes(category)) category = cats.includes('其他') ? '其他' : cats[cats.length - 1];
      const conf = typeof item.confidence === 'number' ? Math.max(0, Math.min(1, item.confidence)) : 1;
      up.run(category, id);
      classified++;
      if (conf < LOW_CONF) {
        lowConfidence++;
        const note = `分类未确认(${Math.round(conf * 100)}%)`;
        const prev = String(row.review_note ?? '').trim();
        noteUp.run(prev ? `${prev}；${note}` : note, row.status === 'ok' ? 'needs_review' : row.status, id);
      }
    }
  }

  return { total: rows.length, classified, lowConfidence, message: undefined };
}

/** 任务级「LLM 分类」按钮（main 路由挂 /api/tasks） */
export const categorizeTasksRouter = Router();
const running = new Map<number, Promise<ClassifyOutcome>>();

categorizeTasksRouter.post('/:id/categorize', async (req, res) => {
  const id = Number(req.params.id);
  const force = Boolean((req.body as { force?: boolean } | undefined)?.force);
  if (!Number.isFinite(id) || !db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(id)) {
    return res.status(404).json({ error: '任务不存在' });
  }
  let job = running.get(id);
  if (!job) {
    job = classifyTask(id, { force }).finally(() => running.delete(id));
    running.set(id, job);
  }
  try {
    res.json(await job);
  } catch (e) {
    res.status(502).json({ error: `LLM 分类失败：${(e as Error).message}` });
  }
});

/** 去掉「分类未确认」段（人工改判/确认后调用；余额断裂等其它提示保留） */
export function stripClassNote(note: string | null): string | null {
  if (!note) return null;
  const cleaned = note
    .split('；')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('分类未确认'))
    .join('；');
  return cleaned || null;
}

/** 批量改判（分析页按线路打标 / 交易页多选，M4）：写交易级 category，事实源唯一 */
export function bulkCategory(ids: number[], category: string | null): number {
  const clean = [...new Set(ids.map((n) => Number(n)).filter((n) => Number.isFinite(n)))];
  if (clean.length === 0) return 0;
  if (category != null && String(category).trim() === '') {
    category = null;
  }
  const upd = db.prepare('UPDATE transactions SET category = ?, category_src = ? WHERE id = ?');
  const n = db.transaction(() => {
    let c = 0;
    for (const id of clean) {
      if (upd.run(category || null, category ? 'manual' : null, id).changes > 0) c++;
      if (category) {
        // 人工确认了分类 → 清掉「分类未确认」提示；提示空了就回到正常
        const cur = (db.prepare('SELECT review_note, status FROM transactions WHERE id = ?').get(id) as
          | { review_note: string | null; status: string }
          | undefined);
        const stripped = stripClassNote(cur?.review_note ?? null);
        if (stripped !== (cur?.review_note ?? null)) {
          const status = stripped == null && cur?.status === 'needs_review' ? 'ok' : cur?.status;
          db.prepare('UPDATE transactions SET review_note = ?, status = ? WHERE id = ?').run(stripped ?? null, status, id);
        }
      }
    }
    return c;
  })();
  return n;
}

/** 单行改判（PATCH /api/transactions/:id 用）：category=null 清除 */
export function setTxCategory(id: number, category: string | null): boolean {
  const r = db
    .prepare('UPDATE transactions SET category = ?, category_src = ? WHERE id = ?')
    .run(category, category ? 'manual' : null, id);
  if (r.changes > 0 && category) {
    const cur = (db.prepare('SELECT review_note FROM transactions WHERE id = ?').get(id) as
      | { review_note: string | null }
      | undefined)?.review_note;
    const stripped = stripClassNote(cur ?? null);
    if (stripped !== (cur ?? null)) {
      db.prepare('UPDATE transactions SET review_note = ? WHERE id = ?').run(stripped ?? null, id);
    }
  }
  return r.changes > 0;
}

/**
 * 解析管线（M2：文字层通道）
 *
 * PDF →（pdfjs 文字层）→ 布局保真文本（行重建：y 中心聚类，行内 x 排序，大间距制表符）
 * →（LLM 结构化，≤3 页/批 + 上批末 3 行衔接）→ 交易入库 + 确定性质检
 *
 * 扫描件（无文字层）在 M2 标记为 error「疑似扫描件」，M3 走 OCR 通道。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { db } from './db.js';
import { getSettings } from './settings.js';
import { extractJson, llmChat } from './ai.js';
import { scanPdfFiles } from './fsutil.js';

const require = createRequire(import.meta.url);

/* ---------- pdfjs（惰性加载；Node 端用 legacy 构建 + fs 直读 standard_fonts/cmaps） ---------- */

let pdfjsPromise: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | null = null;

/** pdfjs 的 Node 工厂用 fs.readFile(file: 字符串) 会按路径找文件，ENOENT → 这里直接 fileURLToPath 读 */
class FSDataFactory {
  constructor(opts: { cMapUrl?: string; standardFontDataUrl?: string; wasmUrl?: string } = {}) {
    this.cMapUrl = opts.cMapUrl;
    this.standardFontDataUrl = opts.standardFontDataUrl;
    this.wasmUrl = opts.wasmUrl;
  }
  cMapUrl?: string;
  standardFontDataUrl?: string;
  wasmUrl?: string;
  async fetch({ kind, filename }: { kind: string; filename: string }) {
    const baseUrl = (this as unknown as Record<string, string | undefined>)[kind];
    if (!baseUrl) throw new Error(`${kind} not provided`);
    const buf = await readFile(fileURLToPath(`${baseUrl}${filename}`));
    return new Uint8Array(buf);
  }
}

function loadPdfjs(): Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const mod = await import('pdfjs-dist/legacy/build/pdf.mjs');
      return mod;
    })();
  }
  return pdfjsPromise;
}

/** pdfjs-dist 资源目录（standard_fonts/cmaps 所在包目录；dev=仓库 pnpm 树，zip=包内 node_modules） */
function pdfjsResourceUrls(): { standardFontDataUrl: string; cMapUrl: string } {
  const pkgDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
  return {
    standardFontDataUrl: pathToFileURL(path.join(pkgDir, 'standard_fonts') + '/').href,
    cMapUrl: pathToFileURL(path.join(pkgDir, 'cmaps') + '/').href,
  };
}

/* ---------- 行重建（§3.2：按 y 中心聚类，容差=行高中位 50%；行内按 x 排序拼格） ---------- */

interface TextPt {
  x: number;
  y: number; // 行中心
  w: number;
  str: string;
}

export interface PageLines {
  /** 布局保真行（每行一格），索引 = line_no - 1 */
  lines: string[];
  /** 该页非空文本字符数（<20 视为疑似扫描件） */
  chars: number;
}

/** pdfjs TextItem → 行重建。纯函数，便于单测 */
export function rebuildLines(items: Array<{ str: string; transform: number[]; width: number; height: number }>): string[] {
  const pts: TextPt[] = items
    .filter((i) => i.str && i.str.trim().length > 0)
    .map((i) => ({
      x: i.transform[4],
      y: i.transform[5] + (i.height || 0) / 2,
      w: i.width || 0,
      str: i.str,
    }));
  if (pts.length === 0) return [];
  const hs = items.map((i) => i.height || 0).filter((h) => h > 0).sort((a, b) => a - b);
  const medH = hs.length ? hs[Math.floor(hs.length / 2)] : 9;
  const tol = Math.max(2, medH * 0.5); // 行高 50%
  const rows: { y: number; items: TextPt[] }[] = [];
  for (const p of [...pts].sort((a, b) => b.y - a.y)) {
    const row = rows.find((r) => Math.abs(r.y - p.y) <= tol);
    if (row) {
      row.items.push(p);
      row.y = (row.y * (row.items.length - 1) + p.y) / row.items.length; // 跟踪均值，防漂移
    } else {
      rows.push({ y: p.y, items: [p] });
    }
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => {
    const sorted = [...r.items].sort((a, b) => a.x - b.x);
    let out = '';
    for (let i = 0; i < sorted.length; i++) {
      if (i > 0) {
        const gap = sorted[i].x - (sorted[i - 1].x + sorted[i - 1].w);
        out += gap > 10 ? '\t' : gap > 2 ? ' ' : '';
      }
      out += sorted[i].str;
    }
    return out;
  });
}

/** 提取 PDF 全部页的文字层 → 布局保真行；返回每页行 + 字符数 */
export async function extractTextLines(pdfPath: string): Promise<PageLines[]> {
  const pdfjs = await loadPdfjs();
  const bytes = await readFile(pdfPath);
  const urls = pdfjsResourceUrls();
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useWorkerFetch: false,
    isEvalSupported: false,
    cMapData: true,
    standardFontDataUrl: urls.standardFontDataUrl,
    cMapUrl: urls.cMapUrl,
    BinaryDataFactory: FSDataFactory,
  } as unknown as Parameters<typeof pdfjs.getDocument>[0]);
  const doc = await task.promise;
  const out: PageLines[] = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const lines = rebuildLines(content.items as Array<{ str: string; transform: number[]; width: number; height: number }>);
      out.push({ lines, chars: lines.join('\n').length });
    }
  } finally {
    await task.destroy();
  }
  return out;
}

/* ---------- LLM 结构化（§5.2：单批 ≤3 页 + 上页末 3 行衔接，温度 0，严格 JSON） ---------- */

const BATCH_PAGES = 3;

const LLM_SYSTEM = `你是银行流水结构化助手。输入是银行流水 PDF 的布局保真文本（每页若干行，行首是行号，列之间用制表符分隔）。
请按页面从上到下的顺序逐笔抽取，输出严格 JSON（不要代码块、不要解释）：
{"bank":"银行名或null","account_no":"账号纯数字或null","account_name":"户名或null","period_start":"YYYY-MM-DD或null","period_end":"YYYY-MM-DD或null",
"transactions":[{"page":1,"line_no":N,"date":"YYYY-MM-DD","summary":"摘要","amount":123.45,"direction":"in","balance":123.45,
"counterparty":"对方户名或null","counterparty_account":"对方账号或null","channel":"渠道或null","confidence":0.95}]}
规则（照抄原文，禁止用余额反推）：
- 每一行交易原样输出一条，顺序与该页从上到下一致。不要合并、拆分，不要为了让余额连续而增删行或改数字。
- 支出列有数字 → direction="out"，amount=支出列印出的数字（正数，去掉千分位）。
- 收入列有数字 → direction="in"，amount=收入列印出的数字（正数）。
- 禁止用「余额相对上一行的增减」反推金额或方向。即使余额对不上，也要照抄该行的支出、收入和余额。
- balance 只填该行印出的余额，没有则 null。禁止用上期余额±金额去填写或改写余额。
- 日期、摘要、对方户名、对方账号只从该行抄。日期统一 YYYY-MM-DD。
- 表头、本页合计、上页结转、承前余额等非交易行不要输出。
- line_no = 该交易在对应页布局文本中的行号（行首编号，1 起）。
- 看不清支出/收入列时：amount 仍填该行能看到的金额，direction 选更接近原文的一侧，confidence 降到 0.5 以下。不要编造一个能对上余额的数字。
- 页眉的银行/账号/户名/期间填进顶层字段。`;

function pageBlock(fileRel: string, p: number, total: number, lines: string[], firstLineNo: number): string {
  const body = lines.map((l, i) => `${firstLineNo + i}: ${l}`.trimEnd()).join('\n');
  return `[流水 ${fileRel} · 第 ${p}/${total} 页]\n${body || '(空页)'}`;
}

/** 归一化 LLM 输出的一笔交易 */
export interface NormTx {
  page: number;
  lineNo: number;
  date?: string;
  summary?: string;
  amount: number;
  direction: 'in' | 'out';
  balance?: number;
  counterparty?: string;
  counterpartyAccount?: string;
  channel?: string;
  confidence: number;
  /** 质检备注（非空 → status=needs_review） */
  review: string;
}

function numOrNull(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.replace(/,/g, '').replace(/[¥\u00a5\s]/g, ''));
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function cleanStr(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().replace(/\s+/g, ' ');
  if (!s || /^(null|none|n\/a|-{1,3}|未知)$/i.test(s)) return undefined;
  return s;
}

/** 去掉旧的余额断裂提示，保留日期/置信度等其它复核原因 */
export function stripBalanceNote(note: string): string {
  return note
    .split('；')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('余额断裂'))
    .join('；');
}

/** 上一行印出的余额 ± 本行印出的金额，与本行印出的余额比较。不改任何交易字段。 */
export function balanceGapNote(
  prevBalance: number,
  direction: 'in' | 'out',
  amount: number,
  balance: number,
): string | null {
  const expected = Math.round((prevBalance + (direction === 'in' ? amount : -amount)) * 100) / 100;
  const shown = Math.round(balance * 100) / 100;
  if (Math.abs(expected - shown) > 0.01) {
    return `余额断裂(复算 ${expected.toFixed(2)} ≠ 显示 ${shown.toFixed(2)})`;
  }
  return null;
}

/** 按流水印刷顺序标注余额断裂。只改 review 文本。 */
export function annotateBalanceReviews(txs: NormTx[]): void {
  const ordered = [...txs].sort((a, b) => a.page - b.page || a.lineNo - b.lineNo);
  let prev: number | undefined;
  for (const t of ordered) {
    t.review = stripBalanceNote(t.review);
    if (prev != null && t.balance != null) {
      const note = balanceGapNote(prev, t.direction, t.amount, t.balance);
      if (note) t.review = t.review ? `${t.review}；${note}` : note;
    }
    if (t.balance != null) prev = t.balance;
  }
}

/**
 * 人工改完一行后，按印刷顺序重算该文件的复核提示（M3：修正后复算）。
 * 只更新 review_note / status，不回写金额、方向、余额、日期。
 * editedId：这次人工保存的行；复算通过则标 fixed。
 */
export function recomputeFileBalanceReviews(fileId: number, editedId?: number): number {
  const rows = db
    .prepare(
      `SELECT id, page, line_no, amount, direction, balance, review_note, status
       FROM transactions WHERE file_id = ? ORDER BY page, line_no, id`,
    )
    .all(fileId) as Array<{
    id: number;
    page: number;
    line_no: number;
    amount: number;
    direction: 'in' | 'out';
    balance: number | null;
    review_note: string | null;
    status: string;
  }>;
  const upd = db.prepare('UPDATE transactions SET review_note = ?, status = ? WHERE id = ?');
  let prev: number | undefined;
  let reviewCount = 0;
  const apply = db.transaction(() => {
    for (const r of rows) {
      let note = stripBalanceNote(r.review_note ?? '');
      if (prev != null && r.balance != null) {
        const gap = balanceGapNote(prev, r.direction, Number(r.amount), Number(r.balance));
        if (gap) note = note ? `${note}；${gap}` : gap;
      }
      if (r.balance != null) prev = Number(r.balance);
      const status = note ? 'needs_review' : r.id === editedId || r.status === 'fixed' ? 'fixed' : 'ok';
      if (note) reviewCount++;
      upd.run(note || null, status, r.id);
    }
    db.prepare(
      `UPDATE files SET status = ?, updated_at = ? WHERE id = ? AND status IN ('done','needs_review')`,
    ).run(reviewCount > 0 ? 'needs_review' : 'done', new Date().toISOString(), fileId);
  });
  apply();
  return reviewCount;
}

function normalizeTxs(raw: unknown, totalPages: number): NormTx[] {
  if (!Array.isArray(raw)) return [];
  const out: NormTx[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const t = r as Record<string, unknown>;
    const page = Math.max(1, Math.min(totalPages, Math.round(numOrNull(t.page) ?? 1)));
    const lineNo = Math.max(0, Math.round(numOrNull(t.line_no) ?? 0));
    const amount = Math.abs(numOrNull(t.amount) ?? NaN);
    if (!Number.isFinite(amount) || amount <= 0) continue; // 无金额的不成行（表头/合计行）
    const dirRaw = String(t.direction ?? '').toLowerCase();
    // 先判 out（'outflow' 含 'out' 不含 'in'；'withdraw' 等），再判 in
    const isOut = /out|withdraw|debit|支出|付|借/.test(dirRaw);
    const isIn = /\bin\b|^in|inflow|income|deposit|credit|收入|贷/.test(dirRaw);
    const dirOk = isOut || isIn;
    const direction: 'in' | 'out' = isOut ? 'out' : 'in';
    const review: string[] = [];
    const date = cleanStr(t.date);
    if (!date) review.push('日期缺失');
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) review.push(`日期格式异常(${date})`);
    const confidence = numOrNull(t.confidence) ?? 1;
    if (confidence < 0.8) review.push(`低置信(${confidence.toFixed(2)})`);
    if (lineNo === 0) review.push('行号缺失');
    const bal = numOrNull(t.balance);
    const summary = cleanStr(t.summary);
    if (!summary) review.push('摘要缺失');
    if (!dirOk) review.push('收付方向未识别');
    out.push({
      page,
      lineNo,
      date,
      summary,
      amount: Math.round(amount * 100) / 100,
      direction,
      balance: bal,
      counterparty: cleanStr(t.counterparty),
      counterpartyAccount: cleanStr(t.counterparty_account),
      channel: cleanStr(t.channel),
      confidence: Math.max(0, Math.min(1, confidence)),
      review: review.join('；'),
    });
  }
  return out;
}

export interface StructuredBatch {
  bank?: string;
  accountNo?: string;
  accountName?: string;
  periodStart?: string;
  periodEnd?: string;
  txs: NormTx[];
}

/** LLM 结构化一批（≤3 页）；prevTail = 上批最后 3 行（跨页衔接，§5.2） */
export async function structureBatch(
  settings: { llmBase: string; llmModel: string; llmExtraHeader: string },
  fileRel: string,
  pages: Array<{ p: number; lines: string[] }>,
  totalPages: number,
  prevTail?: string,
): Promise<StructuredBatch> {
  const blocks = pages.map(({ p, lines }) => pageBlock(fileRel, p, totalPages, lines, 1));
  const user =
    (prevTail ? `【上批末 3 行（跨页衔接，供余额/摘要参考）】\n${prevTail}\n\n` : '') +
    blocks.join('\n\n') +
    `\n\n输出 JSON：`;
  const content = await llmChat(settings.llmBase, settings.llmModel, settings.llmExtraHeader || undefined, LLM_SYSTEM, user, {
    jsonMode: true,
    maxTokens: 12000,
  });
  const j = extractJson<Record<string, unknown>>(content);
  const txs = normalizeTxs(j.transactions, totalPages);
  return {
    bank: cleanStr(j.bank),
    accountNo: cleanStr(j.account_no),
    accountName: cleanStr(j.account_name),
    periodStart: cleanStr(j.period_start),
    periodEnd: cleanStr(j.period_end),
    txs,
  };
}

/* ---------- 文件解析编排 + 入库 ---------- */

export interface ParseOutcome {
  fileId: number;
  status: 'done' | 'needs_review' | 'error';
  txCount: number;
  reviewCount: number;
  error?: string;
}

const now = () => new Date().toISOString();

function setFile(fileId: number, patch: Record<string, unknown>): void {
  const sets = Object.keys(patch)
    .map((k) => `${k} = ?`)
    .join(', ');
  const vals = Object.values(patch);
  db.prepare(`UPDATE files SET ${sets}, updated_at = ? WHERE id = ?`).run(...vals, now(), fileId);
}

/** 解析单个文件（文字层通道）。调用方负责状态置 parsing 与并发控制 */
export async function parseFileTextLayer(fileId: number): Promise<ParseOutcome> {
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId) as Record<string, unknown> | undefined;
  if (!file) throw new Error('文件登记不存在（任务被删除？）');
  const task = db.prepare('SELECT folder_path FROM tasks WHERE id = ?').get(Number(file.task_id)) as
    | { folder_path: string }
    | undefined;
  if (!task) throw new Error('任务不存在');
  const absPath = path.resolve(task.folder_path, String(file.rel_path));

  // 1) 文字层提取 + 行重建
  let pages: PageLines[];
  try {
    pages = await extractTextLines(absPath);
  } catch (e) {
    return finishError(fileId, `PDF 读取失败：${(e as Error).message}`);
  }
  if (pages.length === 0) return finishError(fileId, 'PDF 无页面');
  const totalChars = pages.reduce((s, p) => s + p.chars, 0);
  if (totalChars < 20) {
    return finishError(fileId, '文字层缺失（疑似扫描件），M3 接入 OCR 通道后自动解析');
  }

  // 2) LLM 结构化（≤3 页/批，上批末 3 行衔接）
  const s = getSettings();
  const pagesMeta: Array<{ p: number; lines: string[] }> = [];
  const all: NormTx[] = [];
  let meta: Partial<StructuredBatch> = {};
  let prevTail: string | undefined;
  for (let i = 0; i < pages.length; i += BATCH_PAGES) {
    const blockPages = pages
      .slice(i, i + BATCH_PAGES)
      .map((pl, k) => ({ p: i + k + 1, lines: pl.lines }));
    const r = await structureBatch(s, String(file.rel_path), blockPages, pages.length, prevTail);
    if (r.bank) meta.bank = r.bank;
    if (r.accountNo) meta.accountNo = r.accountNo;
    if (r.accountName) meta.accountName = r.accountName;
    if (r.periodStart) meta.periodStart = r.periodStart;
    if (r.periodEnd) meta.periodEnd = r.periodEnd;
    all.push(...r.txs);
    // 上批末 3 行：最后 3 笔交易的原始行文本
    const last3 = r.txs.slice(-3);
    prevTail = last3.length
      ? last3
          .map((t) => {
            const pl = pages[t.page - 1];
            const raw = pl && t.lineNo >= 1 && t.lineNo <= pl.lines.length ? pl.lines[t.lineNo - 1] : undefined;
            return raw ? `[p${t.page} 行${t.lineNo}] ${raw.trim()}` : null;
          })
          .filter(Boolean)
          .join('\n')
      : undefined;
  }

  // 3) 余额连续性（M3 §5.5）：只追加复核提示，不改金额/方向/余额/日期。
  // 复算顺序 = 流水印刷顺序（页、行）。按日期重排会打乱同日多笔，和原文对不上。
  annotateBalanceReviews(all);

  // 4) 入库（重解析先清旧数据）+ 质检标记
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM rule_hits WHERE transaction_id IN (SELECT id FROM transactions WHERE file_id = ?)').run(fileId);
    db.prepare('DELETE FROM transactions WHERE file_id = ?').run(fileId);
    const ins = db.prepare(
      `INSERT INTO transactions(file_id, page, line_no, date, summary, amount, direction, balance,
        counterparty, counterparty_account, channel, confidence, review_note, raw_text, status)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    let reviewCount = 0;
    const inOrder = [...all].sort((a, b) => a.page - b.page || a.lineNo - b.lineNo);
    for (const t of inOrder) {
      const pl = pages[t.page - 1];
      const raw = pl && t.lineNo >= 1 && t.lineNo <= pl.lines.length ? pl.lines[t.lineNo - 1]?.trim() : undefined;
      if (!raw && !t.review) t.review = '行号越界（对不上原始行）';
      const status = t.review ? 'needs_review' : 'ok';
      if (t.review) reviewCount++;
      ins.run(
        fileId,
        t.page,
        t.lineNo || 0,
        t.date ?? null,
        t.summary ?? null,
        t.amount,
        t.direction,
        t.balance ?? null,
        t.counterparty ?? null,
        t.counterpartyAccount ?? null,
        t.channel ?? null,
        t.confidence,
        t.review || null,
        raw ?? null,
        status,
      );
    }
    return reviewCount;
  });
  const reviewCount = tx();

  // 5) 文件元数据回写（不覆盖已填）
  const patch: Record<string, unknown> = { tx_count: all.length, error: null };
  if (!file.bank && meta.bank) patch.bank = meta.bank;
  if (!file.account_no && meta.accountNo) patch.account_no = meta.accountNo;
  if (!file.account_name && meta.accountName) patch.account_name = meta.accountName;
  if (!file.period_start && meta.periodStart) patch.period_start = meta.periodStart;
  if (!file.period_end && meta.periodEnd) patch.period_end = meta.periodEnd;
  patch.status = reviewCount > 0 ? 'needs_review' : 'done';
  setFile(fileId, patch);
  return { fileId, status: reviewCount > 0 ? 'needs_review' : 'done', txCount: all.length, reviewCount };
}

function finishError(fileId: number, msg: string): ParseOutcome {
  setFile(fileId, { status: 'error', error: msg });
  return { fileId, status: 'error', txCount: 0, reviewCount: 0, error: msg };
}

/* ---------- 解析队列（LLM 并发 = settings.llmConcurrency，§3.2 默认 2） ---------- */

export class ParseQueue {
  private queue: number[] = [];
  private inflight = new Set<number>();
  private workerStarted = false;

  /** 入队（幂等：已排队/解析中则跳过）。返回是否入队 */
  enqueue(fileId: number): boolean {
    if (this.inflight.has(fileId) || this.queue.includes(fileId)) return false;
    this.queue.push(fileId);
    return true;
  }

  get pending(): number {
    return this.queue.length + this.inflight.size;
  }

  /** 服务启动时调一次：常驻轮询（新任务/新文件随时入队） */
  start(): void {
    if (this.workerStarted) return;
    this.workerStarted = true;
    void this.pump();
  }

  private async pump(): Promise<void> {
    for (;;) {
      const cap = Math.min(4, Math.max(1, getSettings().llmConcurrency));
      while (this.inflight.size < cap && this.queue.length > 0) {
        const fileId = this.queue.shift()!;
        this.inflight.add(fileId);
        console.log(`[parse] 开始解析 file#${fileId}（并发 ${this.inflight.size}/${cap}）`);
        void this.runOne(fileId).finally(() => {
          this.inflight.delete(fileId);
        });
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  private async runOne(fileId: number): Promise<void> {
    // 任务/文件可能已被删除
    const exists = db.prepare('SELECT 1 FROM files WHERE id = ?').get(fileId);
    if (!exists) return;
    setFile(fileId, { status: 'parsing', error: null });
    try {
      await parseFileTextLayer(fileId);
    } catch (e) {
      finishError(fileId, (e as Error).message);
    }
  }
}

export const parseQueue = new ParseQueue();

/** 启动自愈：被打断的 parsing 复位 scanned，并自动开跑未解析的文件（M2 验收：放 PDF 自动出交易表） */
export function autoParsePending(): void {
  db.prepare(`UPDATE files SET status = 'scanned' WHERE status = 'parsing'`).run();
  const pending = (
    db.prepare(`SELECT id FROM files WHERE status = 'scanned' AND tx_count = 0`).all() as { id: number }[]
  ).map((r) => r.id);
  for (const id of pending) parseQueue.enqueue(id);
}

/** chokidar 新 PDF 登记后调用：只自动解析新登记的文件 */
export function enqueueNewFile(taskId: number, relPath: string): boolean {
  const r = db
    .prepare(`INSERT OR IGNORE INTO files(task_id, rel_path, status, updated_at) VALUES(?, ?, 'scanned', ?)`)
    .run(taskId, relPath, now());
  if (r.changes > 0) {
    db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now(), taskId);
    return parseQueue.enqueue(Number(r.lastInsertRowid));
  }
  return false;
}

/** 任务目录扫描（幂等登记 + 自动解析新文件），返回新增数量 */
export function refreshTaskFilesAuto(taskId: number, folderPath: string): number {
  let added = 0;
  for (const rel of scanPdfFiles(folderPath)) {
    if (enqueueNewFile(taskId, rel)) added++;
  }
  db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now(), taskId);
  return added;
}

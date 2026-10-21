/**
 * 解析管线（视觉通道）
 *
 * PDF → 逐页渲染成 JPEG → 视觉模型按图读表 → 结构化 JSON → 余额复核 → 入库
 *
 * 文字层会把空的支出/收入列丢掉，所以不再先判断是不是扫描件。
 * 文字层提取函数仍留着，当前解析不走它。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { db } from './db.js';
import { getSettings, llmProfileById } from './settings.js';
import { extractJson, isAbortError, llmChat, probeLLM } from './ai.js';
import { LlmProfile, ParseStep, ParseStepState } from '@flow/shared';
import { classifyTask } from './categorize.js';
import { scanPdfFiles } from './fsutil.js';

const require = createRequire(import.meta.url);

/* ---------- pdfjs（惰性加载；Node 端用 legacy 构建 + fs 直读 standard_fonts/cmaps/wasm） ---------- */

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

/**
 * pdfjs-dist 资源目录（standard_fonts/cmaps/wasm 所在包目录；dev=仓库 pnpm 树，zip=包内 node_modules）。
 * wasm 不能省：JPEG2000（JPX）/JBIG2 扫描页要靠它解码，缺了整页会渲染成白纸。
 */
function pdfjsResourceUrls(): { standardFontDataUrl: string; cMapUrl: string; wasmUrl: string } {
  const pkgDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
  return {
    standardFontDataUrl: pathToFileURL(path.join(pkgDir, 'standard_fonts') + '/').href,
    cMapUrl: pathToFileURL(path.join(pkgDir, 'cmaps') + '/').href,
    wasmUrl: pathToFileURL(path.join(pkgDir, 'wasm') + '/').href,
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

/** 提取 PDF 全部页的文字层 → 布局保真行；onPage 用来把「读到第几页」写进进度 */
export async function extractTextLines(
  pdfPath: string,
  onPage?: (done: number, total: number) => void,
): Promise<PageLines[]> {
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
    wasmUrl: urls.wasmUrl,
    BinaryDataFactory: FSDataFactory,
  } as unknown as Parameters<typeof pdfjs.getDocument>[0]);
  const doc = await task.promise;
  const out: PageLines[] = [];
  const total = doc.numPages;
  onPage?.(0, total);
  try {
    for (let p = 1; p <= total; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const lines = rebuildLines(content.items as Array<{ str: string; transform: number[]; width: number; height: number }>);
      out.push({ lines, chars: lines.join('\n').length });
      onPage?.(p, total);
    }
  } finally {
    await task.destroy();
  }
  return out;
}

/* ---------- 渲染（全部页面先转图，再交给视觉模型；不区分扫描件） ---------- */

export interface PageImage {
  page: number;
  jpeg: Buffer;
}

const RENDER_LONG_EDGE = 2200;

interface CanvasModule {
  createCanvas(width: number, height: number): {
    width: number;
    height: number;
    toBuffer(mime: 'image/jpeg', quality?: number): Buffer;
  };
}

async function loadCanvas(): Promise<CanvasModule> {
  try {
    return (await import('@napi-rs/canvas')) as CanvasModule;
  } catch (e) {
    throw new Error(`无法渲染页面，缺少 @napi-rs/canvas：${(e as Error).message}`);
  }
}

async function openPdf(pdfPath: string) {
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
    wasmUrl: urls.wasmUrl,
    BinaryDataFactory: FSDataFactory,
  } as unknown as Parameters<typeof pdfjs.getDocument>[0]);
  return task;
}

/** 每页渲染成一张 JPEG。长边约 2200 像素，表格线还在，体积适合视觉模型。onlyPages 只渲染这些页。 */
export async function renderPdfPages(
  pdfPath: string,
  onPage?: (done: number, total: number) => void | Promise<void>,
  onlyPages?: number[],
): Promise<{ images: PageImage[]; totalPages: number }> {
  const canvasMod = await loadCanvas();
  const task = await openPdf(pdfPath);
  const doc = await task.promise;
  const out: PageImage[] = [];
  const totalPages = doc.numPages;
  const list = onlyPages?.length
    ? [...new Set(onlyPages.filter((p) => p >= 1 && p <= totalPages))].sort((a, b) => a - b)
    : Array.from({ length: totalPages }, (_, i) => i + 1);
  try {
    await onPage?.(0, list.length);
    for (const p of list) {
      const page = await doc.getPage(p);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(RENDER_LONG_EDGE / Math.max(base.width, base.height), 200 / 72);
      const viewport = page.getViewport({ scale });
      const canvas = canvasMod.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise;
      out.push({ page: p, jpeg: canvas.toBuffer('image/jpeg', 82) });
      page.cleanup?.();
      await onPage?.(out.length, list.length);
    }
  } finally {
    await task.destroy();
  }
  return { images: out, totalPages };
}

export async function countPdfPages(pdfPath: string): Promise<number> {
  const task = await openPdf(pdfPath);
  try {
    const doc = await task.promise;
    return doc.numPages;
  } finally {
    await task.destroy();
  }
}

/* ---------- LLM 结构化（视觉读图，一页一次，温度 0，严格 JSON） ---------- */

const VISION_SYSTEM = `你是银行流水识别助手。输入是银行流水的一页图片。请只根据图上印出来的内容抽取，输出严格 JSON（不要代码块、不要解释）：
{"bank":"银行名或null","account_no":"账号纯数字或null","account_name":"户名或null","period_start":"YYYY-MM-DD或null","period_end":"YYYY-MM-DD或null",
"transactions":[{"line_no":1,"date":"YYYY-MM-DD","summary":"摘要","amount":123.45,"direction":"out","balance":123.45,
"counterparty":"对方户名或null","counterparty_account":"对方账号或null","channel":"付款用途或渠道或null","confidence":0.95,
"raw":"该行各列原文，用 | 隔开，空列留空"}]}
规则（照抄图上的字，禁止用余额反推）：
- 按表格从上到下，每一笔交易一条。单元格里户名折成两行仍是同一笔，不要拆开。
- 支出列有数字 → direction="out"，amount=支出列印出的数字（正数，去掉千分位）。
- 收入列有数字 → direction="in"，amount=收入列印出的数字（正数）。
- 支出和收入是相邻两列。一列为空就不要把另一列的数字抄过去。
- 禁止用「余额相对上一行的增减」反推金额或方向。即使余额对不上，也要照抄该行的支出、收入和余额。
- balance 只填该行印出的余额，没有则 null。余额印成 0 就填 0，不要改成 null。
- 日期、摘要、对方户名、对方账号、付款用途只从该行抄。日期统一 YYYY-MM-DD。付款用途放 channel。
- raw 按列从左到右抄该行，列之间用「 | 」，空着的支出或收入列保留空位。
- 表头、页眉页脚、页码、印章、本页合计、上页结转、承前余额不要输出。
- line_no 从 1 起，按本页交易从上到下编号。
- 看不清支出/收入列时：amount 填该行能看到的金额，direction 选更接近的一侧，confidence 降到 0.5 以下。不要编造一个能对上余额的数字。
- 页眉的银行、账号、户名、查询期间填进顶层字段。本页没有就 null。`;

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
  /** 图上该行原文，列用 | 隔开，供肉眼对照 */
  raw?: string;
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

function asciiDigits(s: string): string {
  return s.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30));
}

function calendarDate(y: number, m: number, d: number): string | undefined {
  if (y < 1970 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return undefined;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * 银行流水上常见的日期收成 YYYY-MM-DD。
 * 认 20260109、2026/1/9、2026.01.09、2026年1月9日，以及已经是 YYYY-MM-DD 的。
 * 认不出或不是合法日期就原样留下，交给后面标「日期格式异常」。
 */
export function normalizeBankDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let s = asciiDigits(raw).trim().split(/[T\s]/)[0] ?? '';
  s = s.replace(/日$/, '');
  let y: number;
  let m: number;
  let d: number;
  const split = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})$/);
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  const hit = split ?? compact;
  if (!hit) return undefined;
  y = Number(hit[1]);
  m = Number(hit[2]);
  d = Number(hit[3]);
  return calendarDate(y, m, d);
}

function cleanDate(v: unknown): string | undefined {
  const s = cleanStr(v);
  if (!s) return undefined;
  return normalizeBankDate(s) ?? s;
}

/** 去掉「日期格式异常」段。其它复核原因保留。 */
function stripDateNote(note: string): string {
  return note
    .split('；')
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith('日期格式异常'))
    .join('；');
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

export type BalanceRecalc = {
  reviewCount: number;
  /** 本笔相对上一笔。null=缺余额无法测算；空串=衔接；否则为「余额断裂…」 */
  selfGap: string | null;
  /** 紧接的下一笔相对本笔。含义同 selfGap */
  nextGap: string | null;
  /** 印刷顺序上还有下一笔 */
  hasNext: boolean;
};

/**
 * 人工改完一行后，按印刷顺序重算该文件每一笔的前后余额。
 * 原来标成正常的行也参与：本笔用上一笔余额 ± 本笔金额对照本笔余额，
 * 下一笔用本笔余额 ± 下一笔金额对照下一笔余额。对不上就改为待复核。
 * 只更新 review_note / status，不回写金额、方向、余额、日期。
 * editedId：这次人工保存的行；本笔复算通过则标 fixed。
 */
export function recomputeFileBalanceReviews(fileId: number, editedId?: number): BalanceRecalc {
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
  let selfGap: string | null = null;
  let nextGap: string | null = null;
  let hasNext = false;
  let seenEdit = false;
  const apply = db.transaction(() => {
    for (const r of rows) {
      let note = stripBalanceNote(r.review_note ?? '');
      // null：上一笔或本笔没有印出余额，这条衔接测不了。空串：测过且衔接。
      let gap: string | null = null;
      if (prev != null && r.balance != null) {
        gap = balanceGapNote(prev, r.direction, Number(r.amount), Number(r.balance)) ?? '';
        if (gap) note = note ? `${note}；${gap}` : gap;
      }
      if (r.balance != null) prev = Number(r.balance);
      // 有断裂说明就待复核，不管改之前是不是「正常」
      const status = note ? 'needs_review' : r.id === editedId || r.status === 'fixed' ? 'fixed' : 'ok';
      if (note) reviewCount++;
      upd.run(note || null, status, r.id);
      if (editedId != null && r.id === editedId) {
        selfGap = gap;
        seenEdit = true;
      } else if (seenEdit && !hasNext) {
        hasNext = true;
        nextGap = gap;
      }
    }
    db.prepare(
      `UPDATE files SET status = ?, updated_at = ? WHERE id = ? AND status IN ('done','needs_review')`,
    ).run(reviewCount > 0 ? 'needs_review' : 'done', new Date().toISOString(), fileId);
  });
  apply();
  return { reviewCount, selfGap, nextGap, hasNext };
}

const OUT_MONEY_KEYS = ['debit', 'debit_amount', 'out_amount', 'expense', 'withdraw', '借方发生额', '借方金额', '支出金额', '支出'];
const IN_MONEY_KEYS = ['credit', 'credit_amount', 'in_amount', 'income', 'deposit', '贷方发生额', '贷方金额', '收入金额', '收入'];

function firstPositive(t: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const n = numOrNull(t[k]);
    if (n != null && Number.isFinite(n) && Math.abs(n) > 0) return Math.abs(n);
  }
  return undefined;
}

/** amount 没有时，从借贷方发生额里取。两边都有数则不猜。 */
function pickMoney(t: Record<string, unknown>): { amount: number; direction?: 'in' | 'out' } | undefined {
  const rawAmount = t.amount;
  if (rawAmount && typeof rawAmount === 'object') {
    const nested = pickMoney(rawAmount as Record<string, unknown>);
    if (nested) return nested;
  }
  const direct = numOrNull(rawAmount);
  if (direct != null && Number.isFinite(direct) && Math.abs(direct) > 0) {
    return { amount: Math.abs(direct), direction: direct < 0 ? 'out' : undefined };
  }
  const outAmt = firstPositive(t, OUT_MONEY_KEYS);
  const inAmt = firstPositive(t, IN_MONEY_KEYS);
  if (outAmt != null && inAmt == null) return { amount: outAmt, direction: 'out' };
  if (inAmt != null && outAmt == null) return { amount: inAmt, direction: 'in' };
  return undefined;
}

/** 模型有时不叫 transactions，或把数组再包一层、写成字符串。 */
function modelTransactions(j: unknown): unknown[] {
  if (Array.isArray(j)) return j;
  if (!j || typeof j !== 'object') return [];
  const obj = j as Record<string, unknown>;
  for (const k of ['transactions', 'txs', 'items', 'records', 'rows', 'data', 'result']) {
    const v = obj[k];
    if (Array.isArray(v)) return v;
    if (typeof v === 'string' && v.trim().startsWith('[')) {
      try {
        const parsed = JSON.parse(v) as unknown;
        if (Array.isArray(parsed)) return parsed;
      } catch {
        /* 字符串不是 JSON 数组 */
      }
    }
    if (v && typeof v === 'object') {
      const inner = modelTransactions(v);
      if (inner.length > 0) return inner;
    }
  }
  return [];
}

function normalizeTxs(raw: unknown, totalPages: number): NormTx[] {
  if (!Array.isArray(raw)) return [];
  const out: NormTx[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const t = r as Record<string, unknown>;
    const page = Math.max(1, Math.min(totalPages, Math.round(numOrNull(t.page) ?? 1)));
    const lineNo = Math.max(0, Math.round(numOrNull(t.line_no) ?? 0));
    const money = pickMoney(t);
    if (!money) continue; // 无金额的不成行（表头/合计行）
    const dirRaw = String(t.direction ?? '').toLowerCase();
    // 先判 out（'outflow' 含 'out' 不含 'in'；'withdraw' 等），再判 in
    const isOut = /out|withdraw|debit|支出|付|借/.test(dirRaw);
    const isIn = /\bin\b|^in|inflow|income|deposit|credit|收入|贷/.test(dirRaw);
    const dirOk = isOut || isIn;
    const direction: 'in' | 'out' = isOut ? 'out' : isIn ? 'in' : (money.direction ?? 'in');
    const review: string[] = [];
    const dateRaw = cleanStr(t.date);
    const date = dateRaw ? normalizeBankDate(dateRaw) : undefined;
    if (!dateRaw) review.push('日期缺失');
    else if (!date) review.push(`日期格式异常(${dateRaw})`);
    const confidence = numOrNull(t.confidence) ?? 1;
    if (confidence < 0.8) review.push(`低置信(${confidence.toFixed(2)})`);
    if (lineNo === 0) review.push('行号缺失');
    const bal = numOrNull(t.balance);
    const summary = cleanStr(t.summary);
    if (!summary) review.push('摘要缺失');
    if (!dirOk && !money.direction) review.push('收付方向未识别');
    out.push({
      page,
      lineNo,
      date,
      summary,
      amount: Math.round(money.amount * 100) / 100,
      direction,
      balance: bal,
      counterparty: cleanStr(t.counterparty),
      counterpartyAccount: cleanStr(t.counterparty_account),
      channel: cleanStr(t.channel),
      confidence: Math.max(0, Math.min(1, confidence)),
      raw: cleanStr(t.raw),
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
  /** 模型给出的行数，含后来因没有金额被丢掉的 */
  rawCount?: number;
}

/** LLM 结构化一批（≤3 页）；prevTail = 上批最后 3 行（跨页衔接，§5.2） */
export async function structureBatch(
  settings: { llmBase: string; llmModel: string; llmExtraHeader: string },
  fileRel: string,
  pages: Array<{ p: number; lines: string[] }>,
  totalPages: number,
  prevTail?: string,
  signal?: AbortSignal,
): Promise<StructuredBatch> {
  const blocks = pages.map(({ p, lines }) => pageBlock(fileRel, p, totalPages, lines, 1));
  const user =
    (prevTail ? `【上批末 3 行（跨页衔接，供余额/摘要参考）】\n${prevTail}\n\n` : '') +
    blocks.join('\n\n') +
    `\n\n输出 JSON：`;
  const content = await llmChat(settings.llmBase, settings.llmModel, settings.llmExtraHeader || undefined, LLM_SYSTEM, user, {
    jsonMode: true,
    maxTokens: 12000,
    signal,
  });
  const j = extractJson<Record<string, unknown>>(content);
  const rows = modelTransactions(j);
  const txs = normalizeTxs(rows, totalPages);
  return {
    bank: cleanStr(j.bank),
    accountNo: cleanStr(j.account_no),
    accountName: cleanStr(j.account_name),
    periodStart: cleanDate(j.period_start),
    periodEnd: cleanDate(j.period_end),
    txs,
    rawCount: rows.length,
  };
}

/**
 * 模型偶尔会把提示里的「上一页最后几笔」原样抄回来当成这一页的交易。
 * raw 与提示行完全相同的丢掉；空白页尤其容易触发。
 */
export function dropEchoedRows(rows: unknown[], prevTail?: string): unknown[] {
  const tail = new Set(
    (prevTail ?? '')
      .split('\n')
      .map((s) => s.trim().replace(/\s+/g, ' '))
      .filter(Boolean),
  );
  if (tail.size === 0) return rows;
  return rows.filter((row) => {
    if (!row || typeof row !== 'object') return true;
    const raw = (row as Record<string, unknown>).raw;
    if (typeof raw !== 'string') return true;
    return !tail.has(raw.trim().replace(/\s+/g, ' '));
  });
}

/** 视觉模型读一页图，直接给出结构化交易。页码和行号按本页顺序写死，不信模型自己编号。 */
export async function structurePageImage(
  settings: { llmBase: string; llmModel: string; llmExtraHeader: string },
  fileRel: string,
  image: PageImage,
  totalPages: number,
  prevTail?: string,
  signal?: AbortSignal,
): Promise<StructuredBatch> {
  const user =
    `文件 ${fileRel}，第 ${image.page}/${totalPages} 页。\n` +
    (prevTail ? `上一页最后几笔已经入库，不要重复输出：\n${prevTail}\n\n` : '') +
    '请阅读这张流水图片，输出 JSON。';
  const content = await llmChat(
    settings.llmBase,
    settings.llmModel,
    settings.llmExtraHeader || undefined,
    VISION_SYSTEM,
    user,
    { maxTokens: 12000, images: [image.jpeg], signal },
  );
  const j = extractJson<Record<string, unknown>>(content);
  const modelRows = modelTransactions(j);
  const rows = dropEchoedRows(modelRows, prevTail);
  rows.forEach((row, i) => {
    if (row && typeof row === 'object') {
      const t = row as Record<string, unknown>;
      t.page = image.page;
      t.line_no = i + 1;
    }
  });
  // 归一化会把页码夹到 1..总页数。这一页就是 image.page，写回去，避免新行落到别的页、本页被删空。
  const txs = normalizeTxs(rows, totalPages).map((t) => ({ ...t, page: image.page }));
  const echoed = modelRows.length - rows.length;
  console.log(
    `[parse] 第 ${image.page}/${totalPages} 页模型 ${modelRows.length} 行${echoed > 0 ? `，其中 ${echoed} 行是上一页提示重复` : ''}，可用 ${txs.length} 笔`,
  );
  return {
    bank: cleanStr(j.bank),
    accountNo: cleanStr(j.account_no),
    accountName: cleanStr(j.account_name),
    periodStart: cleanDate(j.period_start),
    periodEnd: cleanDate(j.period_end),
    txs,
    rawCount: rows.length,
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

/** 解析过程写在 files.progress，任务页轮询展示。只描述正在做的事，不改交易内容。 */
const PARSE_STEPS = [
  ['read', '读取 PDF'],
  ['render', '渲染页面图像'],
  ['vision', '视觉读图'],
  ['structure', '结构化输出'],
  ['balance', '余额复核'],
  ['save', '写入交易'],
  ['categorize', 'LLM 分类'],
] as const;

type ParseStepId = (typeof PARSE_STEPS)[number][0];

class ParseProgress {
  private steps: Array<{ id: ParseStepId; label: string; state: ParseStepState; detail?: string }>;
  constructor(private fileId: number) {
    this.steps = PARSE_STEPS.map(([id, label]) => ({ id, label, state: 'wait' }));
  }
  set(id: ParseStepId, state: ParseStepState, detail?: string): void {
    const step = this.steps.find((s) => s.id === id);
    if (!step) return;
    step.state = state;
    step.detail = detail;
    setFile(this.fileId, { progress: JSON.stringify(this.steps) });
  }
}

/** 用户点了终止。未写入的识别结果丢掉，已经入库的交易保留。 */
class ParseStopped extends Error {
  constructor() {
    super('已终止');
    this.name = 'ParseStopped';
  }
}

function isStopped(e: unknown): boolean {
  return e instanceof ParseStopped;
}

/** 网络抖动、超时、模型暂时无响应。同一页再试，不把前面的页丢掉。 */
function isRetryableModelError(e: unknown): boolean {
  if (!(e instanceof Error) || e.name === 'ParseStopped') return false;
  if (e.name === 'AbortError') return true;
  return /fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|network|不可达|超时|无响应|terminated|other side closed|HTTP 429|HTTP 5\d\d|返回为空|未找到 JSON|Unexpected token|JSON/i.test(
    e.message,
  );
}

const PAGE_RETRY_WAITS = [2000, 5000, 10000];

interface ParseCheckpoint {
  v: 1;
  donePage: number;
  totalPages: number;
  prevTail?: string;
  meta: Partial<StructuredBatch>;
  txs: NormTx[];
}

function readCheckpoint(raw: unknown): ParseCheckpoint | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const j = JSON.parse(raw) as ParseCheckpoint;
    if (!j || j.v !== 1 || !Number.isFinite(j.donePage) || j.donePage < 1 || !Array.isArray(j.txs)) return null;
    return j;
  } catch {
    return null;
  }
}

/** 给任务页用：下一页页码和总页数。没有可续的进度就空。 */
export function fileResumeHint(raw: unknown): { nextPage: number; totalPages: number } | undefined {
  const cp = readCheckpoint(raw);
  if (!cp) return undefined;
  return { nextPage: cp.donePage + 1, totalPages: cp.totalPages };
}

function writeCheckpoint(fileId: number, cp: ParseCheckpoint): void {
  setFile(fileId, { checkpoint: JSON.stringify(cp) });
}

/** 重试等待。暂停会停在这里，终止会抛出。 */
async function waitInterruptible(fileId: number, ms: number): Promise<void> {
  let left = ms;
  while (left > 0) {
    await parseQueue.gate(fileId);
    const step = Math.min(500, left);
    await new Promise((r) => setTimeout(r, step));
    left -= step;
  }
  await parseQueue.gate(fileId);
}

/** 上一页最后两笔，给指定页重读时衔接。页码不连续时用库里已经在的上一页，不用这次刚读的更早一页。 */
function tailBeforePage(fileId: number, page: number): string | undefined {
  const rows = db
    .prepare(
      `SELECT date, direction, amount, raw_text FROM transactions
       WHERE file_id = ? AND page > 0 AND page < ?
       ORDER BY page DESC, line_no DESC, id DESC LIMIT 2`,
    )
    .all(fileId, page) as Array<{ date: string | null; direction: string; amount: number; raw_text: string | null }>;
  rows.reverse();
  if (rows.length === 0) return undefined;
  return rows.map((t) => t.raw_text || `${t.date ?? ''} ${t.direction} ${t.amount}`).join('\n');
}

/**
 * 只换掉这次确实读出交易的页。某一页归一化后是 0 笔，就留下原来的行。
 * 其它页不动。关注、规则命中随被换掉的行一起去掉。
 */
function replaceFilePages(
  fileId: number,
  pages: number[],
  txs: NormTx[],
): { insertedIds: number[]; replacedPages: number[]; keptPages: number[] } {
  const byPage = new Map<number, NormTx[]>();
  for (const p of pages) byPage.set(p, []);
  for (const t of txs) byPage.get(t.page)?.push(t);
  const replacedPages = pages.filter((p) => (byPage.get(p)?.length ?? 0) > 0);
  const keptPages = pages.filter((p) => (byPage.get(p)?.length ?? 0) === 0);
  if (replacedPages.length === 0) return { insertedIds: [], replacedPages, keptPages };
  const placeholders = replacedPages.map(() => '?').join(',');
  const tx = db.transaction(() => {
    db.prepare(
      `DELETE FROM rule_hits WHERE transaction_id IN (SELECT id FROM transactions WHERE file_id = ? AND page IN (${placeholders}))`,
    ).run(fileId, ...replacedPages);
    db.prepare(`DELETE FROM transactions WHERE file_id = ? AND page IN (${placeholders})`).run(fileId, ...replacedPages);
    const ins = db.prepare(
      `INSERT INTO transactions(file_id, page, line_no, date, summary, amount, direction, balance,
        counterparty, counterparty_account, channel, confidence, review_note, raw_text, status)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const insertedIds: number[] = [];
    const inOrder = replacedPages.flatMap((p) => byPage.get(p) ?? []).sort((a, b) => a.page - b.page || a.lineNo - b.lineNo);
    for (const t of inOrder) {
      const raw = t.raw?.trim();
      const status = t.review ? 'needs_review' : 'ok';
      const info = ins.run(
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
      insertedIds.push(Number(info.lastInsertRowid));
    }
    return insertedIds;
  });
  return { insertedIds: tx(), replacedPages, keptPages };
}

export async function filePageMap(fileId: number): Promise<
  | { total: number; gaps: number[]; byPage: { page: number; n: number }[] }
  | undefined
> {
  const file = db.prepare('SELECT rel_path, task_id FROM files WHERE id = ?').get(fileId) as
    | { rel_path: string; task_id: number }
    | undefined;
  if (!file) return undefined;
  const task = db.prepare('SELECT folder_path FROM tasks WHERE id = ?').get(file.task_id) as { folder_path: string } | undefined;
  if (!task) return undefined;
  const total = await countPdfPages(path.resolve(task.folder_path, file.rel_path));
  const rows = db
    .prepare('SELECT page, COUNT(*) AS n FROM transactions WHERE file_id = ? AND page > 0 GROUP BY page ORDER BY page')
    .all(fileId) as Array<{ page: number; n: number }>;
  const have = new Set(rows.map((r) => r.page));
  const known = rows.map((r) => r.page);
  const gaps: number[] = [];
  if (known.length >= 2) {
    const last = known[known.length - 1];
    for (let p = known[0]; p < last; p++) if (!have.has(p)) gaps.push(p);
  }
  return { total, gaps, byPage: rows.map((r) => ({ page: r.page, n: Number(r.n) })) };
}

/** 解析单个文件：整本先转图片，再逐页视觉读图并结构化。fresh 时丢掉断点，从第 1 页重读。pages 只重读这些页，并替换进原记录。 */
export async function parseFileTextLayer(
  fileId: number,
  opts?: { fresh?: boolean; llm?: LlmProfile; pages?: number[] },
): Promise<ParseOutcome> {
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId) as Record<string, unknown> | undefined;
  if (!file) throw new Error('文件登记不存在（任务被删除？）');
  const task = db.prepare('SELECT folder_path FROM tasks WHERE id = ?').get(Number(file.task_id)) as
    | { folder_path: string }
    | undefined;
  if (!task) throw new Error('任务不存在');
  const absPath = path.resolve(task.folder_path, String(file.rel_path));
  const prog = new ParseProgress(fileId);
  const taskId = Number(file.task_id);
  const relPath = String(file.rel_path);
  const pageMode = (opts?.pages?.length ?? 0) > 0;
  const wanted = pageMode ? [...new Set(opts!.pages!)].sort((a, b) => a - b) : [];
  if (!pageMode && opts?.fresh) setFile(fileId, { checkpoint: null });
  const saved = pageMode || opts?.fresh ? null : readCheckpoint(file.checkpoint);

  async function hold(step: ParseStepId, detail: string): Promise<void> {
    if (parseQueue.isPaused(taskId)) {
      prog.set(step, 'pause', detail);
      if (step === 'vision') prog.set('structure', 'pause', '已暂停');
    }
    await parseQueue.gate(fileId);
  }

  let images: PageImage[];
  let totalPages = 0;
  prog.set('read', 'run', pageMode ? `打开文件，准备重读第 ${wanted.join('、')} 页` : '打开文件');
  try {
    if (pageMode) {
      totalPages = await countPdfPages(absPath);
      const bad = wanted.filter((p) => p > totalPages);
      if (bad.length) {
        const msg = `没有第 ${bad.join('、')} 页，这份 PDF 共 ${totalPages} 页。原来的交易还在。`;
        prog.set('read', 'fail', msg);
        return finishKept(fileId, msg);
      }
    }
    const rendered = await renderPdfPages(
      absPath,
      async (done, total) => {
        if (parseQueue.isPaused(taskId)) {
          prog.set('render', 'pause', `已暂停 · 已渲染 ${done}/${total} 页，继续后接着渲染`);
        }
        await parseQueue.gate(fileId);
        if (done === 0 && total > 0) prog.set('read', 'done', pageMode ? `重读 ${wanted.join('、')} 页` : `${total} 页`);
        prog.set('render', 'run', total > 0 ? `已渲染 ${done}/${total} 页` : '打开文件');
      },
      pageMode ? wanted : undefined,
    );
    images = rendered.images;
    totalPages = rendered.totalPages;
  } catch (e) {
    if (isStopped(e)) throw e;
    const msg = `页面渲染失败：${(e as Error).message}`;
    prog.set('render', 'fail', msg);
    return pageMode ? finishKept(fileId, `${msg}。原来的交易还在。`) : finishError(fileId, msg);
  }
  if (images.length === 0) {
    prog.set('read', 'fail', 'PDF 无页面');
    return pageMode ? finishKept(fileId, '没有可重读的页面。原来的交易还在。') : finishError(fileId, 'PDF 无页面');
  }
  prog.set('read', 'done', pageMode ? `重读第 ${wanted.join('、')} 页` : `${images.length} 页`);
  prog.set('render', 'done', `${images.length} 页`);

  const chosen = opts?.llm;
  const savedSettings = chosen ? null : getSettings();
  const s = {
    llmBase: chosen?.base ?? savedSettings!.llmBase,
    llmModel: chosen?.model ?? savedSettings!.llmModel,
    llmExtraHeader: chosen?.extraHeader ?? savedSettings!.llmExtraHeader,
  };
  const all: NormTx[] = [];
  const pageReads: Array<{ page: number; raw: number; n: number }> = [];
  let meta: Partial<StructuredBatch> = {};
  let prevTail: string | undefined;
  let startAt = 0;
  if (saved && saved.totalPages === images.length && saved.donePage >= 1 && saved.donePage <= images.length) {
    startAt = saved.donePage;
    all.push(...saved.txs.map((t) => ({ ...t, review: t.review || '' })));
    meta = { ...saved.meta };
    prevTail = saved.prevTail;
    prog.set('vision', 'run', `前 ${saved.donePage} 页已保留，从第 ${Math.min(saved.donePage + 1, images.length)} 页继续`);
  } else if (saved) {
    console.log(`[parse] file#${fileId} 断点和当前 PDF 对不上，从第 1 页重读`);
    setFile(fileId, { checkpoint: null });
  }
  let failedPage = 0;
  try {
    for (let i = startAt; i < images.length; i++) {
      const image = images[i];
      failedPage = image.page;
      if (pageMode) {
        const prevRendered = i > 0 ? images[i - 1].page : 0;
        if (image.page !== prevRendered + 1) prevTail = tailBeforePage(fileId, image.page);
      }
      const pageHint = `已暂停 · 第 ${image.page}/${totalPages} 页，继续后重读这一页`;
      await hold('vision', pageHint);
      let r: StructuredBatch | undefined;
      let attempt = 0;
      for (;;) {
        prog.set('vision', 'run', pageMode ? `重读第 ${image.page}/${totalPages} 页` : `第 ${image.page}/${totalPages} 页`);
        prog.set('structure', 'run', `正在整理第 ${image.page} 页，已抽出 ${all.length} 笔`);
        try {
          const got = await structurePageImage(s, relPath, image, totalPages, prevTail, parseQueue.signalFor(fileId));
          if (parseQueue.consumeAbort(fileId) === 'stop') throw new ParseStopped();
          r = got;
          break;
        } catch (e) {
          if (isStopped(e)) throw e;
          const kind = parseQueue.consumeAbort(fileId);
          if (kind === 'pause') {
            prog.set('vision', 'pause', pageHint);
            prog.set('structure', 'pause', '已暂停');
            await parseQueue.gate(fileId);
            attempt = 0;
            continue;
          }
          if (kind === 'stop') throw new ParseStopped();
          attempt++;
          if (attempt <= PAGE_RETRY_WAITS.length && isRetryableModelError(e)) {
            const wait = PAGE_RETRY_WAITS[attempt - 1];
            console.log(`[parse] file#${fileId} 第 ${image.page} 页第 ${attempt} 次失败，${wait / 1000}s 后重试：${(e as Error).message}`);
            prog.set(
              'vision',
              'run',
              `第 ${image.page}/${totalPages} 页没读成，${wait / 1000} 秒后重试（${attempt}/${PAGE_RETRY_WAITS.length}）`,
            );
            await waitInterruptible(fileId, wait);
            continue;
          }
          throw e;
        }
      }
      if (!r) throw new Error('这一页没有读出内容');
      if (r.bank) meta.bank = r.bank;
      if (r.accountNo) meta.accountNo = r.accountNo;
      if (r.accountName) meta.accountName = r.accountName;
      if (r.periodStart) meta.periodStart = r.periodStart;
      if (r.periodEnd) meta.periodEnd = r.periodEnd;
      if (pageMode) pageReads.push({ page: image.page, raw: r.rawCount ?? r.txs.length, n: r.txs.length });
      all.push(...r.txs);
      const last2 = r.txs.slice(-2);
      prevTail = last2.length
        ? last2.map((t) => t.raw || `${t.date ?? ''} ${t.direction} ${t.amount}`).join('\n')
        : prevTail;
      if (!pageMode) writeCheckpoint(fileId, { v: 1, donePage: image.page, totalPages: images.length, prevTail, meta, txs: all });
      prog.set('structure', 'run', `第 ${image.page} 页 ${r.txs.length} 笔，累计 ${all.length} 笔`);
    }
  } catch (e) {
    if (isStopped(e)) throw e;
    const why = isAbortError(e) ? '模型没有响应' : (e as Error).message;
    const donePage = Math.max(0, failedPage - 1);
    const msg = pageMode
      ? `第 ${failedPage || wanted[0]} 页没有重读成功：${why}。原来的交易还在。`
      : donePage > 0
        ? `第 ${failedPage}/${images.length} 页失败：${why}。前 ${donePage} 页已保留，再次解析从第 ${donePage + 1} 页继续。`
        : `第 ${failedPage || 1}/${images.length} 页失败：${why}`;
    prog.set('vision', 'fail', msg);
    prog.set('structure', 'fail', msg);
    return pageMode ? finishKept(fileId, msg) : finishError(fileId, msg);
  }
  if (pageMode) {
    prog.set('vision', 'done', `已重读第 ${wanted.join('、')} 页`);
    prog.set('structure', 'done', `这几页读出 ${all.length} 笔`);
    const emptyReads = pageReads.filter((p) => p.n === 0);
    await hold('save', '已暂停，继续后把这几页补进原记录');
    const pagesToWrite = wanted.filter((p) => !emptyReads.some((e) => e.page === p));
    prog.set('save', 'run', pagesToWrite.length > 0 ? `写回第 ${pagesToWrite.join('、')} 页` : '这几页没有新交易，原记录保留');
    const replaced = replaceFilePages(fileId, wanted, all);
    console.log(
      `[parse] file#${fileId} 指定页写回：换上 ${replaced.replacedPages.join('、') || '无'}（${replaced.insertedIds.length} 笔），保留 ${replaced.keptPages.join('、') || '无'}`,
    );
    const keptNote = replaced.keptPages
      .map((p) => {
        const read = pageReads.find((r) => r.page === p);
        return read && read.raw > 0
          ? `第 ${p} 页读到 ${read.raw} 行，但没有能入库的金额，原记录还留着`
          : `第 ${p} 页没有读出交易，原记录还留着`;
      })
      .join('。');
    const wroteNote =
      replaced.replacedPages.length > 0
        ? `第 ${replaced.replacedPages.join('、')} 页已换上 ${replaced.insertedIds.length} 笔`
        : '';
    const warn = keptNote ? [keptNote, wroteNote].filter(Boolean).join('。') : null;
    let reviewCount: number;
    if (replaced.replacedPages.length > 0) {
      prog.set('balance', 'run', '按整份流水重核前后页的余额');
      reviewCount = recomputeFileBalanceReviews(fileId).reviewCount;
      prog.set('balance', 'done', reviewCount > 0 ? `整份里 ${reviewCount} 笔待复核` : '余额连续');
    } else {
      reviewCount = Number(
        (db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE file_id = ? AND status = 'needs_review'`).get(fileId) as { n: number }).n,
      );
      prog.set('balance', 'skip', '没有换上新交易，余额沿用原记录');
    }
    const txCount = Number((db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE file_id = ?').get(fileId) as { n: number }).n);
    const patch: Record<string, unknown> = {
      tx_count: txCount,
      error: warn,
      status: reviewCount > 0 ? 'needs_review' : 'done',
      progress: null,
    };
    if (!file.bank && meta.bank) patch.bank = meta.bank;
    if (!file.account_no && meta.accountNo) patch.account_no = meta.accountNo;
    if (!file.account_name && meta.accountName) patch.account_name = meta.accountName;
    if (!file.period_start && meta.periodStart) patch.period_start = meta.periodStart;
    if (!file.period_end && meta.periodEnd) patch.period_end = meta.periodEnd;
    prog.set('save', 'done', warn ?? `第 ${wanted.join('、')} 页已补进原记录，这份现有 ${txCount} 笔`);
    setFile(fileId, patch);
    if (replaced.insertedIds.length > 0 && getSettings().autoCategorize) {
      try {
        prog.set('categorize', 'run', `补上的 ${replaced.insertedIds.length} 笔待分类`);
        const r = await classifyTask(taskId, {
          fileId,
          txIds: replaced.insertedIds,
          llm: opts?.llm,
          beforeBatch: async () => {
            if (parseQueue.isPaused(taskId)) prog.set('categorize', 'pause', '已暂停，继续后接着分类');
            await parseQueue.gate(fileId);
            prog.set('categorize', 'run', `补上的 ${replaced.insertedIds.length} 笔待分类`);
          },
          signal: () => parseQueue.signalFor(fileId),
          afterRequest: () => {
            const kind = parseQueue.consumeAbort(fileId);
            if (kind === 'stop') throw new ParseStopped();
            return kind === 'pause' ? 'pause' : null;
          },
        });
        prog.set('categorize', 'done', r.classified > 0 ? `已分类 ${r.classified} 笔` : '无需分类');
        setFile(fileId, { error: warn });
      } catch (e) {
        if (isStopped(e)) {
          prog.set('categorize', 'skip', '已终止');
          setFile(fileId, { progress: null, error: warn });
          return { fileId, status: reviewCount > 0 ? 'needs_review' : 'done', txCount, reviewCount };
        }
        prog.set('categorize', 'fail', (e as Error).message);
        const fail = (e as Error).message;
        setFile(fileId, { error: warn ? `${warn}。分类失败：${fail}` : `这几页已补进原记录，LLM 分类失败：${fail}` });
      }
    } else {
      prog.set('categorize', 'skip', replaced.insertedIds.length > 0 ? '自动分类已关闭' : '这几页没有新交易');
    }
    setFile(fileId, { progress: null });
    return { fileId, status: reviewCount > 0 ? 'needs_review' : 'done', txCount, reviewCount };
  }
  prog.set('vision', 'done', `${images.length} 页`);
  prog.set('structure', 'done', `共 ${all.length} 笔`);

  // 3) 余额连续性（M3 §5.5）：只追加复核提示，不改金额/方向/余额/日期。
  prog.set('balance', 'run', '按印刷顺序核对，不改原数字');
  annotateBalanceReviews(all);
  const breaks = all.filter((t) => t.review.includes('余额断裂')).length;
  prog.set('balance', 'done', breaks > 0 ? `${breaks} 笔对不上，只记复核提示` : '余额连续');

  // 4) 入库（重解析先清旧数据）+ 质检标记。暂停停在写入前，终止则这一份不入库。
  await hold('save', '已暂停，继续后写入交易');
  prog.set('save', 'run', `写入 ${all.length} 笔`);
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
      const raw = t.raw?.trim();
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
  const patch: Record<string, unknown> = { tx_count: all.length, error: null, checkpoint: null };
  if (!file.bank && meta.bank) patch.bank = meta.bank;
  if (!file.account_no && meta.accountNo) patch.account_no = meta.accountNo;
  if (!file.account_name && meta.accountName) patch.account_name = meta.accountName;
  if (!file.period_start && meta.periodStart) patch.period_start = meta.periodStart;
  if (!file.period_end && meta.periodEnd) patch.period_end = meta.periodEnd;
  patch.status = reviewCount > 0 ? 'needs_review' : 'done';
  patch.progress = null;
  prog.set('save', 'done', reviewCount > 0 ? `${all.length} 笔，其中 ${reviewCount} 笔待复核` : `${all.length} 笔`);
  setFile(fileId, patch);

  // 6) M4：解析完自动 LLM 批量分类（只分本文件未分类的交易；人工改判过的不动）
  if (all.length > 0 && getSettings().autoCategorize) {
    try {
      prog.set('categorize', 'run', `${all.length} 笔待分类`);
      const r = await classifyTask(taskId, {
        fileId,
        llm: opts?.llm,
        beforeBatch: async () => {
          if (parseQueue.isPaused(taskId)) prog.set('categorize', 'pause', '已暂停，继续后接着分类');
          await parseQueue.gate(fileId);
          prog.set('categorize', 'run', `${all.length} 笔待分类`);
        },
        signal: () => parseQueue.signalFor(fileId),
        afterRequest: () => {
          const kind = parseQueue.consumeAbort(fileId);
          if (kind === 'stop') throw new ParseStopped();
          return kind === 'pause' ? 'pause' : null;
        },
      });
      prog.set('categorize', 'done', r.classified > 0 ? `已分类 ${r.classified} 笔` : '无需分类');
      setFile(fileId, { error: null });
    } catch (e) {
      if (isStopped(e)) {
        prog.set('categorize', 'skip', '已终止');
        setFile(fileId, { progress: null, error: null });
        return { fileId, status: reviewCount > 0 ? 'needs_review' : 'done', txCount: all.length, reviewCount };
      }
      // 解析本身已成功，分类失败只留提示，任务页可点「LLM 分类」重试
      prog.set('categorize', 'fail', (e as Error).message);
      setFile(fileId, { error: `LLM 分类失败：${(e as Error).message}` });
    }
  } else {
    prog.set('categorize', 'skip', all.length > 0 ? '自动分类已关闭' : '无交易');
  }
  setFile(fileId, { progress: null });
  return { fileId, status: reviewCount > 0 ? 'needs_review' : 'done', txCount: all.length, reviewCount };
}

/** 指定页没读成：原记录留着，不把整份打成错误。 */
function finishKept(fileId: number, msg: string): ParseOutcome {
  const row = db.prepare('SELECT tx_count FROM files WHERE id = ?').get(fileId) as { tx_count: number } | undefined;
  if (!row || Number(row.tx_count) <= 0) return finishError(fileId, msg);
  const needs = db.prepare(`SELECT 1 AS n FROM transactions WHERE file_id = ? AND status = 'needs_review' LIMIT 1`).get(fileId);
  const status = needs ? 'needs_review' : 'done';
  setFile(fileId, { status, error: msg, progress: null });
  return { fileId, status, txCount: Number(row.tx_count), reviewCount: 0, error: msg };
}

function finishError(fileId: number, msg: string): ParseOutcome {
  setFile(fileId, { status: 'error', error: msg });
  return { fileId, status: 'error', txCount: 0, reviewCount: 0, error: msg };
}

/** 终止后回到解析前的状态：有交易就保留，没有就回到待解析。不记成错误。 */
function restoreStopped(fileId: number): void {
  const row = db.prepare('SELECT tx_count FROM files WHERE id = ?').get(fileId) as { tx_count: number } | undefined;
  if (!row) return;
  let status = 'scanned';
  if (Number(row.tx_count) > 0) {
    const needs = db
      .prepare(`SELECT 1 AS n FROM transactions WHERE file_id = ? AND status = 'needs_review' LIMIT 1`)
      .get(fileId);
    status = needs ? 'needs_review' : 'done';
  }
  setFile(fileId, { status, error: null, progress: null, checkpoint: null });
}

function writeControlProgress(fileId: number, detail: string, queued: boolean): void {
  if (!db.prepare('SELECT 1 FROM files WHERE id = ?').get(fileId)) return;
  if (queued) {
    setFile(fileId, {
      progress: JSON.stringify([{ id: 'read', label: '排队', state: 'pause', detail }]),
    });
    return;
  }
  const row = db.prepare('SELECT progress FROM files WHERE id = ?').get(fileId) as { progress: string | null } | undefined;
  let steps: ParseStep[] = [];
  try {
    const parsed = JSON.parse(row?.progress || '[]') as ParseStep[];
    if (Array.isArray(parsed)) steps = parsed;
  } catch {
    steps = [];
  }
  if (steps.length === 0) {
    setFile(fileId, { progress: JSON.stringify([{ id: 'read', label: '解析', state: 'pause', detail }]) });
    return;
  }
  let flipped = false;
  for (const step of steps) {
    if (step.state === 'run') {
      step.state = 'pause';
      step.detail = detail;
      flipped = true;
    }
  }
  if (!flipped) {
    const target = [...steps].reverse().find((s) => s.state !== 'wait') ?? steps[steps.length - 1];
    target.state = 'pause';
    target.detail = detail;
  }
  setFile(fileId, { progress: JSON.stringify(steps) });
}

/* ---------- 解析队列（LLM 并发 = settings.llmConcurrency，§3.2 默认 2） ---------- */

const PROBE_STEP = (state: 'run' | 'fail', detail: string) =>
  JSON.stringify([{ id: 'read', label: '连接测试', state, detail }]);

const QUEUE_STEP = (detail: string) => JSON.stringify([{ id: 'read', label: '排队', state: 'run', detail }]);

export class ParseQueue {
  private queue: number[] = [];
  private inflight = new Set<number>();
  private workerStarted = false;
  /** 这一波里每个端点测一次。队列清空后作废，下一波重新测。 */
  private probes = new Map<string, Promise<{ ok: boolean; detail: string }>>();
  /** 入队时选定的模型。跑完或失败后丢掉。 */
  private llmOf = new Map<number, LlmProfile>();
  /** 只重读这些页，结果替换进原记录。 */
  private pagesOf = new Map<number, number[]>();
  /** 暂停的任务。文件留在队列里，正在读的文件在当前请求停下后等待。 */
  private paused = new Set<number>();
  /** 终止的文件。正在跑的那份看到后丢掉还没写入的结果。 */
  private stopRequested = new Set<number>();
  private controllers = new Map<number, AbortController>();
  private abortKind = new Map<number, 'pause' | 'stop'>();
  private waiters = new Map<number, Array<() => void>>();
  /** 这些文件从第 1 页重读，不沿用断点。已完成文件的重新解析走这里。 */
  private fresh = new Set<number>();

  /** 入队（幂等：已排队/解析中则跳过）。fresh 时丢掉已读页，从第 1 页重来。pages 只重读这些页。llmId 缺省用默认模型。返回是否入队 */
  enqueue(fileId: number, opts?: { fresh?: boolean; llmId?: string; pages?: number[] }): boolean {
    if (opts?.fresh) this.fresh.add(fileId);
    else if (opts) this.fresh.delete(fileId);
    if (this.inflight.has(fileId) || this.queue.includes(fileId)) return false;
    const profile = llmProfileById(opts?.llmId);
    if (!profile) return false;
    this.llmOf.set(fileId, profile);
    if (opts?.pages?.length) this.pagesOf.set(fileId, opts.pages);
    else this.pagesOf.delete(fileId);
    this.queue.push(fileId);
    if (db.prepare('SELECT 1 FROM files WHERE id = ?').get(fileId)) {
      const taskId = this.taskIdOf(fileId);
      const paused = taskId != null && this.paused.has(taskId);
      setFile(fileId, {
        status: 'parsing',
        error: null,
        progress: paused
          ? JSON.stringify([{ id: 'read', label: '排队', state: 'pause', detail: '已暂停' }])
          : PROBE_STEP('run', `正在确认 ${profile.name} 可达`),
      });
    }
    return true;
  }

  get pending(): number {
    return this.queue.length + this.inflight.size;
  }

  /** 本进程队列里的文件。启动自愈时不要把这些刚入队的行打回待解析。 */
  queuedIds(): number[] {
    return [...this.queue, ...this.inflight];
  }

  isPaused(taskId: number): boolean {
    return this.paused.has(taskId);
  }

  /** 暂停这个任务。正在读的请求会停下来，继续后从这一页重读；已经读完的页留在内存里。 */
  pauseTask(taskId: number): number {
    const ids = this.idsOf(taskId);
    if (ids.length === 0) return 0;
    this.paused.add(taskId);
    for (const id of ids) {
      const running = this.inflight.has(id);
      if (running) {
        this.abortKind.set(id, 'pause');
        const ac = this.controllers.get(id);
        if (ac && !ac.signal.aborted) ac.abort();
      }
      writeControlProgress(id, running ? '已暂停，正在停下当前这一步' : '已暂停', !running);
    }
    console.log(`[parse] 暂停 task#${taskId}，${ids.length} 份`);
    return ids.length;
  }

  /** 继续这个任务。从停下的那一页接着读。 */
  resumeTask(taskId: number): number {
    const ids = this.idsOf(taskId);
    this.paused.delete(taskId);
    for (const id of this.queue) {
      if (this.taskIdOf(id) === taskId) {
        setFile(id, { status: 'parsing', error: null, progress: QUEUE_STEP('即将继续') });
      }
    }
    this.wake(taskId);
    console.log(`[parse] 继续 task#${taskId}，${ids.length} 份`);
    return ids.length;
  }

  /** 终止这个任务。排队的马上复原；正在读的丢掉还没写入的结果。已入库的交易保留。 */
  stopTask(taskId: number): number {
    const queued = this.queue.filter((id) => this.taskIdOf(id) === taskId);
    const running = [...this.inflight].filter((id) => this.taskIdOf(id) === taskId);
    this.queue = this.queue.filter((id) => this.taskIdOf(id) !== taskId);
    this.paused.delete(taskId);
    for (const id of queued) {
      this.stopRequested.delete(id);
      this.llmOf.delete(id);
      this.pagesOf.delete(id);
      this.fresh.delete(id);
      restoreStopped(id);
    }
    for (const id of running) {
      this.stopRequested.add(id);
      this.abortKind.set(id, 'stop');
      const ac = this.controllers.get(id);
      if (ac && !ac.signal.aborted) ac.abort();
      writeControlProgress(id, '正在终止，未写入的结果会丢掉', false);
    }
    this.wake(taskId);
    console.log(`[parse] 终止 task#${taskId}，排队 ${queued.length} 份，进行中 ${running.length} 份`);
    return queued.length + running.length;
  }

  /** 暂停时在这里等待。终止或文件已删除则抛出。 */
  async gate(fileId: number): Promise<void> {
    if (this.stopRequested.has(fileId)) throw new ParseStopped();
    const taskId = this.taskIdOf(fileId);
    if (taskId == null) throw new ParseStopped();
    if (!this.paused.has(taskId)) return;
    await new Promise<void>((resolve) => {
      const list = this.waiters.get(taskId) ?? [];
      list.push(resolve);
      this.waiters.set(taskId, list);
    });
    if (this.stopRequested.has(fileId) || this.taskIdOf(fileId) == null) throw new ParseStopped();
  }

  /** 当前这份解析用的取消信号。上次若已取消，换一个新的。 */
  signalFor(fileId: number): AbortSignal {
    let ac = this.controllers.get(fileId);
    if (!ac || ac.signal.aborted) {
      if (this.abortKind.get(fileId) === 'pause' && !this.stopRequested.has(fileId)) this.abortKind.delete(fileId);
      ac = new AbortController();
      this.controllers.set(fileId, ac);
    }
    return ac.signal;
  }

  /** 取走这一次中断原因。终止优先于暂停。 */
  consumeAbort(fileId: number): 'pause' | 'stop' | null {
    const kind = this.abortKind.get(fileId) ?? null;
    this.abortKind.delete(fileId);
    if (this.stopRequested.has(fileId)) return 'stop';
    return kind;
  }

  /** 服务启动时调一次：常驻轮询（新任务/新文件随时入队） */
  start(): void {
    if (this.workerStarted) return;
    this.workerStarted = true;
    void this.pump();
  }

  private taskIdOf(fileId: number): number | null {
    const row = db.prepare('SELECT task_id FROM files WHERE id = ?').get(fileId) as { task_id: number } | undefined;
    return row ? Number(row.task_id) : null;
  }

  private idsOf(taskId: number): number[] {
    return [...this.queue, ...this.inflight].filter((id) => this.taskIdOf(id) === taskId);
  }

  private isFilePaused(fileId: number): boolean {
    const taskId = this.taskIdOf(fileId);
    return taskId != null && this.paused.has(taskId);
  }

  private wake(taskId: number): void {
    const list = this.waiters.get(taskId) ?? [];
    this.waiters.delete(taskId);
    for (const fn of list) fn();
  }

  private releasePauseIfIdle(taskId: number): void {
    if (!this.paused.has(taskId)) return;
    const left = [...this.queue, ...this.inflight].some((id) => this.taskIdOf(id) === taskId);
    if (!left) {
      this.paused.delete(taskId);
      this.wake(taskId);
    }
  }

  private profileKey(p: LlmProfile): string {
    return `${p.base}\n${p.model}\n${p.extraHeader}`;
  }

  private profileFor(fileId: number): LlmProfile {
    return (
      this.llmOf.get(fileId) ??
      llmProfileById() ?? {
        id: 'llm-default',
        name: '默认模型',
        base: '',
        model: '',
        extraHeader: '',
      }
    );
  }

  /** 同一端点这一波只测一次。失败后丢掉缓存，下一份可以再测。 */
  private probeProfile(p: LlmProfile): Promise<{ ok: boolean; detail: string }> {
    const key = this.profileKey(p);
    let hit = this.probes.get(key);
    if (!hit) {
      hit = (async () => {
        try {
          console.log(`[parse] 解析前连接测试 ${p.name} ${p.base} 模型 ${p.model || '（未填）'}`);
          const r = await probeLLM(p.base, p.model, p.extraHeader);
          console.log(`[parse] 连接测试${r.ok ? '通过' : '未通过'}：${r.detail}`);
          return { ok: r.ok, detail: r.detail };
        } catch (e) {
          const detail = (e as Error).message;
          console.log(`[parse] 连接测试未通过：${detail}`);
          return { ok: false, detail };
        }
      })();
      this.probes.set(key, hit);
    }
    return hit;
  }

  /** 这个端点没连上：只让用它的、还没开跑的文件失败，别的模型继续。 */
  private failProfile(p: LlmProfile, detail: string): void {
    const key = this.profileKey(p);
    const ids = this.queue.filter((id) => !this.isFilePaused(id) && this.profileKey(this.profileFor(id)) === key);
    const drop = new Set(ids);
    this.queue = this.queue.filter((id) => !drop.has(id));
    const progress = PROBE_STEP('fail', detail);
    for (const id of ids) {
      const pages = this.pagesOf.get(id);
      this.llmOf.delete(id);
      this.pagesOf.delete(id);
      this.fresh.delete(id);
      if (!db.prepare('SELECT 1 FROM files WHERE id = ?').get(id)) continue;
      if (pages?.length) {
        finishKept(id, `模型不可达（${p.name}），第 ${pages.join('、')} 页没有重读：${detail}。原来的交易还在。`);
        continue;
      }
      const resume = readCheckpoint(
        (db.prepare('SELECT checkpoint FROM files WHERE id = ?').get(id) as { checkpoint?: string } | undefined)?.checkpoint,
      );
      const msg = resume
        ? `模型不可达（${p.name}），这次没继续：${detail}。前 ${resume.donePage} 页已保留，恢复后从第 ${resume.donePage + 1} 页继续。`
        : `模型不可达（${p.name}），未开始解析：${detail}`;
      setFile(id, { status: 'error', error: msg, progress });
    }
    console.log(`[parse] ${p.name} 连接测试未通过，${ids.length} 份未开始解析`);
    this.probes.delete(key);
  }

  private async pump(): Promise<void> {
    for (;;) {
      if (this.queue.length === 0 && this.inflight.size === 0) {
        this.probes.clear();
        this.paused.clear();
      }
      const cap = Math.min(4, Math.max(1, getSettings().llmConcurrency));
      while (this.inflight.size < cap) {
        const idx = this.queue.findIndex((id) => !this.isFilePaused(id));
        if (idx < 0) break;
        const fileId = this.queue[idx];
        if (this.stopRequested.has(fileId)) {
          this.queue.splice(idx, 1);
          this.stopRequested.delete(fileId);
          this.llmOf.delete(fileId);
          this.pagesOf.delete(fileId);
          this.fresh.delete(fileId);
          restoreStopped(fileId);
          continue;
        }
        const profile = this.profileFor(fileId);
        const probe = await this.probeProfile(profile);
        if (!probe.ok) {
          this.failProfile(profile, probe.detail);
          continue;
        }
        const now = this.queue.indexOf(fileId);
        if (now < 0 || this.isFilePaused(fileId)) continue;
        this.queue.splice(now, 1);
        this.inflight.add(fileId);
        console.log(`[parse] 开始解析 file#${fileId} 模型 ${profile.name}（并发 ${this.inflight.size}/${cap}）`);
        void this.runOne(fileId).finally(() => {
          this.inflight.delete(fileId);
          this.llmOf.delete(fileId);
          this.pagesOf.delete(fileId);
          const taskId = this.taskIdOf(fileId);
          if (taskId != null) this.releasePauseIfIdle(taskId);
          if (this.inflight.size === 0 && this.queue.length === 0) {
            this.probes.clear();
            this.paused.clear();
          }
        });
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  private async runOne(fileId: number): Promise<void> {
    if (this.stopRequested.has(fileId)) {
      this.stopRequested.delete(fileId);
      this.fresh.delete(fileId);
      restoreStopped(fileId);
      return;
    }
    const exists = db.prepare('SELECT 1 FROM files WHERE id = ?').get(fileId);
    if (!exists) {
      this.fresh.delete(fileId);
      return;
    }
    this.controllers.set(fileId, new AbortController());
    const fresh = this.fresh.has(fileId);
    this.fresh.delete(fileId);
    const llm = this.llmOf.get(fileId);
    const pages = this.pagesOf.get(fileId);
    setFile(fileId, { status: 'parsing', error: null, progress: null });
    try {
      await parseFileTextLayer(fileId, { fresh: pages?.length ? false : fresh, llm, pages });
    } catch (e) {
      if (isStopped(e)) {
        console.log(`[parse] 已终止 file#${fileId}`);
        restoreStopped(fileId);
        return;
      }
      const msg = (e as Error).message;
      if (pages?.length) finishKept(fileId, `${msg}。原来的交易还在。`);
      else finishError(fileId, msg);
    } finally {
      this.controllers.delete(fileId);
      this.abortKind.delete(fileId);
      this.stopRequested.delete(fileId);
    }
  }
}

export const parseQueue = new ParseQueue();

/**
 * 已经入库的日期若能认出，收成 YYYY-MM-DD，并去掉因此打上的「日期格式异常」。
 * 余额断裂、摘要缺失这些别的原因留着。
 */
export function repairStoredDates(): number {
  const rows = db
    .prepare(
      `SELECT id, file_id, date, review_note, status FROM transactions
       WHERE (date IS NOT NULL AND date != '' AND date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
          OR IFNULL(review_note, '') LIKE '%日期格式异常%'`,
    )
    .all() as Array<{ id: number; file_id: number; date: string | null; review_note: string | null; status: string }>;
  const upd = db.prepare('UPDATE transactions SET date = ?, review_note = ?, status = ? WHERE id = ?');
  const touched = new Set<number>();
  let n = 0;
  const apply = db.transaction(() => {
    for (const r of rows) {
      const normalized = r.date ? normalizeBankDate(r.date) : undefined;
      const nextDate = normalized ?? r.date;
      const iso = !!nextDate && normalizeBankDate(nextDate) === nextDate;
      const nextNote = iso ? stripDateNote(r.review_note ?? '') : (r.review_note ?? '');
      const dateChanged = nextDate !== r.date;
      const noteChanged = nextNote !== (r.review_note ?? '');
      if (!dateChanged && !noteChanged) continue;
      let status = r.status;
      if (!nextNote && status === 'needs_review') status = 'ok';
      upd.run(nextDate, nextNote || null, status, r.id);
      touched.add(r.file_id);
      n++;
    }
    const fileUp = db.prepare(
      `UPDATE files SET status = 'done', updated_at = ?
       WHERE id = ? AND status = 'needs_review'
         AND NOT EXISTS (SELECT 1 FROM transactions WHERE file_id = files.id AND status = 'needs_review')`,
    );
    for (const fileId of touched) fileUp.run(now(), fileId);
  });
  apply();
  if (n > 0) console.log(`[parse] 已把 ${n} 笔日期整理成 YYYY-MM-DD`);
  return n;
}

/** 启动自愈：被打断的 parsing 复位 scanned，并自动开跑未解析的文件（M2 验收：放 PDF 自动出交易表） */
export function autoParsePending(): void {
  const active = new Set(parseQueue.queuedIds());
  const stuck = db.prepare(`SELECT id FROM files WHERE status = 'parsing'`).all() as { id: number }[];
  const reset = db.prepare(`UPDATE files SET status = 'scanned', progress = NULL WHERE id = ?`);
  for (const row of stuck) {
    if (!active.has(row.id)) reset.run(row.id);
  }
  const pending = (
    db.prepare(
      `SELECT id FROM files WHERE status = 'scanned' AND (tx_count = 0 OR (checkpoint IS NOT NULL AND checkpoint != ''))`,
    ).all() as { id: number }[]
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

/** 把上次没读完的文件重新入队，从断点继续。给「重新扫描」用。 */
export function enqueueResumable(taskId: number): number {
  const rows = db
    .prepare(`SELECT id, checkpoint FROM files WHERE task_id = ? AND status = 'error' AND checkpoint IS NOT NULL`)
    .all(taskId) as { id: number; checkpoint: string | null }[];
  let n = 0;
  for (const r of rows) {
    if (!fileResumeHint(r.checkpoint)) continue;
    if (parseQueue.enqueue(r.id)) n++;
  }
  return n;
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

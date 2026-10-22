/**
 * 流水表几何重建（PP-OCR 文字框 → 交易行）。
 *
 * 不同银行流水的抬头、字段名、列数都不同，所以这里不写死任何银行模板：
 *   1. 用同义词字典认出表头字段（日期/摘要/借方/贷方/余额/对方户名…）；
 *   2. 表头按 y 邻接分组，取字段最全的一组，按 x 重叠聚成列（支持多行表头/堆叠子字段）；
 *   3. 找一列「一行一个」的锚点（流水号 > 金额 > 余额 > 日期），用锚点切行；
 *   4. 每列按「离锚点最近的一行是首行，往下到下一个锚点前是续行」重建单元格；
 *   5. 结构化字段用正则从单元格原文里取，文字字段拼接后截掉印章/页脚噪声；
 *   6. 金额列粘连时用「两位小数 + 余额连续性 + 期初/期末余额」枚举拆分解。
 *
 * PP-OCR 是行级检测，窄列会被并成一个框；几何 + 业务约束能确定性地还原，
 * 比让视觉模型猜数字可靠。实在还原不了就返回 ok:false，交给调用方退回视觉模型。
 */
import type { OcrBox } from './ocr.js';

/* ---------- 同义词字典 ---------- */

const SYN: Array<[string, string[]]> = [
  // time 放在 date 前面：「交易时间」两边都能匹配，按「时间」理解更准
  ['time', ['时间', '交易时间', 'time']],
  ['date', ['交易日期', '记账日期', '日期', '交易日', 'date', 'tradedate', 'transactiondate', 'valuedate', 'postdate']],
  ['summary', ['摘要', '交易摘要', '业务摘要', '摘要abstract', 'abstract', 'description']],
  [
    'serial',
    [
      '流水号',
      '交易流水号',
      '日志号',
      '凭证号',
      '凭证代号',
      '凭证编号',
      '交易编号',
      '交易序号',
      '业务编号',
      '参考号',
      'serialnum',
      'serialno',
      'serial',
      'transactionseries',
      'referenceno',
    ],
  ],
  ['amount', ['交易金额', '发生金额', '发生额', '金额', '交易额', '收支金额', 'amount']],
  ['debit', ['借方发生额', '借方金额', '支出', '支出金额', '借方', 'debit']],
  ['credit', ['贷方发生额', '贷方金额', '收入', '收入金额', '贷方', 'credit']],
  ['balance', ['交易后余额', '交易余额', '余额', '联机余额', '账户余额', '当前余额', '可用余额', 'balance']],
  ['channel', ['交易渠道', '渠道', '业务类型', '交易类型', 'channel', 'businesstype']],
  [
    'counterparty_account',
    ['对方账号', '对方账户', '交易对手账号', '收款人账号', '付款人账号', '对方帐号', 'accountno', 'accountnumber'],
  ],
  ['counterparty_bank', ['对方开户行', '对方开户银行', '对方银行', '对方行名', '收款银行', '付款银行']],
  [
    'counterparty_name',
    [
      '对方户名',
      '对方名称',
      '对方单位',
      '交易对手',
      '对手信息',
      '对手方信息',
      '收款人',
      '付款人',
      '收付款人',
      'custname',
      'counterparty',
      'opposite',
    ],
  ],
  ['currency', ['币种', '货币', 'currency']],
  ['note', ['附言', '用途', '备注', 'postscript', 'remark', 'memo']],
  ['seq', ['序号', '编号', 'no', 'no.']],
];

const MONEY_FIELDS = new Set(['debit', 'credit', 'balance', 'amount']);

function norm(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[\s　()（）[\]【】:：,，.。/\\-]+/g, '');
}

/** 最长子串匹配字段名；认不出返回 undefined。 */
export function matchField(text: string): string | undefined {
  const t = norm(text);
  if (!t) return undefined;
  // 「借方/贷方金额」「Debit/Credit Amount」是同一列的带符号金额，
  // 不能按「含贷方」当成贷方列，否则支出会被记成收入。
  if (/借.*贷|debit.*credit/.test(t)) return 'amount';
  let best: { score: number; field: string } | undefined;
  for (const [field, labels] of SYN) {
    for (const label of labels) {
      const l = norm(label);
      if (!l) continue;
      const ok = t === l || (l.length >= 4 && t.includes(l)) || (t.length >= 4 && l.includes(t) && t.length >= l.length * 0.6);
      if (ok && (!best || l.length > best.score)) best = { score: l.length, field };
    }
  }
  return best?.field;
}

/* ---------- 正则 ---------- */

// 8 位日期必须自成一段：账号/流水号里连续的数字不能截一段当日期。
const DATE_TOKEN_RE = /(?<!\d)(\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2}|\d{8})(?!\d)/g;
const TIME_RE = /(\d{1,2}:\d{2}(?::\d{2})?)/;
// 金额数字必须自成一段：日期/时间里的数字（2026-02-04、14:51:38）不能截一段当金额。
const NUM_RE = /(?<![\d:.\-])([+-]?\d[\d,]*(?:\.\d+)?)(?![\d:.\-])/;
const SER_RE = /^[A-Za-z0-9][A-Za-z0-9\-_/.]{5,}$/;
// 「打印」不能单独算页脚：摘要里也有「打印机款」这类业务描述。
const FOOT_RE = /合计|经办|生成日期|打印(?:日期|时间|机构|[:：]|$)|制表|第\s*\d+\s*页|页码|复核|授权|银行盖章|业务专用章|扫描全能王|3亿人都在用|扫描App|合并统计币种/;
const NOISE_RE = /业务专用章|扫描全能王|3亿人都在用|扫描App|银行盖章|合并统计币种/;
// 对方户名格里混进来的短数字碎片（摘要折行、印章遮挡的残字），不可能是户名；
// 长数字是对方账号，要保留。
const SHORT_NUM_FRAG_RE = /^[\d\s.,:：/\\-]{1,7}$/;

/**
 * 拆出开头的对方账号（允许「03-8709…」这种带分隔符的账号）。
 * 账号后可能直接跟户名，也可能先有空格。
 */
function splitAccountLead(text: string): { account: string; rest: string } | null {
  const m = /^\d[\d\s\-]{6,}/.exec(text);
  if (!m || m[0].replace(/\D/g, '').length < 8) return null;
  return { account: m[0].trim(), rest: text.slice(m[0].length).trim() };
}

function accountLead(text: string): boolean {
  return splitAccountLead(text) !== null;
}
const STRUCT_RE: Record<string, RegExp> = {
  time: TIME_RE,
  amount: NUM_RE,
  debit: NUM_RE,
  credit: NUM_RE,
  balance: NUM_RE,
  serial: SER_RE,
};

/**
 * 8 位纯数字既可能是 YYYYMMDD，也可能是流水号。
 * 只有年月日都合法才当日期，避免把 65488473 认成 6548-84-73。
 */
function isFullDate(s: string): boolean {
  const t = s.trim();
  const hit = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(t) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(t);
  if (!hit) return false;
  const y = Number(hit[1]);
  const m = Number(hit[2]);
  const d = Number(hit[3]);
  if (y < 1970 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** 日期字符串 → UTC 毫秒，用来比较先后；非法日期返回 undefined。 */
function dateValue(s: string): number | undefined {
  const t = s.trim();
  const hit = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(t) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(t);
  if (!hit) return undefined;
  const y = Number(hit[1]);
  const m = Number(hit[2]);
  const d = Number(hit[3]);
  const dt = Date.UTC(y, m - 1, d);
  return new Date(dt).getUTCDate() === d ? dt : undefined;
}

function extract(field: string, text: string): string {
  if (field === 'date') {
    for (const m of text.matchAll(DATE_TOKEN_RE)) if (isFullDate(m[1])) return m[1];
    return '';
  }
  const rx = STRUCT_RE[field];
  if (!rx) return text;
  const m = rx.exec(text);
  return m ? m[0] : '';
}

function parseNum(s: string): number | undefined {
  const t = s
    .trim()
    .replace(/[,，¥￥\s]/g, '')
    .replace(/[−—]/g, '-');
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const a = [...nums].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

function mean(nums: number[]): number {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

/* ---------- 类型 ---------- */

interface CellBox extends OcrBox {
  field?: string;
  col?: Column;
  /** 这个文字块横跨了几列（>2 说明 OCR 把相邻格并成了一段） */
  spanCols?: number;
}

interface Column {
  x1: number;
  x2: number;
  boxes: CellBox[];
  fields: string[];
  center: number;
  left: number;
  right: number;
}

interface Anchor {
  cy: number;
  boxes: CellBox[];
}

export interface TableTx {
  date?: string;
  time?: string;
  summary?: string;
  serial?: string;
  amount: number;
  direction: 'in' | 'out';
  balance?: number;
  counterparty?: string;
  counterpartyAccount?: string;
  channel?: string;
  currency?: string;
  note?: string;
  confidence: number;
  review: string;
  raw: string;
}

export interface TableMeta {
  bank?: string;
  accountNo?: string;
  accountName?: string;
  periodStart?: string;
  periodEnd?: string;
}

export interface TablePage {
  txs: TableTx[];
  meta: TableMeta;
  /** 每列的字段名，诊断用 */
  columns: string[][];
  rowCount: number;
  openingBalance?: number;
  closingBalance?: number;
  continuityBreaks: number;
  usedMoneySolver: boolean;
  /** 表头没识别出来，列是按数据内容 + 余额连续性推断的 */
  headerless?: boolean;
}

export type TableOutcome = { ok: true; page: TablePage } | { ok: false; reason: string };

/* ---------- 页眉元信息 ---------- */

function extractMeta(boxes: OcrBox[], firstDataY: number): TableMeta {
  const head = boxes.filter((b) => b.cy < firstDataY + 10);
  const spaced = head.map((b) => b.text).join(' ');
  const compact = spaced.replace(/\s+/g, '');
  const meta: TableMeta = {};

  const bank = /[一-鿿]{2,12}(?:农村商业银行|农村信用合作联社|农商银行|银行|信用社)/.exec(compact);
  if (bank) meta.bank = bank[0];

  // 账号标签常带英文括号：户口号(Account No): / 账号： / 结算账号(Account):
  const acct = /(?:户口号|账号|帐号|结算账号|账户)\s*(?:[(（][^)）]{0,24}[)）])?\s*[：:]\s*([0-9]{6,32})/.exec(compact);
  if (acct) meta.accountNo = acct[1];

  const name =
    /(?:账户名称|户名|ACCOUNTNAME)\s*(?:[(（][^)）]{0,24}[)）])?\s*[：:]\s*([^\d：:]{2,40}?)(?=账号|帐号|开户|币种|日期|期间|序号|客户|账户|受理|类型|ACCOUNT|$)/i.exec(
      compact,
    ) ?? /(?:账户名称|户名|ACCOUNTNAME)\s*(?:[(（][^)）]{0,24}[)）])?\s*[：:]\s*([^\d：:]{2,40})/i.exec(compact);
  if (name) {
    const v = name[1].replace(/[（(].*$/, '').trim();
    if (v && !/^(名称|户名)$/.test(v)) meta.accountName = v;
  }

  const period =
    /((?:19|20)\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?)\s*(?:至|到|~|—|－|-)\s*((?:19|20)\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?)/.exec(
      spaced,
    ) ?? /((?:19|20)\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?)\s*(?:至|到|~|—|－|-)\s*((?:19|20)\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?)/.exec(compact);
  if (period) {
    meta.periodStart = period[1];
    meta.periodEnd = period[2];
  } else {
    const start = /(?:起始日期|开始日期|起始|开始)\s*[：:]?\s*((?:19|20)\d{2}[-/.]\d{1,2}[-/.]\d{1,2}|\d{8})/.exec(compact);
    const end = /(?:终止日期|结束日期|截止日期|终止|结束|截止)\s*[：:]?\s*((?:19|20)\d{2}[-/.]\d{1,2}[-/.]\d{1,2}|\d{8})/.exec(compact);
    if (start) meta.periodStart = start[1];
    if (end) meta.periodEnd = end[1];
  }
  return meta;
}

/* ---------- 金额列粘连拆解 ---------- */

interface MoneySolution {
  values: Record<string, number | null>;
  texts: Record<number, string>;
  continuity: boolean;
}

interface MoneyResult {
  rows: Array<MoneySolution | null>;
  opening?: number;
  closing?: number;
  merged: boolean;
}

function footerBalance(boxes: OcrBox[], key: RegExp): number | undefined {
  for (const b of boxes) {
    const m = key.exec(b.text);
    if (!m) continue;
    const n = parseNum(m[1]);
    if (n != null) return n;
  }
  return undefined;
}

function solveMoney(
  data: CellBox[],
  columns: Column[],
  anchors: Anchor[],
  pageFootY: number,
  prevBalance?: number,
): MoneyResult | null {
  const moneyCols = columns.filter((c) => c.fields.some((f) => MONEY_FIELDS.has(f))).sort((a, b) => a.center - b.center);
  if (moneyCols.length < 2) return null;

  const gx1 = Math.min(...moneyCols.map((c) => c.left));
  const gx2 = Math.max(...moneyCols.map((c) => c.right));
  const afterLast = anchors.length ? anchors[anchors.length - 1].cy + 60 : -Infinity;
  const footBoxes = data.filter((b) => b.cy > afterLast);
  const opening = footerBalance(footBoxes, /(?:期初余额|OPENING\s*BALANCE)[^0-9]{0,8}([0-9][0-9,]*\.?[0-9]*)/i);
  const closing = footerBalance(footBoxes, /(?:期末余额|ENDING\s*BALANCE)[^0-9]{0,8}([0-9][0-9,]*\.?[0-9]*)/i);
  const footY = Math.min(
    pageFootY,
    ...data.filter((b) => /期初|期末|OPENING|ENDING|银行盖章/i.test(b.text)).map((b) => b.y1),
    Infinity,
  );

  const rows: Array<MoneySolution | null> = [];
  let prev = prevBalance ?? opening;
  let mergedAny = false;

  for (let ai = 0; ai < anchors.length; ai++) {
    const a = anchors[ai];
    const lo = ai > 0 ? (anchors[ai - 1].cy + a.cy) / 2 : -Infinity;
    const hi = ai + 1 < anchors.length ? (anchors[ai + 1].cy + a.cy) / 2 : footY;
    const bs = data
      .filter((b) => gx1 <= b.cx && b.cx <= gx2 && lo <= b.cy && b.cy < hi)
      .sort((x, y) => x.cy - y.cy || x.cx - y.cx);
    if (bs.length === 0) {
      rows.push(null);
      continue;
    }

    // 同一条视觉行上的文字块
    const lines: Array<{ cy: number; boxes: CellBox[] }> = [];
    for (const b of bs) {
      const last = lines[lines.length - 1];
      if (last) {
        const medh = median(last.boxes.map((x) => x.h));
        if (Math.abs(b.cy - last.cy) <= Math.max(6, 0.55 * medh)) {
          last.boxes.push(b);
          last.cy = mean(last.boxes.map((x) => x.cy));
          continue;
        }
      }
      lines.push({ cy: b.cy, boxes: [b] });
    }

    const frags: Array<Array<[number, number, string]>> = moneyCols.map(() => []);
    const merged: Array<{ li: number; b: CellBox; span: number[] }> = [];
    for (let li = 0; li < lines.length; li++) {
      for (const b of lines[li].boxes) {
        const ovs: Array<[number, number]> = [];
        for (let i = 0; i < moneyCols.length; i++) {
          const c = moneyCols[i];
          const ov = Math.min(c.right, b.x2) - Math.max(c.left, b.x1);
          // 列边界是相邻列中心的中点，长账号格可能压到隔壁金额列十来个像素；
          // 至少要占格子宽度的两成才算落在这列，否则账号会被拼进余额。
          if (ov > Math.max(2, 0.2 * (b.x2 - b.x1))) ovs.push([ov, i]);
        }
        if (ovs.length === 0) continue;
        ovs.sort((x, y) => y[0] - x[0]);
        if (ovs.length === 1 || ovs[0][0] > 0.75 * (b.x2 - b.x1)) {
          frags[ovs[0][1]].push([li, b.cy, b.text]);
        } else {
          merged.push({ li, b, span: ovs.map((x) => x[1]).sort((x, y) => x - y) });
        }
      }
    }
    if (merged.length > 0) mergedAny = true;

    // 粘连框的切分枚举（最多 5000 种，防爆炸）
    let opts: Array<Record<number, [number, number, string]>> = [{}];
    for (const { li, b, span } of merged) {
      const text = b.text.trim();
      const next: Array<Record<number, [number, number, string]>> = [];
      if (span.length === 2) {
        for (let k = 1; k < text.length; k++) {
          next.push({ [span[0]]: [li, b.cy, text.slice(0, k)], [span[1]]: [li, b.cy, text.slice(k)] });
        }
      } else if (span.length === 3) {
        for (let k1 = 1; k1 < text.length - 1; k1++) {
          for (let k2 = k1 + 1; k2 < text.length; k2++) {
            next.push({
              [span[0]]: [li, b.cy, text.slice(0, k1)],
              [span[1]]: [li, b.cy, text.slice(k1, k2)],
              [span[2]]: [li, b.cy, text.slice(k2)],
            });
          }
        }
      }
      const combined: Array<Record<number, [number, number, string]>> = [];
      for (const o of opts) for (const n of next) combined.push({ ...o, ...n });
      opts = combined.slice(0, 5000);
      if (opts.length === 0) opts = [{}];
    }

    const sols: Array<{ ok: boolean; quality: number; sol: MoneySolution }> = [];
    for (const opt of opts) {
      const texts: Record<number, string> = {};
      for (let i = 0; i < moneyCols.length; i++) {
        const parts = [...frags[i], ...(opt[i] ? [opt[i]] : [])].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
        texts[i] = parts.map((p) => p[2]).join('');
      }
      const values: Record<string, number | null> = {};
      for (let i = 0; i < moneyCols.length; i++) {
        const f = moneyCols[i].fields[0];
        const t = texts[i].replace(/[,，]/g, '').trim();
        values[f] = t ? (parseNum(t) ?? null) : null;
      }
      if (values.balance == null) continue;
      const b = values.balance;
      let ok = false;
      if (prev != null) {
        if (values.credit != null && Math.abs(prev + values.credit - b) < 0.011) ok = true;
        else if (values.debit != null && Math.abs(prev - values.debit - b) < 0.011) ok = true;
        else if (values.amount != null && Math.abs(prev + values.amount - b) < 0.011) ok = true;
      } else {
        ok = true;
      }
      let quality = 0;
      for (let i = 0; i < moneyCols.length; i++) {
        const f = moneyCols[i].fields[0];
        if (values[f] == null) continue;
        const t = texts[i].replace(/[,，]/g, '').trim();
        if (/^\d+\.\d{2}$/.test(t)) quality += 2;
        else if (/^\d+\.\d$/.test(t)) quality += 1;
        if (/^(0|[1-9]\d*)$/.test(t.split('.')[0] ?? '')) quality += 1;
      }
      sols.push({ ok, quality, sol: { values, texts, continuity: ok } });
    }
    sols.sort((x, y) => Number(y.ok) - Number(x.ok) || y.quality - x.quality);
    const best = sols[0]?.sol ?? null;
    if (best?.values.balance != null) prev = best.values.balance;
    rows.push(best);
  }

  return { rows, opening, closing, merged: mergedAny };
}

/* ---------- 无表头兜底 ---------- */

/**
 * 少数银行把表头做成图片/底纹，OCR 只能读到数据区。这里不假设列名：
 * 用「日期、金额、账号」的内容特征聚出列，再用余额连续性反推
 * 哪个金额列是借方、贷方或带符号金额，哪个是余额。
 * 推断不出唯一且连续成立的布局就放弃，交给视觉模型。
 */
function inferHeaderlessLayout(
  boxes: CellBox[],
  firstDataY: number,
): { columns: Column[]; headerBottom: number; headerH: number } | null {
  const data = boxes.filter((b) => b.y1 >= firstDataY - 2);
  if (data.length < 20) return null;
  const moneyOf = (t: string): number | undefined => {
    const s = t.trim();
    if (!/^[+-]?\d[\d,]*\.\d{2}$/.test(s)) return undefined;
    return parseNum(s);
  };
  const isDateBox = (t: string): boolean => {
    const m = /^(\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2}|\d{8})$/.exec(t.trim());
    return !!m && isFullDate(m[1]);
  };
  const isAccountBox = (t: string): boolean =>
    /^\d[\d\s\-]{7,}$/.test(t.trim()) && t.replace(/\D/g, '').length >= 8;

  const dateBoxes = data.filter((b) => isDateBox(b.text));
  if (dateBoxes.length < 3) return null;

  // 只用「有明确内容特征」的格子聚列，避免被跨列的粘连文字带偏。
  const seeds = data.filter((b) => isDateBox(b.text) || moneyOf(b.text) != null || isAccountBox(b.text));
  const clusters: Column[] = [];
  for (const b of [...seeds].sort((x, y) => x.cx - y.cx)) {
    let hit: Column | undefined;
    for (const c of clusters) {
      const ov = Math.min(c.x2, b.x2) - Math.max(c.x1, b.x1);
      const w = Math.min(c.x2 - c.x1, b.x2 - b.x1);
      if (w > 0 && ov / w > 0.5) {
        hit = c;
        break;
      }
    }
    if (hit) {
      hit.boxes.push(b);
      hit.x1 = Math.min(hit.x1, b.x1);
      hit.x2 = Math.max(hit.x2, b.x2);
    } else {
      clusters.push({ x1: b.x1, x2: b.x2, boxes: [b], fields: [], center: 0, left: -Infinity, right: Infinity });
    }
  }
  for (const c of clusters) c.center = mean(c.boxes.map((b) => b.cx));
  clusters.sort((x, y) => x.center - y.center);

  const frac = (c: Column, pred: (t: string) => boolean) =>
    c.boxes.length ? c.boxes.filter((b) => pred(b.text)).length / c.boxes.length : 0;
  const dateCols = clusters.filter((c) => c.boxes.length >= 3 && frac(c, isDateBox) >= 0.8);
  if (dateCols.length === 0) return null;
  const dateCol = dateCols.reduce((p, c) => (c.boxes.length > p.boxes.length ? c : p));
  const moneyCols = clusters.filter((c) => c.boxes.length >= 3 && frac(c, (t) => moneyOf(t) != null) >= 0.6);
  if (moneyCols.length < 2) return null;
  const acctCol =
    clusters
      .filter((c) => c !== dateCol && !moneyCols.includes(c) && c.boxes.length >= 3 && frac(c, isAccountBox) >= 0.6)
      .sort((x, y) => y.boxes.length - x.boxes.length)[0] ?? null;

  // 行锚：日期块。同一行被 OCR 拆成多个日期块时按近邻合并。
  const rowY: number[] = [];
  for (const y of dateCol.boxes.map((b) => b.cy).sort((x, y) => x - y)) {
    const last = rowY[rowY.length - 1];
    if (last != null && y - last < 10) rowY[rowY.length - 1] = (last + y) / 2;
    else rowY.push(y);
  }
  if (rowY.length < 3) return null;

  const bandOf = (i: number): [number, number] => [
    i > 0 ? (rowY[i - 1] + rowY[i]) / 2 : -Infinity,
    i + 1 < rowY.length ? (rowY[i] + rowY[i + 1]) / 2 : Infinity,
  ];
  const valAt = (c: Column, i: number): number | null => {
    const [lo, hi] = bandOf(i);
    const vs = new Set<number>();
    for (const b of data) {
      if (b.cx < c.x1 - 1 || b.cx > c.x2 + 1 || b.cy < lo || b.cy >= hi) continue;
      const v = moneyOf(b.text);
      if (v != null) vs.add(v);
    }
    return vs.size === 1 ? [...vs][0] : null;
  };

  /** 余额列必须逐行对得上：prev + 变动 = cur。 */
  const score = (balance: Column, delta: (i: number) => number) => {
    let matched = 0;
    let tested = 0;
    let seen = 0;
    for (let i = 0; i < rowY.length; i++) {
      const cur = valAt(balance, i);
      if (cur == null) continue;
      seen++;
      if (i === 0) continue;
      const prev = valAt(balance, i - 1);
      if (prev == null) continue;
      tested++;
      if (Math.abs(prev + delta(i) - cur) < 0.011) matched++;
    }
    return { matched, tested, seen };
  };

  type Layout = {
    balance: Column;
    amount?: Column;
    debit?: Column;
    credit?: Column;
    matched: number;
    tested: number;
    seen: number;
  };
  const layouts: Layout[] = [];
  for (const balance of moneyCols) {
    const others = moneyCols.filter((c) => c !== balance);
    if (others.length === 1) {
      const amount = others[0];
      const s = score(balance, (i) => valAt(amount, i) ?? 0);
      layouts.push({ balance, amount, ...s });
    }
    for (const debit of others) {
      for (const credit of others) {
        if (debit === credit) continue;
        const s = score(balance, (i) => (valAt(credit, i) ?? 0) - (valAt(debit, i) ?? 0));
        layouts.push({ balance, debit, credit, ...s });
      }
    }
  }
  const minTested = Math.max(3, Math.floor(rowY.length * 0.5));
  const valid = layouts
    .filter((l) => l.tested >= minTested && l.seen >= rowY.length * 0.6 && l.matched / l.tested >= 0.8)
    .sort((x, y) => y.matched / y.tested - x.matched / x.tested || y.matched - x.matched);
  const best = valid[0];
  if (!best) return null;

  for (const c of clusters) c.fields = [];
  dateCol.fields = ['date'];
  best.balance.fields = ['balance'];
  if (best.amount) best.amount.fields = ['amount'];
  if (best.debit) best.debit.fields = ['debit'];
  if (best.credit) best.credit.fields = ['credit'];
  if (acctCol) acctCol.fields = ['counterparty_account'];

  return { columns: clusters, headerBottom: firstDataY - 2, headerH: Math.max(20, median(data.map((b) => b.h))) };
}

/* ---------- 主流程 ---------- */

interface BuildCore {
  boxes: CellBox[];
  data: CellBox[];
  columns: Column[];
  anchorCol: Column;
  anchors: Anchor[];
  cells: Map<number, CellBox[][]>;
  firstDataY: number;
  footY: number;
  /** 表头没识别出来，列是按数据内容 + 余额连续性推断的 */
  headerless?: boolean;
}

function buildCore(raw: OcrBox[]): BuildCore | { reason: string } {
  const boxes: CellBox[] = raw.map((b) => ({ ...b }));
  if (boxes.length === 0) return { reason: 'OCR 没有文字' };

  const dateBoxes = boxes.filter((b) => {
    const m = /^(\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2}|\d{8})$/.exec(b.text.trim());
    return !!m && isFullDate(m[1]);
  });
  const firstDataY = dateBoxes.length ? Math.min(...dateBoxes.map((b) => b.y1)) : Math.min(...boxes.map((b) => b.y1));

  // 表头候选：能匹配字段名的文字块，按 y 邻接分组
  const matches = boxes.filter((b) => matchField(b.text));
  // 数据区里同一列反复出现的「支出/收入」（借贷标志）也能匹配字段名。
  // 同一文字在同一 x 位置纵向重复多次，是数据不是表头。
  const isRepeatedLabel = (b: CellBox): boolean => {
    const t = norm(b.text);
    let n = 0;
    for (const o of matches) {
      if (o === b || norm(o.text) !== t) continue;
      const ov = Math.min(o.x2, b.x2) - Math.max(o.x1, b.x1);
      const w = Math.min(o.x2 - o.x1, b.x2 - b.x1);
      if (w > 0 && ov / w > 0.5) n++;
    }
    return n >= 3;
  };
  const headerMatches = matches.filter((b) => !isRepeatedLabel(b));
  // 表头最多三四行，避免把紧挨着的整列数据并进来。
  const headerSpan = Math.max(80, median(headerMatches.map((b) => b.h)) * 5);
  const groups: Array<{ y1: number; y2: number; boxes: CellBox[] }> = [];
  for (const b of [...headerMatches].sort((x, y) => x.y1 - y.y1)) {
    const g = groups[groups.length - 1];
    if (g && b.y1 - g.y2 <= 40 && b.y2 - g.y1 <= headerSpan) {
      g.boxes.push(b);
      g.y2 = Math.max(g.y2, b.y2);
    } else {
      groups.push({ y1: b.y1, y2: b.y2, boxes: [b] });
    }
  }
  let hdr: CellBox[] = [];
  let bestScore: [number, number] = [-1, -Infinity];
  for (const g of groups) {
    const fields = new Set(g.boxes.map((b) => matchField(b.text)).filter(Boolean));
    const score: [number, number] = [fields.size, -Math.abs(g.y1 - firstDataY)];
    if (score[0] > bestScore[0] || (score[0] === bestScore[0] && score[1] > bestScore[1])) {
      bestScore = score;
      hdr = g.boxes;
    }
  }
  let headerBottom: number;
  let headerH: number;
  let columns: Column[];
  let headerless = false;
  if (hdr.length === 0) {
    const inferred = inferHeaderlessLayout(boxes, firstDataY);
    if (!inferred) return { reason: '没认出表头字段' };
    columns = inferred.columns;
    headerBottom = inferred.headerBottom;
    headerH = inferred.headerH;
    headerless = true;
  } else {
    headerBottom = Math.max(...hdr.map((b) => b.y2));
    headerH = median(hdr.map((b) => b.y2 - b.y1));
    for (const b of hdr) b.field = matchField(b.text);

    // 表头按 x 重叠聚成列；一列里按 y 顺序收集字段（支持堆叠子字段）
    columns = [];
    for (const b of [...hdr].sort((x, y) => x.cx - y.cx)) {
      let hit: Column | undefined;
      for (const c of columns) {
        const ov = Math.min(c.x2, b.x2) - Math.max(c.x1, b.x1);
        const w = Math.min(c.x2 - c.x1, b.x2 - b.x1);
        if (w > 0 && ov / w > 0.45) {
          hit = c;
          break;
        }
      }
      if (hit) {
        hit.boxes.push(b);
        hit.x1 = Math.min(hit.x1, b.x1);
        hit.x2 = Math.max(hit.x2, b.x2);
      } else {
        columns.push({ x1: b.x1, x2: b.x2, boxes: [b], fields: [], center: 0, left: -Infinity, right: Infinity });
      }
    }
    for (const c of columns) {
      c.boxes.sort((x, y) => x.y1 - y.y1 || x.cx - y.cx);
      c.fields = [];
      for (const b of c.boxes) if (b.field && !c.fields.includes(b.field)) c.fields.push(b.field);
      c.center = mean(c.boxes.map((b) => b.cx));
    }
    columns.sort((x, y) => x.center - y.center);
  }

  const data = boxes.filter((b) => b.y1 >= headerBottom - 0.35 * headerH);
  if (data.length === 0) return { reason: '表头下面没有内容' };
  const minx = Math.min(...data.map((b) => b.x1));
  const maxx = Math.max(...data.map((b) => b.x2));

  // 页脚边界：最后一笔日期之后出现的「合计/经办/页码」才算页脚。
  // 合计行的数字本身不带关键词，必须靠位置排除，否则会被当成一笔交易。
  const dateCys: number[] = [];
  for (const b of data) {
    // 页脚的「生成日期/打印日期」不是交易日期，不能用来定表格边界。
    if (FOOT_RE.test(b.text)) continue;
    for (const m of b.text.matchAll(DATE_TOKEN_RE)) {
      if (isFullDate(m[1])) {
        dateCys.push(b.cy);
        break;
      }
    }
  }
  const lastDateCy = dateCys.length ? Math.max(...dateCys) : -Infinity;
  const footY = dateCys.length
    ? Math.min(
        ...data.filter((b) => FOOT_RE.test(b.text) && b.cy > lastDateCy + 20).map((b) => b.y1),
        Infinity,
      )
    : Infinity;

  for (let i = 0; i < columns.length; i++) {
    const c = columns[i];
    c.left = i === 0 ? -Infinity : (columns[i - 1].center + c.center) / 2;
    c.right = i === columns.length - 1 ? Infinity : (c.center + columns[i + 1].center) / 2;
  }
  columns[0].left = minx - 1;
  columns[columns.length - 1].right = maxx + 1;

  for (const b of data) {
    let best: { ov: number; col: Column } | undefined;
    let spans = 0;
    for (const c of columns) {
      const ov = Math.min(c.right, b.x2) - Math.max(c.left, b.x1);
      if (ov > 0) {
        if (ov > 0.15 * (b.x2 - b.x1)) spans++;
        if (!best || ov > best.ov) best = { ov, col: c };
      }
    }
    b.col = best?.col ?? columns.reduce((p, c) => (Math.abs(c.center - b.cx) < Math.abs(p.center - b.cx) ? c : p));
    b.spanCols = spans;
  }

  // 有些银行的日期和时间共用一列（表头只写「交易时间」，单元格里日期在上、时间在下）。
  // 这列的数据里出现合法日期时，补一个 date 字段放在前面。
  for (const c of columns) {
    if (!c.fields.includes('time') || c.fields.includes('date')) continue;
    const hasDate = data.some((b) => {
      if (b.col !== c) return false;
      for (const m of b.text.matchAll(DATE_TOKEN_RE)) if (isFullDate(m[1])) return true;
      return false;
    });
    if (hasDate) c.fields.unshift('date');
  }

  const colBoxes = (c: Column) => data.filter((b) => b.col === c).sort((x, y) => x.cy - y.cy || x.cx - y.cx);

  // 锚点列：一行一个文字块的列，优先流水号 > 金额 > 余额 > 日期。
  // 先按字段筛选有效值再算规律性，避免「8 位流水号被当日期」这类误判。
  const validFor = (field: string, b: CellBox): boolean => {
    if (FOOT_RE.test(b.text)) return false;
    if (field === 'serial') return SER_RE.test(b.text.trim()) && !/[一-鿿]/.test(b.text);
    if (field === 'amount' || field === 'debit' || field === 'credit' || field === 'balance') {
      return parseNum(b.text) != null;
    }
    if (field === 'date') {
      // OCR 有时把日期和摘要并成一个框：「20260104 转取」也算日期格
      for (const m of b.text.matchAll(DATE_TOKEN_RE)) if (isFullDate(m[1])) return true;
      return false;
    }
    return !matchField(b.text);
  };
  const qualityOf = (field: string, bs: CellBox[]): [number, number, number] => {
    const pref = field === 'serial' ? 3 : field === 'amount' ? 2 : field === 'balance' ? 1 : 0;
    if (bs.length === 0) return [pref, 0, 0];
    const ys = bs.map((b) => b.cy).sort((x, y) => x - y);
    const gaps = ys.slice(1).map((y, i) => y - ys[i]).filter((g) => g > 5).sort((x, y) => x - y);
    if (gaps.length === 0) return [pref, 0, bs.length];
    const pitch = gaps[Math.floor(gaps.length / 2)];
    const regular = gaps.filter((g) => pitch * 0.5 < g && g < pitch * 1.6).length / gaps.length;
    return [pref, regular, bs.length];
  };
  const better = (a: [number, number, number], b: [number, number, number]): boolean =>
    a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])));

  let anchorCol: Column | undefined;
  let afield = '';
  let aboxes: CellBox[] = [];
  const options: Array<{ c: Column; field: string; bs: CellBox[]; q: [number, number, number] }> = [];
  for (const c of columns) {
    for (const field of ['serial', 'amount', 'balance', 'date']) {
      if (!c.fields.includes(field)) continue;
      const bs = colBoxes(c).filter((b) => validFor(field, b) && b.cy < footY);
      if (bs.length === 0) continue;
      options.push({ c, field, bs, q: qualityOf(field, bs) });
    }
  }
  if (options.length === 0) return { reason: '没有可作行锚点的列' };
  // 锚点列必须覆盖绝大多数行。某一行的流水号被并进别的格时，流水号列会少一行，
  // 光看「优先级最高」会漏掉整笔交易；这时改用覆盖更全的金额/日期列。
  const maxCount = Math.max(...options.map((o) => o.bs.length));
  const covered = options.filter((o) => o.bs.length >= maxCount * 0.8);
  let bestQ: [number, number, number] = [-1, -1, -1];
  for (const o of covered) {
    if (better(o.q, bestQ)) {
      bestQ = o.q;
      anchorCol = o.c;
      afield = o.field;
      aboxes = o.bs;
    }
  }
  if (!anchorCol || aboxes.length === 0) return { reason: '没有可作行锚点的列' };
  const ays = aboxes.map((b) => b.cy).sort((x, y) => x - y);
  const agaps = ays.slice(1).map((y, i) => y - ays[i]).filter((g) => g > 5).sort((x, y) => x - y);
  const pitch = agaps.length ? agaps[Math.floor(agaps.length / 2)] : 40;

  const anchors: Anchor[] = [];
  for (const b of aboxes) {
    const last = anchors[anchors.length - 1];
    if (last && b.cy - last.cy < pitch * 0.45) {
      last.boxes.push(b);
      last.cy = mean(last.boxes.map((x) => x.cy));
    } else {
      anchors.push({ cy: b.cy, boxes: [b] });
    }
  }
  const kept = anchors.filter((a) => a.boxes.length <= 3);
  anchors.length = 0;
  anchors.push(...kept);

  // 每列单元格：这一列「首字段」的行（离锚点最近的一行）到下一行的首字段之前，
  // 中间都算本格。不能按锚点中点切：日期/时间在格内上下错开半行时会被切到下一笔。
  const isFirstLine = (c: Column, b: CellBox): boolean => {
    const f = c.fields[0];
    if (!f) return false;
    if (f === 'date') return validFor('date', b);
    if (f === 'time') return TIME_RE.test(b.text);
    if (STRUCT_RE[f]) return extract(f, b.text) !== '';
    return true; // 文字列：每个文字块都可能是一格的起点
  };
  const tol = pitch * 0.48;
  const cells = new Map<number, CellBox[][]>();
  for (const c of columns) {
    const bs = colBoxes(c);
    const f0 = c.fields[0];
    const textCol = !!f0 && f0 !== 'date' && f0 !== 'time' && !STRUCT_RE[f0];
    // 文字列的首行必须和锚点对齐得更紧：上一笔户名折行后可能离下一笔锚点更近，
    // 用 0.48 的容差会把这行残字抢成下一笔的对方户名。
    const colTol = textCol ? pitch * 0.28 : tol;
    // 对方户名列几乎总是一行「账号 + 户名」，后面的折行才是户名续行。
    // 用「以账号开头的行」当行首，折行残字就不会被下一笔抢走；手续费/利息行本来就没有对方。
    const cpAnchored = f0 === 'counterparty_name' && bs.filter((b) => accountLead(b.text)).length >= 3;
    // 文字列有两种排版：一种是贴着锚点起头（摘要），一种是在行高内上下居中
    // （兴业这种「户名两行夹着账号」）。看整列文字相对锚点的中位偏移来区分。
    let centered = false;
    if (textCol && !cpAnchored && bs.length && anchors.length > 1) {
      const ds = bs.map((b) => {
        let best = anchors[0];
        for (const a of anchors) if (Math.abs(b.cy - a.cy) < Math.abs(b.cy - best.cy)) best = a;
        return b.cy - best.cy;
      });
      centered = Math.abs(median(ds)) <= pitch * 0.15;
    }
    const cand = cpAnchored ? bs.filter((b) => accountLead(b.text)) : bs.filter((b) => isFirstLine(c, b));
    const firsts = new Map<number, CellBox>();
    for (let ai = 0; ai < anchors.length; ai++) {
      let best: { d: number; b: CellBox } | undefined;
      for (const b of cand) {
        const d = Math.abs(b.cy - anchors[ai].cy);
        if (d <= colTol && (!best || d < best.d)) best = { d, b };
      }
      if (best) firsts.set(ai, best.b);
    }
    // 同一个文字块被相邻锚点抢走时，留给更近的锚点
    const used = new Map<CellBox, number>();
    for (const [ai, b] of [...firsts.entries()]) {
      const other = used.get(b);
      if (other == null) {
        used.set(b, ai);
        continue;
      }
      if (Math.abs(b.cy - anchors[ai].cy) < Math.abs(b.cy - anchors[other].cy)) {
        firsts.delete(other);
        used.set(b, ai);
      } else {
        firsts.delete(ai);
      }
    }
    if (process.env.FLOW_TABLE_DEBUG) {
      console.log(
        '[table] firsts',
        c.fields.join('/'),
        'tol',
        Math.round(colTol),
        'anchors',
        anchors.length,
        'keys',
        firsts.size,
        'footY',
        Math.round(footY),
        'lastFirst',
        firsts.has(anchors.length - 1)
          ? `${firsts.get(anchors.length - 1)!.text}@${Math.round(firsts.get(anchors.length - 1)!.cy)}`
          : '-',
        'lastAnchorCy',
        Math.round(anchors[anchors.length - 1].cy),
        'near',
        cand
          .filter((b) => Math.abs(b.cy - anchors[anchors.length - 1].cy) < 100)
          .map((b) => `${b.text}@${Math.round(b.cy)}`),
      );
    }
    const order = [...firsts.entries()].sort((x, y) => x[1].cy - y[1].cy);
    const perAnchor: CellBox[][] = anchors.map(() => []);
    if (cpAnchored) {
      // 对方户名常是「户名第一行 / 账号+户名第二行 / 户名第三行」上下居中，
      // 账号行是行的中心，不是行的顶端。按离账号行最近来分，不能按首行向下切。
      for (let j = 0; j < order.length; j++) {
        const [ai, f] = order[j];
        const lo = j > 0 ? (order[j - 1][1].cy + f.cy) / 2 : -Infinity;
        const hi = j + 1 < order.length ? (f.cy + order[j + 1][1].cy) / 2 : Math.min(Infinity, footY);
        perAnchor[ai] = bs.filter((b) => b.cy >= lo && b.cy < hi);
      }
    } else if (centered) {
      for (let ai = 0; ai < anchors.length; ai++) {
        perAnchor[ai] = bs.filter((b) => {
          if (b.cy >= footY) return false;
          let bi = 0;
          for (let k = 1; k < anchors.length; k++) {
            if (Math.abs(b.cy - anchors[k].cy) < Math.abs(b.cy - anchors[bi].cy)) bi = k;
          }
          return bi === ai;
        });
      }
    } else {
      for (let j = 0; j < order.length; j++) {
        const [ai, f] = order[j];
        const hi = j + 1 < order.length ? order[j + 1][1].cy : Math.min(Infinity, footY);
        perAnchor[ai] = bs.filter((b) => f.cy - 0.1 <= b.cy && b.cy < hi);
      }
    }
    cells.set(c.center, perAnchor);
  }

  if (process.env.FLOW_TABLE_DEBUG) {
    console.log('[table] cols', columns.map((c) => ({ f: c.fields, cx: Math.round(c.center), l: Math.round(c.left), r: Math.round(c.right) })));
    console.log('[table] anchor', anchorCol.fields, 'rows', anchors.map((a) => Math.round(a.cy)));
    for (const c of columns) {
      console.log('[table] cells', c.fields.join('/'), anchors.map((_, ai) => (cells.get(c.center)?.[ai] ?? []).map((b) => b.text)));
    }
    const emptyRows = anchors.map((_, ai) => ai).filter((ai) => columns.every((c) => (cells.get(c.center)?.[ai] ?? []).length === 0));
    console.log('[table] empty rows', emptyRows, 'anchors', anchors.length);
  }
  return { boxes, data, columns, anchorCol, anchors, cells, firstDataY, footY, headerless };
}

function assemble(lines: CellBox[], fields: string[]): Record<string, string> {
  const sorted = [...lines].sort((x, y) => x.cy - y.cy || x.cx - y.cx);
  const txt = sorted.map((b) => b.text);
  if (fields.length === 0) return {};
  const isStructured = (f: string) => f === 'date' || !!STRUCT_RE[f];
  if (fields.length === 1) {
    const f = fields[0];
    if (isStructured(f)) {
      return { [f]: txt.map((t) => extract(f, t)).find(Boolean) ?? '' };
    }
    const v = txt
      .filter((t) => !FOOT_RE.test(t) && !(f === 'counterparty_name' && SHORT_NUM_FRAG_RE.test(t)))
      .join('');
    const m = NOISE_RE.exec(v);
    return { [f]: m && m.index > 0 ? v.slice(0, m.index) : v };
  }
  const res: Record<string, string> = {};
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const seg = i === fields.length - 1 ? txt.slice(i) : txt.slice(i, i + 1);
    if (isStructured(f)) {
      res[f] = seg.map((t) => extract(f, t)).find(Boolean) ?? '';
    } else {
      const v = seg
        .filter((t) => !FOOT_RE.test(t) && !(f === 'counterparty_name' && SHORT_NUM_FRAG_RE.test(t)))
        .join('');
      const m = NOISE_RE.exec(v);
      res[f] = m && m.index > 0 ? v.slice(0, m.index) : v;
    }
  }
  return res;
}

function emptyPage(boxes: OcrBox[]): TableOutcome {
  return {
    ok: true,
    page: {
      txs: [],
      meta: extractMeta(boxes, Infinity),
      columns: [],
      rowCount: 0,
      continuityBreaks: 0,
      usedMoneySolver: false,
    },
  };
}

/** 这一页看起来是不是一张有金额的流水表（而不是空白页/封面/印章页）。 */
function looksLikeStatement(boxes: OcrBox[]): boolean {
  // 整页明确写着「无对账数据」时，哪怕还有账号/余额抬头，也按 0 笔处理。
  // （只有几何重建失败时才走到这里，不会影响真有交易的页。）
  if (
    boxes.some((b) =>
      /无对账数据|无交易(?:记录|明细|信息|数据)?|没有(?:任何)?交易|以下此页无其他交易|未发生业务/.test(b.text),
    )
  ) {
    return false;
  }
  let money = 0;
  let dates = 0;
  for (const b of boxes) {
    if (/[+-]?\d[\d,]*(?:\.\d{2})(?!\d)/.test(b.text)) money++;
    for (const m of b.text.matchAll(DATE_TOKEN_RE)) if (isFullDate(m[1])) dates++;
  }
  return money >= 3 || (money >= 1 && dates >= 2) || boxes.length >= 60;
}

/** 一把文字框重建一页交易。ok:false 表示几何上不成立，调用方应退回视觉模型。 */
export function parseTablePage(rawBoxes: OcrBox[], prevBalance?: number): TableOutcome {
  if (rawBoxes.length === 0) return emptyPage(rawBoxes);
  // 整页明确写着本月无业务/无对账数据：直接 0 笔，别让页脚余额被当成交易。
  if (rawBoxes.some((b) => /无对账数据|未发生业务/.test(b.text))) return emptyPage(rawBoxes);
  const core = buildCore(rawBoxes);
  if ('reason' in core) {
    // 没表头、也没有金额/日期：空白页、封面、仅印章页 —— 按 0 笔处理，不用再问视觉模型
    if (!looksLikeStatement(rawBoxes)) return emptyPage(rawBoxes);
    return { ok: false, reason: core.reason };
  }
  const { boxes, data, columns, anchors, cells, firstDataY, footY, headerless } = core;

  const recs: Array<Record<string, string>> = [];
  const usedByRow: Array<CellBox[]> = [];
  for (let ai = 0; ai < anchors.length; ai++) {
    const rec: Record<string, string> = {};
    const used: CellBox[] = [];
    for (const c of columns) {
      const lines = cells.get(c.center)?.[ai] ?? [];
      if (lines.length === 0) continue;
      used.push(...lines);
      // 后面的列不要用空值覆盖前面已经取到的同名字段（多行表头常出现重复字段）
      for (const [k, v] of Object.entries(assemble(lines, c.fields))) if (v) rec[k] = v;
    }
    // 日期列缺值时，从本行任意格的文字里补：OCR 常把「20260104 转取」并成一个框，
    // 整框落进摘要列，日期列就空了。
    if (!rec.date) {
      outer: for (const b of used) {
        for (const m of b.text.matchAll(DATE_TOKEN_RE)) {
          if (isFullDate(m[1])) {
            rec.date = m[1];
            break outer;
          }
        }
      }
    }
    recs.push(rec);
    usedByRow.push(used);
  }

  const money = solveMoney(data, columns, anchors, footY, prevBalance);
  const usedMoneySolver = !!money && (money.merged || money.rows.some((r) => r && !r.continuity));

  const txs: TableTx[] = [];
  let dropped = 0;
  let headerlessNoted = false;
  for (let ai = 0; ai < anchors.length; ai++) {
    const rec = recs[ai];
    const solved = money?.rows[ai] ?? null;

    let amount = rec.amount ? parseNum(rec.amount) : undefined;
    let direction: 'in' | 'out' | undefined;
    if (amount != null) direction = amount < 0 ? 'out' : 'in';
    let debit = rec.debit ? parseNum(rec.debit) : undefined;
    let credit = rec.credit ? parseNum(rec.credit) : undefined;
    let balance = rec.balance ? parseNum(rec.balance) : undefined;

    // 几何还原不可靠（金额列粘连或余额断裂）时，用枚举拆解的结果覆盖金额列。
    if (solved && solved.values.balance != null) {
      const better =
        solved.continuity ||
        money!.merged ||
        amount == null ||
        balance == null ||
        (debit == null && credit == null && rec.amount == null);
      if (better) {
        if (solved.values.amount != null) amount = solved.values.amount;
        if (solved.values.debit != null) debit = solved.values.debit;
        if (solved.values.credit != null) credit = solved.values.credit;
        balance = solved.values.balance;
      }
    }

    let finalAmount: number | undefined;
    if (amount != null && amount !== 0) {
      finalAmount = Math.abs(amount);
      direction = amount < 0 ? 'out' : 'in';
    } else if (debit != null && debit !== 0) {
      finalAmount = Math.abs(debit);
      direction = 'out';
    } else if (credit != null && credit !== 0) {
      finalAmount = Math.abs(credit);
      direction = 'in';
    }
    if (finalAmount == null || !direction) {
      dropped++;
      continue;
    }

    const used = usedByRow[ai];
    const conf = used.length ? mean(used.map((b) => b.confidence)) : 0.5;
    const review: string[] = [];
    // 整页共用一个推断提示，别把每一笔都标成待复核。
    if (headerless && !headerlessNoted) {
      review.push('表头未识别，列按余额连续性推断');
      headerlessNoted = true;
    }
    if (money?.merged && solved && !solved.continuity && balance != null) review.push('金额列粘连，余额未对上');
    if (
      used.some(
        (b) => (b.spanCols ?? 0) >= 3 && b.col && !b.col.fields.some((f) => MONEY_FIELDS.has(f)),
      )
    ) {
      review.push('文字跨列粘连');
    }
    if (conf < 0.75) review.push(`低置信(${conf.toFixed(2)})`);

    // 对方账号 + 对方户名常在同一格。账号不一定在最前面：户名折行时可能
    // 「户名上半行 / 账号 / 户名下半行」上下居中，所以要在整段里找长数字。
    const cpRaw = rec.counterparty_name ?? '';
    let cpAcct = (rec.counterparty_account ?? '').replace(/\s/g, '');
    // OCR 有时把开户行、户名和账号并进同一个格；账号列里只剩数字才是账号。
    if (/[一-鿿]/.test(cpAcct)) {
      cpAcct = cpAcct.replace(/[^\d-]/g, '');
      if (cpAcct.replace(/\D/g, '').length < 8) cpAcct = '';
    }
    let cpName = cpRaw.trim();
    const accM = /\d[\d-]{7,}/.exec(cpRaw);
    if (!cpAcct && accM && accM[0].replace(/\D/g, '').length >= 8) {
      cpAcct = accM[0];
      cpName = (cpRaw.slice(0, accM.index) + cpRaw.slice(accM.index + accM[0].length)).trim();
    } else {
      const lead = splitAccountLead(cpRaw);
      if (lead) cpName = lead.rest;
    }

    const rawParts: string[] = [];
    for (const c of columns) {
      for (const f of c.fields) {
        const v = rec[f]?.trim();
        if (v && !rawParts.includes(v)) rawParts.push(v);
      }
    }

    txs.push({
      date: rec.date || undefined,
      time: rec.time || undefined,
      summary: rec.summary?.trim() || undefined,
      serial: rec.serial?.trim() || undefined,
      amount: Math.round(finalAmount * 100) / 100,
      direction,
      balance,
      counterparty: cpName || undefined,
      counterpartyAccount: cpAcct || undefined,
      channel: rec.channel?.trim() || rec.note?.trim() || undefined,
      currency: rec.currency?.trim() || undefined,
      note: rec.note?.trim() || undefined,
      confidence: Math.max(0, Math.min(1, conf)),
      review: review.join('；'),
      raw: rawParts.join(' | '),
    });
  }

  if (txs.length === 0) {
    // 空账户明细：表头和行都在，但整页借贷发生额都是 0.00。
    // 这不是识别失败，按 0 笔处理，别退给视觉模型。
    // 只看发生额，不看余额：空账户明细的期初/期末余额可以很大，但借贷发生额是 0。
    const allZero =
      recs.length > 0 &&
      recs.every((rec) => {
        const vs = ['amount', 'debit', 'credit']
          .map((f) => parseNum(rec[f] ?? ''))
          .filter((v): v is number => v != null);
        return vs.length > 0 && vs.every((v) => v === 0);
      });
    if (allZero) return emptyPage(boxes);
    return { ok: false, reason: `锚点 ${anchors.length} 行但都没有金额` };
  }

  // OCR 偶尔把日期末位截掉（2026/07/31 → 2026/07/3）。流水按时间升序，
  // 后一笔反而更早、且数字是前一笔的前缀时，按前一笔补全并留痕。
  for (let i = 1; i < txs.length; i++) {
    const prev = txs[i - 1].date;
    const cur = txs[i].date;
    if (!prev || !cur || cur === prev || !isFullDate(prev) || !isFullDate(cur)) continue;
    const pv = dateValue(prev);
    const cv = dateValue(cur);
    const pd = prev.replace(/\D/g, '');
    const cd = cur.replace(/\D/g, '');
    if (pv != null && cv != null && cv < pv && pd.startsWith(cd) && pd.length - cd.length <= 2) {
      txs[i].date = prev;
      txs[i].review = [txs[i].review, '日期疑似截断，已按上一笔补全'].filter(Boolean).join('；');
    }
  }
  if (dropped > anchors.length / 2) {
    return { ok: false, reason: `${dropped}/${anchors.length} 行没还原出金额` };
  }

  // 页内余额连续性（跨页由调用方把上一页末笔余额传进来）
  let breaks = 0;
  let prev = prevBalance ?? money?.opening;
  const lastTx = [...txs].reverse().find((t) => t.balance != null);
  for (const t of txs) {
    if (t.balance == null) continue;
    if (prev != null) {
      const expected = Math.round((prev + (t.direction === 'in' ? t.amount : -t.amount)) * 100) / 100;
      if (Math.abs(expected - t.balance) > 0.011) {
        breaks++;
        t.review = t.review ? `${t.review}；余额断裂` : '余额断裂';
      }
    }
    prev = t.balance;
  }
  if (money?.closing != null && lastTx && Math.abs(money.closing - lastTx.balance!) > 0.011) {
    breaks++;
  }

  return {
    ok: true,
    page: {
      txs,
      meta: extractMeta(boxes, firstDataY),
      columns: columns.map((c) => c.fields),
      rowCount: anchors.length,
      openingBalance: money?.opening,
      closingBalance: money?.closing,
      continuityBreaks: breaks,
      usedMoneySolver,
      headerless,
    },
  };
}

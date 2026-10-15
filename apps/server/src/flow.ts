/**
 * 任务资金流向。
 * 账号能对上募资专户的，直接当作专户间划转；
 * 对不上的组交给大模型，结合日期和对手方判断，再由镜像规则核对，避免一笔钱记两次。
 */
import { createHash } from 'node:crypto';
import {
  FlowKind,
  FlowLink,
  FlowNode,
  FlowPartyLine,
  FlowResponse,
  FlowResult,
  normAccountNo,
} from '@flow/shared';
import { db } from './db.js';
import { extractJson, llmChat } from './ai.js';
import { getSettings } from './settings.js';

const TREASURY_RE = /大额存单|结构性存款|定期转存|应付利息|存款利息|手续费|汇划|电子汇划|理财|产品代码/;
const LOW_COUNT = 3;
const LOW_AMOUNT = 50_000;

type Dir = 'in' | 'out';

interface Group {
  gid: string;
  ids: number[];
  date: string;
  direction: Dir;
  amount: number;
  count: number;
  liveCount: number;
  confirmed: number;
  stmtKey: string;
  cpName: string;
  cpAccount: string;
  cpKey: string;
  summary: string;
  kind: FlowKind | '?';
  locked: boolean;
  peerKey: string;
  peerName: string;
  peerAccount: string;
}

interface Acct {
  key: string;
  holder: string;
  bank: string;
  accountNo: string;
}

const running = new Map<number, Promise<FlowResponse>>();

function compactName(s: string): string {
  return s
    .toUpperCase()
    .replace(/[\s\u3000]/g, '')
    .replace(/[.,，。'"“”()（）\-_/·]/g, '')
    .replace(/股份有限公司|有限责任公司|有限公司|LTD|LIMITED|PTE|INC|CO|Ş|Ş/g, '');
}

function sameEntity(a: string, b: string): boolean {
  const x = compactName(a);
  const y = compactName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [s, l] = x.length < y.length ? [x, y] : [y, x];
  if (s.length < 4) return false;
  if (l.includes(s)) return true;
  let i = 0;
  while (i < s.length && i < l.length && s[i] === l[i]) i++;
  return i >= 6;
}

function dayDiff(a: string, b: string): number {
  const da = Date.parse(a.slice(0, 10));
  const db = Date.parse(b.slice(0, 10));
  if (Number.isNaN(da) || Number.isNaN(db)) return 99;
  return Math.abs(da - db) / 86_400_000;
}

export function bankShort(bank: string): string {
  const pairs: [RegExp, string][] = [
    [/农商/, '农商'],
    [/交通|交行/, '交行'],
    [/招商/, '招行'],
    [/兴业/, '兴业'],
    [/浙商/, '浙商'],
    [/工商|工行/, '工行'],
    [/建设|建行/, '建行'],
    [/农业银行|农行/, '农行'],
    [/中国银行/, '中行'],
    [/浦发|浦东发展/, '浦发'],
    [/民生/, '民生'],
    [/光大/, '光大'],
    [/中信/, '中信'],
    [/平安/, '平安'],
    [/华夏/, '华夏'],
    [/广发|广东发展/, '广发'],
    [/邮储|邮政/, '邮储'],
    [/宁波/, '宁波'],
    [/南京/, '南京'],
    [/江苏银行/, '江苏'],
    [/北京银行/, '北京'],
    [/上海银行/, '上海'],
  ];
  for (const [re, name] of pairs) if (re.test(bank)) return name;
  const t = bank.replace(/中国|银行|股份|有限|公司/g, '').trim();
  return (t || bank).slice(0, 2);
}

function tail(no: string): string {
  const s = no.replace(/[\s\u3000\-]/g, '');
  return s.slice(-4);
}

function shortHolder(name: string): string {
  const t = name.replace(/股份有限公司|有限责任公司|有限公司/g, '').trim();
  return t || name;
}

function treasuryLabel(summary: string): string {
  if (/存单|结构性|定期|理财|产品代码/.test(summary)) return '存单/理财';
  if (/利息/.test(summary)) return '利息';
  if (/手续费|汇划/.test(summary)) return '手续费';
  return summary.trim().slice(0, 12) || '其他';
}

function loadContext(taskId: number): {
  taskName: string;
  clientName: string;
  accounts: Acct[];
  rows: Record<string, unknown>[];
} | null {
  const head = db
    .prepare(
      `SELECT tk.name AS task_name, c.name AS client_name, tk.project_id
       FROM tasks tk
       JOIN projects p ON p.id = tk.project_id
       JOIN clients c ON c.id = p.client_id
       WHERE tk.id = ?`,
    )
    .get(taskId) as { task_name: string; client_name: string; project_id: number } | undefined;
  if (!head) return null;
  const accounts = (
    db
      .prepare(
        `SELECT account_key, holder, bank, account_no FROM fund_use_accounts
         WHERE project_id = ? AND account_key != ''`,
      )
      .all(head.project_id) as { account_key: string; holder: string; bank: string; account_no: string }[]
  ).map((a) => ({ key: a.account_key, holder: a.holder, bank: a.bank, accountNo: a.account_no }));
  const rows = db
    .prepare(
      `SELECT t.id, t.date, t.amount, t.direction, t.summary, t.counterparty, t.counterparty_account,
              f.bank, f.account_no
       FROM transactions t
       JOIN files f ON f.id = t.file_id
       WHERE f.task_id = ?`,
    )
    .all(taskId) as Record<string, unknown>[];
  return { taskName: head.task_name, clientName: head.client_name, accounts, rows };
}

function signatureOf(accounts: Acct[], rows: Record<string, unknown>[]): string {
  const body = [
    'flow-v2',
    accounts
      .map((a) => a.key)
      .sort()
      .join(','),
    ...rows.map((r) =>
      [r.id, r.date, r.amount, r.direction, r.counterparty, r.counterparty_account, r.account_no, r.summary].join('|'),
    ),
  ].join('\n');
  return createHash('sha1').update(body).digest('hex');
}

function buildGroups(rows: Record<string, unknown>[], accounts: Acct[], clientName: string): { groups: Group[]; skipped: number } {
  const byKey = new Map(accounts.map((a) => [a.key, a]));
  const holders = accounts.map((a) => a.holder);
  const names = [clientName, ...holders];
  const buckets = new Map<string, Group>();
  let skipped = 0;
  let n = 0;
  for (const r of rows) {
    const stmtKey = normAccountNo(String(r.account_no ?? ''));
    if (!byKey.has(stmtKey)) {
      skipped++;
      continue;
    }
    const direction = (r.direction === 'in' ? 'in' : 'out') as Dir;
    const amount = Number(r.amount) || 0;
    const cpName = String(r.counterparty ?? '').trim();
    const cpAccount = String(r.counterparty_account ?? '').trim();
    const cpKey = normAccountNo(cpAccount);
    const summary = String(r.summary ?? '').trim();
    const date = String(r.date ?? '').slice(0, 10);
    const gk = [stmtKey, direction, amount.toFixed(2), cpKey, compactName(cpName), compactName(summary), date].join('|');
    let g = buckets.get(gk);
    if (!g) {
      n += 1;
      const kind = classify(stmtKey, cpKey, cpName, summary, names, byKey);
      g = {
        gid: `g${n}`,
        ids: [],
        date,
        direction,
        amount,
        count: 0,
        liveCount: 0,
        confirmed: 0,
        stmtKey,
        cpName,
        cpAccount,
        cpKey,
        summary,
        kind: kind.kind,
        locked: kind.locked,
        peerKey: kind.peerKey,
        peerName: kind.peerName || cpName,
        peerAccount: kind.peerAccount || cpAccount,
      };
      buckets.set(gk, g);
    }
    g.ids.push(Number(r.id));
    g.count += 1;
    g.liveCount += 1;
  }
  return { groups: [...buckets.values()], skipped };
}

function classify(
  stmtKey: string,
  cpKey: string,
  cpName: string,
  summary: string,
  names: string[],
  byKey: Map<string, Acct>,
): { kind: FlowKind | '?'; locked: boolean; peerKey: string; peerName: string; peerAccount: string } {
  if (cpKey && cpKey !== stmtKey && byKey.has(cpKey)) {
    return { kind: 'dedicated', locked: true, peerKey: cpKey, peerName: byKey.get(cpKey)!.holder, peerAccount: byKey.get(cpKey)!.accountNo };
  }
  const own = cpName && names.some((n) => sameEntity(cpName, n));
  if (cpKey && cpKey !== stmtKey && own) {
    return { kind: 'own', locked: true, peerKey: '', peerName: cpName, peerAccount: '' };
  }
  if (TREASURY_RE.test(summary)) {
    return { kind: 'treasury', locked: true, peerKey: '', peerName: '', peerAccount: '' };
  }
  if (cpKey && cpKey !== stmtKey && cpName && !own) {
    return { kind: 'external', locked: true, peerKey: '', peerName: cpName, peerAccount: '' };
  }
  return { kind: '?', locked: false, peerKey: '', peerName: cpName, peerAccount: '' };
}

function mirrors(g: Group, h: Group, holderOf: Map<string, string>): boolean {
  if (g.stmtKey === h.stmtKey || g.direction === h.direction) return false;
  if (Math.abs(g.amount - h.amount) > 0.009) return false;
  if (dayDiff(g.date, h.date) > 1) return false;
  const gNamesH = !!g.cpKey && g.cpKey === h.stmtKey;
  const hNamesG = !!h.cpKey && h.cpKey === g.stmtKey;
  if (gNamesH && hNamesG) return true;
  if (gNamesH && !h.cpKey) return !h.cpName || sameEntity(h.cpName, holderOf.get(g.stmtKey) ?? '');
  if (hNamesG && !g.cpKey) return !g.cpName || sameEntity(g.cpName, holderOf.get(h.stmtKey) ?? '');
  return false;
}

/** 两侧专户流水对得上的，只保留转出方，并记成专户间。 */
function pairDedicated(groups: Group[], accounts: Acct[]): void {
  const holderOf = new Map(accounts.map((a) => [a.key, a.holder]));
  const keys = new Set(accounts.map((a) => a.key));
  for (const g of groups) {
    if (g.direction !== 'out' || g.liveCount <= 0 || g.kind === 'treasury') continue;
    const candidates = groups
      .filter((h) => h.direction === 'in' && h.liveCount > 0 && h.kind !== 'treasury' && mirrors(g, h, holderOf))
      .sort((a, b) => dayDiff(g.date, a.date) - dayDiff(g.date, b.date));
    const h = candidates.find((c) => c.liveCount > 0 && keys.has(g.stmtKey) && keys.has(c.stmtKey));
    if (h) {
      g.kind = 'dedicated';
      g.peerKey = h.stmtKey;
      g.locked = true;
      h.kind = 'dedicated';
      h.peerKey = g.stmtKey;
      h.locked = true;
      const n = Math.min(g.liveCount, h.liveCount);
      h.liveCount -= n;
      g.confirmed += n;
    }
  }
}

function asKind(raw: unknown): FlowKind | null {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'dedicated' || s === '专户' || s === '专户间') return 'dedicated';
  if (s === 'own' || s === '自身' || s === '其他账户') return 'own';
  if (s === 'external' || s === '对外') return 'external';
  if (s === 'treasury' || s === '理财' || s === '现金管理') return 'treasury';
  return null;
}

async function askModel(clientName: string, accounts: Acct[], groups: Group[]): Promise<void> {
  const open = groups.filter((g) => !g.locked);
  if (open.length === 0) return;
  const settings = getSettings();
  const acctLines = accounts.map((a) => `- ${a.key} ${bankShort(a.bank)} ${a.holder} 尾号${tail(a.accountNo)}`).join('\n');
  const lines = groups
    .map((g) => {
      const mark = g.locked ? g.kind : '?';
      return `${g.gid}\t${g.date}\t${g.direction}\t${g.amount}\tx${g.count}\t本方${g.stmtKey}\t对手${g.cpName || '（空）'}\t账号${g.cpAccount || '（空）'}\t摘要${g.summary || '（空）'}\t已知${mark}`;
    })
    .join('\n');
  const system = '你是募集资金流水核查助手。只根据给定流水判断资金关系，只输出 JSON，不要解释。';
  const user = `客户：${clientName}
募资专户（key 是账号比对键）：
${acctLines}

交易组（组号 日期 方向 单笔金额 笔数 本方key 对手方 对手账号 摘要 已知分类）：
${lines}

已知不是「?」的组已经按账号或摘要定了，不要改它们的 kind。
只判断「已知?」的组，kind 取：
- dedicated：募资专户之间的划转。peerKey 填对方专户 key。日期相同或差一天、金额相同、方向相反，且一侧账号指向另一侧账户的，是同一笔，pairGid 填对方组号。
- own：转到客户或某个开户主体的其他银行账户（账号不在募资专户清单）。peerName 用主体名称，peerAccount 用账号。不同账号不要合并。
- external：付给外部单位。peerName 用对手方名称。
- treasury：本户存单、理财、利息、手续费，钱没有付给另一个账户。摘要写存单、理财、利息、手续费，且没有对方账号时，用这个。

没有对方账号、但日期和金额能对上另一本专户流水的，优先 dedicated，不要标成 own。
{"items":[{"gid":"g1","kind":"dedicated","peerKey":"","peerName":"","peerAccount":"","pairGid":""}]}`;
  const content = await llmChat(settings.llmBase, settings.llmModel, settings.llmExtraHeader || undefined, system, user, {
    jsonMode: true,
    maxTokens: 8000,
    timeoutMs: 180_000,
  });
  const parsed = extractJson<{ items?: { gid?: string; kind?: string; peerKey?: string; peerName?: string; peerAccount?: string; pairGid?: string }[] }>(content);
  const byGid = new Map(groups.map((g) => [g.gid, g]));
  const keySet = new Set(accounts.map((a) => a.key));
  for (const item of parsed.items ?? []) {
    const g = item.gid ? byGid.get(item.gid) : undefined;
    if (!g || g.locked) continue;
    const kind = asKind(item.kind);
    if (!kind) continue;
    if (kind === 'dedicated') {
      const peer = normAccountNo(item.peerKey || '');
      if (!keySet.has(peer) || peer === g.stmtKey) continue;
      g.kind = 'dedicated';
      g.peerKey = peer;
      g.peerName = item.peerName?.trim() || g.peerName;
    } else if (kind === 'own') {
      g.kind = 'own';
      g.peerName = (item.peerName || g.cpName || '客户其他账户').trim();
      g.peerAccount = (item.peerAccount || g.cpAccount).trim();
    } else if (kind === 'external') {
      g.kind = 'external';
      g.peerName = (item.peerName || g.cpName || '对方未识别').trim();
      g.peerAccount = (item.peerAccount || g.cpAccount).trim();
    } else {
      g.kind = 'treasury';
    }
    const pair = item.pairGid ? byGid.get(item.pairGid) : undefined;
    if (pair && pair.gid !== g.gid && mirrors(g, pair, new Map(accounts.map((a) => [a.key, a.holder])))) {
      g.kind = 'dedicated';
      g.peerKey = pair.stmtKey;
      pair.kind = 'dedicated';
      pair.peerKey = g.stmtKey;
    }
  }
}

function fallbackOpen(groups: Group[], clientName: string, accounts: Acct[]): void {
  const names = [clientName, ...accounts.map((a) => a.holder)];
  for (const g of groups) {
    if (g.kind !== '?') continue;
    if (g.cpName && names.some((n) => sameEntity(g.cpName, n))) {
      g.kind = 'own';
      g.peerName = names.find((n) => sameEntity(g.cpName, n)) ?? g.cpName;
      g.peerAccount = g.cpAccount;
    } else if (!g.cpKey && TREASURY_RE.test(g.summary)) g.kind = 'treasury';
    else {
      g.kind = 'external';
      g.peerName = g.cpName || '对方未识别';
      g.peerAccount = g.cpAccount;
    }
  }
}

function acctNodeId(key: string): string {
  return `acct:${key}`;
}

function assemble(taskId: number, taskName: string, clientName: string, accounts: Acct[], groups: Group[], skipped: number, source: FlowResult['source']): FlowResult {
  const byKey = new Map(accounts.map((a) => [a.key, a]));
  const nodes = new Map<string, FlowNode>();
  const links: FlowLink[] = [];

  const ensureAcct = (key: string) => {
    const id = acctNodeId(key);
    if (nodes.has(id)) return id;
    const a = byKey.get(key);
    nodes.set(id, {
      id,
      role: 'dedicated',
      title: bankShort(a?.bank ?? ''),
      tail: tail(a?.accountNo ?? key),
      sub: a?.holder,
    });
    return id;
  };

  const addFlow = (payer: string, payee: string, kind: FlowKind, amount: number, count: number, both: number) => {
    if (count <= 0 || amount <= 0) return;
    let link = links.find((l) => (l.from === payer && l.to === payee) || (l.from === payee && l.to === payer));
    if (!link) {
      link = {
        id: `l${links.length + 1}`,
        from: payer,
        to: payee,
        kind,
        outAmount: 0,
        outCount: 0,
        outBoth: 0,
        inAmount: 0,
        inCount: 0,
        inBoth: 0,
      };
      links.push(link);
    }
    if (link.from === payer && link.to === payee) {
      link.outAmount += amount;
      link.outCount += count;
      link.outBoth += both;
    } else {
      link.inAmount += amount;
      link.inCount += count;
      link.inBoth += both;
    }
  };

  const externalAgg = new Map<string, FlowPartyLine>();
  const treasury: FlowPartyLine[] = [];

  for (const g of groups) {
    if (g.liveCount <= 0 || g.kind === '?') continue;
    const amt = g.liveCount * g.amount;
    const bothAmt = Math.min(g.confirmed, g.liveCount) * g.amount;
    const stmtId = ensureAcct(g.stmtKey);
    const acct = byKey.get(g.stmtKey);
    const acctTitle = `${bankShort(acct?.bank ?? '')} ${tail(acct?.accountNo ?? g.stmtKey)}`;
    if (g.kind === 'dedicated' && g.peerKey) {
      const peerId = ensureAcct(g.peerKey);
      const payer = g.direction === 'out' ? stmtId : peerId;
      const payee = g.direction === 'out' ? peerId : stmtId;
      addFlow(payer, payee, 'dedicated', amt, g.liveCount, bothAmt);
      continue;
    }
    if (g.kind === 'own') {
      const no = g.peerAccount || g.cpAccount;
      const name = g.peerName || g.cpName || '客户其他账户';
      const id = `own:${normAccountNo(no) || compactName(name)}`;
      if (!nodes.has(id)) {
        nodes.set(id, { id, role: 'own', title: shortHolder(name), tail: no ? tail(no) : undefined, sub: no || '其他账户' });
      }
      const payer = g.direction === 'out' ? stmtId : id;
      const payee = g.direction === 'out' ? id : stmtId;
      addFlow(payer, payee, 'own', amt, g.liveCount, 0);
      continue;
    }
    if (g.kind === 'treasury') {
      const label = treasuryLabel(g.summary);
      const hit = treasury.find((t) => t.accountTitle === acctTitle && t.name === label);
      if (hit) {
        hit.count += g.liveCount;
        if (g.direction === 'out') hit.outAmount += amt;
        else hit.inAmount += amt;
      } else {
        treasury.push({
          name: label,
          accountTitle: acctTitle,
          count: g.liveCount,
          outAmount: g.direction === 'out' ? amt : 0,
          inAmount: g.direction === 'in' ? amt : 0,
        });
      }
      continue;
    }
    const name = g.peerName || g.cpName || '对方未识别';
    const key = compactName(name) || 'unknown';
    const hit = externalAgg.get(key);
    if (hit) {
      hit.count += g.liveCount;
      if (g.direction === 'out') hit.outAmount += amt;
      else hit.inAmount += amt;
    } else {
      externalAgg.set(key, {
        name,
        accountNo: g.peerAccount || g.cpAccount || undefined,
        count: g.liveCount,
        outAmount: g.direction === 'out' ? amt : 0,
        inAmount: g.direction === 'in' ? amt : 0,
      });
    }
  }

  const externalLines = [...externalAgg.values()].sort((a, b) => b.outAmount + b.inAmount - (a.outAmount + a.inAmount));
  for (const line of externalLines) {
    line.grouped = line.count < LOW_COUNT || line.outAmount + line.inAmount < LOW_AMOUNT;
  }

  const bucketId = 'bucket:out';
  const namedExt = externalLines.filter((l) => !l.grouped);
  const groupedExt = externalLines.filter((l) => l.grouped);
  for (const line of namedExt) {
    const id = `ext:${compactName(line.name)}`;
    if (!nodes.has(id)) nodes.set(id, { id, role: 'external', title: line.name, sub: line.accountNo });
  }

  // 对外链接按专户拆开，所以再扫一遍组
  for (const g of groups) {
    if (g.liveCount <= 0 || g.kind !== 'external') continue;
    const name = g.peerName || g.cpName || '对方未识别';
    const line = externalLines.find((l) => compactName(l.name) === (compactName(name) || 'unknown'));
    const stmtId = ensureAcct(g.stmtKey);
    const target = line?.grouped ? bucketId : `ext:${compactName(name)}`;
    if (line?.grouped && !nodes.has(bucketId)) {
      nodes.set(bucketId, { id: bucketId, role: 'bucket', title: '对外转出', sub: `${groupedExt.length} 个对手方` });
    }
    const amt = g.liveCount * g.amount;
    const payer = g.direction === 'out' ? stmtId : target;
    const payee = g.direction === 'out' ? target : stmtId;
    addFlow(payer, payee, 'external', amt, g.liveCount, 0);
  }

  if (treasury.length > 0) {
    const id = 'bucket:treasury';
    nodes.set(id, { id, role: 'treasury', title: '现金管理', sub: '存单 / 利息 / 手续费' });
    for (const g of groups) {
      if (g.liveCount <= 0 || g.kind !== 'treasury') continue;
      const stmtId = ensureAcct(g.stmtKey);
      const amt = g.liveCount * g.amount;
      const payer = g.direction === 'out' ? stmtId : id;
      const payee = g.direction === 'out' ? id : stmtId;
      addFlow(payer, payee, 'treasury', amt, g.liveCount, 0);
    }
  }

  // 没有任何流动的专户不占位
  const used = new Set<string>();
  for (const l of links) {
    used.add(l.from);
    used.add(l.to);
  }
  const nodeList = [...nodes.values()].filter((n) => used.has(n.id));
  const order = (n: FlowNode) => (n.role === 'own' ? 0 : n.role === 'external' ? 1 : n.role === 'bucket' ? 2 : n.role === 'treasury' ? 3 : 4);
  nodeList.sort((a, b) => order(a) - order(b) || a.title.localeCompare(b.title, 'zh'));

  return {
    taskId,
    taskName,
    clientName,
    generatedAt: new Date().toISOString(),
    source,
    txCount: groups.reduce((s, g) => s + g.count, 0),
    skipped,
    nodes: nodeList,
    links,
    externalLines,
    treasuryLines: treasury.sort((a, b) => b.outAmount + b.inAmount - (a.outAmount + a.inAmount)),
  };
}

async function compute(taskId: number): Promise<FlowResponse> {
  const ctx = loadContext(taskId);
  if (!ctx) return { status: 'empty', message: '任务不存在' };
  if (ctx.accounts.length === 0) return { status: 'empty', message: '先登记募资专户，才能区分专户之间的划转' };
  if (ctx.rows.length === 0) return { status: 'empty', message: '这个任务还没有解析出交易' };
  const { groups, skipped } = buildGroups(ctx.rows, ctx.accounts, ctx.clientName);
  if (groups.length === 0) return { status: 'empty', message: '解析出的流水都对不上已登记的募资专户' };
  let source: FlowResult['source'] = 'rules';
  let fallback = false;
  const openBefore = groups.some((g) => !g.locked);
  if (openBefore) {
    try {
      await askModel(ctx.clientName, ctx.accounts, groups);
      source = 'llm';
    } catch (e) {
      console.error('[flow] llm failed', (e as Error).message);
      fallback = true;
    }
  }
  const holderOf = new Map(ctx.accounts.map((a) => [a.key, a.holder]));
  for (const g of groups) {
    if (g.locked || g.kind !== 'dedicated') continue;
    const mirrored = groups.some((h) => h.gid !== g.gid && mirrors(g, h, holderOf));
    if (!mirrored) g.kind = '?';
  }
  fallbackOpen(groups, ctx.clientName, ctx.accounts);
  pairDedicated(groups, ctx.accounts);
  const result = assemble(taskId, ctx.taskName, ctx.clientName, ctx.accounts, groups, skipped, source);
  if (fallback) result.fallback = true;
  return { status: 'ready', result };
}

function readCache(taskId: number, sig: string): FlowResponse | null {
  const row = db.prepare('SELECT signature, payload FROM flow_analyses WHERE task_id = ?').get(taskId) as
    | { signature: string; payload: string }
    | undefined;
  if (!row) return null;
  try {
    const result = JSON.parse(row.payload) as FlowResult;
    return { status: row.signature === sig ? 'ready' : 'stale', result };
  } catch {
    return null;
  }
}

export function getFlow(taskId: number): FlowResponse {
  const ctx = loadContext(taskId);
  if (!ctx) return { status: 'empty', message: '任务不存在' };
  const sig = signatureOf(ctx.accounts, ctx.rows);
  return readCache(taskId, sig) ?? { status: 'missing' };
}

export function runFlow(taskId: number, force: boolean): Promise<FlowResponse> {
  const existing = running.get(taskId);
  if (existing) return existing;
  const job = (async () => {
    const ctx = loadContext(taskId);
    if (!ctx) return { status: 'empty' as const, message: '任务不存在' };
    const sig = signatureOf(ctx.accounts, ctx.rows);
    if (!force) {
      const cached = readCache(taskId, sig);
      if (cached?.status === 'ready') return cached;
    }
    const out = await compute(taskId);
    if (out.result) {
      db.prepare(
        `INSERT INTO flow_analyses(task_id, signature, payload, created_at) VALUES(?,?,?,?)
         ON CONFLICT(task_id) DO UPDATE SET signature = excluded.signature, payload = excluded.payload, created_at = excluded.created_at`,
      ).run(taskId, sig, JSON.stringify(out.result), out.result.generatedAt);
    }
    return out;
  })().finally(() => running.delete(taskId));
  running.set(taskId, job);
  return job;
}

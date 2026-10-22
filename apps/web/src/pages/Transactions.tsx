import { Bookmark, Columns2, FilterX, Inbox, Plus, SlidersHorizontal } from 'lucide-react';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Table } from 'antd';
import { BankFile, specialFundUseByQuery, TxOptions, TxPageResult, TxQuery, TxRow } from '@flow/shared';
import { api } from '../api';
import { Modal } from '../components/Modal';
import { formatByUnit, MoneyUnit, MoneyUnitSelect } from '../lib/moneyUnit';
type TxPageProps = {
  /** 右上角当前任务。交易页只看这一份资料 */
  taskId?: number;
  /** 从某个流水文件进来时带上它的银行和账户 */
  initialBank?: string;
  initialAccountNo?: string;
};

const STATUS_CHIP: Record<string, { cls: string; label: string }> = {
  ok: { cls: 'chip-muted', label: '正常' },
  needs_review: { cls: 'chip-warning', label: '待复核' },
  fixed: { cls: 'chip-success', label: '已修正' },
};

/** 对照模式可选的表头字段。默认只显示复核时最常用的四列。 */
const COMPARE_COLUMNS = [
  { key: 'watch', label: '关注' },
  { key: 'date', label: '日期' },
  { key: 'amount', label: '金额' },
  { key: 'balance', label: '余额' },
  { key: 'summary', label: '摘要' },
  { key: 'counterparty', label: '对手方' },
  { key: 'category', label: '分类' },
  { key: 'holder', label: '开户主体' },
  { key: 'bank', label: '银行 / 账户' },
  { key: 'fundUse', label: '募投项目' },
  { key: 'status', label: '状态' },
] as const;
const DEFAULT_COMPARE_COLUMNS = ['date', 'amount', 'balance', 'status'];
const COMPARE_COLUMNS_KEY = 'flow.tx-compare-columns';

function readCompareColumns(): string[] {
  try {
    const raw = localStorage.getItem(COMPARE_COLUMNS_KEY);
    if (!raw) return [...DEFAULT_COMPARE_COLUMNS];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_COMPARE_COLUMNS];
    const valid = COMPARE_COLUMNS.map((c) => c.key).filter((key) => parsed.includes(key));
    return valid.length > 0 ? valid : [...DEFAULT_COMPARE_COLUMNS];
  } catch {
    return [...DEFAULT_COMPARE_COLUMNS];
  }
}

type TxDraft = {
  date: string;
  direction: 'in' | 'out';
  amount: string;
  balance: string;
  summary: string;
  counterparty: string;
  counterpartyAccount: string;
  channel: string;
  category: string;
};

/** 流水印刷顺序。用来比较哪一条待复核离当前更近。 */
function stmtKey(r: { page: number; sortKey: number; id: number }): number {
  return r.page * 1_000_000_000 + r.sortKey * 1_000_000 + r.id;
}

/** 把对照表里这一行滚到左栏可视区域的正中，方便直接读。 */
function centerCompareRow(id: number): boolean {
  const row = document.querySelector(`.tx-compare-left tr[data-row-key="${id}"]`) as HTMLElement | null;
  if (!row) return false;
  const scroller = row.closest('.tx-compare-left-scroll') as HTMLElement | null;
  if (!scroller) {
    row.scrollIntoView({ block: 'center', inline: 'nearest' });
    return true;
  }
  const rowRect = row.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  const head = scroller.querySelector('.ant-table-thead') as HTMLElement | null;
  const headH = head ? head.getBoundingClientRect().height : 0;
  const visibleTop = box.top + headH;
  const visibleMid = visibleTop + (box.height - headH) / 2;
  const delta = rowRect.top + rowRect.height / 2 - visibleMid;
  if (Math.abs(delta) > 1) scroller.scrollTop += delta;
  return true;
}

function balanceRecalcText(b: { selfGap: string | null; nextGap: string | null; hasNext: boolean }): string {
  const self =
    b.selfGap == null ? '本笔缺少余额，未测算' : b.selfGap === '' ? '本笔与上一笔衔接' : `本笔${b.selfGap}`;
  const next = !b.hasNext
    ? '后面没有下一笔'
    : b.nextGap == null
      ? '下一笔缺少余额，未测算'
      : b.nextGap === ''
        ? '下一笔与本笔衔接'
        : `下一笔${b.nextGap}`;
  return `前后余额已复算：${self}；${next}`;
}

function draftOf(r: TxRow): TxDraft {
  return {
    date: r.date ?? '',
    direction: r.direction,
    amount: String(r.amount),
    balance: r.balance == null ? '' : String(r.balance),
    summary: r.summary ?? '',
    counterparty: r.counterparty ?? '',
    counterpartyAccount: r.counterpartyAccount ?? '',
    channel: r.channel ?? '',
    category: r.category ?? '',
  };
}

function fmtAmount(n: number | undefined, unit: MoneyUnit): string {
  return n == null ? '—' : formatByUnit(n, unit);
}

function fileLabel(relPath: string): string {
  const parts = relPath.split(/[/\\]/);
  return parts[parts.length - 1] || relPath;
}

/**
 * 交易浏览器：只看当前任务。
 * 银行和募投列出该任务的全部；账户随银行、募投收窄。
 */
export function TransactionsPage({ taskId, initialBank, initialAccountNo }: TxPageProps) {
  const [options, setOptions] = useState<TxOptions | null>(null);
  const [catSet, setCatSet] = useState<string[]>([]);
  const [query, setQuery] = useState<TxQuery>({
    taskId,
    bank: initialBank,
    accountNo: initialAccountNo,
    sort: 'stmt',
    page: 1,
    pageSize: 50,
  });
  const [data, setData] = useState<TxPageResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [unit, setUnit] = useState<MoneyUnit>('yuan');
  const [reloadKey, setReloadKey] = useState(0);
  const [expandedKeys, setExpandedKeys] = useState<number[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState<TxDraft | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  /** 补一笔时，新行插在这笔之后；表单关闭后清空 */
  const [insertAfter, setInsertAfter] = useState<TxRow | null>(null);
  const [insertDraft, setInsertDraft] = useState<TxDraft | null>(null);
  const [insertBusy, setInsertBusy] = useState(false);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [bulkCat, setBulkCat] = useState('');
  const [bulkDate, setBulkDate] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [compareFile, setCompareFile] = useState<BankFile | null>(null);
  const [comparePick, setComparePick] = useState(false);
  const [compareCols, setCompareCols] = useState<string[]>(readCompareColumns);
  const [colsOpen, setColsOpen] = useState(false);
  const colsMenuRef = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useState(0.52);
  const splitDrag = useRef(false);
  const [taskFiles, setTaskFiles] = useState<BankFile[]>([]);
  const [filesBusy, setFilesBusy] = useState(false);
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [localName, setLocalName] = useState('');
  const [focus, setFocus] = useState<{ id: number; fileId: number; fileName: string; page: number } | null>(null);
  const [jumpBusy, setJumpBusy] = useState(false);
  const [jumpSeq, setJumpSeq] = useState(0);
  /** 大于 0 时，PDF 用 view=Fit 把该页整页放进右栏中间。每次点击加一，同一页也会重新定位。 */
  const [pdfFit, setPdfFit] = useState(0);
  const [reviewLeft, setReviewLeft] = useState<number | null>(null);
  const jumpToId = useRef<number | null>(null);
  const localUrlRef = useRef<string | null>(null);
  const queryBeforeRef = useRef<TxQuery | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const compare = compareFile != null;
  /** 当前聚焦的行必须在本页表格里，补一笔才有明确的插入位置 */
  const focusedRow = focus ? data?.rows.find((r) => r.id === focus.id) : undefined;

  useEffect(() => {
    if (query.taskId == null) {
      setOptions(null);
      return;
    }
    let cancelled = false;
    const facet: TxQuery = {
      taskId: query.taskId,
      fileId: query.fileId,
      bank: query.bank,
      holder: query.holder,
      accountNo: query.accountNo,
      from: query.from,
      to: query.to,
      counterparty: query.counterparty,
      q: query.q,
      status: query.status,
      category: query.category,
      fundUse: query.fundUse,
    };
    void api
      .txOptions(facet)
      .then((opts) => {
        if (cancelled) return;
        setOptions(opts);
        setQuery((q) => {
          const next = { ...q };
          let changed = false;
          if (q.bank && !opts.banks.includes(q.bank)) {
            next.bank = undefined;
            changed = true;
          }
          if (q.holder && !opts.holders.includes(q.holder)) {
            next.holder = undefined;
            changed = true;
          }
          if (q.accountNo && !opts.accounts.includes(q.accountNo)) {
            next.accountNo = undefined;
            changed = true;
          }
          if (q.category && q.category !== '__none__' && !opts.categories.includes(q.category)) {
            next.category = undefined;
            changed = true;
          }
          if (q.fundUse === '__none__' && !opts.hasUnassignedFundUse) {
            next.fundUse = undefined;
            changed = true;
          } else if (specialFundUseByQuery(q.fundUse) && !opts.specialFundUses.some((item) => item.query === q.fundUse)) {
            next.fundUse = undefined;
            changed = true;
          } else if (q.fundUse && q.fundUse !== '__none__' && !specialFundUseByQuery(q.fundUse) && !opts.fundUses.some((u) => String(u.id) === q.fundUse)) {
            next.fundUse = undefined;
            changed = true;
          }
          return changed ? { ...next, page: 1 } : q;
        });
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [
    query.taskId,
    query.fileId,
    query.bank,
    query.holder,
    query.accountNo,
    query.from,
    query.to,
    query.counterparty,
    query.q,
    query.status,
    query.category,
    query.fundUse,
  ]);

  useEffect(() => {
    void api
      .getCategories()
      .then((r) => setCatSet(r.categories))
      .catch(() => undefined);
  }, []);

  // 换任务，或从某个流水文件进来时，带上它的银行和账户。
  useEffect(() => {
    setFocus(null);
    setCompareFile(null);
    setComparePick(false);
    setSelectedIds([]);
    setBulkCat('');
    if (localUrlRef.current) {
      URL.revokeObjectURL(localUrlRef.current);
      localUrlRef.current = null;
    }
    setLocalUrl(null);
    setLocalName('');
    queryBeforeRef.current = null;
    setQuery((q) => ({
      ...q,
      taskId,
      fileId: undefined,
      bank: initialBank,
      holder: undefined,
      accountNo: initialAccountNo,
      page: 1,
    }));
  }, [taskId, initialBank, initialAccountNo]);

  useEffect(() => {
    if (query.taskId == null) {
      setData(null);
      setLoading(false);
      return;
    }
    const my = ++seq.current;
    setLoading(true);
    api
      .listTransactions(query)
      .then((r) => {
        if (seq.current === my) {
          setData(r);
          setError(undefined);
        }
      })
      .catch((e) => {
        if (seq.current === my) setError((e as Error).message);
      })
      .finally(() => {
        if (seq.current === my) setLoading(false);
      });
  }, [query, reloadKey]);

  const patch = (p: Partial<TxQuery>) => {
    setNotice(undefined);
    setQuery((q) => ({ ...q, ...p, page: 1 }));
  };

  /** 当前页勾选并入已选，其它页的勾选保留 */
  function onSelectChange(keys: Array<string | number>) {
    const pageIds = new Set((data?.rows ?? []).map((r) => r.id));
    const picked = keys.map(Number).filter((id) => pageIds.has(id));
    setSelectedIds((prev) => [...prev.filter((id) => !pageIds.has(id)), ...picked]);
  }

  /** 对照里多选改判。记为人工后，自动分类不会覆盖 */
  async function applyBulk() {
    if (selectedIds.length === 0 || !bulkCat || bulkBusy) return;
    const category = bulkCat === '__clear__' ? null : bulkCat;
    setBulkBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const res = await api.bulkCategory(selectedIds, category);
      setNotice(`已把 ${res.updated} 笔改判为${category ?? '未分类'}`);
      setSelectedIds([]);
      setBulkCat('');
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBulkBusy(false);
    }
  }

  /** 对照里多选改日期。保留勾选，方便接着改分类 */
  async function applyBulkDate() {
    if (selectedIds.length === 0 || !bulkDate || bulkBusy) return;
    setBulkBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const res = await api.bulkDate(selectedIds, bulkDate);
      setNotice(`已把 ${res.updated} 笔日期改为 ${res.date}`);
      setBulkDate('');
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBulkBusy(false);
    }
  }

  /** 只改关注标记。记录和判定在关注页追加，这里不碰 */
  async function toggleWatch(r: TxRow) {
    const next = !r.watched;
    try {
      const res = await api.setWatch(r.id, next);
      setData((d) =>
        d ? { ...d, rows: d.rows.map((x) => (x.id === r.id ? { ...x, watched: res.watched } : x)) } : d,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function openEdit(r: TxRow) {
    setEditingId(r.id);
    setDraft(draftOf(r));
    setError(undefined);
    setNotice(undefined);
  }

  /** 切换对照表显示的列。至少保留一列，选择记在本地。 */
  function toggleCompareCol(key: string) {
    setCompareCols((cur) => {
      const has = cur.includes(key);
      if (has && cur.length <= 1) return cur;
      const next = has ? cur.filter((k) => k !== key) : [...cur, key];
      try {
        localStorage.setItem(COMPARE_COLUMNS_KEY, JSON.stringify(next));
      } catch {
        /* 本地存储不可用时只影响下次打开，不影响当前显示 */
      }
      return next;
    });
  }

  /** 补一笔：日期和方向照抄当前行，金额、余额按 PDF 手填 */
  function startInsert(anchor: TxRow) {
    setInsertAfter(anchor);
    setInsertDraft({
      date: anchor.date ?? '',
      direction: anchor.direction,
      amount: '',
      balance: '',
      summary: '',
      counterparty: '',
      counterpartyAccount: '',
      channel: '',
      category: '',
    });
    setEditingId(null);
    setDraft(null);
    setError(undefined);
    setNotice(undefined);
  }

  async function saveInsert() {
    if (!insertDraft || !insertAfter || !compareFile || insertBusy) return;
    const amount = Number(insertDraft.amount.replace(/,/g, ''));
    const balance =
      insertDraft.balance.trim() === '' ? null : Number(insertDraft.balance.replace(/,/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('金额需为大于 0 的数字，单位是元');
      return;
    }
    if (balance != null && !Number.isFinite(balance)) {
      setError('余额需为数字，或留空。单位是元');
      return;
    }
    setInsertBusy(true);
    setError(undefined);
    try {
      const res = await api.addTransaction(compareFile.id, {
        afterId: insertAfter.id,
        date: insertDraft.date,
        summary: insertDraft.summary,
        amount,
        direction: insertDraft.direction,
        balance,
        counterparty: insertDraft.counterparty,
        counterpartyAccount: insertDraft.counterpartyAccount,
        channel: insertDraft.channel,
        category: insertDraft.category.trim() ? insertDraft.category.trim() : null,
      });
      const other = (res.row.reviewNote ?? '')
        .split('；')
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith('余额断裂'))
        .join('；');
      const balanceText = res.balance ? balanceRecalcText(res.balance) : '';
      setNotice(
        ['已补录一笔，记为「手工补录」，重读页面时会保留', balanceText, other ? `复核：${other}` : '']
          .filter(Boolean)
          .join('。'),
      );
      // 新行紧跟在锚点后面；锚点在当前页最后一行时，它会落到列表下一页
      const rows = data?.rows ?? [];
      const at = rows.findIndex((r) => r.id === insertAfter.id);
      const pageSize = query.pageSize ?? 50;
      if (at >= 0 && at === rows.length - 1 && rows.length >= pageSize) {
        setQuery((q) => ({ ...q, page: (q.page ?? 1) + 1 }));
      }
      jumpToId.current = res.row.id;
      setJumpSeq((n) => n + 1);
      setPdfFit((n) => n + 1);
      setFocus({ id: res.row.id, fileId: res.row.fileId, fileName: res.row.fileName, page: res.row.page || 1 });
      setInsertAfter(null);
      setInsertDraft(null);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setInsertBusy(false);
    }
  }

  async function saveEdit(id: number) {
    if (!draft || editBusy) return;
    const amount = Number(draft.amount.replace(/,/g, ''));
    const balance = draft.balance.trim() === '' ? null : Number(draft.balance.replace(/,/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('金额需为大于 0 的数字，单位是元');
      return;
    }
    if (balance != null && !Number.isFinite(balance)) {
      setError('余额需为数字，或留空。单位是元');
      return;
    }
    setEditBusy(true);
    setError(undefined);
    try {
      const res = await api.patchTransaction(id, {
        date: draft.date,
        summary: draft.summary,
        amount,
        direction: draft.direction,
        balance,
        counterparty: draft.counterparty,
        ...(compare
          ? {
              counterpartyAccount: draft.counterpartyAccount,
              channel: draft.channel,
              category: draft.category.trim() ? draft.category.trim() : null,
            }
          : {}),
      });
      const other = (res.row.reviewNote ?? '')
        .split('；')
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith('余额断裂'))
        .join('；');
      const balanceText = res.balance ? balanceRecalcText(res.balance) : '';
      setNotice(['已保存', balanceText, other ? `复核：${other}` : ''].filter(Boolean).join('。'));
      setEditingId(null);
      setDraft(null);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setEditBusy(false);
    }
  }

  const activeFilterCount = [
    query.bank, query.holder, query.accountNo, query.fundUse, query.from, query.to,
    query.counterparty, query.status, query.category,
  ].filter((v) => v !== undefined && v !== '').length;

  async function openCompare() {
    if (taskId == null) return;
    setComparePick(true);
    setFilesBusy(true);
    setError(undefined);
    try {
      const detail = await api.getTask(taskId);
      setTaskFiles(detail.files.filter((f) => f.relPath.toLowerCase().endsWith('.pdf')));
    } catch (e) {
      setTaskFiles([]);
      setError((e as Error).message);
    } finally {
      setFilesBusy(false);
    }
  }

  /** 已选定账户时，直接找到这个账户的 PDF；同一账户有多期流水就打开最近一期。 */
  function accountCompareFile(
    files: BankFile[],
    accountNo: string,
    bank: string | undefined,
    focusedFileId: number | undefined,
    rowFileId: number | undefined,
  ): BankFile | undefined {
    const sameAccount = files.filter((f) => (f.accountNo ?? '').trim() === accountNo);
    if (sameAccount.length === 0) return undefined;
    const sameBank = bank ? sameAccount.filter((f) => f.bank === bank) : [];
    const cands = sameBank.length > 0 ? sameBank : sameAccount;
    if (cands.length === 1) return cands[0];
    const focused = cands.find((f) => f.id === focusedFileId) ?? cands.find((f) => f.id === rowFileId);
    if (focused) return focused;
    // 同一账户有多期流水：默认打开最近一期，另一期仍可从「切换」进入。
    return [...cands].sort(
      (a, b) => (b.periodEnd ?? '').localeCompare(a.periodEnd ?? '') || b.id - a.id,
    )[0];
  }

  /** 对照按钮：选了账户就直接开这个账户的 PDF；没选账户才让用户挑。 */
  async function startCompare() {
    if (taskId == null) return;
    const accountNo = query.accountNo?.trim();
    if (!accountNo) {
      await openCompare();
      return;
    }
    setFilesBusy(true);
    setError(undefined);
    try {
      const detail = await api.getTask(taskId);
      const files = detail.files.filter((f) => f.relPath.toLowerCase().endsWith('.pdf'));
      setTaskFiles(files);
      const rowFileIds = new Set((data?.rows ?? []).map((r) => r.fileId));
      const target = accountCompareFile(
        files,
        accountNo,
        query.bank,
        focus?.fileId,
        rowFileIds.size === 1 ? [...rowFileIds][0] : undefined,
      );
      if (target) {
        enterCompare(target);
        return;
      }
      // 账户选着但找不到对应 PDF（比如还没登记文件），退回手动选。
      setComparePick(true);
    } catch (e) {
      setTaskFiles([]);
      setError((e as Error).message);
      setComparePick(true);
    } finally {
      setFilesBusy(false);
    }
  }

  function enterCompare(file: BankFile) {
    queryBeforeRef.current = query;
    setCompareFile(file);
    setComparePick(false);
    setColsOpen(false);
    setPdfFit(0);
    setFocus(null);
    setSelectedIds([]);
    setBulkCat('');
    setQuery((q) => ({
      taskId: q.taskId,
      fileId: file.id,
      sort: 'stmt',
      page: 1,
      pageSize: q.pageSize ?? 50,
    }));
  }

  function switchCompare(file: BankFile) {
    setComparePick(false);
    if (file.id === compareFile?.id) return;
    setCompareFile(file);
    setPdfFit(0);
    setFocus(null);
    setSelectedIds([]);
    setBulkCat('');
    if (localUrlRef.current) {
      URL.revokeObjectURL(localUrlRef.current);
      localUrlRef.current = null;
    }
    setLocalUrl(null);
    setLocalName('');
    setQuery((q) => ({ ...q, fileId: file.id, page: 1 }));
  }

  function exitCompare() {
    const prev = queryBeforeRef.current;
    queryBeforeRef.current = null;
    setCompareFile(null);
    setComparePick(false);
    setColsOpen(false);
    setPdfFit(0);
    setFocus(null);
    setSelectedIds([]);
    setBulkCat('');
    if (localUrlRef.current) {
      URL.revokeObjectURL(localUrlRef.current);
      localUrlRef.current = null;
    }
    setLocalUrl(null);
    setLocalName('');
    if (prev) setQuery(prev);
    else setQuery((q) => ({ ...q, fileId: undefined, page: 1 }));
  }

  function focusTx(r: TxRow) {
    setPdfFit(0);
    setFocus({ id: r.id, fileId: r.fileId, fileName: r.fileName, page: r.page || 1 });
  }

  /** 从当前这笔往后，跳到下一条待复核。后面没有就回到第一条。行和 PDF 页都放到中间。 */
  async function jumpToNearestReview() {
    if (!compareFile || query.taskId == null || jumpBusy) return;
    setJumpBusy(true);
    setNotice(undefined);
    setError(undefined);
    try {
      const reviews: TxRow[] = [];
      const chunk = 200;
      for (let page = 1; page <= 50; page++) {
        const r = await api.listTransactions({
          taskId: query.taskId,
          fileId: compareFile.id,
          status: 'needs_review',
          sort: 'stmt',
          page,
          pageSize: chunk,
        });
        reviews.push(...r.rows);
        if (reviews.length >= r.total || r.rows.length === 0) break;
      }
      if (reviews.length === 0) {
        setNotice('这份流水没有待复核');
        return;
      }
      const anchor =
        (focus ? data?.rows.find((r) => r.id === focus.id) : undefined) ?? data?.rows[0];
      const anchorKey = anchor ? stmtKey(anchor) : -1;
      const target = reviews.find((r) => stmtKey(r) > anchorKey) ?? reviews[0];
      const pageSize = query.pageSize ?? 50;
      const onScreen = anchor && target.id === anchor.id && data?.rows.some((row) => row.id === target.id);
      let listPage = query.page ?? 1;
      if (!onScreen) {
        for (let page = 1; page <= 50; page++) {
          const r = await api.listTransactions({
            taskId: query.taskId,
            fileId: compareFile.id,
            sort: 'stmt',
            page,
            pageSize: chunk,
          });
          const idx = r.rows.findIndex((row) => row.id === target.id);
          if (idx >= 0) {
            listPage = Math.floor(((page - 1) * chunk + idx) / pageSize) + 1;
            break;
          }
          if (page * chunk >= r.total || r.rows.length === 0) break;
        }
      }
      if (anchor && target.id === anchor.id) setNotice('已经在这条待复核上');
      jumpToId.current = target.id;
      setJumpSeq((n) => n + 1);
      setPdfFit((n) => n + 1);
      setFocus({ id: target.id, fileId: target.fileId, fileName: target.fileName, page: target.page || 1 });
      setQuery((q) => (q.page === listPage ? q : { ...q, page: listPage }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setJumpBusy(false);
    }
  }

  function openLocalPdf(file: File | undefined) {
    if (!file) return;
    if (localUrlRef.current) URL.revokeObjectURL(localUrlRef.current);
    const url = URL.createObjectURL(file);
    localUrlRef.current = url;
    setLocalUrl(url);
    setLocalName(file.name);
  }

  useEffect(() => {
    if (!compare) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (colsOpen) {
        setColsOpen(false);
      } else if (insertAfter != null) {
        setInsertAfter(null);
        setInsertDraft(null);
      } else if (editingId != null) {
        setEditingId(null);
        setDraft(null);
      } else exitCompare();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // 只在进入对照时绑定。退出时读的是 ref 里保存的筛选。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compare, editingId, insertAfter, colsOpen]);

  useEffect(() => {
    if (!colsOpen) return undefined;
    const onDown = (e: globalThis.MouseEvent) => {
      if (!colsMenuRef.current?.contains(e.target as Node)) setColsOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [colsOpen]);

  useEffect(() => {
    const id = jumpToId.current;
    if (!compare || id == null) return;
    let cancelled = false;
    const timers: number[] = [];
    const run = (tries: number) => {
      if (cancelled || jumpToId.current !== id) return;
      if (!centerCompareRow(id)) {
        if (tries < 8) timers.push(window.setTimeout(() => run(tries + 1), 50));
        return;
      }
      // 分页换页后表格还会再排一次，隔一会儿再校正，避免行停在顶部。
      timers.push(window.setTimeout(() => {
        if (!cancelled && jumpToId.current === id) centerCompareRow(id);
      }, 80));
      timers.push(window.setTimeout(() => {
        if (!cancelled && jumpToId.current === id) {
          centerCompareRow(id);
          jumpToId.current = null;
        }
      }, 240));
    };
    timers.push(window.setTimeout(() => run(0), 0));
    return () => {
      cancelled = true;
      for (const t of timers) window.clearTimeout(t);
    };
  }, [compare, data, loading, query.page, jumpSeq]);

  useEffect(() => {
    if (!compareFile || query.taskId == null) {
      setReviewLeft(null);
      return;
    }
    let cancelled = false;
    void api
      .listTransactions({
        taskId: query.taskId,
        fileId: compareFile.id,
        status: 'needs_review',
        sort: 'stmt',
        page: 1,
        pageSize: 1,
      })
      .then((r) => {
        if (!cancelled) setReviewLeft(r.total);
      })
      .catch(() => {
        if (!cancelled) setReviewLeft(null);
      });
    return () => {
      cancelled = true;
    };
  }, [compareFile, query.taskId, reloadKey]);

  const pdfPage = focus?.page && focus.page > 0 ? focus.page : 1;
  const pdfBase = localUrl ?? (compareFile ? `/api/files/${compareFile.id}/pdf` : '');
  // view=Fit：Chrome 内置阅读器把这一页整页放进右栏，不用再拖 PDF 滑块。
  const pdfSrc = pdfBase ? `${pdfBase}#page=${pdfPage}${pdfFit ? '&view=Fit' : ''}` : '';

  return (
    <div className={compare ? 'tx-compare-screen' : 'tx-page'}>
      <div className={compare ? 'tx-compare-body' : 'tx-page-inner'}>
      {compare && compareFile ? (
        <div className="tx-compare-bar">
          <span className="tx-compare-name" title={localName || compareFile.relPath}>
            {fileLabel(compareFile.relPath)}
            {localName ? ` · ${localName}` : ''}
          </span>
          <div className="tx-compare-bar-actions">
            <button type="button" className="secondary-button" onClick={() => void openCompare()}>
              切换
            </button>
            <button type="button" className="secondary-button" onClick={() => fileInputRef.current?.click()}>
              本地
            </button>
            <button type="button" className="secondary-button" onClick={exitCompare}>
              退出
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,.pdf"
              hidden
              onChange={(e) => {
                openLocalPdf(e.target.files?.[0]);
                e.currentTarget.value = '';
              }}
            />
          </div>
        </div>
      ) : (
      <div className="page-header" style={{ marginBottom: 12 }}>
        <div>
          <h1 style={{ fontSize: 18, marginBottom: 2 }}>交易</h1>
        </div>
        <div className="page-header-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={taskId == null || filesBusy}
            onClick={() => void startCompare()}
          >
            <Columns2 size={14} /> 对照
          </button>
          <MoneyUnitSelect value={unit} onChange={setUnit} />
        </div>
      </div>
      )}

      {compare ? null : taskId == null ? (
        <div className="flow-empty">
          <h3>先在右上角打开一个任务</h3>
          <p>交易只显示当前任务的流水。</p>
        </div>
      ) : options ? (
        <div className="tx-filters">
          <div className="tx-filter-row primary">
            <select
              className="input filter-control"
              title={query.bank || '全部银行'}
              value={query.bank ?? ''}
              onChange={(e) => {
                const bank = e.target.value || undefined;
                patch(bank ? { bank, accountNo: undefined } : { bank: undefined });
              }}
            >
              <option value="">全部银行</option>
              {options.banks.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
            <select
              className="input filter-control"
              title={
                specialFundUseByQuery(query.fundUse)?.label ||
                options.fundUses.find((u) => String(u.id) === query.fundUse)?.name ||
                '全部募投'
              }
              value={query.fundUse ?? ''}
              onChange={(e) => {
                const fundUse = e.target.value || undefined;
                patch(fundUse ? { fundUse, accountNo: undefined } : { fundUse: undefined });
              }}
            >
              <option value="">全部募投</option>
              {options.hasUnassignedFundUse ? <option value="__none__">未归集</option> : null}
              {options.specialFundUses.map((item) => (
                <option key={item.query} value={item.query}>
                  {item.label}
                </option>
              ))}
              {options.fundUses.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
            <select
              className="input filter-control"
              title={query.holder || '全部开户主体'}
              value={query.holder ?? ''}
              onChange={(e) => {
                const holder = e.target.value || undefined;
                patch(holder ? { holder, accountNo: undefined } : { holder: undefined });
              }}
            >
              <option value="">全部开户主体</option>
              {options.holders.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
            <select
              className="input filter-control"
              title={query.accountNo || '全部账户'}
              value={query.accountNo ?? ''}
              onChange={(e) => patch({ accountNo: e.target.value || undefined })}
            >
              <option value="">全部账户</option>
              {options.accounts.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <select
              className="input filter-control"
              value={query.status ?? ''}
              onChange={(e) => patch({ status: (e.target.value || undefined) as TxQuery['status'] })}
            >
              <option value="">全部状态</option>
              <option value="ok">正常</option>
              <option value="needs_review">待复核</option>
              <option value="fixed">已修正</option>
            </select>
            <select
              className="input filter-control"
              title={query.category || '全部分类'}
              value={query.category ?? ''}
              onChange={(e) => patch({ category: e.target.value || undefined })}
            >
              <option value="">全部分类</option>
              <option value="__none__">未分类</option>
              {options.categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="tx-filter-row secondary">
            <input
              type="date"
              className="input filter-control"
              value={query.from ?? ''}
              onChange={(e) => patch({ from: e.target.value || undefined })}
              title="起始日期"
            />
            <span className="filter-sep">至</span>
            <input
              type="date"
              className="input filter-control"
              value={query.to ?? ''}
              onChange={(e) => patch({ to: e.target.value || undefined })}
              title="结束日期"
            />
            <input
              className="input filter-control"
              placeholder="对手方"
              value={query.counterparty ?? ''}
              onChange={(e) => patch({ counterparty: e.target.value || undefined })}
            />
            {activeFilterCount > 0 ? (
              <button
                className="filter-reset"
                onClick={() => {
                  setNotice(undefined);
                  setQuery({
                    taskId: query.taskId,
                    sort: query.sort,
                    page: 1,
                    pageSize: 50,
                  });
                }}
              >
                <FilterX size={13} /> 清除（{activeFilterCount}）
              </button>
            ) : (
              <span />
            )}
          </div>
        </div>
      ) : (
        <div className="flow-notice">加载过滤器选项…</div>
      )}

      {!compare && error ? <div className="flow-error">{error}</div> : null}
      {!compare && notice ? <div className="flow-notice">{notice}</div> : null}

      <div className={compare ? 'tx-compare' : undefined}>
      <div className={compare ? 'tx-compare-left' : undefined} style={compare ? { width: `${split * 100}%` } : undefined}>
      {compare ? (
        <div className="tx-compare-next-bar">
          <div className="tx-compare-left-actions">
            <div className="tx-compare-fields" ref={colsMenuRef}>
              <button
                type="button"
                className="secondary-button"
                aria-expanded={colsOpen}
                title="选择对照表显示哪些字段"
                onClick={() => setColsOpen((open) => !open)}
              >
                <SlidersHorizontal size={14} /> 字段
              </button>
              {colsOpen ? (
                <div className="tx-compare-fields-menu" role="group" aria-label="显示字段">
                  {COMPARE_COLUMNS.map((col) => {
                    const checked = compareCols.includes(col.key);
                    return (
                      <label key={col.key}>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={checked && compareCols.length <= 1}
                          onChange={() => toggleCompareCol(col.key)}
                        />
                        {col.label}
                      </label>
                    );
                  })}
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className="secondary-button"
              disabled={!focusedRow || insertBusy}
              title={
                focusedRow
                  ? `在第 ${focusedRow.page} 页这一笔后面补一笔，按印刷位置插入`
                  : '先在左侧点一行，补录的行会插在它后面'
              }
              onClick={() => focusedRow && startInsert(focusedRow)}
            >
              <Plus size={14} /> 补一笔
            </button>
          </div>
          <button
            type="button"
            className={`tx-next-review${reviewLeft === 0 ? ' empty' : ''}`}
            disabled={jumpBusy || reviewLeft === 0}
            title={
              reviewLeft == null
                ? '正在统计待复核'
                : reviewLeft === 0
                  ? '这份流水没有待复核'
                  : `还剩 ${reviewLeft} 笔待复核`
            }
            onClick={() => void jumpToNearestReview()}
          >
            <span>下一个待复核</span>
            <span className="tx-next-review-count">{reviewLeft == null ? '–' : reviewLeft}</span>
          </button>
        </div>
      ) : null}
      <div className={compare ? 'tx-compare-left-scroll' : undefined}>
      {compare || !data ? null : (
        <div className="tx-summary">
          <span>共 {data.total.toLocaleString()} 笔</span>
          <span className="tx-summary-in">流入 {formatByUnit(data.inflow, unit)}</span>
          <span className="tx-summary-out">流出 {formatByUnit(data.outflow, unit)}</span>
          <span className="tx-summary-page">
            第 {query.page} 页 · 每页 {query.pageSize} 笔
          </span>
        </div>
      )}

      {compare || !(data && data.rows.length === 0) ? null : (
        <div className="flow-empty">
          <h3>
            <Inbox size={18} style={{ verticalAlign: '-3px', marginRight: 8 }} />
            暂无交易
          </h3>
          <p>把流水 PDF 放进任务目录后自动解析入库；或到任务页点「重新扫描」。</p>
        </div>
      )}

      {compare && error && editingId == null ? <div className="flow-error">{error}</div> : null}
      {compare && notice ? <div className="flow-notice">{notice}</div> : null}

      <div className="tx-table">
        <Table
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={data?.rows ?? []}
          rowSelection={
            compare
              ? {
                  selectedRowKeys: selectedIds,
                  onChange: onSelectChange,
                  columnWidth: 36,
                }
              : undefined
          }
          onRow={
            compare
              ? (r: TxRow) => ({
                  onClick: (e) => {
                    const el = e.target as HTMLElement;
                    if (el.closest('.ant-table-selection-column, button, a, input, label')) return;
                    focusTx(r);
                    setExpandedKeys((keys) => (keys.includes(r.id) ? keys.filter((id) => id !== r.id) : [...keys, r.id]));
                  },
                })
              : undefined
          }
          rowClassName={
            compare
              ? (r: TxRow) => {
                  const base = r.id === focus?.id ? 'tx-compare-hit' : 'tx-compare-row';
                  return r.status === 'needs_review' ? `${base} tx-compare-review` : base;
                }
              : undefined
          }
          pagination={{
            current: query.page ?? 1,
            pageSize: query.pageSize ?? 50,
            total: data?.total ?? 0,
            showSizeChanger: false,
            hideOnSinglePage: false,
            onChange: (p) => setQuery((q) => ({ ...q, page: p })),
          }}
          expandable={
            compare
              ? {
                  rowExpandable: () => true,
                  expandedRowKeys: expandedKeys,
                  expandIcon: ({ record }: { expanded: boolean; onExpand: (r: TxRow, e: MouseEvent<HTMLElement>) => void; record: TxRow }) => (
                    <button
                      type="button"
                      className="ant-table-row-expand-icon ant-table-row-expand-icon-collapsed"
                      aria-label="修改交易"
                      title="修改这笔交易"
                      onClick={(e) => {
                        e.stopPropagation();
                        focusTx(record);
                        openEdit(record);
                      }}
                    />
                  ),
                  expandedRowRender: (r: TxRow) => <TxRawRow r={r} />,
                }
              : undefined
          }
          columns={([
            {
              title: '关注',
              key: 'watch',
              width: 52,
              align: 'center',
              render: (_: unknown, r: TxRow) => (
                <button
                  type="button"
                  className={`tx-watch${r.watched ? ' on' : ''}`}
                  title={r.watched ? '取消关注。已记下的内容和判定会留着' : '标记关注，之后到关注页处理'}
                  onClick={() => void toggleWatch(r)}
                >
                  <Bookmark size={14} />
                </button>
              ),
            },
            {
              title: '日期',
              key: 'date',
              dataIndex: 'date',
              width: 96,
              render: (v: unknown) => <span className="tx-date">{typeof v === 'string' ? v : '—'}</span>,
            },
            {
              title: '金额',
              key: 'amount',
              dataIndex: 'amount',
              width: 150,
              align: 'right',
              render: (_: unknown, r: TxRow) => (
                <span className={`tx-amount ${r.direction}`}>
                  {r.direction === 'in' ? '+' : '−'} {fmtAmount(r.amount, unit)}
                </span>
              ),
            },
            {
              title: '余额',
              key: 'balance',
              dataIndex: 'balance',
              width: 118,
              align: 'right',
              render: (v: unknown) => <span className="tx-balance">{fmtAmount(typeof v === 'number' ? v : undefined, unit)}</span>,
            },
            {
              title: '摘要',
              key: 'summary',
              dataIndex: 'summary',
              ellipsis: true,
              render: (v: unknown, r: TxRow) => <span title={r.rawText ?? (typeof v === 'string' ? v : undefined)}>{typeof v === 'string' ? v : '—'}</span>,
            },
            {
              title: '对手方',
              key: 'counterparty',
              dataIndex: 'counterparty',
              width: 170,
              ellipsis: true,
              render: (v: unknown) => (typeof v === 'string' && v ? v : '—'),
            },
            {
              title: '分类',
              key: 'category',
              width: 140,
              ellipsis: true,
              render: (_: unknown, r: TxRow) =>
                r.category ? (
                  <span className="tx-cat">
                    <span title={r.category}>{r.category}</span>
                    <span className={`tx-cat-src${r.categorySrc === 'manual' ? ' manual' : ''}`}>
                      {r.categorySrc === 'manual' ? '人工改判' : 'LLM'}
                    </span>
                  </span>
                ) : (
                  '—'
                ),
            },
            {
              title: '开户主体',
              key: 'holder',
              dataIndex: 'holder',
              width: 168,
              ellipsis: true,
              render: (v: unknown) => (typeof v === 'string' && v ? <span title={v}>{v}</span> : '—'),
            },
            {
              title: '银行 / 账户',
              key: 'bank',
              width: 160,
              ellipsis: true,
              render: (_: unknown, r: TxRow) =>
                r.bank || r.accountNo ? (
                  <span className="tx-bankaccount" title={`${r.bank ?? ''} ${r.accountNo ?? ''}`}>
                    {r.bank ?? '—'} {r.accountNo ? `· ${r.accountNo.slice(-4)}` : ''}
                  </span>
                ) : (
                  '—'
                ),
            },
            {
              title: '募投项目',
              key: 'fundUse',
              dataIndex: 'fundUse',
              width: 140,
              ellipsis: true,
              render: (v: unknown) => (typeof v === 'string' && v ? v : '—'),
            },
            {
              title: '状态',
              key: 'status',
              width: 124,
              render: (_: unknown, r: TxRow) => {
                const chip = STATUS_CHIP[r.status] ?? { cls: 'chip-muted', label: r.status };
                return (
                  <>
                    <span className={`chip tx-status ${chip.cls}`} title={r.reviewNote || chip.label}>
                      {chip.label}
                    </span>
                    {r.source === 'manual' ? (
                      <span className="tx-manual-tag" title="手工补录，重读页面时会保留">
                        补录
                      </span>
                    ) : null}
                  </>
                );
              },
            },
          ] as { title?: unknown; key?: unknown }[]).filter((c) => {
            if (!compare) return true;
            return compareCols.includes(String(c.key ?? ''));
          }) as never}
        />
      </div>
      </div>
      {compare && selectedIds.length > 0 ? (
        <div className="tx-bulk tx-compare-bulk">
          <span className="tx-bulk-count">已选 {selectedIds.length} 笔</span>
          <span className="tx-bulk-hint">可跨页勾选。改判记为人工；改日期会清掉日期相关复核提示。</span>
          <select
            className="input filter-control tx-bulk-select"
            aria-label="批量分类"
            value={bulkCat}
            disabled={bulkBusy}
            onChange={(e) => setBulkCat(e.target.value)}
          >
            <option value="">选择分类</option>
            <option value="__clear__">未分类</option>
            {catSet.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <button type="button" className="primary-button" disabled={!bulkCat || bulkBusy} onClick={() => void applyBulk()}>
            {bulkBusy ? '改判中…' : '改判'}
          </button>
          <input
            type="date"
            className="input filter-control tx-bulk-date"
            aria-label="批量修改日期"
            value={bulkDate}
            disabled={bulkBusy}
            onChange={(e) => setBulkDate(e.target.value)}
          />
          <button
            type="button"
            className="primary-button"
            disabled={!bulkDate || bulkBusy}
            onClick={() => void applyBulkDate()}
          >
            {bulkBusy ? '处理中…' : '改日期'}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={bulkBusy}
            onClick={() => {
              setSelectedIds([]);
              setBulkCat('');
              setBulkDate('');
            }}
          >
            取消
          </button>
        </div>
      ) : null}
      {compare && draft && editingId != null ? (
        <CompareEdit
          draft={draft}
          categories={catSet}
          busy={editBusy}
          error={error}
          onChange={setDraft}
          onSave={() => void saveEdit(editingId)}
          onCancel={() => {
            setEditingId(null);
            setDraft(null);
            setError(undefined);
          }}
        />
      ) : null}
      {compare && insertDraft && insertAfter ? (
        <CompareEdit
          title={`补一笔（插在第 ${insertAfter.page} 页这笔之后）`}
          draft={insertDraft}
          categories={catSet}
          busy={insertBusy}
          error={error}
          onChange={setInsertDraft}
          onSave={() => void saveInsert()}
          onCancel={() => {
            setInsertAfter(null);
            setInsertDraft(null);
            setError(undefined);
          }}
        />
      ) : null}
      </div>
      {compare ? (
        <div
          className="tx-compare-split"
          role="separator"
          aria-orientation="vertical"
          aria-valuemin={28}
          aria-valuemax={72}
          aria-valuenow={Math.round(split * 100)}
          title="拖动调整左右宽度"
          onPointerDown={(e) => {
            splitDrag.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            e.currentTarget.classList.add('dragging');
            e.currentTarget.parentElement?.classList.add('is-split-drag');
          }}
          onPointerMove={(e) => {
            if (!splitDrag.current) return;
            const parent = e.currentTarget.parentElement;
            if (!parent) return;
            const rect = parent.getBoundingClientRect();
            if (rect.width <= 0) return;
            const minLeft = 320;
            const minRight = 280;
            const x = Math.min(Math.max(e.clientX - rect.left, minLeft), rect.width - minRight);
            setSplit(x / rect.width);
          }}
          onPointerUp={(e) => {
            splitDrag.current = false;
            e.currentTarget.classList.remove('dragging');
            e.currentTarget.parentElement?.classList.remove('is-split-drag');
          }}
          onPointerCancel={(e) => {
            splitDrag.current = false;
            e.currentTarget.classList.remove('dragging');
            e.currentTarget.parentElement?.classList.remove('is-split-drag');
          }}
        />
      ) : null}
      {compare ? (
        <div className="tx-compare-right">
          {pdfSrc ? <iframe key={`${pdfSrc}:${pdfFit}`} className="tx-pdf-frame" title="流水 PDF" src={pdfSrc} /> : null}
        </div>
      ) : null}
      </div>

      {comparePick ? (
        <Modal title="选择要对照的流水" lead="选一份本任务的银行流水，进入左右对照。" onClose={() => setComparePick(false)}>
          {filesBusy ? (
            <p className="modal-lead">正在读取本任务的流水…</p>
          ) : taskFiles.length === 0 ? (
            <p className="modal-lead">本任务还没有 PDF。把流水放进任务目录后，再来对照。</p>
          ) : (
            <div className="tx-compare-files">
              {taskFiles.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={`tx-compare-file${compareFile?.id === f.id ? ' on' : ''}`}
                  onClick={() => (compareFile ? switchCompare(f) : enterCompare(f))}
                >
                  <span className="tx-compare-file-name">{fileLabel(f.relPath)}</span>
                  <span className="tx-compare-file-meta">
                    {[f.bank, f.accountNo ? f.accountNo.slice(-4) : '', f.txCount ? `${f.txCount} 笔` : ''].filter(Boolean).join(' · ') || 'PDF'}
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={() => setComparePick(false)}>
              取消
            </button>
          </div>
        </Modal>
      ) : null}
      </div>
    </div>
  );
}

/** 对照模式里改这笔交易。只盖住左半边，右边的 PDF 仍可对照。 */
function CompareEdit({
  title = '修改交易',
  draft,
  categories,
  busy,
  error,
  onChange,
  onSave,
  onCancel,
}: {
  title?: string;
  draft: TxDraft;
  categories: string[];
  busy: boolean;
  error?: string;
  onChange: (draft: TxDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const extra = draft.category && !categories.includes(draft.category) ? [draft.category] : [];
  return (
    <div
      className="tx-compare-edit-mask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div className="tx-compare-edit" role="dialog" aria-label={title}>
        <h3>{title}</h3>
        {error ? <div className="flow-error">{error}</div> : null}
        <div className="tx-compare-edit-grid">
          <span>日期</span>
          <input className="input" type="date" aria-label="日期" value={draft.date} onChange={(e) => onChange({ ...draft, date: e.target.value })} />
          <span>方向</span>
          <select className="input" aria-label="方向" value={draft.direction} onChange={(e) => onChange({ ...draft, direction: e.target.value as 'in' | 'out' })}>
            <option value="out">支出</option>
            <option value="in">收入</option>
          </select>
          <span>金额</span>
          <input className="input" aria-label="金额（元）" value={draft.amount} onChange={(e) => onChange({ ...draft, amount: e.target.value })} placeholder="金额（元）" />
          <span>余额</span>
          <input className="input" aria-label="余额（元）" value={draft.balance} onChange={(e) => onChange({ ...draft, balance: e.target.value })} placeholder="余额（元），可空" />
          <span>摘要</span>
          <input className="input" aria-label="摘要" value={draft.summary} onChange={(e) => onChange({ ...draft, summary: e.target.value })} placeholder="摘要" />
          <span>对手方</span>
          <input className="input" aria-label="对手方" value={draft.counterparty} onChange={(e) => onChange({ ...draft, counterparty: e.target.value })} placeholder="对手方" />
          <span>对方账号</span>
          <input className="input" aria-label="对方账号" value={draft.counterpartyAccount} onChange={(e) => onChange({ ...draft, counterpartyAccount: e.target.value })} placeholder="对方账号" />
          <span>渠道</span>
          <input className="input" aria-label="渠道" value={draft.channel} onChange={(e) => onChange({ ...draft, channel: e.target.value })} placeholder="渠道" />
          <span>分类</span>
          <select className="input" aria-label="分类" value={draft.category} onChange={(e) => onChange({ ...draft, category: e.target.value })}>
            <option value="">未分类</option>
            {categories.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
            {extra.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>取消</button>
          <button type="button" className="primary-button" disabled={busy} onClick={onSave}>{busy ? '保存中…' : '保存'}</button>
        </div>
      </div>
    </div>
  );
}

/** 对照模式里展开，看原始行，方便在右边的 PDF 里定位。 */
function TxRawRow({ r }: { r: TxRow }) {
  return (
    <div className="tx-detail">
      {r.reviewNote ? <div className="tx-detail-review">复核：{r.reviewNote}</div> : null}
      <div className="tx-detail-meta">
        <span>
          {r.fileName} · 第 {r.page} 页 · 行 {r.lineNo}
          {r.source === 'manual' ? ' · 手工补录' : ''}
        </span>
        {r.channel ? <span>渠道：{r.channel}</span> : null}
        {r.counterpartyAccount ? <span>对方账号：{r.counterpartyAccount}</span> : null}
      </div>
      {r.rawText ? <pre className="tx-raw">{r.rawText}</pre> : <div className="tx-raw-empty">（无原始行文本）</div>}
    </div>
  );
}

export default TransactionsPage;

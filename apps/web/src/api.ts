import {
  BankFile,
  Client,
  ClientBrief,
  ClientView,
  ClassifyOutcome,
  CreateEntityInput,
  FlowTask,
  FsListing,
  FsMkdirInput,
  FsRootInfo,
  ProbeResult,
  ProjectBrief,
  ProjectView,
  Settings,
  TaskBrief,
  TaskListItem,
  TaskView,
  TxOptions,
  TxPageResult,
  TxQuery,
  TxRow,
  FundUse,
  FundUseKind,
  ProjectAccount,
  SpecialFundUseRole,
  FlowResponse,
  CategoryFocus,
  CashMandate,
  DedicatedBalance,
  CashLotReport,
  WatchItem,
} from '@flow/shared';

type FundUseInput = { name: string; kind: FundUseKind; addedOn: string; adjustedAmount: number };

export interface LlmModelsResult {
  ok: boolean;
  models: string[];
  detail: string;
}

async function j<T>(p: string, init?: RequestInit): Promise<T> {
  const r = await fetch(p, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`);
  }
  return r.json() as Promise<T>;
}

export interface ClientDetail {
  client: ClientView;
  projects: ProjectView[];
}

export interface ProjectDetail {
  project: ProjectView;
  client: ClientBrief;
  tasks: TaskView[];
  fundUses: FundUse[];
  accounts: ProjectAccount[];
}

export interface TaskDetail {
  task: TaskView;
  project: ProjectBrief;
  client: ClientBrief;
  files: BankFile[];
  accounts: ProjectAccount[];
  /** 这个任务的解析已暂停，点继续后从停下的那一步接着做 */
  parsePaused?: boolean;
}

export interface RefreshResult {
  ok: boolean;
  added: number;
  /** 上次没读完、这次从断点继续的文件数 */
  resumed?: number;
}

export type FilePages = { total: number; gaps: number[]; byPage: { page: number; n: number }[] };

export const api = {
  /* ---------- 设置 / AI 探测（M1） ---------- */
  getSettings: () => j<Settings>('/api/settings'),
  putSettings: (s: Settings) => j<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(s) }),
  probe: (s?: Partial<Settings>) =>
    j<{ llm: ProbeResult; ocr: ProbeResult }>('/api/ai/probe', {
      method: 'POST',
      body: JSON.stringify(s ?? {}),
    }),
  probeLlm: (v: Partial<Settings>) => j<ProbeResult>('/api/ai/probe-llm', { method: 'POST', body: JSON.stringify(v) }),
  probeOcr: (v: Partial<Settings>) => j<ProbeResult>('/api/ai/probe-ocr', { method: 'POST', body: JSON.stringify(v) }),
  llmModels: (v: Partial<Settings>) => j<LlmModelsResult>('/api/llm/models', { method: 'POST', body: JSON.stringify(v) }),

  /* ---------- 目录浏览器（对齐 Avalon fs 通道） ---------- */
  fsRoot: () => j<FsRootInfo>('/api/fs/root'),
  fsList: (p?: string) => j<FsListing>(`/api/fs/list${p ? `?path=${encodeURIComponent(p)}` : ''}`),
  fsMkdir: (i: FsMkdirInput) => j<{ path: string }>('/api/fs/mkdir', { method: 'POST', body: JSON.stringify(i) }),

  /* ---------- 客户 ---------- */
  listClients: () => j<ClientView[]>('/api/clients'),
  createClient: (i: CreateEntityInput) => j<Client>('/api/clients', { method: 'POST', body: JSON.stringify(i) }),
  getClient: (id: number) => j<ClientDetail>(`/api/clients/${id}`),
  deleteClient: (id: number) => j<{ ok: boolean }>(`/api/clients/${id}`, { method: 'DELETE' }),
  createProject: (clientId: number, i: CreateEntityInput) =>
    j<ProjectView>(`/api/clients/${clientId}/projects`, { method: 'POST', body: JSON.stringify(i) }),
  openClientFolder: (id: number) => j<{ ok: boolean }>(`/api/clients/${id}/open`, { method: 'POST' }),

  /* ---------- 项目 ---------- */
  getProject: (id: number) => j<ProjectDetail>(`/api/projects/${id}`),
  deleteProject: (id: number) => j<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),
  createTask: (projectId: number, i: CreateEntityInput) =>
    j<FlowTask>(`/api/projects/${projectId}/tasks`, { method: 'POST', body: JSON.stringify(i) }),
  openProjectFolder: (id: number) => j<{ ok: boolean }>(`/api/projects/${id}/open`, { method: 'POST' }),
  createFundUse: (projectId: number, body: FundUseInput) =>
    j<FundUse>(`/api/projects/${projectId}/uses`, { method: 'POST', body: JSON.stringify(body) }),
  updateFundUse: (projectId: number, useId: number, body: FundUseInput) =>
    j<FundUse>(`/api/projects/${projectId}/uses/${useId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteFundUse: (projectId: number, useId: number) =>
    j<{ ok: boolean }>(`/api/projects/${projectId}/uses/${useId}`, { method: 'DELETE' }),
  createAccount: (projectId: number, body: { holder: string; bank: string; accountNo: string; openedOn: string; fundUseId: number | null; useRole?: SpecialFundUseRole | '' }) =>
    j<ProjectAccount>(`/api/projects/${projectId}/accounts`, { method: 'POST', body: JSON.stringify(body) }),
  updateAccount: (
    projectId: number,
    accountId: number,
    body: { holder: string; bank: string; accountNo: string; openedOn: string; fundUseId: number | null; useRole?: SpecialFundUseRole | '' },
  ) => j<ProjectAccount>(`/api/projects/${projectId}/accounts/${accountId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteAccount: (projectId: number, accountId: number) =>
    j<{ ok: boolean }>(`/api/projects/${projectId}/accounts/${accountId}`, { method: 'DELETE' }),

  /* ---------- 任务 ---------- */
  getTask: (id: number) => j<TaskDetail>(`/api/tasks/${id}`),
  getFlow: (id: number) => j<FlowResponse>(`/api/tasks/${id}/flow`),
  categoryFocus: (id: number) => j<{ views: CategoryFocus[] }>(`/api/tasks/${id}/category-focus`),
  dedicatedBalances: (id: number) => j<{ rows: DedicatedBalance[] }>(`/api/tasks/${id}/dedicated-balances`),
  cashLots: (id: number) => j<CashLotReport>(`/api/tasks/${id}/cash-lots`),
  saveCashSplit: (taskId: number, txId: number, body: { principal: number | null; interest: number | null }) =>
    j<CashLotReport>(`/api/tasks/${taskId}/cash-lots/${txId}/split`, { method: 'PUT', body: JSON.stringify(body) }),
  cashMandate: (id: number) => j<CashMandate>(`/api/tasks/${id}/cash-mandate`),
  saveCashMandate: (id: number, body: { opening: number; openingAsOf: string; boards: { startDate: string; endDate: string; limitAmount: number; note: string }[] }) =>
    j<CashMandate>(`/api/tasks/${id}/cash-mandate`, { method: 'PUT', body: JSON.stringify(body) }),
  runFlow: (id: number, force = false, llmId?: string) =>
    j<FlowResponse>(`/api/tasks/${id}/flow`, { method: 'POST', body: JSON.stringify({ force, llmId }) }),
  /** M4：任务级 LLM 批量分类（force=连 LLM 已分的也重分，人工改判不动） */
  categorizeTask: (id: number, force = false) =>
    j<ClassifyOutcome>(`/api/tasks/${id}/categorize`, { method: 'POST', body: JSON.stringify({ force }) }),
  deleteTask: (id: number) => j<{ ok: boolean }>(`/api/tasks/${id}`, { method: 'DELETE' }),
  refreshTask: (id: number) => j<RefreshResult>(`/api/tasks/${id}/refresh`, { method: 'POST' }),
  openTaskFolder: (id: number) => j<{ ok: boolean }>(`/api/tasks/${id}/open`, { method: 'POST' }),
  listTasks: () => j<TaskListItem[]>('/api/tasks'),
  recentTasks: () => j<TaskBrief[]>('/api/tasks/recent'),

  /* ---------- 解析 / 交易浏览器（M2） ---------- */
  filePages: (id: number) => j<FilePages>(`/api/files/${id}/pages`),
  parseFile: (id: number, fresh = false, llmId?: string, pages?: number[]) =>
    j<{ ok: boolean; queued: boolean; paused?: boolean; resumed?: boolean; resumePage?: number }>(
      `/api/files/${id}/parse`,
      { method: 'POST', body: JSON.stringify({ fresh, llmId, pages }) },
    ),
  parseTask: (taskId: number, llmId?: string) =>
    j<{ ok: boolean; added: number; queued: number; paused?: boolean; resumed?: number }>(
      `/api/files/task/${taskId}/parse`,
      { method: 'POST', body: JSON.stringify({ llmId }) },
    ),
  pauseTaskParse: (taskId: number) =>
    j<{ ok: boolean; files: number; paused: boolean }>(`/api/files/task/${taskId}/pause`, { method: 'POST' }),
  resumeTaskParse: (taskId: number) =>
    j<{ ok: boolean; files: number; paused: boolean }>(`/api/files/task/${taskId}/resume`, { method: 'POST' }),
  stopTaskParse: (taskId: number) =>
    j<{ ok: boolean; files: number; paused: boolean }>(`/api/files/task/${taskId}/stop`, { method: 'POST' }),
  deleteFile: (id: number) => j<{ ok: boolean }>(`/api/files/${id}`, { method: 'DELETE' }),
  /** 把这份流水归到某个已登记募资专户。只改文件上的银行、账号、户名 */
  assignFileAccount: (id: number, body: { bank: string; accountNo: string; accountName: string }) =>
    j<{ ok: boolean }>(`/api/files/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  /** 在某一笔后面人工补一行。按印刷位置插入，保存后整份重算余额 */
  addTransaction: (
    fileId: number,
    body: {
      afterId: number;
      date: string;
      summary: string;
      amount: number;
      direction: 'in' | 'out';
      balance: number | null;
      counterparty: string;
      counterpartyAccount: string;
      channel: string;
      category: string | null;
    },
  ) =>
    j<{
      row: TxRow;
      reviewCount: number;
      balance: { selfGap: string | null; nextGap: string | null; hasNext: boolean };
    }>(`/api/files/${fileId}/transactions`, { method: 'POST', body: JSON.stringify(body) }),
  listTransactions: (q: TxQuery) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v));
    return j<TxPageResult>(`/api/transactions?${p.toString()}`);
  },
  txOptions: (q: TxQuery = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) {
      if (k === 'page' || k === 'pageSize' || k === 'sort') continue;
      if (v !== undefined && v !== '') p.set(k, String(v));
    }
    const s = p.toString();
    return j<TxOptions>(`/api/transactions/options${s ? `?${s}` : ''}`);
  },
  reviewQueue: (taskId?: number) =>
    j<{ rows: TxRow[]; total: number }>(`/api/transactions/review${taskId ? `?taskId=${taskId}` : ''}`),
  patchTransaction: (
    id: number,
    body: {
      date?: string;
      summary?: string;
      amount: number;
      direction: 'in' | 'out';
      balance?: number | null;
      counterparty?: string;
      counterpartyAccount?: string;
      channel?: string;
      /** M4 改判：显式传 null=清除 */
      category?: string | null;
    },
  ) =>
    j<{
      row: TxRow;
      reviewCount: number;
      balance?: { selfGap: string | null; nextGap: string | null; hasNext: boolean };
    }>(`/api/transactions/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  setWatch: (id: number, marked: boolean) =>
    j<{ watched: boolean }>(`/api/watch/${id}/mark`, { method: 'POST', body: JSON.stringify({ marked }) }),
  watchList: (taskId?: number) =>
    j<{ items: WatchItem[]; total: number }>(`/api/watch${taskId ? `?taskId=${taskId}` : ''}`),
  watchNote: (id: number, text: string) =>
    j<{ ok: boolean }>(`/api/watch/${id}/note`, { method: 'POST', body: JSON.stringify({ text }) }),
  watchVerdict: (id: number, verdict: string) =>
    j<{ ok: boolean; verdict: string }>(`/api/watch/${id}/verdict`, { method: 'POST', body: JSON.stringify({ verdict }) }),
  /** M4：分析页按线路批量改判（写交易级 category） */
  bulkCategory: (ids: number[], category: string | null) =>
    j<{ updated: number }>(`/api/transactions/bulk-category`, {
      method: 'POST',
      body: JSON.stringify({ ids, category }),
    }),
  /** 对照页批量改日期：服务端统一收成 YYYY-MM-DD，并清掉日期相关复核提示 */
  bulkDate: (ids: number[], date: string) =>
    j<{ updated: number; date: string }>(`/api/transactions/bulk-date`, {
      method: 'POST',
      body: JSON.stringify({ ids, date }),
    }),
  /* ---------- 分类集（M4，§3.3 设置页管理） ---------- */
  getCategories: () => j<{ categories: string[]; defs: Record<string, string> }>('/api/categories'),
  putCategories: (categories: string[]) =>
    j<{ categories: string[] }>(`/api/categories`, { method: 'PUT', body: JSON.stringify({ categories }) }),
};

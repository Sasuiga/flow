import {
  BankFile,
  Client,
  ClientBrief,
  ClientView,
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
} from '@flow/shared';

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
}

export interface TaskDetail {
  task: TaskView;
  project: ProjectBrief;
  client: ClientBrief;
  files: BankFile[];
}

export interface RefreshResult {
  ok: boolean;
  added: number;
}

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

  /* ---------- 任务 ---------- */
  getTask: (id: number) => j<TaskDetail>(`/api/tasks/${id}`),
  deleteTask: (id: number) => j<{ ok: boolean }>(`/api/tasks/${id}`, { method: 'DELETE' }),
  refreshTask: (id: number) => j<RefreshResult>(`/api/tasks/${id}/refresh`, { method: 'POST' }),
  openTaskFolder: (id: number) => j<{ ok: boolean }>(`/api/tasks/${id}/open`, { method: 'POST' }),
  listTasks: () => j<TaskListItem[]>('/api/tasks'),
  recentTasks: () => j<TaskBrief[]>('/api/tasks/recent'),

  /* ---------- 解析 / 交易浏览器（M2） ---------- */
  parseFile: (id: number) => j<{ ok: boolean; queued: boolean }>(`/api/files/${id}/parse`, { method: 'POST' }),
  parseTask: (taskId: number) =>
    j<{ ok: boolean; added: number; queued: number }>(`/api/files/task/${taskId}/parse`, { method: 'POST' }),
  deleteFile: (id: number) => j<{ ok: boolean }>(`/api/files/${id}`, { method: 'DELETE' }),
  listTransactions: (q: TxQuery) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v));
    return j<TxPageResult>(`/api/transactions?${p.toString()}`);
  },
  txOptions: () => j<TxOptions>('/api/transactions/options'),
  reviewQueue: (taskId?: number) =>
    j<{ rows: TxRow[]; total: number }>(`/api/transactions/review${taskId ? `?taskId=${taskId}` : ''}`),
  patchTransaction: (
    id: number,
    body: { date?: string; summary?: string; amount: number; direction: 'in' | 'out'; balance?: number | null; counterparty?: string },
  ) =>
    j<{ row: TxRow; reviewCount: number }>(`/api/transactions/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
};

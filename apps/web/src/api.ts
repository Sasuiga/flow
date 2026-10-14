import { BankFile, ProbeResult, Project, Settings } from '@flow/shared';

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

export interface ProjectView extends Project {
  fileCount: number;
  txCount: number;
}

export const api = {
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
  listProjects: () => j<ProjectView[]>('/api/projects'),
  createProject: (name: string, folderPath: string) =>
    j<ProjectView & { added: number }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name, folderPath }),
    }),
  refreshProject: (id: number) =>
    j<{ ok: boolean; added: number }>(`/api/projects/${id}/refresh`, { method: 'POST' }),
  deleteProject: (id: number) => j<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),
  listFiles: (id: number) => j<BankFile[]>(`/api/projects/${id}/files`),
};

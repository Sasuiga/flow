import { ProbeResult } from '@flow/shared';

const strip = (u: string) => u.replace(/\/+$/, '');

/** 解析 "Name: value" 形式的自定义请求头；空/非法返回 undefined */
export function parseExtraHeader(v: string): Record<string, string> | undefined {
  const m = (v ?? '').trim().match(/^([A-Za-z0-9-]+)\s*:\s*(.+)$/);
  if (!m) return undefined;
  return { [m[1].trim()]: m[2].trim() };
}

/** 探测 vLLM（OpenAI 兼容）：GET {base}/models */
export async function probeLLM(base: string, model: string, extraHeader?: string): Promise<ProbeResult> {
  try {
    const res = await fetch(strip(base) + '/models', {
      headers: parseExtraHeader(extraHeader ?? ''),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}（${strip(base)}/models）` };
    const data = (await res.json()) as { data?: { id: string }[] };
    const ids = (data.data ?? []).map((m) => m.id);
    if (ids.length === 0) return { ok: true, detail: `端点可达（${strip(base)}），但未返回模型列表` };
    if (model && !ids.includes(model))
      return { ok: true, detail: `端点可达，但模型 "${model}" 不在列表中。当前可用：${ids.join(', ')}` };
    return { ok: true, detail: `端点可达，模型 ${model || ids[0]}` };
  } catch (e) {
    return { ok: false, detail: `连接失败：${(e as Error).message}` };
  }
}

/** 探测 PP-OCRv6：GET {base}/health */
export async function probeOCR(base: string, extraHeader?: string): Promise<ProbeResult> {
  try {
    const res = await fetch(strip(base) + '/health', {
      headers: parseExtraHeader(extraHeader ?? ''),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}（${strip(base)}/health）` };
    const d = (await res.json()) as { status?: string; model?: string };
    return { ok: true, detail: `ready${d.model ? `：${d.model}` : ''}` };
  } catch (e) {
    return { ok: false, detail: `连接失败：${(e as Error).message}` };
  }
}

/** 拉取 LLM 可用模型列表：GET {base}/models */
export async function fetchLLMModels(base: string, extraHeader?: string): Promise<ProbeResult & { models: string[] }> {
  try {
    const res = await fetch(strip(base) + '/models', {
      headers: parseExtraHeader(extraHeader ?? ''),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { ok: false, models: [], detail: `HTTP ${res.status}（${strip(base)}/models）` };
    const data = (await res.json()) as { data?: { id: string }[] };
    const models = (data.data ?? []).map((m) => m.id);
    if (models.length === 0) return { ok: true, models, detail: '端点可达，但未返回模型列表' };
    return { ok: true, models, detail: `共 ${models.length} 个模型` };
  } catch (e) {
    return { ok: false, models: [], detail: `连接失败：${(e as Error).message}` };
  }
}

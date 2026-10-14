import { ProbeResult } from '@flow/shared';

const strip = (u: string) => u.replace(/\/+$/, '');

/** 探测 vLLM（OpenAI 兼容）：GET {base}/models */
export async function probeLLM(base: string, model: string): Promise<ProbeResult> {
  try {
    const res = await fetch(strip(base) + '/models', { signal: AbortSignal.timeout(8000) });
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
export async function probeOCR(base: string): Promise<ProbeResult> {
  try {
    const res = await fetch(strip(base) + '/health', { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}（${strip(base)}/health）` };
    const d = (await res.json()) as { status?: string; model?: string };
    return { ok: true, detail: `ready${d.model ? `：${d.model}` : ''}` };
  } catch (e) {
    return { ok: false, detail: `连接失败：${(e as Error).message}` };
  }
}

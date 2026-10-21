import { ProbeResult } from '@flow/shared';

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

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

/**
 * OpenAI 兼容 chat/completions（解析管线用，M2）。
 * 流式接收（非流式会缓冲到生成完才回包，推理较慢时可能超过 undici 300s headers 超时）。
 * 返回 content 文本（reasoning 不计入）；调用方自行解析 JSON（extractJson 容错）。
 */
export async function llmChat(
  base: string,
  model: string,
  extraHeader: string | undefined,
  system: string,
  user: string,
  opts: { jsonMode?: boolean; maxTokens?: number; timeoutMs?: number; images?: Buffer[]; signal?: AbortSignal } = {},
): Promise<string> {
  const userContent =
    opts.images && opts.images.length > 0
      ? [
          { type: 'text', text: user },
          ...opts.images.map((img) => ({
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${img.toString('base64')}` },
          })),
        ]
      : user;
  const body: Record<string, unknown> = {
    model,
    temperature: 0,
    stream: true,
    messages: [{ role: 'system', content: system }, { role: 'user', content: userContent }],
    // Qwen3 系 thinking 模型：结构化提取任务关思考，省 token 且快（不支持的模型会忽略）
    chat_template_kwargs: { enable_thinking: false },
  };
  if (opts.jsonMode) body.response_format = { type: 'json_object' };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 900_000);
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
  let res: Response;
  try {
    res = await fetch(strip(base) + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...parseExtraHeader(extraHeader ?? '') },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    const err = e as Error & { cause?: { code?: string; message?: string } };
    const cause = err.cause?.code || err.cause?.message;
    throw new Error(`LLM 端点不可达（${strip(base)}）：${err.message}${cause ? `（${cause}）` : ''}`);
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`LLM HTTP ${res.status}${text ? `：${text}` : ''}`);
  }
  if (!res.body) throw new Error('LLM 响应无 body');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const j = JSON.parse(data) as { choices?: { delta?: { content?: string; reasoning?: string } }[] };
        const delta = j.choices?.[0]?.delta;
        if (delta?.content) content += delta.content;
      } catch {
        /* 半行 JSON，忽略 */
      }
    }
  }
  if (content.trim().length === 0) throw new Error('LLM 返回为空（模型名是否有效？或纯思考模式未输出）');
  return content;
}

/** 从 LLM 输出里提取 JSON 对象：去代码块/前后杂讯，取第一个完整 {…} */
export function extractJson<T>(text: string): T {
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`LLM 输出中未找到 JSON：${s.slice(0, 80)}…`);
  return JSON.parse(s.slice(start, end + 1)) as T;
}

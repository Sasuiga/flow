/**
 * PP-OCR 适配器。
 *
 * 端点只有整页文字框（没有表格结构），所以这里只负责把图片送过去、
 * 把 {text, confidence, box} 转成带包围盒的文字块；分栏、成行、拆合并单元格
 * 全在 table.ts 里按几何和业务约束做。
 */
import { parseExtraHeader } from './ai.js';

export interface OcrBox {
  text: string;
  confidence: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  cx: number;
  cy: number;
  h: number;
}

interface RawResult {
  text?: unknown;
  confidence?: unknown;
  box?: unknown;
}

interface RawResponse {
  results?: RawResult[];
}

export interface OcrConfig {
  ocrBase: string;
  ocrExtraHeader?: string;
}

const strip = (u: string) => u.replace(/\/+$/, '');

/** 校验并规整 OCR 返回的四边形。坐标缺失或退化就丢掉该块。 */
function toBox(r: RawResult): OcrBox | null {
  const text = typeof r.text === 'string' ? r.text.trim() : '';
  if (!text) return null;
  const box = r.box;
  if (!Array.isArray(box) || box.length < 2) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of box) {
    if (!Array.isArray(p) || p.length < 2) return null;
    const x = Number(p[0]);
    const y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    xs.push(x);
    ys.push(y);
  }
  const x1 = Math.min(...xs);
  const x2 = Math.max(...xs);
  const y1 = Math.min(...ys);
  const y2 = Math.max(...ys);
  if (x2 <= x1 || y2 <= y1) return null;
  const conf = Number(r.confidence);
  return {
    text,
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 1,
    x1,
    y1,
    x2,
    y2,
    cx: (x1 + x2) / 2,
    cy: (y1 + y2) / 2,
    h: y2 - y1,
  };
}

/** 整页 OCR。端点不可达时抛错，由调用方决定是否退回视觉模型。 */
export async function ocrPage(cfg: OcrConfig, jpeg: Buffer, signal?: AbortSignal): Promise<OcrBox[]> {
  const base = strip(cfg.ocrBase || '');
  if (!base) throw new Error('未配置 OCR 端点');
  const timeout = AbortSignal.timeout(120_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(`${base}/ocr/raw`, {
      method: 'POST',
      headers: { 'content-type': 'image/jpeg', ...(parseExtraHeader(cfg.ocrExtraHeader ?? '') ?? {}) },
      body: new Uint8Array(jpeg),
      signal: combined,
    });
  } catch (e) {
    throw new Error(`OCR 端点不可达（${base}）：${(e as Error).message}`);
  }
  if (!res.ok) throw new Error(`OCR 返回 HTTP ${res.status}（${base}）`);
  let json: RawResponse;
  try {
    json = (await res.json()) as RawResponse;
  } catch {
    throw new Error('OCR 返回的不是 JSON');
  }
  const results = Array.isArray(json.results) ? json.results : [];
  const boxes: OcrBox[] = [];
  for (const r of results) {
    const b = toBox(r);
    if (b) boxes.push(b);
  }
  // 空白页（只有印章/页码，甚至什么都没有）返回空数组，由表格通道按 0 笔处理
  return boxes;
}

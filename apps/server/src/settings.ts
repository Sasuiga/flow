import { db } from './db.js';
import { DEFAULT_SETTINGS, LlmProfile, Settings } from '@flow/shared';

function asProfile(raw: unknown): LlmProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = String(r.id ?? '').trim();
  const base = String(r.base ?? '').trim();
  if (!id || !base) return null;
  const model = String(r.model ?? '').trim();
  return {
    id,
    name: String(r.name ?? '').trim() || model || '未命名模型',
    base,
    model,
    extraHeader: String(r.extraHeader ?? ''),
  };
}

/** 没有登记过模型时，用原来的单端点字段补一套，避免升级后设置页是空的。 */
function ensureProfiles(s: Settings): void {
  const cleaned = (s.llmProfiles ?? []).map(asProfile).filter((p): p is LlmProfile => !!p);
  if (cleaned.length === 0) {
    const id = 'llm-default';
    s.llmProfiles = [
      {
        id,
        name: s.llmModel || '默认模型',
        base: s.llmBase,
        model: s.llmModel,
        extraHeader: s.llmExtraHeader ?? '',
      },
    ];
    s.defaultLlmId = id;
  } else {
    s.llmProfiles = cleaned;
    if (!s.llmProfiles.some((p) => p.id === s.defaultLlmId)) s.defaultLlmId = s.llmProfiles[0].id;
  }
  const def = s.llmProfiles.find((p) => p.id === s.defaultLlmId) ?? s.llmProfiles[0];
  s.llmBase = def.base;
  s.llmModel = def.model;
  s.llmExtraHeader = def.extraHeader;
}

export function getSettings(): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS, llmProfiles: [] };
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  for (const r of rows) {
    if (r.key === 'llmConcurrency') s.llmConcurrency = Number(r.value) || s.llmConcurrency;
    else if (r.key === 'autoCategorize') s.autoCategorize = r.value === '1' || r.value === 'true';
    else if (r.key === 'llmProfiles') {
      try {
        const parsed = JSON.parse(r.value) as unknown;
        if (Array.isArray(parsed)) s.llmProfiles = parsed.map(asProfile).filter((p): p is LlmProfile => !!p);
      } catch {
        s.llmProfiles = [];
      }
    } else if (r.key === 'llmExtraHeader' || r.key === 'ocrExtraHeader' || r.key === 'defaultLlmId')
      (s as unknown as Record<string, unknown>)[r.key] = r.value;
    else (s as unknown as Record<string, unknown>)[r.key] = r.value;
  }
  ensureProfiles(s);
  return s;
}

/** 按 id 取模型。没传 id 时用默认。id 对不上返回 undefined。 */
export function llmProfileById(id?: string): LlmProfile | undefined {
  const s = getSettings();
  if (id) return s.llmProfiles.find((p) => p.id === id);
  return s.llmProfiles.find((p) => p.id === s.defaultLlmId) ?? s.llmProfiles[0];
}

export function saveSettings(input: Settings): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS, ...input, llmProfiles: input.llmProfiles ?? [] };
  ensureProfiles(s);
  const up = db.prepare(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  const tx = db.transaction(() => {
    up.run('llmProfiles', JSON.stringify(s.llmProfiles));
    up.run('defaultLlmId', s.defaultLlmId);
    up.run('llmBase', s.llmBase);
    up.run('llmModel', s.llmModel);
    up.run('llmExtraHeader', s.llmExtraHeader ?? '');
    up.run('ocrBase', s.ocrBase || null);
    up.run('ocrExtraHeader', s.ocrExtraHeader ?? '');
    up.run('llmConcurrency', String(s.llmConcurrency));
    up.run('autoCategorize', s.autoCategorize ? '1' : '0');
  });
  tx();
  return s;
}

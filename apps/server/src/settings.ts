import { db } from './db.js';
import { DEFAULT_SETTINGS, Settings } from '@flow/shared';

export function getSettings(): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS };
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  for (const r of rows) {
    if (r.key === 'llmConcurrency') s.llmConcurrency = Number(r.value) || s.llmConcurrency;
    else (s as Record<string, unknown>)[r.key] = r.value;
  }
  return s;
}

export function saveSettings(s: Settings): Settings {
  const up = db.prepare(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  const tx = db.transaction(() => {
    up.run('llmBase', s.llmBase);
    up.run('llmModel', s.llmModel);
    up.run('ocrBase', s.ocrBase);
    up.run('llmConcurrency', String(s.llmConcurrency));
  });
  tx();
  return s;
}

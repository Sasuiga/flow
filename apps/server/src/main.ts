import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getSettings, saveSettings } from './settings.js';
import { probeLLM, probeOCR } from './ai.js';
import { projectsRouter } from './projects.js';
import { Settings } from '@flow/shared';

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) =>
  res.json({ ok: true, name: 'flow-server', version: '0.1.0' }),
);

app.get('/api/settings', (_req, res) => res.json(getSettings()));
app.put('/api/settings', (req, res) => res.json(saveSettings(req.body as Settings)));
app.post('/api/ai/probe', async (req, res) => {
  const body = req.body as Partial<Settings> | undefined;
  const s = body && Object.keys(body).length ? { ...getSettings(), ...body } : getSettings();
  const [llm, ocr] = await Promise.all([
    probeLLM(s.llmBase, s.llmModel, s.llmExtraHeader),
    probeOCR(s.ocrBase, s.ocrExtraHeader),
  ]);
  res.json({ llm, ocr });
});

app.use('/api/projects', projectsRouter);

/* Web 静态资源（vite build 产物），SPA 回退 */
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
} else {
  app.get('/', (_req, res) =>
    res.send('flow-server running. Web dist not built (dev mode: use vite on :5173)'),
  );
}

const port = Number(process.env.PORT || 4120);
app.listen(port, () => {
  console.log(`[flow] http://localhost:${port}  (web dist: ${existsSync(dist) ? '已加载' : '未构建，dev 模式请用 vite :5173'})`);
});

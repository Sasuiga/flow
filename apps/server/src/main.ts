import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getSettings, saveSettings } from './settings.js';
import { probeLLM, probeOCR, fetchLLMModels } from './ai.js';
import { clientsRouter } from './clients.js';
import { projectsRouter, tasksRouter } from './projects.js';
import { fsRouter } from './fs.js';
import { transactionsRouter, filesRouter, taskListRouter } from './tx.js';
import { categoriesRouter, categorizeTasksRouter } from './categorize.js';
import { initWatchers } from './watch.js';
import { autoParsePending, parseQueue } from './parse.js';
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

/** 单项探测：LLM（带当前表单值，不依赖已保存设置） */
app.post('/api/ai/probe-llm', async (req, res) => {
  const s = getSettings();
  const b = (req.body ?? {}) as Partial<Settings>;
  const r = await probeLLM(b.llmBase || s.llmBase, (b.llmModel ?? '') || s.llmModel, b.llmExtraHeader ?? s.llmExtraHeader);
  res.json(r);
});

/** 单项探测：OCR */
app.post('/api/ai/probe-ocr', async (req, res) => {
  const s = getSettings();
  const b = (req.body ?? {}) as Partial<Settings>;
  const r = await probeOCR(b.ocrBase || s.ocrBase, b.ocrExtraHeader ?? s.ocrExtraHeader);
  res.json(r);
});

/** 拉取 LLM 可用模型列表（填模型名用） */
app.post('/api/llm/models', async (req, res) => {
  const s = getSettings();
  const b = (req.body ?? {}) as Partial<Settings>;
  res.json(await fetchLLMModels(b.llmBase || s.llmBase, b.llmExtraHeader ?? s.llmExtraHeader));
});

app.use('/api/projects', projectsRouter);
// 任务列表/最近任务 先于 /api/tasks/:id 注册，避免 'recent' 被当 id
app.use('/api/tasks', taskListRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/tasks', categorizeTasksRouter); // M4：POST /:id/categorize
app.use('/api/clients', clientsRouter);
app.use('/api/fs', fsRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/categories', categoriesRouter); // M4：分类集管理
app.use('/api/files', filesRouter);

/* Web 静态资源：兼容仓库布局（dev/dist）与 zip 绿色包布局 */
const distCandidates = [
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist'), // 仓库: apps/server/dist → apps/web/dist
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'web'), // zip: root/main.js → root/web
  path.resolve(process.cwd(), 'web'),
  path.resolve(process.cwd(), 'dist'),
];
const dist = distCandidates.find((p) => existsSync(p)) ?? null;
if (dist) {
  app.use(express.static(dist));
  app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
} else {
  app.get('/', (_req, res) =>
    res.send('flow-server running. Web dist not built (dev mode: use vite on :5173)'),
  );
}

const port = Number(process.env.PORT || 4120);
app.listen(port, () => {
  console.log(`[flow] http://localhost:${port}  (web dist: ${existsSync(dist ?? '') ? '已加载' : '未构建，dev 模式请用 vite :5173'})`);
  // M2：任务目录监听 + 解析队列（新 PDF 自动登记并解析；启动时补扫+自愈）
  void initWatchers().then(() => {
    autoParsePending(); // 复位被打断的 parsing + 开跑未解析文件
    parseQueue.start();
    console.log('[flow] 任务目录监听与解析队列已启动');
  });
});

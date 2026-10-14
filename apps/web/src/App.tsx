import { useEffect, useState } from 'react';
import { AppChrome, type FlowView } from './components/AppChrome';
import { HomePage } from './pages/Home';
import { ClientPage } from './pages/ClientPage';
import { ProjectPage } from './pages/ProjectPage';
import { TaskPage } from './pages/TaskPage';
import Placeholder from './pages/Placeholder';
import SettingsPage from './pages/Settings';
import TransactionsPage from './pages/Transactions';
import { api } from './api';
import { TaskBrief } from '@flow/shared';

type View =
  | { k: 'home' }
  | { k: 'client'; id: number }
  | { k: 'project'; id: number }
  | { k: 'task'; id: number }
  | { k: 'tx'; taskId?: number; fileId?: number }
  | { k: 'review' }
  | { k: 'rules' }
  | { k: 'settings' };

/**
 * 骨架：Avalon AppChrome 顶栏 + 客户→项目→任务 下钻 + 交易浏览器（M2）。
 * 「当前任务」上下文切换器：顶栏 ctx-tab，选中任务后「交易」页默认过滤到该任务。
 */
export default function App() {
  const [view, setView] = useState<View>(() => {
    // 深链：#/client/1 /#/project/1 /#/task/1 /#/tx?task=1&file=2（刷新/分享保持位置）
    const m = location.hash.match(/^#\/(client|project|task)\/(\d+)(?:\?(.*))?$/);
    if (m) {
      const qs = m[3] ? new URLSearchParams(m[3]) : null;
      if (m[1] === 'task' && qs?.get('tx')) return { k: 'tx', taskId: Number(qs.get('task')) || undefined, fileId: Number(qs.get('file')) || undefined };
      return { k: m[1] as 'client' | 'project' | 'task', id: Number(m[2]) };
    }
    return { k: 'home' };
  });
  // 「当前任务」上下文（顶栏切换器）
  const [ctxTask, setCtxTask] = useState<TaskBrief | null>(null);
  const [recentTasks, setRecentTasks] = useState<TaskBrief[]>([]);

  const chromeActive: FlowView =
    view.k === 'tx' || view.k === 'review' || view.k === 'rules' || view.k === 'settings' ? view.k : 'home';

  const nav = (v: FlowView) => {
    location.hash = '';
    if (v === 'settings') setView({ k: 'settings' });
    else if (v === 'tx') setView({ k: 'tx', taskId: ctxTask?.id });
    else if (v === 'review') setView({ k: 'review' });
    else if (v === 'rules') setView({ k: 'rules' });
    else setView({ k: 'home' });
  };

  /** 上下文切换器选中任务 → 交易页过滤到该任务 */
  const pickTask = (id: number | null) => {
    const brief = id == null ? null : recentTasks.find((t) => t.id === id) ?? null;
    setCtxTask(brief);
    setView({ k: 'tx', taskId: id ?? undefined });
  };

  /** 任务页「查看交易」：进入交易页并设为当前任务上下文 */
  const browseTaskTx = (taskId: number) => {
    const brief = recentTasks.find((t) => t.id === taskId);
    if (brief) setCtxTask(brief);
    setView({ k: 'tx', taskId });
    void api.recentTasks().then(setRecentTasks).catch(() => undefined);
  };

  // 同步 hash 便于刷新/分享定位
  const syncHash = (v: View) => {
    if (v.k === 'client' || v.k === 'project' || v.k === 'task') location.hash = `/${v.k}/${v.id}`;
    else if (v.k === 'tx' && (v.taskId || v.fileId)) {
      const qs = new URLSearchParams();
      if (v.taskId) qs.set('task', String(v.taskId));
      if (v.fileId) qs.set('file', String(v.fileId));
      location.hash = `/tx?${qs.toString()}`;
    }
  };
  useEffect(() => {
    syncHash(view);
  }, [view]);

  // 最近任务（顶栏切换器；启动 + 新建任务后可刷新）
  useEffect(() => {
    void api.recentTasks().then(setRecentTasks).catch(() => undefined);
  }, []);

  return (
    <div className="flow-root">
      <AppChrome
        active={chromeActive}
        onNav={nav}
        contextTask={ctxTask}
        recentTasks={recentTasks}
        onPickTask={pickTask}
      />
      <main className="page-main">
        {view.k === 'home' && <HomePage onOpenClient={(id) => setView({ k: 'client', id })} />}
        {view.k === 'client' && (
          <ClientPage
            clientId={view.id}
            onBack={() => setView({ k: 'home' })}
            onOpenProject={(id) => setView({ k: 'project', id })}
          />
        )}
        {view.k === 'project' && (
          <ProjectPage
            projectId={view.id}
            onBackToClient={(clientId) => setView({ k: 'client', id: clientId })}
            onOpenTask={(id) => setView({ k: 'task', id })}
          />
        )}
        {view.k === 'task' && (
          <TaskPage
            taskId={view.id}
            onBackToProject={(projectId) => setView({ k: 'project', id: projectId })}
            onBrowseTx={(taskId) => browseTaskTx(taskId)}
            onBrowseFileTx={(taskId, fileId) => setView({ k: 'tx', taskId, fileId })}
            onChangedTasks={() => void api.recentTasks().then(setRecentTasks).catch(() => undefined)}
          />
        )}
        {view.k === 'tx' && (
          <TransactionsPage key={view.taskId ?? 'all'} initialTaskId={view.taskId} initialFileId={view.fileId} />
        )}
        {view.k === 'review' && (
          <Placeholder
            name="修正队列"
            note="余额连续性校验失败/低置信行集中修正：左侧原始页文本或页图，右侧可编辑字段，保存后自动复算。"
            milestone="M3 交付"
          />
        )}
        {view.k === 'rules' && (
          <Placeholder
            name="规则"
            note="内置规则开关与参数（v1：R3 大额整额 / R4 非工作时段 / R5 快进快出）；命中明细与「确认/误报」标记。关联方/专户最高危规则（R1/R2）随主体登记 v1.1 启用。"
            milestone="M5 交付"
          />
        )}
        {view.k === 'settings' && (
          <div className="page" style={{ maxWidth: 1100 }}>
            <SettingsPage />
          </div>
        )}
      </main>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { AppChrome, type FlowView } from './components/AppChrome';
import { HomePage } from './pages/Home';
import { ClientPage } from './pages/ClientPage';
import { ProjectPage } from './pages/ProjectPage';
import { TaskPage } from './pages/TaskPage';
import Placeholder from './pages/Placeholder';
import SettingsPage from './pages/Settings';
import TransactionsPage from './pages/Transactions';
import ReviewQueue from './pages/ReviewQueue';
import WatchPage from './pages/WatchPage';
import AnalysisPage from './pages/AnalysisPage';
import { api } from './api';
import { TaskBrief } from '@flow/shared';

type View =
  | { k: 'home' }
  | { k: 'client'; id: number }
  | { k: 'project'; id: number }
  | { k: 'task'; id: number }
  | { k: 'tx'; taskId?: number; bank?: string; accountNo?: string }
  | { k: 'flow' }
  | { k: 'review' }
  | { k: 'watch' }
  | { k: 'rules' }
  | { k: 'settings' };

/**
 * 骨架：Avalon AppChrome 顶栏 + 客户→项目→任务 下钻 + 交易浏览器（M2）。
 * 「当前任务」上下文切换器：顶栏 ctx-tab，选中任务后「交易」页默认过滤到该任务。
 */
export default function App() {
  const [view, setView] = useState<View>(() => {
    // 深链：#/client/1 /#/project/1 /#/task/1 /#/tx?task=1&file=2（刷新/分享保持位置）
    if (location.hash === '#/flow') return { k: 'flow' };
    if (location.hash === '#/watch') return { k: 'watch' };
    const tx = location.hash.match(/^#\/tx(?:\?(.*))?$/);
    if (tx) {
      const qs = new URLSearchParams(tx[1] ?? '');
      return {
        k: 'tx',
        taskId: qs.get('task') ? Number(qs.get('task')) : undefined,
        bank: qs.get('bank') || undefined,
        accountNo: qs.get('account') || undefined,
      };
    }
    const m = location.hash.match(/^#\/(client|project|task)\/(\d+)(?:\?(.*))?$/);
    if (m) {
      const qs = m[3] ? new URLSearchParams(m[3]) : null;
      if (m[1] === 'task' && qs?.get('tx')) {
        return {
          k: 'tx',
          taskId: Number(m[2]),
          bank: qs.get('bank') || undefined,
          accountNo: qs.get('account') || undefined,
        };
      }
      return { k: m[1] as 'client' | 'project' | 'task', id: Number(m[2]) };
    }
    return { k: 'home' };
  });
  // 「当前任务」上下文（顶栏切换器）
  const [ctxTask, setCtxTask] = useState<TaskBrief | null>(null);
  const [recentTasks, setRecentTasks] = useState<TaskBrief[]>([]);

  const chromeActive: FlowView =
    view.k === 'tx' || view.k === 'flow' || view.k === 'review' || view.k === 'watch' || view.k === 'rules' || view.k === 'settings'
      ? view.k
      : 'home';

  const nav = (v: FlowView) => {
    location.hash = '';
    if (v === 'settings') setView({ k: 'settings' });
    else if (v === 'tx') setView({ k: 'tx', taskId: ctxTask?.id });
    else if (v === 'flow') setView({ k: 'flow' });
    else if (v === 'review') setView({ k: 'review' });
    else if (v === 'watch') setView({ k: 'watch' });
    else if (v === 'rules') setView({ k: 'rules' });
    else setView({ k: 'home' });
  };

  /** 顶栏任务名、或菜单里点一个任务：回到该任务页，不留在交易页。 */
  const openTask = (id: number) => {
    const brief = recentTasks.find((t) => t.id === id);
    if (brief) setCtxTask(brief);
    setView({ k: 'task', id });
    void api.recentTasks().then(setRecentTasks).catch(() => undefined);
  };

  const pickTask = (id: number | null) => {
    if (id == null) {
      setCtxTask(null);
      return;
    }
    openTask(id);
  };

  // 同步 hash 便于刷新/分享定位
  const syncHash = (v: View) => {
    if (v.k === 'client' || v.k === 'project' || v.k === 'task') location.hash = `/${v.k}/${v.id}`;
    else if (v.k === 'flow') location.hash = '/flow';
    else if (v.k === 'watch') location.hash = '/watch';
    else if (v.k === 'tx' && (v.taskId || v.bank || v.accountNo)) {
      const qs = new URLSearchParams();
      if (v.taskId) qs.set('task', String(v.taskId));
      if (v.bank) qs.set('bank', v.bank);
      if (v.accountNo) qs.set('account', v.accountNo);
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

  // 打开任务页 / 带任务过滤的交易页时，顶栏跟着显示这个任务。
  // 之前只有点「查看交易」或从菜单点选才会写入，所以进了任务页仍停在「当前任务」。
  useEffect(() => {
    const taskId = view.k === 'task' ? view.id : view.k === 'tx' ? view.taskId : undefined;
    if (taskId == null) return;
    const known = recentTasks.find((t) => t.id === taskId);
    if (known) {
      setCtxTask((cur) => (cur?.id === known.id ? cur : known));
      return;
    }
    let cancelled = false;
    void api
      .getTask(taskId)
      .then((d) => {
        if (cancelled) return;
        setCtxTask({
          id: d.task.id,
          name: d.task.name,
          clientName: d.client.name,
          projectName: d.project.name,
          fileCount: d.task.fileCount,
          txCount: d.task.txCount,
          updatedAt: d.task.updatedAt,
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [view, recentTasks]);

  useEffect(() => {
    const scoped = view.k === 'flow' || view.k === 'tx' || view.k === 'review' || view.k === 'watch';
    if (!scoped || ctxTask || recentTasks.length === 0) return;
    setCtxTask(recentTasks[0]);
  }, [view, ctxTask, recentTasks]);

  const chromeTasks =
    ctxTask && !recentTasks.some((t) => t.id === ctxTask.id) ? [ctxTask, ...recentTasks] : recentTasks;

  return (
    <div className="flow-root">
      <AppChrome
        active={chromeActive}
        onNav={nav}
        contextTask={ctxTask}
        recentTasks={chromeTasks}
        onPickTask={pickTask}
        onOpenTask={(id) => openTask(id)}
        taskTabActive={view.k === 'task'}
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
            onBrowseFile={(file) =>
              setView({
                k: 'tx',
                taskId: view.id,
                bank: file.bank,
                accountNo: file.accountNo,
              })
            }
            onChangedTasks={() => void api.recentTasks().then(setRecentTasks).catch(() => undefined)}
          />
        )}
        {view.k === 'tx' && (
          <TransactionsPage
            key={`${view.taskId ?? ctxTask?.id ?? 'none'}-${view.bank ?? ''}-${view.accountNo ?? ''}`}
            taskId={view.taskId ?? ctxTask?.id}
            initialBank={view.bank}
            initialAccountNo={view.accountNo}
          />
        )}
        {view.k === 'flow' && <AnalysisPage task={ctxTask} />}
        {view.k === 'review' && <ReviewQueue taskId={ctxTask?.id} />}
        {view.k === 'watch' && <WatchPage taskId={ctxTask?.id} taskName={ctxTask?.name} />}
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

import { useEffect, useState } from 'react';
import { AppChrome, type FlowView } from './components/AppChrome';
import { HomePage } from './pages/Home';
import { ClientPage } from './pages/ClientPage';
import { ProjectPage } from './pages/ProjectPage';
import { TaskPage } from './pages/TaskPage';
import Placeholder from './pages/Placeholder';
import SettingsPage from './pages/Settings';

type View =
  | { k: 'home' }
  | { k: 'client'; id: number }
  | { k: 'project'; id: number }
  | { k: 'task'; id: number }
  | { k: 'tx' }
  | { k: 'review' }
  | { k: 'rules' }
  | { k: 'settings' };

/**
 * 骨架：Avalon AppChrome 顶栏 + 客户→项目→任务 下钻。
 * 「当前任务」上下文切换器（Avalon 顶栏上下文标签）M2 随任务工作视图加入。
 */
export default function App() {
  const [view, setView] = useState<View>(() => {
    // 深链：#/client/1 /#/project/1 /#/task/1（刷新/分享保持位置）
    const m = location.hash.match(/^#\/(client|project|task)\/(\d+)/);
    if (m) return { k: m[1] as 'client' | 'project' | 'task', id: Number(m[2]) };
    return { k: 'home' };
  });

  const chromeActive: FlowView =
    view.k === 'tx' || view.k === 'review' || view.k === 'rules' || view.k === 'settings' ? view.k : 'home';

  const nav = (v: FlowView) => {
    location.hash = '';
    if (v === 'settings') setView({ k: 'settings' });
    else if (v === 'tx') setView({ k: 'tx' });
    else if (v === 'review') setView({ k: 'review' });
    else if (v === 'rules') setView({ k: 'rules' });
    else setView({ k: 'home' });
  };

  // 同步 hash 便于刷新/分享定位
  const syncHash = (v: View) => {
    if (v.k === 'client' || v.k === 'project' || v.k === 'task') location.hash = `/${v.k}/${v.id}`;
  };
  useEffect(() => {
    syncHash(view);
  }, [view]);

  return (
    <div className="flow-root">
      <AppChrome active={chromeActive} onNav={nav} />
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
          <TaskPage taskId={view.id} onBackToProject={(projectId) => setView({ k: 'project', id: projectId })} />
        )}
        {view.k === 'tx' && (
          <Placeholder
            name="交易浏览器"
            note="跨任务的全量交易表：任务/银行/账户/日期区间/分类/对手方/风险标记多维过滤 + 分页 + 行展开看原始文本；可改判分类、写备注。"
            milestone="M2 交付"
          />
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

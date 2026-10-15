import { ChevronDown, ClipboardCheck, Home, ScrollText, Settings, ShieldCheck, FolderOpen } from 'lucide-react';
import { useRef, useState } from 'react';
import { TaskBrief } from '@flow/shared';

export type FlowView =
  | 'home'
  | 'tx'
  | 'review'
  | 'rules'
  | 'settings';

const TABS: { key: FlowView; label: string; icon: React.ReactNode }[] = [
  { key: 'home', label: '首页', icon: <Home size={13} strokeWidth={2} /> },
  { key: 'tx', label: '交易', icon: <ScrollText size={13} strokeWidth={2} /> },
  { key: 'review', label: '修正', icon: <ClipboardCheck size={13} strokeWidth={2} /> },
  { key: 'rules', label: '规则', icon: <ShieldCheck size={13} strokeWidth={2} /> },
];

type AppChromeProps = {
  active: FlowView;
  onNav: (v: FlowView) => void;
  /** Avalon ChromeContextTab：「当前任务」上下文切换器（M2 随任务工作视图加入） */
  contextTask?: TaskBrief | null;
  recentTasks?: TaskBrief[];
  onPickTask?: (id: number | null) => void;
  /** 点击任务名：回到该任务页 */
  onOpenTask?: (id: number) => void;
  taskTabActive?: boolean;
};

const MENU_WIDTH = 280;
const MARGIN = 8;

export function AppChrome({
  active,
  onNav,
  contextTask,
  recentTasks = [],
  onPickTask,
  onOpenTask,
  taskTabActive,
}: AppChromeProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | undefined>();
  const triggerRef = useRef<HTMLDivElement | null>(null);

  function toggleMenu() {
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const estHeight = (recentTasks.length + 1) * 34 + 16;
    const hasRoomBelow = rect.bottom + estHeight <= window.innerHeight - MARGIN;
    setMenuPos({
      left: Math.min(
        Math.max(MARGIN, rect.left),
        window.innerWidth - MENU_WIDTH - MARGIN,
      ),
      top: hasRoomBelow ? rect.bottom + 4 : Math.max(MARGIN, rect.top - estHeight - 4),
    });
    setMenuOpen(true);
  }

  const pick = (id: number | null) => {
    setMenuOpen(false);
    onPickTask?.(id);
  };

  return (
    <header className="app-chrome">
      <nav className="app-chrome-tabs" aria-label="主导航">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`app-chrome-tab${active === t.key ? ' active' : ''}`}
            onClick={() => onNav(t.key)}
          >
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
        {/* 当前任务上下文切换器（Avalon 上下文标签观感） */}
        <div
          ref={triggerRef}
          className={`app-chrome-tab ctx-tab${contextTask ? '' : ' empty'}${taskTabActive ? ' task-open' : ''}`}
          title={contextTask ? `${contextTask.clientName} / ${contextTask.projectName}` : '从最近任务中选择'}
        >
          <button
            type="button"
            className="ctx-tab-main"
            onClick={() => (contextTask ? onOpenTask?.(contextTask.id) : toggleMenu())}
          >
            <FolderOpen size={13} strokeWidth={2} />
            <span className="ctx-tab-label">{contextTask ? contextTask.name : '当前任务'}</span>
          </button>
          <button type="button" className="ctx-tab-chevron" aria-label="最近任务" onClick={toggleMenu}>
            <ChevronDown size={12} strokeWidth={2} />
          </button>
        </div>
        {menuOpen && menuPos ? (
          <div className="ctx-menu" style={{ left: menuPos.left, top: menuPos.top }} role="menu">
            <div className="ctx-menu-title">最近任务</div>
            {recentTasks.length === 0 ? <div className="ctx-menu-empty">还没有任务</div> : null}
            {recentTasks.map((t) => (
              <button
                key={t.id}
                type="button"
                role="menuitem"
                className={`ctx-menu-item${t.id === contextTask?.id ? ' active' : ''}`}
                onClick={() => pick(t.id)}
              >
                <span className="ctx-menu-name">{t.name}</span>
                <span className="ctx-menu-sub">
                  {t.clientName} / {t.projectName} · {t.txCount} 笔
                </span>
              </button>
            ))}
            {contextTask ? (
              <button type="button" role="menuitem" className="ctx-menu-clear" onClick={() => pick(null)}>
                清除（全部任务）
              </button>
            ) : null}
          </div>
        ) : null}
      </nav>
      <div className="app-chrome-trailing">
        <button
          type="button"
          className="app-chrome-icon-button"
          title="设置"
          aria-label="设置"
          onClick={() => onNav('settings')}
        >
          <Settings size={15} strokeWidth={1.75} />
        </button>
      </div>
    </header>
  );
}

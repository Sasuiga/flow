import { ClipboardCheck, Home, ScrollText, Settings, ShieldCheck } from 'lucide-react';

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
};

/** 顶栏（Avalon AppChrome 骨架：36px、标签 + 设置；「当前任务」上下文切换器 M2 随任务视图加入） */
export function AppChrome({ active, onNav }: AppChromeProps) {
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

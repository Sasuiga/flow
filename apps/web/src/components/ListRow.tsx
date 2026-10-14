import { MoreHorizontal } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';

export type ListRowMenuItem = {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
};

type ListRowProps = {
  active?: boolean;
  disabled?: boolean;
  menuItems?: ListRowMenuItem[];
  onClick?: () => void;
  title?: string;
  children: ReactNode;
};

const MENU_WIDTH = 112;
const MARGIN = 8;

/**
 * Avalon list-row（table 变体）：38px 行、10px 圆角、hover 高亮、行尾 ⋯ 菜单
 * （菜单 fixed 定位 + 视口防溢出，对齐 Avalon ListRow 行为）。
 */
export function ListRow({ active, disabled, menuItems, onClick, title, children }: ListRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | undefined>();
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const hasMenu = Boolean(menuItems?.length);

  function openMenu() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const estHeight = (menuItems?.length ?? 1) * 34 + 10;
    const hasRoomBelow = rect.bottom + 4 + estHeight <= window.innerHeight - MARGIN;
    const top = hasRoomBelow
      ? rect.bottom + 4
      : Math.max(MARGIN, rect.top - estHeight - 4);
    const left = Math.min(
      Math.max(MARGIN, rect.right - MENU_WIDTH),
      window.innerWidth - MENU_WIDTH - MARGIN,
    );
    setMenuPos({ left, top });
    setMenuOpen(true);
  }

  return (
    <div className={`list-row${active ? ' active' : ''}`}>
      <button
        type="button"
        className="list-row-main"
        disabled={disabled || !onClick}
        onClick={onClick}
        title={title}
      >
        {children}
      </button>
      {hasMenu ? (
        <div className="list-row-menu-wrap">
          <button
            ref={triggerRef}
            type="button"
            className="list-row-menu-trigger"
            aria-label="条目操作"
            aria-expanded={menuOpen}
            disabled={disabled}
            onClick={(e) => {
              e.stopPropagation();
              menuOpen ? setMenuOpen(false) : openMenu();
            }}
          >
            <MoreHorizontal size={16} />
          </button>
          {menuOpen && menuPos ? (
            <div className="list-row-menu" style={{ left: menuPos.left, top: menuPos.top }} role="menu">
              {menuItems!.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  className={item.danger ? 'danger' : undefined}
                  disabled={disabled || item.disabled}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(false);
                    item.onClick();
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 列表表头（与 ListRow 内 span 的列类名对齐，保证列对齐；withMenu=行带 ⋯ 菜单时右侧留位） */
export function ListRowHeader({ cols, withMenu = false }: { cols: { label: string; cls: string }[]; withMenu?: boolean }) {
  return (
    <div className={`list-row-table-header${withMenu ? ' with-menu' : ''}`} aria-hidden>
      {cols.map((c) => (
        <span key={c.label} className={c.cls}>
          {c.label}
        </span>
      ))}
    </div>
  );
}

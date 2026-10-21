import { MoreHorizontal } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

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
const MENU_WIDTH_MOBILE = 132;
const MENU_ITEM_HEIGHT = 34;
const MENU_ITEM_HEIGHT_MOBILE = 42;
const MARGIN = 8;

/**
 * Avalon list-row（table 变体）：38px 行、10px 圆角、hover 高亮、行尾 ⋯ 菜单
 * （菜单 fixed 定位 + 视口防溢出，对齐 Avalon ListRow 行为）。
 */
export function ListRow({ active, disabled, menuItems, onClick, title, children }: ListRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | undefined>();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const hasMenu = Boolean(menuItems?.length);

  useEffect(() => {
    if (!menuOpen) return undefined;
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setMenuOpen(false);
      const swallow = (ev: Event) => {
        ev.stopPropagation();
        ev.preventDefault();
        document.removeEventListener('click', swallow, true);
      };
      document.addEventListener('click', swallow, true);
      window.setTimeout(() => document.removeEventListener('click', swallow, true), 0);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [menuOpen]);

  function openMenu() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // 手机端的菜单更高、更宽（触控目标），定位要按同一套尺寸估算
    const narrow = window.matchMedia('(max-width: 640px)').matches;
    const menuWidth = narrow ? MENU_WIDTH_MOBILE : MENU_WIDTH;
    const itemHeight = narrow ? MENU_ITEM_HEIGHT_MOBILE : MENU_ITEM_HEIGHT;
    const estHeight = (menuItems?.length ?? 1) * itemHeight + 10;
    const hasRoomBelow = rect.bottom + 4 + estHeight <= window.innerHeight - MARGIN;
    const top = hasRoomBelow
      ? rect.bottom + 4
      : Math.max(MARGIN, rect.top - estHeight - 4);
    const left = Math.min(
      Math.max(MARGIN, rect.right - menuWidth),
      window.innerWidth - menuWidth - MARGIN,
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
            <div ref={menuRef} className="list-row-menu" style={{ left: menuPos.left, top: menuPos.top }} role="menu">
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

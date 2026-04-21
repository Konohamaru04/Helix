import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent
} from 'react';
import { createPortal } from 'react-dom';

export interface ContextMenuItem {
  key: string;
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  label: string;
  items: ContextMenuItem[];
  onClose: () => void;
}

const VIEWPORT_MARGIN = 8;

export function ContextMenu(props: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: props.x, top: props.y });

  useEffect(() => {
    setPosition({ left: props.x, top: props.y });
  }, [props.x, props.y]);

  useLayoutEffect(() => {
    const menu = menuRef.current;

    if (!menu) {
      return;
    }

    const rect = menu.getBoundingClientRect();
    const nextLeft = Math.max(
      VIEWPORT_MARGIN,
      Math.min(props.x, window.innerWidth - rect.width - VIEWPORT_MARGIN)
    );
    const nextTop = Math.max(
      VIEWPORT_MARGIN,
      Math.min(props.y, window.innerHeight - rect.height - VIEWPORT_MARGIN)
    );

    setPosition((current) =>
      current.left === nextLeft && current.top === nextTop
        ? current
        : { left: nextLeft, top: nextTop }
    );
  }, [props.items.length, props.x, props.y]);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        props.onClose();
      }
    }

    function handleContextMenu(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        props.onClose();
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        props.onClose();
      }
    }

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('contextmenu', handleContextMenu);
    window.addEventListener('resize', props.onClose);
    window.addEventListener('blur', props.onClose);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('contextmenu', handleContextMenu);
      window.removeEventListener('resize', props.onClose);
      window.removeEventListener('blur', props.onClose);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [props]);

  function handleMenuContext(event: ReactMouseEvent<HTMLDivElement>) {
    event.preventDefault();
  }

  return createPortal(
    <div
      ref={menuRef}
      aria-label={props.label}
      className="motion-menu-pop fixed z-40 min-w-44 rounded-2xl border border-white/10 bg-slate-950/95 p-2 shadow-panel backdrop-blur"
      onContextMenu={handleMenuContext}
      role="menu"
      style={{
        left: `${position.left}px`,
        top: `${position.top}px`
      }}
    >
      {props.items.map((item) => (
        <button
          aria-disabled={item.disabled ? true : undefined}
          className={`motion-interactive flex w-full items-center rounded-xl px-3 py-2 text-left text-sm transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
            item.danger
              ? 'text-rose-200 hover:bg-rose-500/10 focus-visible:outline-rose-400'
              : 'text-slate-100 hover:bg-white/5 focus-visible:outline-cyan-400'
          } disabled:cursor-not-allowed disabled:opacity-50`}
          disabled={item.disabled}
          key={item.key}
          onClick={() => {
            item.onSelect();
            props.onClose();
          }}
          role="menuitem"
          type="button"
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body
  );
}

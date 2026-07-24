import { useEffect, useLayoutEffect, useRef, useState } from "react";

// A bare right-click menu: fixed-positioned at a screen point, clamped into the
// viewport, and self-closing on outside-click / Escape / scroll / resize / blur.
// Pure presentation — the owner supplies the entries and does the work.

export interface MenuItem {
  label: string;
  icon?: string; // phosphor class, e.g. "ph-trash"
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}
export type MenuEntry = MenuItem | "sep";

export default function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuEntry[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // Once mounted we know the real size — nudge back in if it would clip.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const nx = x + r.width > window.innerWidth - 8 ? Math.max(8, window.innerWidth - r.width - 8) : x;
    const ny = y + r.height > window.innerHeight - 8 ? Math.max(8, window.innerHeight - r.height - 8) : y;
    setPos({ x: nx, y: ny });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Capture, so a click that lands on any other control still closes us first.
    window.addEventListener("pointerdown", onDown, true);
    document.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="ctx-menu"
      style={{ left: pos.x, top: pos.y }}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        it === "sep" ? (
          <div key={i} className="ctx-sep" />
        ) : (
          <button
            key={i}
            className={`ctx-item ${it.danger ? "danger" : ""}`}
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              it.onClick();
              onClose();
            }}
          >
            {it.icon && <i className={`ph ${it.icon}`} />}
            <span>{it.label}</span>
          </button>
        )
      )}
    </div>
  );
}

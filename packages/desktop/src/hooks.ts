import { useEffect, type RefObject } from "react";

// Escape closes the overlay — shared by every sheet/modal/confirm so the
// behavior is uniform (capture phase, so it wins over view-level handlers).
export function useEscapeToClose(onClose: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, enabled]);
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Keyboard focus trap + restore — shared by every overlay (palette, sheets,
// modals). While open, Tab/Shift+Tab cycle within the container instead of
// escaping to the page behind it; on close, focus returns to whatever
// triggered the overlay (the nav button, the board card, …) instead of
// falling back to <body>.
export function useFocusTrap<T extends HTMLElement>(ref: RefObject<T | null>, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = () => Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));

    // Respect an explicit autoFocus already applied inside the container;
    // otherwise land on the first focusable element so Tab has somewhere to
    // start.
    if (!el.contains(document.activeElement)) {
      focusables()[0]?.focus();
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("keydown", onKey);
      // The trigger may have unmounted (e.g. a card removed by the same
      // action that closed the overlay) — guard the restore.
      if (previouslyFocused && document.body.contains(previouslyFocused)) previouslyFocused.focus();
    };
  }, [ref, enabled]);
}

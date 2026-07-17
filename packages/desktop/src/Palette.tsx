import { useEffect, useMemo, useRef, useState } from "react";
import type { ActiveThread, Project } from "./types";

// ⌘K command palette: actions, active threads, and projects, filtered as you
// type. Enter (or click) runs the selected row and closes.

export interface PaletteAction {
  id: string;
  label: string;
  kind: string;
  icon: string;
  run: () => void;
}

export default function Palette({
  projects,
  active,
  actions,
  onOpenThread,
  onOpenProject,
  onClose,
}: {
  projects: Project[];
  active: ActiveThread[];
  actions: PaletteAction[];
  onOpenThread: (projectId: number, threadId: number) => void;
  onOpenProject: (projectId: number) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const list = useMemo<PaletteAction[]>(() => {
    const threadRows: PaletteAction[] = active.map((t) => ({
      id: `thread-${t.id}`,
      label: `${t.project_name} · ${t.title}`,
      kind: t.running ? "running" : t.kind,
      icon: "ph-chats-circle",
      run: () => onOpenThread(t.project_id, t.id),
    }));
    const projectRows: PaletteAction[] = projects.map((p) => ({
      id: `project-${p.id}`,
      label: p.name,
      kind: "project",
      icon: "ph-folder",
      run: () => onOpenProject(p.id),
    }));
    const all = [...actions, ...threadRows, ...projectRows];
    const needle = q.trim().toLowerCase();
    if (!needle) return all.slice(0, 12);
    return all
      .filter((r) => r.label.toLowerCase().includes(needle) || r.kind.toLowerCase().includes(needle))
      .slice(0, 12);
  }, [q, actions, active, projects, onOpenThread, onOpenProject]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => inputRef.current?.focus(), []);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={q}
          placeholder="Jump to thread, delegate, run a command…"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, list.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter" && list[sel]) {
              list[sel].run();
              onClose();
            }
          }}
        />
        <div className="results">
          {list.map((r, i) => (
            <button
              key={r.id}
              className={`result ${i === sel ? "sel" : ""}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => {
                r.run();
                onClose();
              }}
            >
              <i className={`ph ${r.icon}`} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.label}</span>
              <span className="kind">{r.kind}</span>
            </button>
          ))}
          {list.length === 0 && (
            <div style={{ padding: 14, fontSize: 12.5, color: "var(--color-neutral-600)" }}>No matches.</div>
          )}
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import type { Project, ProjectSettings, Thread } from "./types";

// New-ticket sheet (design 3a): task + project + model/effort tag pickers +
// isolation preview. "Delegate ↵" creates the ticket thread and launches the
// run in one move (there is no create-without-delegate — a Spawn ticket IS a
// delegated run; board columns stay Trello-owned during migration).

const MODELS = ["haiku", "sonnet", "opus", "fable"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

export default function DelegateSheet({
  projects,
  initialProjectId,
  onClose,
  onDelegated,
}: {
  projects: Project[];
  initialProjectId?: number | null;
  onClose: () => void;
  onDelegated: (t: Thread) => void;
}) {
  const [task, setTask] = useState("");
  const [projectId, setProjectId] = useState<number | "">(initialProjectId ?? "");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (projectId === "") return setSettings(null);
    window.spawn.getProjectSettings(projectId).then(setSettings).catch(() => setSettings(null));
  }, [projectId]);

  const allowed = settings?.allowedModels ?? MODELS.filter((m) => m !== "fable");
  const firstLine = task.trim().split("\n")[0] ?? "";
  const branchPreview = firstLine ? `ticket/<id>-${slugify(firstLine)}` : "ticket/<id>-<slug>";

  const delegate = async () => {
    const text = task.trim();
    if (!text || projectId === "" || sending) return;
    setSending(true);
    try {
      const t = await window.spawn.delegateTask({
        projectId,
        task: text,
        model: model || undefined,
        effort: effort || undefined,
      });
      onDelegated(t);
      onClose();
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="overlay center" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="s-head">
          <i className="ph ph-plus-circle" />
          New ticket
          <button className="x" onClick={onClose}>
            <i className="ph ph-x" />
          </button>
        </div>
        <textarea
          className="task"
          autoFocus
          value={task}
          placeholder="Describe the task — the agent reads this verbatim. Paste logs, link files, reference PRs…"
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              delegate();
            }
          }}
        />
        <div>
          <div className="f-label">Project</div>
          <select
            className="f-select"
            value={projectId === "" ? "" : String(projectId)}
            onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : "")}
          >
            <option value="">pick a project…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <div className="f-label">
            Model · effort <span style={{ color: "var(--color-neutral-600)" }}>(right-size the run)</span>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {MODELS.map((m) => (
              <span
                key={m}
                className={`tag pick ${model === m ? "tag-accent" : "tag-neutral"}`}
                style={allowed.includes(m) ? undefined : { opacity: 0.4 }}
                title={allowed.includes(m) ? "" : "not in this project's allowed models"}
                onClick={() => setModel(model === m ? "" : m)}
              >
                {m}
              </span>
            ))}
            <span style={{ width: 1, height: 18, background: "var(--color-neutral-800)", margin: "0 4px" }} />
            {EFFORTS.map((x) => (
              <span
                key={x}
                className={`tag pick ${effort === x ? "tag-accent" : "tag-neutral"}`}
                onClick={() => setEffort(effort === x ? "" : x)}
              >
                {x}
              </span>
            ))}
          </div>
        </div>
        <div className="toggle-row" style={{ marginTop: 0 }}>
          <span className={`toggle ${settings?.isolation !== false ? "on" : ""}`} style={{ cursor: "default" }} />
          <span>
            {settings?.isolation !== false ? "Isolated in a worktree" : "Isolation off for this project"}
          </span>
          <span className="hint mono">{settings?.isolation !== false ? branchPreview : ""}</span>
        </div>
        <div className="s-foot">
          <span style={{ fontSize: 11, color: "var(--color-neutral-500)" }}>
            {model || settings?.defaultModel || "harness default"} · {effort || settings?.defaultEffort || "default effort"}
          </span>
          <button
            className="btn btn-primary small-btn"
            style={{ marginLeft: "auto", padding: "5px 14px", fontSize: 12 }}
            disabled={!task.trim() || projectId === "" || sending}
            onClick={delegate}
          >
            {sending ? "Delegating…" : "Create & delegate ↵"}
          </button>
        </div>
      </div>
    </div>
  );
}

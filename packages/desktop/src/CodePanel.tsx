import { useCallback, useEffect, useRef, useState } from "react";
import type { DiffFile, ThreadDiff } from "./types";

// The Code view (SPWN-41): a GitHub-style "files changed" panel for a thread's
// worktree branch. Lists every path the branch touched vs its base; clicking a
// file expands its unified diff inline (PR-review style). Lives in the thread
// screen's right column beside the chat, so you can read the agent's reasoning
// and its code changes at once.

// ── Unified-diff parsing ──────────────────────────────────────────────────
type Row =
  | { kind: "hunk"; text: string }
  | { kind: "line"; sign: " " | "+" | "-"; oldNo: number | null; newNo: number | null; text: string }
  | { kind: "meta"; text: string };

const MAX_ROWS = 2000; // guard against pathologically large diffs

function parseDiff(raw: string): { rows: Row[]; truncated: boolean; binary: boolean } {
  const rows: Row[] = [];
  const lines = raw.split("\n");
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  let binary = false;
  for (const line of lines) {
    if (rows.length >= MAX_ROWS) return { rows, truncated: true, binary };
    if (line.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/.exec(line);
      if (m) {
        oldNo = Number(m[1]);
        newNo = Number(m[2]);
        inHunk = true;
        rows.push({ kind: "hunk", text: m[3].trim() ? `@@ ${m[3].trim()}` : "" });
      }
      continue;
    }
    if (!inHunk) {
      // File header noise (diff --git, index, ---, +++, mode lines). Surface a
      // binary marker; otherwise skip the plumbing.
      if (/^Binary files /.test(line)) binary = true;
      continue;
    }
    if (line.startsWith("\\")) {
      rows.push({ kind: "meta", text: line.slice(2) }); // "No newline at end of file"
      continue;
    }
    const sign = line[0];
    const body = line.slice(1);
    if (sign === "+") {
      rows.push({ kind: "line", sign: "+", oldNo: null, newNo, text: body });
      newNo++;
    } else if (sign === "-") {
      rows.push({ kind: "line", sign: "-", oldNo, newNo: null, text: body });
      oldNo++;
    } else {
      // context (leading space) or a stray blank line inside a hunk
      rows.push({ kind: "line", sign: " ", oldNo, newNo, text: body });
      oldNo++;
      newNo++;
    }
  }
  return { rows, truncated: false, binary };
}

function DiffBody({ raw }: { raw: string }) {
  const { rows, truncated, binary } = parseDiff(raw);
  if (binary) return <div className="diff-note">Binary file — not shown.</div>;
  if (rows.length === 0) return <div className="diff-note">No textual changes.</div>;
  return (
    <div className="diff-body">
      {rows.map((r, i) =>
        r.kind === "hunk" ? (
          <div key={i} className="diff-row hunk">
            <span className="ln" />
            <span className="ln" />
            <span className="dl">{r.text}</span>
          </div>
        ) : r.kind === "meta" ? (
          <div key={i} className="diff-row meta">
            <span className="ln" />
            <span className="ln" />
            <span className="dl">{r.text}</span>
          </div>
        ) : (
          <div key={i} className={`diff-row ${r.sign === "+" ? "add" : r.sign === "-" ? "del" : "ctx"}`}>
            <span className="ln">{r.oldNo ?? ""}</span>
            <span className="ln">{r.newNo ?? ""}</span>
            <span className="dl">
              <span className="sg">{r.sign === " " ? " " : r.sign}</span>
              {r.text || " "}
            </span>
          </div>
        )
      )}
      {truncated && <div className="diff-note">Diff truncated — open the file to see the rest.</div>}
    </div>
  );
}

// ── File row (a collapsible section, one per changed file) ─────────────────
const STATUS = {
  A: { icon: "ph-file-plus", cls: "add", label: "added" },
  M: { icon: "ph-file", cls: "mod", label: "modified" },
  D: { icon: "ph-file-x", cls: "del", label: "deleted" },
} as const;

function StatBar({ f }: { f: DiffFile }) {
  const add = f.additions ?? 0;
  const del = f.deletions ?? 0;
  const total = add + del;
  const seg = total === 0 ? 0 : Math.max(1, Math.round((add / total) * 5));
  return (
    <span className="stat">
      {f.binary ? (
        <span className="bin">bin</span>
      ) : (
        <>
          {add > 0 && <span className="a">+{add}</span>}
          {del > 0 && <span className="d">−{del}</span>}
        </>
      )}
      <span className="bar" aria-hidden>
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className={total === 0 ? "n" : i < seg ? "g" : "r"} />
        ))}
      </span>
    </span>
  );
}

function FileRow({
  file,
  open,
  diff,
  onToggle,
}: {
  file: DiffFile;
  open: boolean;
  diff: string | null | undefined; // undefined=not loaded, null=loading
  onToggle: () => void;
}) {
  const slash = file.path.lastIndexOf("/");
  const dir = slash >= 0 ? file.path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? file.path.slice(slash + 1) : file.path;
  const s = STATUS[file.status];
  return (
    <div className={`file ${open ? "open" : ""}`}>
      <button className="file-head" onClick={onToggle} title={file.path}>
        <i className={`ph ${open ? "ph-caret-down" : "ph-caret-right"} caret`} />
        <i className={`ph ${s.icon} sicon ${s.cls}`} title={s.label} />
        <span className="path">
          {dir && <span className="dir">{dir}</span>}
          <span className="name">{name}</span>
        </span>
        <StatBar f={file} />
      </button>
      {open &&
        (diff === null ? (
          <div className="diff-note loading">Loading diff…</div>
        ) : diff === undefined ? null : diff === "" ? (
          <div className="diff-note">No diff available.</div>
        ) : (
          <DiffBody raw={diff} />
        ))}
    </div>
  );
}

// ── Panel ──────────────────────────────────────────────────────────────────
export default function CodePanel({ threadId }: { threadId: number }) {
  const [data, setData] = useState<ThreadDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [diffs, setDiffs] = useState<Map<string, string | null>>(new Map());
  const openRef = useRef(open);
  openRef.current = open;

  const loadFileDiff = useCallback(
    (path: string) => {
      setDiffs((m) => new Map(m).set(path, null)); // mark loading
      window.agentdeck
        .getThreadFileDiff(threadId, path)
        .then((r) => setDiffs((m) => new Map(m).set(path, r.diff)))
        .catch(() => setDiffs((m) => new Map(m).set(path, "")));
    },
    [threadId]
  );

  const refresh = useCallback(() => {
    window.agentdeck
      .getThreadDiff(threadId)
      .then((d) => {
        setData(d);
        setLoading(false);
        // Drop expanded files that no longer appear; reload the ones that do.
        const present = new Set(d.files.map((f) => f.path));
        const keep = new Set([...openRef.current].filter((p) => present.has(p)));
        setOpen(keep);
        keep.forEach(loadFileDiff);
      })
      .catch(() => {
        setData(null);
        setLoading(false);
      });
  }, [threadId, loadFileDiff]);

  useEffect(() => {
    setData(null);
    setLoading(true);
    setOpen(new Set());
    setDiffs(new Map());
    refresh();
  }, [refresh]);

  // Re-pull when this thread's run ends or its state changes (files likely moved).
  useEffect(() => {
    return window.agentdeck.onEvent((ev) => {
      if (ev.type === "turn:done" && ev.payload.threadId === threadId) refresh();
      else if (ev.type === "thread:updated" && ev.payload.id === threadId) refresh();
    });
  }, [threadId, refresh]);

  const toggle = (path: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else {
        next.add(path);
        if (!diffs.has(path)) loadFileDiff(path);
      }
      return next;
    });
  };

  const files = data?.files ?? [];
  const allOpen = files.length > 0 && files.every((f) => open.has(f.path));
  const toggleAll = () => {
    if (allOpen) setOpen(new Set());
    else {
      const next = new Set(files.map((f) => f.path));
      setOpen(next);
      files.forEach((f) => !diffs.has(f.path) && loadFileDiff(f.path));
    }
  };

  return (
    <aside className="code-panel fade-l">
      <div className="code-head">
        <div className="ttl">
          <i className="ph ph-git-diff" />
          <span>Changes</span>
          {data?.base && <code className="vs">vs {data.base}</code>}
        </div>
        <div className="acts">
          {files.length > 0 && (
            <button className="btn btn-ghost small-btn" onClick={toggleAll} title={allOpen ? "Collapse all" : "Expand all"}>
              <i className={`ph ${allOpen ? "ph-arrows-in-line-vertical" : "ph-arrows-out-line-vertical"}`} />
            </button>
          )}
          <button className="btn btn-ghost small-btn" onClick={refresh} title="Refresh">
            <i className="ph ph-arrow-clockwise" />
          </button>
        </div>
      </div>

      {files.length > 0 && (
        <div className="code-summary">
          <span>
            {files.length} file{files.length === 1 ? "" : "s"} changed
          </span>
          {data && data.additions > 0 && <span className="a">+{data.additions}</span>}
          {data && data.deletions > 0 && <span className="d">−{data.deletions}</span>}
        </div>
      )}

      <div className="code-files">
        {loading ? (
          <div className="code-empty">Loading changes…</div>
        ) : !data?.worktreePath ? (
          <div className="code-empty">
            <i className="ph ph-git-branch" />
            <span>No isolated branch — this thread runs in the project directory, so there's nothing to diff.</span>
          </div>
        ) : files.length === 0 ? (
          <div className="code-empty">
            <i className="ph ph-check-circle" />
            <span>No changes yet on {data.branch ? <code>{data.branch}</code> : "this branch"}. The agent hasn't touched any files.</span>
          </div>
        ) : (
          files.map((f) => (
            <FileRow key={f.path} file={f} open={open.has(f.path)} diff={diffs.get(f.path)} onToggle={() => toggle(f.path)} />
          ))
        )}
      </div>
    </aside>
  );
}

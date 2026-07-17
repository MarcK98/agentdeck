import { useEffect, useState } from "react";
import type { Project, ProjectSettings } from "./types";

// Settings as a full screen (design 2a): project sub-nav left, panels right.
// Only real, daemon-backed settings render as editable; future sections
// (MCP servers, commands/skills, budgets) state what they are honestly
// instead of faking controls.

const MODELS = ["haiku", "sonnet", "opus", "fable"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export default function SettingsView({
  projects,
  initialProjectId,
}: {
  projects: Project[];
  initialProjectId: number | null;
}) {
  const [projectId, setProjectId] = useState<number | null>(initialProjectId ?? projects[0]?.id ?? null);
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  const [savedTick, setSavedTick] = useState(0);

  const project = projects.find((p) => p.id === projectId) ?? null;

  useEffect(() => {
    if (projectId == null) return;
    setSettings(null);
    window.spawn.getProjectSettings(projectId).then(setSettings);
  }, [projectId]);

  const patch = async (p: Partial<ProjectSettings>) => {
    if (projectId == null) return;
    setSettings(await window.spawn.updateProjectSettings(projectId, p));
    setSavedTick((n) => n + 1);
  };

  const toggleModel = (m: string) => {
    if (!settings) return;
    const allowed = settings.allowedModels.includes(m)
      ? settings.allowedModels.filter((x) => x !== m)
      : [...settings.allowedModels, m];
    const change: Partial<ProjectSettings> = { allowedModels: allowed };
    if (settings.defaultModel && !allowed.includes(settings.defaultModel)) change.defaultModel = "";
    patch(change);
  };

  return (
    <div className="view">
      <div className="view-head">
        <h4>Project settings</h4>
        <span className="sub">changes apply to new turns immediately</span>
        {savedTick > 0 && (
          <span className="ok-c" style={{ marginLeft: "auto", fontSize: 11.5, display: "inline-flex", gap: 5, alignItems: "center" }}>
            <i className="ph ph-check-circle" /> saved
          </span>
        )}
      </div>
      <div className="settings-body">
        <div className="subnav fade-r">
          <div className="h">Projects</div>
          {projects.map((p) => (
            <button key={p.id} className={p.id === projectId ? "on" : ""} onClick={() => setProjectId(p.id)}>
              {p.name}
            </button>
          ))}
        </div>

        <div className="settings-panels">
          {project == null || settings == null ? (
            <div className="full empty" style={{ margin: "40px auto" }}>
              {project == null ? "Pick a project." : "Loading…"}
            </div>
          ) : (
            <>
              <div className="panel">
                <div className="p-title">
                  <i className="ph ph-folder" />
                  General
                </div>
                <div className="f-label">Name</div>
                <div className="f-static">{project.name}</div>
                <div className="f-label" style={{ marginTop: 12 }}>
                  Working directory
                </div>
                <div className="f-static mono">{project.dir}</div>
                <div className="note">
                  Projects are directories under PROJECTS_ROOT (plus projects.json overrides) — rename or
                  move them on disk.
                </div>
              </div>

              <div className="panel">
                <div className="p-title">
                  <i className="ph ph-brain" />
                  Models & effort
                </div>
                <div className="f-label">Allowed models</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {MODELS.map((m) => (
                    <span
                      key={m}
                      className={`tag pick ${settings.allowedModels.includes(m) ? "tag-accent" : "tag-outline"}`}
                      style={m === "fable" && !settings.allowedModels.includes(m) ? { opacity: 0.6 } : undefined}
                      onClick={() => toggleModel(m)}
                    >
                      {settings.allowedModels.includes(m) && <i className="ph ph-check" style={{ marginRight: 5 }} />}
                      {m}
                      {m === "fable" && !settings.allowedModels.includes(m) ? " · opt-in" : ""}
                    </span>
                  ))}
                </div>
                <div className="f-row">
                  <div>
                    <div className="f-label">Default model</div>
                    <select
                      className="f-select"
                      value={settings.defaultModel}
                      onChange={(e) => patch({ defaultModel: e.target.value })}
                    >
                      <option value="">harness default</option>
                      {settings.allowedModels.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <div className="f-label">Default effort</div>
                    <select
                      className="f-select"
                      value={settings.defaultEffort}
                      onChange={(e) => patch({ defaultEffort: e.target.value })}
                    >
                      <option value="">harness default</option>
                      {EFFORTS.map((x) => (
                        <option key={x} value={x}>
                          {x}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="note">The lead can still right-size per ticket — these are the fallbacks.</div>
              </div>

              <div className="panel">
                <div className="p-title">
                  <i className="ph ph-hand-palm" />
                  Approvals
                </div>
                <div className="seg2">
                  {(["prompt", "auto"] as const).map((mode) => (
                    <button
                      key={mode}
                      className={settings.approvalMode === mode ? "on" : ""}
                      onClick={() => patch({ approvalMode: mode })}
                    >
                      {mode === "prompt" ? "Prompt me" : "Auto-allow"}
                    </button>
                  ))}
                </div>
                <div className="note">
                  Prompted requests land in the Approvals inbox and pause only their own thread.
                  Auto-allow runs unattended (bypassPermissions).
                </div>
              </div>

              <div className="panel">
                <div className="p-title">
                  <i className="ph ph-git-branch" />
                  Isolation
                </div>
                <div className="toggle-row" style={{ marginTop: 0 }}>
                  <button
                    className={`toggle ${settings.isolation !== false ? "on" : ""}`}
                    onClick={() => patch({ isolation: settings.isolation === false })}
                  />
                  <span>Worktree per ticket</span>
                  <span className="hint mono">ticket/&lt;id&gt;-&lt;slug&gt;</span>
                </div>
                <div className="note">
                  Delegations into this project (when it's a git repo) run in their own worktree + branch.
                  Cleanup removes only the checkout — branches always survive.
                </div>
              </div>

              <div className="panel">
                <div className="p-title">
                  <i className="ph ph-plugs-connected" />
                  MCP servers
                </div>
                <div className="note" style={{ marginTop: 0 }}>
                  {settings.mcps.length
                    ? settings.mcps.join(", ")
                    : "Per-project MCP servers are a future step — runs currently get the daemon-wide set (approver, plus Chrome when BROWSER_MCP_ENABLED)."}
                </div>
              </div>

              <div className="panel">
                <div className="p-title">
                  <i className="ph ph-terminal-window" />
                  Commands & skills
                </div>
                <div className="note" style={{ marginTop: 0 }}>
                  {settings.skills.length
                    ? settings.skills.join(", ")
                    : "Agents pick up this project's .claude/ commands, skills, and subagents from disk — nothing to configure here yet."}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

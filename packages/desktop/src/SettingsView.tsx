import { useEffect, useState } from "react";
import type { Connection, McpServerDef, Project, ProjectSettings, SkillInfo } from "./types";

// Connection catalog: developer-infra types with icons and value hints.
// "other" keeps it open-ended.
export const CONNECTION_TYPES: { key: string; label: string; icon: string; hint: string }[] = [
  { key: "google-account", label: "Google account", icon: "ph-google-logo", hint: "email" },
  { key: "apple-account", label: "Apple account", icon: "ph-apple-logo", hint: "Apple ID email" },
  { key: "github", label: "GitHub", icon: "ph-github-logo", hint: "org/user or repo" },
  { key: "gcp", label: "Google Cloud", icon: "ph-cloud", hint: "project id" },
  { key: "firebase", label: "Firebase", icon: "ph-fire", hint: "project id" },
  { key: "supabase", label: "Supabase", icon: "ph-database", hint: "project ref" },
  { key: "vercel", label: "Vercel", icon: "ph-triangle", hint: "project / team" },
  { key: "netlify", label: "Netlify", icon: "ph-globe-hemisphere-west", hint: "site name" },
  { key: "heroku", label: "Heroku", icon: "ph-hexagon", hint: "app name" },
  { key: "aws", label: "AWS", icon: "ph-cloud-arrow-up", hint: "account / profile" },
  { key: "digitalocean", label: "DigitalOcean", icon: "ph-drop", hint: "app / droplet" },
  { key: "stripe", label: "Stripe", icon: "ph-credit-card", hint: "account" },
  { key: "sentry", label: "Sentry", icon: "ph-bug", hint: "org/project" },
  { key: "database", label: "Database", icon: "ph-database", hint: "host / name" },
  { key: "domain", label: "Domain", icon: "ph-globe", hint: "domain name" },
  { key: "other", label: "Other", icon: "ph-plug", hint: "identifier" },
];
const connMeta = (type: string) =>
  CONNECTION_TYPES.find((t) => t.key === type) ?? CONNECTION_TYPES[CONNECTION_TYPES.length - 1];

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
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [savedTick, setSavedTick] = useState(0);
  // Add-MCP-server form.
  const [mcpName, setMcpName] = useState("");
  const [mcpTarget, setMcpTarget] = useState("");
  // Rules/memory drafts — saved on blur or ⌘S, so typing doesn't spam the DB.
  const [rulesDraft, setRulesDraft] = useState("");
  const [memoryDraft, setMemoryDraft] = useState("");
  // Add-connection form.
  const [connType, setConnType] = useState("google-account");
  const [connLabel, setConnLabel] = useState("");
  const [connValue, setConnValue] = useState("");
  const [connUrl, setConnUrl] = useState("");
  const [connEnv, setConnEnv] = useState("");

  const project = projects.find((p) => p.id === projectId) ?? null;

  useEffect(() => {
    if (projectId == null) return;
    setSettings(null);
    setSkills([]);
    window.spawn.getProjectSettings(projectId).then((s) => {
      setSettings(s);
      setRulesDraft(s.rules ?? "");
      setMemoryDraft(s.memory ?? "");
    });
    window.spawn.listSkills(projectId).then(setSkills).catch(() => setSkills([]));
  }, [projectId]);

  const patch = async (p: Partial<ProjectSettings>) => {
    if (projectId == null) return;
    setSettings(await window.spawn.updateProjectSettings(projectId, p));
    setSavedTick((n) => n + 1);
  };

  const addMcpServer = () => {
    if (!settings) return;
    const name = mcpName.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
    const target = mcpTarget.trim();
    if (!name || !target || settings.mcpServers.some((s) => s.name === name)) return;
    const def: McpServerDef = /^https?:\/\//i.test(target)
      ? { name, transport: "http", url: target, enabled: true }
      : { name, transport: "stdio", command: target, enabled: true };
    patch({ mcpServers: [...settings.mcpServers, def] });
    setMcpName("");
    setMcpTarget("");
  };

  const patchMcpServer = (name: string, change: Partial<McpServerDef> | null) => {
    if (!settings) return;
    const next =
      change === null
        ? settings.mcpServers.filter((s) => s.name !== name)
        : settings.mcpServers.map((s) => (s.name === name ? { ...s, ...change } : s));
    patch({ mcpServers: next });
  };

  const toggleSkill = async (s: SkillInfo) => {
    if (!settings || projectId == null) return;
    const disabled = s.enabled
      ? [...settings.disabledSkills, s.name]
      : settings.disabledSkills.filter((x) => x !== s.name);
    await patch({ disabledSkills: disabled });
    setSkills(await window.spawn.listSkills(projectId));
  };

  const addConnection = () => {
    if (!settings || !connValue.trim()) return;
    const conn: Connection = {
      id: `${connType}-${Date.now().toString(36)}`,
      type: connType,
      label: connLabel.trim(),
      value: connValue.trim(),
      url: connUrl.trim() || undefined,
      secretEnv: connEnv.trim() || undefined,
    };
    patch({ connections: [...settings.connections, conn] });
    setConnLabel("");
    setConnValue("");
    setConnUrl("");
    setConnEnv("");
  };
  const removeConnection = (id: string) => {
    if (!settings) return;
    patch({ connections: settings.connections.filter((c) => c.id !== id) });
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
                {settings.mcpServers.map((s) => (
                  <div key={s.name} className="mcp-row">
                    <span className={s.enabled ? "dot-live" : "dot-idle"} />
                    <div className="body">
                      <div className="n">{s.name}</div>
                      <div className="c mono" title={s.command ?? s.url}>
                        {s.command ?? s.url}
                      </div>
                    </div>
                    <span className="tag tag-neutral" style={{ fontSize: 10 }}>
                      {s.transport}
                    </span>
                    <button
                      className={`toggle ${s.enabled ? "on" : ""}`}
                      title={s.enabled ? "Disable" : "Enable"}
                      onClick={() => patchMcpServer(s.name, { enabled: !s.enabled })}
                    />
                    <button className="mcp-x" title="Remove" onClick={() => patchMcpServer(s.name, null)}>
                      <i className="ph ph-x" />
                    </button>
                  </div>
                ))}
                {settings.mcpServers.length === 0 && (
                  <div className="note" style={{ marginTop: 0 }}>
                    None yet. Enabled servers are added to every run in this project, alongside the
                    built-in approver{" "}
                    <span className="mono" style={{ fontSize: 10.5 }}>
                      (+ chrome-devtools when BROWSER_MCP_ENABLED)
                    </span>
                    .
                  </div>
                )}
                <div className="mcp-add">
                  <input
                    className="f-static"
                    style={{ width: 110 }}
                    placeholder="name"
                    value={mcpName}
                    onChange={(e) => setMcpName(e.target.value)}
                  />
                  <input
                    className="f-static mono"
                    style={{ flex: 1, minWidth: 0 }}
                    placeholder="npx some-mcp --flag   ·   or https://mcp.example.dev"
                    value={mcpTarget}
                    onChange={(e) => setMcpTarget(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addMcpServer();
                    }}
                  />
                  <button
                    className="btn btn-ghost small-btn"
                    disabled={!mcpName.trim() || !mcpTarget.trim()}
                    onClick={addMcpServer}
                  >
                    <i className="ph ph-plus" /> Add
                  </button>
                </div>
                <div className="note">
                  Command line or http(s) URL — auto-detected. Servers inherit the daemon's
                  environment; per-server secrets aren't stored here. Applies to new turns.
                </div>
              </div>

              <div className="panel">
                <div className="p-title">
                  <i className="ph ph-terminal-window" />
                  Skills
                  <span style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--color-neutral-600)" }}>
                    project .claude/skills + user ~/.claude/skills
                  </span>
                </div>
                {skills.map((s) => (
                  <label key={`${s.scope}-${s.name}`} className="skill-row" title={s.description}>
                    <input type="checkbox" checked={s.enabled} onChange={() => toggleSkill(s)} />
                    <span className="n">{s.name}</span>
                    <span className="tag tag-neutral" style={{ fontSize: 10 }}>
                      {s.scope}
                    </span>
                  </label>
                ))}
                {skills.length === 0 && (
                  <div className="note" style={{ marginTop: 0 }}>
                    No skills found for this project.
                  </div>
                )}
                <div className="note">
                  Unchecked skills are denied to agents in this project (via a Skill(name) tool rule).
                  Everything else stays available.
                </div>
              </div>

              <div className="panel">
                <div className="p-title">
                  <i className="ph ph-scroll" />
                  Rules
                  <span className="p-hint">how agents behave here</span>
                </div>
                <textarea
                  className="blob"
                  value={rulesDraft}
                  placeholder={"Standing instructions for every run in this project.\ne.g. Always open a PR, never push to main. Run npm test before committing. Ask before touching migrations."}
                  onChange={(e) => setRulesDraft(e.target.value)}
                  onBlur={() => {
                    if (rulesDraft !== settings.rules) patch({ rules: rulesDraft });
                  }}
                />
                <div className="note">
                  Injected into every run's system prompt — on top of the repo's own CLAUDE.md.
                  Saves when you click away.
                </div>
              </div>

              <div className="panel">
                <div className="p-title">
                  <i className="ph ph-brain" />
                  Memory
                  <span className="p-hint">what's durably true here</span>
                </div>
                <textarea
                  className="blob"
                  value={memoryDraft}
                  placeholder={"Project facts agents should always know.\ne.g. Staging is at staging.foo.dev. The iOS build needs Xcode 16. Marc reviews all schema changes."}
                  onChange={(e) => setMemoryDraft(e.target.value)}
                  onBlur={() => {
                    if (memoryDraft !== settings.memory) patch({ memory: memoryDraft });
                  }}
                />
                <div className="note">Injected alongside the rules. Saves when you click away.</div>
              </div>

              <div className="panel full">
                <div className="p-title">
                  <i className="ph ph-plugs" />
                  Connections
                  <span className="p-hint">accounts, cloud projects & deploy targets this project is wired to</span>
                </div>
                <div className="conn-grid">
                  {settings.connections.map((c) => {
                    const meta = connMeta(c.type);
                    return (
                      <div key={c.id} className="conn-card" title={c.notes ?? ""}>
                        <i className={`ph ${meta.icon} conn-icon`} />
                        <div className="body">
                          <div className="t">
                            {meta.label}
                            {c.label && <span className="lbl"> · {c.label}</span>}
                          </div>
                          <div className="v mono">{c.value}</div>
                          <div className="meta">
                            {c.url && (
                              <a href={c.url} target="_blank" rel="noreferrer">
                                console <i className="ph ph-arrow-square-out" />
                              </a>
                            )}
                            {c.secretEnv && (
                              <span className="tag tag-neutral" title="Env var holding this connection's credentials — the token itself is never stored">
                                env: {c.secretEnv}
                              </span>
                            )}
                          </div>
                        </div>
                        <button className="mcp-x" title="Remove" onClick={() => removeConnection(c.id)}>
                          <i className="ph ph-x" />
                        </button>
                      </div>
                    );
                  })}
                  {settings.connections.length === 0 && (
                    <div className="note" style={{ marginTop: 0, gridColumn: "1 / -1" }}>
                      Nothing wired yet. Connections are shown to agents on every run — deploy targets,
                      accounts, and cloud projects they must use instead of guessing.
                    </div>
                  )}
                </div>
                <div className="conn-add">
                  <select className="f-select" style={{ width: 160 }} value={connType} onChange={(e) => setConnType(e.target.value)}>
                    {CONNECTION_TYPES.map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  <input
                    className="f-static"
                    style={{ width: 120 }}
                    placeholder="label (prod, staging…)"
                    value={connLabel}
                    onChange={(e) => setConnLabel(e.target.value)}
                  />
                  <input
                    className="f-static mono"
                    style={{ flex: 1, minWidth: 90 }}
                    placeholder={connMeta(connType).hint}
                    value={connValue}
                    onChange={(e) => setConnValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addConnection();
                    }}
                  />
                  <input
                    className="f-static mono"
                    style={{ width: 170 }}
                    placeholder="console url (optional)"
                    value={connUrl}
                    onChange={(e) => setConnUrl(e.target.value)}
                  />
                  <input
                    className="f-static mono"
                    style={{ width: 140 }}
                    placeholder="token env var (opt.)"
                    value={connEnv}
                    onChange={(e) => setConnEnv(e.target.value)}
                  />
                  <button className="btn btn-ghost small-btn" disabled={!connValue.trim()} onClick={addConnection}>
                    <i className="ph ph-plus" /> Add
                  </button>
                </div>
                <div className="note">
                  Identifiers only — emails, project ids, app names. Tokens never live here: point the
                  env field at the daemon env var that carries them.
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

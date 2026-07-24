import { useEffect, useRef, useState } from "react";
import type { Connection, McpServerDef, Project, ProjectSettings, SkillInfo, AgentDeckEvent } from "./types";
import { MODELS, EFFORTS } from "./constants";

// Connection catalog: developer-infra types with icons and value hints.
// "other" keeps it open-ended.
export const CONNECTION_TYPES: { key: string; label: string; icon: string; hint: string }[] = [
  { key: "google-account", label: "Google account", icon: "ph-google-logo", hint: "email" },
  { key: "apple-account", label: "Apple account", icon: "ph-apple-logo", hint: "Apple ID email" },
  { key: "github", label: "GitHub", icon: "ph-github-logo", hint: "org/user or repo" },
  { key: "gcp", label: "Google Cloud", icon: "ph-cloud", hint: "project id" },
  { key: "firebase", label: "Firebase", icon: "ph-fire", hint: "project id" },
  { key: "supabase", label: "Supabase", icon: "ph-database", hint: "project ref" },
  { key: "neon", label: "Neon", icon: "ph-lightning", hint: "project / branch" },
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

// One pasteable credential a provider MCP needs (goes to encrypted storage).
type McpSecretField = { key: string; label: string; hint?: string; file?: boolean; optional?: boolean };
// How a provider connects:
//   oauth-cli  — one-click `gcloud auth login` (browser), account pinned
//   token-page — open the provider's token page, capture the token (clipboard)
//   key-file   — download a key file (Apple .p8) + ids
//   cli        — reuse a CLI login on the daemon host (no in-app step)
//   none       — custom / manual
type McpConnectKind = "oauth-cli" | "token-page" | "key-file" | "cli" | "none";
// A one-click provider MCP preset. `command` may contain `{dir}` — replaced
// with the project's working dir when the preset is picked (Firebase --dir).
type McpPreset = {
  key: string;
  label: string;
  icon: string;
  transport: "stdio" | "http";
  command?: string;
  url?: string;
  auth: "token" | "cli" | "none";
  authNote?: string;
  secrets: McpSecretField[];
  connect: { kind: McpConnectKind; tokenPageUrl?: string; portalUrl?: string };
  docsUrl?: string;
};

// Provider MCP catalog (verified July 2026). `connect.kind` drives the in-app
// auth: Google Cloud is real browser OAuth; token providers open their token
// page and the app captures the token; Apple imports a downloaded .p8.
export const MCP_CATALOG: McpPreset[] = [
  {
    key: "gcloud", label: "Google Cloud", icon: "ph-cloud", transport: "stdio",
    command: "npx -y @google-cloud/gcloud-mcp",
    auth: "cli", authNote: "Signs in with `gcloud auth login` — isolated per connection.",
    secrets: [],
    connect: { kind: "oauth-cli" },
    docsUrl: "https://github.com/googleapis/gcloud-mcp",
  },
  {
    key: "supabase", label: "Supabase", icon: "ph-database", transport: "stdio",
    command: "npx -y @supabase/mcp-server-supabase@latest --read-only --project-ref=YOUR_REF",
    auth: "token",
    secrets: [{ key: "SUPABASE_ACCESS_TOKEN", label: "Access token", hint: "supabase.com → account → access tokens" }],
    connect: { kind: "token-page", tokenPageUrl: "https://supabase.com/dashboard/account/tokens" },
    docsUrl: "https://supabase.com/docs/guides/getting-started/mcp",
  },
  {
    // Neon (serverless Postgres). The hosted MCP takes the API key as an
    // Authorization header, so it rides the http + bearer path (like Expo) —
    // the local stdio server only takes the key as a positional arg, which
    // our encrypted-env model can't feed.
    key: "neon", label: "Neon", icon: "ph-lightning", transport: "http",
    url: "https://mcp.neon.tech/mcp",
    auth: "token",
    secrets: [{ key: "NEON_API_KEY", label: "API key", hint: "console.neon.tech → account settings → API keys" }],
    connect: { kind: "token-page", tokenPageUrl: "https://console.neon.tech/app/settings/api-keys" },
    docsUrl: "https://neon.com/docs/ai/neon-mcp-server",
  },
  {
    key: "firebase", label: "Firebase", icon: "ph-fire", transport: "stdio",
    command: "npx -y firebase-tools@latest mcp --dir {dir}",
    auth: "cli", authNote: "Uses `firebase login` (or ADC) on the daemon host.",
    secrets: [],
    connect: { kind: "cli" },
    docsUrl: "https://firebase.google.com/docs/ai-assistance/mcp-server",
  },
  {
    key: "apple", label: "App Store Connect", icon: "ph-apple-logo", transport: "stdio",
    command: "npx -y app-store-connect-mcp-server",
    auth: "token",
    secrets: [
      { key: "APP_STORE_CONNECT_KEY_ID", label: "Key ID", hint: "App Store Connect API key ID" },
      { key: "APP_STORE_CONNECT_ISSUER_ID", label: "Issuer ID", hint: "API key issuer ID" },
      { key: "APP_STORE_CONNECT_P8_PATH", label: ".p8 file path", hint: "absolute path to AuthKey_*.p8", file: true },
    ],
    connect: { kind: "key-file", portalUrl: "https://appstoreconnect.apple.com/access/integrations/api" },
    docsUrl: "https://github.com/JoshuaRileyDev/app-store-connect-mcp-server",
  },
  {
    key: "expo", label: "Expo (EAS)", icon: "ph-atom", transport: "http",
    url: "https://mcp.expo.dev/mcp",
    auth: "token",
    secrets: [{ key: "EXPO_TOKEN", label: "EAS access token", hint: "expo.dev → account → access tokens" }],
    connect: { kind: "token-page", tokenPageUrl: "https://expo.dev/settings/access-tokens" },
    docsUrl: "https://docs.expo.dev/mcp/",
  },
  {
    key: "railway", label: "Railway", icon: "ph-train-simple", transport: "stdio",
    command: "npx -y @railway/mcp-server",
    auth: "token",
    secrets: [{ key: "RAILWAY_API_TOKEN", label: "Account token", hint: "railway.com → account → tokens" }],
    connect: { kind: "token-page", tokenPageUrl: "https://railway.com/account/tokens" },
    docsUrl: "https://docs.railway.com/reference/mcp-server",
  },
  {
    key: "netlify", label: "Netlify", icon: "ph-globe-hemisphere-west", transport: "stdio",
    command: "npx -y @netlify/mcp",
    auth: "token",
    secrets: [{ key: "NETLIFY_PERSONAL_ACCESS_TOKEN", label: "Access token", hint: "app.netlify.com → applications → personal access tokens" }],
    connect: { kind: "token-page", tokenPageUrl: "https://app.netlify.com/user/applications#personal-access-tokens" },
    docsUrl: "https://github.com/netlify/netlify-mcp",
  },
  {
    key: "heroku", label: "Heroku", icon: "ph-hexagon", transport: "stdio",
    command: "npx -y @heroku/mcp-server",
    auth: "token",
    secrets: [{ key: "HEROKU_API_KEY", label: "API key", hint: "dashboard.heroku.com → account → API key" }],
    connect: { kind: "token-page", tokenPageUrl: "https://dashboard.heroku.com/account" },
    docsUrl: "https://devcenter.heroku.com/articles/heroku-mcp-server",
  },
  {
    key: "vercel", label: "Vercel", icon: "ph-triangle", transport: "http",
    url: "https://mcp.vercel.com",
    auth: "token",
    secrets: [{ key: "VERCEL_TOKEN", label: "Access token", hint: "vercel.com → account → tokens" }],
    connect: { kind: "token-page", tokenPageUrl: "https://vercel.com/account/tokens" },
    docsUrl: "https://vercel.com/docs/agent-resources/vercel-mcp",
  },
  {
    key: "custom", label: "Custom", icon: "ph-plug", transport: "stdio",
    command: "", auth: "none", secrets: [],
    connect: { kind: "none" },
  },
];
const mcpMeta = (key?: string) => MCP_CATALOG.find((p) => p.key === key) ?? null;

// One-line "what happens when you click Add" hint per connect kind.
const connectHint = (p: McpPreset | null): { icon: string; text: string } => {
  switch (p?.connect.kind) {
    case "oauth-cli":
      return { icon: "ph-google-logo", text: "Adds the server, then opens Google sign-in — isolated per connection, account pinned." };
    case "token-page":
      return { icon: "ph-link-simple", text: `Connect ${p.label}: paste your token below, or leave it blank to capture it from the token page.` };
    case "key-file":
      return { icon: "ph-apple-logo", text: "Adds the server, then opens the Apple portal — download your API key (.p8) and import it." };
    case "cli":
      return { icon: "ph-terminal", text: p.authNote ?? "Uses a CLI login on the daemon host." };
    default:
      return { icon: "ph-plug", text: "Custom server — provide a command or URL." };
  }
};

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");

// Focused settings categories — the left rail's second group filters which
// panels render, so each screen is a small honest set instead of a wall.
type Category = "overview" | "behavior" | "integrations" | "knowledge" | "notifications";
const CATEGORIES: { key: Category; label: string; icon: string }[] = [
  { key: "overview", label: "Overview", icon: "ph-squares-four" },
  { key: "behavior", label: "Models & behavior", icon: "ph-sliders-horizontal" },
  { key: "integrations", label: "Integrations", icon: "ph-plugs-connected" },
  { key: "knowledge", label: "Knowledge", icon: "ph-book-open-text" },
  // App-wide (not per-project) — the panel renders outside the project gate.
  { key: "notifications", label: "Notifications", icon: "ph-bell" },
];

// App-wide OS-notification preference, mirrored to the Electron main process.
const NOTIF_KEY = "spawn.notificationsEnabled";
const loadNotifPref = (): boolean => {
  try {
    return localStorage.getItem(NOTIF_KEY) !== "0";
  } catch {
    return true;
  }
};

// Live connect state for one server: signing in / waiting for a token / failed.
type ConnectState = { state: "connecting" | "waiting" | "failed"; url?: string; error?: string };

// A pasted/copied token must be non-trivial and single-token (no whitespace).
const looksLikeToken = (s: string) => s.trim().length >= 12 && !/\s/.test(s.trim());

const dropKey = <T,>(obj: Record<string, T>, k: string): Record<string, T> => {
  const n = { ...obj };
  delete n[k];
  return n;
};

const shortAcct = (a: string) => (a.length > 20 ? a.split("@")[0] : a);

// Draft for the "add MCP server" flow (a catalog pick or Custom).
type McpDraft = {
  provider: string;
  name: string;
  environment: string;
  transport: "stdio" | "http";
  command: string;
  url: string;
  secretKeys: string[];
  secretVals: Record<string, string>;
  advanced: boolean;
};

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
  // "saved" is a transient confirmation, not a status light — fade it out.
  useEffect(() => {
    if (savedTick === 0) return;
    const t = setTimeout(() => setSavedTick(0), 2000);
    return () => clearTimeout(t);
  }, [savedTick]);
  const [category, setCategory] = useState<Category>("overview");
  // Add-MCP-server draft (null = nothing being added).
  const [mcpDraft, setMcpDraft] = useState<McpDraft | null>(null);
  // Live connect state per server name (browser OAuth / clipboard token watch).
  const [connecting, setConnecting] = useState<Record<string, ConnectState>>({});
  const clipCancel = useRef<Record<string, boolean>>({});
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

  const reloadSettings = async () => {
    if (projectId == null) return;
    setSettings(await window.agentdeck.getProjectSettings(projectId));
  };

  useEffect(() => {
    if (projectId == null) return;
    setSettings(null);
    setSkills([]);
    setMcpDraft(null);
    window.agentdeck.getProjectSettings(projectId).then((s) => {
      setSettings(s);
      setRulesDraft(s.rules ?? "");
      setMemoryDraft(s.memory ?? "");
    });
    window.agentdeck.listSkills(projectId).then(setSkills).catch(() => setSkills([]));
  }, [projectId]);

  // Live connect signals from the daemon (real app): surface the gcloud consent
  // URL as a fallback, and reflect connected/failed if the RPC hasn't resolved.
  useEffect(() => {
    return window.agentdeck.onEvent((ev: AgentDeckEvent) => {
      if (ev.type === "connect:url") {
        const { serverName, url } = ev.payload;
        setConnecting((c) => (c[serverName] ? { ...c, [serverName]: { ...c[serverName], url } } : c));
      } else if (ev.type === "connect:status") {
        const { serverName, state, error } = ev.payload;
        if (state === "connected") {
          setConnecting((c) => dropKey(c, serverName));
          reloadSettings();
        } else if (state === "failed") {
          setConnecting((c) => ({ ...c, [serverName]: { state: "failed", error } }));
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const patch = async (p: Partial<ProjectSettings>) => {
    if (projectId == null) return;
    setSettings(await window.agentdeck.updateProjectSettings(projectId, p));
    setSavedTick((n) => n + 1);
  };

  // Begin adding a server from a catalog pick (or Custom).
  const startAdd = (preset: McpPreset) => {
    setMcpDraft({
      provider: preset.key,
      name: preset.key === "custom" ? "" : preset.key,
      environment: "",
      transport: preset.transport,
      command: (preset.command ?? "").replace("{dir}", project?.dir ?? ""),
      url: preset.url ?? "",
      secretKeys: preset.secrets.map((s) => s.key),
      secretVals: Object.fromEntries(preset.secrets.map((s) => [s.key, ""])),
      advanced: false,
    });
  };

  // Create the server row, then kick off its connect flow so the user lands on
  // "Add" and the browser/token step starts immediately (their one-click ask).
  const commitAdd = async () => {
    if (!settings || !mcpDraft || projectId == null) return;
    const preset = mcpMeta(mcpDraft.provider);
    const isCustom = mcpDraft.provider === "custom";
    const raw = isCustom ? mcpDraft.command.trim() : (mcpDraft.transport === "http" ? mcpDraft.url : mcpDraft.command).trim();
    if (!raw) return;
    const transport: "stdio" | "http" = isCustom
      ? (/^https?:\/\//i.test(raw) ? "http" : "stdio")
      : mcpDraft.transport;
    let name = slug(mcpDraft.name) || (isCustom ? "mcp" : mcpDraft.provider);
    const existing = new Set(settings.mcpServers.map((s) => s.name));
    if (existing.has(name)) {
      let i = 2;
      while (existing.has(`${name}-${i}`)) i++;
      name = `${name}-${i}`;
    }
    const def: McpServerDef = {
      name,
      transport,
      enabled: true,
      ...(transport === "http" ? { url: raw } : { command: raw }),
      ...(!isCustom ? { provider: mcpDraft.provider } : {}),
      ...(mcpDraft.environment.trim() ? { environment: mcpDraft.environment.trim() } : {}),
      ...(mcpDraft.secretKeys.length ? { secretKeys: mcpDraft.secretKeys } : {}),
    };
    await window.agentdeck.updateProjectSettings(projectId, { mcpServers: [...settings.mcpServers, def] });
    // Save any tokens the user pasted directly in the add card (always allowed).
    const pasted = Object.entries(mcpDraft.secretVals).filter(([, v]) => v.trim());
    for (const [k, v] of pasted) await window.agentdeck.setProjectMcpSecret(projectId, name, k, v.trim());
    await reloadSettings();
    setSavedTick((n) => n + 1);
    const kind = preset?.connect.kind;
    setMcpDraft(null);
    // Auto-start the connect step for one-click kinds — but if a token was
    // pasted, it's already saved, so skip the clipboard-capture flow.
    if (kind === "oauth-cli") startGcloud(name);
    else if (kind === "token-page" && preset && pasted.length === 0) startTokenCapture(name, preset);
    else if (kind === "key-file" && preset?.connect.portalUrl && pasted.length === 0) window.agentdeck.openExternal(preset.connect.portalUrl);
  };

  // Google Cloud: browser OAuth into an isolated per-connection config dir.
  const startGcloud = async (name: string) => {
    if (projectId == null) return;
    setConnecting((c) => ({ ...c, [name]: { state: "connecting" } }));
    const r = await window.agentdeck.connectGcloud(projectId, name);
    if (r.ok) {
      await reloadSettings();
      setConnecting((c) => dropKey(c, name));
      setSavedTick((n) => n + 1);
    } else {
      setConnecting((c) => ({ ...c, [name]: { state: "failed", error: r.error } }));
    }
  };

  // Token providers: open the provider's token page and watch the clipboard —
  // when the user copies their token, capture + store it, no manual paste.
  const startTokenCapture = async (name: string, preset: McpPreset) => {
    if (projectId == null) return;
    const tokenKey = preset.secrets[0]?.key;
    const url = preset.connect.tokenPageUrl;
    if (!tokenKey || !url) return;
    await window.agentdeck.openExternal(url);
    setConnecting((c) => ({ ...c, [name]: { state: "waiting" } }));
    clipCancel.current[name] = false;
    const baseline = (await window.agentdeck.readClipboard().catch(() => "")).trim();
    const deadline = Date.now() + 90_000;
    const poll = async () => {
      if (clipCancel.current[name] || projectId == null) return;
      const cur = (await window.agentdeck.readClipboard().catch(() => "")).trim();
      if (cur && cur !== baseline && looksLikeToken(cur)) {
        await window.agentdeck.setProjectMcpSecret(projectId, name, tokenKey, cur);
        await reloadSettings();
        setConnecting((c) => dropKey(c, name));
        setSavedTick((n) => n + 1);
        return;
      }
      if (Date.now() < deadline) setTimeout(poll, 800);
      else setConnecting((c) => ({ ...c, [name]: { state: "failed", error: "No token detected — paste it manually below." } }));
    };
    setTimeout(poll, 800);
  };

  // Apple: pick the downloaded .p8; the daemon stores it isolated + wires the path.
  const startAppleImport = async (name: string) => {
    if (projectId == null) return;
    const path = await window.agentdeck.pickFile({ filters: [{ name: "App Store Connect key", extensions: ["p8"] }] });
    if (!path) return;
    await window.agentdeck.importAppleKey(projectId, name, path);
    await reloadSettings();
    setSavedTick((n) => n + 1);
  };

  const disconnectServer = async (name: string) => {
    if (projectId == null) return;
    clipCancel.current[name] = true;
    await window.agentdeck.disconnectProvider(projectId, name);
    await reloadSettings();
    setConnecting((c) => dropKey(c, name));
  };

  const cancelConnect = (name: string) => {
    clipCancel.current[name] = true;
    setConnecting((c) => dropKey(c, name));
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
    setSkills(await window.agentdeck.listSkills(projectId));
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
          <div className="h">Settings</div>
          {CATEGORIES.map((c) => (
            <button
              key={c.key}
              className={`cat ${category === c.key ? "on" : ""}`}
              onClick={() => setCategory(c.key)}
            >
              <i className={`ph ${c.icon}`} />
              {c.label}
            </button>
          ))}
          <div className="h" style={{ marginTop: 18 }}>Project</div>
          {projects.map((p) => (
            <button key={p.id} className={p.id === projectId ? "on" : ""} onClick={() => setProjectId(p.id)}>
              {p.name}
            </button>
          ))}
        </div>

        <div className="settings-panels">
          {category === "notifications" ? (
            <NotificationsPanel />
          ) : project == null || settings == null ? (
            <div className="full empty" style={{ margin: "40px auto" }}>
              {project == null ? "Pick a project." : "Loading…"}
            </div>
          ) : (
            <>
              {category === "overview" && (
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
                  <button
                    className="f-static mono dir-open"
                    title="Open in Finder"
                    onClick={() => window.agentdeck.openDir(project.dir)}
                  >
                    <span className="ell">{project.dir}</span>
                    <i className="ph ph-arrow-square-out" />
                  </button>
                  <div className="note">
                    Projects are directories under PROJECTS_ROOT (plus projects.json overrides) — rename or
                    move them on disk.
                  </div>
                </div>
              )}

              {category === "behavior" && (
                <>
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
                </>
              )}

              {category === "integrations" && (
                <>
                  <div className="panel full">
                    <div className="p-title">
                      <i className="ph ph-plugs-connected" />
                      MCP servers
                      <span className="p-hint">tools your agents can call — deploy, DB, mobile, cloud</span>
                    </div>

                    {settings.mcpServers.length > 0 && (
                      <div className="mcp-cards">
                        {settings.mcpServers.map((s) => (
                          <McpServerCard
                            key={s.name}
                            server={s}
                            meta={mcpMeta(s.provider)}
                            projectId={projectId!}
                            connect={connecting[s.name]}
                            onToggle={() => patchMcpServer(s.name, { enabled: !s.enabled })}
                            onRemove={() => patchMcpServer(s.name, null)}
                            onSecretsSaved={reloadSettings}
                            onGcloud={() => startGcloud(s.name)}
                            onTokenCapture={() => mcpMeta(s.provider) && startTokenCapture(s.name, mcpMeta(s.provider)!)}
                            onAppleImport={() => startAppleImport(s.name)}
                            onDisconnect={() => disconnectServer(s.name)}
                            onCancelConnect={() => cancelConnect(s.name)}
                          />
                        ))}
                      </div>
                    )}
                    {settings.mcpServers.length === 0 && (
                      <div className="note" style={{ marginTop: 0 }}>
                        None yet. Pick a provider below to wire one up. Enabled servers join every run in
                        this project, alongside the built-in approver{" "}
                        <span className="mono" style={{ fontSize: 10.5 }}>(+ chrome-devtools when BROWSER_MCP_ENABLED)</span>.
                      </div>
                    )}

                    <div className="mcp-catalog">
                      {MCP_CATALOG.map((p) => (
                        <button
                          key={p.key}
                          className={`mcp-chip ${mcpDraft?.provider === p.key ? "on" : ""}`}
                          onClick={() => startAdd(p)}
                        >
                          <i className={`ph ${p.icon}`} />
                          {p.label}
                        </button>
                      ))}
                    </div>

                    {mcpDraft && (
                      <McpAddCard
                        draft={mcpDraft}
                        setDraft={setMcpDraft}
                        onCancel={() => setMcpDraft(null)}
                        onAdd={commitAdd}
                      />
                    )}

                    <div className="note">
                      Pick a provider → Connect. Google Cloud opens a real sign-in (isolated per
                      connection, account pinned); token providers open their token page and capture it
                      from your clipboard; Apple imports a downloaded .p8. Credentials are stored encrypted
                      / isolated on this host and never returned to a client. Add multiple per project.
                    </div>
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

              {category === "knowledge" && (
                <>
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
                      placeholder={"Project facts agents should always know.\ne.g. Staging is at staging.foo.dev. The iOS build needs Xcode 16. The owner reviews all schema changes."}
                      onChange={(e) => setMemoryDraft(e.target.value)}
                      onBlur={() => {
                        if (memoryDraft !== settings.memory) patch({ memory: memoryDraft });
                      }}
                    />
                    <div className="note">Injected alongside the rules. Saves when you click away.</div>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── App-wide notifications (not per-project) ───────────────────────────────────
// Native OS notifications fire from the Electron main process when a comment
// lands on a ticket (from the lead or an agent) or an approval is requested —
// but only while the window isn't focused. This panel is the on/off switch
// (persisted + mirrored to main) plus a test button to trigger the macOS
// permission prompt and confirm they show up.
function NotificationsPanel() {
  const [enabled, setEnabled] = useState(loadNotifPref);
  const [tested, setTested] = useState(false);

  const toggle = () => {
    const next = !enabled;
    setEnabled(next);
    try {
      localStorage.setItem(NOTIF_KEY, next ? "1" : "0");
    } catch {
      /* storage unavailable — the pref just won't persist */
    }
    window.agentdeck.setNotificationsEnabled?.(next);
  };

  const test = async () => {
    await window.agentdeck.testNotification?.();
    setTested(true);
    setTimeout(() => setTested(false), 2500);
  };

  return (
    <div className="panel">
      <div className="p-title">
        <i className="ph ph-bell" />
        Desktop notifications
      </div>
      <div className="toggle-row" style={{ marginTop: 0 }}>
        <button className={`toggle ${enabled ? "on" : ""}`} onClick={toggle} />
        <span>Notify me on the desktop</span>
      </div>
      <div className="note">
        A macOS notification when a comment lands on a ticket (from the team lead or an agent) or a
        run asks for approval — shown only while AgentDeck isn't the focused window. Click one to jump
        straight to the ticket or the Approvals inbox.
      </div>
      <div style={{ marginTop: 14 }}>
        <button className="btn btn-secondary small-btn" onClick={test} disabled={!enabled}>
          <i className="ph ph-paper-plane-tilt" /> Send a test notification
        </button>
        {tested && (
          <span className="ok-c" style={{ marginLeft: 10, fontSize: 11.5 }}>
            <i className="ph ph-check-circle" /> sent
          </span>
        )}
      </div>
      <div className="note" style={{ marginTop: 10 }}>
        First time, macOS asks for permission — allow it under System Settings → Notifications →
        AgentDeck if you missed the prompt.
      </div>
    </div>
  );
}

// ── One provider MCP server card (Integrations) ────────────────────────────────
// Shows the connection state: a live connect (signing in / waiting for a token),
// connected (account / token set) with Disconnect, or a Connect affordance
// matched to the provider's auth kind. A manual editor is the paste fallback.
function McpServerCard({
  server,
  meta,
  projectId,
  connect,
  onToggle,
  onRemove,
  onSecretsSaved,
  onGcloud,
  onTokenCapture,
  onAppleImport,
  onDisconnect,
  onCancelConnect,
}: {
  server: McpServerDef;
  meta: McpPreset | null;
  projectId: number;
  connect?: ConnectState;
  onToggle: () => void;
  onRemove: () => void;
  onSecretsSaved: () => void;
  onGcloud: () => void;
  onTokenCapture: () => void;
  onAppleImport: () => void;
  onDisconnect: () => void;
  onCancelConnect: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const kind = meta?.connect.kind ?? "none";
  const fields: McpSecretField[] =
    meta?.secrets && meta.secrets.length
      ? meta.secrets
      : (server.secretKeys ?? []).map((k) => ({ key: k, label: k }));
  const setKeys = new Set(server.secretsSet ?? []);
  const required = fields.filter((f) => !f.optional);
  const allRequiredSet = required.length > 0 && required.every((f) => setKeys.has(f.key));
  const anySet = setKeys.size > 0;
  const icon = meta?.icon ?? (server.transport === "http" ? "ph-globe" : "ph-plug");

  const connected =
    kind === "oauth-cli" ? !!server.account
      : kind === "key-file" ? allRequiredSet
        : kind === "token-page" ? anySet
          : false;
  const busy = connect && connect.state !== "failed";

  const saveManual = async () => {
    setSaving(true);
    for (const [k, v] of Object.entries(vals)) {
      if (v.trim()) await window.agentdeck.setProjectMcpSecret(projectId, server.name, k, v.trim());
    }
    setVals({});
    setSaving(false);
    setEditing(false);
    onSecretsSaved();
  };

  const statusChip = busy ? (
    <span className="mcp-tok pending">
      <i className="ph ph-circle-notch spin" />
      {connect!.state === "waiting" ? "waiting" : "signing in…"}
    </span>
  ) : connected ? (
    <span className="mcp-tok ok" title={server.account ?? undefined}>
      <i className="ph ph-check-circle" />
      {server.account ? shortAcct(server.account) : "connected"}
    </span>
  ) : kind === "cli" ? (
    <span className="mcp-tok cli" title={meta?.authNote}>
      <i className="ph ph-terminal" /> CLI auth
    </span>
  ) : kind === "none" ? null : (
    <span className="mcp-tok warn">
      <i className="ph ph-key" /> not connected
    </span>
  );

  return (
    <div className={`mcp-card ${server.enabled ? "" : "off"}`}>
      <div className="mcp-card-head">
        <i className={`ph ${icon} mcp-card-icon`} />
        <div className="body">
          <div className="n">
            {server.name}
            {server.environment && <span className="mcp-badge">{server.environment}</span>}
          </div>
          <div className="c mono" title={server.command ?? server.url}>
            {server.command ?? server.url}
          </div>
        </div>
        <div className="mcp-card-actions">
          {statusChip}
          <span className="tag tag-neutral" style={{ fontSize: 10 }}>
            {server.transport}
          </span>
          <button
            className={`toggle ${server.enabled ? "on" : ""}`}
            title={server.enabled ? "Disable" : "Enable"}
            onClick={onToggle}
          />
          <button className="mcp-x" title="Remove" onClick={onRemove}>
            <i className="ph ph-x" />
          </button>
        </div>
      </div>

      {(busy || connected || kind !== "none") && (
        <div className="mcp-card-foot">
          {busy ? (
            <div className="mcp-connecting">
              <span className="txt">
                {connect!.state === "waiting"
                  ? "Token page opened — copy your token and it connects automatically."
                  : "Opening your browser — finish signing in."}
              </span>
              {connect!.url && (
                <a className="mcp-docs" href={connect!.url} target="_blank" rel="noreferrer">
                  open sign-in <i className="ph ph-arrow-square-out" />
                </a>
              )}
              <button className="mcp-linkbtn" onClick={onCancelConnect}>
                Cancel
              </button>
            </div>
          ) : connected ? (
            <div className="mcp-connected-row">
              <span className="lbl">
                <i className="ph ph-shield-check" />
                {kind === "oauth-cli" && server.account ? `Connected · ${server.account}` : "Connected"}
              </span>
              {(kind === "oauth-cli" || kind === "token-page") && (
                <button className="mcp-linkbtn" onClick={kind === "oauth-cli" ? onGcloud : onTokenCapture}>
                  Reconnect
                </button>
              )}
              <button className="mcp-linkbtn danger" onClick={onDisconnect}>
                Disconnect
              </button>
            </div>
          ) : (
            <div className="mcp-connect-row">
              {connect?.state === "failed" && (
                <span className="mcp-err">
                  <i className="ph ph-warning-circle" /> {connect.error}
                </span>
              )}
              {kind === "oauth-cli" && (
                <button className="btn btn-primary small-btn" onClick={onGcloud}>
                  <i className="ph ph-google-logo" /> Connect with Google
                </button>
              )}
              {kind === "token-page" && (
                <>
                  <button className="btn btn-primary small-btn" onClick={onTokenCapture}>
                    <i className="ph ph-link-simple" /> Connect {meta?.label}
                  </button>
                  <button className="mcp-linkbtn" onClick={() => setEditing((e) => !e)}>
                    paste token
                  </button>
                </>
              )}
              {kind === "key-file" && (
                <>
                  {meta?.connect.portalUrl && (
                    <button className="btn btn-secondary small-btn" onClick={() => window.agentdeck.openExternal(meta.connect.portalUrl!)}>
                      <i className="ph ph-apple-logo" /> Apple portal
                    </button>
                  )}
                  <button className="btn btn-primary small-btn" onClick={onAppleImport}>
                    <i className="ph ph-upload-simple" /> Choose .p8
                  </button>
                  <button className="mcp-linkbtn" onClick={() => setEditing((e) => !e)}>
                    key id / issuer id
                  </button>
                </>
              )}
              {kind === "cli" && <span className="mcp-foot-note">{meta?.authNote}</span>}
            </div>
          )}
        </div>
      )}

      {editing && fields.length > 0 && (
        <div className="mcp-secret-edit">
          {fields
            .filter((f) => !(f.file && kind === "key-file"))
            .map((f) => (
              <div key={f.key} className="mcp-secret-row">
                <div className="f-label">
                  {f.label}
                  {setKeys.has(f.key) && <span className="mcp-set-dot"> · set</span>}
                  {f.optional && <span className="mcp-opt"> · optional</span>}
                </div>
                <input
                  className="f-static mono"
                  type={f.file ? "text" : "password"}
                  placeholder={setKeys.has(f.key) ? "•••••••• (leave blank to keep)" : f.hint ?? f.key}
                  value={vals[f.key] ?? ""}
                  onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))}
                />
              </div>
            ))}
          <div className="mcp-secret-actions">
            {meta?.docsUrl && (
              <a className="mcp-docs" href={meta.docsUrl} target="_blank" rel="noreferrer">
                where to get this <i className="ph ph-arrow-square-out" />
              </a>
            )}
            <button className="btn btn-ghost small-btn" disabled={saving} onClick={saveManual}>
              <i className="ph ph-check" /> Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── The "add MCP server" card shown after a catalog pick ───────────────────────
function McpAddCard({
  draft,
  setDraft,
  onCancel,
  onAdd,
}: {
  draft: McpDraft;
  setDraft: (d: McpDraft) => void;
  onCancel: () => void;
  onAdd: () => void;
}) {
  const preset = mcpMeta(draft.provider);
  const isCustom = draft.provider === "custom";
  const up = (p: Partial<McpDraft>) => setDraft({ ...draft, ...p });
  const canAdd = isCustom
    ? !!draft.command.trim()
    : draft.transport === "http"
      ? !!draft.url.trim()
      : !!draft.command.trim();

  return (
    <div className="mcp-addcard">
      <div className="mcp-addcard-head">
        <i className={`ph ${preset?.icon ?? "ph-plug"}`} />
        <span className="t">{isCustom ? "Custom MCP server" : `Add ${preset?.label}`}</span>
        <button className="mcp-x" title="Cancel" onClick={onCancel}>
          <i className="ph ph-x" />
        </button>
      </div>

      <div className="mcp-addcard-row">
        <div style={{ width: 150 }}>
          <div className="f-label">Name</div>
          <input
            className="f-static"
            placeholder="name"
            value={draft.name}
            onChange={(e) => up({ name: e.target.value })}
          />
        </div>
        <div style={{ flex: 1, minWidth: 120 }}>
          <div className="f-label">Environment <span className="mcp-opt">optional</span></div>
          <input
            className="f-static"
            placeholder="production / staging / preview"
            value={draft.environment}
            onChange={(e) => up({ environment: e.target.value })}
          />
        </div>
      </div>

      {isCustom ? (
        <div className="mcp-addcard-row">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="f-label">Command or URL</div>
            <input
              className="f-static mono"
              placeholder="npx some-mcp --flag   ·   or https://mcp.example.dev"
              value={draft.command}
              onChange={(e) => up({ command: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canAdd) onAdd();
              }}
            />
          </div>
        </div>
      ) : (
        <>
          <div className="mcp-authnote">
            <i className={`ph ${connectHint(preset).icon}`} /> {connectHint(preset).text}
          </div>
          {preset?.connect.kind === "token-page" && preset.secrets.length > 0 && (
            <div className="mcp-secret-edit flush">
              {preset.secrets.map((f) => (
                <div key={f.key} className="mcp-secret-row">
                  <div className="f-label">
                    {f.label}
                    {f.optional && <span className="mcp-opt"> · optional</span>}
                  </div>
                  <input
                    className="f-static mono"
                    type="password"
                    placeholder={`paste your ${f.label.toLowerCase()}`}
                    value={draft.secretVals[f.key] ?? ""}
                    onChange={(e) => up({ secretVals: { ...draft.secretVals, [f.key]: e.target.value } })}
                  />
                </div>
              ))}
              <div className="note" style={{ marginTop: 2 }}>
                Paste it here — or leave blank and click Add &amp; connect to grab it from the token page via your clipboard.
              </div>
            </div>
          )}
          <button className="mcp-adv-toggle" onClick={() => up({ advanced: !draft.advanced })}>
            <i className={`ph ${draft.advanced ? "ph-caret-down" : "ph-caret-right"}`} /> Advanced
          </button>
          {draft.advanced && (
            <div className="mcp-addcard-row">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="f-label">{draft.transport === "http" ? "URL" : "Command"}</div>
                <input
                  className="f-static mono"
                  value={draft.transport === "http" ? draft.url : draft.command}
                  onChange={(e) =>
                    up(draft.transport === "http" ? { url: e.target.value } : { command: e.target.value })
                  }
                />
                <div className="note" style={{ marginTop: 6 }}>
                  {draft.provider === "firebase"
                    ? "Prefilled with this project's directory."
                    : draft.provider === "supabase"
                      ? "Replace YOUR_REF with your Supabase project ref."
                      : "Prefilled from the provider — edit if you need custom flags."}
                </div>
              </div>
            </div>
          )}
        </>
      )}

      <div className="mcp-addcard-foot">
        <button className="btn btn-ghost small-btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-primary small-btn" disabled={!canAdd} onClick={onAdd}>
          <i className="ph ph-plus" />{" "}
          {preset?.connect.kind === "oauth-cli" || preset?.connect.kind === "token-page"
            ? "Add & connect"
            : preset?.connect.kind === "key-file"
              ? "Add & set up"
              : "Add server"}
        </button>
      </div>
    </div>
  );
}

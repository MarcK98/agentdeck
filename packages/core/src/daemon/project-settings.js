// Per-project settings + secrets (decisions #5 and #9).
//
// Settings persist in SQLite (project_settings, v2 migration); secrets do NOT.
// Two hard rules enforced by the split below:
//   - `settings` are client-visible and JSON-safe (fed to the settings page).
//   - `secrets` are daemon-side ONLY: injected into agent runs as env/config,
//     never returned by a daemon method, never in an event, never to a
//     remote/mobile client. getProjectSettings() therefore returns settings
//     WITHOUT secrets by construction, not by filtering.

import * as db from "../db/index.js";

const DEFAULTS = {
  approvalMode: "prompt", // "prompt" | "auto" — per project, no global default
  allowedModels: ["haiku", "sonnet", "opus"], // fable requires explicit opt-in
  defaultModel: "", // empty = harness default
  defaultEffort: "", // empty = harness default; per-run opts still win
  isolation: true, // worktree-per-ticket for delegations into git projects
  // Per-project MCP servers, merged into every run's --mcp-config when
  // enabled: {name, transport: "stdio"|"http", command?, url?, enabled}.
  // `command` is one shell-like line (tokenized daemon-side). No env/secrets
  // here by the settings-table rule — servers inherit the daemon's env.
  mcpServers: [],
  // Skills the agent may NOT use in this project (denied via
  // --disallowedTools "Skill(name)"). Everything discovered is allowed by
  // default; this is the unchecked set in the settings UI.
  disabledSkills: [],
  // Standing instructions for every run in this project (how to behave).
  // Injected via --append-system-prompt; independent of the repo's CLAUDE.md.
  rules: "",
  // Durable project facts/context agents should always know (what's true).
  // Injected alongside rules.
  memory: "",
  // The project's wiring: accounts, cloud projects, deploy targets.
  // {id, type, label, value, url?, secretEnv?, notes?} — `value` is the
  // non-secret identifier (email, project id, app name). Secret material
  // NEVER lives here; `secretEnv` just names the daemon env var that carries
  // the token, so agents know which one to use.
  connections: [],
};

// Secrets stay in-memory on purpose: Phase 1 ships no secret-editing UI, and
// they must never touch the settings table.
const secretsByProject = new Map(); // projectId -> {KEY: value} — never leaves the daemon

export function getProjectSettings(projectId) {
  return { ...DEFAULTS, ...db.getProjectSettingsRow(projectId) };
}

export function updateProjectSettings(projectId, patch) {
  const clean = { ...patch };
  delete clean.secrets; // secrets have their own write path, never this one
  db.upsertProjectSettings(projectId, { ...getProjectSettings(projectId), ...clean });
  return getProjectSettings(projectId);
}

// Daemon-internal: resolve secrets to inject into a run's environment.
export function getProjectSecrets(projectId) {
  return { ...(secretsByProject.get(projectId) ?? {}) };
}

export function setProjectSecret(projectId, key, value) {
  const cur = secretsByProject.get(projectId) ?? {};
  secretsByProject.set(projectId, { ...cur, [key]: value });
  return true; // never echo the value back
}

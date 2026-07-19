// Per-project settings + secrets.
//
// Settings persist in SQLite (project_settings, v2 migration) as a client-safe
// JSON blob. MCP secrets (the tokens users paste on the settings page) persist
// SEPARATELY, encrypted at rest (project_secrets, v4 + secrets.js). Two hard
// rules still hold:
//   - `settings` are client-visible and JSON-safe (fed to the settings page).
//   - secret VALUES are daemon-side ONLY: decrypted just to inject into agent
//     runs, never returned by a daemon method, never in an event, never to a
//     remote/mobile client. getProjectSettings() returns, per MCP server, only
//     WHICH secret keys are set (`secretsSet`) — never the values.

import * as db from "../db/index.js";
import { encrypt, decrypt } from "../secrets.js";

const DEFAULTS = {
  approvalMode: "prompt", // "prompt" | "auto" — per project, no global default
  allowedModels: ["haiku", "sonnet", "opus"], // fable requires explicit opt-in
  defaultModel: "", // empty = harness default
  defaultEffort: "", // empty = harness default; per-run opts still win
  isolation: true, // worktree-per-ticket for delegations into git projects
  // Per-project MCP servers, merged into every run's --mcp-config when
  // enabled: {name, transport, command?, url?, enabled, provider?,
  // environment?, secretKeys?, env?}. `command` is one shell-like line
  // (tokenized daemon-side). Token values live in project_secrets (encrypted),
  // keyed by `mcp:<name>:<ENV_KEY>`, and are injected as env/headers at run time
  // — never stored in this blob, never returned to a client.
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

const secretKeyFor = (serverName, envKey) => `mcp:${serverName}:${envKey}`;
const mcpPrefix = (serverName) => `mcp:${serverName}:`;

// Env keys currently set for an MCP server (booleans only — values stay hidden).
function secretsSetFor(projectId, serverName) {
  const prefix = mcpPrefix(serverName);
  return db
    .listSecretKeys(projectId, prefix)
    .map((k) => k.slice(prefix.length));
}

export function getProjectSettings(projectId) {
  const merged = { ...DEFAULTS, ...db.getProjectSettingsRow(projectId) };
  // Augment each MCP server with which of its secrets are set — never values.
  merged.mcpServers = (merged.mcpServers ?? []).map((s) => ({
    ...s,
    secretsSet: secretsSetFor(projectId, s.name),
  }));
  return merged;
}

export function updateProjectSettings(projectId, patch) {
  const clean = { ...patch };
  delete clean.secrets; // secret values have their own write path, never this one
  // Strip the daemon-computed field so it never round-trips into the blob.
  if (Array.isArray(clean.mcpServers)) {
    clean.mcpServers = clean.mcpServers.map(({ secretsSet, ...rest }) => rest);
  }
  const prev = getProjectSettings(projectId);
  db.upsertProjectSettings(projectId, { ...prev, ...clean });
  // Prune secrets belonging to MCP servers that were just removed.
  if (Array.isArray(clean.mcpServers)) {
    const kept = new Set(clean.mcpServers.map((s) => s.name));
    for (const s of prev.mcpServers ?? []) {
      if (!kept.has(s.name)) db.deleteSecretsByPrefix(projectId, mcpPrefix(s.name));
    }
  }
  return getProjectSettings(projectId);
}

// Set (or clear, when value is empty) one MCP secret. Returns a boolean; the
// value is never echoed back.
export function setProjectMcpSecret(projectId, serverName, envKey, value) {
  if (!serverName || !envKey) return false;
  const key = secretKeyFor(serverName, envKey);
  if (value == null || value === "") {
    db.deleteSecret(projectId, key);
  } else {
    db.setSecret(projectId, key, encrypt(value));
  }
  return true;
}

export function clearProjectMcpSecret(projectId, serverName, envKey) {
  db.deleteSecret(projectId, secretKeyFor(serverName, envKey));
  return true;
}

// Daemon-internal: decrypt a server's secrets to inject into a run
// (env for stdio, Authorization header for http). Returns {ENV_KEY: value}.
export function getProjectMcpSecrets(projectId, serverName) {
  const prefix = mcpPrefix(serverName);
  const out = {};
  for (const k of db.listSecretKeys(projectId, prefix)) {
    const plain = decrypt(db.getSecret(projectId, k));
    if (plain != null) out[k.slice(prefix.length)] = plain;
  }
  return out;
}

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "./config.js";
import { log } from "./logger.js";

// Optional explicit overrides: projects.json in the repo root
//   { "channel-name-or-id": "/absolute/path/to/project", ... }
const PROJECTS_FILE = new URL("../projects.json", import.meta.url);

let overrides = {};
try {
  overrides = JSON.parse(readFileSync(PROJECTS_FILE, "utf8"));
} catch {
  /* optional file */
}

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const warned = new Set();

/**
 * Resolve a Discord channel to a project directory.
 * Order: explicit override by channel ID -> override by channel name
 *        -> <PROJECTS_ROOT>/<channel name> -> default project -> null
 */
export function resolveProject({ channelId, channelName, isDM }) {
  const { root, defaultDir } = config.projects;

  const candidates = [];
  if (overrides[channelId]) candidates.push(resolve(overrides[channelId]));
  if (channelName && overrides[channelName])
    candidates.push(resolve(overrides[channelName]));
  if (!isDM && channelName && root) candidates.push(join(root, channelName));
  if (defaultDir) candidates.push(resolve(defaultDir));

  for (const dir of candidates) {
    if (isDir(dir)) return dir;
  }

  const key = channelId;
  if (!warned.has(key)) {
    warned.add(key);
    log.warn(
      `No project dir for #${channelName ?? channelId} (tried: ${candidates.join(", ") || "nothing configured"}) — ignoring this channel.`
    );
  }
  return null;
}

export const projectExists = (p) => existsSync(p);

import { config } from "./config.js";
import { log } from "./logger.js";
import { startDiscord } from "./channels/discord.js";
import { startPermissionServer } from "./permission-server.js";

// Adapter registry — add telegram/slack/whatsapp here later.
// Each adapter is an async function that starts listening and
// returns a stop() function.
const ADAPTERS = {
  discord: startDiscord,
};

const stops = [];

async function main() {
  log.info("claude-channel-bridge starting…");
  log.info(`Claude cwd: ${config.claude.cwd}`);

  if (config.approvals.enabled) {
    stops.push(await startPermissionServer());
  }

  for (const name of config.channels) {
    const start = ADAPTERS[name];
    if (!start) {
      log.warn(`Unknown channel "${name}" — skipping. Known: ${Object.keys(ADAPTERS).join(", ")}`);
      continue;
    }
    try {
      stops.push(await start());
      log.info(`[${name}] adapter started`);
    } catch (err) {
      log.error(`[${name}] failed to start:`, err.message);
    }
  }

  if (!stops.length) {
    log.error("No channel adapters running — check your .env. Exiting.");
    process.exit(1);
  }
}

const shutdown = async (signal) => {
  log.info(`${signal} received, shutting down…`);
  await Promise.allSettled(stops.map((stop) => stop()));
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main();

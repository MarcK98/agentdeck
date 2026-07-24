import { spawn } from "node:child_process";
import { createServer } from "vite";

// Dev launcher: Vite dev server + Electron pointed at it. One command
// (`npm run desktop` at the repo root), no extra process-manager deps.
const vite = await createServer();
await vite.listen();
const url = vite.resolvedUrls.local[0];
console.log(`[desktop] vite dev server: ${url}`);

const electron = spawn("npx", ["electron", "."], {
  stdio: "inherit",
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});
electron.on("close", async (code) => {
  await vite.close();
  process.exit(code ?? 0);
});

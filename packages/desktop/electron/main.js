import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { ensureDaemon, rpc, subscribeEvents } from "./daemon-client.js";

// Spawn desktop — a client of the Spawn daemon (its own background process,
// see @spawn/core daemon/server.js). This process holds NO sessions and no
// database; it renders state and relays daemon events to the window. The
// renderer talks through the preload IPC surface, which mirrors the daemon
// API 1:1.

const __dirname = fileURLToPath(new URL(".", import.meta.url));

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    title: "Spawn",
    backgroundColor: "#1e1f22",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(join(__dirname, "..", "dist", "index.html"));
  }
}

// IPC surface = daemon RPC, JSON in/out only.
ipcMain.handle("spawn:listProjects", () => rpc("listProjects"));
ipcMain.handle("spawn:listThreads", (_e, projectId) => rpc("listThreads", projectId));
ipcMain.handle("spawn:createThread", (_e, args) => rpc("createThread", args));
ipcMain.handle("spawn:renameThread", (_e, threadId, title) => rpc("renameThread", threadId, title));
ipcMain.handle("spawn:listMessages", (_e, threadId, opts) => rpc("listMessages", threadId, opts));
ipcMain.handle("spawn:sendMessage", (_e, threadId, text) => rpc("sendMessage", threadId, text));
ipcMain.handle("spawn:cancelTurn", (_e, threadId) => rpc("cancelTurn", threadId));
ipcMain.handle("spawn:resolveApproval", (_e, id, allow, updatedInput) =>
  rpc("resolveApproval", id, allow, updatedInput)
);
ipcMain.handle("spawn:getProjectSettings", (_e, projectId) => rpc("getProjectSettings", projectId));
ipcMain.handle("spawn:updateProjectSettings", (_e, projectId, patch) =>
  rpc("updateProjectSettings", projectId, patch)
);

app.whenReady().then(async () => {
  // CI/agent smoke: prove daemon spawn + RPC round-trip, then exit.
  if (process.env.SPAWN_SMOKE) {
    try {
      const boot = await ensureDaemon();
      const projects = await rpc("listProjects");
      console.log(
        `SPAWN_SMOKE ok: daemon ${boot.started ? "spawned" : "already up"}, ${projects.length} projects`
      );
      app.exit(0);
    } catch (err) {
      console.error(`SPAWN_SMOKE failed: ${err.message}`);
      app.exit(1);
    }
    return;
  }

  await ensureDaemon();
  subscribeEvents((ev) => win?.webContents.send("spawn:event", ev));
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

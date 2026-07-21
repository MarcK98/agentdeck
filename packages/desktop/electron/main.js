import { app, BrowserWindow, ipcMain, shell, clipboard, dialog } from "electron";
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
    // Nocturne ground (--color-bg) — also paints the pre-load flash.
    backgroundColor: "#161826",
    // No native (white) title bar: traffic lights float over the app's own
    // dark top bar, which is a drag region (see .topbar in app.css).
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // External links (board card click-throughs) open in the OS browser —
  // never as a new Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
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
ipcMain.handle("spawn:listAllThreads", () => rpc("listAllThreads"));
ipcMain.handle("spawn:createThread", (_e, args) => rpc("createThread", args));
ipcMain.handle("spawn:renameThread", (_e, threadId, title) => rpc("renameThread", threadId, title));
ipcMain.handle("spawn:setThreadStatus", (_e, threadId, status) => rpc("setThreadStatus", threadId, status));
ipcMain.handle("spawn:deleteThread", (_e, threadId) => rpc("deleteThread", threadId));
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
ipcMain.handle("spawn:setProjectMcpSecret", (_e, projectId, serverName, envKey, value) =>
  rpc("setProjectMcpSecret", projectId, serverName, envKey, value)
);
ipcMain.handle("spawn:clearProjectMcpSecret", (_e, projectId, serverName, envKey) =>
  rpc("clearProjectMcpSecret", projectId, serverName, envKey)
);
ipcMain.handle("spawn:listTickets", () => rpc("listTickets"));
ipcMain.handle("spawn:createTicket", (_e, args) => rpc("createTicket", args));
ipcMain.handle("spawn:updateTicket", (_e, ticketId, patch) => rpc("updateTicket", ticketId, patch));
ipcMain.handle("spawn:deleteTicket", (_e, ticketId) => rpc("deleteTicket", ticketId));
ipcMain.handle("spawn:delegateTicket", (_e, ticketId, opts) => rpc("delegateTicket", ticketId, opts));
ipcMain.handle("spawn:getTicket", (_e, ticketId) => rpc("getTicket", ticketId));
ipcMain.handle("spawn:listTicketComments", (_e, ticketId) => rpc("listTicketComments", ticketId));
// Desktop comments are always authored by the human (server-enforced kind).
ipcMain.handle("spawn:addTicketComment", (_e, ticketId, body) =>
  rpc("addTicketComment", ticketId, { authorKind: "human", authorName: "you", body })
);
ipcMain.handle("spawn:listTicketAttachments", (_e, ticketId) => rpc("listTicketAttachments", ticketId));
ipcMain.handle("spawn:addTicketAttachment", (_e, ticketId, sourcePath) =>
  rpc("addTicketAttachment", ticketId, sourcePath, "you")
);
ipcMain.handle("spawn:getTeamLeadProject", () => rpc("getTeamLeadProject"));
ipcMain.handle("spawn:delegateTask", (_e, args) => rpc("delegateTask", args));
ipcMain.handle("spawn:listActiveThreads", () => rpc("listActiveThreads"));
ipcMain.handle("spawn:getThreadContext", (_e, threadId) => rpc("getThreadContext", threadId));
ipcMain.handle("spawn:cleanupThread", (_e, threadId, force) => rpc("cleanupThread", threadId, force));
ipcMain.handle("spawn:getMap", () => rpc("getMap"));
ipcMain.handle("spawn:listApprovals", () => rpc("listApprovals"));
ipcMain.handle("spawn:listDecisions", () => rpc("listDecisions"));
ipcMain.handle("spawn:getUsage", (_e, days) => rpc("getUsage", days));
ipcMain.handle("spawn:resetThreadSession", (_e, threadId) => rpc("resetThreadSession", threadId));
ipcMain.handle("spawn:listSkills", (_e, projectId) => rpc("listSkills", projectId));
ipcMain.handle("spawn:listDeliverables", (_e, threadId) => rpc("listDeliverables", threadId));
// Finder integration — local shell, not daemon RPC.
ipcMain.handle("spawn:openDir", (_e, dir) => shell.openPath(dir));
ipcMain.handle("spawn:revealFile", (_e, p) => shell.showItemInFolder(p));

// Provider connect — local host capabilities (browser, clipboard, file picker).
// Not daemon RPC: they touch the machine the user is sitting at.
ipcMain.handle("spawn:openExternal", (_e, url) =>
  /^https?:/i.test(url) ? shell.openExternal(url) : Promise.resolve()
);
ipcMain.handle("spawn:readClipboard", () => clipboard.readText());
ipcMain.handle("spawn:pickFile", async (_e, opts) => {
  const res = await dialog.showOpenDialog(win, {
    properties: ["openFile"],
    filters: opts?.filters ?? [],
  });
  return res.canceled ? null : res.filePaths[0] ?? null;
});
// Connect flows that need the daemon (cred isolation, gcloud login) — rpc.
ipcMain.handle("spawn:connectGcloud", (_e, projectId, serverName) =>
  rpc("connectGcloud", projectId, serverName)
);
ipcMain.handle("spawn:importAppleKey", (_e, projectId, serverName, sourcePath) =>
  rpc("importAppleKey", projectId, serverName, sourcePath)
);
ipcMain.handle("spawn:disconnectProvider", (_e, projectId, serverName) =>
  rpc("disconnectProvider", projectId, serverName)
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

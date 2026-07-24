import { app, BrowserWindow, ipcMain, shell, clipboard, dialog, Notification } from "electron";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { ensureDaemon, rpc, subscribeEvents } from "./daemon-client.js";

// AgentDeck desktop — a client of the AgentDeck daemon (its own background process,
// see @agentdeck/core daemon/server.js). This process holds NO sessions and no
// database; it renders state and relays daemon events to the window. The
// renderer talks through the preload IPC surface, which mirrors the daemon
// API 1:1.

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// The OS notification header/app label (macOS uses the app name; Windows needs
// an explicit AppUserModelID) — otherwise dev builds surface as "Electron".
app.setName("AgentDeck");
if (process.platform === "win32") app.setAppUserModelId("com.agentdeck.desktop");

let win = null;

// ── Native notifications ────────────────────────────────────────────────
// The main process is the only place that (a) sees every daemon event even
// when the window is hidden/minimized and (b) can raise + focus the window on
// click. We fire an OS notification for the events worth interrupting for — a
// new ticket comment (from the lead or a working agent, never your own) and an
// approval request — but ONLY while the window isn't focused, so we never
// duplicate what's already on screen. Toggleable from Settings (the renderer
// pushes the pref over IPC on boot and whenever it changes).
let notificationsEnabled = true;

const AUTHOR_LABEL = { human: "you", lead: "Team lead", agent: "Agent" };
const oneLine = (s, n = 140) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// Raise the window (restoring/showing if needed), then tell the renderer where
// to navigate for the thing that was clicked.
const focusTo = (payload) => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.webContents.send("agentdeck:notify-click", payload);
};

const showNotification = ({ title, subtitle, body, onClick }) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, subtitle, body });
  if (onClick) n.on("click", onClick);
  n.show();
};

// Decide whether a daemon event deserves an OS notification, and fire it.
// Best-effort and fire-and-forget: a failure here must never break the event
// stream feeding the renderer.
async function maybeNotify(ev) {
  if (!notificationsEnabled || !win || win.isFocused()) return;
  try {
    if (ev.type === "ticket:comment") {
      const { ticketId, comment } = ev.payload ?? {};
      // Only surface comments from the lead/agents — not the human's own.
      if (!comment || comment.author_kind === "human") return;
      const ticket = await rpc("getTicket", ticketId).catch(() => null);
      const who = AUTHOR_LABEL[comment.author_kind] ?? comment.author_kind;
      showNotification({
        title: `New comment · SPWN-${ticketId}`,
        subtitle: ticket ? `${ticket.title} · ${ticket.project_name}` : undefined,
        body: `${who}: ${oneLine(comment.body)}`,
        onClick: () => focusTo({ kind: "ticket", ticketId }),
      });
    } else if (ev.type === "approval:request") {
      const { id, tool, threadId } = ev.payload ?? {};
      showNotification({
        title: "Approval needed",
        body: `${tool ?? "A tool"} wants to run`,
        onClick: () => focusTo({ kind: "approval", id, threadId }),
      });
    }
  } catch {
    /* a notification is best-effort */
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    title: "AgentDeck",
    // Nocturne ground (--color-bg) — also paints the pre-load flash.
    backgroundColor: "#0b0c1a",
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
ipcMain.handle("agentdeck:listProjects", () => rpc("listProjects"));
ipcMain.handle("agentdeck:listThreads", (_e, projectId) => rpc("listThreads", projectId));
ipcMain.handle("agentdeck:listAllThreads", () => rpc("listAllThreads"));
ipcMain.handle("agentdeck:createThread", (_e, args) => rpc("createThread", args));
ipcMain.handle("agentdeck:renameThread", (_e, threadId, title) => rpc("renameThread", threadId, title));
ipcMain.handle("agentdeck:setThreadStatus", (_e, threadId, status) => rpc("setThreadStatus", threadId, status));
ipcMain.handle("agentdeck:deleteThread", (_e, threadId) => rpc("deleteThread", threadId));
ipcMain.handle("agentdeck:listMessages", (_e, threadId, opts) => rpc("listMessages", threadId, opts));
ipcMain.handle("agentdeck:sendMessage", (_e, threadId, text) => rpc("sendMessage", threadId, text));
ipcMain.handle("agentdeck:cancelTurn", (_e, threadId) => rpc("cancelTurn", threadId));
ipcMain.handle("agentdeck:resolveApproval", (_e, id, allow, updatedInput) =>
  rpc("resolveApproval", id, allow, updatedInput)
);
ipcMain.handle("agentdeck:getProjectSettings", (_e, projectId) => rpc("getProjectSettings", projectId));
ipcMain.handle("agentdeck:updateProjectSettings", (_e, projectId, patch) =>
  rpc("updateProjectSettings", projectId, patch)
);
ipcMain.handle("agentdeck:setProjectMcpSecret", (_e, projectId, serverName, envKey, value) =>
  rpc("setProjectMcpSecret", projectId, serverName, envKey, value)
);
ipcMain.handle("agentdeck:clearProjectMcpSecret", (_e, projectId, serverName, envKey) =>
  rpc("clearProjectMcpSecret", projectId, serverName, envKey)
);
ipcMain.handle("agentdeck:listTickets", () => rpc("listTickets"));
ipcMain.handle("agentdeck:createTicket", (_e, args) => rpc("createTicket", args));
ipcMain.handle("agentdeck:updateTicket", (_e, ticketId, patch) => rpc("updateTicket", ticketId, patch));
ipcMain.handle("agentdeck:deleteTicket", (_e, ticketId) => rpc("deleteTicket", ticketId));
ipcMain.handle("agentdeck:delegateTicket", (_e, ticketId, opts) => rpc("delegateTicket", ticketId, opts));
ipcMain.handle("agentdeck:getTicket", (_e, ticketId) => rpc("getTicket", ticketId));
ipcMain.handle("agentdeck:listTicketComments", (_e, ticketId) => rpc("listTicketComments", ticketId));
// Desktop comments are always authored by the human (server-enforced kind).
ipcMain.handle("agentdeck:addTicketComment", (_e, ticketId, body) =>
  rpc("addTicketComment", ticketId, { authorKind: "human", authorName: "you", body })
);
ipcMain.handle("agentdeck:listTicketAttachments", (_e, ticketId) => rpc("listTicketAttachments", ticketId));
ipcMain.handle("agentdeck:addTicketAttachment", (_e, ticketId, sourcePath) =>
  rpc("addTicketAttachment", ticketId, sourcePath, "you")
);
ipcMain.handle("agentdeck:getTeamLeadProject", () => rpc("getTeamLeadProject"));
ipcMain.handle("agentdeck:delegateTask", (_e, args) => rpc("delegateTask", args));
ipcMain.handle("agentdeck:listActiveThreads", () => rpc("listActiveThreads"));
ipcMain.handle("agentdeck:getThreadContext", (_e, threadId) => rpc("getThreadContext", threadId));
ipcMain.handle("agentdeck:getThreadDiff", (_e, threadId) => rpc("getThreadDiff", threadId));
ipcMain.handle("agentdeck:getThreadFileDiff", (_e, threadId, path) => rpc("getThreadFileDiff", threadId, path));
ipcMain.handle("agentdeck:cleanupThread", (_e, threadId, force) => rpc("cleanupThread", threadId, force));
ipcMain.handle("agentdeck:getMap", () => rpc("getMap"));
ipcMain.handle("agentdeck:listApprovals", () => rpc("listApprovals"));
ipcMain.handle("agentdeck:listDecisions", () => rpc("listDecisions"));
ipcMain.handle("agentdeck:getUsage", (_e, days) => rpc("getUsage", days));
ipcMain.handle("agentdeck:resetThreadSession", (_e, threadId) => rpc("resetThreadSession", threadId));
ipcMain.handle("agentdeck:listSkills", (_e, projectId) => rpc("listSkills", projectId));
ipcMain.handle("agentdeck:listDeliverables", (_e, threadId) => rpc("listDeliverables", threadId));
// Finder integration — local shell, not daemon RPC.
ipcMain.handle("agentdeck:openDir", (_e, dir) => shell.openPath(dir));
ipcMain.handle("agentdeck:revealFile", (_e, p) => shell.showItemInFolder(p));

// Native notifications — a host capability, not daemon RPC. The renderer owns
// the on/off preference (localStorage) and pushes it here; the test button
// fires one immediately, bypassing the focus gate so it works with the app in
// the foreground (also nudges macOS to ask for notification permission).
ipcMain.handle("agentdeck:setNotificationsEnabled", (_e, on) => {
  notificationsEnabled = !!on;
});
ipcMain.handle("agentdeck:testNotification", () => {
  showNotification({
    title: "AgentDeck notifications are on",
    body: "You'll be pinged here when a comment lands on a ticket.",
    onClick: () => focusTo({ kind: "test" }),
  });
});

// Provider connect — local host capabilities (browser, clipboard, file picker).
// Not daemon RPC: they touch the machine the user is sitting at.
ipcMain.handle("agentdeck:openExternal", (_e, url) =>
  /^https?:/i.test(url) ? shell.openExternal(url) : Promise.resolve()
);
ipcMain.handle("agentdeck:readClipboard", () => clipboard.readText());
ipcMain.handle("agentdeck:pickFile", async (_e, opts) => {
  const res = await dialog.showOpenDialog(win, {
    properties: ["openFile"],
    filters: opts?.filters ?? [],
  });
  return res.canceled ? null : res.filePaths[0] ?? null;
});
// Connect flows that need the daemon (cred isolation, gcloud login) — rpc.
ipcMain.handle("agentdeck:connectGcloud", (_e, projectId, serverName) =>
  rpc("connectGcloud", projectId, serverName)
);
ipcMain.handle("agentdeck:importAppleKey", (_e, projectId, serverName, sourcePath) =>
  rpc("importAppleKey", projectId, serverName, sourcePath)
);
ipcMain.handle("agentdeck:disconnectProvider", (_e, projectId, serverName) =>
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
  subscribeEvents((ev) => {
    win?.webContents.send("agentdeck:event", ev);
    maybeNotify(ev);
  });
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

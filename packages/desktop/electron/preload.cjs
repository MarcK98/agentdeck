const { contextBridge, ipcRenderer } = require("electron");

// The renderer's ONLY door to the daemon. Mirrors the daemon method surface;
// keep it dumb — no logic here, so a future remote transport slots in behind
// the same window.agentdeck API.
contextBridge.exposeInMainWorld("agentdeck", {
  listProjects: () => ipcRenderer.invoke("agentdeck:listProjects"),
  listThreads: (projectId) => ipcRenderer.invoke("agentdeck:listThreads", projectId),
  listAllThreads: () => ipcRenderer.invoke("agentdeck:listAllThreads"),
  createThread: (args) => ipcRenderer.invoke("agentdeck:createThread", args),
  renameThread: (threadId, title) => ipcRenderer.invoke("agentdeck:renameThread", threadId, title),
  setThreadStatus: (threadId, status) => ipcRenderer.invoke("agentdeck:setThreadStatus", threadId, status),
  deleteThread: (threadId) => ipcRenderer.invoke("agentdeck:deleteThread", threadId),
  listMessages: (threadId, opts) => ipcRenderer.invoke("agentdeck:listMessages", threadId, opts),
  sendMessage: (threadId, text) => ipcRenderer.invoke("agentdeck:sendMessage", threadId, text),
  cancelTurn: (threadId) => ipcRenderer.invoke("agentdeck:cancelTurn", threadId),
  resolveApproval: (id, allow, updatedInput) =>
    ipcRenderer.invoke("agentdeck:resolveApproval", id, allow, updatedInput),
  getProjectSettings: (projectId) => ipcRenderer.invoke("agentdeck:getProjectSettings", projectId),
  updateProjectSettings: (projectId, patch) =>
    ipcRenderer.invoke("agentdeck:updateProjectSettings", projectId, patch),
  setProjectMcpSecret: (projectId, serverName, envKey, value) =>
    ipcRenderer.invoke("agentdeck:setProjectMcpSecret", projectId, serverName, envKey, value),
  clearProjectMcpSecret: (projectId, serverName, envKey) =>
    ipcRenderer.invoke("agentdeck:clearProjectMcpSecret", projectId, serverName, envKey),
  openExternal: (url) => ipcRenderer.invoke("agentdeck:openExternal", url),
  readClipboard: () => ipcRenderer.invoke("agentdeck:readClipboard"),
  pickFile: (opts) => ipcRenderer.invoke("agentdeck:pickFile", opts),
  connectGcloud: (projectId, serverName) =>
    ipcRenderer.invoke("agentdeck:connectGcloud", projectId, serverName),
  importAppleKey: (projectId, serverName, sourcePath) =>
    ipcRenderer.invoke("agentdeck:importAppleKey", projectId, serverName, sourcePath),
  disconnectProvider: (projectId, serverName) =>
    ipcRenderer.invoke("agentdeck:disconnectProvider", projectId, serverName),
  listTickets: () => ipcRenderer.invoke("agentdeck:listTickets"),
  createTicket: (args) => ipcRenderer.invoke("agentdeck:createTicket", args),
  updateTicket: (ticketId, patch) => ipcRenderer.invoke("agentdeck:updateTicket", ticketId, patch),
  deleteTicket: (ticketId) => ipcRenderer.invoke("agentdeck:deleteTicket", ticketId),
  delegateTicket: (ticketId, opts) => ipcRenderer.invoke("agentdeck:delegateTicket", ticketId, opts),
  getTicket: (ticketId) => ipcRenderer.invoke("agentdeck:getTicket", ticketId),
  listTicketComments: (ticketId) => ipcRenderer.invoke("agentdeck:listTicketComments", ticketId),
  addTicketComment: (ticketId, body) => ipcRenderer.invoke("agentdeck:addTicketComment", ticketId, body),
  listTicketAttachments: (ticketId) => ipcRenderer.invoke("agentdeck:listTicketAttachments", ticketId),
  addTicketAttachment: (ticketId, sourcePath) => ipcRenderer.invoke("agentdeck:addTicketAttachment", ticketId, sourcePath),
  getTeamLeadProject: () => ipcRenderer.invoke("agentdeck:getTeamLeadProject"),
  delegateTask: (args) => ipcRenderer.invoke("agentdeck:delegateTask", args),
  listActiveThreads: () => ipcRenderer.invoke("agentdeck:listActiveThreads"),
  getThreadContext: (threadId) => ipcRenderer.invoke("agentdeck:getThreadContext", threadId),
  cleanupThread: (threadId, force) => ipcRenderer.invoke("agentdeck:cleanupThread", threadId, force),
  getMap: () => ipcRenderer.invoke("agentdeck:getMap"),
  listApprovals: () => ipcRenderer.invoke("agentdeck:listApprovals"),
  listDecisions: () => ipcRenderer.invoke("agentdeck:listDecisions"),
  getUsage: (days) => ipcRenderer.invoke("agentdeck:getUsage", days),
  resetThreadSession: (threadId) => ipcRenderer.invoke("agentdeck:resetThreadSession", threadId),
  listSkills: (projectId) => ipcRenderer.invoke("agentdeck:listSkills", projectId),
  listDeliverables: (threadId) => ipcRenderer.invoke("agentdeck:listDeliverables", threadId),
  openDir: (dir) => ipcRenderer.invoke("agentdeck:openDir", dir),
  revealFile: (p) => ipcRenderer.invoke("agentdeck:revealFile", p),
  setNotificationsEnabled: (on) => ipcRenderer.invoke("agentdeck:setNotificationsEnabled", on),
  testNotification: () => ipcRenderer.invoke("agentdeck:testNotification"),
  onEvent: (fn) => {
    const handler = (_e, ev) => fn(ev);
    ipcRenderer.on("agentdeck:event", handler);
    return () => ipcRenderer.removeListener("agentdeck:event", handler);
  },
  // Fired when the user clicks an OS notification — App uses it to navigate to
  // the ticket / approvals inbox the notification was about.
  onNotificationClick: (fn) => {
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on("agentdeck:notify-click", handler);
    return () => ipcRenderer.removeListener("agentdeck:notify-click", handler);
  },
});

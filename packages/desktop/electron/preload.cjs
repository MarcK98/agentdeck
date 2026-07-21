const { contextBridge, ipcRenderer } = require("electron");

// The renderer's ONLY door to the daemon. Mirrors the daemon method surface;
// keep it dumb — no logic here, so a future remote transport slots in behind
// the same window.spawn API.
contextBridge.exposeInMainWorld("spawn", {
  listProjects: () => ipcRenderer.invoke("spawn:listProjects"),
  listThreads: (projectId) => ipcRenderer.invoke("spawn:listThreads", projectId),
  listAllThreads: () => ipcRenderer.invoke("spawn:listAllThreads"),
  createThread: (args) => ipcRenderer.invoke("spawn:createThread", args),
  renameThread: (threadId, title) => ipcRenderer.invoke("spawn:renameThread", threadId, title),
  setThreadStatus: (threadId, status) => ipcRenderer.invoke("spawn:setThreadStatus", threadId, status),
  deleteThread: (threadId) => ipcRenderer.invoke("spawn:deleteThread", threadId),
  listMessages: (threadId, opts) => ipcRenderer.invoke("spawn:listMessages", threadId, opts),
  sendMessage: (threadId, text) => ipcRenderer.invoke("spawn:sendMessage", threadId, text),
  cancelTurn: (threadId) => ipcRenderer.invoke("spawn:cancelTurn", threadId),
  resolveApproval: (id, allow, updatedInput) =>
    ipcRenderer.invoke("spawn:resolveApproval", id, allow, updatedInput),
  getProjectSettings: (projectId) => ipcRenderer.invoke("spawn:getProjectSettings", projectId),
  updateProjectSettings: (projectId, patch) =>
    ipcRenderer.invoke("spawn:updateProjectSettings", projectId, patch),
  setProjectMcpSecret: (projectId, serverName, envKey, value) =>
    ipcRenderer.invoke("spawn:setProjectMcpSecret", projectId, serverName, envKey, value),
  clearProjectMcpSecret: (projectId, serverName, envKey) =>
    ipcRenderer.invoke("spawn:clearProjectMcpSecret", projectId, serverName, envKey),
  openExternal: (url) => ipcRenderer.invoke("spawn:openExternal", url),
  readClipboard: () => ipcRenderer.invoke("spawn:readClipboard"),
  pickFile: (opts) => ipcRenderer.invoke("spawn:pickFile", opts),
  connectGcloud: (projectId, serverName) =>
    ipcRenderer.invoke("spawn:connectGcloud", projectId, serverName),
  importAppleKey: (projectId, serverName, sourcePath) =>
    ipcRenderer.invoke("spawn:importAppleKey", projectId, serverName, sourcePath),
  disconnectProvider: (projectId, serverName) =>
    ipcRenderer.invoke("spawn:disconnectProvider", projectId, serverName),
  listTickets: () => ipcRenderer.invoke("spawn:listTickets"),
  createTicket: (args) => ipcRenderer.invoke("spawn:createTicket", args),
  updateTicket: (ticketId, patch) => ipcRenderer.invoke("spawn:updateTicket", ticketId, patch),
  deleteTicket: (ticketId) => ipcRenderer.invoke("spawn:deleteTicket", ticketId),
  delegateTicket: (ticketId, opts) => ipcRenderer.invoke("spawn:delegateTicket", ticketId, opts),
  getTicket: (ticketId) => ipcRenderer.invoke("spawn:getTicket", ticketId),
  listTicketComments: (ticketId) => ipcRenderer.invoke("spawn:listTicketComments", ticketId),
  addTicketComment: (ticketId, body) => ipcRenderer.invoke("spawn:addTicketComment", ticketId, body),
  listTicketAttachments: (ticketId) => ipcRenderer.invoke("spawn:listTicketAttachments", ticketId),
  addTicketAttachment: (ticketId, sourcePath) => ipcRenderer.invoke("spawn:addTicketAttachment", ticketId, sourcePath),
  getTeamLeadProject: () => ipcRenderer.invoke("spawn:getTeamLeadProject"),
  delegateTask: (args) => ipcRenderer.invoke("spawn:delegateTask", args),
  listActiveThreads: () => ipcRenderer.invoke("spawn:listActiveThreads"),
  getThreadContext: (threadId) => ipcRenderer.invoke("spawn:getThreadContext", threadId),
  cleanupThread: (threadId, force) => ipcRenderer.invoke("spawn:cleanupThread", threadId, force),
  getMap: () => ipcRenderer.invoke("spawn:getMap"),
  listApprovals: () => ipcRenderer.invoke("spawn:listApprovals"),
  listDecisions: () => ipcRenderer.invoke("spawn:listDecisions"),
  getUsage: (days) => ipcRenderer.invoke("spawn:getUsage", days),
  resetThreadSession: (threadId) => ipcRenderer.invoke("spawn:resetThreadSession", threadId),
  listSkills: (projectId) => ipcRenderer.invoke("spawn:listSkills", projectId),
  listDeliverables: (threadId) => ipcRenderer.invoke("spawn:listDeliverables", threadId),
  openDir: (dir) => ipcRenderer.invoke("spawn:openDir", dir),
  revealFile: (p) => ipcRenderer.invoke("spawn:revealFile", p),
  onEvent: (fn) => {
    const handler = (_e, ev) => fn(ev);
    ipcRenderer.on("spawn:event", handler);
    return () => ipcRenderer.removeListener("spawn:event", handler);
  },
});

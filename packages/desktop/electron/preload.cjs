const { contextBridge, ipcRenderer } = require("electron");

// The renderer's ONLY door to the daemon. Mirrors the daemon method surface;
// keep it dumb — no logic here, so a future remote transport slots in behind
// the same window.spawn API.
contextBridge.exposeInMainWorld("spawn", {
  listProjects: () => ipcRenderer.invoke("spawn:listProjects"),
  listThreads: (projectId) => ipcRenderer.invoke("spawn:listThreads", projectId),
  createThread: (args) => ipcRenderer.invoke("spawn:createThread", args),
  renameThread: (threadId, title) => ipcRenderer.invoke("spawn:renameThread", threadId, title),
  listMessages: (threadId, opts) => ipcRenderer.invoke("spawn:listMessages", threadId, opts),
  sendMessage: (threadId, text) => ipcRenderer.invoke("spawn:sendMessage", threadId, text),
  cancelTurn: (threadId) => ipcRenderer.invoke("spawn:cancelTurn", threadId),
  resolveApproval: (id, allow, updatedInput) =>
    ipcRenderer.invoke("spawn:resolveApproval", id, allow, updatedInput),
  getProjectSettings: (projectId) => ipcRenderer.invoke("spawn:getProjectSettings", projectId),
  updateProjectSettings: (projectId, patch) =>
    ipcRenderer.invoke("spawn:updateProjectSettings", projectId, patch),
  listTickets: () => ipcRenderer.invoke("spawn:listTickets"),
  createTicket: (args) => ipcRenderer.invoke("spawn:createTicket", args),
  updateTicket: (ticketId, patch) => ipcRenderer.invoke("spawn:updateTicket", ticketId, patch),
  deleteTicket: (ticketId) => ipcRenderer.invoke("spawn:deleteTicket", ticketId),
  delegateTicket: (ticketId, opts) => ipcRenderer.invoke("spawn:delegateTicket", ticketId, opts),
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
  onEvent: (fn) => {
    const handler = (_e, ev) => fn(ev);
    ipcRenderer.on("spawn:event", handler);
    return () => ipcRenderer.removeListener("spawn:event", handler);
  },
});

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
  getBoard: () => ipcRenderer.invoke("spawn:getBoard"),
  getTeamLeadProject: () => ipcRenderer.invoke("spawn:getTeamLeadProject"),
  delegateTask: (args) => ipcRenderer.invoke("spawn:delegateTask", args),
  listActiveThreads: () => ipcRenderer.invoke("spawn:listActiveThreads"),
  onEvent: (fn) => {
    const handler = (_e, ev) => fn(ev);
    ipcRenderer.on("spawn:event", handler);
    return () => ipcRenderer.removeListener("spawn:event", handler);
  },
});

// ============================================================================
// Preload — the only bridge between the privileged main process and the UI.
// Exposes a minimal, explicit `window.nexus` API; the renderer never touches
// Node or ipcRenderer directly.
// ============================================================================
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nexus', {
  // Workspace
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  getWorkspace: () => ipcRenderer.invoke('workspace:get'),
  setWorkspace: (p) => ipcRenderer.invoke('workspace:set', p),

  // Filesystem
  readFile: (path) => ipcRenderer.invoke('fs:read', path),
  writeFile: (path, content) => ipcRenderer.invoke('fs:write', { path, content }),
  editFile: (path, oldString, newString, replaceAll) =>
    ipcRenderer.invoke('fs:edit', { path, oldString, newString, replaceAll }),
  listDir: (path) => ipcRenderer.invoke('fs:list', path),
  grep: (pattern, glob) => ipcRenderer.invoke('fs:grep', { pattern, glob }),

  // Shell
  runCommand: (command, timeoutMs) => ipcRenderer.invoke('shell:exec', { command, timeoutMs }),

  // Checkpoints
  snapshotFile: (path) => ipcRenderer.invoke('fs:snapshot', path),
  deleteFile: (path) => ipcRenderer.invoke('fs:delete', path),

  // LLM streaming proxy (all providers route through the main process)
  llmStream: (opts) => ipcRenderer.invoke('llm:stream', opts),
  llmAbort: (requestId) => ipcRenderer.invoke('llm:abort', requestId),
  onLlmChunk: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on('llm:chunk', handler);
    return () => ipcRenderer.off('llm:chunk', handler);
  },

  // Web
  webSearch: (query, limit) => ipcRenderer.invoke('web:search', { query, limit }),
  webFetch: (url, maxChars) => ipcRenderer.invoke('web:fetch', { url, maxChars }),

  // OAuth
  startOAuth: () => ipcRenderer.invoke('oauth:start'),
  onOAuthCallback: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on('oauth:callback', handler);
    return () => ipcRenderer.off('oauth:callback', handler);
  }
});

/* 欢迎屏展示窗专用桥（SEC-07）：只暴露关窗一个动作（最小权限；欢迎内容走 URL query，不依赖 IPC） */
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set(['welcome:winClose']);

contextBridge.exposeInMainWorld('api', {
  invoke(channel, payload) {
    if (!INVOKE.has(channel)) return Promise.reject(new Error(`bad channel: ${channel}`));
    return ipcRenderer.invoke(channel, payload);
  },
});

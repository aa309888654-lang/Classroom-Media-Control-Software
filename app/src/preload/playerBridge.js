/* 视频投放窗专用桥（SEC-07）：只暴露视频播放相关通道，不共享面板全量桥（最小权限） */
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set(['video:notifyEnded', 'video:windowToggle']);
const EVENTS = new Set(['video:load', 'video:control']);

contextBridge.exposeInMainWorld('api', {
  invoke(channel, payload) {
    if (!INVOKE.has(channel)) return Promise.reject(new Error(`bad channel: ${channel}`));
    return ipcRenderer.invoke(channel, payload);
  },
  on(channel, cb) {
    if (!EVENTS.has(channel)) return () => { };
    const handler = (_e, data) => cb(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});

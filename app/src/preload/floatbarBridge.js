/* PPT 悬浮控制条专用桥（SEC-07）：只暴露翻页/退出/音乐播放暂停四个动作（最小权限） */
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set(['ppt:prev', 'ppt:next', 'ppt:exit', 'floatbar:music']);

contextBridge.exposeInMainWorld('api', {
  invoke(channel, payload) {
    if (!INVOKE.has(channel)) return Promise.reject(new Error(`bad channel: ${channel}`));
    return ipcRenderer.invoke(channel, payload);
  },
});

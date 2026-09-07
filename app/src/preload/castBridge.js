/* 同屏接收窗专用桥：只暴露关窗一个动作，不共享面板桥（最小权限） */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('castApi', {
  close: () => ipcRenderer.invoke('cast:winClose'),
});

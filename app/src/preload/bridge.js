const { contextBridge, ipcRenderer } = require('electron');

const INVOKE_CHANNELS = new Set([
  'app:getInit', 'app:quit', 'app:openExternal', 'app:copyText',
  'config:save',
  'library:scan', 'library:deleteFile', 'music:renameTrack',
  'displays:list', 'displays:extend', 'displays:select',
  'office:detect',
  'ppt:openDialog', 'ppt:present', 'ppt:exit', 'ppt:status', 'ppt:next', 'ppt:prev', 'ppt:goto', 'ppt:preopen', 'ppt:exportAll',
  'video:openDialog', 'video:play', 'video:stop', 'video:control', 'video:notifyEnded', 'video:windowToggle', 'video:seek',
  'timer:start', 'timer:toggle', 'timer:reset', 'timer:toggleShow', 'timer:state', 'timer:winFullscreen', 'timer:escExit',
  'music:setState',
  'music:playable',
  'music:addCategory', 'music:removeCategory', 'music:import',
  'dialog:pickDir',
  'hotkey:remap', 'hotkey:conflicts',
  'window:toggleAlwaysOnTop', 'window:minimize', 'window:toggleFullscreen', 'window:setFullscreen',
  'window:miniMode', 'window:miniCollapse', 'window:miniExpand',
  'cast:toggle', 'cast:state',
  'peer:scanStart', 'peer:scanStop', 'peer:connect', 'peer:disconnect', 'peer:session', 'peer:state', 'peer:cmd',
  'welcome:toggle', 'welcome:state', 'welcome:winClose', 'welcome:pickLogo',
  'floatbar:music',
]);

const EVENT_CHANNELS = new Set([
  'hotkey', 'ppt:state', 'ppt:presenter', 'video:state', 'toast', 'displays:changed', 'video:load', 'video:control', 'video:windowmode', 'video:progress', 'music:restore', 'timer:tick', 'timer:finished', 'cast:status', 'cast:state', 'welcome:state', 'import:progress', 'thumb:ready', 'ppt:pages', 'peer:list', 'peer:connected', 'window:alwaysOnTop',
]);

contextBridge.exposeInMainWorld('api', {
  invoke(channel, payload) {
    if (!INVOKE_CHANNELS.has(channel)) return Promise.reject(new Error(`bad channel: ${channel}`));
    return ipcRenderer.invoke(channel, payload);
  },
  on(channel, cb) {
    if (!EVENT_CHANNELS.has(channel)) return () => { };
    const handler = (_e, data) => cb(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});

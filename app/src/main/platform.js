// 平台判定集中一处，主进程/渲染层（经 getInit 透传）都从这里分流
const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

module.exports = { isMac, isWin, platform: process.platform };

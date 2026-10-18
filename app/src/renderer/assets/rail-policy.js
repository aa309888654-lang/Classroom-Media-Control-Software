/*
 * 全页缩略图轨道的「要不要补导」策略（纯函数，无 DOM/无 IO，浏览器与 node --test 共用）。
 *
 * 抽出来的原因：这段判定是本次修复的核心，原来内联在 app.js 里既没法单测，
 * 也没法在评审时一眼看出边界。改坏了会静默退回到「缩略图永远不出现」。
 *
 * 背景缺陷：requestPptPages 原来用一次性锁 `requested === file` 防重复请求。
 * 选中课件后 1.2 秒内点了「一键放映」时，主进程走「放映中只读缓存」分支返回 0 页，
 * 锁却被永久记下 —— 这份课件此后永远不再导出，界面表现为缩略图一直不出现，
 * 只有切到别的课件再切回来才恢复。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RailPolicy = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 一次导出请求的结果，决定轨道下一步怎么走
  //   gotPages : 已经拿到页（onPptPages 增量合并后的实际页数）
  //   total     : 主进程报告的总页数；0 表示非 PPT/空课件，没什么可导的
  //   aborted   : 放映中被脚本主动打断（已导的页仍在轨道上）
  function afterExport(r, gotPages) {
    if (gotPages > 0) return { retry: false, state: 'ready' };
    // 连应答都没有（IPC 抛错 / 常驻 PowerShell 通道超时）→ 状态未知，必须允许重试。
    // 这里如果当成「空课件」就再也不会补导，缩略图永久缺失。
    if (!r) return { retry: true, state: 'no-response' };
    // 非 PPT 或总页数为 0：不是故障，别反复重试
    if (!r.total) return { retry: false, state: 'empty-deck' };
    // aborted：已导页留着，等下次选中再补，不算异常
    if (r.aborted) return { retry: false, state: 'aborted' };
    // 有页数却一张没拿到：要么撞上「放映中只读缓存」，要么 COM 真的失败了
    return { retry: true, state: 'pending-retry' };
  }

  // 渲染层该不该安排一次补导。必须同时满足：不放映、不在打开、且上次一无所获。
  function shouldScheduleRequest(opts) {
    const { file, presenting, loading, emptyFor, requested } = opts;
    if (!file) return false;
    if (presenting || loading) return false;
    // 已经要过页了就别再打扰 PowerPoint
    if (emptyFor !== file) return false;
    return requested !== file || emptyFor === file;
  }

  // 导出前是否可以直接跳过（防重复请求，但「上次一无所获」必须放行）
  function shouldSkipRequest(rail, file) {
    if (!file) return true;
    return rail.requested === file && rail.emptyFor !== file;
  }

  return { afterExport, shouldScheduleRequest, shouldSkipRequest };
});

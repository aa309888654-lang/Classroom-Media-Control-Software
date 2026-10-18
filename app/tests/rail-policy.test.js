/* 全页缩略图轨道「补导」策略单测（rail-policy.js）
 *
 * 回归缺陷：requestPptPages 原来用一次性锁 requested === file 防重复请求。
 * 选中课件后 1.2 秒内点「一键放映」→ 主进程走「放映中只读缓存」分支返回 0 页 →
 * 锁被永久记下 → 这份课件此后永不导出，界面表现为缩略图一直不出现。
 * 这组用例把「必须能重试」和「不该重试」两种边界都钉死。 */
const { test } = require('node:test');
const assert = require('node:assert');

const RailPolicy = require('../src/renderer/assets/rail-policy.js');

const F = 'C:/fake/课件.pptx';

/* ---------- afterExport：导出结果 → 轨道状态 ---------- */

test('afterExport：拿到页就不再重试', () => {
  const r = RailPolicy.afterExport({ ok: true, total: 20 }, 12);
  assert.strictEqual(r.retry, false);
  assert.strictEqual(r.state, 'ready');
});

test('afterExport：有总页数却 0 页 → 必须重试（本次缺陷的核心分支）', () => {
  const r = RailPolicy.afterExport({ ok: true, total: 20 }, 0);
  assert.strictEqual(r.retry, true, '撞上放映中只读缓存时要能重试，否则缩略图永远不出现');
  assert.strictEqual(r.state, 'pending-retry');
});

test('afterExport：被放映打断不算异常，不立即重试（已导页仍在轨道上）', () => {
  const r = RailPolicy.afterExport({ ok: true, total: 20, aborted: true }, 0);
  assert.strictEqual(r.retry, false);
  assert.strictEqual(r.state, 'aborted');
});

test('afterExport：非 PPT / 空课件（total=0）不反复重试', () => {
  assert.strictEqual(RailPolicy.afterExport({ ok: true, total: 0 }, 0).state, 'empty-deck');
  assert.strictEqual(RailPolicy.afterExport({ ok: true, total: 0 }, 0).retry, false);
});

test('afterExport：主进程没给应答也不当成成功', () => {
  assert.strictEqual(RailPolicy.afterExport(null, 0).retry, true);
});

/* ---------- shouldScheduleRequest：渲染层该不该安排补导 ---------- */

test('shouldScheduleRequest：退出放映后必须能补导', () => {
  const ok = RailPolicy.shouldScheduleRequest({
    file: F, presenting: false, loading: false, emptyFor: F, requested: F,
  });
  assert.strictEqual(ok, true, '上次一无所获且现在没在放映 → 应补导');
});

test('shouldScheduleRequest：放映中 / 打开中都不补导（此时 COM 会被占）', () => {
  assert.strictEqual(RailPolicy.shouldScheduleRequest({
    file: F, presenting: true, loading: false, emptyFor: F, requested: F,
  }), false);
  assert.strictEqual(RailPolicy.shouldScheduleRequest({
    file: F, presenting: false, loading: true, emptyFor: F, requested: F,
  }), false);
});

test('shouldScheduleRequest：已经拿到页（emptyFor 已清）就不再打扰 PowerPoint', () => {
  assert.strictEqual(RailPolicy.shouldScheduleRequest({
    file: F, presenting: false, loading: false, emptyFor: '', requested: F,
  }), false);
});

test('shouldScheduleRequest：没选课件不安排', () => {
  assert.strictEqual(RailPolicy.shouldScheduleRequest({
    file: '', presenting: false, loading: false, emptyFor: '', requested: '',
  }), false);
});

/* ---------- shouldSkipRequest：导出前的防重复闸门 ---------- */

test('shouldSkipRequest：已成功导过 → 跳过，不重复拉 PowerPoint', () => {
  const rail = { requested: F, emptyFor: '' };
  assert.strictEqual(RailPolicy.shouldSkipRequest(rail, F), true);
});

test('shouldSkipRequest：上次一无所获 → 必须放行（一次性锁不能把这份课件锁死）', () => {
  const rail = { requested: F, emptyFor: F };
  assert.strictEqual(RailPolicy.shouldSkipRequest(rail, F), false,
    '这就是本次缺陷：原来这里被一次性锁挡掉，缩略图永远出不来');
});

test('shouldSkipRequest：换课件不跳过', () => {
  const rail = { requested: F, emptyFor: '' };
  assert.strictEqual(RailPolicy.shouldSkipRequest(rail, 'C:/fake/other.pptx'), false);
  assert.strictEqual(RailPolicy.shouldSkipRequest(rail, ''), true);
});

/* ---------- 两段策略必须自洽 ---------- */

test('一致性：shouldSkip 放行后，shouldSchedule 会在非放映期安排补导', () => {
  const rail = { requested: F, emptyFor: F };
  assert.strictEqual(RailPolicy.shouldSkipRequest(rail, F), false);
  const after = RailPolicy.afterExport({ ok: true, total: 30 }, 0);
  rail.emptyFor = after.retry ? F : '';
  assert.strictEqual(RailPolicy.shouldScheduleRequest({
    file: F, presenting: false, loading: false, emptyFor: rail.emptyFor, requested: rail.requested,
  }), true, '一次失败后必须能在退出放映时真正补上，否则修复不成立');
});

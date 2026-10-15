/* transcode 模块单测：parseDuration + probeDurationSec（PERF-08 的零 spawn 时长探测）
 * probeDurationSec 用真实 ffmpeg 生成两种长度的 MP4 做验证（依赖 ffmpeg-static，CI/本机都有）。 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const { installElectron } = require('./helpers');
installElectron();
const transcode = require('../src/main/transcode.js');

test('parseDuration：从 ffmpeg stderr 提取时长', () => {
  assert.strictEqual(transcode.parseDuration('  Duration: 01:02:03.50, start: 0.0'), 3723.5);
  assert.strictEqual(transcode.parseDuration('Duration: 00:00:10.00'), 10);
  assert.strictEqual(transcode.parseDuration('garbage'), 0);
});

test('isVideoSafe / isAudioSafe 白名单', () => {
  assert.strictEqual(transcode.isVideoSafe('.mp4'), true);
  assert.strictEqual(transcode.isVideoSafe('.mkv'), false);
  assert.strictEqual(transcode.isAudioSafe('.wav'), true);
  assert.strictEqual(transcode.isAudioSafe('.wmv'), false);
});

test('probeDurationSec：真实 MP4 时长解析（mvhd 原子，零 spawn）', (t) => {
  const ffmpeg = transcode.resolveFfmpeg();
  if (!ffmpeg) { t.skip('无 ffmpeg'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xt-probe-'));
  const mk = (name, seconds) => {
    const f = path.join(dir, name);
    execFileSync(ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=160x120:rate=10`, '-pix_fmt', 'yuv420p', f], { stdio: 'ignore' });
    return f;
  };
  const short = mk('short.mp4', 0.8);
  const long = mk('long.mp4', 3);
  const dShort = transcode.probeDurationSec(short);
  const dLong = transcode.probeDurationSec(long);
  assert.ok(dShort > 0.5 && dShort < 1.2, `短视频时长 ${dShort} 应在 0.8 附近`);
  assert.ok(dLong > 2.5 && dLong < 3.5, `长视频时长 ${dLong} 应在 3 附近`);
  // 非 MP4 / 损坏文件 → 0（调用方回退双尝试）
  const bad = path.join(dir, 'bad.mp4');
  fs.writeFileSync(bad, 'not a real mp4');
  assert.strictEqual(transcode.probeDurationSec(bad), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

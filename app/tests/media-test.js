/* 手工验证音乐冷门格式转码缓存（需 electron，非 node --test）：
   npx electron tests/media-test.js  */
const { app } = require('electron');
const path = require('path');
const transcode = require('../src/main/transcode');
const fs = require('fs');

app.whenReady().then(async () => {
  const file = path.join(process.env.USERPROFILE, 'Documents', '小天AIGC', '音乐', '测试', '测试冷门.wma');
  console.log('测试文件存在:', fs.existsSync(file), file);
  console.log('isAudioSafe(.wma)=', transcode.isAudioSafe('.wma'), 'isAudioExt(.wma)=', transcode.isAudioExt('.wma'));
  process.stdout.write('转码中 ');
  const r = await transcode.ensureAudioPlayable(file, (p) => process.stdout.write('.'));
  console.log('\n结果:', JSON.stringify({ transcoded: r.transcoded, cached: r.cached, error: r.error, isMp3: r.file && r.file.endsWith('.mp3') }));
  console.log('生成的 mp3 存在:', r.file && fs.existsSync(r.file), r.file);
  const hit = transcode.getCachedAudio(file);
  console.log('二次命中缓存:', !!hit, hit);
  app.exit(r.transcoded ? 0 : 1);
});

/* 产物完整性核验：把打包产物 app.asar 里的每个「源码」文件与当前工作区逐一比对。
 * 比「看几个关键字符串在不在」强得多——任何一个字节对不上都会报出来。
 * 用法：node scripts/verify-artifact.js [asar路径]
 */
const asar = require('@electron/asar');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ASAR = process.argv[2] || 'I:\\教务系统\\软件封装\\win-unpacked\\resources\\app.asar';
const APP = path.join(__dirname, '..');
// electron-builder 允许把 node_modules 打进 asar（生产依赖），那些不在工作区 src/ 下，不参与比对
const IGNORE = /^node_modules\//;

let files = [];
try { files = asar.listPackage(ASAR); } catch (e) { console.error('读 asar 失败:', e.message); process.exit(1); }

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');
let checked = 0;
const differ = [], missing = [], skipped = [];

// extractFile 对路径分隔符/前导斜杠比较敏感，按库实际存的形式依次尝试
function readFromAsar(raw, rel) {
  const candidates = [...new Set([
    raw,                                              // listPackage 原样返回（\src\preload\bridge.js）
    raw.replace(/\\/g, '/'),                          // /src/preload/bridge.js
    raw.replace(/^\\/, ''),                          // src\preload\bridge.js
    rel,                                              // src/preload/bridge.js
    rel.replace(/^\//, ''),                          // src/preload/bridge.js
  ])];
  let lastErr = null;
  for (const cand of candidates) {
    try { return asar.extractFile(ASAR, cand); } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('extractFile 失败');
}

for (const f of files) {
  // Windows 下 listPackage 返回的是反斜杠路径，统一成正斜杠再拼
  const rel = f.replace(/\\/g, '/').replace(/^\//, '');
  if (!rel || IGNORE.test(rel)) { if (rel) skipped.push(rel); continue; }
  if (!/\.(js|html|css|json|md|mjs)$/i.test(rel)) continue;
  if (rel.startsWith('.mimosa/') || rel.includes('/.mimosa/')) continue;

  const onDisk = path.join(APP, ...rel.split('/'));
  if (!fs.existsSync(onDisk)) { missing.push(rel); continue; }

  let a, b;
  // asar 不是真实文件系统，fs.readFileSync 读不到里面的文件，必须用 extractFile
  try { a = readFromAsar(f, rel); b = fs.readFileSync(onDisk); }
  catch (e) { missing.push(`${rel} (读取失败: ${e.message})`); continue; }

  // package.json 特殊处理：electron-builder 会刻意精简包内那份（剥掉 scripts /
  // devDependencies 等只在开发/构建时用得到的字段），字节必然不同。逐字节比它会永远
  // 误报，所以改成比「运行时真正生效的字段」。
  if (rel === 'package.json') {
    let aj, bj;
    try { aj = JSON.parse(a.toString('utf8')); bj = JSON.parse(b.toString('utf8')); } catch { }
    if (aj && bj) {
      const KEYS = ['name', 'productName', 'version', 'main'];
      const bad = KEYS.filter((k) => String(aj[k]) !== String(bj[k]));
      const depDiff = JSON.stringify(aj.dependencies || {}) !== JSON.stringify(bj.dependencies || {});
      if (bad.length) differ.push({ rel, asarBytes: a.length, diskBytes: b.length, note: `字段不一致: ${bad.join(',')}` });
      else if (depDiff) differ.push({ rel, asarBytes: a.length, diskBytes: b.length, note: 'dependencies 不一致' });
      else checked++;
      continue;
    }
  }

  checked++;
  if (md5(a) !== md5(b)) differ.push({ rel, asarBytes: a.length, diskBytes: b.length });
}

const asarVer = (() => {
  try { return JSON.parse(readFromAsar('package.json', 'package.json').toString('utf8')).version; }
  catch { return ''; }
})();
const diskVer = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8')).version;

console.log(`\n===== 产物完整性核验 =====`);
console.log(`asar: ${ASAR}`);
console.log(`as 内条目: ${files.length}（其中 node_modules 依赖 ${skipped.length} 项跳过比对）`);
console.log(`实际比对:   ${checked} 个源码文件`);
console.log(`内容不符:   ${differ.length}`);
console.log(`工作区缺失: ${missing.length}`);
if (differ.length) { console.log('\n--- 内容不符 ---'); for (const d of differ) console.log(`  ${d.rel}  asar=${d.asarBytes}B  disk=${d.diskBytes}B${d.note ? '  ← ' + d.note : ''}`); }
if (missing.length) { console.log('\n--- 只存在于包内 ---'); for (const m of missing) console.log(`  ${m}`); }
console.log(`\n版本: 包内=${asarVer}  工作区=${diskVer}  ${asarVer === diskVer ? '一致' : '不一致！'}`);

/* ---- 附带核对 extraResources：ppt-control.ps1 不在 asar 里，走 extraResources 落到
   resources/resources/ 下。它是 PPT 全部功能的命脉（放映/翻页/缩略图导出都靠它），
   版本不同步会出「界面有按钮、点了没反应」这类诡异故障。 */
const RES = path.join(path.dirname(ASAR), 'resources');
let psOk = false, psMsg = '';
try {
  const a = fs.readFileSync(path.join(RES, 'ppt-control.ps1'));
  const b = fs.readFileSync(path.join(APP, 'resources', 'ppt-control.ps1'));
  psOk = md5(a) === md5(b);
  psMsg = psOk ? `一致（${a.length} 字节）` : `不一致！包内 ${a.length}B / 源码 ${b.length}B`;
} catch (e) { psMsg = `核对失败: ${e.message}`; }
console.log(`ppt-control.ps1: ${psMsg}`);
if (!psOk) missing.push('resources/resources/ppt-control.ps1');

const fail = differ.length > 0 || missing.length > 0 || asarVer !== diskVer;
console.log(fail ? '\n结论: 产物与源码不一致，需要重新打包' : '\n结论: 产物与当前源码完全一致，无需重新打包');
process.exit(fail ? 1 : 0);

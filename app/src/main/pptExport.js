/* PPT 全页导出缓存（从 index.js 抽出，GAP-09）：
 * - 每个课件一个按「路径哈希 + 大小 + mtime」键控的子目录（BUG-03 防不同目录同名文件串图）；
 * - 页面按页缓存（page-N.png），导出方只增量补新页；
 * - 提供 sweep() 清理 14 天前的旧导出目录（GAP-10 防只增不减）。 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TTL_MS = 14 * 24 * 3600 * 1000;

let ROOT = '';

// 导出根目录必须存在，否则 PS 脚本里的 Test-Path 为假、静默跳过导出
function root() {
  if (!ROOT) {
    const { app } = require('electron');
    ROOT = path.join(app.getPath('temp'), 'xiaotian-aigc-ppt');
    try { fs.mkdirSync(ROOT, { recursive: true }); } catch { }
  }
  return ROOT;
}

// 清理过期导出目录（启动时调用一次）。
// 用 fs.promises 异步做：原本是 readdirSync + 逐目录 statSync + 递归 rmSync，
// 放在启动路径上会同步冻结主进程（老机上开机黑屏 1~3s）。
async function sweep() {
  let ents = [];
  try { ents = await fs.promises.readdir(root(), { withFileTypes: true }); } catch { return; }
  await Promise.all(ents.map(async (ent) => {
    if (!ent.isDirectory()) return;
    const p = path.join(root(), ent.name);
    try {
      const st = await fs.promises.stat(p);
      if (Date.now() - st.mtimeMs > TTL_MS) await fs.promises.rm(p, { recursive: true, force: true });
    } catch { }
  }));
}

// 每个课件一个子目录（文件名+路径哈希+大小+mtime 做 key）：page-N.png 按页缓存，
// 翻页每轮只导新页，换课件不串图（BUG-03：路径哈希区分不同目录下同名同大小同 mtime 的文件）
function exportDir(file) {
  if (!file) return root();
  let key = 'unknown';
  try { const st = fs.statSync(file); key = `${st.size}-${Math.round(st.mtimeMs)}`; } catch { }
  const norm = String(file).replace(/\\/g, '/');
  const base = norm.split('/').pop().replace(/[^\w.-]/g, '_') || 'file';
  const dirHash = crypto.createHash('sha1').update(norm.toLowerCase()).digest('hex').slice(0, 10);
  const name = `${dirHash}-${base}-${key}`;
  const dir = path.join(root(), name);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { }
  return dir;
}

module.exports = { exportDir, sweep };

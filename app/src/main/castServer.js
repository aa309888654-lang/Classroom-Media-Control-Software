/* 无线同屏·信令服务（无第三方依赖，证书生成用 node-forge）：局域网双端口服务
 * HTTP  端口 P  ：发送端落地页（零证书门槛，任何手机可打开）+ 上传上屏 + WebRTC 信令
 * HTTPS 端口 P+1：镜像投屏页（浏览器只在安全上下文开放抓屏 API，自签证书首次需「继续前往」）
 * 上传上屏不走抓屏 API，iPhone 也可用；镜像投屏限安卓/电脑。
 * 发送端与接收端都以 127.0.0.1/局域网 IP 访问本服务，零安装零外网。 */
const http = require('http');
const https = require('https');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config'); // SEC-03：证书信任开关走配置（可在设置中关闭自动导入）

const DEFAULT_PORT = 18333;
const MAX_OFFSET = 8;
const UPLOAD_MAX = 500 * 1024 * 1024; // 单文件上限 500MB
// 实际生效的上限：默认就是 UPLOAD_MAX；start(cb, { uploadMax }) 可调小（集成测试用），
// 不传就是生产值，不会被意外放宽。
let uploadMax = UPLOAD_MAX;

let httpServer = null;
let httpsServer = null;
let port = 0;
let httpsPort = 0;
let url = '';
let httpsUrl = '';
let statusCb = null;
let uploadsDir = '';
let authToken = ''; // 本次服务的访问令牌（BUG-01：原来零鉴权 + CORS *，任何网页都能驱动教室大屏）
const uploads = new Map(); // id -> {file, name, mime}
const queues = { receiver: [], sender: [] };
let currentCert = null; // 当前 https 证书（供 /cast.crt 下载与自动信任）
let commandCb = null;   // 遥控命令回调（主进程注入：音乐/PPT/视频控制）
let stateProvider = null; // 遥控页轮询的状态快照（主进程注入）

/* ---------- 访问控制（BUG-01 修复） ----------
 * 1) start() 生成随机 token；页面（/、/remote）响应时下发 SameSite=Strict Cookie，
 *    同源页面的后续 fetch 自动带上（发送端/遥控页零改动）。
 * 2) file:// 接收端（主面板内联接收窗、caster.html）拿不到 Cookie，由调用方把 token
 *    放进窗口 query，再用 X-Token 头发送。
 * 3) 所有 /api/* 与 /media/* 必须通过 X-Token 或 Cookie 校验，否则 401。
 * 4) CORS 由「*」改为反射请求源：外部网页即使预检通过也没有 token，读不到也发不动。
 */
function makeToken() { return crypto.randomBytes(24).toString('hex'); }

function tokenOk(req) {
  if (!authToken) return false;
  const h = req.headers && (req.headers['x-token'] || req.headers['x-auth-token']);
  if (h && String(h) === authToken) return true;
  const c = String((req.headers && req.headers.cookie) || '');
  for (const part of c.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === 'dshcast' && part.slice(i + 1).trim() === authToken) return true;
  }
  return false;
}

function servePage(res, html) {
  const headers = { 'Content-Type': 'text/html; charset=utf-8' };
  // 手机浏览器常缓存页面：缓存页不重新请求就拿不到新 Cookie，旧令牌全量 401。
  // no-store 保证每次打开/刷新都真正取页，令牌永远是新的。
  headers['Cache-Control'] = 'no-store';
  if (authToken) headers['Set-Cookie'] = `dshcast=${authToken}; Path=/; SameSite=Strict`;
  res.writeHead(200, headers);
  res.end(html);
}
const REMOTE_CMDS = {
  // playCat：按序号播放曲库分类（page=0 即分类 1），桌面遥控端直接开播用
  music: new Set(['toggle', 'prev', 'next', 'volUp', 'volDown', 'mute', 'playCat']),
  ppt: new Set(['next', 'prev', 'exit', 'goto']),
  video: new Set(['toggle', 'stop', 'volUp', 'volDown']),
};
function setCommandHandler(cb) { commandCb = cb; }
function setStateProvider(fn) { stateProvider = fn; }

function lanIp() {
  const bad = /vethernet|vmware|virtualbox|hyper-v|loopback|bluetooth|tailscale|zerotier|wsl/i;
  const cands = [];
  for (const [name, infos] of Object.entries(os.networkInterfaces())) {
    if (bad.test(name)) continue;
    for (const i of infos || []) {
      if (i.family === 'IPv4' && !i.internal) cands.push(i.address);
    }
  }
  return cands[0] || '127.0.0.1';
}

// CORS：反射请求源，不再使用通配 *（通配 + 凭证是浏览器禁止的组合，
// 而 * 本身等于「任意网页都能调」。真正的门禁是 token，见文件头访问控制说明）
function sendJson(req, res, code, obj) {
  const origin = req && req.headers ? req.headers.origin : undefined;
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Token',
    Vary: 'Origin',
  };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  res.writeHead(code, headers);
  res.end(JSON.stringify(obj));
}

function notify(ev) { if (statusCb) statusCb(ev); }

// 让发送端离开（接收端主动关闭时通知浏览器释放流）
function bye() { queues.sender.push({ type: 'bye' }); }

/* ---------- 自签证书（按局域网 IP 缓存；IP 变了自动重签，杜绝 SAN 失效） ---------- */
function ensureCert() {
  const { app } = require('electron');
  const forge = require('node-forge');
  const dir = path.join(app.getPath('userData'), 'cast-cert');
  const ip = lanIp();
  const keyFile = path.join(dir, `key-${ip}.pem`);
  const crtFile = path.join(dir, `cert-${ip}.pem`);
  let key = '';
  let cert = '';
  try {
    key = fs.readFileSync(keyFile, 'utf8');
    cert = fs.readFileSync(crtFile, 'utf8');
  } catch { }
  if (!key || !cert) {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const x509 = forge.pki.createCertificate();
    x509.publicKey = keys.publicKey;
    x509.serialNumber = '01' + Date.now().toString(16);
    x509.validity.notBefore = new Date(Date.now() - 60 * 1000);
    x509.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000);
    const attrs = [{ name: 'commonName', value: 'xiaotian-aigc-cast' }];
    x509.setSubject(attrs);
    x509.setIssuer(attrs);
    const altNames = [
      { type: 7, ip: '127.0.0.1' },
      { type: 2, value: 'localhost' },
    ];
    if (ip && ip !== '127.0.0.1') altNames.push({ type: 7, ip });
    x509.setExtensions([{ name: 'subjectAltName', altNames }]);
    x509.sign(keys.privateKey, forge.md.sha256.create());
    key = forge.pki.privateKeyToPem(keys.privateKey);
    cert = forge.pki.certificateToPem(x509);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(keyFile, key);
      fs.writeFileSync(crtFile, cert);
    } catch { }
  }
  // Windows 证书指纹 = DER 的 SHA1（大写十六进制），自动信任时比对用
  let thumb = '';
  try {
    const crtObj = forge.pki.certificateFromPem(cert);
    const der = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(crtObj)).getBytes(), 'binary');
    thumb = require('crypto').createHash('sha1').update(der).digest('hex').toUpperCase();
  } catch { }
  return { key, cert, crtFile, thumb, ip };
}

/* 把自签证书装入 Windows 当前用户「受信任的根证书颁发机构」：
 * Chrome/Edge 用系统证书库，装一次后局域网 https 镜像页不再报「证书不受信任」。
 * CurrentUser\Root 无需管理员；首次导入 Windows 会弹一次确认框，点「是」即可。
 * 每个指纹每次会话只尝试一次，避免反复弹框。 */
let trustAttempted = '';
function trustCertWindows(c) {
  if (process.platform !== 'win32' || !c.thumb || !c.crtFile) return;
  if (trustAttempted === c.thumb) return;
  trustAttempted = c.thumb;
  try {
    const { execFile } = require('child_process');
    const crtPsPath = c.crtFile.replace(/'/g, "''");
    const ps = `$t='${c.thumb}';` +
      `$have = Get-ChildItem Cert:\CurrentUser\Root -ErrorAction SilentlyContinue | Where-Object { $_.Thumbprint -eq $t };` +
      `if (-not $have) { Import-Certificate -FilePath '${crtPsPath}' -CertStoreLocation Cert:\CurrentUser\Root | Out-Null }`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { windowsHide: true, timeout: 90000 }, () => { });
  } catch { }
}

/* ---------- 上传上屏 ---------- */
function ensureUploadsDir() {
  const { app } = require('electron');
  const root = path.resolve(app.getPath('temp'), 'xiaotian-aigc-uploads');
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { }
  fs.mkdirSync(root, { recursive: true });
  uploadsDir = root;
}

const MIME_MAP = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.heic': 'image/heic',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4',
  '.pdf': 'application/pdf',
};
const SAFE_EXT = new Set(Object.keys(MIME_MAP));

function handleUpload(req, res, u) {
  const name = (u.searchParams.get('name') || '未命名').slice(0, 120).replace(/[\\/:*?"<>|]/g, '_');
  const mime = (u.searchParams.get('type') || '').slice(0, 80);
  const id = crypto.randomBytes(8).toString('hex');
  // 落盘文件名 = 随机 hex + 白名单扩展名，不含任何用户输入；
  // 再按规范要求做根目录边界校验，杜绝任何形式的路径穿越。
  const rawExt = path.extname(name).toLowerCase();
  const ext = SAFE_EXT.has(rawExt) ? rawExt : '.bin';
  const root = path.resolve(uploadsDir);
  const target = path.resolve(root, id + ext);
  if (target !== root && !target.startsWith(root + path.sep)) {
    sendJson(req, res, 400, { ok: false, error: 'bad-path' });
    return;
  }
  const file = target;
  const out = fs.createWriteStream(file);
  let size = 0;
  let aborted = false;
  let responded = false;
  let completed = false;   // 写流是否走完（finish 置位）——用来区分「正常收完」与「半截」
  req.on('data', (c) => {
    size += c.length;
    // 超限：先回 413 再断流。原来直接 req.destroy() 不发响应，客户端只看到 socket hang up
    if (size > uploadMax && !aborted) {
      aborted = true;
      responded = true;
      // 413 必须真的送达客户端：响应声明「连接即将关闭」，
      // 并且收尾用优雅 FIN（socket.end()）而不是 RST（destroy()）——
      // RST 会把还躺在客户端接收缓冲区里的响应数据一起冲掉，
      // 客户端只看到 ECONNRESET（"socket hang up"），用户看到的是无意义的网络错误
      // 而不是「文件太大」。原来的 req.destroy() 正是这个毛病。
      try { res.setHeader('Connection', 'close'); } catch { }
      sendJson(req, res, 413, { ok: false, error: 'too-large', max: uploadMax });
      // 关键（2026-10-20 全面检查发现）：req.destroy() 不带 error 参数时，
      // pipe 的 dest 既收不到 'end' 也收不到 'error' → 写流的 'finish'/'close' 都不会触发
      //（Node v24 实测：只有请求侧 REQ_CLOSE 触发）。于是下面 out.on('close') 的清理
      // 是死代码：半成品文件残留 + 写流 fd 不关，每次超限在系统盘留下最多 500MB。
      // 必须显式销毁写流并立刻删文件。
      try { out.destroy(); } catch { }
      try { fs.rmSync(file, { force: true }); } catch { }
      // 响应 flush 完之后再优雅断开连接，客户端这时已经能读到 413。
      res.on('finish', () => { try { if (req.socket) req.socket.end(); } catch { } });
    }
  });
  req.pipe(out);
  // 客户端中途断开（未超限）：req 不会发 'end'，写流同样收不到 finish/close，
  // 半成品会一直留在磁盘上。req.complete 为 true 表示消息完整收到（正常路径）。
  req.on('close', () => {
    if (req.complete || completed) return;
    try { out.destroy(); } catch { }
    try { fs.rmSync(file, { force: true }); } catch { }
  });
  out.on('close', () => {
    // 没走完 finish 就是半成品（被掐断/超限/出错），一律清掉；
    // 正常上传完成时 writableFinished 为 true，不动它。
    if (!out.writableFinished) { try { fs.rmSync(file, { force: true }); } catch { } }
  });
  out.on('finish', () => {
    completed = true;
    if (aborted) { try { fs.rmSync(file, { force: true }); } catch { } return; }
    const mimeFinal = mime || MIME_MAP[ext] || 'application/octet-stream';
    uploads.set(id, { file, name, mime: mimeFinal });
    queues.receiver.push({ type: 'upload', id, name, mime: mimeFinal });
    notify('upload');
    if (!responded) sendJson(req, res, 200, { ok: true, id, url: `/media/${id}` });
  });
  out.on('error', () => {
    completed = true;
    try { fs.rmSync(file, { force: true }); } catch { }
    if (!responded) { responded = true; sendJson(req, res, 500, { ok: false, error: 'save-failed' }); }
  });
}

/* Range 支持（BUG-06）：没有 Accept-Ranges/Content-Length/206 时，
 * 浏览器 <video controls> 拿不到真实时长、进度条拖不动、只能顺序播放。 */
function serveMedia(req, res, id) {
  const rec = uploads.get(String(id).slice(0, 64));
  if (!rec || !fs.existsSync(rec.file)) { sendJson(req, res, 404, { ok: false }); return; }
  let size = 0;
  try { size = fs.statSync(rec.file).size; } catch { }
  const cors = {};
  const origin = req && req.headers ? req.headers.origin : undefined;
  if (origin) { cors['Access-Control-Allow-Origin'] = origin; cors['Access-Control-Allow-Credentials'] = 'true'; }
  cors['Accept-Ranges'] = 'bytes';
  cors['Cache-Control'] = 'no-store';
  const range = String((req.headers && req.headers.range) || '');
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (m && size) {
    let start, end;
    const a = m[1], b = m[2];
    if (a === '' && b === '') {
      // bytes=- 非法
      res.writeHead(416, { 'Content-Range': `bytes */${size}`, ...cors });
      return res.end();
    }
    if (a === '') {
      // 后缀范围 bytes=-N → 最后 N 字节（深测发现：原解析把 -N 误当成 0..N）
      const n = parseInt(b, 10);
      if (!Number.isFinite(n) || n <= 0) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}`, ...cors });
        return res.end();
      }
      start = Math.max(0, size - n);
      end = size - 1;
    } else {
      start = parseInt(a, 10);
      end = b === '' ? size - 1 : parseInt(b, 10); // bytes=N- 开区间 → 到末尾
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end >= size || start < 0) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}`, ...cors });
      return res.end();
    }
    res.writeHead(206, {
      'Content-Type': rec.mime,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      ...cors,
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(rec.file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': rec.mime, 'Content-Length': size, ...cors });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(rec.file).pipe(res);
}

/* ---------- 发送端网页（内联，无外部资源） ---------- */
/* __HTTPS_PORT__ 会在响应时替换成真实的 HTTPS 端口 */
const SENDER_PAGE = String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>小天AIGC · 无线投屏</title>
<style>
  html,body{margin:0;height:100%;background:#161616;color:#eaeaea;font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
  body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:24px;text-align:center}
  .logo{width:56px;height:56px;border-radius:14px;background:#1d3a5f;display:flex;align-items:center;justify-content:center;font-size:28px}
  h1{font-size:19px;margin:0;font-weight:700}
  .card{background:#1d2330;border:1px solid #33415c;border-radius:16px;padding:18px 20px;max-width:480px;width:100%;box-sizing:border-box;text-align:left}
  .card h2{margin:0 0 6px;font-size:15px;color:#7dc4ff}
  .tip{color:#a3a3a3;font-size:13px;line-height:1.7}
  button{font-size:16px;font-weight:700;color:#fff;background:#1473e6;border:none;border-radius:12px;padding:14px 26px;cursor:pointer;box-shadow:0 6px 20px rgba(38,128,235,.35)}
  button:active{transform:scale(.97)}
  .green{background:#1d9a52;box-shadow:0 6px 20px rgba(29,154,82,.3)}
  #stopBtn{background:#e34850;box-shadow:none;display:none}
  #st,#ust{color:#9fbfef;font-size:13px;min-height:18px;letter-spacing:1px}
  .warn{color:#da7b11}
  .alt{color:#8b949e;font-size:12px;margin-top:8px;line-height:1.7}
  a{color:#7dc4ff}
  #upFile{display:none}
  .bar{height:8px;background:#0d1117;border-radius:4px;overflow:hidden;margin-top:10px;display:none}
  .bar i{display:block;height:100%;width:0;background:#1d9a52;transition:width .2s}
</style>
</head>
<body>
  <div class="logo">📺</div>
  <h1>小天AIGC · 无线投屏</h1>

  <div class="card">
    <h2>方式一 · 镜像投屏（安卓手机 / 电脑）</h2>
    <div class="tip">把整个手机/电脑屏幕实时投到教室大屏。电脑请用 Chrome 或 Edge 打开本页。</div>
    <div style="text-align:center;margin-top:12px">
      <button id="startBtn">🖥 开始共享屏幕</button>
      <button id="goHttpsBtn" class="green" style="display:none">🔒 进入加密镜像页</button>
      <button id="stopBtn">⏹ 停止共享</button>
    </div>
    <div id="st">就绪</div>
    <div class="alt">首次进入加密页若提示「证书风险 / 不安全」，点「高级 → 继续前往」即可，这是局域网自建加密的正常提示。<br>
      <a href="/cast.crt" download>⬇ 下载证书</a>（电脑浏览器不再提示：安装到「受信任的根证书颁发机构」）；
      本机投屏直接开 <a href="http://localhost:__HTTP_PORT__/">http://localhost:__HTTP_PORT__</a>（免证书）。</div>
  </div>

  <div class="card">
    <h2>方式二 · 上传上屏（苹果手机用这个；手机/电脑通用）</h2>
    <div class="tip">选一张照片或一段视频，立刻显示到教室大屏。适合上交作业、展示学生作品。</div>
    <div style="text-align:center;margin-top:12px">
      <button id="upBtn">📤 选择照片 / 视频上屏</button>
      <input type="file" id="upFile" accept="image/*,video/*" />
    </div>
    <div class="bar" id="ubar"><i id="ubarFill"></i></div>
    <div id="ust">支持 JPG/PNG/MP4 等，最大 500MB</div>
  </div>

  <script>
    const stEl = document.getElementById('st');
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const goHttpsBtn = document.getElementById('goHttpsBtn');
    let pc = null, stream = null, polling = false;
    const pending = [];
    const st = (t, warn) => { stEl.textContent = t; stEl.className = warn ? 'warn' : ''; };

    async function send(msg) {
      await fetch('/api/signal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: 'receiver', msg }) });
    }

    // 进入页面即分流：镜像只在 https 安全上下文可用；http 落地页引导跳转，上传随时可用
    (function preflight() {
      const ua = navigator.userAgent;
      const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      if (window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
        st('就绪');
        return;
      }
      startBtn.style.display = 'none';
      stopBtn.style.display = 'none';
      if (!window.isSecureContext) {
        goHttpsBtn.style.display = 'inline-block';
        goHttpsBtn.onclick = () => { location.href = 'https://' + location.hostname + ':__HTTPS_PORT__/'; };
        st('镜像需加密连接，点下方绿色按钮进入', true);
      } else if (isIOS) {
        st('苹果手机不支持网页镜像，请用「方式二 · 上传上屏」', true);
      } else {
        st('此浏览器不支持屏幕共享，请改用 Chrome / Edge', true);
      }
    })();

    async function start() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        st('此浏览器不支持屏幕共享', true);
        return;
      }
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      } catch (e) { st('已取消共享', true); return; }
      startBtn.style.display = 'none'; stopBtn.style.display = 'inline-block';
      st('连接中…');
      pc = new RTCPeerConnection();
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      stream.getVideoTracks()[0].onended = () => stop(true);
      pc.onicecandidate = (e) => { if (e.candidate) send({ type: 'ice', candidate: e.candidate }); };
      pc.onconnectionstatechange = () => {
        if (pc && (pc.connectionState === 'connected')) st('✅ 已连接，正在投屏');
        if (pc && ['failed', 'disconnected'].includes(pc.connectionState)) st('连接质量不佳，若长时间无画面请检查 WiFi', true);
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await send({ type: 'offer', sdp: pc.localDescription.sdp });
      if (!polling) { polling = true; poll(); }
    }
    async function poll() {
      while (polling) {
        try {
          const r = await fetch('/api/poll?role=sender');
          const j = await r.json();
          for (const m of j.messages || []) {
            if (m.type === 'answer') {
              await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
              for (const c of pending) await pc.addIceCandidate(c);
              pending.length = 0;
              st('✅ 已连接，正在投屏');
            } else if (m.type === 'ice') {
              if (pc.currentRemoteDescription) await pc.addIceCandidate(m.candidate);
              else pending.push(m.candidate);
            } else if (m.type === 'bye') {
              stop(false); st('接收端已关闭');
            }
          }
        } catch (e) { st('与接收端断开，请重开网址', true); polling = false; return; }
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    function stop(remote) {
      polling = false;
      try { if (pc) pc.close(); } catch (e) {}
      pc = null;
      if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
      startBtn.style.display = 'inline-block'; stopBtn.style.display = 'none';
      if (!remote) st('已停止');
    }
    startBtn.onclick = start;
    stopBtn.onclick = () => { stop(false); st('已停止'); };

    // ---------- 上传上屏 ----------
    const upBtn = document.getElementById('upBtn');
    const upFile = document.getElementById('upFile');
    const ubar = document.getElementById('ubar');
    const ubarFill = document.getElementById('ubarFill');
    const ust = document.getElementById('ust');
    upBtn.onclick = () => upFile.click();
    upFile.onchange = async () => {
      const f = upFile.files && upFile.files[0];
      if (!f) return;
      ubar.style.display = 'block'; ubarFill.style.width = '0';
      ust.textContent = '上传中：' + f.name;
      try {
        const r = await fetch('/api/upload?name=' + encodeURIComponent(f.name) + '&type=' + encodeURIComponent(f.type || ''), {
          method: 'POST', body: f,
        });
        const j = await r.json();
        if (j.ok) { ubarFill.style.width = '100%'; ust.textContent = '✅ 已上屏：' + f.name; }
        else { ust.textContent = '上传失败，请重试'; ust.className = 'warn'; }
      } catch (e) { ust.textContent = '上传失败，请确认与大屏在同一 WiFi'; ust.className = 'warn'; }
      upFile.value = '';
      setTimeout(() => { ubar.style.display = 'none'; }, 1500);
    };
  </script>
</body>
</html>`;

/* ---------- 无线遥控页：手机/电脑浏览器打开，遥控音乐/PPT/视频 ---------- */
const REMOTE_PAGE = String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>小天AIGC · 无线遥控</title>
<style>
  html,body{margin:0;background:#161616;color:#eaeaea;font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
  body{padding:16px;max-width:520px;margin:0 auto}
  h1{font-size:18px;margin:6px 0 12px;font-weight:700;text-align:center}
  .sec{background:#1d2330;border:1px solid #33415c;border-radius:14px;padding:12px 14px;margin-bottom:12px}
  .sec h2{margin:0 0 10px;font-size:14px;color:#7dc4ff}
  .row{display:flex;gap:8px;flex-wrap:wrap}
  button{flex:1;min-height:48px;font-size:15px;font-weight:700;color:#fff;background:#26314a;border:1px solid #3a4a6b;border-radius:10px;cursor:pointer}
  button:active{transform:scale(.96);background:#1473e6}
  button.danger{background:#5c2630;border-color:#7c3640}
  #rstat{background:#10151f;border:1px solid #2b3446;border-radius:10px;padding:10px 12px;font-size:13px;line-height:1.9;color:#a3c8ee;margin-bottom:12px}
  #rerr{color:#da7b11;font-size:12px;min-height:16px;text-align:center}
</style>
</head>
<body>
  <h1>小天AIGC · 无线遥控</h1>
  <div id="rstat">连接中…</div>

  <div class="sec">
    <h2>🎵 音乐</h2>
    <div class="row">
      <button onclick="cmd('music','prev')">⏮ 上一首</button>
      <button onclick="cmd('music','toggle')">▶ 播放 / 暂停</button>
      <button onclick="cmd('music','next')">⏭ 下一首</button>
    </div>
    <div class="row" style="margin-top:8px">
      <button onclick="cmd('music','mute')">🔇 静音</button>
      <button onclick="cmd('music','volDown')">🔉 音量−</button>
      <button onclick="cmd('music','volUp')">🔊 音量＋</button>
    </div>
  </div>

  <div class="sec">
    <h2>📽 PPT</h2>
    <div class="row">
      <button onclick="cmd('ppt','prev')">⏮ 上一页</button>
      <button onclick="cmd('ppt','next')">⏭ 下一页</button>
      <button class="danger" onclick="cmd('ppt','exit')">✕ 退出放映</button>
    </div>
  </div>

  <div class="sec">
    <h2>🎬 视频</h2>
    <div class="row">
      <button onclick="cmd('video','toggle')">▶ 播放 / 暂停</button>
      <button class="danger" onclick="cmd('video','stop')">⏹ 停止</button>
      <button onclick="cmd('video','volUp')">🔊</button>
      <button onclick="cmd('video','volDown')">🔉</button>
    </div>
  </div>

  <div id="rerr"></div>

  <script>
    var rstat = document.getElementById('rstat');
    var rerr = document.getElementById('rerr');
    function show(t, warn) { rerr.textContent = t; rerr.style.color = warn ? '#da7b11' : '#7dc4ff'; }
    // 令牌过期（大屏 app 重启后旧 Cookie 失效）→ 自动刷新一次拿新令牌；5 秒内不重复刷，防刷新风暴
    function reloadOnce() {
      var last = 0;
      try { last = Number(sessionStorage.getItem('xt-rl') || 0); } catch (e) { }
      if (Date.now() - last > 5000) {
        try { sessionStorage.setItem('xt-rl', String(Date.now())); } catch (e) { }
        location.reload();
      } else {
        show('连接已过期，请手动下拉刷新本页', true);
      }
    }
    function cmd(t, c, page) {
      fetch('/api/remote/cmd', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: t, cmd: c, page: page || 0 }) })
        .then(function (r) { if (r.status === 401) { reloadOnce(); return null; } return r.json(); })
        .then(function (j) { if (j && !j.ok) show('命令未被接受'); })
        .catch(function () { show('与大屏断开，请检查 WiFi', true); });
    }
    function pollState() {
      fetch('/api/remote/state').then(function (r) { if (r.status === 401) { reloadOnce(); return null; } return r.json(); }).then(function (j) {
        if (!j) return;
        var s = j.state || {};
        var m = s.music || {}, p = s.ppt || {}, v = s.video || {};
        var lines = [];
        lines.push('🎵 音乐：' + (m.track ? '♪ ' + m.track : '未在播放') + (m.playing ? '（播放中）' : (m.track ? '（已暂停）' : '')) + ' · 音量 ' + (m.volume || 0) + '%');
        lines.push('📽 PPT：' + (p.presenting ? '放映中 第 ' + p.position + ' / ' + p.total + ' 页' : '未在放映'));
        lines.push('🎬 视频：' + (v.playing ? '投放中' : '未播放'));
        rstat.innerHTML = lines.map(function (x) { return '<div>' + x + '</div>'; }).join('');
      }).catch(function () { rstat.textContent = '与大屏断开，请检查 WiFi 后刷新本页'; });
    }
    setInterval(pollState, 1000);
    pollState();
  </script>
</body>
</html>`;

function handle(req, res) {
  const u = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') { sendJson(req, res, 200, {}); return; }
  if (u.pathname === '/' || u.pathname === '/index.html') {
    servePage(res, SENDER_PAGE.replace('__HTTPS_PORT__', String(httpsPort || port + 1)).replace(/__HTTP_PORT__/g, String(port)));
    return;
  }
  if (u.pathname === '/remote') {
    servePage(res, REMOTE_PAGE);
    return;
  }
  // 证书是公开资料，放行；其余 /api/* 与 /media/* 一律要求令牌（BUG-01）
  if (u.pathname !== '/cast.crt' && (u.pathname.startsWith('/api/') || u.pathname.startsWith('/media/'))) {
    // /media/ 额外接受 URL 签名 ?k=：<img>/<video> 发不出请求头，只能用 URL 带令牌
    const signed = u.pathname.startsWith('/media/') && authToken && u.searchParams.get('k') === authToken;
    if (!signed && !tokenOk(req)) { sendJson(req, res, 401, { ok: false, error: 'unauthorized' }); return; }
  }
  if (u.pathname === '/api/remote/state' && req.method === 'GET') {
    const st = stateProvider ? (stateProvider() || {}) : {};
    sendJson(req, res, 200, { ok: true, state: st });
    return;
  }
  if (u.pathname === '/api/remote/cmd' && req.method === 'POST') {
    let body = '';
    let tooLarge = false;
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e4 && !tooLarge) {
        tooLarge = true;
        sendJson(req, res, 413, { ok: false, error: 'too-large' });
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooLarge) return;
      try {
        const j = JSON.parse(body || '{}');
        const allowed = REMOTE_CMDS[j.target];
        const cmd = String(j.cmd || '');
        if (!allowed || !allowed.has(cmd)) { sendJson(req, res, 400, { ok: false, error: 'bad-cmd' }); return; }
        if (commandCb) commandCb({ target: j.target, cmd, page: Number(j.page) || 0 });
        sendJson(req, res, 200, { ok: true });
      } catch { sendJson(req, res, 400, { ok: false }); }
    });
    return;
  }
  if (u.pathname === '/cast.crt' && currentCert) {
    res.writeHead(200, {
      'Content-Type': 'application/x-x509-ca-cert',
      'Content-Disposition': 'attachment; filename="xiaotian-cast.crt"',
    });
    res.end(currentCert.cert);
    return;
  }
  if (u.pathname === '/api/upload' && req.method === 'POST') { handleUpload(req, res, u); return; }
  if (u.pathname.startsWith('/media/') && (req.method === 'GET' || req.method === 'HEAD')) { serveMedia(req, res, u.pathname.slice(7)); return; }
  if (u.pathname === '/api/poll' && req.method === 'GET') {
    const role = u.searchParams.get('role') === 'sender' ? 'sender' : 'receiver';
    const messages = queues[role].splice(0);
    sendJson(req, res, 200, { messages });
    return;
  }
  if (u.pathname === '/api/signal' && req.method === 'POST') {
    let body = '';
    let tooLarge = false;
    req.on('data', (c) => {
      body += c;
      if (body.length > 2e6 && !tooLarge) {
        tooLarge = true;
        sendJson(req, res, 413, { ok: false, error: 'too-large' });
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooLarge) return;
      try {
        const j = JSON.parse(body || '{}');
        const to = j.to === 'sender' ? 'sender' : 'receiver';
        const msg = (j.msg && typeof j.msg === 'object') ? j.msg : {};
        queues[to].push(msg);
        if (to === 'receiver' && msg.type === 'offer') notify('sender-found');   // 有设备发起共享
        if (to === 'sender' && msg.type === 'answer') notify('connected');       // 接收端已应答
        sendJson(req, res, 200, { ok: true });
      } catch { sendJson(req, res, 400, { ok: false }); }
    });
    return;
  }
  if (u.pathname === '/api/status' && req.method === 'GET') {
    sendJson(req, res, 200, { ok: true, port, httpsPort });
    return;
  }
  sendJson(req, res, 404, { ok: false });
}

async function listenOn(create, p) {
  return new Promise((resolve) => {
    const srv = create();
    srv.once('error', (e) => resolve({ ok: false, error: e.code || 'listen-error' }));
    srv.listen(p, '0.0.0.0', () => resolve({ ok: true, srv, port: srv.address().port }));
  });
}

let starting = null; // 正在启动中的 Promise：并发 start 复用同一次，杜绝双服务
let abortGen = 0;    // stop() 会自增：启动途中被停止时，本次启动代号作废并关掉刚起的 server

async function start(cb, opts = {}) {
  // 单文件上传上限：默认 500MB；测试可传更小的值走真实 413 分支（不加测试专用环境变量）
  if (Number.isFinite(opts && opts.uploadMax) && opts.uploadMax > 0) uploadMax = Math.floor(opts.uploadMax);
  // 并发守卫（照搬 pptServer 的 starting 串行化写法）：
  // start() 内部有 await，可被并发进入。若不加闸，双击「无线同屏」会起两个服务——
  // A 拿到 18333、B 拿到 18334 并覆盖模块变量，srvA 此后永不被 stop() 关闭，
  // 仍在对外服务且持有效 token，表现为「点了停止却停不掉」。
  if (starting) return starting;
  stop();               // 先关掉上一轮（同一次启动内不再重复调用）
  const gen = abortGen; // 本次启动代号；stop() 若在启动途中发生会自增，届时作废
  starting = (async () => {
  statusCb = cb || null;
  authToken = makeToken(); // 每次启动换新令牌；stop() 时作废
  queues.receiver.length = 0;
  queues.sender.length = 0;
  ensureUploadsDir();
  currentCert = ensureCert();

  for (let i = 0; i <= MAX_OFFSET; i++) {
    const r = await listenOn(() => http.createServer(handle), DEFAULT_PORT + i);
    if (!r.ok) continue;
    httpServer = r.srv;
    port = r.port;
    const certs = currentCert;
    for (let j = 1; j <= MAX_OFFSET; j++) {
      const r2 = await listenOn(() => https.createServer({ key: certs.key, cert: certs.cert }, handle), port + j);
      if (r2.ok) { httpsServer = r2.srv; httpsPort = r2.port; break; }
    }
    break;
  }
  if (!httpServer) return { ok: false, error: 'port-busy' };
  // 启动途中用户已点了停止：立刻把刚 listen 成功的 server 关掉，不留野服务
  if (gen !== abortGen) {
    if (httpServer) { try { httpServer.close(); } catch { } }
    if (httpsServer) { try { httpsServer.close(); } catch { } }
    httpServer = null; httpsServer = null;
    return { ok: false, error: 'aborted' };
  }
  const ip = lanIp();
  url = `http://${ip}:${port}`;
  httpsUrl = httpsServer ? `https://${ip}:${httpsPort}` : '';
  // 自动装入 Windows 受信任根（SEC-03：可在「设置 → 自动信任投屏证书」关闭；关闭后首次投屏手动允许即可）
  if (config.get().castAutoTrustCert) trustCertWindows(currentCert);
  return { ok: true, url, httpsUrl, port, httpsPort, token: authToken };
  })();
  try {
    return await starting;
  } finally {
    starting = null;
  }
}

function stop() {
  abortGen++; // 作废正在进行的启动：它会在 listen 成功后自检并关掉自己的 server
  if (httpServer) { try { httpServer.close(); } catch { } }
  if (httpsServer) { try { httpsServer.close(); } catch { } }
  // 只 close() 不会断已建立的 keep-alive 连接：投屏停止后旧发送端仍握着长连接轮询
  if (httpServer && httpServer.closeAllConnections) { try { httpServer.closeAllConnections(); } catch { } }
  if (httpsServer && httpsServer.closeAllConnections) { try { httpsServer.closeAllConnections(); } catch { } }
  httpServer = null;
  httpsServer = null;
  url = '';
  httpsUrl = '';
  authToken = '';
  uploads.clear();
  statusCb = null;
}
function running() { return !!httpServer; }
function current() { return { running: !!httpServer, url, httpsUrl, port, httpsPort, token: authToken }; }

// 预热证书：RSA-2048 keygen 是纯 CPU 的同步重活（本机实测 ~91ms，低端一体机 0.5~0.8s），
// 放在 start() 里就是「点无线同屏像假死」。改为启动后空闲时段先跑一遍，
// 之后按 IP 命中缓存，首次点击就是零成本。
function warmCert() {
  try { return ensureCert(); } catch { return null; }
}

module.exports = { start, stop, bye, running, current, setCommandHandler, setStateProvider, warmCert };

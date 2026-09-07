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

const DEFAULT_PORT = 18333;
const MAX_OFFSET = 8;
const UPLOAD_MAX = 500 * 1024 * 1024; // 单文件上限 500MB

let httpServer = null;
let httpsServer = null;
let port = 0;
let httpsPort = 0;
let url = '';
let httpsUrl = '';
let statusCb = null;
let uploadsDir = '';
const uploads = new Map(); // id -> {file, name, mime}
const queues = { receiver: [], sender: [] };

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

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*', // 接收端页从 file:// 加载，跨源需放行
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(obj));
}

function notify(ev) { if (statusCb) statusCb(ev); }

// 让发送端离开（接收端主动关闭时通知浏览器释放流）
function bye() { queues.sender.push({ type: 'bye' }); }

/* ---------- 自签证书（首次生成后缓存在 userData，此后毫秒级启动） ---------- */
function ensureCert() {
  const { app } = require('electron');
  const dir = path.join(app.getPath('userData'), 'cast-cert');
  const keyFile = path.join(dir, 'key.pem');
  const crtFile = path.join(dir, 'cert.pem');
  try {
    const key = fs.readFileSync(keyFile, 'utf8');
    const cert = fs.readFileSync(crtFile, 'utf8');
    if (key && cert) return { key, cert };
  } catch { }
  // eslint-disable-next-line global-require
  const forge = require('node-forge');
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01' + Date.now().toString(16);
  cert.validity.notBefore = new Date(Date.now() - 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000);
  const attrs = [{ name: 'commonName', value: 'xiaotian-aigc-cast' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  const altNames = [
    { type: 7, ip: '127.0.0.1' },
    { type: 2, value: 'localhost' },
  ];
  const ip = lanIp();
  if (ip && ip !== '127.0.0.1') altNames.push({ type: 7, ip });
  cert.setExtensions([{ name: 'subjectAltName', altNames }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const key = forge.pki.privateKeyToPem(keys.privateKey);
  const crt = forge.pki.certificateToPem(cert);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(keyFile, key);
    fs.writeFileSync(crtFile, crt);
  } catch { }
  return { key, cert: crt };
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
    sendJson(res, 400, { ok: false, error: 'bad-path' });
    return;
  }
  const file = target;
  const out = fs.createWriteStream(file);
  let size = 0;
  let aborted = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > UPLOAD_MAX) { aborted = true; req.destroy(); }
  });
  req.pipe(out);
  out.on('finish', () => {
    if (aborted) { try { fs.rmSync(file, { force: true }); } catch { } return; }
    const mimeFinal = mime || MIME_MAP[ext] || 'application/octet-stream';
    uploads.set(id, { file, name, mime: mimeFinal });
    queues.receiver.push({ type: 'upload', id, name, mime: mimeFinal });
    notify('upload');
    sendJson(res, 200, { ok: true, id, url: `/media/${id}` });
  });
  out.on('error', () => sendJson(res, 500, { ok: false, error: 'save-failed' }));
}

function serveMedia(res, id) {
  const rec = uploads.get(String(id).slice(0, 64));
  if (!rec || !fs.existsSync(rec.file)) { sendJson(res, 404, { ok: false }); return; }
  res.writeHead(200, { 'Content-Type': rec.mime, 'Access-Control-Allow-Origin': '*' });
  fs.createReadStream(rec.file).pipe(res);
}

/* ---------- 发送端网页（内联，无外部资源） ---------- */
/* __HTTPS_PORT__ 会在响应时替换成真实的 HTTPS 端口 */
const SENDER_PAGE = String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>小天AIGC · 无线同屏</title>
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
  #upFile{display:none}
  .bar{height:8px;background:#0d1117;border-radius:4px;overflow:hidden;margin-top:10px;display:none}
  .bar i{display:block;height:100%;width:0;background:#1d9a52;transition:width .2s}
</style>
</head>
<body>
  <div class="logo">📺</div>
  <h1>小天AIGC · 无线同屏</h1>

  <div class="card">
    <h2>方式一 · 镜像投屏（安卓手机 / 电脑）</h2>
    <div class="tip">把整个手机/电脑屏幕实时投到教室大屏。</div>
    <div style="text-align:center;margin-top:12px">
      <button id="startBtn">🖥 开始共享屏幕</button>
      <button id="goHttpsBtn" class="green" style="display:none">🔒 进入加密镜像页</button>
      <button id="stopBtn">⏹ 停止共享</button>
    </div>
    <div id="st">就绪</div>
    <div class="alt">首次进入加密页若提示「证书风险 / 不安全」，点「高级 → 继续前往」即可，这是局域网自建加密的正常提示。</div>
  </div>

  <div class="card">
    <h2>方式二 · 上传上屏（所有手机，含苹果）</h2>
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

function handle(req, res) {
  const u = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') { sendJson(res, 200, {}); return; }
  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(SENDER_PAGE.replace('__HTTPS_PORT__', String(httpsPort || port + 1)));
    return;
  }
  if (u.pathname === '/api/upload' && req.method === 'POST') { handleUpload(req, res, u); return; }
  if (u.pathname.startsWith('/media/') && req.method === 'GET') { serveMedia(res, u.pathname.slice(7)); return; }
  if (u.pathname === '/api/poll' && req.method === 'GET') {
    const role = u.searchParams.get('role') === 'sender' ? 'sender' : 'receiver';
    const messages = queues[role].splice(0);
    sendJson(res, 200, { messages });
    return;
  }
  if (u.pathname === '/api/signal' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', () => {
      try {
        const j = JSON.parse(body || '{}');
        const to = j.to === 'sender' ? 'sender' : 'receiver';
        const msg = (j.msg && typeof j.msg === 'object') ? j.msg : {};
        queues[to].push(msg);
        if (to === 'receiver' && msg.type === 'offer') notify('sender-found');   // 有设备发起共享
        if (to === 'sender' && msg.type === 'answer') notify('connected');       // 接收端已应答
        sendJson(res, 200, { ok: true });
      } catch { sendJson(res, 400, { ok: false }); }
    });
    return;
  }
  if (u.pathname === '/api/status' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, port, httpsPort });
    return;
  }
  sendJson(res, 404, { ok: false });
}

async function listenOn(create, p) {
  return new Promise((resolve) => {
    const srv = create();
    srv.once('error', (e) => resolve({ ok: false, error: e.code || 'listen-error' }));
    srv.listen(p, '0.0.0.0', () => resolve({ ok: true, srv, port: srv.address().port }));
  });
}

async function start(cb) {
  stop();
  statusCb = cb || null;
  queues.receiver.length = 0;
  queues.sender.length = 0;
  ensureUploadsDir();

  for (let i = 0; i <= MAX_OFFSET; i++) {
    const r = await listenOn(() => http.createServer(handle), DEFAULT_PORT + i);
    if (!r.ok) continue;
    httpServer = r.srv;
    port = r.port;
    const certs = ensureCert();
    for (let j = 1; j <= MAX_OFFSET; j++) {
      const r2 = await listenOn(() => https.createServer({ key: certs.key, cert: certs.cert }, handle), port + j);
      if (r2.ok) { httpsServer = r2.srv; httpsPort = r2.port; break; }
    }
    break;
  }
  if (!httpServer) return { ok: false, error: 'port-busy' };
  const ip = lanIp();
  url = `http://${ip}:${port}`;
  httpsUrl = httpsServer ? `https://${ip}:${httpsPort}` : '';
  return { ok: true, url, httpsUrl, port, httpsPort };
}

function stop() {
  if (httpServer) { try { httpServer.close(); } catch { } }
  if (httpsServer) { try { httpsServer.close(); } catch { } }
  httpServer = null;
  httpsServer = null;
  url = '';
  httpsUrl = '';
  uploads.clear();
  statusCb = null;
}
function running() { return !!httpServer; }
function current() { return { running: !!httpServer, url, httpsUrl, port, httpsPort }; }

module.exports = { start, stop, bye, running, current };

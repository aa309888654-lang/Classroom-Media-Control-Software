/* 局域网遥控发现（UDP 广播信标）：
 * 被控电脑开着「无线同屏」时，castServer 的遥控 API 才在监听——所以信标也只在
 * 同屏服务运行期间广播，内容仅 {app, name, httpPort}，供控制端列出可遥控设备。
 * 真正的命令不走 UDP，走 peerClient 的 HTTP（/api/remote/cmd，带令牌）。 */
const dgram = require('dgram');
const os = require('os');

const BEACON_PORT = 18334;     // 信标 UDP 端口（与 castServer 的 18333 错开）
const BEACON_INTERVAL = 2000;  // 广播周期
const PEER_TTL = 6000;         // 超过 6s 没再收到信标 → 视为离线
const APP_TAG = 'xiaotian-aigc-peer';

function ipToInt(ip) {
  const p = String(ip).split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const part of p) {
    const v = Number(part);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n * 256) + v;
  }
  return n >>> 0;
}

// 各网卡的定向广播地址 + 全局广播地址：部分路由器禁 255.255.255.255，定向广播兜底
function broadcastAddrs() {
  const out = new Set(['255.255.255.255']);
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const i of infos || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      const ipN = ipToInt(i.address);
      const maskN = i.netmask ? ipToInt(i.netmask) : null;
      if (ipN == null || maskN == null) continue;
      const bc = (ipN & maskN) | (~maskN >>> 0);
      out.add([bc >>> 24, (bc >> 16) & 255, (bc >> 8) & 255, bc & 255].join('.'));
    }
  }
  return [...out];
}

/* 纯函数：新信标合并进设备表（同 ip:port 只刷新时间戳/名字），过期项剔除。
 * 抽成纯函数是为了单测不依赖真实网络。 */
function mergePeers(list, incoming, now) {
  const map = new Map();
  for (const p of list || []) {
    if (p && p.ip && p.port && now - p.lastSeen < PEER_TTL) map.set(`${p.ip}:${p.port}`, p);
  }
  const key = `${incoming.ip}:${incoming.port}`;
  const prev = map.get(key);
  map.set(key, {
    ip: incoming.ip,
    port: Number(incoming.port),
    name: incoming.name || (prev && prev.name) || incoming.ip,
    lastSeen: now,
  });
  // 显式指定 zh-Hans-CN：localeCompare() 不带 locale 时跟随**系统语言**，
  // 英文环境下（en-US）中文会退化成按 Unicode 码点排序 —— 同一份设备表
  // 在中文机和英文机上顺序不一致（办公室/会议室/三年二班 → 三年二班/会议室/办公室）。
  // GitHub Actions 的 windows runner 就是英文环境，这条曾导致 peer.test.js 挂掉。
  return [...map.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
}

/* ---------- 信标广播（被控端；随同屏服务启停） ---------- */
let beaconSock = null;
let beaconTimer = null;
let selfPort = 0; // 本机同屏服务端口：扫描时用来排除自己的信标

function sendBeacon() {
  if (!beaconSock || !selfPort) return;
  const msg = Buffer.from(JSON.stringify({ app: APP_TAG, name: os.hostname(), httpPort: selfPort }));
  for (const addr of broadcastAddrs()) {
    try { beaconSock.send(msg, BEACON_PORT, addr); } catch { }
  }
}

function startBeacon(httpPort) {
  stopBeacon();
  selfPort = Number(httpPort) || 0;
  if (!selfPort) return;
  const sock = dgram.createSocket('udp4');
  try {
    beaconSock = sock; // 登记给 stopBeacon，否则本次 socket 无人能关
    sock.on('error', () => { });
    sock.bind(() => {
      // bind 回调可能在 stopBeacon() 之后才跑（极短窗口内开关同屏）。
      // 回调里必须认领「我还是当前信标吗」：不是就自毁，否则会留下一个
      // 永不被清理的孤儿 setInterval + 一个仍在发信标的 socket（BUG）。
      if (beaconSock !== sock) { try { sock.close(); } catch { } return; }
      try { sock.setBroadcast(true); } catch { }
      sendBeacon(); // 立即广播一次，不用等一个周期
      beaconTimer = setInterval(sendBeacon, BEACON_INTERVAL);
      if (beaconTimer.unref) beaconTimer.unref(); // 不拖住进程退出
      if (sock.unref) sock.unref();
    });
  } catch { }
}

function stopBeacon() {
  if (beaconTimer) clearInterval(beaconTimer);
  beaconTimer = null;
  if (beaconSock) { try { beaconSock.close(); } catch { } }
  beaconSock = null;
  selfPort = 0;
}

/* ---------- 信标扫描（控制端；打开遥控面板时启，关闭时停） ---------- */
let scanSock = null;
let scanPeers = [];
let scanCb = null;

function startScan(cb) {
  stopScan();
  scanCb = cb || null;
  scanPeers = [];
  try {
    scanSock = dgram.createSocket('udp4');
    scanSock.on('message', (msg, rinfo) => {
      let j = null;
      try { j = JSON.parse(msg.toString('utf8')); } catch { return; }
      if (!j || j.app !== APP_TAG || !j.httpPort) return;
      if (j.name === os.hostname() && Number(j.httpPort) === selfPort) return; // 自己的信标
      scanPeers = mergePeers(scanPeers, { ip: rinfo.address, port: Number(j.httpPort), name: j.name }, Date.now());
      if (scanCb) scanCb(scanPeers);
    });
    scanSock.on('error', () => { }); // 端口被占用等：静默，面板仍可手动输 IP 连接
    scanSock.bind(BEACON_PORT, () => { try { scanSock.setBroadcast(true); } catch { } });
    if (scanSock.unref) scanSock.unref();
  } catch { }
}

function stopScan() {
  if (scanSock) { try { scanSock.close(); } catch { } }
  scanSock = null;
  scanPeers = [];
  scanCb = null;
}

module.exports = { BEACON_PORT, PEER_TTL, mergePeers, startBeacon, stopBeacon, startScan, stopScan };

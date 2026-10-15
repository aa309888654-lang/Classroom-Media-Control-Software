/* 遥控客户端（控制端）：通过 HTTP 驱动另一台电脑上的小天AIGC。
 * 被控端只需开着「无线同屏」。鉴权复用手机遥控页同一套机制：
 * 首次 GET /remote 时服务端下发 Set-Cookie: dshcast=<令牌>，
 * 之后命令/状态查询都带该 Cookie，不引入新协议、不降低原有门槛。 */
const TIMEOUT_MS = 4000;

let session = null; // { ip, port, cookie, name }

async function fetchWithTimeout(url, opts = {}) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

function authHeaders() {
  return session ? { Cookie: `dshcast=${session.cookie}` } : {};
}

// 连接：拿 Cookie 令牌 + 拉一次状态验证链路可用
async function connect(ip, port, name) {
  disconnect();
  const p = Number(port) || 18333;
  const host = String(ip || '').trim();
  if (!host) return { ok: false, error: 'no-ip' };
  let res;
  try {
    res = await fetchWithTimeout(`http://${host}:${p}/remote`);
  } catch { return { ok: false, error: 'unreachable' }; }
  if (!res.ok) return { ok: false, error: 'http-' + res.status };
  let cookie = '';
  const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of cookies) {
    const m = /(?:^|;\s*)dshcast=([^;]+)/.exec(c);
    if (m) { cookie = m[1]; break; }
  }
  if (!cookie) return { ok: false, error: 'no-token' };
  session = { ip: host, port: p, cookie, name: name || host };
  const st = await state();
  if (!st.ok) { disconnect(); return { ok: false, error: st.error || 'state-failed' }; }
  return { ok: true, state: st.state, name: session.name, ip: session.ip, port: session.port };
}

async function state() {
  if (!session) return { ok: false, error: 'not-connected' };
  try {
    const res = await fetchWithTimeout(`http://${session.ip}:${session.port}/api/remote/state`, { headers: authHeaders() });
    if (res.status === 401) { disconnect(); return { ok: false, error: 'unauthorized' }; }
    const j = await res.json();
    return j && j.ok ? { ok: true, state: j.state || {} } : { ok: false, error: 'bad-state' };
  } catch { return { ok: false, error: 'unreachable' }; }
}

async function cmd(target, cmd, page = 0) {
  if (!session) return { ok: false, error: 'not-connected' };
  try {
    const res = await fetchWithTimeout(`http://${session.ip}:${session.port}/api/remote/cmd`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ target, cmd, page: Number(page) || 0 }),
    });
    if (res.status === 401) { disconnect(); return { ok: false, error: 'unauthorized' }; }
    return await res.json();
  } catch { return { ok: false, error: 'unreachable' }; }
}

function current() {
  return session ? { ip: session.ip, port: session.port, name: session.name } : null;
}

function disconnect() { session = null; }

module.exports = { connect, state, cmd, current, disconnect };

/* 接收端核心（共享）：轮询信令服务取 offer → 应答 → 接到视频流后交给 <video>。
 * 仅在 file:// 页面里运行，信令走 http://127.0.0.1（本机），不依赖外网。 */
window.CastReceiver = (() => {
  let pc = null;
  let port = 0;
  let video = null;
  let running = false;
  const pendingIce = [];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function api(path, body) {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : undefined);
    return r.json();
  }

  async function start(opts) {
    port = Number(opts.port);
    video = opts.video;
    running = true;
    const onState = opts.onState || (() => {});
    const onUpload = opts.onUpload || null;
    pc = new RTCPeerConnection();

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        api('/api/signal', { to: 'sender', msg: { type: 'ice', candidate: e.candidate } }).catch(() => { });
      }
    };
    pc.ontrack = (e) => {
      video.srcObject = e.streams[0];
      video.hidden = false;
      video.play().catch(() => { });
      onState('playing');
    };
    pc.onconnectionstatechange = () => {
      if (pc && ['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
        onState('disconnected');
      }
    };

    // 轮询等待发送端的 offer；同时收集发送端 ICE
    while (running && (!pc.currentRemoteDescription)) {
      try {
        const j = await api('/api/poll?role=receiver');
        for (const m of j.messages || []) {
          if (m.type === 'offer') {
            await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
            for (const c of pendingIce) await pc.addIceCandidate(c);
            pendingIce.length = 0;
            const ans = await pc.createAnswer();
            await pc.setLocalDescription(ans);
            await api('/api/signal', { to: 'sender', msg: { type: 'answer', sdp: pc.localDescription.sdp } });
            onState('connecting');
          } else if (m.type === 'ice') {
            if (pc.currentRemoteDescription) await pc.addIceCandidate(m.candidate);
            else pendingIce.push(m.candidate);
          } else if (m.type === 'upload' && onUpload) {
            onUpload(m); // 上传上屏：iPhone 等不支持网页镜像的设备走这条通道
          } else if (m.type === 'bye') {
            onState('bye');
            stop();
            return;
          }
        }
      } catch { onState('error'); }
      if (running && !pc.currentRemoteDescription) await sleep(300);
    }
    // 已握手后继续轮询收集 ICE（NAT/host 候选补齐）
    while (running) {
      try {
        const j = await api('/api/poll?role=receiver');
        for (const m of j.messages || []) {
          if (m.type === 'ice' && pc.currentRemoteDescription) await pc.addIceCandidate(m.candidate);
          else if (m.type === 'upload' && onUpload) onUpload(m);
          if (m.type === 'bye') { onState('bye'); stop(); return; }
        }
      } catch { }
      await sleep(300);
    }
  }

  function stop() {
    running = false;
    if (pc) { try { pc.close(); } catch { } }
    pc = null;
    if (video) { try { video.srcObject = null; } catch { } }
  }

  return { start, stop };
})();

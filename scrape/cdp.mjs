/* ==========================================================================
 * 极简 Chrome DevTools Protocol 客户端（零依赖）
 * --------------------------------------------------------------------------
 * 为什么不直接用 puppeteer-core：
 *   puppeteer-core 会给 worker.js 带来几百 KB 依赖与 Node API 依赖（ws/http 等），
 *   线上 Worker（workerd）不一定能跑，一旦 bundle 跑不起来会**连带打挂线上生产 Worker**。
 *   Cloudflare Browser Rendering 的 browser binding 本身就提供
 *   「WebSocket Fetcher → CDP」通道，Workers 原生有 WebSocket + Fetcher，
 *   所以这里只实现 CDP 的消息收发（~80 行），零新增依赖、零新增运行时风险。
 *
 * 用法（Cloudflare Worker 内）：
 *   const session = await env.BROWSER.launch();
 *   const resp = await session.webSocket.fetch("https://browser-binding.invalid",
 *                                             { headers: { Upgrade: "websocket" } });
 *   const socket = resp.webSocket; socket.accept();
 *   const cdp = createCdpClient(socket);
 *   await cdp.send("Page.navigate", { url: "https://..." });
 *   socket.close();
 * ========================================================================== */

export function createCdpClient(socket) {
  let nextId = 0;
  const pending = new Map();
  const listeners = [];   // 事件订阅：on(method, cb)

  const onMessage = (ev) => {
    let msg;
    try {
      const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }
    // 事件（无 id）→ 广播给订阅者
    if (msg && msg.id == null) {
      if (msg.method) {
        for (const l of listeners) {
          if (l.method === msg.method) { try { l.cb(msg.params || {}); } catch (e) { /* ignore */ } }
        }
      }
      return;
    }
    if (!msg || msg.id == null || !pending.has(msg.id)) return;
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error((msg.error && msg.error.message) || "CDP error"));
    else p.resolve(msg.result);
  };
  const onClose = () => {
    for (const [, p] of pending) p.reject(new Error("CDP 连接已关闭"));
    pending.clear();
  };
  socket.addEventListener("message", onMessage);
  socket.addEventListener("close", onClose);
  // Workers 的 WebSocket 需要显式 accept；Node 的全局 WebSocket 无此方法
  if (typeof socket.accept === "function") {
    try { socket.accept(); } catch (e) { /* 已 accept 过 */ }
  }

  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, 30000);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
      try {
        socket.send(JSON.stringify(payload));
      } catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        reject(e);
      }
    });
  }

  return {
    send,
    on(method, cb) {
      listeners.push({ method, cb });
      return () => { const i = listeners.findIndex((l) => l.method === method && l.cb === cb); if (i >= 0) listeners.splice(i, 1); };
    },
    close() {
      try { socket.close(); } catch (e) { /* ignore */ }
    },
  };
}

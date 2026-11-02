/* ==========================================================================
 * 江苏银行 App 端口 —— Cloudflare Workers 版（走 Cloudflare Browser Rendering）
 * ==========================================================================
 *
 * 【为什么线上 Worker 需要「浏览器」】
 *   江苏银行全线（mbank5h5 手机银行 H5 / www 官网 / 苏银理财官网 suyinwealth.com）
 *   都挂在同一套 WAF（NRPd / 瑞数系）后面：
 *     · 首次请求一律 202 / 412 / 445 + JS 挑战页；
 *     · 挑战脚本是【多层字节码 VM 混淆器】，靠 `window.eval` 逐层解包执行；
 *     · 解出的状态 = cookie（FSSBBIl1UgzbN7NP）+ **每个请求都要带的 URL 签名 XhC8Wb**；
 *     · 实测（2026-10-29）：不带签名的请求，一次挑战只放行第 1 个，之后全部 202。
 *   而 Cloudflare Workers **明令禁止 eval() 与 new Function**（官方文档：For security
 *   reasons, the following are not allowed: eval(), new Function...），
 *   ⇒ 这套 WAF 脚本在 Worker 里跑不起来，纯 fetch 方案必然失败。
 *   ⇒ 唯一可行解：Worker 里驱动一个**真 Chromium**（Cloudflare Browser Rendering），
 *     让 WAF 脚本在浏览器里原生执行；本模块只负责「在页面里调银行自己的加密接口」。
 *
 * 【本模块做什么】
 *   ① 用 browser binding 拿一个 Chromium 会话（CDP over Workers 原生 WebSocket，零新增依赖）
 *   ② 打开江苏银行 H5 种子页 → WAF 自行解挑战
 *   ③ 在页面上下文里调 `window.YT.ajaxData`（银行自己的加解密 + 签名）
 *      → H5queryFinanceDetail.do（详情/七字段/额度/登记编码）
 *      → H5queryTbprddaily.do（dateFlag=4 成立以来全量净值）
 *   ④ 用 jsb_nav.mjs 的同一套映射逻辑产出与本机 Chrome 端口完全一致的结果结构
 *
 * 【性能】一次 Chromium 会话可连抓多只产品（会话复用，不必每个产品重过 WAF 挑战）：
 *   首只（含挑战）约 15~25s，之后每只约 1~3s。
 *
 * 【与本机端口的关系】
 *   scrape/jsb_app.mjs   = 本机 Chrome 版（已验证）
 *   scrape/jsb_nav.mjs   = 纯 JS 协议实现（银行官方加密模块移植，已验证；受 WAF 限制需签名）
 *   scrape/jsb_worker.mjs= 本文件：线上 Worker 用 Browser Rendering 驱动页面
 * ========================================================================== */

import { createCdpClient } from "./cdp.mjs";
import { jsbMap, jsbToSeries } from "./jsb_nav.mjs";

const JSB_SEED_URL = "https://mbank5h5.jsbchina.cn/mbank/page/indexJsb.html";
const JSB_API_BASE = "https://mbank5h5.jsbchina.cn/mbank//finance/";
const JSB_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.40(0x1800282a) NetType/WIFI Language/zh_CN";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 在页面上下文里调银行自己的加密接口（与 jsb_app.mjs 完全一致的口径） */
function apiEvalExpr(path, params, cbMs) {
  return `(() => new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    setTimeout(() => fin({ ok: false, err: "callback-timeout" }), ${cbMs});
    try {
      window.YT.ajaxData(${JSON.stringify(JSB_API_BASE + path)}, ${JSON.stringify(params)},
        (res) => { let o = res; if (typeof o === "string") { try { o = JSON.parse(o); } catch (e) {} } fin({ ok: true, data: o }); },
        (e) => fin({ ok: false, err: String((e && (e.message || e.msg || e.errMsg)) || e) }));
    } catch (e) { fin({ ok: false, err: String((e && e.message) || e) }); }
  }))()`;
}

function jsbDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * 一个 Chromium 会话内连抓多只产品。
 * @param {string[]} codes 产品代码数组
 * @param {{connect: () => Promise<{socket: WebSocket, close: () => Promise<void>}>, timeoutMs?: number}} opts
 * @returns {Promise<(object|null)[]>} 与本机端口同构的结果数组
 */
export async function jsbBrowserFetchMany(codes, opts = {}) {
  const list = (codes || []).map((c) => String(c || "").trim().toUpperCase()).filter(Boolean);
  if (!list.length) return [];
  const connect = opts.connect;
  if (typeof connect !== "function") throw new Error("jsbBrowserFetchMany 需要 connect 回调（browser binding 会话）");

  const timeoutMs = opts.timeoutMs || 60000;
  const t0 = Date.now();
  const conn = await connect();
  const cdp = createCdpClient(conn.socket);
  let targetId = null;

  try {
    const created = await cdp.send("Target.createTarget", { url: "about:blank" });
    targetId = created.targetId;
    const attached = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const sid = attached.sessionId;
    const send = (method, params) => cdp.send(method, params, sid);

    await send("Page.enable");
    await send("Runtime.enable");
    await send("Network.enable");
    // ★ 抹平自动化指纹（与本机 Chrome 对齐，详见 applyFingerprint 注释）：
    //   Cloudflare Chromium 默认 navigator.webdriver=true + languages=["en-US"]，
    //   江苏银行 WAF 行为分析据此在「带签名请求」阶段返 400 → 抓不到。
    await applyFingerprint(send, opts.variant);

    await send("Page.navigate", { url: JSB_SEED_URL });

    // 等页面把 YT 加密库准备好（WAF 解挑战 + seajs 加载）。
    // ★ 关键：WAF 挑战页与真实业务页是**两次不同的加载**——挑战脚本解出 cookie 后
    //   会带签名参数重新加载（云端实测 202 → 挑战脚本 200 → 带签名请求 400/200）。
    //   因此：一旦拿到 WAF cookie（FSSBBIl1UgzbN7NP）但 YT 还没就绪，就主动 reload 一次，
    //   让页面进入真实业务页加载 YT 库；最多重试 2 次。
    let ready = false;
    const readyDeadline = Date.now() + Math.max(timeoutMs - 15000, 15000);
    let reloaded = 0;
    while (Date.now() < readyDeadline) {
      const r = await send("Runtime.evaluate", {
        expression: "JSON.stringify({yt: !!(window.YT && window.YT.SecurityJSBANK && window.YT.SecurityJSBANK.encrypt), aes: !!window.jsbankAES, rsa: !!window.jsbankRSA, cookie: document.cookie||''})",
        returnByValue: true,
      }).catch(() => null);
      let st = null;
      try { st = JSON.parse((r && r.result && r.result.value) || "{}"); } catch (e) {}
      if (st && st.yt && st.aes && st.rsa) { ready = true; break; }
      if (st && /FSSBBIl1UgzbN7NP/.test(st.cookie || "") && reloaded < 2) {
        reloaded++;
        try { await send("Page.reload", { ignoreCache: false }); } catch (e) { /* ignore */ }
        await sleep(2500);
        continue;
      }
      await sleep(800);
    }
    if (!ready) return list.map(() => null);

    const evaluate = async (expr) => {
      const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      if (r && r.exceptionDetails) throw new Error("页面内异常: " + JSON.stringify(r.exceptionDetails).slice(0, 200));
      return r && r.result ? r.result.value : undefined;
    };

    const out = [];
    for (const prdCode of list) {
      try {
        out.push(await fetchOne(evaluate, prdCode, t0));
      } catch (e) {
        out.push(null);
      }
    }
    return out;
  } finally {
    try { if (targetId) await cdp.send("Target.closeTarget", { targetId }); } catch (e) { /* ignore */ }
    cdp.close();
    try { await conn.close(); } catch (e) { /* ignore */ }
  }
}

async function fetchOne(evaluate, prdCode, t0) {
  const det = await evaluate(apiEvalExpr("H5queryFinanceDetail.do", { prdCode }, 15000));
  if (!det || !det.ok || !det.data) return null;
  const info0 = det.data.iFinancesPrdDetailMBInfo && det.data.iFinancesPrdDetailMBInfo[0];
  if (!info0) return null;

  let series = [];
  try {
    const daily = await evaluate(apiEvalExpr("H5queryTbprddaily.do", {
      prdCode, TACode: "Y04", prodTemplateNo: "D300", dateFlag: "4", prdattr: "4",
    }, 18000));
    if (daily && daily.ok) series = jsbToSeries(daily.data && daily.data.tbprddailyList);
  } catch (e) { /* 净值失败不致命 */ }

  if (!series.length) {
    for (const df of ["3", "2", "1"]) {
      try {
        const r2 = await evaluate(apiEvalExpr("H5queryTbprddaily.do", {
          prdCode, TACode: "Y04", prodTemplateNo: "D300", dateFlag: df, prdattr: "4",
        }, 15000));
        const s2 = r2 && r2.ok ? jsbToSeries(r2.data && r2.data.tbprddailyList) : [];
        if (s2.length > series.length) series = s2;
        if (series.length) break;
      } catch (e) { /* ignore */ }
    }
  }

  const out = jsbMap(det.data, series, {
    nav: info0.NAV != null ? Number(info0.NAV) : null,
    navDate: jsbDate(info0.NAV_DATE),
    prdCode: info0.PRDCODE || prdCode,
  });
  out.productCode = out.productCode || prdCode;
  out.ms = Date.now() - t0;
  out.navNote = "江苏银行 App 端口（Cloudflare Browser Rendering 驱动页面内 YT.ajaxData，dateFlag=4 全量净值 + 七字段 + 额度 + 登记编码）";
  return out;
}

/** 单只产品（内部走批量接口，保持同一会话语义） */
export async function jsbBrowserFetch(code, opts = {}) {
  const r = await jsbBrowserFetchMany([code], opts);
  return r && r.length ? r[0] : null;
}

/**
 * Cloudflare Worker 用的连接器：browser binding → 会话 → WebSocket Fetcher → CDP
 * @param {any} env Worker 的 env（需含 BROWSER browser binding）
 */
export function makeBrowserBindingConnector(env, bindingName = "BROWSER") {
  const binding = env && env[bindingName];
  if (!binding) throw new Error("未配置 browser binding（" + bindingName + "）");
  return async function connect() {
    const session = await binding.launch();
    try {
      const resp = await session.webSocket.fetch("https://browser-binding.invalid", {
        headers: { Upgrade: "websocket" },
      });
      if (!resp || !resp.webSocket) throw new Error("Browser Run 未返回 WebSocket");
      const socket = resp.webSocket;
      return {
        socket,
        close: async () => {
          try { socket.close(); } catch (e) { /* ignore */ }
          try { await binding.closeSession(session.sessionId); } catch (e) { /* ignore */ }
        },
      };
    } catch (e) {
      try { await binding.closeSession(session.sessionId); } catch (e2) { /* ignore */ }
      throw e;
    }
  };
}

/**
 * 诊断版：把 Browser Rendering 内部每一步暴露出来（供线上排查 WAF/加载失败）。
 * 与 jsbBrowserFetchMany 的差别：① 不吞异常；② 返回每一步的探测结果；
 *   ③ 额外探测页面在云端看到的挑战形态（状态码/是否 eval 挑战/YT 是否就绪）。
 * 用法：GET /api/jsb-diag?code=J04946
 */
/**
 * 指纹策略变体：Cloudflare Browser Rendering 的 Chromium 天然带自动化痕迹，
 * 江苏银行 WAF 在「挑战通过后的带签名重载」阶段返 400 —— 疑似行为分析命中。
 * 本函数按 variant 应用不同的指纹抹平策略，供线上 A/B 一次性比对。
 *
 * v1 = iPhone 微信 UA + AutomationOverride + zh-CN
 * v2 = 同 v1，但额外用 addScriptToEvaluateOnNewDocument 硬改 navigator.webdriver=false
 * v3 = 保留 Cloudflare 原生 UA（真实 Chrome UA，不伪装手机），仅 AutomationOverride + zh-CN
 */
async function applyFingerprint(send, variant) {
  const v = variant || "v2";
  // ① 一律先关 CDP 自动化标记（部分版本此命令不生效，故另有 ② 兜底）
  try { await send("Emulation.setAutomationOverride", { enabled: false }); } catch (e) { /* ignore */ }
  // ② 硬改 navigator.webdriver / chrome.runtime / permissions 指纹（页面脚本级，早于任何页面脚本执行）
  if (v === "v1" || v === "v2") {
    try {
      await send("Page.addScriptToEvaluateOnNewDocument", {
        source: `(function(){
          try {
            Object.defineProperty(Navigator.prototype, 'webdriver', { get: function(){ return false; }, configurable: true });
          } catch(e){}
          try { delete Object.getPrototypeOf(navigator).webdriver; } catch(e){}
          try {
            if (!window.chrome) { window.chrome = { runtime: {} }; }
            Object.defineProperty(window.chrome, 'runtime', { value: { connect: function(){}, sendMessage: function(){}, id: undefined }, writable: true, configurable: true });
          } catch(e){}
          try {
            var origQuery = navigator.permissions && navigator.permissions.query;
            if (origQuery) {
              navigator.permissions.query = function(p){
                return new Promise(function(res, rej){
                  if (p && p.name === 'notifications') { res({ state: Notification.permission, onchange: null }); }
                  else { res({ state: 'prompt', onchange: null }); }
                });
              };
            }
          } catch(e){}
          try {
            Object.defineProperty(navigator, 'plugins', { get: function(){ return [1,2,3,4,5]; }, configurable: true });
          } catch(e){}
          try {
            Object.defineProperty(navigator, 'languages', { get: function(){ return ['zh-CN','zh']; }, configurable: true });
          } catch(e){}
          try {
            Object.defineProperty(navigator, 'hardwareConcurrency', { get: function(){ return 8; }, configurable: true });
          } catch(e){}
          try {
            Object.defineProperty(navigator, 'deviceMemory', { get: function(){ return 8; }, configurable: true });
          } catch(e){}
        })();`,
      });
    } catch (e) { /* ignore */ }
  }
  // ③ UA / 语言 / 时区 / 视口
  if (v === "v3") {
    // 保留 Cloudflare 原生 UA：伪装手机 UA 但底层是桌面 Chromium，指纹自相矛盾更易被识别
    try {
      await send("Emulation.setUserAgentOverride", { acceptLanguage: "zh-CN,zh;q=0.9" });
    } catch (e) { /* ignore */ }
  } else {
    try {
      await send("Emulation.setUserAgentOverride", {
        userAgent: JSB_UA,
        acceptLanguage: "zh-CN,zh;q=0.9",
        platform: "iPhone",
      });
    } catch (e) { /* ignore */ }
  }
  try { await send("Emulation.setLocaleOverride", { locale: "zh-CN" }); } catch (e) { /* ignore */ }
  try { await send("Emulation.setTimezoneOverride", { timezoneId: "Asia/Shanghai" }); } catch (e) { /* ignore */ }
  try {
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  } catch (e) { /* ignore */ }
  try { await send("Network.setExtraHTTPHeaders", { headers: { "Accept-Language": "zh-CN,zh;q=0.9" } }); } catch (e) { /* ignore */ }
  return v;
}

export async function jsbBrowserDiag(code, opts = {}) {
  const c = String(code || "").trim().toUpperCase();
  const connect = opts.connect;
  const timeoutMs = opts.timeoutMs || 90000;
  const out = { code: c, steps: [], url: JSB_SEED_URL };
  const t0 = Date.now();
  const step = (k, v) => { out.steps.push(Object.assign({ k, t: Date.now() - t0 }, v)); };

  let conn = null, cdp = null, targetId = null;
  try {
    conn = await connect();
    step("connected", {});
    cdp = createCdpClient(conn.socket);
    const created = await cdp.send("Target.createTarget", { url: "about:blank" });
    targetId = created.targetId;
    const attached = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const sid = attached.sessionId;
    const send = (method, params) => cdp.send(method, params, sid);
    step("target", { targetId });

    await send("Page.enable");
    await send("Runtime.enable");
    try { await send("Network.enable"); } catch (e) {}
    try { await send("Log.enable"); } catch (e) {}

    // ★★ 关键：抹平「自动化指纹」——江苏银行 WAF（瑞数系）做行为分析，
    //   本机成功路径用的是 `--disable-blink-features=AutomationControlled` + `--lang=zh-CN`，
    //   而 Cloudflare Browser Rendering 的 Chromium 默认为：
    //     navigator.webdriver === true   ← 直接暴露自动化
    //     navigator.languages === ["en-US"] ← 与 UA 声明的 zh-CN 不一致
    //   实测（2026-10-30 线上诊断）：带这些指纹时 WAF 挑战脚本虽加载成功(200)，
    //   cookie 也解出来了，但随后的带签名请求被 **400 硬拒** → YT 库永不加载 → 抓不到数据。
    //   ⇒ 逐项抹平，与本机 Chrome 行为对齐（策略见 applyFingerprint，可用 ?variant= A/B）。
    const fpVariant = await applyFingerprint(send, opts.variant);
    out.variant = fpVariant;

    // ★ 事件采集：console 输出 / JS 异常 / 加载失败的资源 / 响应状态
    const evts = { console: [], exceptions: [], failed: [], responses: [] };
    cdp.on("Runtime.consoleAPICalled", (p) => {
      try {
        const txt = (p.args || []).map((a) => (a.value != null ? String(a.value) : (a.description || a.type))).join(" ");
        if (evts.console.length < 25) evts.console.push((p.type || "") + ": " + txt.slice(0, 200));
      } catch (e) {}
    });
    cdp.on("Runtime.exceptionThrown", (p) => {
      try {
        const d = p.exceptionDetails || {};
        const msg = (d.exception && (d.exception.description || d.exception.value)) || d.text || "";
        if (evts.exceptions.length < 15) evts.exceptions.push(String(msg).slice(0, 260));
      } catch (e) {}
    });
    cdp.on("Network.loadingFailed", (p) => {
      try { if (evts.failed.length < 15) evts.failed.push((p.errorText || "") + " " + (p.type || "") + " " + (p.blockedReason || "")); } catch (e) {}
    });
    cdp.on("Network.responseReceived", (p) => {
      try {
        const r = p.response || {};
        const u = String(r.url || "");
        if (/jsbchina/.test(u) && evts.responses.length < 20) {
          evts.responses.push(r.status + " " + u.replace(/^https?:\/\/[^/]+/, "").slice(0, 110));
        }
      } catch (e) {}
    });

    const nav = await send("Page.navigate", { url: JSB_SEED_URL });
    step("navigated", { nav: nav || null });

    // 观察 Cloudflare 出网看到的挑战形态
    const probe = await send("Runtime.evaluate", {
      expression: `JSON.stringify({
        href: location.href,
        title: document.title,
        htmlLen: document.documentElement ? document.documentElement.outerHTML.length : 0,
        hasYT: !!(window.YT && window.YT.SecurityJSBANK),
        hasAes: !!window.jsbankAES,
        hasRsa: !!window.jsbankRSA,
        hasEval: (document.documentElement ? document.documentElement.outerHTML : "").indexOf("eval(") >= 0,
        cookie: document.cookie ? document.cookie.slice(0, 300) : "",
        ua: navigator.userAgent
      })`,
      returnByValue: true,
    }).catch((e) => ({ error: String(e && e.message || e) }));
    let probeObj = null;
    try { probeObj = JSON.parse((probe && probe.result && probe.result.value) || "{}"); } catch (e) { probeObj = { raw: String(probe && probe.result && probe.result.value).slice(0, 400) }; }
    step("page_probe", { probe: probeObj });

    // ★ 深挖：脚本是否真的加载/执行？收集 console + 脚本列表 + 资源加载状态
    const deep = await send("Runtime.evaluate", {
      expression: `JSON.stringify({
        readyState: document.readyState,
        scripts: Array.prototype.slice.call(document.scripts).map(function(s){
          return { src: s.src || "(inline)", r: s.getAttribute('r') || "", len: (s.textContent||"").length };
        }),
        winKeys: Object.keys(window).filter(function(k){ return /jsbank|^YT$|SecurityJSBANK|_$/.test(k); }).slice(0, 20),
        _$ts: typeof window._$ts !== "undefined" ? Object.keys(window._$ts).slice(0, 12) : null,
        perfRes: (function(){
          try { return performance.getEntriesByType("resource").map(function(e){ return e.name.replace(/^https?:\\/\\/[^\\/]+/, "") + "|" + e.responseStatus + "|" + Math.round(e.duration) + "ms|" + (e.transferSize||0); }); } catch(e){ return []; }
        })()
      })`,
      returnByValue: true,
    }).catch((e) => ({ error: String(e && e.message || e) }));
    let deepObj = null;
    try { deepObj = JSON.parse((deep && deep.result && deep.result.value) || "{}"); } catch (e) { deepObj = { raw: String(deep && deep.result && deep.result.value).slice(0, 400) }; }
    step("deep_probe", { deep: deepObj });

    // 收集 JS 异常：重新注入一个 error 收集器后主动 reload 一次，抓首屏报错
    try {
      await send("Page.addScriptToEvaluateOnNewDocument", {
        source: "window.__errs=[];window.addEventListener('error',function(e){window.__errs.push(String(e.message||e.error||'err')+' @'+(e.filename||''));},true);",
      });
      await send("Page.reload", { ignoreCache: false });
      await sleep(6000);
      const errs = await send("Runtime.evaluate", {
        expression: "JSON.stringify({errs: window.__errs||[], hasYT: !!(window.YT&&window.YT.SecurityJSBANK), cookie: document.cookie||''})",
        returnByValue: true,
      }).catch(() => null);
      step("reload_probe", { errs: errs && errs.result ? errs.result.value : String(errs).slice(0, 300) });
    } catch (e) {
      step("reload_probe", { error: String(e && e.message || e) });
    }

    // 等 YT 加密库就绪（最多 45s）；同时若挑战通过（拿到 FSSBBIl1UgzbN7NP cookie），
    // 主动 reload 一次让真实业务页（含 YT 库）加载进来。
    let ready = false;
    const deadline = Date.now() + 60000;
    let reloaded = false;
    while (Date.now() < deadline) {
      const r = await send("Runtime.evaluate", {
        expression: "JSON.stringify({yt: !!(window.YT && window.YT.SecurityJSBANK && window.YT.SecurityJSBANK.encrypt), aes: !!window.jsbankAES, cookie: document.cookie||'', href: location.href})",
        returnByValue: true,
      }).catch(() => null);
      let st = null;
      try { st = JSON.parse((r && r.result && r.result.value) || "{}"); } catch (e) {}
      if (st && st.yt && st.aes) { ready = true; break; }
      // 挑战已过（WAF cookie 在手）但 YT 未加载 → reload 一次拿真实页
      if (!reloaded && st && /FSSBBIl1UgzbN7NP/.test(st.cookie || "") && Date.now() > t0 + 8000) {
        reloaded = true;
        step("challenge_passed_reload", { cookie: String(st.cookie).slice(0, 120), href: st.href });
        try { await send("Page.reload", { ignoreCache: false }); } catch (e) {}
        await sleep(3000);
        continue;
      }
      await sleep(1500);
    }
    step("yt_ready", { ready, reloaded, evts });

    // ★ 深挖二：WAF 脚本把 URL 改成了什么？它注入了哪些 cookie / 拦截了哪些请求？
    //   400 的根因大概率是「WAF 给浏览器算出的签名与云端出网 IP/UA 不匹配」。
    const w = await send("Runtime.evaluate", {
      expression: `JSON.stringify({
        href: location.href,
        search: location.search,
        cookieAll: document.cookie,
        cookieNames: document.cookie.split(';').map(function(c){return c.split('=')[0].trim();}),
        // 页面里所有 <script> 与 inline 脚本前 300 字（找 WAF 注入逻辑）
        inlineHeads: Array.prototype.slice.call(document.scripts).filter(function(s){return !s.src;}).map(function(s){
          return (s.textContent||'').slice(0, 300);
        }),
        // XHR/fetch 拦截器：WAF 通常重写 XMLHttpRequest.open
        xhrOpen: (function(){ try { return String(XMLHttpRequest.prototype.open).slice(0,300); } catch(e){ return 'n/a'; } })(),
        fetchStr: (function(){ try { return String(window.fetch).slice(0,300); } catch(e){ return 'n/a'; } })(),
        docTitle: document.title
      })`,
      returnByValue: true,
    }).catch((e) => ({ error: String(e && e.message || e) }));
    let wObj = null;
    try { wObj = JSON.parse((w && w.result && w.result.value) || "{}"); } catch (e) { wObj = { raw: String(w && w.result && w.result.value).slice(0, 400) }; }
    step("waf_probe", { waf: wObj });

    // ★ 深挖三：为什么 WAF 脚本没执行？
    //   手工把挑战 JS 塞进页面执行，看它是否抛错（瑞数脚本常依赖 window/document 特性、
    //   或用 <script> 的 r='m' 属性 + 自执行；也可能在 Cloudflare Chromium 里因
    //   navigator.webdriver / headless 指纹被「毒化」而主动放弃）。
    const exec = await send("Runtime.evaluate", {
      expression: `(async function(){
        var out = {};
        try {
          var src = "${JSB_SEED_URL.replace(/^https?:\/\//, "")}";
          var scripts = Array.prototype.slice.call(document.scripts).map(function(s){return s.src;}).filter(Boolean);
          out.scriptSrcs = scripts;
          // 1) 重新 fetch 挑战 JS，拿到源码
          var r = await fetch(scripts[0] || "", {credentials:"include"});
          out.fetchStatus = r.status;
          var txt = await r.text();
          out.jsLen = txt.length;
          // 2) 手动 eval 一次，看是否抛错
          try { (0,eval)(txt); out.evalOk = true; }
          catch(e){ out.evalErr = String(e && (e.message||e)).slice(0,300); }
          // 3) 执行后 cookie/全局是否变化
          out.cookieAfter = document.cookie;
          out.hasYT2 = !!(window.YT && window.YT.SecurityJSBANK);
          out.hasAes2 = !!window.jsbankAES;
          // 4) 指纹检测：Cloudflare Chromium 会不会暴露 headless/webdriver
          out.webdriver = navigator.webdriver;
          out.headlessUA = /Headless/i.test(navigator.userAgent);
          out.pluginsLen = (navigator.plugins||[]).length;
          out.languages = navigator.languages;
          out.chrome = (typeof window.chrome);
          out.permissions = (navigator.permissions ? "yes" : "no");
        } catch(e) { out.err = String(e && (e.message||e)).slice(0,300); }
        return JSON.stringify(out);
      })()`,
      awaitPromise: true,
      returnByValue: true,
    }).catch((e) => ({ error: String(e && e.message || e) }));
    let execObj = null;
    try { execObj = JSON.parse((exec && exec.result && exec.result.value) || "{}"); } catch (e) { execObj = { raw: String(exec && exec.result && exec.result.value).slice(0, 500) }; }
    step("exec_probe", { exec: execObj });

    if (ready) {
      const ev = await send("Runtime.evaluate", {
        expression: apiEvalExpr("H5queryTbprddaily.do", {
          prdCode: c, TACode: "Y04", prodTemplateNo: "D300", dateFlag: "4", prdattr: "4",
        }, 20000),
        awaitPromise: true, returnByValue: true,
      }).catch((e) => ({ error: String(e && e.message || e) }));
      const v = ev && ev.result && ev.result.value;
      let brief = null;
      try {
        const o = typeof v === "string" ? JSON.parse(v) : v;
        const rows = o && o.data && o.data.tbprddailyList;
        brief = { ok: o && o.ok, rows: rows ? rows.length : 0, err: o && o.err,
                  sample: rows && rows.length ? rows[0] : null,
                  head: o && o.data ? Object.keys(o.data).slice(0, 8) : null };
      } catch (e) { brief = { raw: String(v).slice(0, 400) }; }
      step("api_call", { brief });
    }
    out.ok = ready;
    return out;
  } catch (e) {
    out.error = String((e && e.message) || e);
    return out;
  } finally {
    try { if (cdp && targetId) await cdp.send("Target.closeTarget", { targetId }); } catch (e) {}
    try { if (cdp) cdp.close(); } catch (e) {}
    try { if (conn) await conn.close(); } catch (e) {}
  }
}

export default { jsbBrowserFetch, jsbBrowserFetchMany, jsbBrowserDiag, makeBrowserBindingConnector };

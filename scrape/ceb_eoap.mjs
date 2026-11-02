/* 光大银行 App 端口（eoap 营销 H5）—— 净值 + 七字段抓取（仅本机 Node 用）
 *
 * ============================ 端口本质 ============================
 * 用户从「光大手机银行」把产品分享到微信，得到形如
 *   https://eoap.cebbank.com/uiap/ebdc/?code=<wxOAuthCode>&state=STATE
 *     #/productDetail?originFrom=weChat&accessId=<accessId>&os=1&share=1&fromShareChannel=mobileBank
 * 这个 H5 是 Vue SPA，数据全部来自：
 *   POST https://eoap.cebbank.com/uiap/ebdcService/<ctx><path>
 * 其中 ctx 默认 `/sec`（国密加密通道）。
 *
 * ============================ 三道墙（2026-10-16 全部打通）============================
 * ① 瑞数 RS5（berrCCR8OusE.1058d2a.js）：直接 POST 接口一律 412 挑战页。
 *    —— Node / curl / curl_cffi（safari_ios、chrome131…）全都 412，说明不是 TLS 指纹门禁。
 * ② 国密 SM2 握手 + SM4 报文：`/sec/eapi/encrypt/handShake` 下发 msg2(msg5/msg7)，
 *    之后每个请求体都是 `{msg1,msg4,...}` 密文，响应也是密文。手工实现成本极高。
 * ③ WAF 对「已持 P cookie 但校验不过」的请求直接 400（4 字节空白，server: ******）。
 *
 * 【关键发现】只要让真浏览器带着 `--disable-blink-features=AutomationControlled` 启动，
 * RS5 就会正常下发并校验通过；此前所有 400 都是**自动化指纹被识别**导致 P cookie 被毒化。
 * 因此本模块用 Chrome 跑通 ①②③，再借 App 自己的 webpack 模块直接调用它的 ajax：
 *   window.webpackChunk*[].push([["probe"],[],req => window.__req = req])
 *   const ajax = window.__req(68367).v_   // 68367 导出 v_，即 App 的 $ajax.post
 * ajax 内部已完成握手 + 加解密，返回的就是**解密后的业务对象** —— 无需自己实现国密。
 *
 * ============================ 可用接口（网关白名单，2026-10-16 实测）============================
 *   POST /sec/eproduct/productView/getProductViewDetails  {accessId, sign, deploymentChannel}
 *        → { proId, proCode, refereeVO, recordId, ... }   ← accessId 换 proId
 *   POST /sec/eproduct/productDetail
 *        {operKey:"", productId:<proId>, accessId, fromChannelInfo:"mobileBankShare",
 *         imgParams:[{host:"cdn",imgUrlKey:"picServerPath"}], sign, deploymentChannel:""}
 *        → { type, data:{ proName, proCode, managerCode, prodRiskLevel, netvalueDate,
 *             productTermInfo, perforCompareNormText, remainQuota, purchaseRule, redeemRule,
 *             productAnnouncement:{productRegistCode, establishDate, managerCode, documentType},
 *             bfspRiseFallBo:{近1月/3月/6月/1年 涨跌幅+年化} } }
 *   POST /sec/eproduct/financeProduct/performanceGraph
 *        {proCode, period:"Y1", type:"NETVALUE", proType:"03", sign, deploymentChannel:""}
 *        → { emptyGraph, xaxis:["YYYY/MM/DD"...], yaxis:[{data:[{value}...]}], specialFlag }
 *
 * sign = `${crypto.randomUUID()}__${Date.now()}`（客户端自生成防重放串，实测可自造）。
 * 其它路径一律 `err_gateway 白名单中未查询到相关url` —— 网关只放行上面三条。
 *
 * ============================ 重要边界 ============================
 * · **一个 accessId 只对应一个产品**：productDetail 必须带 accessId（缺 → 「产品ID不能为空」；
 *   乱填 → 「产品已失效」）。所以想抓新产品，必须拿到它自己的分享链接。
 * · performanceGraph 虽然按 proCode 查，但实测只对**当前会话产品**有数据；
 *   换别的码（EW7746A / EW7899A）一律 `emptyGraph:true`，与 proType/type 无关。
 * · 登记编码、成立日、业绩基准、风险等级、最短持有全部来自 productDetail，
 *   **不解析说明书 PDF**（用户 2026-10-16 规则）。
 * · Cloudflare Workers 无 Chrome，本模块整体不加载；ceb 在 Workers 上仍走原链路。
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const EOAP_HOST = "https://eoap.cebbank.com";
const EOAP_SHARE = EOAP_HOST + "/uiap/ebdc/";
const UA_MOBILE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const CHROME_CANDIDATES = [
  process.env.CEB_CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].filter(Boolean);

/** 惰性解析 puppeteer-core（装在 WorkBuddy 运行时 workspace） */
let _puppeteer;
function puppeteerCore() {
  if (_puppeteer !== undefined) return _puppeteer;
  for (const spec of [
    "puppeteer-core",
    "C:/Users/a/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core",
    process.env.CEB_PUPPETEER,
  ].filter(Boolean)) {
    try { _puppeteer = require(spec); return _puppeteer; } catch (e) { /* 试下一个 */ }
  }
  _puppeteer = null;
  return null;
}

/** 共享浏览器实例：同一进程内复用，省掉每次 ~1.2s 的启动开销 */
let _browser = null;
async function sharedBrowser() {
  const pptr = puppeteerCore();
  if (!pptr) return null;
  if (_browser && _browser.connected) return _browser;
  const exe = CHROME_CANDIDATES.find((p) => { try { return require("node:fs").existsSync(p); } catch (e) { return false; } });
  if (!exe) return null;
  _browser = await pptr.launch({
    executablePath: exe,
    headless: "new",
    // ⚠ 这一行是整条链路能否跑通的关键：去掉它，瑞数会识别自动化指纹并毒化 P cookie，
    //   所有 /sec/* 请求恒回 400（4 字节空白）。见文件头「三道墙」。
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--lang=zh-CN", "--disable-blink-features=AutomationControlled"],
    defaultViewport: { width: 414, height: 896, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  });
  return _browser;
}

export async function closeCebBrowser() {
  try { if (_browser && _browser.connected) await _browser.close(); } catch (e) {}
  _browser = null;
}

/** 分享链 / accessId → 规范化分享地址 */
export function cebShareUrl(accessId) {
  const id = String(accessId || "").trim();
  if (!id) return EOAP_SHARE;
  return EOAP_SHARE + "?accessId=" + encodeURIComponent(id) +
    "&fromShareChannel=mobileBank&os=1&share=1&originFrom=weChat" +
    "#/productDetail?originFrom=weChat&accessId=" + encodeURIComponent(id) +
    "&os=1&share=1&fromShareChannel=mobileBank";
}

/** 从一条分享链里抠 accessId */
export function cebAccessIdOf(link) {
  const s = String(link || "");
  const m = s.match(/[?&#]accessId=([^&#\s]+)/i);
  return m ? decodeURIComponent(m[1]) : "";
}

/* 会话页缓存：accessId → { page, proId, proCode, at }
 * 同一个 accessId 反复抓（刷净值）时复用页面，免掉重复握手（省 ~9s）。 */
const SESSIONS = new Map();
const SESSION_TTL_MS = 8 * 60 * 1000;

async function openSession(accessId) {
  const browser = await sharedBrowser();
  if (!browser) return { error: "no-browser" };
  const page = await browser.newPage();
  await page.setUserAgent(UA_MOBILE);
  // 打开前先装钩子：拿到 webpack require（App 的模块表）与 JSON.parse 兜底
  await page.evaluateOnNewDocument(() => {
    window.__cebAjax = null;
    window.__cebErr = null;
    const grab = () => {
      try {
        const key = Object.keys(window).find((k) => /^webpackChunk/.test(k));
        if (!key) return false;
        let req = null;
        window[key].push([["__ceb_probe__"], {}, function (r) { req = r; }]);
        if (!req) return false;
        const mod = req(68367);
        if (mod && typeof mod.v_ === "function") { window.__cebAjax = mod.v_; return true; }
      } catch (e) { window.__cebErr = String((e && e.message) || e); }
      return false;
    };
    let n = 0;
    const timer = setInterval(() => { n++; if (grab() || n > 120) clearInterval(timer); }, 250);
  });

  const url = cebShareUrl(accessId);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  // 等握手 + 首屏渲染完成（实测 8~12s）
  const deadline = Date.now() + 45000;
  let ready = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 700));
    const st = await page.evaluate(() => ({ has: !!window.__cebAjax, len: document.body.innerText.length }));
    if (st.has && st.len > 60) { ready = true; break; }
  }
  if (!ready) {
    const st = await page.evaluate(() => ({ has: !!window.__cebAjax, err: window.__cebErr, len: document.body.innerText.length }));
    await page.close().catch(() => {});
    return { error: "session-not-ready", detail: st };
  }
  return { page };
}

/** 在页面里调一次 App 的 ajax（自动加 sign），返回解密后的对象 */
async function pageCall(page, path, params) {
  return page.evaluate(async (path, params) => {
    const sign = (typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID() + "__" + Date.now()
      : "ceb-" + Math.random().toString(16).slice(2) + "__" + Date.now();
    try {
      const ajax = window.__cebAjax;
      if (typeof ajax !== "function") return { ok: false, err: "no-ajax" };
      const d = await ajax(path, Object.assign({ sign: sign, deploymentChannel: "" }, params));
      return { ok: true, data: d };
    } catch (e) {
      return { ok: false, err: (e && (e.code || e.msg)) ? { code: e.code, msg: e.msg } : String(e) };
    }
  }, path, params);
}

/* ------------------------------ 字段清洗 ------------------------------ */

/** "R2中低风险" → "R2"；"R5高风险" → "R5" */
function cleanRisk(s) {
  const m = String(s || "").match(/R[1-5]/i);
  return m ? m[0].toUpperCase() : null;
}
/** "2026/01/28" → "2026-01-28" */
function cleanDate(s) {
  const m = String(s || "").match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (!m) return null;
  return m[1] + "-" + String(m[2]).padStart(2, "0") + "-" + String(m[3]).padStart(2, "0");
}
/** "持有7天后每日可赎" / "14天最低持有" / "120天" → 天数；"每日开放" → 0 */
function parseHoldDays(...texts) {
  for (const t of texts) {
    const s = String(t || "");
    if (!s) continue;
    if (/每日开放|无固定期限|每日可赎/.test(s) && !/\d+\s*天/.test(s)) return 0;
    const m = s.match(/(\d+)\s*天/);
    if (m) return Number(m[1]);
  }
  return null;
}
/** "代销光大理财" / "光大理财有限责任公司" → "光大理财" */
function cleanManager(...texts) {
  for (const t of texts) {
    const s = String(t || "").replace(/^代销/, "").trim();
    if (!s) continue;
    const m = s.match(/^(.{2,8}理财)/);
    if (m) return m[1];
    return s;
  }
  return null;
}
/** "剩余可购买额度>4亿元" → 400000000（近似；取不到精确值返回 null） */
function parseQuota(s) {
  const t = String(s || "");
  const m = t.match(/([\d.]+)\s*(亿|万)/);
  if (!m) return null;
  const v = Number(m[1]);
  if (!isFinite(v)) return null;
  return Math.round(v * (m[2] === "亿" ? 1e8 : 1e4));
}

/* ------------------------------ 主流程 ------------------------------ */

/**
 * 抓一支光大产品（App 端口）
 * @param {object} opts
 * @param {string} [opts.accessId]  分享链 accessId（首选）
 * @param {string} [opts.link]      直接给分享链
 * @param {string} [opts.proCode]   产品代码（仅用于校验/日志；本端口按 accessId 定位产品）
 * @param {number} [opts.period]    performanceGraph 周期，默认 "Y1"
 * @param {boolean} [opts.infoOnly] 只取产品信息，跳过净值曲线
 * @returns {Promise<null|object>}  { code, name, manager, risk, holdDays, established, regCode,
 *                                     benchmark, remainQuota, series:[[date,nav]...], ... }
 */
export async function cebEoapFetch(opts = {}) {
  const accessId = String(opts.accessId || cebAccessIdOf(opts.link) || "").trim();
  if (!accessId) return null;
  const t0 = Date.now();
  let sess = SESSIONS.get(accessId);
  if (!sess || (Date.now() - sess.at) > SESSION_TTL_MS) {
    if (sess && sess.page) { try { await sess.page.close(); } catch (e) {} }
    sess = await openSession(accessId);
    if (sess.error) { SESSIONS.delete(accessId); return null; }
    SESSIONS.set(accessId, { page: sess.page, at: Date.now() });
  }
  const page = sess.page;

  // ① accessId → proId
  const view = await pageCall(page, "/eproduct/productView/getProductViewDetails", { accessId: accessId });
  if (!view.ok || !view.data || !view.data.proId) return null;
  const proId = view.data.proId;
  const accessProCode = view.data.proCode || null;

  // ② 产品详情（七字段）
  const detail = await pageCall(page, "/eproduct/productDetail", {
    operKey: "",
    productId: proId,
    accessId: accessId,
    fromChannelInfo: "mobileBankShare",
    imgParams: [{ host: "cdn", imgUrlKey: "picServerPath" }],
  });
  if (!detail.ok) return null;
  const d = (detail.data && detail.data.data) || {};
  const ann = d.productAnnouncement || {};

  const code = String(accessProCode || d.proCode || opts.proCode || "").toUpperCase();
  const name = d.proName || null;

  // ③ 净值全序列（按 proCode + 周期）；infoOnly 时跳过（只补产品信息，省一次请求）
  const period = String(opts.period || "Y1");
  let series = [];
  if (!opts.infoOnly) {
    const g = await pageCall(page, "/eproduct/financeProduct/performanceGraph", {
      proCode: code,
      period: period,
      type: "NETVALUE",
      proType: d.proType || "03",
    });
    if (g.ok && g.data && !g.data.emptyGraph && Array.isArray(g.data.xaxis)) {
      const xs = g.data.xaxis || [];
      const ys = (g.data.yaxis && g.data.yaxis[0] && g.data.yaxis[0].data) || [];
      for (let i = 0; i < xs.length; i++) {
        const dt = cleanDate(xs[i]);
        const v = ys[i] && ys[i].value;
        if (dt && typeof v === "number" && isFinite(v)) series.push([dt, v]);
      }
      series.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    }
  }

  const riseFall = d.bfspRiseFallBo || {};
  return {
    code: code,
    navVia: "ceb",
    navPort: "app",
    name: name,
    manager: cleanManager(ann.managerCode, d.managerCode),
    kind: "nav",
    risk: cleanRisk(d.prodRiskLevel),
    holdDays: parseHoldDays(d.productTermInfo, name, d.subTitle),
    established: cleanDate(ann.establishDate),
    regCode: ann.productRegistCode || null,
    benchmark: (d.perforCompareNormText || "").trim() || null,
    documentType: ann.documentType || null,
    remainQuota: parseQuota(d.remainQuota),
    remainQuotaText: d.remainQuota || null,
    minFirstAmount: d.minFirstAmountOfIndi || null,
    netvalueDate: cleanDate(d.netvalueDate) || (series.length ? series[series.length - 1][0] : null),
    redeemOperaFlag: d.redeemOperaFlag || null,
    termInfo: d.productTermInfo || null,
    // 阶段涨跌（App 直出，非自算）
    periodRiseFall: {
      m1: riseFall.oneMonthRiseAndFall, m1Annual: riseFall.oneMonthAnnualRate,
      m3: riseFall.threeMonthRiseAndFall, m3Annual: riseFall.threeMonthAnnualRate,
      m6: riseFall.sixMontheRiseAndFall, m6Annual: riseFall.sixMontheAnnualRate,
      y1: riseFall.oneYearRiseAndFall, y1Annual: riseFall.oneYearAnnualRate,
    },
    proId: proId,
    accessId: accessId,
    series: series,
    elapsedMs: Date.now() - t0,
  };
}

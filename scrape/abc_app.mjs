/* 农业银行 App 端口（wx.abchina.com/webank 微信/掌银内嵌 webview）产品信息抓取（仅本机 Node 用）
 *
 * ============================ 端口本质 ============================
 * 链接：https://wx.abchina.com/webank/main-view/financialDetails?code=<ACCESSID>_<f产品码>
 *   例：?code=92d72d55785a42c587ac0b25_fNYJXLD  → 农银匠心·灵动90天(科技领航) NYJXLDKJLH90
 * 该页是「分享落地页」（轻量 Vue SPA），业务数据全部来自唯一接口：
 *   POST https://wx.abchina.com/webank/applet/api/weChat/shareInfo
 *   body {"code":"<ACCESSID>_<f产品码>"}  → { status:"0000", result:{ ...产品字段... } }
 * 响应为**明文 JSON**（无 SM 加密），但服务端启用 TLS legacy renegotiation，
 * Node 17+ 的 OpenSSL 直连报 EPROTO(unsafe legacy renegotiation disabled)，
 * 故必须借 Chrome（CDP 无头）访问——与生产 bob/ceb 等 Chrome 端口同一约束。
 *
 * ⚠ 关键约束：shareInfo 的 code 参数必须是「分享码」= <ACCESSID>_<f产品码>，
 *   其中 ACCESSID 是每条分享链接独有的令牌（如 92d72d55785a42c587ac0b25），
 *   **无法从产品代码(如 NYJXLDKJLH90)反推**。因此本端口只能「按分享链接」触发
 *   （/api/abcapp?code=<分享码>），不能像 web 端口那样按产品代码通用查询。
 *   abcAppFetch 收到的 code 即分享码；响应里的 prodId 才是真实产品代码。
 *
 * ============================ result 关键字段（实测 NYJXLDKJLH90）============================
 *   name              农银理财农银匠心·灵动90天理财产品（科技领航）
 *   prodId            NYJXLDKJLH90                       ← 真实产品代码
 *   vluTerm           90                                 ← 最短持有天数
 *   sProdDuration     持有90天后每日可赎
 *   codTarfRskLvl     02                                 ← 风险等级(01低/02中低/03中/04中高/05高)
 *   pfmcDateStrt      2026/05/13                         ← 成立日期(银行真字段)
 *   benchmarkDesc     业绩比较基准说明(投资范围+示例)      ← 业绩比较基准(描述)
 *   earningRate       中债-新综合财富(1年以下)指数收益率*99%+中证800指数*1%  ← 业绩比较基准(公式)
 *   txtIfPdPftTyp     非保本浮动收益                       ← 收益类型
 *   investType        01                                 ← 投资性质(01固定收益类)
 *   amtStart/amtStep  1.00 / 1.00                        ← 起点/递增金额
 *   pfmcVlu/pfmcTyp   5.98% / 成立以来年化                ← 成立以来年化业绩
 *   auxInfo            含「本产品成立于2026年05月13日，数据截止至2026年10月15日」
 *
 * ❌ 本 webview【不提供】三项（与用户预期不同，根因见下）：
 *   · 净值(NAV)：该分享页只渲染业绩摘要(成立以来年化)，无单位净值序列——
 *     净值须走农行 web 端口 ewealth.abchina.com.cn（OwnProdNetValueFilterV3）。
 *   · 产品登记编码(Z700…)：农行公开接口(含本 webview)均不返回登记编码（与 worker.js
 *     abcFetch 注释一致：registryCode=null）。
 *   · 额度(quota)：分享落地页无购买额度字段；「购买」按钮仅 deep-link 回掌银 App
 *     (bankabc://jumpToSharedProduct)，本无头环境拿不到额度。
 *   故本模块定位为「app 端口信息补充」（partial:true），不构造净值序列。
 *
 * 实测样例：NYJXLDKJLH90 经本模块 → established=2026-05-13 / holdDays=90 /
 *   risk=R2(中低风险) / 成立以来年化=5.98% / 起点=1.00。
 * ========================================================================== */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const ABC_APP_PAGE = "https://wx.abchina.com/webank/main-view/financialDetails";
const ABC_SHARE_EP = "/webank/applet/api/weChat/shareInfo";
const ABC_APP_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.40(0x1800282a) NetType/WIFI Language/zh_CN";

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].filter(Boolean);

let _puppeteer;
function puppeteerCore() {
  if (_puppeteer !== undefined) return _puppeteer;
  for (const spec of ["puppeteer-core", "C:/Users/a/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core", process.env.ABC_PUPPETEER].filter(Boolean)) {
    try { _puppeteer = require(spec); return _puppeteer; } catch (e) { /* 下一个 */ }
  }
  _puppeteer = null;
  return null;
}

let _browser = null;
async function sharedBrowser() {
  const pptr = puppeteerCore();
  if (!pptr) return null;
  if (_browser && _browser.connected) return _browser;
  const fs = require("node:fs");
  const exe = CHROME_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });
  if (!exe) return null;
  _browser = await pptr.launch({
    executablePath: exe,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--lang=zh-CN", "--disable-blink-features=AutomationControlled"],
    defaultViewport: { width: 390, height: 844, isMobile: true, hasTouch: true },
  });
  return _browser;
}
export async function closeAbcBrowser() {
  try { if (_browser && _browser.connected) await _browser.close(); } catch (e) {}
  _browser = null;
}

function abcAppDate(s) {
  if (!s) return null;
  const d = String(s).replace(/[^0-9]/g, "");
  const m = d.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const m2 = String(s).match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;
  return null;
}
// codTarfRskLvl "01".."05" → R1..R5；同步给中文名
const ABC_RISK = { "01": ["R1", "低风险"], "02": ["R2", "中低风险"], "03": ["R3", "中风险"], "04": ["R4", "中高风险"], "05": ["R5", "高风险"] };
const ABC_INVEST = { "01": "固定收益类", "02": "权益类", "03": "商品及金融衍生品类", "04": "混合类" };

function mapAbcApp(r) {
  const risk = ABC_RISK[String(r.codTarfRskLvl || "").padStart(2, "0")] || ABC_RISK[r.codTarfRskLvl];
  const invest = ABC_INVEST[r.investType] || null;
  const established = abcAppDate(r.pfmcDateStrt);
  const vluTerm = Number(r.vluTerm);
  return {
    name: r.name || null,
    productCode: r.prodId || null,           // 真实产品代码（分享码里的 f 码）
    shareCode: r.prodIdEnc || null,          // 加密产品码（分享用）
    manager: (r.name && /农银/.test(r.name)) ? "农银理财" : (r.manager || "农银理财"),
    established,                              // 银行真字段(pfmcDateStrt)，非序列首点
    establishedFromSeries: false,
    holdDays: Number.isFinite(vluTerm) && vluTerm > 0 ? vluTerm : null,
    holdDaysDesc: r.sProdDuration || null,
    risk: risk ? risk[0] : null,              // R2
    riskName: risk ? risk[1] : null,          // 中低风险
    benchmark: r.benchmarkDesc || null,       // 业绩比较基准(描述)
    benchmarkFormula: r.earningRate || null,  // 业绩比较基准(公式)
    profitType: r.txtIfPdPftTyp || null,      // 收益类型(非保本浮动收益)
    investType: invest,                       // 投资性质
    amtStart: Number(r.amtStart) || null,     // 起点金额
    amtStep: Number(r.amtStep) || null,       // 递增金额
    perfSinceIncept: r.pfmcVlu || null,       // 成立以来年化(如 "5.98%")
    perfSinceInceptType: r.pfmcTyp || null,   // "成立以来年化"
    perfEndDate: abcAppDate(r.pfmcDateEnd),   // 数据截止日
    registryCode: null,                       // 农行公开接口(含本 webview)不返回登记编码
    quota: null,                              // 分享落地页无额度字段
    quotaText: null,
    series: [],                               // 净值序列不在本 webview（见文件头）
    kind: "nav",
    navBasis: "info",
    partial: true,
    navNote: "农行 App 端口(financialDetails 分享页)仅提供产品信息七字段+业绩；净值须走 web 端口 ewealth，登记编码/额度农行公开接口均不返回",
    source: "live",
    bank: "abc",
    navVia: "abc-app",
    navPort: "app",
    ms: 0,
  };
}

/**
 * 抓取农行 App 端口（分享落地页）产品信息。
 * @param {string} shareCode 分享码（链接 ?code= 参数，形如 <ACCESSID>_<f产品码>）
 * @param {{detailOnly?:boolean, timeoutMs?:number}} opts detailOnly 预留（本端口本就只取信息）
 * @returns {Promise<object|null>}
 */
export async function abcAppCapture(shareCode, opts = {}) {
  const c = String(shareCode || "").trim();
  if (!c) return null;
  const pptr = puppeteerCore();
  if (!pptr) return null;
  const browser = await sharedBrowser();
  if (!browser) return null;
  const t0 = Date.now();
  const timeoutMs = opts.timeoutMs || 45000;
  // 硬超时护栏：避免 Chrome/网络异常时永久挂起调用方（如 /api/abcapp 端点）
  const hardCap = Math.min(timeoutMs + 15000, 75000);

  const run = async () => {
    let page;
    try {
      page = await browser.newPage();
      await page.setUserAgent(ABC_APP_UA);
      await page.setExtraHTTPHeaders({ "Accept-Language": "zh-CN,zh;q=0.9" });

      // ① 主路径：拦截页面自身发出的 shareInfo 响应（明文 JSON）
      let captured = null;
      const onResp = async (resp) => {
        try {
          if (resp.url().includes(ABC_SHARE_EP)) {
            const b = await resp.text();
            const j = JSON.parse(b);
            if (j && j.result) captured = j.result;
          }
        } catch (e) {}
      };
      page.on("response", onResp);

      const timer = setTimeout(() => { try { page.close().catch(() => {}); } catch (e) {} }, hardCap + 5000);
      try {
        await page.goto(ABC_APP_PAGE + "?code=" + encodeURIComponent(c), { waitUntil: "networkidle2", timeout: timeoutMs });
      } catch (e) { /* 超时也继续，响应可能已捕获 */ }
      // 给分享页渲染 + 接口回包留时间（最多 8s）
      try {
        await page.waitForFunction(() => window.__abcCaptured === true, { timeout: 8000, polling: 200 }).catch(() => {});
      } catch (e) {}
      // 若网络拦截未命中（极端 CSP），用页面内同源 fetch 再取一次
      if (!captured) {
        try {
          captured = await page.evaluate(async (code) => {
            try {
              const r = await fetch("/webank/applet/api/weChat/shareInfo", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code }),
              });
              const j = await r.json();
              return j && j.result ? j.result : null;
            } catch (e) { return null; }
          }, c);
        } catch (e) {}
      }
      clearTimeout(timer);

      if (!captured) return null;
      const out = mapAbcApp(captured);
      out.ms = Date.now() - t0;
      return out;
    } catch (e) {
      return null;
    } finally {
      try { if (page) await page.close(); } catch (e) {}
    }
  };

  return await Promise.race([
    run(),
    new Promise((resolve) => setTimeout(() => resolve(null), hardCap)),
  ]);
}

export default { abcAppCapture, closeAbcBrowser };

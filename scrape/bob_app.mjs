/* 北京银行 App 端口（cdnmobibank 手机银行理财详情 H5）—— 净值 + 信息 + 额度抓取（仅本机 Node 用）
 *
 * ============================ 端口本质 ============================
 * 页面：https://cdnmobibank.bankofbeijing.com.cn/cdn/mbank/FP/FP6/TFP6001.html?prdCode=<销售代码>
 *   Vue SPA（main_library.dll.js 3.3MB + JNative.js 原生桥）。所有业务数据走唯一加密网关：
 *     POST https://cdnmobibank.bankofbeijing.com.cn/H
 *     Content-Type: application/json;charset=UTF-8（但请求体/响应体均为二进制密文）
 *   加密栈 = SM2 + SM4 + CryptoJS + JSBridge（国密），Node 直连复刻成本极高（同光大大农商）。
 *
 * 【关键发现】/H 的加解密在 **JS 层**完成（JSON.parse 能拿到解密后的明文对象），
 *   故借真浏览器跑：注入 JSON.parse hook，捕获 app 自己解密后的业务对象，无需自己实现国密。
 *   与 ceb_eoap.mjs 同一范式（复用无头 Chrome 单例 + 借 app 自身解密）。
 *
 * ============================ 解密后对象（body.cd）关键字段 ============================
 *   prdName(名称) / taName(发行人=北银理财有限责任公司) / nav(单位净值) / financeDate
 *   riskName(谨慎型/稳健型…) / riskLeve(1..5) / bjyhHoldDays(最短持有,如"01") / bjyhHoldDaysName(每日)
 *   estabDate(成立日YYYYMMDD) / guestRateRemarkValue(业绩比较基准说明) / incomeRate(七日年化)
 *   prdTotAmt / plimitAmt(产品额度/规模,元) / motorLimitAmt(页面「额度仅剩X」,元) / CanUseLargeBuyAmt(大额可买,元) / prdCode
 *   lockDays(锁定期天数=最短持有期) / bjyhHoldDays+bjyhHoldDaysName(⚠ 购买预约期, 非持有期)
 *   ⚠ 净值历史对象(cd.list3)只含区间涨跌幅(navrg*)，无单位净值。
 *   ⚠ 登记编码(Z700…)此对象不含 → 取 web 端口 CHINABOND_REGCODE。
 *
 * 【净值历史 —— 2026-10-17 晚间 F12 抓包打通】页面默认只加载「近一月」图表；点击图表时间
 *   tab（近一年/近六月/近三月）后，接口回 cd.list = [{navDate(YYYYMMDD), nav(单位净值),
 *   totNav(累计净值), prdCode, taCode, nvgronemonth/nvgrthreemonth/nvgrsixmonth/nvgryear(区间涨幅),
 *   benchmark, weekrate, dailyIncome, incomeUnit}] 全量记录——按**交易日**发布（跳过周末，
 *   实测 85 条里 17 处跳日全是周五→周一）。近三月=窗口内(实测 59 条 2026-07-20 起)，近六月/
 *   近一年对成立不久的产品即全量(实测 85 条 2026-06-13 起)；「查看更多」若在本页展开/翻页则
 *   再收一轮，若跳转新页面，evaluateOnNewDocument 会在新文档重新装 hook 继续收。取记录数
 *   最多的一份提取 series（[日期, 单位净值] 升序）。
 *   ⚠ UI 只有 近一月/近三月/近六月/近一年 四档，无「成立以来」档——成立超 1 年的产品（如
 *   TG01190701 成立 2019）app 图表最多给近一年，全量历史只能来自 web 信披站 navlist。
 *   ⚠ Chrome 开销构成（2026-10-17 优化前 ≈15-20s）：networkidle2 等网络静默 + 固定 sleep 6s
 *   + 三档 tab 各 1.2s + 「查看更多」2.5s。优化后：domcontentloaded + 事件驱动等待
 *   （__bob/__bobNav 桶增长即返回）+ 只点「近一年」一档（窗口包含关系，响应落桶即止）
 *   ≈8-12s；detailOnly 模式（不点 tab）≈4-6s。且 bobFetch 热路径默认只走 web（纯 HTTP），
 *   仅 web 查无/无序列的产品（如 132040B）才付这份 Chrome 开销，带 10 分钟 TTL 缓存。
 * 实测样本：YJ01260316A(天天金53号A类, lockDays=0, 每日持有, 额度27694353283.41)：全量 85 点
 *           2026-06-13→2026-10-16，nav===totNav(无分红)，末值 1.007669@10-16；
 *           132040B(招睿月添利30天持有期2号, 北银代销招银理财, lockDays=30, 额度仅剩0.04元)：
 *           app 240 点(近一年滚动窗 2025-10-20→10-15)，established=2025-08-26(募集期首日
 *           2025-08-19 起有 nav=1 占位点，全量窗内更早，取最多份)。
 *           TG01190701(京华远见易淘金, 现金管理类)：份额码 TG01190701A 在 App 查无
 *           （「无满足条件记录」），父码 TG01190701 才通；cd.list nav 恒为 1（单位净值占位，
 *           真实收益在万份收益/累计净值）——现金管理类按项目规则不抓，序列整份丢弃，
 *           只取成立日 2019-08-30 / 额度 500亿。
 * ========================================================================== */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const BOB_APP_PAGE = "https://cdnmobibank.bankofbeijing.com.cn/cdn/mbank/FP/FP6/TFP6001.html";
const BOB_APP_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.40(0x1800282a) NetType/WIFI Language/zh_CN";

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].filter(Boolean);

let _puppeteer;
function puppeteerCore() {
  if (_puppeteer !== undefined) return _puppeteer;
  for (const spec of [
    "puppeteer-core",
    "C:/Users/a/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core",
    process.env.BOB_PUPPETEER,
  ].filter(Boolean)) {
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
export async function closeBobBrowser() {
  try { if (_browser && _browser.connected) await _browser.close(); } catch (e) {}
  _browser = null;
}

/* 开机预热：提前启动无头 Chrome 单例（冷启 ≈10s），把首次真实抓取的 Chrome 启动开销
   挪到开机期。仿 jsb_app.mjs 的 jsbWarmup：只 launch 浏览器，不抓页面、不占抓取通道。
   预热失败不致命——后续 bobAppCapture 命中 sharedBrowser() 仍会自愈启动。 */
export async function bobWarmup() {
  try {
    const b = await sharedBrowser();
    return !!b;
  } catch (e) { return false; }
}

function bobAppDate(s) {
  const d = String(s || "").replace(/[^0-9]/g, "");
  const m = d.match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
// 风险：riskName 谨慎型→R1 / 稳健型→R2 / 平衡型→R3 / 进取型→R4 / 激进型→R5；兜底 riskLeve 数字
function bobAppRisk(riskName, riskLeve) {
  const t = String(riskName || "");
  if (/谨慎/.test(t)) return "R1";
  if (/稳健/.test(t)) return "R2";
  if (/平衡/.test(t)) return "R3";
  if (/进取/.test(t)) return "R4";
  if (/激进/.test(t)) return "R5";
  const n = Number(riskLeve);
  if (Number.isFinite(n) && n >= 1 && n <= 5) return "R" + n;
  return null;
}
// 最短持有天数：每日 → 1；否则 lockDays（锁定期，30天持有期产品的真实持有期）优先，
// 再退 bjyhHoldDays。⚠ bjyhHoldDays/bjyhHoldDaysName 是「购买预约期」（如 "03"+"7日-1个月"），
// 不是持有期——招睿月添利30天持有期2号(132040B)的 bjyhHoldDays="03" 但 lockDays=30，
// 页面文案「最低持有30天」以 lockDays 为准（2026-10-17 实测修正）。
function bobAppHoldDays(days, name, lockDays) {
  const t = String(name || "");
  if (/每日/.test(t)) return 1;
  const lock = parseInt(String(lockDays == null ? "" : lockDays).replace(/[^0-9]/g, ""), 10);
  if (Number.isFinite(lock) && lock > 0) return lock;
  const n = parseInt(String(days || "").replace(/[^0-9]/g, ""), 10);
  if (Number.isFinite(n) && n > 0) return n;
  const m = t.match(/(\d+)\s*天/);
  return m ? Number(m[1]) : null;
}
// 业绩基准：guestRateRemarkValue 是长说明；去掉「业绩比较基准」标签头
function bobAppBench(s) {
  let t = String(s || "").trim();
  if (!t) return null;
  t = t.replace(/^本理财产品业绩比较基准是?[:：]?\s*/, "").replace(/^业绩比较基准[:：]?\s*/, "").trim();
  return t || null;
}

/**
 * 抓取北京银行 App 端口产品详情 + 全量历史净值（借无头 Chrome + JSON.parse hook 拿解密后对象）。
 * 两种模式（opts.detailOnly 控制）：
 *  - detailOnly=true：只取详情对象 cd（成立日/额度/风险/最短持有/业绩基准/七日年化），
 *    不点图表时间 tab、不点「查看更多」——app 对 web 的增量字段全在首屏详情接口里，
 *    约 4-6s 完成。用于成立日扫描、额度查询等「只要信息不要序列」的场景。
 *  - 默认（全量）：详情 + 点「近一年」时间 tab 取最大窗口历史净值（近三月⊂近六月⊂近一年，
 *    一档即最大；仅当该档接口无响应才依次补「近六月」「近三月」防御），约 8-12s。
 * 所有等待均为事件驱动（waitForFunction 等 __bob/__bobNav 桶增长），无固定长 sleep
 * （2026-10-17 优化前：networkidle2 + 固定 6s + 三档各 1.2s + 查看更多 2.5s ≈ 15-20s）。
 * 份额码在 App 产品超市查无（页面提示「无满足条件记录」，如 TG01190701A）时自动按父码重试一次
 * （App 按父码上架，web 净值行里的 PROD_CODE 也是父码，父页数据即该份额的数据）。
 * @param {string} code 销售代码（prdCode，如 YJ01260316A / TG01190701A）
 * @returns {Promise<object|null>} { name, manager, nav, navDate, risk, holdDays, established,
 *   benchmark, incomeRate, productScale, remainQuota, quotaState, currency, prdCode,
 *   series([[日期,单位净值]...] 升序，detailOnly 模式恒为空), navLatest, navLatestDate } 或 null
 */
async function bobAppCaptureOnce(code, opts = {}) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  const timeoutMs = (opts && opts.timeoutMs) || 25000;
  const browser = await sharedBrowser();
  if (!browser) return null;
  const page = await browser.newPage();
  let timer = null; // 兜底硬关闭定时器句柄：提前返回/抛错路径在 finally 里统一清除
  try {
    await page.setUserAgent(BOB_APP_UA);
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.evaluateOnNewDocument(() => { try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch (e) {} });

    // JSON.parse hook：捕获 app 解密后的业务对象（含 cd 且像产品数据），取信息最全的一个
    await page.evaluateOnNewDocument(() => {
      window.__bob = [];
      window.__bobNav = [];
      const seen = new Set();
      const navSeen = new Set();
      const grab = (obj) => {
        try {
          if (!obj || typeof obj !== "object") return;
          const cd = obj.cd;
          if (!cd || typeof cd !== "object") return;
          if (!(cd.prdName || cd.prdCode || cd.prdTotAmt || cd.nav)) return;
          const s = JSON.stringify(obj);
          if (seen.has(s)) return;
          seen.add(s);
          // 以 cd 字段数衡量信息量，保留最全的
          window.__bob.push({ n: Object.keys(cd).length, cd });
        } catch (e) {}
      };
      // 历史净值响应：cd.list = [{navDate, nav, totNav, prdCode, ...}]（点时间 tab 后接口才回）
      const grabNav = (obj) => {
        try {
          if (!obj || typeof obj !== "object") return;
          const cd = obj.cd;
          if (!cd || typeof cd !== "object") return;
          const list = cd.list;
          if (!Array.isArray(list) || !list.length) return;
          const f = list[0];
          if (!f || typeof f !== "object" || !f.navDate || f.nav == null) return;
          const s = JSON.stringify(obj);
          if (navSeen.has(s)) return;
          navSeen.add(s);
          window.__bobNav.push({ n: list.length, list });
        } catch (e) {}
      };
      const orig = JSON.parse;
      JSON.parse = function (t, ...rest) {
        const r = orig.call(this, t, ...rest);
        try { grab(r); grabNav(r); } catch (e) {}
        return r;
      };
    });

    const detailOnly = !!(opts && opts.detailOnly); // 只要详情字段（成立日/额度/风险/持有/基准），不点时间 tab
    // ⚠ page.close() 返回的 Promise 必须 .catch：兜底触发时页面往往已被 finally 关掉，
    // rejection（ProtocolError: No target with given id found）不接就是 unhandled rejection，
    // Node 22 会直接崩掉整个服务进程（2026-10-21 TG01190701A「无满足条件」提前返回后
    // 25s 兜底定时器触发，实测崩服一次）。与 abc_app.mjs 同一写法。
    timer = setTimeout(() => { try { page.close().catch(() => {}); } catch (e) {} }, timeoutMs + 25000);
    // domcontentloaded 即返回（不等网络全静默）：真正的就绪信号是下方 __bob 桶非空
    try { await page.goto(BOB_APP_PAGE + "?prdCode=" + encodeURIComponent(c), { waitUntil: "domcontentloaded", timeout: timeoutMs }); }
    catch (e) { /* 超时也继续，数据可能已渲染 */ }

    // 详情对象（cd）随首屏业务接口返回：事件驱动等待，替代原固定 6s（实测 2-4s 即落桶）。
    // 同时监听「无满足条件记录」查无提示（份额码未按父码上架时的页面文案，如 TG01190701A）：
    // 命中即早退，不再白等满超时，立刻走外层父码重试（旧实现此处要空等 12s+）。
    try {
      await page.waitForFunction(() => (window.__bob && window.__bob.length > 0) ||
        /无(满足|符合)条件/.test((document.body && document.body.innerText) || ""), { timeout: Math.min(timeoutMs, 12000), polling: 200 });
    } catch (e) { /* 到点也用已有数据继续（可能查无/页面结构变化）*/ }
    // 查无提示命中且详情桶为空 → 本码在 App 未上架，直接返回 null 交给父码重试
    if (!(await page.evaluate(() => (window.__bob || []).length))) {
      try {
        const miss = await page.evaluate(() => /无(满足|符合)条件/.test((document.body && document.body.innerText) || ""));
        if (miss) return null;
      } catch (e) { /* 上下文异常按无数据继续 */ }
    }

    // detailOnly 模式：app 端口对 web 的增量价值（成立日 estabDate / 额度 / 风险 / 最短持有 /
    // 业绩基准）全在详情对象 cd 里，页面加载即返回，无需点任何时间 tab、无需点「查看更多」
    // ——成立日扫描/额度查询走此模式，约 4-6s 完成（原全量模式 15-20s）。
    let navCap = [];
    if (!detailOnly) {
      // 历史净值（全量模式）：先点「近一年」（最大窗口；近三月⊂近六月⊂近一年，一档即最大），
      // 等接口响应落桶即止；未落才依次补「近六月」「近三月」（防御某档接口失败）。
      try {
        // 等图表时间 tab 渲染出来再点（详情卡先渲染、图表随后），替代原盲目定时
        await page.waitForFunction(() => {
          const hit = (txt) => [...document.querySelectorAll("div,span,li,button,i")]
            .filter((e) => e.childElementCount === 0 && (e.textContent || "").trim() === txt);
          return hit("近一年").length > 0 || hit("近六月").length > 0 || hit("近三月").length > 0;
        }, { timeout: 4000, polling: 250 }).catch(() => {});
        for (const lab of ["近一年", "近六月", "近三月"]) {
          const n0 = await page.evaluate(() => (window.__bobNav || []).length);
          const clicked = await page.evaluate((txt) => {
            const els = [...document.querySelectorAll("div,span,li,button,i")]
              .filter((e) => e.childElementCount === 0 && (e.textContent || "").trim() === txt);
            if (!els.length) return false;
            els[els.length - 1].click();
            return true;
          }, lab);
          if (!clicked) continue;
          // 等该档响应落桶（典型 0.5-1.5s；原每档固定 sleep 1200ms 且三档全点）
          try {
            await page.waitForFunction((n) => (window.__bobNav || []).length > n, { timeout: 2500, polling: 200 }, n0);
          } catch (e) { /* 该档未响应，试下一档 */ }
          const grew = (await page.evaluate(() => (window.__bobNav || []).length)) > n0;
          if (grew && lab === "近一年") break; // 最大窗口已到手，余下两档只是防御，不再白等
        }
        navCap = await page.evaluate(() => window.__bobNav || []);
      } catch (e) {}
    }

    // ⚠ 必须先把详情桶读出来：「查看更多」会跳转新页面，跳转后 window.__bob 被清空
    const cap = await page.evaluate(() => window.__bob || []);
    clearTimeout(timer);

    // 「查看更多」：本页展开/翻页则再收一轮；跳转新页面则 evaluateOnNewDocument 会在新文档
    // 重新装上 hook，新一轮接口响应进新 __bobNav（此前两桶数据已在 Node 侧，不会丢）
    if (!detailOnly) {
      try {
        const navBefore = navCap.length;
        await page.evaluate(() => {
          const els = [...document.querySelectorAll("a,div,span,li,button,i")]
            .filter((e) => e.childElementCount === 0 && (e.textContent || "").trim() === "查看更多");
          if (els.length) els[els.length - 1].click();
        });
        // 等「查看更多」触发的响应落桶（典型 0.5-1s；原固定 sleep 2500ms）
        try {
          await page.waitForFunction((n) => (window.__bobNav || []).length > n, { timeout: 2000, polling: 200 }, navBefore);
        } catch (e) {
          // 可能跳转新页面（执行上下文销毁）：短固定等待让新文档的 hook 收一轮
          await new Promise((r) => setTimeout(r, 1500));
        }
        const more = await page.evaluate(() => window.__bobNav || []).catch(() => []);
        navCap = navCap.concat(more);
      } catch (e) {}
    }
    if (!cap.length) return null;
    // 优先取 prdCode 与请求码精确匹配的对象（页面加载时可能渲染其它产品），
    // 无匹配再退到「字段最全」策略（防止个别产品不回显 prdCode 时全军覆没）。
    const want = String(c || "").toUpperCase();
    cap.sort((a, b) => b.n - a.n);
    const exact = cap.find((o) => String((o.cd && o.cd.prdCode) || "").toUpperCase() === want);
    const cd = (exact ? exact.cd : cap[0].cd) || {};

    const name = cd.prdName || null;
    if (!name) return null;

    // 历史净值序列：取记录数最多的一份 cd.list（同日去重、按日期升序）
    let appSeries = [];
    if (navCap.length) {
      let best = navCap[0];
      for (const b of navCap) if (b.n > best.n) best = b;
      const byDate = new Map();
      for (const r of best.list) {
        const d = bobAppDate(r.navDate);
        const v = parseFloat(r.nav);
        if (d && Number.isFinite(v) && v > 0) byDate.set(d, [d, v]);
      }
      appSeries = [...byDate.values()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
      // 现金管理类（OPEN_TYPE=6，如京华远见易淘金）cd.list 的 nav 是单位净值占位、恒为 1
      // （2026-10-17 实测 TG01190701：29 点全为 1）：真实收益在万份收益/累计净值字段。
      // 【项目规则 2026-10-21】现金管理类不抓不处理（web 端口 OPEN_TYPE=6 已直接排除），
      // App 侧对恒等序列同样整份丢弃，不做任何复利合成。
      if (appSeries.length >= 2 && appSeries.every((p) => p[1] === appSeries[0][1])) appSeries = [];
    }

    // 额度（元）：motorLimitAmt(页面「额度仅剩X」) → plimitAmt(可购额度上限) → prdTotAmt(产品总额度)。
    // ⚠ prdTotAmt 是状态文案时（如「额度充足」）说明上游未披露数字额度，此时 plimitAmt 只是
    // 上限、不是剩余量，绝不能当额度显示——TG01190701 实测 plimitAmt=500亿 但页面只有
    // 「额度充足」且产品总规模仅 28.8亿（2026-10-17 核实证伪），回落状态文案。
    // 132040B：plimitAmt=0.00/motorLimitAmt=0.04/prdTotAmt=0.04 → 取 motor（页面「额度仅剩0.04元」）。
    // YJ01260316A：plimitAmt=prdTotAmt=276.94亿/motor=0 → 取 plimit（数字额度，用户已确认展示 276.94亿）。
    const totRaw = String(cd.prdTotAmt == null ? "" : cd.prdTotAmt).trim();
    const totIsText = totRaw !== "" && !/^[0-9]+(\.[0-9]+)?$/.test(totRaw);
    const plimit = parseFloat(cd.plimitAmt);
    const motor = parseFloat(cd.motorLimitAmt);
    const tot = parseFloat(cd.prdTotAmt);
    let quotaNum = null, quotaText = null;
    if (totIsText) {
      quotaText = totRaw; // 「额度充足」等状态文案：无数字额度，不编造
    } else {
      quotaNum = Number.isFinite(plimit) && plimit > 0 ? plimit
        : (Number.isFinite(motor) && motor > 0 ? motor
        : (Number.isFinite(tot) && tot > 0 ? tot : null));
    }

    const lastNav = appSeries.length ? appSeries[appSeries.length - 1] : null;
    return {
      name,
      manager: cd.taName ? String(cd.taName).replace(/有限责任公司|有限公司/g, "") : null, // 北银理财
      nav: parseFloat(cd.nav) || null,
      navDate: bobAppDate(cd.financeDate),
      risk: bobAppRisk(cd.riskName, cd.riskLeve),
      holdDays: bobAppHoldDays(cd.bjyhHoldDays, cd.bjyhHoldDaysName, cd.lockDays),
      established: bobAppDate(cd.estabDate),
      benchmark: bobAppBench(cd.guestRateRemarkValue),
      incomeRate: cd.incomeRate || null,
      productScale: Number.isFinite(tot) ? tot : null,
      remainQuota: quotaNum,
      quotaState: (quotaNum != null || quotaText) ? "available" : null,
      quotaText,
      currency: "CNY",
      prdCode: cd.prdCode || c,
      source: "app-bob",
      series: appSeries,
      navLatest: lastNav ? lastNav[1] : (parseFloat(cd.nav) || null),
      navLatestDate: lastNav ? lastNav[0] : bobAppDate(cd.financeDate),
    };
  } catch (e) {
    return null;
  } finally {
    if (timer) clearTimeout(timer); // 所有退出路径（含「无满足条件」提前返回/抛错）都撤掉兜底定时器
    try { await page.close(); } catch (e) {}
  }
}

/* 对外入口：份额码查无 → 父码重试一次（2026-10-17 实测 TG01190701A 在 App「无满足条件记录」，
   父码 TG01190701 页面完整渲染；App 按父码上架，web 净值行 PROD_CODE 亦是父码）。
   父码必须回显父码本身，防止串到其它产品。 */
export async function bobAppCapture(code, opts = {}) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  let r = await bobAppCaptureOnce(c, opts).catch(() => null);
  if (!r) {
    const parent = c.replace(/[A-Z]$/, "");
    if (parent && parent !== c && parent.length >= 6) {
      r = await bobAppCaptureOnce(parent, opts).catch(() => null);
      if (r && String(r.prdCode || "").toUpperCase() !== parent) r = null;
    }
  }
  return r;
}

/* 招银理财官网（www.cmbchinawm.com）产品抓取 —— **纯 HTTP + SM2，Node 与 Cloudflare Workers 通用**
 * ============================================================================
 * 替代 cmbwm_app.mjs 的 CDP/Chrome 腿：官网所有 POST 接口的请求体都是 SM2 加密的
 *   body = JSON.stringify(SmAencrypt(payload))，SmAencrypt = x => '04' + sm2.doEncrypt(JSON.stringify(x), PUBKEY, 1)
 * 这里用纯 JS 自实现 SM2+SM3（见 cmbwm_sm2.mjs，零依赖、BigInt 运算），不再依赖真浏览器。
 *
 * 已实证（2026-11）：
 *   ① SM3("abc") 命中国标向量；SM2 自生成密钥对加密→解密回合一致；
 *   ② 用反查到的真实公钥加密后 POST，官网返回 code:200 + 完整净值序列；
 *   ③ nginx WAF 仅要求同源 Origin + Referer（csrf 同源校验），无需 cookie；
 *   ④ /web/api/* 有境外 IP 地域封禁（302→/block_page），但 /prod-api 反代前缀不受限。
 *
 * 接口（全部 POST，前缀 /prod-api/web/api，详见 cmbwm_app.mjs 头部注释）：
 *   净值  product/getNetValAndRate   {prodTradeCode}
 *   详情  product/getProductDetail/01 {prodTradeCode}
 *   成立日 product/query-his-sal-risk-quota {prodTradeCode}
 *   目录  product/getProductList      {current,pageSize,prodClcMode:"01",finType:"P"}
 *
 * 字段口径：navDate/ipoBgnDt/xpcMtuDt 都是毫秒时间戳；净值日必须按**北京时间日历日**取（ms+8h 后取 UTC 日）。
 * ========================================================================== */

import { sm2EncryptHex } from "./cmbwm_sm2.mjs";

const CMBWM_BASE = "https://www.cmbchinawm.com";
const CMBWM_API = "/web/api/product";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

// SM2 公钥：从官网混淆 bundle 的运行期闭包反查得到（见 cmbwm_pubkey.txt），curve-validated，公开值。
const PUBKEY = "04cf98844d3ddf6b87e124fba422e64e0b93e9bf83aff6fb8e246c0582567390099bfcb6563290e9a015f42a382053ceb3c95530201da6c8f1ba140774f3bc6a87";

// nginx WAF 要求同源 Origin + Referer（缺则 403）；sec-fetch-* 同真浏览器，保险起见一并带。
const REQ_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": UA,
  "Accept-Language": "zh-CN,zh;q=0.9",
  "Accept": "application/json, text/plain, */*",
  "Origin": "https://www.cmbchinawm.com",
  "Referer": "https://www.cmbchinawm.com/",
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "cors",
  "sec-fetch-dest": "empty",
};

const RISK = { "01": "R1(低)", "02": "R2(中低)", "03": "R3(中)", "04": "R4(中高)", "05": "R5(高)" };

/* ---------------- 工具（移植自 cmbwm_app.mjs） ---------------- */

/** 毫秒时间戳 → YYYY-MM-DD（**按北京时间日历日**：ms + 8h 后取 UTC 日）。 */
function ms2date(ms) {
  const n = Number(ms);
  if (!n || !isFinite(n)) return null;
  return new Date(n + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 北京时间的今天 */
function todayBJ() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function ms2DateOrNull(ms) { return ms2date(ms); }

/** "成立以来\r\n2009/03/26-2026/10/20" → 2009-03-26（兼容对象与字符串两种返回） */
function parseEstablish(quota) {
  let tp = "";
  if (typeof quota === "string") tp = quota;
  else if (quota && typeof quota === "object") {
    const list = quota.mpSalRiskQuotaQDTableVOList || [];
    for (const it of list) {
      const t = String((it && it.timePeriod) || "");
      if (/成立以来/.test(t)) { tp = t; break; }
    }
  }
  if (!tp) return null;
  const m = /(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(tp);
  if (!m) return null;
  return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
}

/* 名称解析最短持有天数（复用 worker.js 同款口径；内联轻量版避免循环依赖） */
const HD_CN = { 零: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const HD_NUM = "(\\d+|[零一两二三四五六七八九十]+)";
function hdCn2num(s) {
  const t = String(s || "").trim();
  if (/^\d+$/.test(t)) return Number(t);
  if (!t) return null;
  if (t === "十") return 10;
  if (t.length === 1) return HD_CN[t] ?? null;
  if (t.length === 2) {
    if (t[0] === "十") return 10 + (HD_CN[t[1]] || 0);
    if (t[1] === "十") return (HD_CN[t[0]] || 0) * 10;
  }
  if (t.length === 3 && t[1] === "十") return (HD_CN[t[0]] || 0) * 10 + (HD_CN[t[2]] || 0);
  return null;
}
function cmbHoldDaysFromName(name) {
  const s = String(name || "");
  const D = (n, u) => (n == null ? null : u === "m" ? n * 30 : u === "y" ? n * 365 : u === "w" ? n : n);
  const WORDS = [
    [/天添金|日日|活钱管家|天天/, 1],
    [/一年半(?:开|定开)/, 18 * 30],
    [/半年(?:开|定开)|半年度/, 180],
    [/季添利|季季开|季季|季开/, 90],
    [/月添利|月月开|月开|月度开|月月/, 30],
    [/周周发|每周开放|周周|周开|周享/, 7],
    [/年年享|年年开|每年开放/, 365],
    [/日开|每日开放/, 1],
  ];
  for (const [re, v] of WORDS) if (re.test(s)) return v;
  const rules = [
    [new RegExp(HD_NUM + "\\s*天(?:持有|滚动)"), "d"],
    [new RegExp(HD_NUM + "\\s*个?月(?:持有|滚动)"), "m"],
    [new RegExp(HD_NUM + "\\s*年(?:持有|期)"), "y"],
    [new RegExp("(?:滚动持有|持有|滚动)\\s*" + HD_NUM + "\\s*天"), "d"],
    [new RegExp("(?:滚动持有|持有|滚动)\\s*" + HD_NUM + "\\s*个?月"), "m"],
    [new RegExp("(?:滚动持有|持有|滚动)\\s*" + HD_NUM + "\\s*年"), "y"],
    [new RegExp(HD_NUM + "\\s*个?月封闭"), "m"],
    [new RegExp(HD_NUM + "\\s*年封闭"), "y"],
    [new RegExp(HD_NUM + "\\s*天封闭"), "d"],
    [new RegExp(HD_NUM + "\\s*个?月\\s*(?:定开|定期开放|开(?![放始]))"), "m"],
    [new RegExp(HD_NUM + "\\s*年\\s*(?:定开|定期开放|开(?![放始]))"), "y"],
    [new RegExp(HD_NUM + "\\s*天\\s*(?:定开|定期开放)"), "d"],
    [new RegExp(HD_NUM + "\\s*个?月"), "m"],
    [new RegExp(HD_NUM + "\\s*年"), "y"],
    [new RegExp(HD_NUM + "\\s*天"), "d"],
  ];
  for (const [re, unit] of rules) {
    const m = re.exec(s);
    if (m) { const n = hdCn2num(m[1]); if (n != null && n > 0) return D(n, unit); }
  }
  return null;
}

/* ---------------- 请求 ---------------- */

/** SM2 加密 POST（Promise reject 表示失败；调用方据此回落兜底）。
 *  含轻量重试：官网偶有 5xx/超时（"系统繁忙"），退避后重试可自愈，避免误回落兜底链。 */
async function wmPost(path, payload, timeoutMs = 20000) {
  const body = JSON.stringify(sm2EncryptHex(JSON.stringify(payload), PUBKEY));
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(CMBWM_BASE + "/prod-api" + path, {
        method: "POST", headers: REQ_HEADERS, body, signal: ctrl.signal,
      });
      if (r.status !== 200) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) {
      lastErr = e;
      clearTimeout(timer);
      if (attempt < 2) await new Promise((res) => setTimeout(res, 350 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/* ---------------- 对外 API ---------------- */

/**
 * 抓招银理财官网产品的净值序列 + 信息字段。
 * @param code 产品交易代码（prodTradeCode，如 132112D）
 * @param opts.since 增量：仅作为标记（navIncremental），实际全量返回，由编排层按 since 过滤
 * @param opts.log 日志回调
 */
export async function cmbwmByCode(code, opts = {}) {
  const c = String(code || "").trim();
  if (!c) return null;

  let navJ, detJ, qJ;
  try {
    [navJ, detJ, qJ] = await Promise.all([
      wmPost(CMBWM_API + "/getNetValAndRate", { prodTradeCode: c }),
      wmPost(CMBWM_API + "/getProductDetail/01", { prodTradeCode: c }),
      wmPost(CMBWM_API + "/query-his-sal-risk-quota", { prodTradeCode: c }),
    ]);
  } catch (e) {
    console.log("[cmbwm-http] 请求失败: " + e.message);
    if (opts.log) opts.log("  [cmbwm-http] 请求失败: " + e.message);
    return null;
  }

  const navRaw = (navJ && navJ.data) || [];
  if (!navRaw.length) {
    if (opts.log) opts.log("  [cmbwm-http] 净值接口无 data");
    return null;
  }

  const rows = [];
  const seen = {};
  for (const x of navRaw) {
    const date = ms2date(x.navDate);
    if (!date) continue;
    const num = (v) => (v == null || v === "" ? null : Number(v));
    const unit = num(x.nav);
    const accu = num(x.accuNav);
    const wan = num(x.tenThousandUnitIncome);
    if (unit == null && accu == null && wan == null) continue; // 纯现金类占位行
    if (seen[date]) continue;
    seen[date] = 1;
    // 优先单位净值，缺失时回退累计净值
    rows.push([date, unit != null ? unit : accu]);
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const info = (detJ && detJ.data) || null;
  const establish = parseEstablish(qJ && qJ.data);
  const last = rows.length ? rows[rows.length - 1] : null;

  return {
    name: (info && (info.prodNam || info.csName)) || null,
    manager: "招银理财",
    established: (info && info.ipoBgnDt ? ms2date(info.ipoBgnDt) : establish) || (rows.length ? rows[0][0] : null),
    establishedFromSeries: !(info && info.ipoBgnDt) && !establish && rows.length > 0,
    series: rows,
    kind: "nav",
    risk: info && info.rskGrd ? (RISK[info.rskGrd] || ("R" + String(info.rskGrd).replace(/^0+(?=\d)/, ""))) : null,
    benchmark: (info && info.pfmCompBchmRmk) || null,
    holdDays: info ? cmbHoldDaysFromName(info.prodNam || info.csName) : null,
    registryCode: (info && info.prodRegId) || null,
    source: "live",
    bank: "cmb",
    navVia: "cmb",
    navPort: "cmbwm",
    lastSrcVia: "cmb",
    lastSrcPort: "cmbwm",
    navDate: last ? last[0] : null,
    navLatest: last ? last[1] : null,
    navIncremental: !!opts.since,
    infoOnly: rows.length === 0 && !opts.since,
  };
}

/**
 * 招银理财官网全量目录枚举（cfweb 下架产品仍留存于此）。
 * 返回 [{code, shortName, registerCode, risk, status, benchmark, ipoBgnDt, ipoEndDt, xpcMtuDt}]
 */
export async function cmbwmCatalog(opts = {}) {
  const base = { prodClcMode: "01", finType: "P" };
  const PS = 200; // 官网对单页大行数（>~200）偶发 500，缩小页幅 + wmPost 重试自愈
  const first = await wmPost(CMBWM_API + "/getProductList", { ...base, current: 1, pageSize: PS });
  if (!first || !first.data) throw new Error(`目录接口异常：${(first && first.msg) || "无 data"}`);
  const total = Number(first.data.total) || 0;
  const pages = Math.ceil(total / PS) || 1;
  if (opts.log) opts.log(`  [cmbwm-http] 目录 ${total} 个，${pages} 页`);
  const all = [...(first.data.list || [])];

  for (let p = 2; p <= pages; p++) {
    const j = await wmPost(CMBWM_API + "/getProductList", { ...base, current: p, pageSize: PS });
    all.push(...((j.data && j.data.list) || []));
  }

  const onSale = new Set();
  for (const st of ["1", "2"]) {
    const j = await wmPost(CMBWM_API + "/getProductList", { ...base, saleState: st, current: 1, pageSize: PS });
    const n = (j.data && j.data.total) || 0;
    const list = (j.data && j.data.list) || [];
    for (const x of list) onSale.add(`${x.prodTradeCode}|${st}`);
    if (n > list.length) {
      for (let p = 2; p <= Math.ceil(n / PS); p++) {
        const k = await wmPost(CMBWM_API + "/getProductList", { ...base, saleState: st, current: p, pageSize: PS });
        for (const x of ((k.data && k.data.list) || [])) onSale.add(`${x.prodTradeCode}|${st}`);
      }
    }
    if (opts.log) opts.log(`  [cmbwm-http] saleState=${st} → ${n} 个`);
  }

  const now = Date.now();
  const seen = new Set();
  const products = [];
  for (const x of all) {
    const code = String(x.prodTradeCode || "").trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    let saleState;
    if (onSale.has(`${code}|1`)) saleState = "可购买";
    else if (onSale.has(`${code}|2`)) saleState = "即将发售";
    else if (x.xpcMtuDt && Number(x.xpcMtuDt) < now) saleState = "已到期";
    else if (x.ipoBgnDt && ms2date(x.ipoBgnDt) > todayBJ()) saleState = "即将发售";
    else saleState = "暂停购买";
    products.push({
      code,
      shortName: x.csName || null,
      registerCode: x.prodRegId || null,
      risk: RISK[x.rskGrd] || x.rskGrd || null,
      status: saleState,
      benchmark: x.pfmCompBchmRmk || null,
      ipoBgnDt: ms2DateOrNull(x.ipoBgnDt),
      ipoEndDt: ms2DateOrNull(x.ipoEndDt),
      xpcMtuDt: ms2DateOrNull(x.xpcMtuDt),
    });
  }
  if (opts.log) opts.log(`  [cmbwm-http] 目录完成：${products.length} 个`);
  return products;
}

/* 纯 HTTP 腿无需预热/关闭浏览器 */
export async function cmbwmWarmup() { return true; }
export async function closeCmbwmBrowser() {}

export default { cmbwmByCode, cmbwmCatalog, cmbwmWarmup, closeCmbwmBrowser };

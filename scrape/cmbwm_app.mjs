/* 招银理财官网（www.cmbchinawm.com）产品抓取 —— **仅本机 Node 用**（Cloudflare Workers 无 Chrome）
 * ============================================================================
 * 为什么必须走 CDP（真浏览器），不能用纯 HTTP 客户端：
 *
 *   官网所有 POST 接口的请求体都是 SM2 加密的，形如 "04<hex>"：
 *     body = JSON.stringify(vm.SmAencrypt(payload))
 *     vm.SmAencrypt = x => '04' + sm2.doEncrypt(JSON.stringify(x), PUBKEY, 1)   // C1C3C2
 *   公钥与加密逻辑都编译在 660KB 的混淆 bundle 里，纯 HTTP 客户端既拿不到也复现不了。
 *   与其把国密 SM2+SM3 用 JS 重写一遍，不如在真实页面上下文里执行 vm.SmAencrypt(...)
 *   当加密器 —— 页面自己就是最权威的实现。
 *
 *   ⚠ 注意：bundle 里还有一个 RSAencrypt，但它不是 SmAencrypt 用的那个；
 *     真正被调的是 vm.SmAencrypt（页面 Vue 根实例上的方法）。
 *
 * 另有两个坑（都已在 2026-10-31 实证）：
 *   1) 站点 nginx 对 /web/api/* 做了地域封禁（境外 IP 一律 302 → /block_page）。
 *      但反代前缀 /prod-api/web/api/ 不受限 → 请求必须走 /prod-api 前缀。
 *      （直接 curl /web/api/... 会 302；curl /prod-api/web/api/... 正常返回 JSON）
 *   2) 页面用 hash 路由，列表页是 /publicOffering 而不是 /proList（后者落到 block_page）。
 *
 * 接口（全部 POST，前缀 /prod-api/web/api）：
 *   净值  product/getNetValAndRate   {prodTradeCode}   ← 一次回全历史，无分页、无条数上限
 *   详情  product/getProductDetail/01 {prodTradeCode}  ← 名称/简称/登记编码/风险/基准/成立日
 *   成立日 product/query-his-sal-risk-quota {prodTradeCode}
 *   目录  product/getProductList      {current,pageSize,prodClcMode:"01",finType:"P"}  ← 全量目录枚举
 *
 * 字段口径：
 *   navDate / ipoBgnDt / xpcMtuDt 都是毫秒时间戳。
 *   ⚠⚠ 2026-10-31 修正（早一天 bug）：净值日必须按**北京时间日历日**取（ms + 8h 后取 UTC 日），
 *      不可直接用 UTC 日期。铁证：官网标签 +1 天 vs 中国理财网/招行超市/cgb-app 三方逐日一致，
 *      且官网原始星期分布「周五 0 个」违反净值披露规律 → 日期整体错位一天。
 *   investType 01=固定收益类 02=权益类 03=混合类 04=商品及金融衍生品类
 *   showPrice=N 的产品（现金管理类）不披露单位/累计净值，只有万份收益。
 *
 * 2026-10-31 重构：① 改用零依赖 CDP 客户端（scrape/cmbwm_cdp.mjs，Node 内置 WebSocket，无需 puppeteer）；
 *   ② CmbwmClient 队列批处理 —— 把多产品的请求攒进**单个 page.evaluate**内 24 路并发发，
 *      大幅降低 CDP 往返开销（cron 批量刷新 171 只时，从「每产品 2 次 evaluate」降到「每 24 请求 1 次 evaluate」）。
 * ========================================================================== */

import { CdpPage } from "./cmbwm_cdp.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CMBWM_BASE = "https://www.cmbchinawm.com";
// 注意：这里不带 /prod-api 前缀，调用处统一加（否则会拼成 /prod-api/prod-api/...）
const CMBWM_API = "/web/api/product";
// 页面就绪判据：Vue 根实例上必须有 SmAencrypt（bundle 加载完才有）
const PAGE_READY =
  "!!(document.querySelector('#app')&&document.querySelector('#app').__vue__&&document.querySelector('#app').__vue__.SmAencrypt)";

// 页面就绪总时限：bundle 660KB 冷启动实测 15~25s；封顶 40s，超时快速失败（不拖垮编排层 60s 预算）。
const CMBWM_PAGE_READY_TIMEOUT_MS = 40000;

// 批处理参数（移植自 bankscrape cmbwm.js）
const IN_PAGE_CONC = 24;       // 单 evaluate 内页面并发上限（实测 24~30 路 ≈ 22 req/s）
const MIN_BATCH = 24;          // 队列积压到这个数立即 flush
const MAX_BATCH = 36;          // 单次 evaluate 最多并发的请求数
const FLUSH_DELAY_MS = 40;     // 不足 MIN_BATCH 时，最多等 40ms 攒批

const PROFILE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "cmbwm_profile");
const CDP_PORT = 9423;

/* 页面内结果变换器（直接在页面里跑，把响应体压到最小）：
 *   raw 原样 / obj JSON.parse / nav 只留 5 字段（1000 点约 40KB）/ quota 只留「成立以来」首日 */
const TRANSFORM_SRC = `{
  raw:(t)=>t,
  obj:(t)=>{try{return JSON.parse(t)}catch(e){return {__err:'parse'}}},
  nav:(t)=>{try{const j=JSON.parse(t);if(!j.data)return {__err:j.msg||'no data'};return j.data.map(x=>[x.navDate,x.nav,x.accuNav,x.tenThousandUnitIncome,x.annualizedYield])}catch(e){return {__err:'parse'}}},
  quota:(t)=>{try{const j=JSON.parse(t);if(!j.data)return {__err:j.msg||'no data'};const a=(j.data.mpSalRiskQuotaQDTableVOList||[]).filter(x=>/成立以来/.test(String(x.timePeriod||''))).map(x=>String(x.timePeriod));return a[0]||null}catch(e){return {__err:'parse'}}}
}`;

const RISK = { "01": "R1(低)", "02": "R2(中低)", "03": "R3(中)", "04": "R4(中高)", "05": "R5(高)" };

/* ---------------- 工具 ---------------- */

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

/* ---------------- 页面 / 客户端单例 ---------------- */

let _page = null;
let _opening = null;

async function ensurePage(log = () => {}) {
  if (_page && !_page.closed) {
    const ok = await _page.eval(PAGE_READY).catch(() => false);
    if (ok) return _page;
    try { _page.close(); } catch {}
    _page = null;
  }
  if (_opening) return _opening;
  _opening = (async () => {
    _page = await CdpPage.open({
      url: CMBWM_BASE + "/",
      port: CDP_PORT,
      profileDir: PROFILE_DIR,
      readyExpr: PAGE_READY,
      timeoutMs: CMBWM_PAGE_READY_TIMEOUT_MS,
      log,
    });
    return _page;
  })().finally(() => { _opening = null; });
  return _opening;
}

class CmbwmClient {
  constructor(log = () => {}) {
    this.log = log;
    this.q = [];
    this.flushing = false;
    this._timer = null;
    this.minBatch = MIN_BATCH;
    this.maxBatch = MAX_BATCH;
    this.stats = { requests: 0, batches: 0, errors: 0 };
  }

  /** 入队；同一批在页面内并发执行，把 CDP 往返开销摊薄到 1/N */
  _enqueue(kind, path, payload) {
    return new Promise((resolve, reject) => {
      this.q.push({ kind, path, payload, resolve, reject });
      if (this.q.length >= this.minBatch) this._flush();
      else if (!this._timer) this._timer = setTimeout(() => { this._timer = null; this._flush(); }, FLUSH_DELAY_MS);
    });
  }

  async _flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.q.length) {
        const batch = this.q.splice(0, this.maxBatch);
        try {
          const out = await this._runBatch(batch.map((x) => ({ kind: x.kind, path: x.path, payload: x.payload })));
          batch.forEach((it, i) => {
            const v = out[i];
            if (v && v.__err) { this.stats.errors++; it.reject(new Error(String(v.__err).slice(0, 120))); }
            else it.resolve(v);
          });
        } catch (e) {
          batch.forEach((it) => it.reject(e));
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  /** 在页面上下文里批量跑请求（单 evaluate 内 24 路并发）；items: [{kind,path,payload}] */
  async _runBatch(items) {
    let page = await ensurePage(this.log);
    try {
      return await this._runBatchInner(page, items);
    } catch (e) {
      // 页面可能崩溃 → 重建一次并重试
      try { if (_page && !_page.closed) _page.close(); } catch {}
      _page = null;
      page = await ensurePage(this.log);
      return await this._runBatchInner(page, items);
    }
  }

  async _runBatchInner(page, items) {
    const payload = JSON.stringify(items);
    const expr = `(async()=>{
      const vm=document.querySelector('#app').__vue__;
      const T=${TRANSFORM_SRC};
      const reqs=${payload};
      const out=new Array(reqs.length);
      let cur=0;
      const worker=async()=>{
        while(true){
          const i=cur++; if(i>=reqs.length) return;
          const q=reqs[i];
          try{
            const body=JSON.stringify(vm.SmAencrypt(q.payload));
            const r=await fetch('/prod-api'+q.path,{method:'POST',headers:{'Content-Type':'application/json'},body});
            const t=await r.text();
            out[i]=T[q.kind](t);
          }catch(e){ out[i]={__err:String(e&&e.message||e)}; }
        }
      };
      await Promise.all(Array.from({length:Math.min(${IN_PAGE_CONC},reqs.length)},worker));
      return JSON.stringify(out);
    })()`;
    const s = await page.evalAsync(expr, { timeoutMs: 300000 });
    this.stats.batches++;
    this.stats.requests += items.length;
    return JSON.parse(s);
  }

  /* 通用单发 + 三类业务接口 */
  list(path, payload) { return this._enqueue("obj", CMBWM_API + path, payload); }
  nav(code) { return this._enqueue("nav", CMBWM_API + "/getNetValAndRate", { prodTradeCode: code }); }
  detail(code) { return this._enqueue("obj", CMBWM_API + "/getProductDetail/01", { prodTradeCode: code }); }
  quota(code) { return this._enqueue("quota", CMBWM_API + "/query-his-sal-risk-quota", { prodTradeCode: code }); }
}

let _client = null;
function getClient(log) {
  if (!_client) _client = new CmbwmClient(log);
  return _client;
}

/* ---------------- 对外 API ---------------- */

/**
 * 抓招银理财官网产品的净值序列 + 信息字段。
 * @param code 产品交易代码（prodTradeCode，如 132112D）
 * @param opts.since 增量：只回该日期之后的新增点（不传 = 全量）
 * @param opts.log 日志回调
 */
export async function cmbwmByCode(code, opts = {}) {
  const c = String(code || "").trim();
  if (!c) return null;
  const client = getClient(opts.log);

  // 净值 / 详情 / 成立日 **并发** 入队（页面内 fetch 可并行，省往返）
  const navP = client.nav(c);
  const detP = client.detail(c);
  const qP = client.quota(c);
  const [navRaw, det, q] = await Promise.all([navP, detP, qP]);

  if (!navRaw || navRaw.__err) {
    if (opts.log) opts.log("  [cmbwm] 净值接口失败: " + JSON.stringify(navRaw).slice(0, 300));
    return null;
  }

  const rows = [];
  const seen = {};
  for (const x of navRaw) {
    const date = ms2date(x[0]);
    if (!date) continue;
    const num = (v) => (v == null || v === "" ? null : Number(v));
    const unit = num(x[1]);
    const accu = num(x[2]);
    const wan = num(x[3]);
    if (unit == null && accu == null && wan == null) continue; // 纯现金类占位行
    if (seen[date]) continue;
    seen[date] = 1;
    // 优先单位净值，缺失时回退累计净值（实测多数点两者相等；分红产品以累计为准）
    rows.push([date, unit != null ? unit : accu]);
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const info = (det && det.data) || null;
  const establish = parseEstablish(q);
  const last = rows.length ? rows[rows.length - 1] : null;

  const out = {
    name: (info && (info.prodNam || info.csName)) || null,
    manager: "招银理财",
    established: (info && info.ipoBgnDt ? ms2date(info.ipoBgnDt) : establish) || (rows.length ? rows[0][0] : null),
    establishedFromSeries: !(info && info.ipoBgnDt) && !establish && rows.length > 0,
    series: rows,
    kind: "nav",
    // rskGrd 是 "01".."05"（两位数字）→ 归一成 R1..R5（带中文标签，与项目展示口径一致）
    risk: info && info.rskGrd ? (RISK[info.rskGrd] || ("R" + String(info.rskGrd).replace(/^0+(?=\d)/, ""))) : null,
    benchmark: (info && info.pfmCompBchmRmk) || null,
    // 2026-10-31 移植：用名称解析最短持有天数（覆盖 月/年/季/周 + 中文数字 + 封闭期用到期日兜底）
    holdDays: info ? cmbHoldDaysFromName(info.prodNam || info.csName) : null,
    regCode: (info && info.prodRegId) || null,
    source: "live",
    bank: "cmb",
    navVia: "cmb",
    navPort: "cmbwm",
    lastSrcVia: "cmb",
    lastSrcPort: "cmbwm",
    navDate: last ? last[0] : null,
    navLatest: last ? last[1] : null,
    // 增量模式：本轮只回 since 之后的新增点（0 点也是合法结果 = 已是最新）
    navIncremental: !!opts.since,
    // infoOnly =「该产品根本没有净值序列，只取到信息」。增量模式 0 新增点 ≠ 没净值 → 不置 true。
    infoOnly: rows.length === 0 && !opts.since,
  };
  return out;
}

/**
 * 招银理财官网全量目录枚举（cfweb 下架产品仍留存于此，是 132112D 这类产品的唯一出口）。
 * 返回 [{code, shortName, regCode, risk, status, benchmark, ipoBgnDt, ipoEndDt, xpcMtuDt}]
 * —— 可直接用来补全/发现「招行代销它行 + 招银理财自营」候选。
 */
export async function cmbwmCatalog(opts = {}) {
  const client = getClient(opts.log);
  const base = { prodClcMode: "01", finType: "P" };
  const first = await client.list("/getProductList", { ...base, current: 1, pageSize: 500 });
  if (!first || !first.data) throw new Error(`目录接口异常：${(first && first.msg) || "无 data"}`);
  const total = Number(first.data.total) || 0;
  const pages = Math.ceil(total / 500) || 1;
  if (opts.log) opts.log(`  [cmbwm] 目录 ${total} 个，${pages} 页`);
  const all = [...(first.data.list || [])];

  for (let p = 2; p <= pages; p++) {
    const j = await client.list("/getProductList", { ...base, current: p, pageSize: 500 });
    all.push(...((j.data && j.data.list) || []));
  }

  // 销售状态：官方只提供「可购买 / 即将发售」两个筛选口径，各拉一遍拿代码集合
  const onSale = new Set();
  for (const st of ["1", "2"]) {
    const j = await client.list("/getProductList", { ...base, saleState: st, current: 1, pageSize: 500 });
    const n = (j.data && j.data.total) || 0;
    const list = (j.data && j.data.list) || [];
    for (const x of list) onSale.add(`${x.prodTradeCode}|${st}`);
    if (n > list.length) {
      for (let p = 2; p <= Math.ceil(n / 500); p++) {
        const k = await client.list("/getProductList", { ...base, saleState: st, current: p, pageSize: 500 });
        for (const x of ((k.data && k.data.list) || [])) onSale.add(`${x.prodTradeCode}|${st}`);
      }
    }
    if (opts.log) opts.log(`  [cmbwm] saleState=${st} → ${n} 个`);
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
      regCode: x.prodRegId || null,
      risk: RISK[x.rskGrd] || x.rskGrd || null,
      status: saleState,
      benchmark: x.pfmCompBchmRmk || null,
      ipoBgnDt: ms2DateOrNull(x.ipoBgnDt),
      ipoEndDt: ms2DateOrNull(x.ipoEndDt),
      xpcMtuDt: ms2DateOrNull(x.xpcMtuDt),
    });
  }
  if (opts.log) opts.log(`  [cmbwm] 目录完成：${products.length} 个`);
  return products;
}

function ms2DateOrNull(ms) { return ms2date(ms); }

/* 名称解析最短持有天数（复用 worker.js 同款口径；此处避免循环依赖，内联一份轻量版） */
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

/* 预热：加载页面 + bundle，让 vm.SmAencrypt 就绪（省掉首个产品的 15~25s 冷启动） */
export async function cmbwmWarmup() {
  const client = getClient();
  try { await ensurePage(() => {}); return true; } catch (e) { return false; }
}

export async function closeCmbwmBrowser() {
  try { if (_page && !_page.closed) await _page.close(); } catch (e) {}
  _page = null;
  _client = null;
}

export default { cmbwmByCode, cmbwmCatalog, cmbwmWarmup, closeCmbwmBrowser };

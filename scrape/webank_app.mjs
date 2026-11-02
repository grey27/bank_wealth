/* 微众银行 App 端口（personal.webank.com 理财网关）—— 产品信息 + 最新净值
 *
 * ============================ 端口本质 ============================
 * 微众银行 App 的「理财」模块是 React Native，数据全部走 HTTP JSON 网关：
 *   POST https://personal.webank.com/wm-hjhtr/wm_product/productinfo/getproductlistbycode
 *   body {"productInfoList":[{"name":"NYJXLD1409G"}]}
 *   → { ret_code:"20350000", ret_data:{ productInfoList:[{ name, content:"<JSON字符串>" }] } }
 * content 是 **210 个字段的 JSON 字符串**，覆盖名称/发行方/成立日/风险等级/期限/最新净值/
 * 净值日期/规模/额度/起购/费率/买卖规则 —— 一次请求全拿到，免登录、免签名、免 PDF。
 *
 * 反编译来源：APK rn/js-modules/742.js（RN 接口总表）、766.js（WeApi 网络层）、
 *            5944.js（域名表）、765.js（网关前缀表）、14503.js（净值服务路由）。
 *
 * ============================ 净值历史：2026-10-17 误判，2026-10-19 已打通 ============================
 * 2026-10-17 穷举结论（已推翻）：App 的产品详情净值曲线走 FundHistoryNAVService，其候选
 *   端点 GET /wm-hjhtr/wm-pqs/* 与 GET /wm-htrserver/finance/* 对免登录请求恒回
 *   23525003 / 21405001。当时误判为「服务端对免登录客户端的准入控制，脚本与浏览器均无法复现」。
 *
 * 2026-10-19 突破（用户贴 App 未登录截图指正「截屏 HTTP 是 app 端口不是 H5」后重测）：
 *   另有一条**产品历史净值聚合网关**可免登录直取全序列——
 *     POST https://personal.webank.com/wm-hjhtr/wm_product/history/query/stock_rates
 *     UA: webank/9.5.2
 *     body: {"prod_code":"NYCF000010","start_date":"20200101","end_date":"20991231"}
 *     → 20350000, ret_data = { "YYYYMMDD": { unit_net_value, accu_net_value, ... }, ... }（升序）
 *   · 必须 POST + 同时带 start_date/end_date；GET 或只给 prod_code 无日期均 21600054 失败。
 *   · 宽区间（2015 起）不截断，返回该码成立以来全部交易日。
 *   · 未收录码 → ret_data={}（容错正常）；假码也只回空，不报错。
 *   · 与产品信息网关同 host（personal.webank.com，personalv6.* / *.webankwealth.com 同响应），
 *     免登录、免签名、免设备凭证 —— 之前的 23525003 是**选错端点**，不是准入控制。
 *   · 实测 NYCF000010 → 144 点（20260316→20261016），与用户截图历史净值逐日吻合。
 *   故本模块**承诺产品信息 + 全量净值序列**（webankAppNavHistory），不再回落中国理财网序列。
 *
 * 公众号数据域（hjdata.webank.com/hj/productinfo/getproductlistbycode）仍只认基金/公众号
 *   内部编号（如 11201401-1），不认 NYJXLD1409G；净值接口恒回 20270054，与本路径无关。
 */

const WB_HOST = "https://personal.webank.com";
const WB_INFO_PATH = "/wm-hjhtr/wm_product/productinfo/getproductlistbycode";
// 2026-10-19 突破：产品历史净值聚合网关（免登录、免签名，必须 POST + start_date/end_date）
const WB_NAV_HISTORY_PATH = "/wm-hjhtr/wm_product/history/query/stock_rates";
const WB_UA = "webank/9.5.2";

/** 微众的成功码（理财域 2035xxxx；数据域 2027xxxx） */
const WB_OK = "20350000";

function ymd(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (/^\d{8}$/.test(s)) return s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6, 8);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const n = Number(s);
  if (Number.isFinite(n) && n > 1e11) {
    // 毫秒时间戳按北京时间取日期（微众给的是当日 00:00 +08:00，UTC 会退一天）
    const d = new Date(n + 8 * 3600 * 1000);
    return d.toISOString().slice(0, 10);
  }
  return null;
}

function riskText(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return null;
  if (/^R?\d$/i.test(s)) return "R" + s.replace(/^R/i, "");
  return s;
}

/** 期限：invest_term + invest_term_unit（14 D → 14 天；unit: D 天 / M 月 / Y 年） */
function termDays(c) {
  const n = Number(c.invest_term);
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = String(c.invest_term_unit || "").toUpperCase();
  if (u === "D") return n;
  if (u === "M") return n * 30;
  if (u === "Y") return n * 365;
  return n;
}

async function httpJson(url, init, transport) {
  const f = transport || globalThis.fetch;
  const res = await f(url, init);
  const txt = await res.text();
  let j = null;
  try { j = JSON.parse(txt); } catch (e) { j = null; }
  return { status: res.status, text: txt, json: j };
}

/**
 * 拉微众 App 端口的全量产品信息（210 字段）
 * @param {string} code 产品代码，如 NYJXLD1409G
 * @param {{transport?:Function}} opts
 * @returns {Promise<{retCode:string, raw:object|null, content:object|null}>}
 */
export async function webankProductInfo(code, opts = {}) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return { retCode: "", raw: null, content: null };
  const r = await httpJson(WB_HOST + WB_INFO_PATH, {
    method: "POST",
    headers: {
      "user-agent": WB_UA,
      "content-type": "application/json",
      accept: "*/*",
    },
    body: JSON.stringify({ productInfoList: [{ name: c }] }),
  }, opts.transport);
  const j = r.json || {};
  const retCode = String(j.ret_code || "");
  const item = (j.ret_data && Array.isArray(j.ret_data.productInfoList)) ? j.ret_data.productInfoList[0] : null;
  if (!item) return { retCode, raw: j, content: null };
  let content = null;
  try { content = typeof item.content === "string" ? JSON.parse(item.content) : (item.content || null); } catch (e) { content = null; }
  return { retCode, raw: j, content };
}

/**
 * 微众 App 端口历史净值序列（2026-10-19 突破，免登录）
 * POST https://personal.webank.com/wm-hjhtr/wm_product/history/query/stock_rates
 *   body {"prod_code":code, "start_date":"20200101", "end_date":"20991231"}  UA webank/9.5.2
 *   → 20350000, ret_data = { "YYYYMMDD": { unit_net_value, accu_net_value, ... }, ... }（升序）
 * 边界：必须 POST + 起止日期；GET 或只给 prod_code 无日期均 21600054 失败；
 *      未收录/假码 → ret_data={}（容错正常，返回 null）；宽区间不截断。
 * @param {string} code 产品代码，如 NYCF000010
 * @param {{transport?:Function}} opts
 * @returns {Promise<Array<[string, number]>|null>}  [[YYYY-MM-DD, unit_net_value], ...]（升序）或 null
 */
export async function webankAppNavHistory(code, opts = {}) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  const r = await httpJson(WB_HOST + WB_NAV_HISTORY_PATH, {
    method: "POST",
    headers: {
      "user-agent": WB_UA,
      "content-type": "application/json",
      accept: "*/*",
    },
    body: JSON.stringify({ prod_code: c, start_date: "20200101", end_date: "20991231" }),
  }, opts.transport);
  const j = r.json || {};
  if (String(j.ret_code || "") !== WB_OK) return null;
  const rd = j.ret_data;
  if (!rd || typeof rd !== "object") return null;
  const list = Object.keys(rd)
    .map((k) => {
      const d = ymd(k);
      const rec = rd[k] && typeof rd[k] === "object" ? rd[k] : null;
      const v = rec ? Number(rec.unit_net_value) : NaN;
      return d && Number.isFinite(v) ? [d, v] : null;
    })
    .filter(Boolean)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return list.length ? list : null;
}

/**
 * 微众 App 端口抓取
 * @param {string} code
 * @param {{transport?:Function, infoOnly?:boolean, probe?:boolean}} opts
 *   infoOnly=true 只取信息（不构造 series）；probe=true 额外探测净值历史接口的拒绝码（诊断用）
 */
export async function webankAppFetch(code, opts = {}) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  const t0 = Date.now();
  // 2026-10-22 拆分：navOnly=true 只抓净值——跳过 productinfo（信息接口），直取历史净值序列
  if (opts.navOnly) {
    const hist = await webankAppNavHistory(c, opts).catch(() => null);
    const series = (hist && hist.length) ? hist : [];
    const last = series.length ? series[series.length - 1] : null;
    return {
      name: null, shortName: null, manager: null, taCode: null,
      established: null, maturity: null, risk: null, holdDays: null,
      regCode: null, benchmark: null,
      latestNav: last ? last[1] : null, netvalueDate: last ? last[0] : null,
      totalAmount: null, quotaTotal: null, minFirstAmount: null, feeRate: null, discountFeeRate: null,
      series, kind: "nav", navBasis: "nav", partial: series.length < 2, navNote: null,
      source: "live", bank: "webank", navVia: "webank", navPort: "app", ms: Date.now() - t0,
    };
  }
  const { retCode, content } = await webankProductInfo(c, opts);
  if (!content) {
    // ret_code=20350000 但 productInfoList 为空 = 微众没收录这个码（不是接口故障）
    return { error: retCode === WB_OK ? "product-not-found" : ("ret_code=" + (retCode || "?")), code: c, ms: Date.now() - t0 };
  }

  const name = content.prod_full_name || content.prod_name || c;
  const manager = content.company_name || content.org_name || null;
  const established = ymd(content.establish_date);
  const navDate = ymd(content.income_update_date) || ymd(content.net_value_date);
  const navVal = Number(content.net_value != null ? content.net_value : content.total_netvalue);
  const latestNav = Number.isFinite(navVal) && navVal > 0 ? navVal : null;

  const rate = Array.isArray(content.rate_item_list) && content.rate_item_list[0] ? content.rate_item_list[0] : null;
  const firstBuy = content.start_buy_amount && Number(content.start_buy_amount.first_buy);

  // 历史净值序列（2026-10-19 突破）：App 端口可免登录直取全量；失败再回落最新单点。
  // infoOnly=true 时跳过（fetchMeta 只补信息字段，不重复拉序列）。
  let navSeries = [];
  let navNote = null;
  if (!opts.infoOnly) {
    const hist = await webankAppNavHistory(c, opts).catch(() => null);
    if (hist && hist.length) {
      navSeries = hist;
      navNote = "微众 App 端口历史净值序列（POST " + WB_NAV_HISTORY_PATH + "，全量 " + hist.length + " 点）";
    } else if (latestNav && navDate) {
      navSeries = [[navDate, latestNav]];
      navNote = "微众 App 端口仅取到最新净值单点（历史序列接口未返回）";
    }
  }

  const out = {
    name,
    shortName: content.prod_name || null,
    manager,
    taCode: content.ta_code || null,
    established,
    maturity: ymd(content.maturity_date),
    risk: riskText(content.risk_level),
    holdDays: termDays(content),
    regCode: null,          // 微众 App 端口的 210 字段里**没有**理财登记编码（已全字段扫描确认）
    benchmark: null,        // 同上，也没有业绩比较基准（fin_performance 恒为空）
    latestNav,
    netvalueDate: navDate,
    totalAmount: Number(content.total_amount) || null,
    quotaTotal: Number(content.quota_total) || null,
    minFirstAmount: Number.isFinite(firstBuy) && firstBuy > 0 ? firstBuy : null,
    feeRate: rate && rate.original_fee_rate != null ? String(rate.original_fee_rate) : null,
    discountFeeRate: rate && rate.discount_fee_rate != null ? String(rate.discount_fee_rate) : null,
    // 净值序列：2026-10-19 起 App 端口可免登录直取全量（见上方 webankAppNavHistory）
    series: navSeries,
    kind: "nav",
    navBasis: "nav",
    partial: navSeries.length < 2,
    navNote,
    source: "live",
    bank: "webank",
    navVia: "webank",
    navPort: "app",
    ms: Date.now() - t0,
  };

  if (opts.probe) out.probe = await webankProbeNavHistory(c, opts).catch(() => null);
  return out;
}

/**
 * 净值历史接口探测（诊断用）：复核各候选端点状态
 *   · 第 1 条 = 2026-10-19 打通的 POST 聚合网关（应回 20350000 + 全序列）
 *   · 后 4 条 = 2026-10-17 误判的旧候选（wm-pqs / wm-htrserver，恒回拒绝码，已弃用）
 * @returns {Promise<Array<{url:string, code:string, note:string}>>}
 */
export async function webankProbeNavHistory(code, opts = {}) {
  const c = String(code || "").trim().toUpperCase();
  const body = JSON.stringify({ prod_code: c, start_date: "20200101", end_date: "20991231" });
  const urls = [
    { url: WB_HOST + WB_NAV_HISTORY_PATH, method: "POST", headers: { "user-agent": WB_UA, "content-type": "application/json", accept: "*/*" }, body },
    { url: WB_HOST + "/wm-hjhtr/wm-pqs/query/ta/stock_rates?prod_code=" + c + "&start_date=20240101&end_date=20991231", method: "GET" },
    { url: WB_HOST + "/wm-hjhtr/wm-pqs/history/query/finance/stock_rates?prod_code=" + c + "&start_date=20240101&end_date=20991231", method: "GET" },
    { url: WB_HOST + "/wm-htrserver/finance/wm_pqs/paging_query_fund_nav_history?prod_code=" + c + "&page_size=100&sort_type=desc", method: "GET" },
    { url: WB_HOST + "/wm-htrserver/finance/wm_pqs/query_finance_trend_chart_list?prod_code=" + c + "&ladder_type=month", method: "GET" },
  ];
  const out = [];
  for (const u of urls) {
    try {
      const r = await httpJson(u.url, {
        method: u.method,
        headers: u.headers || { "user-agent": WB_UA, accept: "*/*" },
        ...(u.body ? { body: u.body } : {}),
      }, opts.transport);
      const code2 = r.json ? String(r.json.ret_code || "") : "";
      let note = "";
      if (code2 === WB_OK) {
        const rd = r.json && r.json.ret_data;
        const n = rd && typeof rd === "object" ? Object.keys(rd).length : 0;
        note = "可用" + (n ? "（全序列 " + n + " 点）" : "");
      } else {
        note = (r.json && r.json.ret_msg) || "";
      }
      out.push({ url: u.url.replace(WB_HOST, ""), code: code2 || ("HTTP " + r.status), note });
    } catch (e) {
      out.push({ url: u.url.replace(WB_HOST, ""), code: "THROW", note: (e && e.message) || String(e) });
    }
  }
  return out;
}

/**
 * 广发银行 App 端口（wap.cgbchina.com.cn · MDP/H5 网关）
 * 用途：按产品代码取「七字段」——产品全称 / 净值序列 / 最短持有期 / 风险等级 / 登记编码 / 成立日 / 业绩比较基准
 *
 * 关键结论（2026-10-16 实测打通）：
 *  1. 详情页 /mdp/hmba/investment/self/detail 是 Vue SPA，本身不含数据；
 *     页面会下发 MDP_A_KEY / MDP_G_KEY cookie，**MDP_A_KEY 就是网关会话号 mpSId**（放在 body.header.mpSId）。
 *  2. 网关：POST https://wap.cgbchina.com.cn/h5-mobilebank-app/noSessionServlet/hbss/<svc>.lgx
 *     body = { header:{senderSN,os,bizScene,channel,scope,mpSId}, body:{...} }
 *     必备请求头：Tcom-trxChanAppCode=O02HMBA / Tcom-trxTrgRoleCode=1 /
 *                Tcom-trxSrcSysCode=HMBA_WECHAT0000000000000 / Tcom-equipId=<任意> / senderSN=<时间戳+名+随机>
 *     全部为免登录接口，无需签名、无需登录态。
 *  3. 接口分工：
 *     mps005billquery.lgx  shortCode+flowNo → tradeData 竖线串，内含 prdCode（分享链 → 产品代码）
 *     fn10025.lgx          prdCode → 产品全量信息（133 字段：名称/风险等级/最短持有/成立日/基准/最新净值）
 *     fn10003.lgx          prdCode+beginNum+fetchNum → 净值分页（totalNum 即总点数，含 navFloatRate 日涨跌）
 *     fn10008.lgx          prdCode+beginDate+endDate(8位) → 净值曲线（nAVProductInfoList，含 max/minNAV）
 *     fn20004.lgx          prdCode+fileType(0 风险揭示书 / 2 产品说明书) → PDF 路径
 *                          ⚠ 按用户规则（2026-10-16）**不从该 PDF 解析任何产品信息**，仅取 URL 备查
 *     fn20001.lgx          prdCode → 公告列表（fileTittle/issDate/icppUrl）
 *     qryfinproductstageperfrangedata.lgx  prodCode → 近1月/近3月/成立至今 年化收益
 *  4. 代销产品限制：净值只保留本渠道在售期间的点数（本例 36 点，2026-08-19 起），不会给到发行方全历史。
 *  5. 登记编码不在 fn10025 里，且不从说明书 PDF 抠 → 本模块 regCode 恒为空；需要登记编码走 worker.js
 *     fetchMeta 的中国理财网兜底（/api/meta）。
 */

const HOST = "https://wap.cgbchina.com.cn";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.40";
const TRX = {
  "Tcom-trxChanAppCode": "O02HMBA",
  "Tcom-trxTrgRoleCode": "1",
  "Tcom-trxSrcSysCode": "HMBA_WECHAT0000000000000",
  "Tcom-equipId": "2026101612345678901234567890",
};

const senderSN = (name) => (String(Date.now()) + name.substring(1, 5) + Math.floor(1e4 * Math.random())).substring(0, 30);

class CgbSession {
  constructor() { this.jar = new Map(); this.mpSId = ""; this.bizScene = "/mdp/hmba/investment/self/detail"; }
  cookie() { return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; "); }
  absorb(res) {
    for (const c of (res.headers.getSetCookie?.() || [])) {
      const [kv] = c.split(";"); const i = kv.indexOf("=");
      if (i > 0) this.jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  }
  /** 打开详情页拿 MDP_A_KEY 作为 mpSId */
  async open({ flowNo = "", shortCode = "N" } = {}) {
    const qs = new URLSearchParams();
    if (flowNo) qs.set("flowNo", flowNo);
    if (shortCode) qs.set("shortCode", shortCode);
    const res = await fetch(`${HOST}/mdp/hmba/investment/self/detail?${qs}`, { headers: { "User-Agent": UA } });
    this.absorb(res);
    await res.text();
    this.mpSId = this.jar.get("MDP_A_KEY") || "";
    return this.mpSId;
  }
  async call(svc, body = {}) {
    const s = senderSN(svc);
    const res = await fetch(`${HOST}/h5-mobilebank-app/noSessionServlet/hbss/${svc}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=utf-8",
        senderSN: s, ...TRX,
        "User-Agent": UA,
        Accept: "application/json, text/plain, */*",
        Origin: HOST,
        Referer: `${HOST}/mdp/hmba/investment/self/detail`,
        Cookie: this.cookie(),
      },
      body: JSON.stringify({
        header: { senderSN: s, os: "iPhone", bizScene: this.bizScene, channel: "MB", scope: "2", mpSId: this.mpSId },
        body,
      }),
    });
    this.absorb(res);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    const code = json?.header?.errorCode;
    if (code !== "0") {
      const err = new Error(`${svc} 失败 code=${code} msg=${json?.header?.errorMsg || text.slice(0, 120)}`);
      err.code = code; err.svc = svc;
      throw err;
    }
    return json.body || {};
  }
}

const ymd = (s) => (s && /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s || "");

/** 分享链 flowNo → 产品代码（同时带出渠道/追踪号） */
export async function resolveFlow(flowNo, shortCode = "N") {
  const s = new CgbSession();
  await s.open({ flowNo, shortCode });
  const body = await s.call("mps005billquery.lgx", { shortCode, flowNo, srcChannel: "MB" });
  const kv = {};
  for (const seg of String(body.tradeData || "").split("|")) {
    const i = seg.indexOf("=");
    if (i > 0) kv[seg.slice(0, i)] = seg.slice(i + 1);
  }
  return { prdCode: kv.prdCode || "", mainChannel: kv.mainChannel || "", sChannel: kv.sChannel || "", traceFlowNo: kv.traceFlowNo || "", raw: kv, session: s };
}

/** 产品全量信息（fn10025 的 133 字段原样返回，另给常用字段中文映射） */
export async function fetchProductInfo(prdCode, session) {
  const s = session || new CgbSession();
  if (!s.mpSId) await s.open({});
  const ch = { channel: "400", sChannel: "WX" };
  const raw = await s.call("fn10025.lgx", { prdCode, intlFinaFlag: "", ...ch });
  return {
    raw,
    prdCode: raw.prdCode,
    name: raw.prdName,
    issuer: raw.prdManagerName,
    riskLevel: raw.riskLevel,                 // 1~5 → R1~R5
    minHoldDays: Number(raw.sharedetailMinHold || 0),
    openDesc: raw.investmentCycleDesc || "",
    estabDate: ymd(raw.estabDate),
    endDate: ymd(raw.endDate),
    benchmark: raw.perforMark || "",
    benchmarkDesc: raw.benchMarkRateExp || "",
    latestNAV: raw.nAV,
    latestNAVDate: ymd(raw.nAVDate || raw.newRateDate),
    totalNAV: raw.totNAV,
    shareClass: raw.shareClass,
    status: raw.status,
  };
}

const ymdCompact = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

/**
 * 净值序列（fn10003 分页）
 * 注意：beginDate/endDate 跨度不得超过 1 年，故按年窗口逐段取，窗口内再按 beginNum 翻页。
 */
export async function fetchNAV(prdCode, session, { beginDate = "", pageSize = 200 } = {}) {
  const s = session || new CgbSession();
  if (!s.mpSId) await s.open({});
  const ch = { channel: "400", sChannel: "WX" };
  const today = new Date();
  // 起点：产品成立日优先，否则回看 3 年
  let cursor = beginDate ? new Date(`${ymd(beginDate)}T00:00:00`) : new Date(today.getFullYear() - 3, today.getMonth(), today.getDate());
  if (isNaN(cursor.getTime())) cursor = new Date(today.getFullYear() - 3, today.getMonth(), today.getDate());
  const out = [];
  for (let guard = 0; guard < 12; guard++) {
    if (cursor > today) break;
    const winEnd = new Date(Math.min(new Date(cursor.getFullYear() + 1, cursor.getMonth(), cursor.getDate() - 1).getTime(), today.getTime()));
    const b = ymdCompact(cursor), e = ymdCompact(winEnd);
    let page = await s.call("fn10003.lgx", { prdCode, beginNum: 0, fetchNum: pageSize, beginDate: b, endDate: e, ...ch });
    let list = (page.list || []).slice();
    const total = Number(page.totalNum || 0);
    while (list.length < total) {
      page = await s.call("fn10003.lgx", { prdCode, beginNum: list.length, fetchNum: pageSize, beginDate: b, endDate: e, ...ch });
      const got = page.list || [];
      if (!got.length) break;
      list = list.concat(got);
    }
    out.push(...list);
    cursor = new Date(winEnd.getFullYear(), winEnd.getMonth(), winEnd.getDate() + 1);
  }
  const seen = new Set();
  return out
    .map((x) => ({ date: ymd(x.nAVDate), nav: Number(x.nAV), totalNAV: Number(x.totalNAV), chg: x.navFloatRate }))
    .filter((x) => (seen.has(x.date) ? false : seen.add(x.date)))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** 阶段收益（近1月 / 近3月 / 成立至今） */
export async function fetchStagePerf(prdCode, session) {
  const s = session || new CgbSession();
  if (!s.mpSId) await s.open({});
  const body = await s.call("qryfinproductstageperfrangedata.lgx", { prodCode: prdCode, prodType: "FINA" });
  return (body.details || []).map((d) => ({ name: d.dateAreaName, rate: Number(d.yieldRate), beg: ymd(d.yieldBegDate), end: ymd(d.yieldEndDate) }));
}

/** 产品文件：0=风险揭示书 2=产品说明书（登记编码在说明书首页） */
export async function fetchDocs(prdCode, session) {
  const s = session || new CgbSession();
  if (!s.mpSId) await s.open({});
  const ch = { channel: "400", sChannel: "WX" };
  const out = {};
  for (const [key, fileType] of [["spec", "2"], ["risk", "0"]]) {
    try {
      const d = await s.call("fn20004.lgx", { prdCode, fileType, ...ch });
      out[key] = { url: `${d.icppFileOuturl || "https://static.95508.com/cgbstatic"}${d.icppUrl || ""}`, pages: Number(d.totalPages || 0), fileName: d.fileName };
    } catch (e) { out[key] = { error: e.message }; }
  }
  try {
    const n = await s.call("fn20001.lgx", { prdCode, openType: "0", fileType: "0", orderFlag: "0", beginNum: 0, fetchNum: 10, ...ch });
    out.notices = (n.noticeFileInfoList || []).map((x) => ({ title: x.fileTittle, date: ymd(x.issDate), url: `${x.icppFileOuturl || ""}${x.icppUrl || ""}` }));
  } catch { out.notices = []; }
  return out;
}

/** 一站式：给 prdCode（或 flowNo）拿七字段 */
export async function cgbAppFetch({ prdCode = "", flowNo = "", shortCode = "N" } = {}) {
  const s = new CgbSession();
  await s.open({ flowNo, shortCode });
  let code = prdCode;
  let flow = null;
  if (!code) {
    flow = await s.call("mps005billquery.lgx", { shortCode, flowNo, srcChannel: "MB" });
    const kv = {};
    for (const seg of String(flow.tradeData || "").split("|")) { const i = seg.indexOf("="); if (i > 0) kv[seg.slice(0, i)] = seg.slice(i + 1); }
    code = kv.prdCode || "";
  }
  const info = await fetchProductInfo(code, s);
  const nav = await fetchNAV(code, s, { beginDate: info.raw?.estabDate || "" });
  const stage = await fetchStagePerf(code, s).catch(() => []);
  const docs = await fetchDocs(code, s);
  // 用户规则（2026-10-16）：产品信息含登记编码一律不从说明书 PDF 解析 → 这里恒为空串，
  // 登记编码请由 worker.js 的 fetchMeta 通用兜底走中国理财网补齐。
  const regCode = "";
  return {
    source: "cgb-app",
    prdCode: code,
    name: info.name,
    issuer: info.issuer,
    riskLevel: info.riskLevel ? `R${info.riskLevel}` : "",
    minHoldDays: info.minHoldDays,
    openDesc: info.openDesc,
    estabDate: info.estabDate,
    endDate: info.endDate,
    benchmark: info.benchmark,
    latestNAV: info.latestNAV,
    latestNAVDate: info.latestNAVDate,
    navCount: nav.length,
    navRange: nav.length ? `${nav[0].date} → ${nav.at(-1).date}` : "",
    nav,
    stagePerf: stage,
    regCode,
    docs,
    raw: { product: info.raw },
  };
}

// CLI: node scrape/cgb_app.mjs <flowNo|prdCode> [shortCode]
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("cgb_app.mjs")) {
  const arg = process.argv[2] || "";
  const short = process.argv[3] || "N";
  const isFlow = /^[A-Z]{4}[0-9A-F]{16,}$/i.test(arg);
  const out = await cgbAppFetch(isFlow ? { flowNo: arg, shortCode: short } : { prdCode: arg, shortCode: short });
  console.log(JSON.stringify({ ...out, raw: undefined }, null, 2));
}

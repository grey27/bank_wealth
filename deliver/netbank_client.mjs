// ============================================================================
//  网商银行（mybank.cn）服务器端取数客户端 —— 无人值守 / 不依赖手机 / 不依赖登录态
// ----------------------------------------------------------------------------
//  能力：
//   · 服务器端离线复刻支付宝 JShield(APSign) 签名（headless Chrome + 内嵌 WASM）
//   · 完整还原网商 mgw 四条通道的网关 / appid / 头集合 / 请求体形态
//   · 免登录通道可对「任意产品码」取回产品销售文件（说明书/风险揭示书/权益须知/
//     投资协议书/调整公告）
//
//  通道矩阵（均已实测复现）：
//   ① MyBankH5Main  bkmobilegw + appid 34324491   x-data=md5(body) + x-sign=APSign("MyBankH5Main",tok,md5)
//   ② MobileCore    bkmobilegw + appid 34324491   x-sign=APSign("MybankH5",tok,obj) + ts
//   ③ WechatCore    mobilegw   + appid 35033653   x-sign=APSign("WECHAT_TINY_H5_MYBANK",tok,obj) + ts
//   ④ App 原生      bkmobilegw + appid 23387407   sign + ts（SecurityGuard，服务端暂不可复现）
//
//  已知网关语义：
//   1000 成功 | 2000 登录超时（该 op 需网商会话）| 3000 op 未部署 | 7001 参数不合法
//   7002 验签失败 | 7007 缺 ts | 7014 加签数据为空
// ============================================================================
import crypto from "node:crypto";
import { apSign, apSignJson, apSignValue } from "./jshield_client.mjs";

export const BIZ_TOKEN = "W3g6PvhSk11pFCmtGKQWavpk";

export const CHANNELS = {
  // 网商自有网关 · 网商 H5（唯一实测免登录可用）
  h5: {
    gateway: "https://bkmobilegw.mybank.cn/mgw.htm",
    appid: "34324491",
    productId: "MYBANK_MOBILE_BROWSER",
    xCors: "X-CORS-34324491-default",
    signMode: "md5",
    signApp: "MyBankH5Main",
  },
  // 网商 App 内嵌 H5
  mobileCore: {
    gateway: "https://bkmobilegw.mybank.cn/mgw.htm",
    appid: "34324491",
    productId: "MYBANK_MOBILE_BROWSER",
    xCors: "X-CORS-34324491-default",
    signMode: "obj",
    signApp: "MybankH5",
  },
  // 微信 H5 / 支付宝域
  wechat: {
    gateway: "https://mobilegw.mybank.cn/mgw.htm",
    appid: "35033653",
    productId: null,
    xCors: "x-cors-35033653-default",
    signMode: "obj",
    signApp: "WECHAT_TINY_H5_MYBANK",
  },
};

const md5 = (s) => crypto.createHash("md5").update(s, "utf8").digest("hex");

const UA =
  "Mozilla/5.0 (Linux; Android 13; SM-S918B Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 AliApp(BK/10.5.0)";

// cookie jar（网关会下发 Set-Cookie，H5 通道 credentials:"include"）
const jar = new Map();
function cookieHeader() {
  if (!jar.size) return "";
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
function absorb(res) {
  const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const c of raw) {
    const kv = c.split(";")[0];
    const i = kv.indexOf("=");
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
  return raw;
}

/**
 * 统一 RPC
 * @param {string} operationType  网商 operationType
 * @param {object} requestData    业务参数（会被包成数组作为 body）
 * @param {object} opts
 *   channel: 'h5' | 'mobileCore' | 'wechat'
 *   timeout, h5appid, chInfo, extraHeaders, dropSign
 */
export async function rpc(operationType, requestData, opts = {}) {
  const {
    channel = "h5",
    timeout = 20000,
    h5appid = "66666708",
    chInfo = "APP_NO_LOGIN",
    extraHeaders = {},
    dropSign = false,
    useCookie = true,
  } = opts;
  const ch = CHANNELS[channel];
  if (!ch) throw new Error("unknown channel: " + channel);

  const dataStr = JSON.stringify(requestData);
  const headers = {
    "content-type": "application/json",
    appid: ch.appid,
    "operation-type": operationType,
    "X-CORS-34324491-default": "1",
    origin: "https://render.mybank.cn",
    referer: "https://render.mybank.cn/",
    "user-agent": UA,
    ...extraHeaders,
  };
  if (ch.productId) headers.productId = ch.productId;
  headers[ch.xCors] = "1";
  if (h5appid) headers.h5appid = h5appid;
  if (chInfo) headers.chInfo = chInfo;

  if (!dropSign) {
    if (ch.signMode === "md5") {
      const xdata = md5(dataStr);
      headers["x-data"] = xdata;
      headers["x-sign"] = await apSign(xdata, ch.signApp, BIZ_TOKEN);
    } else {
      headers["x-sign"] = await apSignValue(requestData, ch.signApp, BIZ_TOKEN);
      headers.ts = String(Date.now());
    }
  }
  if (useCookie) {
    const ck = cookieHeader();
    if (ck) headers.cookie = ck;
  }

  const res = await fetch(ch.gateway, {
    method: "POST",
    headers,
    body: JSON.stringify([requestData]),
    signal: AbortSignal.timeout(timeout),
  });

  const setCookies = absorb(res);
  const text = await res.text();
  const rs = res.headers.get("Result-Status") || res.headers.get("result-status") || "";
  const memo = res.headers.get("memo") || "";
  const tips = res.headers.get("tips") || "";
  const traceId = res.headers.get("mgw-traceid") || res.headers.get("Mgw-TraceId") || "";
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return {
    channel, op: operationType, httpStatus: res.status, rs, memo, tips, traceId,
    setCookies, ok: rs === "1000", data, text,
  };
}

// ---------------------------------------------------------------------------
//  免登录能力：取任意产品码的产品销售文件（实测 1000）
// ---------------------------------------------------------------------------
export const OP_QUERY_PROFILES =
  "com.mybank.bkfundterm.biz.mobile.service.FundProductService.queryFundProfiles";

export const OP_DECISION_PAGE =
  "com.mybank.bkfundprod.biz.mobile.service.bff.PageDecisionFacade.decisionPageView";

export const OP_DECISION_PAGE_NOAUTH =
  "com.mybank.bkfundprod.biz.mobile.service.bff.PageDecisionFacade.decisionPageViewWithoutAuth";

/** 免登录取产品销售文件 */
export async function fetchProductProfile(fundCode, opts = {}) {
  const r = await rpc(OP_QUERY_PROFILES, { fundCode }, { channel: "h5", ...opts });
  return r;
}

/** 拉取 BFF 页面数据（含净值字段 netAssetValInfoResultList）—— 需网关侧允许 */
export async function fetchDecisionPage(pageFlag, busiCmd, opts = {}) {
  const params = { pageFlag, busiCmd: { ...busiCmd, extInfo: { isJumpApp: "0", originChannel: "2000", currentChannel: "2000" } } };
  return rpc(OP_DECISION_PAGE, params, { channel: "h5", ...opts });
}

export function cookies() { return Object.fromEntries(jar); }
export function clearCookies() { jar.clear(); }

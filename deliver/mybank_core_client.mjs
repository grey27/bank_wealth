// 网商 WechatCoreStrategy 高保真复刻（直连 mobilegw / bkmobilegw，无需容器、无需登录态）
//
// 还原自 yuyan2/main-vendors.ee0e0c071.js 模块 13599 的 At 类（WechatCoreStrategy）：
//   getHeader:
//     { "content-type":"application/json", "operation-type":op,
//       appkey:"35033653", appid:"35033653", "x-cors-35033653-default":1,
//       authority:<网关主机名>, authorization:"x-sid <sid>", did, ... }
//   request:
//     v = yt(data)                     // 深拷贝 + 空对象补 xapiDefaultField
//     y = mt(v)                        // 深拷贝
//     g = APSign.getSign("WECHAT_TINY_H5_MYBANK","W3g6PvhSk11pFCmtGKQWavpk", y)
//     headers["x-sign"]=g["x-sign"]; headers.ts=Date.now()
//     url = gateway + "?operationType=" + op
//     body = Array.isArray(v)?v:[v]
import { apSignJson } from "./jshield_client.mjs";

export const BIZ_TOKEN = "W3g6PvhSk11pFCmtGKQWavpk";
export const SIGN_APP = "WECHAT_TINY_H5_MYBANK";
export const APPKEY = "35033653";

export const GATEWAYS = {
  mobilegw: "https://mobilegw.mybank.cn/mgw.htm",
  bkmobilegw: "https://bkmobilegw.mybank.cn/mgw.htm",
};

/** yt(): 深拷贝 + 空对象补 xapiDefaultField（模块 13599 原文还原） */
export function yt(data) {
  const t = deepClone(data) || {};
  if (typeof t !== "object" || Array.isArray(t)) return t;
  (function walk(o) {
    if (isEmptyObj(o)) {
      o.xapiDefaultField = Date.now().toString();
      return;
    }
    for (const k in o) {
      const v = o[k];
      if (v && typeof v === "object" && !Array.isArray(v)) walk(v);
    }
  })(t);
  return t;
}

function isEmptyObj(o) {
  return o !== null && o !== undefined && typeof o === "object" && Object.keys(o).length === 0;
}
function deepClone(e, seen = new WeakMap()) {
  if (e === null || typeof e !== "object") return e;
  if (e instanceof Date) return new Date(e.getTime());
  if (e instanceof RegExp) return new RegExp(e);
  if (e instanceof Map) return new Map([...e.entries()].map(([k, v]) => [deepClone(k, seen), deepClone(v, seen)]));
  if (e instanceof Set) return new Set([...e.values()].map((v) => deepClone(v, seen)));
  if (Array.isArray(e)) return e.map((v) => deepClone(v, seen));
  if (seen.has(e)) return seen.get(e);
  const n = Array.isArray(e) ? [] : {};
  seen.set(e, n);
  for (const r in e) if (Object.prototype.hasOwnProperty.call(e, r)) n[r] = deepClone(e[r], seen);
  return n;
}

export async function coreRpc(operationType, requestData, opts = {}) {
  const {
    gateway = GATEWAYS.mobilegw,
    appkey = APPKEY,
    signApp = SIGN_APP,
    bizToken = BIZ_TOKEN,
    sessionId = "",
    userId = "",
    apdidToken = "",
    openId = "",
    did = "",
    extraHeaders = {},
    timeout = 20000,
    dropSign = false,
    dropTs = false,
    withQuery = true,
  } = opts;

  const v = yt(requestData || {});
  const authority = gateway.replace(/^https?:\/\//, "").replace(/\/.*$/, "");

  const headers = {
    "content-type": "application/json",
    "operation-type": operationType,
    appkey,
    appid: appkey,
    ["x-cors-" + appkey + "-default"]: 1,
    authority,
    authorization: sessionId ? `x-sid ${sessionId}` : "x-sid",
    did: did || "",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "cross-site",
    "x-janus-wx-sign": "1",
    origin: "https://render.mybank.cn",
    referer: "https://render.mybank.cn/",
    "user-agent":
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.40",
    ...extraHeaders,
  };
  if (userId) headers.wxbkuid = userId;
  if (apdidToken) headers.apdidtoken = apdidToken;
  if (openId) headers.openid = openId;

  if (!dropSign) {
    // APSign 接收对象；此处传 JSON 文本，签名器会求值为 JS 对象
    headers["x-sign"] = await apSignJson(JSON.stringify(v), signApp, bizToken);
    if (!dropTs) headers.ts = String(Date.now());
  }

  const url = withQuery ? `${gateway}?operationType=${encodeURIComponent(operationType)}` : gateway;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(Array.isArray(v) ? v : [v]),
    signal: AbortSignal.timeout(timeout),
  });

  const text = await res.text();
  const rs = res.headers.get("Result-Status") || res.headers.get("result-status") || "";
  const memo = res.headers.get("memo") || "";
  const tips = res.headers.get("tips") || "";
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { httpStatus: res.status, rs, memo, tips, ok: rs === "1000", data, text };
}

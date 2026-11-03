// 中信银行「净值」直连抓取（双端：Node + Cloudflare Workers 均可用）
//
// 端点：https://wap.bank.ecitic.com/NMBFOServer/api.do?act=<ACT>&isWeb=1  (POST JSON)
// 逆向来源：手机银行 H5 分享类接口（pg.share-new.financial chunk）
//   · 握手   PEMBPKQY  -> 返回 MODULUS / PUBLICEXPONENT（服务端 RSA 公钥，十进制）
//   · 反查   PEMBFIPL  -> 只传 PRDCODE 即命中，回带正确 TACODE + PRDNAME（名称兜底）
//   · 详情   PENFPDQR  -> 产品名称 / 风险 / 最新净值（business 明文）
//   · 历史   PENFHNLC  -> 成立以来净值序列（SECTIONTYPID=999）
//
// ⚠ TACODE 陷阱（2026-10-15，AF264829A 修复）：TACODE 不是产品码前缀。
//   AF 系列（慧盈象/慧盈等）TACODE="YZX"；EW 系列 TACODE 恰=="EW"故旧版碰巧能用。
//   错 TACODE → PENF045「查询不到该产品」。故必须先 PEMBFIPL 反查再查详情/历史。
//
// 请求体加密（与 app.js 1:1 复刻）：
//   dataKey  = 24 字节随机可打印串（utf8）
//   business = 3DES-ECB-PKCS7( utf8( encodeURI(JSON.stringify(params)) ), key=dataKey )
//   key      = RSAES-PKCS1-V1_5( utf8(dataKey), serverPubKey )
//   发送体   = { dataPackage: { business, key } }
//   响应 dataPackage.business 为明文 JSON（分享类接口不加密响应）。
//
// 依赖：仅 Web Crypto（globalThis.crypto.subtle，Node/Worker 均有）+ fetch + 纯 JS 3DES-ECB。
//   无任何 Node 专属 API / eval，故可随 worker.js 一起打包进 Worker。

/* ============================ 纯 JS 3DES-ECB (PKCS7) ============================ */
const IP = [58,50,42,34,26,18,10,2,60,52,44,36,28,20,12,4,62,54,46,38,30,22,14,6,64,56,48,40,32,24,16,8,57,49,41,33,25,17,9,1,59,51,43,35,27,19,11,3,61,53,45,37,29,21,13,5,63,55,47,39,31,23,15,7];
const FP = [40,8,48,16,56,24,64,32,39,7,47,15,55,23,63,31,38,6,46,14,54,22,62,30,37,5,45,13,53,21,61,29,36,4,44,12,52,20,60,28,35,3,43,11,51,19,59,27,34,2,42,10,50,18,58,26,33,1,41,9,49,17,57,25];
const EBIT = [32,1,2,3,4,5,4,5,6,7,8,9,8,9,10,11,12,13,12,13,14,15,16,17,16,17,18,19,20,21,20,21,22,23,24,25,24,25,26,27,28,29,28,29,30,31,32,1];
const PPERM = [16,7,20,21,29,12,28,17,1,15,23,26,5,18,31,10,2,8,24,14,32,27,3,9,19,13,30,6,22,11,4,25];
const PC1 = [57,49,41,33,25,17,9,1,58,50,42,34,26,18,10,2,59,51,43,35,27,19,11,3,60,52,44,36,63,55,47,39,31,23,15,7,62,54,46,38,30,22,14,6,61,53,45,37,29,21,13,5,28,20,12,4];
const PC2 = [14,17,11,24,1,5,3,28,15,6,21,10,23,19,12,4,26,8,16,7,27,20,13,2,41,52,31,37,47,55,30,40,51,45,33,48,44,49,39,56,34,53,46,42,50,36,29,32];
const ROT = [1,1,2,2,2,2,2,2,1,2,2,2,2,2,2,1];
const SBOX = [
  [[14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7],[0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8],[4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0],[15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13]],
  [[15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10],[3,13,4,7,15,2,8,14,12,0,1,10,6,9,11,5],[0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15],[13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9]],
  [[10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8],[13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1],[13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7],[1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12]],
  [[7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15],[13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9],[10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4],[3,15,0,6,10,1,13,8,9,4,5,11,12,7,2,14]],
  [[2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9],[14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6],[4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14],[11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3]],
  [[12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11],[10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8],[9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6],[4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13]],
  [[4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1],[13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6],[1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2],[6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12]],
  [[13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7],[1,15,13,8,10,3,7,4,12,5,6,11,0,14,9,2],[7,11,4,1,9,12,14,2,0,6,10,13,15,3,5,8],[2,1,14,7,4,10,8,13,15,12,9,0,3,5,6,11]],
];

function permute(bits, table) {
  const out = new Array(table.length);
  for (let i = 0; i < table.length; i++) out[i] = bits[table[i] - 1];
  return out;
}
function xorBits(a, b) {
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}
function bytesToBits(bytes) {
  const out = new Array(bytes.length * 8);
  for (let i = 0; i < bytes.length; i++) {
    for (let j = 0; j < 8; j++) out[i * 8 + j] = (bytes[i] >> (7 - j)) & 1;
  }
  return out;
}
function bitsToBytes(bits) {
  const n = bits.length / 8;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j];
    out[i] = v;
  }
  return out;
}
function sboxSub(x48) {
  const out = new Array(32);
  for (let i = 0; i < 8; i++) {
    const grp = x48.slice(i * 6, i * 6 + 6);
    const row = (grp[0] << 1) | grp[5];
    const col = (grp[1] << 3) | (grp[2] << 2) | (grp[3] << 1) | grp[4];
    const val = SBOX[i][row][col];
    for (let b = 0; b < 4; b++) out[i * 4 + b] = (val >> (3 - b)) & 1;
  }
  return out;
}
function desSubkeys(key8) {
  const kbits = bytesToBits(key8);
  const k56 = permute(kbits, PC1);
  let c = k56.slice(0, 28);
  let d = k56.slice(28, 56);
  const subs = [];
  for (let r = 0; r < 16; r++) {
    const rot = ROT[r];
    c = c.slice(rot).concat(c.slice(0, rot));
    d = d.slice(rot).concat(d.slice(0, rot));
    subs.push(permute(c.concat(d), PC2));
  }
  return subs;
}
function desOneBlock(block64, subkeys, decrypt) {
  const L0 = permute(block64, IP);
  let left = L0.slice(0, 32);
  let right = L0.slice(32, 64);
  const order = decrypt ? subkeys.slice().reverse() : subkeys;
  for (const k of order) {
    const exp = permute(right, EBIT);
    const x = xorBits(exp, k);
    const s = sboxSub(x);
    const p = permute(s, PPERM);
    const newRight = xorBits(left, p);
    left = right;
    right = newRight;
  }
  const pre = right.concat(left); // 末轮后再交换 -> R16||L16
  return permute(pre, FP);
}
function des3Ecb(dataBytes, key24, decrypt) {
  const k1 = key24.slice(0, 8), k2 = key24.slice(8, 16), k3 = key24.slice(16, 24);
  const s1 = desSubkeys(k1), s2 = desSubkeys(k2), s3 = desSubkeys(k3);
  // 加密：K1 加密 -> K2 解密 -> K3 加密；解密反向
  const seq = decrypt
    ? [[s3, true], [s2, false], [s1, true]]
    : [[s1, false], [s2, true], [s3, false]];
  let out = new Uint8Array(dataBytes.length);
  for (let off = 0; off < dataBytes.length; off += 8) {
    const block = bytesToBits(dataBytes.slice(off, off + 8));
    let cur = block;
    for (const [sk, dec] of seq) cur = desOneBlock(cur, sk, dec);
    out.set(bitsToBytes(cur), off);
  }
  return out;
}
function tdesEcbEncrypt(plainBytes, key24) {
  // PKCS7 填充到 8 的倍数
  const pad = 8 - (plainBytes.length % 8);
  const buf = new Uint8Array(plainBytes.length + pad);
  buf.set(plainBytes, 0);
  buf.fill(pad, plainBytes.length);
  return des3Ecb(buf, key24, false);
}
function tdesEcbDecrypt(cipherBytes, key24) {
  const out = des3Ecb(cipherBytes, key24, true);
  const pad = out[out.length - 1];
  return out.slice(0, out.length - (pad >= 1 && pad <= 8 ? pad : 0));
}

/* ============================ RSA / 网络 ============================ */
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function bytesToB64url(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = i + 1 < bytes.length ? bytes[i + 1] : 0, b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64URL[b0 >> 2];
    out += B64URL[((b0 & 3) << 4) | (b1 >> 4)];
    if (i + 1 < bytes.length) out += B64URL[((b1 & 15) << 2) | (b2 >> 6)]; else out += "=";
    if (i + 2 < bytes.length) out += B64URL[b2 & 63]; else out += "=";
  }
  return out.replace(/=+$/, "");
}
function decToB64url(decStr) {
  let bi = BigInt(decStr);
  let bytes = [];
  while (bi > 0n) { bytes.unshift(Number(bi & 0xffn)); bi >>= 8n; }
  if (bytes[0] & 0x80) bytes.unshift(0);
  return bytesToB64url(bytes);
}
function getRandomKey(n) {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let s = "";
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
async function getNodeCrypto() {
  try {
    if (typeof process === "undefined" || !process.versions || !process.versions.node) return null;
    const mod = await import("module");
    const createRequire = mod.createRequire;
    if (!createRequire) return null;
    return createRequire(import.meta.url)("node:crypto");
  } catch (e) { return null; }
}
// RSAES-PKCS1-v1.5 加密 dataKey：
//   · 本地 Node：用原生 crypto.publicEncrypt（此 Node 的 webcrypto 不支持 RSAES-PKCS1_V1_5）
//   · Workers：**纯 JS 自实现**（BigInt 模幂 + PKCS#1 v1.5 填充）——
//     ⚠ 2026-11-02 实测：Cloudflare Workers 的 Web Crypto **不支持 RSAES-PKCS1-V1_5**
//       （Unrecognized key import algorithm；连字符变体 "RSAES-PKCS1-v1_5" 同样不支持，
//        CF Web Crypto 只支持 RSA-OAEP）。故此腿在 Worker 上从未真正跑通，
//        表现为 citicDirectNav 恒 null、citic quota 恒 null（本地 Node 正常）。
//     本实现纯 BigInt、零依赖，Node 与 Workers 行为一致。
async function encryptRsaPkcs1(dataKeyBytes, modulusDec, exponentDec) {
  const nodeCrypto = await getNodeCrypto();
  if (nodeCrypto && nodeCrypto.publicEncrypt) {
    const jwk = { kty: "RSA", n: decToB64url(modulusDec), e: decToB64url(exponentDec) };
    return new Uint8Array(nodeCrypto.publicEncrypt(
      { key: jwk, format: "jwk", padding: nodeCrypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(dataKeyBytes)
    ));
  }
  // —— 纯 JS PKCS#1 v1.5（Worker 路径）——
  return rsaPkcs1EncryptJs(dataKeyBytes, BigInt(modulusDec), BigInt(exponentDec));
}

// 纯 JS RSAES-PKCS1-v1.5 加密（BigInt 模幂）
//   EM = 0x00 || 0x02 || PS(非零随机) || 0x00 || M     （M = dataKey）
//   c  = EM^e mod n
function rsaPkcs1EncryptJs(msg, n, e) {
  const kLen = Math.ceil(bitLength(n) / 8);          // 模数字节长度（2048-bit → 256）
  const mLen = msg.length;
  if (mLen > kLen - 11) throw new Error("RSA PKCS#1: 明文过长");
  const psLen = kLen - mLen - 3;
  const em = new Uint8Array(kLen);
  em[0] = 0x00;
  em[1] = 0x02;
  const ps = new Uint8Array(psLen);
  for (let i = 0; i < psLen; i++) {
    let b = 0;
    if (globalThis.crypto && globalThis.crypto.getRandomValues) {
      b = globalThis.crypto.getRandomValues(new Uint8Array(1))[0];
    } else {
      b = Math.floor(Math.random() * 256) & 0xff;
    }
    ps[i] = b === 0 ? 1 : b;   // PKCS#1 要求填充字节非零
  }
  em.set(ps, 2);
  em[2 + psLen] = 0x00;
  em.set(msg, 3 + psLen);
  const c = modPow(bytesToBigInt(em), e, n);
  return bigIntToBytes(c, kLen);
}
function bitLength(big) {
  let bits = 0;
  let v = big;
  while (v > 0n) { bits++; v >>= 1n; }
  return bits;
}
function bytesToBigInt(bytes) {
  let bi = 0n;
  for (let i = 0; i < bytes.length; i++) bi = (bi << 8n) | BigInt(bytes[i]);
  return bi;
}
function bigIntToBytes(bi, len) {
  const out = new Uint8Array(len);
  let v = bi;
  for (let i = len - 1; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}
function modPow(base, exp, mod) {
  if (mod === 1n) return 0n;
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    e >>= 1n;
    b = (b * b) % mod;
  }
  return result;
}

/* ============================ 抓取主流程 ============================ */
const HOST = "https://wap.bank.ecitic.com";
const BASE = "/NMBFOServer/api.do";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
const TIMEOUT_MS = 20000;

let cookieJar = [];
async function postJson(act, bodyObj, transport, jar) {
  const fetcher = transport || fetch;
  const body = JSON.stringify(bodyObj);
  const headers = {
    "Content-Type": "application/json; charset=UTF-8",
    "User-Agent": UA,
    "Accept": "application/json, text/plain, */*",
  };
  const _jar = jar || cookieJar;   // jar 缺省时回落模块级（仅本机单线程调试）
  if (_jar.length) headers["Cookie"] = _jar.join("; ");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetcher(HOST + BASE + "?act=" + act + "&isWeb=1", {
      method: "POST",
      headers,
      body,
      signal: ctrl.signal,
    });
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
    if (sc && sc.length) { if (jar) jar.length = 0, sc.forEach((c) => jar.push(c.split(";")[0])); else cookieJar = sc.map((c) => c.split(";")[0]); }
    const txt = await res.text();
    return txt;
  } finally {
    clearTimeout(timer);
  }
}

// ① 握手 + 建会话：取服务端 RSA 公钥 → 生成随机 dataKey → 返回加解密器。
// 2026-10-25 从 citicDirectNav 内抽出复用（额度接口 citicDirectQuota 也要走同一套信封）。
async function citicSession(transport) {
  // 【2026-11-02】每次调用独立的 cookie jar：模块级 jar 在 Workers 同 isolate 并发下会被互相覆盖
  //   （A 请求的 Cookie 被 B 请求带上 → 会话串了 → PENFHNLC 返回空 → 历史序列丢失）。
  const jar = [];
  let hsTxt;
  try { hsTxt = await postJson("PEMBPKQY", { ISWEBENCRYPY: "1" }, transport, jar); }
  catch (e) { return null; }
  let hs;
  try { hs = JSON.parse(hsTxt).dataPackage.business; hs = JSON.parse(hs); }
  catch (e) { return null; }
  if (!hs || !hs.MODULUS || !hs.PUBLICEXPONENT) return null;

  const dataKey = getRandomKey(24); // 24 字节随机可打印串
  const key24 = new TextEncoder().encode(dataKey); // utf8(24B)

  // 服务端公钥：RSAES-PKCS1-v1.5 加密 dataKey
  let encKeyBytes;
  try {
    encKeyBytes = await encryptRsaPkcs1(key24, hs.MODULUS, hs.PUBLICEXPONENT);
  } catch (e) { return null; }
  const keyHex = Array.from(encKeyBytes).map((b) => b.toString(16).padStart(2, "0")).join("");

  function smEncrypt(params) {
    const json = JSON.stringify(params).replace(/\+/g, "\\u002B");
    const au = encodeURI(json);
    const bus = tdesEcbEncrypt(new TextEncoder().encode(au), key24);
    const business = Array.from(bus).map((b) => b.toString(16).padStart(2, "0")).join("");
    return { dataPackage: { business, key: keyHex } };
  }
  function decodeBiz(txt) {
    const j = JSON.parse(txt);
    const biz = j.dataPackage && j.dataPackage.business;
    if (!biz) return null;
    try { return JSON.parse(biz); } catch (e) { return null; }
  }
  return { smEncrypt, decodeBiz, jar };
}

async function citicDirectNav(code, opts = {}) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  const transport = opts.transport;
  // 探测用（2026-10-25）：每步回调，便于看 PEMBFIPL / PENFPDQR 的原始返回
  const onStep = typeof opts.onStep === "function" ? opts.onStep : null;
  const step = (name, txt, parsed) => { if (onStep) { try { onStep(name, txt, parsed); } catch (e) { /* 忽略 */ } } };

  const sess = await citicSession(transport);
  if (!sess) return null;
  const { smEncrypt, decodeBiz, jar } = sess;

  // ② TACODE 反查 + 产品存在性确认（PEMBFIPL 只传 PRDCODE 即可命中）。
  // ⚠ 2026-10-15 坑：AF 系列（慧盈象等）TACODE=YZX 而非码前缀"AF"，旧版硬编码
  //   code.slice(0,2) 导致 PENFPDQR 返回 PENF045「查询不到该产品」（EW 系列因
  //   TACODE 恰好=="EW"才「碰巧能用」）。PEMBFIPL 空 TACODE 即可命中并回带正确 TACODE。
  //   resultList[0] 同时带回 PRDNAME（完整产品名，作 name 兜底）。
  let tacode = null;
  let plName = null;
  try {
const plTxt = await postJson("PEMBFIPL", smEncrypt({ PRDCODE: c, PRDTYPE: "1", TACODE: "", IPOMODE: "" }), transport, jar);
    const pl = decodeBiz(plTxt);
    step("PEMBFIPL", plTxt, pl);
    if (pl && Array.isArray(pl.resultList) && pl.resultList.length) {
      const r0 = pl.resultList[0];
      if (r0 && r0.TACODE) tacode = r0.TACODE;
      if (r0) plName = r0.PRDNAME || r0.NAME || null;
    }
  } catch (e) { /* 反查失败则回落码前缀 */ }
  if (!tacode) tacode = c.slice(0, 2); // 历史兼容：EW 等 TACODE==码前缀的产品

  // ③ 产品详情（确认确实存在、取名称/风险/最新净值）
let detail = decodeBiz(await postJson("PENFPDQR", smEncrypt({ PRDCODE: c, TACODE: tacode }), transport, jar));
  step("PENFPDQR", null, detail);
  if (!detail) return null;
  // 保险：反查 TACODE 后详情仍报 PENF045（查询不到）时，用码前缀再试一次
  if (detail.RETCODE === "PENF045" && tacode !== c.slice(0, 2)) {
const d2 = decodeBiz(await postJson("PENFPDQR", smEncrypt({ PRDCODE: c, TACODE: c.slice(0, 2) }), transport, jar));
    if (d2 && d2.RETCODE !== "PENF045") { detail = d2; tacode = c.slice(0, 2); }
  }
  // NAME 为完整名称；PRDNAME 被截断到30字；CONTRACTNAME 仅是合同文件名占位
  const name = detail.NAME || detail.PRDNAME || plName || detail.CONTRACTNAME || detail.prdName || null;
  if (!name && detail.RETCODE && detail.RETCODE !== "AAAAAAA") return null;

  // 探测用（2026-10-25）：只回原始 detail，不拉历史净值。
  // 用于排查「信银 App 显示的剩余可购买金额」落在哪个字段（PENFPDQR 全字段 dump）。
  if (opts.rawDetail) return { detail, tacode, plName, name };

  // ④ 历史净值：成立以来（SECTIONTYPID=999）
  const hist = decodeBiz(await postJson("PENFHNLC", smEncrypt({
    LZFLAG: "1", PRDCODE: c, PRDTYPE: "1", TACODE: tacode, ACCOUNTTYPE: "1",
    SECTIONTYPID: "999", QUERYNM: "1500", PAGENM: "0", ORDERFLAG: "0", CROSSFLAG: "", DIVIDFLAG: "1",
  }), transport, jar));
  if (!hist || !Array.isArray(hist.resultList) || !hist.resultList.length) return null;

  const series = hist.resultList
    .map((r) => {
      const d = String(r.ISSDATE || r.DATADATE || r.UPPERDATE || "").trim();
      const nav = parseFloat(r.NAV);
      return { d, nav };
    })
    .filter((p) => /^\d{8}$/.test(p.d) && Number.isFinite(p.nav) && p.nav > 0)
    .map((p) => [p.d.slice(0, 4) + "-" + p.d.slice(4, 6) + "-" + p.d.slice(6, 8), Number(p.nav.toFixed(8))])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  if (!series.length) return null;
  const ded = [];
  for (const r of series) {
    if (ded.length && ded[ded.length - 1][0] === r[0]) ded[ded.length - 1] = r;
    else ded.push(r);
  }
  return {
    name,
    manager: opts.manager || null,
    established: ded[0][0],
    series: ded,
    kind: "nav",
    risk: detail.RISKLEVEL ? "R" + detail.RISKLEVEL : (detail.RISKLEVEL_Show ? ("较低风险" === detail.RISKLEVEL_Show ? "R2" : null) : null),
    source: "live",
    bank: "citic",
    navVia: "citic",
  };
}

/* ============================ 额度（2026-10-25 新增） ============================
 * 信银理财 App「剩余可购买金额」实抓（用户截图 AF247339H = 1,930,241,709.89 元）。
 *
 * 端点：与净值同一套 NMBFOServer 信封，act=PEMBFIPL（产品列表查询），**必须带 TACODE**。
 *   · TACODE:""（旧净值反查写法）→ resultList 恒空 —— 这就是此前「查不到产品」的真因；
 *   · TACODE:"YZX"（信银理财 TA）→ 精确命中，单次 ~250ms 回 187 字段。
 *
 * 字段口径（2206 只全量列表实测，2026-10-25）：
 *   TOTSELLLMS  销售上限（1680/2163 为万元整数倍，如 25 亿 / 5.7 亿 / 200.1 亿）
 *   TOTUSEAMT   与 FINCPRDBAL（产品余额）1913/1931 完全相等 → 账面「已用/余额」
 *   但**信银 App「剩余可购买金额」显示的就是 TOTUSEAMT**：
 *     · AF247339H：App 1,930,241,709.89 ｜ TOTUSEAMT 1,930,241,710.53（差 0.64 元，实时波动）
 *     · 2206 只中「已用≈该值」唯一命中 AF247339H；「上限−已用≈该值」零命中
 *     · 折万元 193,024.17万 与截图逐位一致
 *   故按 App 口径取 TOTUSEAMT 作 remainQuota（上限/已用另存供核对）。
 * 覆盖面：中信银行代销的信银产品（TACODE=YZX 全量 2206 只）；纯他行代销份额（如
 *   AF223066H 浦发代销）不在内 —— 与净值直连同覆盖面。
 */
const CITIC_QUOTA_CACHE_TTL = 60000; // 1 分钟：额度随申赎实时变动，但短缓存足够
const citicQuotaCache = new Map();   // code -> { t, v }

export async function citicDirectQuota(code, opts = {}) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  if (!opts.noCache) {
    const hit = citicQuotaCache.get(c);
    if (hit && Date.now() - hit.t < CITIC_QUOTA_CACHE_TTL) return hit.v;
  }
  const transport = opts.transport;

  const sess = await citicSession(transport);
  if (!sess) return null;
  const { smEncrypt, decodeBiz } = sess;

  let pl;
  try {
    pl = decodeBiz(await postJson("PEMBFIPL", smEncrypt({ PRDCODE: c, PRDTYPE: "1", TACODE: "YZX", IPOMODE: "" }), transport, jar));
  } catch (e) { return null; }
  const row = (pl && Array.isArray(pl.resultList) && pl.resultList.length) ? pl.resultList[0] : null;
  if (!row) return null; // 中信未代销 / 查无此码

  const cap = Number(row.TOTSELLLMS);
  const used = Number(row.TOTUSEAMT);
  const remain = Number.isFinite(used) ? used : null; // App 口径：见上方字段口径说明
  const out = {
    name: row.PRDNAME || row.NAME || null,
    remainQuota: remain != null && remain > 0 ? remain : 0,
    remainQuotaPct: null,
    quotaState: remain != null && remain > 0 ? "available" : "sold_out",
    saleStatus: row.PRDSTTNM || null,
    currency: "CNY",
    quotaText: null,
    // 附带字段（编排层当前只透传 remainQuota/quotaState/quotaText 等，这里留作日志与核对）
    capQuota: Number.isFinite(cap) ? cap : null,
    usedQuota: Number.isFinite(used) ? used : null,
    quotaSource: "citic-app",
  };
  citicQuotaCache.set(c, { t: Date.now(), v: out });
  return out;
}

export { citicDirectNav, tdesEcbEncrypt, tdesEcbDecrypt, des3Ecb, desOneBlock, desSubkeys, bytesToBits, bitsToBytes };

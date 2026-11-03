/* ==========================================================================
 * 理财产品聚焦 —— /api/fetch Serverless 代理（Cloudflare Workers）
 *
 * 作用：
 *   把 server.py「服务器端实时抓取」的能力搬到云端，让静态托管的 GitHub Pages 页面
 *   也能实时拉取银行真实净值，彻底解决线上「服务器未连接」。
 *
 * 为什么必须是 Serverless 而不是浏览器直连：
 *   工行 papi.icbc.com.cn 的响应头 access-control-allow-origin 只允许工行自身域名，
 *   浏览器端必然被 CORS 拦截（详见 icbc-nav-scraper skill）。Worker 在服务端发请求，
 *   不受同源策略限制，再把结果以 Access-Control-Allow-Origin: * 返回给前端。
 *
 * 接口契约（与 server.py 完全一致，前端无需改消费逻辑）：
 *   GET /api/fetch?bank=<银行key>&code=<产品代码>
 *   成功 200 → {name, manager, established, series:[[date,val],...], kind, source:"live"}
 *   未收录 404 → {error:"not found", bank, code}
 *
 * ╔═══════════════════════════════════════════════════════════════════════╗
 * ║ 项目铁律（2026-10-21 用户立，所有银行抓取函数都必须遵守）：              ║
 * ║   本项目【只收录有净值的固收产品】，【不考虑现金管理类产品】。            ║
 * ║   · 现金管理类（各行的叫法：现金管理类/类货基/日日新/惠享天天/天天增利等， ║
 * ║     上游常以 productType1==="XJL"、OPEN_TYPE=6、variety="3"、ishb=true     ║
 * ║     或「单位净值恒 1、真实收益在万份收益」为特征）一律不抓：               ║
 * ║     抓到权威分类信号 → 直接 return null 排除。                           ║
 * ║   · 禁止 reintroduce 任何现金类【处理】代码：万份收益复利合成（ccbCompound  ║
 * ║     等）、kind:"wan" / navBasis:"wan" 口径标记、七日年化/万份收益字段映射。  ║
 * ║     历史上这些逻辑把现金类伪装成净值型放行过（兴银理财日日新1号/9B3100GS）， ║
 * ║     现已全部删除，不要再加回来。                                         ║
 * ║   · 各银行的 holdDays 名称启发式（日开/现金管理→1天）是【持有天数推断】，   ║
 * ║     与现金类处理无关，保留。                                            ║
 * ╚═══════════════════════════════════════════════════════════════════════╝
 *
 * 已实现实时抓取：icbc（工行自营 GY/空 + 代销 PAWM/EW/Y05/ZY1/MS/PY8/Y3/Y04/PWM/Y88 等）
 *                    boc（中国银行；App 端口 bocFinanceDetail 手机银行 H5，isNewVersion:"Y" 详情口 211 字段，
 *                         含风险/登记编码/成立日/最短持有期/业绩基准/管理人/存续规模 + 历史净值，免登录；web 概要兜底）
 *                    psbc（邮储银行微信 H5，国密 SM2+SM4 加密通道；含风险等级/业绩比较基准）
 *                    ceb（光大银行；App 端口 eoap 营销 H5 直连，全量净值 + 七字段，需分享链 accessId；官网 eportal 兜底）
 *                    abc（农业银行渠道净值：农银理财官网 abcwealth.com.cn 主源（快一个披露日，
 *                         只存近 ~1081 个披露日）+ 农行理财e站 ewealth.abchina.com.cn
 *                         兜底及早期历史，双源合并同日以官网为准；现金管理类一律排除）
 *                    bob（北京银行 / 北银理财 beijingbobwealth.com.cn，免签名免 Token；
 *                         净值 + 产品信息 + 登记编码；现金管理类一律排除不抓，见项目规则）
 *                    cmb（招商银行 cfweb 理财超市 cfweb.paas.cmbchina.com，SM4-ECB 国密签名；
 *                         代销/自营净值 + 产品信息 + 登记编码；净值型按单位净值处理）
 *                    bosc（上海银行 www.bosc.cn，净值披露接口 qryMCFinanceNetProHisValueForPersonPage；
 *                         净值型按单位净值处理；含管理人/业绩比较基准；不返回风险等级与登记编码）
 *                    spdb（浦发银行；产品信息取 per.spdb.com.cn/api/search（chlid=1066）；
 *                         官网净值页已下线、网银需登录，故净值按发行方路由：
 *                         归一化名称到招行 cfweb 目录检索，命中则取招行真实净值序列）
 *                    ccb（建设银行；tool3.ccb.cn 理财净值披露页后端网关 WCCMainPlatV5，免登录免签名：
 *                         TXCODE=NLC165 支持 IvsmPd_ECD 按产品码精确过滤 → 产品信息 + 最新披露单位净值；
 *                         历史净值取静态披露文件 /newsinfo/finance/{码}{市场ID}{机构ID}40{口径}.txt
 *                         （09 单位净值；现金管理类整段恒1已按项目规则排除，不再取10/15口径）；
 *                         详情页 NLC164 需登录故风险等级置空）
 * 其余银行：返回 404，由前端回退到已内嵌的真实快照（doLookupProduct），行为与既有线上一致。
 *
 * 部署：npx wrangler deploy
 * 本机验证：node src/serverless/test_local.js --psbc <code>
 * ========================================================================== */

/* ==========================================================================
 * 江苏银行「线上 Worker」端口 —— Cloudflare Browser Rendering（真 Chromium 驱动页面）
 *
 * 为什么单独 import 而不是动态 import：动态 import(new URL(...)) 是故意留给
 * 「只在本机 Node 跑」的模块（jsb_app.mjs 依赖 puppeteer-core/本机 Chrome，
 * Workers 里没有 Chrome）。本模块是纯 Workers 安全的（fetch + WebSocket + WebCrypto），
 * 所以用**静态 import**，让 wrangler/esbuild 把它打进 bundle，线上才能真正用上。
 *
 * 江苏银行全线挂在 WAF 后面，必须执行 JS 挑战（多层 eval 虚拟机），而 Workers
 * 禁止 eval()/new Function ⇒ 纯 HTTP 必被 202 拦；只能驱动真浏览器。见 jsb_worker.mjs。
 * ========================================================================== */
import { jsbBrowserFetch, jsbBrowserFetchMany, jsbBrowserDiag, makeBrowserBindingConnector } from "./jsb_worker.mjs";

/* 招银理财官网纯 HTTP+SM2 腿（scrape/cmbwm_http.mjs）：纯 Workers 安全（fetch + WebCrypto），
 * 故静态 import 打进 bundle（同 jsb_worker 的约定——动态 import(new URL) 只留给本机 Chrome 模块）。
 * 原先 cmbwm_app.mjs 用动态 import(new URL("./cmbwm_app.mjs", import.meta.url))，在 Worker 运行时
 * 会抛 "Invalid URL string"，导致 cmbwm 线上从未真正跑过（静默 null → 回落中国理财网）。
 * 改用静态 import 后，线上 Worker 才能真用上这条纯 HTTP 腿。 */
import { cmbwmByCode as cmbwmHttpByCode, cmbwmCatalog as cmbwmHttpCatalog } from "./cmbwm_http.mjs";

/* 中信银行 App 端口（scrape/citic_direct_nav.mjs）：纯 Workers 安全（fetch + WebCrypto + 纯 JS 3DES），
 * 故**静态 import** 打进 bundle（同 cmbwm_http / jsb_worker 的约定）。
 * 【2026-11-02 修复·重要】原先用动态 import(new URL("./citic_direct_nav.mjs", import.meta.url))，
 * 而 esbuild **不解析** new URL(..., import.meta.url) 形式的动态 import → 该模块代码根本没进 bundle，
 * Worker 运行时执行到这行抛 "Invalid URL string"，被 try/catch 吞掉 → 中信 App 端口在**线上从未真正跑过**：
 *   · 净值：非信银代销产品（如光大 EW7019D）永远抓不到 → 落中国理财网兜底；
 *   · 额度：citic quota 恒返回 null（本地 Node 能取到 remainQuota，线上 ms:0/null）。
 * 改静态 import 后，这条腿才真正在线上生效。 */
import { citicDirectNav, citicDirectQuota } from "./citic_direct_nav.mjs";

/* Worker env（含 browser binding）—— fetch 入口写入，各抓取函数按需取用。
 * 为什么不逐层透传：jsbFetch/xxxFetch 这类函数的调用点遍布全文件，
 * 加参数会牵动上百处；同一部署里 env 是常量，模块级保存最省事也最安全。 */
let WORKER_ENV = null;
export function setWorkerEnv(env) { WORKER_ENV = env || null; }
export function getWorkerEnv() { return WORKER_ENV; }

/* ==========================================================================
 * 国密工具箱 —— SM3 / SM4(ECB+PKCS7) / SM2 加密，纯 JS 手写实现，零依赖
 *
 * 为什么不用 import 'sm-crypto'：本项目的 worker.js 是【单文件直接部署】到
 * Cloudflare Workers 的，仓库里没有 package.json，也没有打包环节，第三方包在 Worker
 * 运行时根本解析不到（线上表现就是 Cannot find package 'sm-crypto'）——邮储(psbc)
 * 这一路在线上一直是废的。故与既有的招行 cmbSm4Ecb 一样改为手写。
 *
 * ⚠ Workers 限制：禁止在全局作用域生成随机值（Disallowed operation，code 10021）。
 *   所以随机数一律只在函数被调用时才取（psbcRandomKey / sm2Encrypt 均符合），
 *   不要试图把这些函数提到模块顶层去预生成任何东西。
 *
 * 正确性验证：
 *   - SM3("abc") = 66c7f0f4…66 与 GB/T 官方向量一致；
 *   - SM4 与 sm-crypto 随机 300/300 逐字节一致，且与既有 cmbSm4Ecb 200/200 一致；
 *   - SM2 与 sm-crypto 双向互通各 50/50（我方加密→对方解密、对方密文→我方解密）。
 * ⚠ 口径坑：sm-crypto 默认【不带】C1 的 04 前缀，本实现与之一致；
 *   但邮储(psbc) 服务端【要】前缀，所以调用处显式写 "04" + sm2Encrypt(...)；
 *   兴业(cib) 那边则直接用返回值。改前缀归属前务必先确认调用方。
 * ⚠ 任何一处常量改错都不会报错，只会变成服务端静默拒收——改完请跑 node scrape/test_gm.mjs。
 * ========================================================================== */

/* --------------------------- SM3 摘要 --------------------------- */
const SM3_IV = [0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600, 0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e];
const gmRotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
const sm3FF = (j, x, y, z) => (j < 16 ? x ^ y ^ z : (x & y) | (x & z) | (y & z));
const sm3GG = (j, x, y, z) => (j < 16 ? x ^ y ^ z : (x & y) | (~x & z));
const sm3P0 = (x) => (x ^ gmRotl(x, 9) ^ gmRotl(x, 17)) >>> 0;
const sm3P1 = (x) => (x ^ gmRotl(x, 15) ^ gmRotl(x, 23)) >>> 0;
const sm3TT = (j) => (j < 16 ? 0x79cc4519 : 0x7a879d8a);

function sm3CF(v, blk) {
  const w = new Array(68).fill(0), w1 = new Array(64).fill(0);
  for (let j = 0; j < 16; j++) w[j] = ((blk[j * 4] << 24) | (blk[j * 4 + 1] << 16) | (blk[j * 4 + 2] << 8) | blk[j * 4 + 3]) >>> 0;
  for (let j = 16; j < 68; j++) w[j] = (sm3P1(w[j - 16] ^ w[j - 9] ^ gmRotl(w[j - 3], 15)) ^ gmRotl(w[j - 13], 7) ^ w[j - 6]) >>> 0;
  for (let j = 0; j < 64; j++) w1[j] = (w[j] ^ w[j + 4]) >>> 0;
  let [a, b, c, d, e, f, g, h] = v;
  for (let j = 0; j < 64; j++) {
    const ss1 = gmRotl((gmRotl(a, 12) + e + gmRotl(sm3TT(j), j)) >>> 0, 7);
    const ss2 = (ss1 ^ gmRotl(a, 12)) >>> 0;
    const tt1 = (sm3FF(j, a, b, c) + d + ss2 + w1[j]) >>> 0;
    const tt2 = (sm3GG(j, e, f, g) + h + ss1 + w[j]) >>> 0;
    d = c; c = gmRotl(b, 9); b = a; a = tt1;
    h = g; g = gmRotl(f, 19); f = e; e = sm3P0(tt2);
  }
  return [a ^ v[0], b ^ v[1], c ^ v[2], d ^ v[3], e ^ v[4], f ^ v[5], g ^ v[6], h ^ v[7]].map((x) => x >>> 0);
}

function sm3(u8) {
  const bitLen = u8.length * 8;
  const blocks = Math.ceil((u8.length + 9) / 64);
  const padded = new Uint8Array(blocks * 64);
  padded.set(u8);
  padded[u8.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(blocks * 64 - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(blocks * 64 - 4, bitLen >>> 0, false);
  let v = SM3_IV.slice();
  for (let i = 0; i < padded.length; i += 64) v = sm3CF(v, padded.subarray(i, i + 64));
  return Uint8Array.from(v.flatMap((x) => [(x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff]));
}

/* --------------------------- SM4 分组密码 --------------------------- */
const GM_SBOX = [214,144,233,254,204,225,61,183,22,182,20,194,40,251,44,5,43,103,154,118,42,190,4,195,170,68,19,38,73,134,6,153,156,66,80,244,145,239,152,122,51,84,11,67,237,207,172,98,228,179,28,169,201,8,232,149,128,223,148,250,117,143,63,166,71,7,167,252,243,115,23,186,131,89,60,25,230,133,79,168,104,107,129,178,113,100,218,139,248,235,15,75,112,86,157,53,30,36,14,94,99,88,209,162,37,34,124,59,1,33,120,135,212,0,70,87,159,211,39,82,76,54,2,231,160,196,200,158,234,191,138,210,64,199,56,181,163,247,242,206,249,97,21,161,224,174,93,164,155,52,26,85,173,147,50,48,245,140,177,227,29,246,226,46,130,102,202,96,192,41,35,171,13,83,78,111,213,219,55,69,222,253,142,47,3,255,106,114,109,108,91,81,141,27,175,146,187,221,188,127,17,217,92,65,31,16,90,216,10,193,49,136,165,205,123,189,45,116,208,18,184,229,180,176,137,105,151,74,12,150,119,126,101,185,241,9,197,110,198,132,24,240,125,236,58,220,77,32,121,238,95,62,215,203,57,72];
const GM_FK = [0xa3b1bac6, 0x56aa3350, 0x677d9197, 0xb27022dc];
const GM_CK = [0x00070e15,0x1c232a31,0x383f464d,0x545b6269,0x70777e85,0x8c939aa1,0xa8afb6bd,0xc4cbd2d9,0xe0e7eef5,0xfc030a11,0x181f262d,0x343b4249,0x50575e65,0x6c737a81,0x888f969d,0xa4abb2b9,0xc0c7ced5,0xdce3eaf1,0xf8ff060d,0x141b2229,0x30373e45,0x4c535a61,0x686f767d,0x848b9299,0xa0a7aeb5,0xbcc3cad1,0xd8dfe6ed,0xf4fb0209,0x10171e25,0x2c333a41,0x484f565d,0x646b7279];
const gmTau = (a) => (((GM_SBOX[(a >>> 24) & 0xff] << 24) | (GM_SBOX[(a >>> 16) & 0xff] << 16) | (GM_SBOX[(a >>> 8) & 0xff] << 8) | GM_SBOX[a & 0xff]) >>> 0);
const gmT = (x) => { const b = gmTau(x); return (b ^ gmRotl(b, 2) ^ gmRotl(b, 10) ^ gmRotl(b, 18) ^ gmRotl(b, 24)) >>> 0; };
const gmTkey = (x) => { const b = gmTau(x); return (b ^ gmRotl(b, 13) ^ gmRotl(b, 23)) >>> 0; };

function gmSm4Keys(key) {
  const K = [];
  for (let i = 0; i < 4; i++) K.push(((((key[i * 4] << 24) | (key[i * 4 + 1] << 16) | (key[i * 4 + 2] << 8) | key[i * 4 + 3]) >>> 0) ^ GM_FK[i]) >>> 0);
  const rk = [];
  for (let i = 0; i < 32; i++) { K.push((K[i] ^ gmTkey(((K[i + 1] ^ K[i + 2] ^ K[i + 3] ^ GM_CK[i]) >>> 0))) >>> 0); rk.push(K[i + 4]); }
  return rk;
}
function gmSm4Block(rk, blk) {
  const x = [];
  for (let i = 0; i < 4; i++) x.push(((blk[i * 4] << 24) | (blk[i * 4 + 1] << 16) | (blk[i * 4 + 2] << 8) | blk[i * 4 + 3]) >>> 0);
  for (let i = 0; i < 32; i++) x.push((x[i] ^ gmT(((x[i + 1] ^ x[i + 2] ^ x[i + 3] ^ rk[i]) >>> 0))) >>> 0);
  return Uint8Array.from([x[35], x[34], x[33], x[32]].flatMap((w) => [(w >>> 24) & 0xff, (w >>> 16) & 0xff, (w >>> 8) & 0xff, w & 0xff]));
}
/** SM4-ECB；data 必须已是 16 的整数倍（含填充）。decrypt=true 时轮密钥逆序即为解密 */
function sm4Ecb(keyU8, dataU8, decrypt = false) {
  const rk = gmSm4Keys(keyU8);
  if (decrypt) rk.reverse();
  const out = new Uint8Array(dataU8.length);
  for (let i = 0; i < dataU8.length; i += 16) out.set(gmSm4Block(rk, dataU8.subarray(i, i + 16)), i);
  return out;
}
/** SM4-CBC（兴业 z.cib.com.cn 用）；IV 取 16 字节 */
function sm4Cbc(keyU8, ivU8, dataU8, decrypt = false) {
  const rk = gmSm4Keys(keyU8);
  if (decrypt) rk.reverse();
  const out = new Uint8Array(dataU8.length);
  let prev = ivU8;
  for (let i = 0; i < dataU8.length; i += 16) {
    const blk = dataU8.subarray(i, i + 16);
    if (!decrypt) {
      const enc = gmSm4Block(rk, Uint8Array.from(blk.map((b, j) => b ^ prev[j])));
      out.set(enc, i);
      prev = enc;
    } else {
      out.set(Uint8Array.from(gmSm4Block(rk, blk).map((b, j) => b ^ prev[j])), i);
      prev = blk;
    }
  }
  return out;
}
const gmPkcs7 = (u8) => { const p = 16 - (u8.length % 16); const o = new Uint8Array(u8.length + p); o.set(u8); for (let i = u8.length; i < o.length; i++) o[i] = p; return o; };
const gmUnPkcs7 = (u8) => u8.subarray(0, u8.length - u8[u8.length - 1]);

/* 面向 call site 的薄封装：与之替代的 sm-crypto 调用等价（密钥/IV 均为 hex 字符串） */
const gmSm4EcbEnc = (str, keyHex) => gmU8Hex(sm4Ecb(gmHexU8(keyHex), gmPkcs7(gmU8(str))));
const gmSm4EcbDec = (hexStr, keyHex) => gmStr(gmUnPkcs7(sm4Ecb(gmHexU8(keyHex), gmHexU8(hexStr), true)));
const gmSm4CbcEnc = (str, keyHex, ivHex) => gmU8Hex(sm4Cbc(gmHexU8(keyHex), gmHexU8(ivHex), gmPkcs7(gmU8(str)), false));
const gmSm4CbcDec = (hexStr, keyHex, ivHex) => gmStr(gmUnPkcs7(sm4Cbc(gmHexU8(keyHex), gmHexU8(ivHex), gmHexU8(hexStr), true)));
/** SM3 摘要，入参 UTF-8 字符串，出参小写 hex 串 */
const gmSm3 = (str) => gmU8Hex(sm3(gmU8(str)));

/* --------------------------- 字节 / 十六进制工具 --------------------------- */
const gmU8Hex = (u8) => Array.from(u8).map((b) => b.toString(16).padStart(2, "0")).join("");
const gmHexU8 = (h) => { const s = String(h).trim(); const o = new Uint8Array(s.length >> 1); for (let i = 0; i < o.length; i++) o[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16); return o; };
const gmU8 = (s) => new TextEncoder().encode(s);
const gmStr = (u8) => new TextDecoder().decode(u8);

/* --------------------------- SM2 公钥加密（sm2p256v1） --------------------------- */
const SM2_P = 0xfffffffeffffffffffffffffffffffffffffffff00000000ffffffffffffffffn;
const SM2_A = 0xfffffffeffffffffffffffffffffffffffffffff00000000fffffffffffffffcn;
const SM2_B = 0x28e9fa9e9d9f5e344d5a9e4bcf6509a7f39789f515ab8f92ddbcbd414d940e93n;
const SM2_N = 0xfffffffeffffffffffffffffffffffff7203df6b21c6052b53bbf40939d54123n;
const SM2_GX = 0x32c4ae2c1f1981195f9904466a39c9948fe30bbff2660be1715a4589334c74c7n;
const SM2_GY = 0xbc3736a2f4f6779c59bdcee36b692153d0a9877cc62a474002df32e52139f0a0n;
const sm2Mod = (x, m) => { const r = x % m; return r < 0n ? r + m : r; };
function sm2Inv(x, m) { let [r0, r1] = [x, m], [s0, s1] = [1n, 0n]; while (r1 !== 0n) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; } return sm2Mod(s0, m); }
/** 点用 [x,y] 表示，null 代表无穷远点 */
function sm2Add(p1, p2) {
  if (!p1) return p2;
  if (!p2) return p1;
  const [x1, y1] = p1, [x2, y2] = p2;
  let lam;
  if (x1 === x2) { if (sm2Mod(y1 + y2, SM2_P) === 0n) return null; lam = sm2Mod((3n * x1 * x1 + SM2_A) * sm2Inv(sm2Mod(2n * y1, SM2_P), SM2_P), SM2_P); }
  else lam = sm2Mod((y2 - y1) * sm2Inv(sm2Mod(x2 - x1, SM2_P), SM2_P), SM2_P);
  const x3 = sm2Mod(lam * lam - x1 - x2, SM2_P);
  return [x3, sm2Mod(lam * sm2Mod(x1 - x3, SM2_P) - y1, SM2_P)];
}
function sm2Mul(k, pt) { let acc = null, cur = pt, kk = k; while (kk > 0n) { if (kk & 1n) acc = sm2Add(acc, cur); cur = sm2Add(cur, cur); kk >>= 1n; } return acc; }
const sm2FeHex = (v) => v.toString(16).padStart(64, "0");
const sm2FeU8 = (v) => gmHexU8(sm2FeHex(v));
function sm2Kdf(z, klen) {
  const out = [];
  for (let i = 1, n = Math.ceil(klen / 256); i <= n; i++) {
    const be = new Uint8Array(4);
    new DataView(be.buffer).setUint32(0, i, false);
    out.push(...sm3(Uint8Array.from([...z, ...be])));
  }
  return Uint8Array.from(out);
}
/**
 * SM2 加密。pubHex 为 130 位公钥（可带 04 前缀）；返回小写 hex，密文顺序为国标
 * C1||C3||C2，C1 **不带**非压缩点的 04 前缀（与 sm-crypto 默认一致）。
 * ⚠ 邮储(psbc) 要求带前缀，调用处要自己拼 "04" + …；兴业(cib) 直接用本返回值。
 */
function sm2Encrypt(msgU8, pubHex) {
  const h = String(pubHex).replace(/^04/, "");
  const PK = [BigInt("0x" + h.slice(0, 64)), BigInt("0x" + h.slice(64, 128))];
  let k;
  do {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    k = BigInt("0x" + gmU8Hex(b));
  } while (k === 0n || k >= SM2_N);
  const C1 = sm2Mul(k, [SM2_GX, SM2_GY]);
  const S = sm2Mul(k, PK);
  if (!C1 || !S) throw new Error("sm2: 标量乘得到无穷远点");
  const x2 = sm2FeU8(S[0]), y2 = sm2FeU8(S[1]);
  const t = sm2Kdf(Uint8Array.from([...x2, ...y2]), msgU8.length * 8);
  const C2 = Uint8Array.from(msgU8.map((b, i) => b ^ t[i]));
  const C3 = sm3(Uint8Array.from([...x2, ...msgU8, ...y2]));
  return gmU8Hex(Uint8Array.from([...sm2FeU8(C1[0]), ...sm2FeU8(C1[1]), ...C3, ...C2]));
}

/* ----------------------------- 配置常量 ----------------------------- */

const ICBC_HOST = "https://papi.icbc.com.cn";
// 统一用 consignment 端点：实测工行自有(GY/空)与代销(PAWM/EW/Y05…)均返回数据；
// general/getNetValue 对代销产品返回空，所以不要换回去。
const ICBC_NAV_EP = "/finance/deposit/consignment/getNetValueList";

// 工行个人网银「理财详情」NoSession 端点（2026-10-12 逆向，用户 Edge 登录网银抓包）：
//   GET /servlet/ICBCBaseReqServletNoSession?dse_operationName=per_FinanceProductDetailNSOp
//       &productId=XXX&transData=XXX@1@$$$$$XXX$$$0$1$11/ALL$1&Area_code=0200&requestChannel=302
// 免登录可用（servlet 名即 NoSession；已用无 cookie curl 复测 200，额度区块与登录态一致）。
// 返回 GBK 服务端渲染 HTML，额度在页面里：<!-- 充足/紧张/暂无 --> 注释 + issuEnough.png 图标
// +「剩余额度>1亿元 / 8000万」文本。这是工行唯一免登录含额度的通道（papi H5 detail 无额度）。
const ICBC_MYBANK_HOST = "https://mybank.icbc.com.cn";

// app 端口「历史净值」异步接口（2026-10-15 逆向，用户在电脑打开 mybank 产品详情可见全量净值）：
//   POST /servlet/AsynGetDataServlet  form: tranCode=A00682&productid=XXX&tagFlag=1&chartTimeFlag=6&tranFlag=0&detailFlag=1
//   免登录可用（无 cookie curl 复测 200）。chartTimeFlag=6 = 自成立以来（全量历史）。
//   返回 {workDateListJson, valueListJson(单位净值), totalValueListJson(累计净值)}，各为 JSON 字符串数组；日期 YYYYMMDD。
//   实测与 web 端口(papi getNetValueList)逐点一致（26G5411A 均 85 点、首末值日期相同）。
//   这是工行「先 app 后 web」的关键：app 端口同时有全量净值 + 额度(NoSession)，web 端口(papi)只有净值无额度。
const ICBC_ASYN_EP = "/servlet/AsynGetDataServlet";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const REFERER = "https://www.icbc.com.cn/webpage/finance/disclosure/?type=2";
const ORIGIN = "https://www.icbc.com.cn";

// saleTarget 探测顺序（与 src/bank_scrape/icbc_nav.py 的 SALE_TARGETS 保持一致）
const SALE_TARGETS = ["7", "5", "2", "6", "9", "1", "3", "4", "8"];

const UPSTREAM_TIMEOUT_MS = 25000;

// /api/fetch 成功结果的缓存时长（秒）。银行净值一天最多更新一次，缓存 6 小时足够：
// 既能扛住上游抖动，也不会让用户看到过期数据。
const CACHE_TTL_SEC = 6 * 60 * 60;

// /api/fetch 返回结构版本号。改动返回字段时 +1（v1→v2→…），让旧结构缓存立即失效。
const CACHE_VERSION = "v41"; // v41：**新增中信银行官网「代销产品信息查询平台」端口**（etrade.citicbank.com/portalweb/cms/getConsignProdList.htm，JSONP，免登录免签名、不带 Referer 也通）—— 收录中信代销的**全部**产品（含他行发行），提供 taName 发行方权威口径 + 当日单点净值（比信银官网/App 端口都新）+ 风险等级 + 产品状态；历史序列仍由信银官网/App 提供，三端口按日期并集（官网覆盖同日）。  // v40：

/* 分页参数 —— 这两个值是被 Cloudflare Workers 的「子请求配额」倒推出来的，别随手调大。
 *
 * 约束：Workers 免费版单次调用最多 50 个出站子请求（每发一次 HTTP 算 1 个）。
 * 开销 = saleTarget 探测（最多 9 次）+ 翻页（最多 MAX_PAGES 次）。
 *
 * 实测 getNetValueList 支持 pageSize=500（613 条的产品，pageSize=500 时 pages 从 13 降到 2）。
 * 取 pageSize=500 / MAX_PAGES=8：最坏 9 + 8 = 17 次子请求，远低于 50 的配额，
 * 且单产品可覆盖 4000 个交易日（≈10 年），远超实际披露历史长度。
 */
const MAX_PAGES = 8;
const PAGE_SIZE = 500;

/* 各银行净值披露时间（北京时间）。用于刷新时跳过「尚未出新净值」的产品，省去无谓回源。
 *
 * 规则（来自实盘观察，2026-10-30 归纳）：
 *  - 建设银行：T+0 产品当日多次（上午/中午/下午/晚上）出当日净值；其余 T+1/T+2 产品当晚 23:00 出当日净值。
 *  - 邮储/农行/中信/平安/广发/江苏(苏银) 官网：当晚 23:00–24:00 出当日净值。
 *  - 其余银行（兴业/交银/招行/民生/华夏/微众/网商/南京/杭州/北京/光大…）：次日（D+1）上午才出 D 日净值。
 *  - 中国理财网：所有银行都是次日（D+1）上午出 D 日净值（仅作兜底，本项目不用于净值抓取）。
 *
 * 建模：产品最新净值日 = L。下一日净值 (L+1) 的披露时刻 = (L + (lagDays+1) 天) 的 hour:min（北京时间）。
 *  - 当晚披露（lagDays=0, hour=23）：建行(非T0)/邮储/中邮/农行/中信/平安/广发/江苏 适用。
 *  - 次日早披露（lagDays=1, hour=10）：其余银行及中国理财网兜底 适用。
 * 在披露时刻之前，该产品不可能有新净值 → 直接跳过抓取（返回 navIncremental:true, series:[]，前端/定时脚本按「已是最新」处理）。
 */
const NAV_PUBLISH_SCHEDULE = {
  ccb:    { lagDays: 0, hour: 23, min: 0 },  // 建设银行/建信理财：NAV 优先源=建信理财官网（T+0 当日上午/中午/下午/晚上多次披露、非 T+0 当晚23点出当日净值）；建设银行自身端口(wealth.ccb.com/tool3.ccb.cn/finance.txt)次日晨出昨日净值→仅兜底。hour:23 对应建信理财非 T+0 当日23点；T+0 日内多次披露按 23 点保守跳过（不漏非 T+0，T+0 最多延迟到当日23点窗口补齐）。
  psbc:   { lagDays: 0, hour: 23, min: 0 },  // 邮储官网（含中邮理财）：当晚23-24点出当日净值
  psbcwm: { lagDays: 0, hour: 23, min: 0 },
  abc:    { lagDays: 0, hour: 23, min: 0 },  // 农行官网：当晚23-24点
  citic:  { lagDays: 0, hour: 23, min: 0 },  // 中信官网：当晚23-24点
  pingan: { lagDays: 0, hour: 23, min: 0 },  // 平安官网：当晚23-24点
  cgb:    { lagDays: 0, hour: 23, min: 0 },  // 广发官网：当晚23-24点
  jsb:    { lagDays: 0, hour: 23, min: 0 },  // 江苏银行(苏银)官网：当晚23-24点
  // 其余银行（兴业/交银/招行/民生/华夏/北京/光大/南京/杭州/微众/网商/富民…）及中国理财网兜底：次日(D+1)上午出 D 日净值。
  // ⚠ hour 取 0（凌晨即视为上一交易日净值已出）：避免「default 组银行(工行/中行等) 10-29 等 2 天前产品被过度跳过」。
  //   效果 = 仅当产品最新净值日是「昨天/今天」才跳过；更早(≥2天前)一律 fetch。早抓若暂无新点会被 navIncremental 安全吸收，不丢数据。
  default:{ lagDays: 1, hour: 0, min: 0 },
};

// 把银行 key 归一化到 schedule 表（去掉理财子后缀 wm）
function scheduleBankKey(bank) {
  if (!bank) return "default";
  const b = String(bank).toLowerCase().replace(/wm$/, "");
  return NAV_PUBLISH_SCHEDULE[b] ? b : "default";
}

// 返回「下一日净值 (L+1) 披露时刻」的真实 UTC 毫秒戳。
// L 形如 'YYYY-MM-DD'（产品当前最新净值日）。在此时刻之前该产品不可能有新数据，可跳过抓取。
// 无 since 或格式不符 → 返回 0（不跳过，走正常抓取）。
function nextNavPublishMs(bank, sinceStr) {
  if (!sinceStr || !/^\d{4}-\d{2}-\d{2}$/.test(sinceStr)) return 0;
  const sch = NAV_PUBLISH_SCHEDULE[scheduleBankKey(bank)];
  const [y, m, d] = sinceStr.split("-").map(Number);
  // 北京时刻：(L + lagDays+1 天) 的 hour:min → 先按「UTC 当北京」构造，再减 8h 得真实 UTC
  const bj = Date.UTC(y, m - 1, d + sch.lagDays + 1, sch.hour, sch.min, 0, 0);
  return bj - 8 * 3600 * 1000;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

/* ----------------------------- 工具函数 ----------------------------- */

function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

/**
 * 推断发行机构（管理人）。
 * 与 server.py 的 infer_icbc_manager 保持一致，并补全工行代销池里实际存在的财富管理子公司
 * （原有实现缺信银/苏银/中邮/交银/高盛工银/民生理财，会误落回默认的「工银理财」）。
 * 顺序敏感：更具体的前缀（如「高盛工银」）必须排在更短的前缀（如「工银」）之前。
 */
const MANAGER_HINTS = [
  ["施罗德交银", "施罗德交银理财"],
  ["法巴农银", "法巴农银理财"],
  ["贝莱德建信", "贝莱德建信理财"],
  ["高盛工银", "高盛工银理财"],
  ["民生理财", "民生理财"],
  ["信银", "信银理财"],
  ["苏银", "苏银理财"],
  ["中邮", "中邮理财"],
  ["交银", "交银理财"],
  ["工银", "工银理财"],
  ["建信", "建信理财"],
  ["农银", "农银理财"],
  ["中银", "中银理财"],
  ["光大", "光大理财"],
  ["兴银", "兴银理财"],
  ["招银", "招银理财"],
  ["北银", "北银理财"],
  ["杭银", "杭银理财"],
  ["宁银", "宁银理财"],
  ["青银", "青银理财"],
  ["南银", "南银理财"],
  ["恒丰", "恒丰理财"],
  ["渤银", "渤银理财"],
  ["渝农商", "渝农商理财"],
  ["汇华", "汇华理财"],
  ["浦银", "浦银理财"],
  ["上银", "上银理财"],
  ["华夏", "华夏理财"],
  ["平安", "平安理财"],
  ["广银", "广银理财"],
];

export function inferManager(name) {
  const n = name || "";
  for (const [kw, mgr] of MANAGER_HINTS) {
    if (n.includes(kw)) return mgr;
  }
  return "工银理财";
}

/**
 * inferManager 的**严格版**：认不出就返回 null。
 * inferManager 对未知名默认回「工银理财」（见 managerToBankKey 注释），直接用它会把
 * 名字里没有机构字样的产品误标成工银理财 —— 违反《硬编码兜底禁令》：
 * 「名称能可靠识别机构才填，否则置 null（宁可空缺也不写错）」。
 * 用法：落盘净值记录的 manager 字段、发行行判定等**不允许猜**的场景。
 */
export function inferManagerStrict(name) {
  const n = String(name || "");
  for (const [kw, mgr] of MANAGER_HINTS) {
    if (n.includes(kw)) return mgr;
  }
  return null;
}

/**
 * 发行机构（管理人）→ 发行银行 key。
 * 口径与 predict_bank.js 规则 JSON「销售代码-预判规则.json」的 manager_to_parent_key
 * 完全一致（2026-10-15 照搬，含施罗德交银/贝莱德建信/法巴农银/高盛工银/汇华等合资行），
 * 避免两套口径漂移。映射为 null 的未接入行（杭银/渤银/徽银/青银/渝农商/浙银理财）
 * 不出现在表里 → 返回空串，由编排层走「代销银行 → 中国理财网兜底」。
 * 用途：抓净值时发行银行不再按 code 调 /api/predict 预判，改由前端把产品记录里已存的
 * 发行机构（产品详情页最上方卡片红圈字段 r.manager，如「招银理财」）经 /api/product 的
 * manager 参数透传，本函数负责换算成 fetchProductFull 需要的银行 key。
 */
const MANAGER_TO_KEY = {
  "交银理财": "comm", "施罗德交银理财": "comm", "汇华理财": "comm",
  "光大理财": "ceb",
  "浦银理财": "spdb",
  "中银理财": "boc",
  "招银理财": "cmb",
  "中邮理财": "psbc",
  "信银理财": "citic",
  "建信理财": "ccb", "贝莱德建信理财": "ccb",
  "民生理财": "cmbc",
  "工银理财": "icbc", "高盛工银理财": "icbc",
  "广银理财": "cgb",
  "宁银理财": "nbcb",
  "华夏理财": "huaxia",
  "上银理财": "bosc",
  "兴银理财": "cib",
  "北银理财": "bob",
  "农银理财": "abc", "法巴农银理财": "abc",
  "平安理财": "pingan",
  "南银理财": "nanyin",
  "苏银理财": "jsb",
};
// manager 字段出现长名/变体时的关键词兜底（如「招银理财有限责任公司」「兴业银行」）
const MANAGER_KEY_HINTS = [
  ["施罗德交银", "comm"], ["贝莱德建信", "ccb"], ["法巴农银", "abc"], ["高盛工银", "icbc"],
  ["招银", "cmb"], ["工银", "icbc"], ["中银", "boc"], ["中邮", "psbc"],
  ["宁银", "nbcb"], ["信银", "citic"], ["交银", "comm"], ["建信", "ccb"],
  ["民生", "cmbc"], ["农银", "abc"], ["光大", "ceb"], ["浦银", "spdb"],
  ["广银", "cgb"], ["北银", "bob"], ["上银", "bosc"], ["兴银", "cib"],
  ["兴业", "cib"], ["苏银", "jsb"], ["南银", "nanyin"], ["平安", "pingan"],
  ["华夏", "huaxia"], ["汇华", "comm"],
];
export function managerToBankKey(m) {
  const s = String(m || "").trim();
  if (!s) return "";
  if (MANAGER_TO_KEY[s]) return MANAGER_TO_KEY[s];
  // 长名归一化（「招银理财有限责任公司」→「招银理财」）后再查精确表；
  // 注意 inferManager 对未知名默认回「工银理财」，不能盲信，仅采纳非默认结果。
  const norm = inferManager(s);
  if (norm !== "工银理财" && MANAGER_TO_KEY[norm]) return MANAGER_TO_KEY[norm];
  for (const [kw, k] of MANAGER_KEY_HINTS) if (s.includes(kw)) return k;
  return "";
}

/* --------------------------- 工行接口客户端 --------------------------- */

/**
 * 向 papi.icbc.com.cn 发 POST JSON 请求，返回解析后的 JSON；失败返回 null。
 *
 * TLS 坑（重要）：该主机握手会走「旧版不安全重协商」，OpenSSL 3 默认禁止。
 *   - Node 全局 fetch(undici) → ERR_SSL_UNSAFE_LEGACY_RENEGOTIATION_DISABLED，连不上；
 *     server.py 当年被迫改用 curl 子进程也是同一个原因。
 *     本机注入的 transport（test_transport.js）用 https + SSL_OP_LEGACY_SERVER_CONNECT 绕过。
 *   - Cloudflare Workers 出网由 Cloudflare 自己的 TLS 栈处理，无此限制 → 原生 fetch 即可。
 *
 * transport 仅为本机验证留的注入点，默认就是平台原生 fetch，生产路径不受影响。
 */
async function icbcPost(path, body, timeoutMs = UPSTREAM_TIMEOUT_MS, transport = undefined) {
  const doFetch = transport || fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await doFetch(ICBC_HOST + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        "User-Agent": UA,
        Referer: REFERER,
        Origin: ORIGIN,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      redirect: "follow",
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 取单页净值。返回 {total, list, netErr}。
 * netErr=true 表示「压根没连上上游」（网络/超时/非法响应）；
 * netErr=false 表示 upstream 有应答（哪怕业务码异常或确实 0 条）—— 两者必须区分，
 * 否则线上出故障时会被前端误当成「查无此产品」而静默降级，掩盖真实问题。
 */
async function icbcNavPage(prodId, saleTarget, page = 1, size = PAGE_SIZE, transport = undefined) {
  const d = await icbcPost(
    ICBC_NAV_EP,
    { prodId, saleTarget, pageIndex: page, pageSize: size },
    UPSTREAM_TIMEOUT_MS,
    transport
  );
  if (!d) return { total: 0, list: [], netErr: true };
  if (d.code !== 0) return { total: 0, list: [], netErr: false };
  const data = d.data || {};
  return { total: Number(data.total || 0), list: data.list || [], netErr: false };
}

/**
 * 探测该产品在哪个 saleTarget 下有净值数据。
 * 不同产品走的 saleTarget 不一样（多数是 7，个别是 5/2/9 等），必须逐个试。
 * 返回 {saleTarget, netErr}；netErr 仅在所有候选都因网络失败时才为 true。
 */
async function probeSaleTarget(prodId, targets = SALE_TARGETS, transport = undefined) {
  let netErrCount = 0;
  for (const st of targets) {
    const r = await icbcNavPage(prodId, st, 1, 10, transport);
    if (r.total) return { saleTarget: st, netErr: false };
    if (r.netErr) netErrCount++;
  }
  return { saleTarget: null, netErr: netErrCount === targets.length };
}

/**
 * 解析工行网银详情 HTML 中的额度区块。
 * 主锚点：状态图标 issuEnough/issuTension/issuNot.png（整页唯一，位于额度区块内）。
 *   图标后第一个 <div> 即状态文本：充足/紧张 → 「剩余额度XXX」（如 ">1亿元"/"8000万"）；
 *   暂无 → 仅「售罄」二字（无「剩余额度」文本！旧版 indexOf("剩余额度") 会命中
 *   JS 注释「//获取产品剩余额度」而解析为 null，导致售罄产品显示空白 —— 已修）。
 * 状态：图标 Enough/Tension → available；Not → sold_out；文本含「售罄」兜底 → sold_out。
 * 兜底：无图标时按旧逻辑以「剩余额度」文本 + 模板注释 <!-- 充足/紧张/暂无 --> 推断。
 * 文本：quotaText 去掉「剩余额度」前缀（如 ">1亿元"/"8000万"），售罄时为 "售罄"；
 *       带 > 前缀（“>1亿元”）是下界描述，不折算数值，避免谎报精确值。
 * 返回 { remainQuota, quotaState, quotaText, saleStatus, currency }；无额度区块返回 null。
 */
function parseIcbcQuotaHtml(html) {
  let quotaState = null, text = null;
  const im = html.match(/issu(Enough|Tension|Not)\.png/);
  if (im) {
    quotaState = im[1] === "Not" ? "sold_out" : "available";
    const tail = html.slice(im.index, im.index + 800);
    const tm = tail.match(/<div[^>]*>\s*([^<]{1,40}?)\s*<\/div>/);
    if (tm) text = tm[1].trim();
  } else {
    const i = html.indexOf("剩余额度");
    if (i < 0) return null;
    const region = html.slice(Math.max(0, i - 1500), i + 400);
    const m = html.slice(i, i + 60).match(/剩余额度\s*([^<]{1,30})</);
    text = m ? m[1].trim() : "";
    const cm = region.match(/<!--\s*(充足|紧张|暂无)\s*-->/g);
    const marker = cm ? cm[cm.length - 1] : "";
    if (/暂无/.test(marker) || /售罄/.test(text)) quotaState = "sold_out";
    else if (/充足|紧张/.test(marker)) quotaState = "available";
    else if (text && !/^[>＞]/.test(text) && !/^0/.test(text)) quotaState = "available";
    else if (/^0/.test(text)) quotaState = "sold_out";
  }
  if (/售罄/.test(text)) quotaState = "sold_out";
  let remainQuota = null;
  if (quotaState === "available" && text) {
    const pm = text.match(/剩余额度\s*([\d.]+)\s*(万|亿)/);
    if (pm) remainQuota = Number(pm[1]) * (pm[2] === "亿" ? 1e8 : 1e4);
  }
  if (!quotaState && !text) return null;
  const quotaText = text ? text.replace(/^剩余额度/, "").trim() : null;
  return { remainQuota, quotaState, quotaText: quotaText || null, saleStatus: null, currency: "CNY" };
}

/**
 * 取工行个人网银 NoSession 详情页 HTML（免登录，GBK）。额度失败一律返回 null（静默），
 * 绝不影响净值主链路。名称/额度均从这一页解析，故抽为共享取数，web/app 端口复用。
 */
async function icbcMybankDetailHtml(code, transport = undefined) {
  const doFetch = transport || fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    // transData 结构照抄浏览器原文：{code}@1@$$$$${code}$$$0$1$11/ALL$1（$ @ / 均为 URL 合法字符，不编码）
    const url = ICBC_MYBANK_HOST +
      "/servlet/ICBCBaseReqServletNoSession?dse_operationName=per_FinanceProductDetailNSOp" +
      "&productId=" + encodeURIComponent(code) +
      "&transData=" + code + "@1@$$$$$" + code + "$$$0$1$11/ALL$1" +
      "&Area_code=0200&requestChannel=302";
    const res = await doFetch(url, {
      method: "GET",
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Referer: "https://mybank.icbc.com.cn/servlet/ICBCPERBANKLocationServiceServlet",
      },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    try { return new TextDecoder("gbk").decode(buf); } catch (e) { return null; }
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 抓工行单产品额度（个人网银 NoSession 详情页，免登录，GBK）。
 * 额度失败一律返回 null（静默），绝不影响净值主链路。
 */
async function icbcQuota(code, transport = undefined, html = undefined) {
  const h = html != null ? html : await icbcMybankDetailHtml(code, transport);
  if (!h) return null;
  return parseIcbcQuotaHtml(h);
}

/**
 * 从 NoSession 详情 HTML 解析产品名。
 * 主锚点：on_submit('formhis','CODE','NAME',...) —— 名称即第 3 个单引号参数，实测自营/代销
 *   两种产品均命中，且与 web 端口(papi prodName)口径完全一致：
 *   26G5411A → 工银理财·核心优选最短持有30天固收增强开放（26G5411A）；WFQ1D5A → 中银理财-稳富全球配置日开05。
 * 兜底：① 自营「NAME（CODE）」；② 代销「NAME CODE」空格分隔。manager 由名称前缀 inferManager 抽取。
 */
function parseIcbcName(html, code) {
  const esc = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let m = html.match(new RegExp("on_submit\\([^,]+,\\s*['\"]" + esc + "['\"]\\s*,\\s*['\"]([^'\"]{2,80})['\"]"));
  if (m && m[1].trim()) return m[1].trim();
  m = html.match(new RegExp("([\\u4e00-\\u9fa5A-Za-z0-9·][\\u4e00-\\u9fa5A-Za-z0-9·]{1,78})（" + esc + "）"));
  if (m) return m[1].trim() + "（" + code + "）";
  m = html.match(new RegExp("([\\u4e00-\\u9fa5A-Za-z0-9·\\-][\\u4e00-\\u9fa5A-Za-z0-9·\\-]{1,78})\\s+" + esc + "(?![A-Za-z0-9])"));
  if (m) return m[1].trim();
  return null;
}

/**
 * app 端口元数据：从 NoSession 详情 HTML 解析产品名 + 额度。
 */
async function icbcAppMeta(code, transport = undefined) {
  const html = await icbcMybankDetailHtml(code, transport);
  if (!html) return null;
  const out = {};
  const name = parseIcbcName(html, code);
  if (name) out.name = name;
  const q = parseIcbcQuotaHtml(html);
  if (q) {
    out.remainQuota = q.remainQuota;
    out.quotaState = q.quotaState;
    out.quotaText = q.quotaText;
    out.saleStatus = q.saleStatus;
    out.currency = q.currency;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * app 端口全量净值：AsynGetDataServlet（tranCode=A00682，chartTimeFlag=6 自成立以来）。
 * 返回 {series:[[YYYY-MM-DD, unitNav],...], kind:"nav"}；现金管理类（单位净值恒1）/未收录返回 null。
 * 【项目规则 2026-10-21】现金管理类一律不抓：app 端口恒 1 即排除，交 web 端口再按 prodType 排除一道。
 */
async function icbcAppNav(code, transport = undefined) {
  const doFetch = transport || fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const body = "tranCode=A00682&productid=" + encodeURIComponent(code) +
      "&tagFlag=1&chartTimeFlag=6&tranFlag=0&detailFlag=1";
    const res = await doFetch(ICBC_MYBANK_HOST + ICBC_ASYN_EP, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "User-Agent": UA,
        Referer: "https://mybank.icbc.com.cn/icbc/newperbank/perbank3/frame/frame_index.jsp?serviceId=PBL20111002",
      },
      body,
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) return null;
    const d = await res.json().catch(() => null);
    if (!d) return null;
    let wd, vv;
    try { wd = JSON.parse(d.workDateListJson || "[]"); vv = JSON.parse(d.valueListJson || "[]"); }
    catch (e) { return null; }
    if (!Array.isArray(wd) || !Array.isArray(vv) || wd.length < 2 || wd.length !== vv.length) return null;
    const series = [];
    for (let i = 0; i < wd.length; i++) {
      const ds = String(wd[i] || "");
      if (!/^\d{8}$/.test(ds)) continue;
      const v = parseFloat(vv[i]);
      if (!Number.isFinite(v)) continue;
      series.push([ds.slice(0, 4) + "-" + ds.slice(4, 6) + "-" + ds.slice(6, 8), v]);
    }
    if (series.length < 2) return null;
    // 净值型判定：单位净值须有明显波动才采用。现金管理类单位净值恒 1.0（无波动）→ 返回 null。
    // 【项目规则】现金管理类不抓不处理（历史上的「web 端口 prodType=0 万份收益复利合成」已删除），
    // 恒 1 序列没有收录价值，直接排除，避免把常量 1.0 当净值。
    let mn = Infinity, mx = -Infinity;
    for (const p of series) { if (p[1] < mn) mn = p[1]; if (p[1] > mx) mx = p[1]; }
    if (mx - mn < 1e-6) return null;
    series.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    return { series, kind: "nav" };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * app 端口抓取（AsynGetDataServlet 全量净值 + NoSession 名称/额度，两请求并行，navPort="app"）。
 * 【2026-10-25 精度修正】该端口单位净值只返回 4 位（如 1.0140），前端补位成 1.014000 后
 * 与官网（papi 披露，6 位：1.014022）失真。故现作为 papi 官网端口的兜底：仅当官网未收录 /
 * 官网异常时才回落本端口（精度较低，会补位，仅作兜底）。净值型产品 series>=2 即采用；
 * 现金管理类 / 未收录 / app 异常 → 返回 null，交 papi 官网端口（主源）。
 */
async function icbcAppFetch(code, transport = undefined) {
  const [nav, meta] = await Promise.all([
    icbcAppNav(code, transport),
    icbcAppMeta(code, transport),
  ]);
  if (!nav || !nav.series || nav.series.length < 2) return null;
  const name = (meta && meta.name) || code;
  return {
    name,
    manager: inferManager(name),
    established: nav.series[0][0],
    establishedFromSeries: true, // icbc app 端口无成立日字段（AsynGetDataServlet 只回净值序列）
    series: nav.series,
    kind: nav.kind,
    source: "live",
    navPort: "app",
    remainQuota: meta ? (meta.remainQuota != null ? meta.remainQuota : null) : null,
    quotaState: meta ? (meta.quotaState != null ? meta.quotaState : null) : null,
    quotaText: meta ? (meta.quotaText != null ? meta.quotaText : null) : null,
    saleStatus: meta ? (meta.saleStatus != null ? meta.saleStatus : null) : null,
    currency: meta ? (meta.currency != null ? meta.currency : null) : null,
  };
}

/**
 * 从工行个人网银 NoSession 详情 HTML 解析「净值历史预览表」（服务端渲染，6 位精度、T+0 实时）。
 * 该表只内嵌最近若干天（通常 4 行：净值日期 / 单位净值 / 累计净值 / 备注），全量历史仍走 papi 披露端口。
 * 用途：弥补官网披露端口(papi) T+1 滞后——用本表 6 位最新点覆盖/补齐 papi 缺失的最新一天，
 *   使最终序列既全量、又 6 位、又 T+0，与官网 mybank 产品页逐点一致。
 * 返回 {series:[[YYYY-MM-DD, 单位净值],...] 升序, kind:"nav"}；无表/解析失败返回 null。
 */
function parseIcbcNavTable(html) {
  if (!html) return null;
  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let best = null, m;
  while ((m = tableRe.exec(html))) {
    const body = m[1];
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const series = [];
    let r;
    while ((r = trRe.exec(body))) {
      const tds = [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
        .map((x) => x[1].replace(/<[^>]+>/g, "").trim());
      if (tds.length < 2) continue;
      const ds = tds[0].trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ds)) continue;
      const v = parseFloat(tds[1].trim()); // 单位净值 = 第一个数值列
      if (!Number.isFinite(v) || v <= 0) continue;
      series.push([ds, v]);
    }
    if (series.length && (!best || series.length > best.length)) {
      series.sort((a, b) => (a[0] < b[0] ? -1 : 1));
      best = { series, kind: "nav" };
    }
  }
  return best;
}

/**
 * web 端口（官网披露 papi.icbc.com.cn）抓净值：getNetValueList 全量历史，saleTarget 逐个探测。
 * 口径（项目规则 2026-10-21 立）：
 *   prodType="1"(或其它非"0") → value 即单位净值，直接用（固收产品路径）；
 *   prodType="0"             → value 是万份收益（totValue 是 7日年化%）＝现金管理类
 *                              → 直接返回 null 排除。历史上的「复利合成单位净值」处理已删除：
 *                              把万份收益当单位净值喂引擎会得到荒谬结果（0.33→0.31 算成 -7%），
 *                              而复利合成又把现金类伪装成净值型放行，两条路都不可取。
 * navPort="web"；papi 无额度，仍附带 NoSession(个人网银 mybank) 额度兜底。
 */
async function icbcWebFetch(code, opts = {}) {
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const size = opts.size ?? PAGE_SIZE;
  const transport = opts.transport;

  const probe = await probeSaleTarget(code, opts.targets, transport);
  if (!probe.saleTarget) {
    // 所有候选 saleTarget 都因网络失败 → 这是「上游不可达」，绝不能报成「查无此产品」
    if (probe.netErr) {
      const e = new Error("upstream unreachable: papi.icbc.com.cn");
      e.upstream = true;
      throw e;
    }
    return null; // upstream 正常应答但各 saleTarget 均无数据 = 真的未收录该代码
  }
  const saleTarget = probe.saleTarget;

  let rows = [];
  let total = 0;
  for (let page = 1; page <= maxPages; page++) {
    const pageData = await icbcNavPage(code, saleTarget, page, size, transport);
    if (!pageData.list.length) break;
    rows = rows.concat(pageData.list);
    total = pageData.total || total;
    if (total && rows.length >= total) break;
  }

  // 只保留有日期的记录，并按日期升序（引擎要求 series 按时间递增）
  rows = rows.filter((r) => r && r.workDate);
  if (!rows.length) return null;
  rows.sort((a, b) => (String(a.workDate) < String(b.workDate) ? -1 : 1));

  const name = rows[0].prodName || code;
  const prodType = String(rows[0].prodType ?? "");

  // 【项目规则 2026-10-21 立】只收录有净值的固收产品：prodType="0" 是工行官网的
  // 现金管理类口径（value=万份收益、totValue=七日年化%），直接返回 null 排除；
  // 历史上的「从 1.0 复利合成单位净值 + kind:"wan"」处理已删除，勿再 reintroduce。
  if (prodType === "0") return null;
  const series = [];
  for (const r of rows) {
    const v = parseFloat(r.value);
    if (!Number.isFinite(v)) continue;
    series.push([r.workDate, v]);
  }

  if (!series.length) return null;

  const out = {
    name,
    manager: inferManager(name),
    established: series[0][0],
    establishedFromSeries: true, // icbc web 端口（papi 披露）无成立日字段
    series,
    kind: "nav",
    source: "live",
    navPort: "web",
  };
  // 额度（2026-10-12 新增）：个人网银 NoSession 详情页，免登录。
  // 附带在 icbcLive 返回值上，fetchProductFull 第4步（nav/bankInfo 任一带额度即采用）自动生效。
  // 失败静默 → 不带额度字段 → 前端显示空白（未知），绝不影响净值主链路。
  try {
    const q = await icbcQuota(code, transport, opts.html); // 复用 icbcLive 已抓取的详情 HTML，避免重复请求
    if (q) {
      out.remainQuota = q.remainQuota;
      out.quotaState = q.quotaState;
      out.quotaText = q.quotaText;
      out.saleStatus = q.saleStatus;
      out.currency = q.currency;
    }
  } catch (e) { /* 额度失败不影响净值 */ }
  return out;
}

/**
 * 工行净值抓取（2026-10-25 方案 A：官网 mybank 同款 6 位精度 + T+0 实时）。
 * 三条数据源协同：
 *  ① 官网披露端口 papi（icbcWebFetch）：全量历史、6 位精度，但 T+1 滞后（缺最新一天）——主历史源；
 *  ② 个人网银 mybank 详情页预览表（parseIcbcNavTable）：最近若干天、6 位精度、T+0 实时——补/覆盖最新几天；
 *  ③ 兜底 AsynGetDataServlet（icbcAppNav）：全量但仅 4~5 位（补位失真），仅当 ①② 都不可用时回落。
 * 合并策略：以 papi 全量 6 位历史为主，用 mybank 6 位最新表覆盖/补齐 papi 缺失的最新一天，
 *   故最终序列既全量、又 6 位、又 T+0，与官网 mybank 产品页逐点一致（根治旧 1.015090 残留 bug）。
 * 名称/额度仍从 mybank 详情页 NoSession 解析（用户「额度在 app 端口」诉求不变）。
 */
export async function icbcLive(code, opts = {}) {
  const transport = opts.transport;
  // 【2026-10-23 用户规则】刷信息只刷信息、刷额度只刷额度——两者都不抓净值。
  // 工行 App 端口：icbcAppMeta（NoSession 详情页解析 名称 + 额度），此处只取 meta，不碰净值。
  if (opts.mode === "info" || opts.mode === "quota") {
    const meta = await icbcAppMeta(code, transport).catch(() => null);
    if (!meta) return null;
    return {
      name: meta.name || code,
      manager: inferManager(meta.name || code),
      established: null,
      series: [],
      kind: "nav",
      remainQuota: meta.remainQuota != null ? meta.remainQuota : null,
      quotaState: meta.quotaState != null ? meta.quotaState : null,
      quotaText: meta.quotaText != null ? meta.quotaText : null,
      saleStatus: meta.saleStatus != null ? meta.saleStatus : null,
      currency: meta.currency || null,
      source: "live",
      navPort: "app",
      infoOnly: true,
    };
  }

  // 1) mybank 详情页 HTML（一次抓取）：解析 名称 + 额度 + 6 位最新净值表(T+0)
  const html = await icbcMybankDetailHtml(code, transport).catch(() => null);
  let meta = null, table = null;
  if (html) {
    const name = parseIcbcName(html, code);
    const q = parseIcbcQuotaHtml(html);
    if (name || q) {
      meta = {};
      if (name) meta.name = name;
      if (q) {
        meta.remainQuota = q.remainQuota; meta.quotaState = q.quotaState;
        meta.quotaText = q.quotaText; meta.saleStatus = q.saleStatus; meta.currency = q.currency;
      }
    }
    table = parseIcbcNavTable(html);
  }

  // 2) 官网披露 papi 全量 6 位历史（T+1）；复用本已抓取的 mybank 详情 HTML 取额度，不重复请求
  let web = null;
  try { web = await icbcWebFetch(code, { ...opts, html }); } catch (e) { web = null; }

  // 3) 合并：papi 全量(6 位) 为主，mybank 6 位最新表(T+0) 覆盖/补齐最近几天
  let series, navPort;
  const base = (web && web.series && web.series.length >= 2) ? web.series : null;
  if (base) {
    series = mergeNavByDate(base, table ? table.series : null);
    navPort = "web"; // 主源为官网披露；mybank 仅补最新几天（T+0），使最新一天不再滞后/失真
  } else if (table && table.series && table.series.length) {
    // papi 不可用 → AsynGetDataServlet 全量(4~5 位) + mybank 最新覆盖，至少最新几天精准
    const app = await icbcAppNav(code, transport).catch(() => null);
    series = mergeNavByDate(app ? app.series : [], table.series);
    navPort = app ? "app" : "mybank";
  } else if (web && web.series && web.series.length >= 2) {
    series = web.series; navPort = "web";
  } else {
    // ①② 皆不可用 → 回落旧 app 端口（4~5 位，仅兜底）
    const app = await icbcAppFetch(code, transport);
    if (!app || !app.series || app.series.length < 2) return null;
    series = app.series; navPort = "app";
  }

  // 净值型判定：单位净值须有明显波动；现金管理类（恒 1.0）排除，不抓。
  let mn = Infinity, mx = -Infinity;
  for (const p of series) { if (p[1] < mn) mn = p[1]; if (p[1] > mx) mx = p[1]; }
  if (mx - mn < 1e-6) return null;

  const name = (meta && meta.name) || (web && web.name) || code;
  const out = {
    name,
    manager: inferManager(name),
    established: series[0][0],
    establishedFromSeries: true, // icbc 端口均无成立日字段
    series,
    kind: "nav",
    source: "live",
    navPort,
  };
  // 额度（NoSession 个人网银 mybank 详情页，免登录）；优先用本函数已解析的 meta，缺失时回落 web(papi 路径已附带)。
  // 只要任一额度字段存在即附带（remainQuota 可能为空，但 quotaText 如 ">1亿元" 仍有意义），失败静默，不影响净值主链路。
  const qsrc = (meta && (meta.remainQuota != null || meta.quotaText != null)) ? meta : (web || {});
  if (qsrc && (qsrc.remainQuota != null || qsrc.quotaText != null || qsrc.quotaState != null)) {
    out.remainQuota = qsrc.remainQuota != null ? qsrc.remainQuota : null;
    out.quotaState = qsrc.quotaState != null ? qsrc.quotaState : null;
    out.quotaText = qsrc.quotaText != null ? qsrc.quotaText : null;
    out.saleStatus = qsrc.saleStatus != null ? qsrc.saleStatus : null;
    out.currency = qsrc.currency != null ? qsrc.currency : null;
  }
  return out;
}

/* ==========================================================================
 * 中国银行（手机银行）净值代理
 *
 * 为什么需要它：中行手机银行 SPA 的净值数据走服务端网关，且 ebsnew.boc.cn 没有
 * CORS 头，浏览器直连必被同源策略拦截（与 ICBC / 中国理财网同理）。Worker 在服务端
 * 发请求，再以 Access-Control-Allow-Origin: * 回给前端。
 *
 * 网关契约（无需登录，browser 带不带 cookie 都能查）：
 *   POST https://ebsnew.boc.cn/BMPS/_bfwajax.do?_locale=zh_CN
 *   请求体: json=<urlencode({header, method, params})>
 *
 * 关键交易码（2026-10-17 经 CDP 无头 Chrome + MicroMessenger/iPhone UA 抓包确认）：
 *   PsnxWmpProductDetailQueryOutlay 产品详情（★核心）。**必须带 isNewVersion:"Y"**：
 *     这是手机银行 bocFinanceDetail 页面用的那一版；缺该字段服务端直接回 result:{}（0 键），
 *     旧实现的「额度/最短持有恒 null」即栽在此处。带上后一次回 211 个字段：
 *       productName / managerCode / managerName / riskLevel / regCode /
 *       establishDate / periodTerm / dayPerPeriod / dayPerPeriodWord /
 *       benchmarkWord(业绩基准原文) / productSize(存续规模) / indiAmtRem /
 *       subPosUp(个人持仓上限) / purPosUp(单日申购上限) / saleState / productState /
 *       isQuotaTension(Y=额度紧张) / nav / updateDate / newYield。
 *   PsnxWmpProductSummaryQueryOutlay 产品概要：productShortName / productLongName、
 *     debtRegistrationCode(登记编码)、customerRiskLevels(风险等级 C2..C5，取最低档映射 R)、
 *     performanceBenchmark(业绩基准)。现仅作详情缺失项兜底。
 *   PsnxWmpHistoryNavQueryOutlay   历史净值序列：list[{updateDate, nav, accumulativeNav,
 *     dayIncomeRatio(当日收益率%), fundIncome(万份收益)}]，参数 circle 取 3M/6M/1Y/3Y
 *     （必填 subChannelId:"31"，缺省返回 0 条；1M/1Y 对极新产品可能返回 0，3Y 稳定）。
 *   PsnxWmpProductYieldQueryOutlay 近期业绩（近1月/近3月/今年以来/成立以来年化+区间涨跌）。
 *   PsnxWmpManagerListQueryOutlay  管理人（managerCode 如 ZY1）→ 招银理财。
 *
 * App 端口链接形如
 *   https://ebsnew.boc.cn/bocphone/VueLocalCli4/bocFinanceDetail/index.html
 *     #/productDetail?functionCode=bocFinanceProductDetail&productId=668313D&lastShortUrl=...
 * 页面本身无鉴权，网关请求只比 web 端多 isNewVersion:"Y"，因此本代理直接用 fetch 打
 * _bfwajax.do 即可，运行期不需要起浏览器（浏览器只用于抓包定位该开关）。
 *
 * 与 ICBC 不同，中行「详情 + 历史净值」即可拿到全部前端所需字段（含风险等级/最短持有期），
 * 无需再跨库补元数据；本代理仍把概要作为兜底，并把风险/登记编码/业绩基准一起返回。
 *
 * 口径（项目规则 2026-10-21 立）：series 一律是「单位净值」（与前端引擎约定一致）。
 *   - 净值型：nav 随日期变化 → 直接取用；
 *   - 现金管理类（如 HXTT01D 惠享天天）：nav 恒为 1.0，真实收益在 fundIncome(万份收益)
 *     → 按项目规则直接排除（return null），历史上的「从 1.0 复利合成」处理已删除。
 */

const BOC_HOST = "https://ebsnew.boc.cn";
const BOC_PATH = "/BMPS/_bfwajax.do?_locale=zh_CN";
const BOC_SUB_CHANNEL = "31"; // 理财销售渠道，缺省返回 0 条净值

// 构造网关 header（uuid 用当前时间戳即可，服务端不校验）
function bocHeader() {
  return {
    agent: "WEB15", version: "3.1.9", device: "WEB15", platform: "WEB15",
    plugins: "5", page: "6", local: "zh_CN", uuid: String(Date.now()),
    ext: "8", cipherType: "0", appSequence: "",
  };
}

// 风险等级：customerRiskLevels 形如 "C2,C3"（区间），取最低档 → R。C1..C5 → R1..R5。
function bocRiskFromLevels(s) {
  if (!s) return null;
  const map = { C1: "R1", C2: "R2", C3: "R3", C4: "R4", C5: "R5" };
  const min = s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => map[x])
    .sort()[0];
  return min ? map[min] : null;
}

// 向中行网关发 POST（body=json=<urlencode({header,method,params})>）。
// 返回 {status, text, json, err}：status=0 表示压根没连上（超时/被拒/TLS 失败），
// json=null 表示拿到了响应但不是合法 JSON。
// 刻意保留 status/text 而非只回 null：银行侧对「非浏览器出网」会直接拒绝，
// 只有原始状态码和响应体能区分「被墙/被拦截」与「接口真的没数据」。
// 中行网关对 Workers 出网基本不服务：本机直连秒回，Workers 侧绝大多数请求超时
// （实测：一开始偶有 1.6~2.5s 的成功，随后 0/6 全超时，判断为对 Cloudflare 出网 IP 限流/封堵）。
// 因此策略改为「快速失败 + 缓存成功」：
//   单次 9s、重试 1 次 → 最坏 18s，刻意压在前端 httpJson 的 20s 超时之下，
//   这样前端能拿到干净的 502 立刻降级到内嵌快照，而不是被自己的超时中断。
//   一旦偶发成功，结果会进 Cache API 缓存 6 小时，后续请求瞬时命中。
const BOC_TIMEOUT_MS = 9000;
const BOC_ATTEMPTS = 2;

async function bocPostOnce(method, params, transport = undefined) {
  const doFetch = transport || fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BOC_TIMEOUT_MS);
  try {
    const body = "json=" + encodeURIComponent(JSON.stringify({ header: bocHeader(), method, params }));
    const res = await doFetch(BOC_HOST + BOC_PATH, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Accept: "application/json",
        "User-Agent": UA,
      },
      body,
      signal: ctrl.signal,
      redirect: "follow",
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, text, json };
  } catch (e) {
    return { status: 0, text: "", json: null, err: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

// 带重试的入口：拿到合法 JSON 立刻返回，否则重试；全失败则返回最后一次结果（含诊断信息）。
// sink：耗时采集数组（由 fetchProductFull 经 opts.__sink 下传，见 navTiming 注释），可空。
async function bocPost(method, params, transport = undefined, sink = null) {
  let last = null;
  for (let i = 0; i < BOC_ATTEMPTS; i++) {
    const t = Date.now();
    const r = await bocPostOnce(method, params, transport);
    navTiming(sink, "boc." + method.replace(/^PsnxWmp/, "") + "#试" + (i + 1), Date.now() - t,
      r.json ? "json ok" : "失败 status=" + r.status + (r.err ? " " + r.err : ""));
    if (r.json) return r;
    last = r;
  }
  return last;
}

// 把上游失败原因拼进 error.message：线上排障时这是唯一线索。
function bocUpstreamError(r, stage) {
  let detail;
  if (!r) detail = "no response";
  else if (r.status === 0) detail = "connect failed: " + (r.err || "unknown");
  else detail = "HTTP " + r.status + " body=" + String(r.text || "").slice(0, 160).replace(/\s+/g, " ");
  const e = new Error("upstream unreachable: ebsnew.boc.cn [" + stage + "] " + detail);
  e.upstream = true;
  return e;
}

/**
 * 取中行产品的概要 + 完整净值序列。
 * 返回与 icbcLive 完全一致的契约：{name, manager, established, series, kind, source:"live"}，
 * 并额外携带 risk / regCode / benchmark（中行免费提供，前端可直接用，省去元数据补抓）。
 *
 * 判定：
 *   bocPost 拿不到合法 JSON → 上游网络失败/被拦截，抛 upstream 异常（入口转 502，
 *     前端降级到内嵌快照）；message 带上游状态码与响应体片段，便于线上排障；
 *   概要存在但 productShortName 为空 → 真的未收录该产品 → 返回 null（入口转 404）；
 *   概要有、净值序列为空 → 产品存在但尚无数（极新），返回 null（前端回退快照）。
 */
// 中银币种代码 → 字母码（BOC 网关 currencyCode：014=USD，其余多数=CNY）。
// 仅精确映射已知币种，未知回落 null，前端 fmtQuota 默认按「元」显示（对人民币产品即正确）。
function bocCurrency(code) {
  const m = { "014": "USD", "840": "USD", "001": "CNY", "156": "CNY" };
  return m[String(code == null ? "" : code).trim()] || null;
}

// 最短持有天数（App 端口新增能力）。中行详情给三个可用口径，按可靠度取：
//   ① dayPerPeriod   每持有期天数（如「持有90天后可赎」→ 90）
//   ② dayPerPeriodWord 文案兜底解析：「持有90天后可赎」/「持有30天后可赎回」
//   ③ periodTerm     产品期限（固收类有时会回填，作最后兜底）
// dayPerPeriod 为 "0" 视为每日开放 → 1 天。取不到返回 null（交由名称解析接管）。
function bocHoldDays(det) {
  if (!det) return null;
  const d = Number(det.dayPerPeriod);
  if (Number.isFinite(d) && d > 0) return d;
  const word = String(det.dayPerPeriodWord || "");
  const m = /持有\s*(\d+)\s*天/.exec(word);
  if (m) return Number(m[1]);
  const p = Number(det.periodTerm);
  if (Number.isFinite(p) && p > 0) return p;
  return null;
}

export async function bocFetch(code, opts = {}) {
  const sub = opts.subChannelId || BOC_SUB_CHANNEL;
  const circle = opts.circle || "3Y";
  const transport = opts.transport;
  const sink = opts.__sink || null; // 耗时采集（fetchProductFull 下传）
  // 2026-10-22 修复：nav 模式只抓净值（跳过产品详情/概要/额度接口）；quota 模式只抓额度（跳过净值/信息）。
  const __navMode = opts.mode === "nav";
  const __quotaMode = opts.mode === "quota";
  const __infoMode = opts.mode === "info";

  // ── 详情（App 端口版）：isNewVersion:"Y" 是手机银行 bocFinanceDetail 页面用的那一版，
  //    实测缺这个字段服务端直接回 result:{}（0 个键）——旧实现里「额度/最短持有恒 null」
  //    就是栽在这里，而不是产品没披露。带上它一次回 211 个字段：
  //      regCode(登记编码) / riskLevel(R2) / establishDate(成立日) /
  //      periodTerm+dayPerPeriod(最短持有期) / benchmarkWord(业绩比较基准原文) /
  //      managerName(管理人) / productSize(存续规模) / subPosUp+purPosUp(申购上限) / newYield。
  //    因此详情优先，概要只作缺失项兜底。
  let det = null;
  if (!__navMode) {
    try {
      const dr = await bocPost(
        "PsnxWmpProductDetailQueryOutlay",
        { productId: code, subChannelId: sub, isNewVersion: "Y" },
        transport,
        sink
      );
      const rr = dr && dr.json && dr.json.result;
      if (rr && Object.keys(rr).length) det = rr;
    } catch (e) { /* 详情失败不致命：回落概要 + 净值 */ }
  }

  let name = det ? (det.productName || "") : "";
  let regCode = det ? (det.regCode || null) : null;
  let riskRaw = det ? (det.riskLevel || null) : null; // 已是 R2 这类规范档
  let benchmark = det ? (det.benchmarkWord || null) : null;

  // 概要兜底（+ 业绩基准的第二来源）。四项都已齐全时不再打这一枪。
  let rs = {};
  const needSummary = !name || !regCode || !riskRaw || !benchmark;
  if (!__navMode && !__quotaMode && needSummary && !(opts.summaryComplete && (opts.sRegCode || opts.sRisk || opts.sBenchmark || opts.sName))) {
    const summary = await bocPost("PsnxWmpProductSummaryQueryOutlay", { productId: code, subChannelId: sub }, transport, sink);
    if (!summary.json) {
      // 详情已经拿到东西就不因概要失败而整体失败
      if (!det) throw bocUpstreamError(summary, "summary");
    } else {
      rs = summary.json.result || {};
      name = name || rs.productShortName || rs.productLongName || "";
      regCode = regCode || rs.debtRegistrationCode || null;
      riskRaw = riskRaw || rs.customerRiskLevels || null;
      benchmark = benchmark || rs.performanceBenchmark || null;
    }
  }
  if (opts.summaryComplete) {
    name = name || opts.sName || "";
    regCode = regCode || opts.sRegCode || null;
    riskRaw = riskRaw || opts.sRisk || null;
    benchmark = benchmark || opts.sBenchmark || null;
  }

  let ded = [];
  if (!opts.infoOnly && !__infoMode && !__quotaMode) {
    const navResp = await bocPost("PsnxWmpHistoryNavQueryOutlay", { productId: code, subChannelId: sub, circle }, transport, sink);
    if (!navResp.json) throw bocUpstreamError(navResp, "navlist");
    const list = (navResp.json.result && navResp.json.result.list) || [];
    const rows = list
      .map((it) => ({
        date: String(it.updateDate || "").replace(/\//g, "-"),
        nav: parseFloat(it.nav),
      }))
      .filter((r) => r.date)
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    // 同日去重，保留最后一条
    for (const r of rows) {
      if (ded.length && ded[ded.length - 1].date === r.date) ded[ded.length - 1] = r;
      else ded.push(r);
    }
  }
  // 收录判据用「净值序列非空」而非「概要名称非空」：个别产品（如 HXTT01D 惠享天天）
  // 概要有数据但 productShortName 为空，按名称判会把它误杀；名称留空时前端沿用种子名/手填名。
  // quota 模式不抓净值（见上 L1042 门控），ded  legitimately 为空，不能被「无净值即 return null」拦掉，
  // 否则中行产品在刷额度时恒返回 null → 额度整列刷不到（2026-10-22 回归修复）。
  if (!opts.infoOnly && !__infoMode && !__quotaMode && !ded.length) return null; // 未收录该代码，或产品尚无任何净值

  // 净值口径（必须与前端引擎约定一致：series 一律是「单位净值」）：
  //   nav（净值型）：nav 随日期变化 → 直接取用。
  // 【项目规则 2026-10-21 立】现金管理类（nav 恒 1、真实收益在 fundIncome 万份收益）不抓：
  //   历史上的「从 1.0 复利合成 + kind:"wan"」处理已删除，恒 1 序列一律排除。
  let kind, series;
  if (opts.infoOnly) {
    // infoOnly：只取信息字段，不打历史净值那一枪；用详情口的最新净值/日期拼一个单点，
    // 让「净值来源」仍有东西可显示（前端对单点的处理与其它银行一致）。
    series = [];
    kind = null;
    if (det && Number(det.nav) > 0) {
      const d = String(det.updateDate || "").replace(/\//g, "-");
      if (d) { series = [[d, Number(det.nav)]]; kind = "nav"; }
    }
  } else if (__quotaMode || __infoMode) {
    // quota / info 模式：本就不抓净值（见上方门控），series 留空，继续往下整理额度/信息口径并返回
    series = [];
    kind = null;
  } else {
  const varies = ded.some((r) => Number.isFinite(r.nav) && Math.abs(r.nav - 1) > 1e-6);
  if (!varies) return null; // nav 恒 1 ＝现金管理类或无有效净值 → 项目规则：排除
  series = ded.map((r) => [r.date, r.nav]).filter((p) => Number.isFinite(p[1]) && p[1] > 0);
  kind = "nav";
  }
  if (!series.length && !opts.infoOnly && !__infoMode && !__quotaMode) return null;

  // ── 额度 / 规模：详情已在上方取到（det），此处只做口径整理，不再重复请求。
  //   中行对开放式产品不披露「剩余可申购金额」（indiAmtRem 恒 null），能拿到的是：
  //     productSize 存续规模（元）→ 作为额度口径落 quotaText（前端直接显示文本）
  //     subPosUp    个人持仓上限   purPosUp 单日申购上限
  //   三态判定沿用原逻辑：售罄 / 有额度 / 未知。
  let remainQuota = null, saleStatus = null, currency = null, quotaState = null, quotaText = null;
  let scale = null, buyLimitPersonal = null, buyLimitDaily = null;
  if (det) {
    currency = bocCurrency(det.currencyCode);
    // isQuotaTension=Y 标「额度紧张」；saleState/productState="0" 视为在售(ON_SALE)
    saleStatus = det.isQuotaTension === "Y" ? "TIGHT"
      : ((det.saleState === "0" || det.productState === "0") ? "ON_SALE" : (det.saleState != null ? String(det.saleState) : null));
    const indiNum = (det.indiAmtRem != null && det.indiAmtRem !== "") ? Number(det.indiAmtRem) : null;
    const saleNum = (det.saleNumRemained != null && det.saleNumRemained !== "") ? Number(det.saleNumRemained) : null;
    if (indiNum != null && Number.isFinite(indiNum)) {
      if (indiNum <= 0) quotaState = "sold_out";
      else { remainQuota = indiNum; quotaState = "available"; }
    } else if (saleNum != null && Number.isFinite(saleNum)) {
      if (saleNum <= 0) quotaState = "sold_out";
      else { remainQuota = saleNum; quotaState = "available"; }
    } else {
      quotaState = (det.saleState === "0" || det.productState === "0") ? "available" : null;
    }
    // 存续规模（元）→ 文本额度，供前端「额度」位显示（与工行 quotaText 同一条渲染路径）
    const ps = Number(det.productSize);
    if (Number.isFinite(ps) && ps > 0) {
      scale = ps;
      quotaText = "存续规模 " + (ps >= 1e8 ? (ps / 1e8).toFixed(2) + "亿元" : (ps / 1e4).toFixed(2) + "万元");
    }
    const sp = Number(det.subPosUp);
    if (Number.isFinite(sp) && sp > 0) buyLimitPersonal = sp;
    const pp = Number(det.purPosUp);
    if (Number.isFinite(pp) && pp > 0) buyLimitDaily = pp;
  }

  return {
    name,
    // 管理人：详情口的 managerName 是权威口径（`668313D` 就是「招银理财有限责任公司」，
    // 而名称里没有「招银」二字，纯靠 inferManager 会被兜底成「中银理财」）。
    // 取不到时才回落到「名字命中 → 具体管理人，否则中银理财」。
    manager: (() => {
      if (det && det.managerName) return inferManager(det.managerName) || det.managerName;
      const m = inferManager(name);
      return m !== "工银理财" ? m : "中银理财";
    })(),
    // 成立日：详情口的 establishDate 是真正的成立日（`2026/05/22`）；
    // series[0][0] 是首条净值日，含募集期（本例为 05/20），两者可能差 2 天。优先详情。
    established: (det && det.establishDate) ? String(det.establishDate).replace(/\//g, "-") : (series[0] ? series[0][0] : null),
    establishedFromSeries: !(det && det.establishDate), // det.establishDate 缺位时退序列首点（含募集期）
    series,
    kind,
    // 最短持有天数：App 端口新版详情才提供（dayPerPeriod / dayPerPeriodWord）。
    holdDays: bocHoldDays(det),
    // 风险：详情给的是 R2 这种规范档，概要给的是 "C2,C3" 区间码，两种都接。
    risk: /^R[1-9]$/.test(String(riskRaw)) ? String(riskRaw)
      : (opts.summaryComplete && opts.sRisk ? opts.sRisk : bocRiskFromLevels(riskRaw)),
    regCode: regCode || null,
    benchmark: benchmark || null,
    source: "live",
    // 与平安一致，返回完整额度对象以匹配 fetchProductFull 第4步与前端 MULTI_REAL 持久化结构。
    remainQuota,
    remainQuotaPct: null,
    saleStatus,
    currency,
    quotaState,
    // 中行开放式产品不披露「剩余可申购金额」，额度口径是存续规模 + 两类申购上限。
    quotaText,          // 如「存续规模 7507.28万元」（前端直接渲染）
    scale,              // 存续规模（元）
    buyLimitPersonal,   // 个人持仓上限（元）
    buyLimitDaily,      // 单日申购上限（元）
    managerCode: (det && det.managerCode) || null,
    navDate: (det && det.updateDate) ? String(det.updateDate).replace(/\//g, "-") : (series.length ? series[series.length - 1][0] : null),
    latestNav: (det && Number(det.nav)) || (series.length ? series[series.length - 1][1] : null),
    annualYield: (det && det.newYield != null && Number(det.newYield) > 0) ? Number(det.newYield) : null,
    // 端口：拿到 App 端口详情（isNewVersion:"Y"）标 app；只退到概要/净值时标 web。
    navPort: det ? "app" : "web",
  };
}

/* ==========================================================================
 * 邮储银行（PSBC）实时抓取
 *
 * 站点：https://wap.psbc.com/wxbank/h5/weChatShare/ （Vue SPA，微信 H5 分享页）
 * 接口基址：https://wap.psbc.com/wxbank/api/v2/00/marketing/finance
 *   queryFinancialProductDetail {productCode}            → object.productDetail
 *   queryHisProfit {pageNum,pageSize,productCode,type}   → object.profitHistory.{total,data:[{xh,gbrq,cpjz}]}
 *       type=3 单位净值（本项目只用这个口径——固收产品）；type=1 七日年化/万份收益
 *       （现金管理类口径，按项目规则不抓，psbcFetch 不再调用）
 *
 * 难点：所有 /api/v2 请求都被前端 axios 拦截器做了国密封装，明文 POST 会被拒
 *   {"respCode":"000015","respMsg":"不可访问"}。封装方式（取自 index.5ce411e8.js）：
 *   1. 生成 128-bit 随机会话密钥 key（32 位大写 hex）
 *   2. body = { data: SM4-ECB(JSON.stringify(payload), key),
 *               key:  "04" + SM2(key, 内置公钥) }
 *   3. 响应字段 object 是 SM4-ECB 密文，用同一个 key 解开
 *
 * CORS：Allow-Origin 只放行 https://wap.psbc.com，浏览器无法直连，必须走本代理。
 * 上游偶发 SSL 重协商失败，故单次限时 + 重试（与 boc 同一套抖动对策）。
 * ========================================================================== */

const PSBC_BASE = "https://wap.psbc.com/wxbank/api/v2/00/marketing/finance";
const PSBC_PUBKEY =
  "046d73cda253d12b481ffabe0ccbe586bc5367799eacef77b7d8ed4a22ab849d369396513929159e34a1f7eecc19dc67e4f929fdf4f3f1259b776f99be68c2056a";
const PSBC_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0";
const PSBC_REFERER = "https://wap.psbc.com/wxbank/h5/weChatShare/";
const PSBC_TIMEOUT_MS = 9000;
const PSBC_ATTEMPTS = 2;
const PSBC_PAGE_SIZE = 100;
// 600 条 ≈ 两年多的日频披露，足够；子请求配额 50 也很安全
const PSBC_MAX_PAGES = 6;

function psbcRandomKey() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s.toUpperCase();
}

async function psbcPost(path, payload, transport, sink = null, label = null) {
  const doFetch = transport || fetch;
  const key = psbcRandomKey();
  const body = {
    // 会话密钥本身按 UTF-8 文本用 SM2 加密（与服务端约定，勿改成按 hex 字节）
    data: gmSm4EcbEnc(JSON.stringify(payload), key),
    // 邮储服务端要求 C1 带非压缩点的 04 前缀，故这里显式补上
    key: "04" + sm2Encrypt(gmU8(key), PSBC_PUBKEY),
  };
  // 分阶段耗时采集（2026-10-14）：与 cwPostEnc 同款——子请求自报耗时（psbc.<路径>），
  // 重试以 #试N 标注。此前邮储通道完全不计时 → 列表「净值·psbc」阶段没有任何子项。
  const t0 = Date.now();
  let lastErr = null;
  let attempts = 0;
  let out = null;
  for (let i = 0; i < PSBC_ATTEMPTS; i++) {
    attempts = i + 1;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PSBC_TIMEOUT_MS);
    try {
      const res = await doFetch(PSBC_BASE + "/" + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json;charset=UTF-8",
          "User-Agent": PSBC_UA,
          Referer: PSBC_REFERER,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const j = await res.json();
      clearTimeout(timer);
      if (!j || typeof j !== "object") { lastErr = "响应非对象"; continue; }
      if (j.respCode !== "000000") { lastErr = `respCode=${j.respCode} ${j.respMsg || ""}`.trim(); continue; }
      let obj = null;
      if (j.object) {
        try { obj = JSON.parse(gmSm4EcbDec(j.object, key)); }
        catch (e) { lastErr = "解密失败: " + (e && e.message); continue; }
      }
      out = { ok: true, object: obj, raw: j };
      break;
    } catch (e) {
      clearTimeout(timer);
      lastErr = (e && e.message) || String(e);
    }
  }
  // label 仅用于时间分解显示（不改 URL）：区分 type=3 单位净值 / type=1 万份收益 与页码，
  // 否则列表里多条 psbc.queryHisProfit 用户分不清各自抓的是什么（2026-10-14 用户提问）。
  navTiming(sink, (label || ("psbc." + path)) + (attempts > 1 ? "#试" + attempts : ""), Date.now() - t0,
    out ? "ok" : ("fail " + lastErr));
  return out || { ok: false, err: `psbc/${path}: ${lastErr}` };
}

/** 翻页取全部历史（gbrq 公布日期 + cpjz 产品净值） */
async function psbcNavAll(code, type, transport, sink = null) {
  const out = [];
  for (let p = 1; p <= PSBC_MAX_PAGES; p++) {
    const r = await psbcPost("queryHisProfit", {
      pageNum: p,
      pageSize: PSBC_PAGE_SIZE,
      productCode: code,
      type: String(type),
    }, transport, sink, "psbc.queryHisProfit(" + (type === 1 ? "万份收益" : "单位净值") + "·第" + p + "页)");
    if (!r.ok) {
      if (p === 1) throw Object.assign(new Error(r.err), { upstream: true });
      break;
    }
    const h = (r.object && r.object.profitHistory) || null;
    const data = (h && h.data) || [];
    for (const it of data) {
      const d = String(it.gbrq || "").replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
      const v = parseFloat(it.cpjz);
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(v) && v > 0) out.push([d, v]);
    }
    const total = h && h.total ? Number(h.total) : 0;
    if (!data.length || (total && out.length >= total) || data.length < PSBC_PAGE_SIZE) break;
  }
  return out;
}

/**
 * 持有天数（最短持有期）。邮储接口没有直接字段，从两处文本解析：
 *   ① 赎回规则说明 shgzbs：「持有90天后每日可赎」
 *   ② 产品名称：「心盛·鸿锦最短持有90天1号A」/「稳富（30天持有期）02」
 *   ③ 日开 / 现金管理类按 T+1 记 1 天
 * 前端「添加产品」把持有天数列为必填，解析不到就留空让用户手填，不猜。
 */
function psbcHoldDays(pd, name) {
  const pick = (s, re) => {
    const m = String(s || "").match(re);
    return m ? Number(m[1]) : null;
  };
  const fromRule = pick(pd && pd.shgzbs, /持有\s*(\d+)\s*天/);
  if (fromRule) return fromRule;
  const n = String(name || "");
  const a = pick(n, /最短持有\s*(\d+)\s*天/);
  if (a) return a;
  const b = pick(n, /(\d+)\s*天持有期/);
  if (b) return b;
  if (/日开|天天|现金管理|货币|活期/.test(n)) return 1;
  return null;
}

// 邮储/中邮币种数字码(ISO 4217 numeric) → 字母码，供前端 fmtQuota 显示「元/美元」
function psbcCurrency(num) {
  const m = { "156": "CNY", "001": "CNY", "840": "USD", "826": "GBP", "392": "JPY", "036": "AUD", "978": "EUR", "702": "SGD", "344": "HKD" };
  return m[String(num == null ? "" : num).trim()] || null;
}

/* ==========================================================================
 * 中邮理财官网（www.psbc-wm.com）—— 发行方权威净值 / 信息源（2026-10-23 接入）
 *
 * 为什么加：邮储母行微信端口 wap.psbc.com 的净值**比发行人官网慢一个披露日**，
 *   且详情口不返回登记编码（每轮都要多跑一次中国理财网名检索，实测 +3~8s）。
 *   实测 2501MC018A（灵活·鸿运最短持有14天18号A）：
 *     官网 10-23 已披露 1.0180，母行只到 10-22 → 用户 2026-10-23 报障的直接成因；
 *     官网 search 直接给 wp_registration_code=Z7001925000554（母行恒 null）。
 *
 * 接口（免登录、免签名、免 Cookie、**JSON API 不过瑞数 WAF**——只有 HTML 页面回 412）：
 *   ① GET /pswm-api/product/search?keywords=<码>
 *      → data.list[]：wp_name / wp_code / wp_registration_code(登记编码) /
 *        prd_risk_rate("2"→R2) / wp_establish_date(成立日 YYYYMMDD) /
 *        update_date(最新净值日) / nav(最新单位净值) / performance_comparison(基准全文)
 *   ② GET /pswm-api/product/nvlist?wp_code=<码>&pageSize=10&pageNum=N
 *      → data.list[]：update_date(YYYYMMDD) / nav(单位净值) / accumulative_nav；
 *        按日期**倒序**；totalRow=全量点数、totalPage=总页数。
 *        ⚠ pageSize 服务端硬压到 10（传 100/500 也只回 10 条），故需按页翻；
 *          实测 2501MC018A 249 点/25 页（含成立日 2025-10-23 至当日），
 *          2501NZ005A 113 点/12 页 —— **官网给的是成立以来全量，不是滚动窗口**。
 *   ③ GET /pswm-api/product/bjjz?wp_code=<码> → data = 业绩比较基准全文
 *
 * 覆盖边界：仅中邮理财发行的产品（他行理财子代销品 search 返回空 → 自动回落母行端口）。
 * 访问约束：服务端用旧版不安全 TLS 重协商，Node 全局 fetch 会报
 *   ERR_SSL_UNSAFE_LEGACY_RENEGOTIATION_DISABLED —— 本机由 serve.mjs 的 nodeTransport
 *   （SSL_OP_LEGACY_SERVER_CONNECT）出网，故调用方必须传 transport。
 * ========================================================================== */
const PSBCWM_HOST = "https://www.psbc-wm.com";
const PSBCWM_REF = PSBCWM_HOST + "/products_index/index.html";
const PSBCWM_TIMEOUT_MS = 12000;
const PSBCWM_PAGE_SIZE = 10;   // 服务端硬上限，传更大也只回 10
const PSBCWM_MAX_PAGES = 60;   // 600 点上限，防畸形 totalPage 把循环拖长
const PSBCWM_CONC = 6;         // 并发翻页批大小（纯 JSON 小包，6 路实测稳定）

async function psbcwmGet(path, transport) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PSBCWM_TIMEOUT_MS);
  try {
    const res = await (transport || fetch)(PSBCWM_HOST + path, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json, text/plain, */*",
        Referer: PSBCWM_REF,
      },
      signal: ctrl.signal,
    });
    if (!res || !res.ok) return null;
    const j = await res.json().catch(() => null);
    return j && j.state === "ok" ? j : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// "20261023" → "2026-10-23"
function psbcwmYmd(s) {
  const t = String(s || "");
  return /^\d{8}$/.test(t) ? t.slice(0, 4) + "-" + t.slice(4, 6) + "-" + t.slice(6, 8) : null;
}

// 拉历史净值（首页定 totalPage，其余页 6 并发分批）。
// since 给定时走增量：DESC（page 1 最新），只保留 > since 的点，并在追上 since 的页提前停翻页，
// 避免重翻全量历史（中邮 249 点=25 页，日常刷新只需 page 1 即可）。since 缺失 → 全量（添加产品）。
// 返回 { rows, ok }：ok=false 表示首页就没数据（抓取失败/产品未收录），
// 增量腿据此区分「无新增点(=已是最新)」与「抓不到(=该走兜底)」。
async function psbcwmRows(code, transport, since) {
  const base = "/pswm-api/product/nvlist?wp_code=" + encodeURIComponent(code) + "&pageSize=" + PSBCWM_PAGE_SIZE + "&pageNum=";
  const first = await psbcwmGet(base + "1", transport);
  const d = first && first.data;
  if (!d || !Array.isArray(d.list) || !d.list.length) return { rows: [], ok: false };
  const keepNew = (list) => (list || []).filter((r) => {
    const dt = psbcwmYmd(r && r.update_date);
    return dt && dt > since; // 只留 since 之后（不含）的缺失/新增点
  });
  if (since) {
    let kept = keepNew(d.list);
    const total = Math.min(Math.max(1, Number(d.totalPage) || 1), PSBCWM_MAX_PAGES);
    const oldest1 = psbcwmYmd(d.list[d.list.length - 1] && d.list[d.list.length - 1].update_date);
    // page 1 最旧点已 <= since → 后续页更旧，无需再翻（日常刷新到此即可）
    if (!(oldest1 && oldest1 <= since) && total > 1) {
      for (let p = 2; p <= total; p++) {
        const r = await psbcwmGet(base + p, transport).catch(() => null);
        const l = r && r.data && r.data.list;
        if (l && l.length) {
          kept = kept.concat(keepNew(l));
          const oldest = psbcwmYmd(l[l.length - 1] && l[l.length - 1].update_date);
          if (oldest && oldest <= since) break; // 追上，停止翻页
        }
        if (!l || l.length < PSBCWM_PAGE_SIZE) break; // 末页（短页即停）
      }
    }
    return { rows: kept, ok: true };
  }
  // 全量（添加产品 / 无 since）
  const rows = d.list.slice();
  const total = Math.min(Math.max(1, Number(d.totalPage) || 1), PSBCWM_MAX_PAGES);
  const pages = [];
  for (let p = 2; p <= total; p++) pages.push(p);
  for (let i = 0; i < pages.length; i += PSBCWM_CONC) {
    const batch = pages.slice(i, i + PSBCWM_CONC);
    const rs = await Promise.all(batch.map((p) => psbcwmGet(base + p, transport).catch(() => null)));
    for (const r of rs) if (r && r.data && Array.isArray(r.data.list)) rows.push(...r.data.list);
  }
  return { rows, ok: true };
}

/**
 * 中邮理财官网抓取。
 * @param {string} code 产品代码
 * @param {{transport?:Function, infoOnly?:boolean}} opts
 *   infoOnly=true 只取产品信息（search + bjjz），**不拉 nvlist 净值序列**（刷信息模式用）。
 * @returns {Promise<null|{name,manager,established,series,kind,risk,benchmark,holdDays,regCode,...}>}
 */
export async function psbcwmFetch(code, opts = {}) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  const transport = opts.transport;
  const sink = opts.__sink || null; // 耗时采集：让「时间分解」能看到官网这一腿（psbc 不走 fetchFromBank 的 transport 计时代理）
  const t0 = Date.now();

  // ① 产品检索（信息 + 最新净值单点）；精确匹配 wp_code，防关键词模糊命中别的产品
  const sj = await psbcwmGet("/pswm-api/product/search?keywords=" + encodeURIComponent(c), transport);
  navTiming(sink, "psbcwm.官网检索", Date.now() - t0, sj ? "HTTP 200" : "null");
  const list = (sj && sj.data && sj.data.list) || [];
  const it = list.find((x) => String(x.wp_code || "").toUpperCase() === c) || null;
  if (!it) {
    navLog("psbcwm code=" + c + " 官网未收录 -> 回落母行端口 (" + (Date.now() - t0) + "ms)");
    return null;
  }
  const name = it.wp_name || null;
  const regCode = it.wp_registration_code || null;
  const risk = /^[1-5]$/.test(String(it.prd_risk_rate || "")) ? "R" + String(it.prd_risk_rate) : null;
  const established = psbcwmYmd(it.wp_establish_date);
  // 基准：优先 bjjz 接口（与官网详情页同源、全文），失败退回 search 里的 performance_comparison
  // light=true（刷额度时只为拿「是否现金类」）跳过这次往返
  // 2026-10-30：mode="nav"（刷净值）也跳过 bjjz —— 业绩比较基准属「产品信息」，
  //   与 fetchProductFull 的既有规则一致（凡抓净值的地方一律不调产品信息接口）；
  //   线上该请求被限速时是每只产品一笔可观开销，且刷净值并不写信息（前端 writeInfo=false）。
  let benchmark = null;
  if (!opts.light && opts.mode !== "nav") {
    const bj = await psbcwmGet("/pswm-api/product/bjjz?wp_code=" + encodeURIComponent(c), transport);
    benchmark = (bj && typeof bj.data === "string" && bj.data.trim()) ? bj.data.trim() : null;
  }
  if (!benchmark) benchmark = it.performance_comparison || it.model_comment || null;

  // ② 历史净值全量（infoOnly 不拉）
  let series = [];
  // 【项目铁律 2026-10-21 / 2026-10-23】现金管理类：中邮官网的模板码是**权威分类信号**——
  //   prd_template_code="1702" = 现金管理类模板；净值型固收实测为 1311（最短持有14天/180天）、
  //   1300（鸿运灵活1号）。这是「不拉净值也能判定」的信号，刷信息/刷额度（不抓序列）时靠它排除，
  //   此前只靠「序列整段恒 1」判定 → info/quota 模式判不出来，现金类会被当普通产品收录。
  const tplCash = String(it.prd_template_code || "") === "1702";
  let cash = tplCash;
  let __navIncremental = false; // 增量腿是否跑通（源有数据；可能本轮 0 新增点）
  if (!opts.infoOnly && !tplCash) {
    const tNav = Date.now();
    const _rw = await psbcwmRows(c, transport, opts.since);
    const rows = _rw.rows;
    const byDate = new Map();
    for (const r of rows) {
      const dt = psbcwmYmd(r && r.update_date);
      const v = Number(r && r.nav);
      if (dt && Number.isFinite(v) && v > 0) byDate.set(dt, Number(v.toFixed(8)));
    }
    series = [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    navTiming(sink, "psbcwm.历史净值", Date.now() - tNav, "n=" + series.length + " last=" + (series.length ? series[series.length - 1][0] : "-"));
    // 增量腿跑通标记：since 给定且首页有数据 → 本腿有效（0 新增点也是有效结果）
    if (opts.since && _rw.ok) __navIncremental = true;
    // 【项目规则 2026-10-21】现金管理类（单位净值整段恒 1）不抓：命中即丢弃序列并标记。
    // 增量刷新（opts.since 给定）下序列仅含新增点，不能作为现金管理类判定依据 → 跳过（沿用既有分类）。
    if (!opts.since && series.length && series.every(([, v]) => Math.abs(v - 1) <= 1e-6)) {
      cash = true;
      series = [];
    }
  }

  navLog("psbcwm code=" + c + " -> name=" + (name || "-") + " reg=" + (regCode || "-") +
    " n=" + series.length + " last=" + (series.length ? series[series.length - 1][0] : "-") +
    " (" + (Date.now() - t0) + "ms)");

  return {
    name,
    manager: "中邮理财",
    established,
    establishedFromSeries: !established,
    series,
    cash,
    kind: "nav",
    risk,
    benchmark,
    holdDays: null, // 官网无「最短持有天数」字段，由母行详情/名称解析补
    regCode,
    source: "live",
    bank: "psbc",
    navVia: "psbcwm",
    navPort: "web",
    // 增量腿标记：本轮按 since 只回新增点（可能 0 点），编排层据此把它当有效净值源，
    // 避免因 series<2 被拒而转去全量兜底（见 navLegOk）。
    navIncremental: __navIncremental,
    navLatest: series.length ? series[series.length - 1][1] : (Number(it.nav) > 0 ? Number(it.nav) : null),
    navLatestDate: series.length ? series[series.length - 1][0] : psbcwmYmd(it.update_date),
  };
}

export async function psbcFetch(code, opts = {}) {
  const transport = opts.transport;
  const sink = opts.__sink || null; // 耗时采集（safeBank → fetchFromBank opts.__sink 下传）
  const __navMode = (opts.mode || "all") === "nav";
  // 【2026-10-23 用户规则】刷信息只刷信息、刷额度只刷额度——两者都不抓净值。
  // psbc 的信息（名称/风险/基准/持有期）与额度（productLeftAmt）同出「产品详情」一个接口，
  // 净值另走 psbcNavAll（type=3 历史净值翻页，3~4s/次）。故 info/quota 只需详情、跳过净值翻页。
  const __infoMode = opts.mode === "info";
  const __quotaMode = opts.mode === "quota";
  const __noNav = __infoMode || __quotaMode;

  // —— 并发：① 中邮理财官网（发行方，净值更新到当天 + 带登记编码 + 现金类模板码）；
  //            ② 母行微信端口产品详情（额度/持有期）——
  // quota 模式也要跑官网，但只跑 search（light=true，跳过 bjjz/净值），
  // 目的是拿 prd_template_code 判定现金管理类（母行详情无类型字段）。
  // 两者并发，不增加额度模式的墙钟时间。
  const wmP = __quotaMode
    ? psbcwmFetch(code, { transport, infoOnly: true, light: true, __sink: sink, since: opts.since, mode: opts.mode }).catch(() => null)
    : psbcwmFetch(code, { transport, infoOnly: __infoMode, __sink: sink, since: opts.since, mode: opts.mode }).catch(() => null);
  // nav 模式只取净值序列：跳过「产品详情」接口（该接口曾兼作存在性/现金类闸门，
  // 现产品均为真实产品、现金类已在添加产品 UI 拦截，无需再校验）。
  const detP = __navMode
    ? Promise.resolve({ ok: false, object: null, err: null })
    : psbcPost("queryFinancialProductDetail", { productCode: code }, transport, sink);
  const [wm, det] = await Promise.all([wmP, detP]);
  const pd = (det.ok && det.object && det.object.productDetail) || null;
  const pdName = pd && pd.productName ? String(pd.productName).trim() : "";
  const name = pdName || (wm && wm.name) || "";

  // 额度：邮储/中邮「产品剩余可购金额」(productLeftAmt，单位：元；字段名含 Left=剩余) + 购买状态(gmzt)。
  // 开放式产品 productLeftAmt 即实时剩余可购额度；封闭式产品为其未售余额。
  // 三态：productLeftAmt>0 → 具体数值(available)；==0 → 已售罄(sold_out)；null → 未知（前端不显示）。
  const quotaFields = (() => {
    const n = (pd && pd.productLeftAmt != null && pd.productLeftAmt !== "") ? Number(pd.productLeftAmt) : null;
    const ok = n != null && Number.isFinite(n);
    return {
      remainQuota: ok && n > 0 ? n : null,
      remainQuotaPct: null,
      quotaState: ok ? (n > 0 ? "available" : "sold_out") : null,
      saleStatus: (pd && (pd.gmzt === 1 || pd.gmzt === "1" || pd.gmzt === "Y" || pd.gmzt === "y")) ? "ON_SALE"
        : (pd && pd.issueStatus != null ? String(pd.issueStatus) : null),
      currency: psbcCurrency(pd && pd.productCcy),
    };
  })();

  // 邮储自有理财产品由中邮理财发行；名字里若命中其它理财子公司才采用其名（与 boc 同策略，
  // 直接用 inferManager 会因为它默认回退「工银理财」而误判）
  const manager = (() => {
    const m = inferManager(name);
    return m !== "工银理财" ? m : "中邮理财";
  })();
  const riskFromPd = pd && pd.risksLevel ? "R" + String(pd.risksLevel).replace(/\D/g, "") : null;
  const holdDays = psbcHoldDays(pd, name);
  const benchmark = (pd && pd.ggms) || (wm && wm.benchmark) || null;

  // ① 官网全序列（nav / all）→ 主源：发行方权威、含当日、含成立日/登记编码
  // 2026-10-30 增量：opts.since 给定（刷新）时官网腿只回「新增点」，可能 0~1 点。
  //   不能沿用 series>=2 门槛，否则会被当成「官网没收录」而落到 ④ 母行端口全量兜底，
  //   把历史全翻一遍 —— 增量收益归零、耗时反而更差。故增量腿用 navLegOk 判定。
  if (wm && !wm.cash && navLegOk(wm)) {
    return {
      name: wm.name || name || null,
      manager,
      established: wm.established || wm.series[0][0],
      establishedFromSeries: !wm.established,
      series: wm.series,
      kind: "nav",
      risk: wm.risk || riskFromPd,
      benchmark,
      holdDays,
      regCode: wm.regCode || null,
      source: "live",
      bank: "psbc",
      navVia: "psbcwm",
      navPort: "web",
      navIncremental: !!wm.navIncremental,
      navLatest: wm.navLatest,
      navLatestDate: wm.navLatestDate,
      ...quotaFields,
    };
  }
  // 官网判定为现金管理类（模板码 1702 / 序列整段恒 1）→ 项目铁律：净值、信息、额度一律不收录。
  // 返回哨兵对象（而非 null），让编排层区分「被规则排除」与「查无此码」，
  // 从而下发 isCash 让前端提示「该产品为现金管理类」。
  if (wm && wm.cash) return { _excludedCash: true, code };

  // ② 刷信息：官网信息壳（带登记编码 → 编排层四项齐全即可跳过中国理财网，实测省 3~8s）
  if (__infoMode) {
    if (!wm && !pd) return null;
    return {
      name: (wm && wm.name) || pdName || null,
      manager,
      established: (wm && wm.established) || null,
      establishedFromSeries: false,
      series: [],
      kind: "nav",
      risk: (wm && wm.risk) || riskFromPd,
      benchmark,
      holdDays,
      regCode: (wm && wm.regCode) || null,
      source: "live",
      bank: "psbc",
      navPort: "web",
      infoOnly: true,
      ...quotaFields,
    };
  }

  // ③ 刷额度：只用母行详情（官网无剩余额度字段）
  if (__quotaMode) {
    if (!pd) return null;
    return {
      name: pdName || null,
      manager,
      established: null,
      establishedFromSeries: false,
      series: [],
      kind: "nav",
      risk: riskFromPd,
      benchmark: (pd && pd.ggms) || null,
      holdDays,
      regCode: null,
      source: "live",
      bank: "psbc",
      navPort: "app", // 额度只出母行微信 H5（官网无剩余额度字段）
      infoOnly: true,
      ...quotaFields,
    };
  }

  // ④ nav / all：官网未收录（他行理财子代销品）→ 母行微信端口原路径
  // 【项目规则 2026-10-21 立】只收录有净值的固收产品：只取 type=3 单位净值。
  // 邮储对现金管理类不走 type=3（真实收益在 type=1 万份收益）——历史上的
  // 「退 type=1 复利合成 + kind:"wan"」现金类处理已删除，勿再 reintroduce。
  const rows = await psbcNavAll(code, 3, transport, sink);
  if (!rows.length) return null; // 未收录该代码

  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const ded = [];
  for (const r of rows) {
    if (ded.length && ded[ded.length - 1][0] === r[0]) ded[ded.length - 1] = r;
    else ded.push(r);
  }
  // 单位净值整段恒 1 ＝现金管理类净值归一 → 按项目规则排除（防御性判据：
  // 正常情况下邮储对现金类根本不回 type=3 数据，上面 !rows.length 已拦掉）。
  if (ded.every(([, v]) => Math.abs(v - 1) <= 1e-6)) return null;

  const series = ded;
  if (!series.length) return null;

  return {
    name: name || null,
    manager,
    established: (wm && wm.established) || (series.length ? series[0][0] : null),
    establishedFromSeries: !(wm && wm.established) && series.length > 0, // 邮储端口无成立日字段
    series,
    kind: "nav", // 现金管理类已排除，走到这里的都是单位净值型固收产品
    risk: riskFromPd || (wm && wm.risk) || null,
    benchmark,
    regCode: (wm && wm.regCode) || null, // 母行接口不返回登记编码，官网有则带上
    holdDays,
    source: "live",
    navPort: "app", // 母行微信 H5 端口（官网未收录该代码时唯一净值来源）
    ...quotaFields,
  };
}

/* ==========================================================================
 * 元数据补充：中国理财网（官方理财登记中心）
 *
 * 为什么需要它：ICBC 自身净值接口（getNetValueList）只有 workDate/value/prodName，
 * 没有「风险等级 / 成立日期 / 持有天数」。这些字段须从「中国理财网」跨库补全。
 *
 * 反爬机制：RSA 密钥交换 + AES-256-ECB 加密载荷 + SHA256 签名。
 * 本实现用 Worker 原生 WebCrypto（密钥生成 / 签名 / AES）+ BigInt（RSA PKCS#1 v1.5
 * 解密，WebCrypto 不支持该 padding）实现，无需 nodejs_compat。
 *
 * 两级来源：
 *   ① 内置种子（ICBC_META_SEEDS）：已知重点产品的权威元数据，瞬时、零外部依赖，优先命中；
 *   ② 中国理财网实时查询：未知代码走 ICBC 名称 → 关键词 → 模糊搜索 → 归一化名精确匹配。
 * ========================================================================== */

const CW_HOST = "https://www.chinawealth.com.cn";
const CW_BASE = "/lcw-fe-service";

// —— 测试钩子（Phase 4 A/B 验证用）——
// 仅当运行环境设置 globalThis.__NAV_MOCK__（形如 {bank, meta, xpl}）时接管数据源；
// 生产环境该全局恒为 undefined，以下三处判断均短路，零行为影响、零性能影响。
// 注意：每次调用时动态读取全局，确保测试进程在 import 之后才安装 mock 也能生效。
function __navMock() {
  return (typeof globalThis !== "undefined" && globalThis.__NAV_MOCK__) || null;
}
const CW_SIGN_KEY = "ppnn13%dkstFeb.1st";
const CW_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const CW_REF = "https://www.chinawealth.com.cn/lcweb/management/proScreen";

// 一级(低) → R1 … 五级(高) → R5
function cwRiskToR(level) {
  if (!level) return null;
  const m = String(level).match(/[一二三四五]/);
  if (!m) return null;
  return { "一": "R1", "二": "R2", "三": "R3", "四": "R4", "五": "R5" }[m[0]] || null;
}

// "2026/06/25" / "2026-06-25" → "2026-06-25"
function normDate(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

// 期限类型 → 最短持有天数（每日开放式 → 1）
function cwTermToHoldDays(term) {
  if (!term) return null;
  const t = String(term);
  if (t.includes("每日") || t.includes("日开放")) return 1;
  const m = t.match(/(\d+)\s*天/);
  if (m) return parseInt(m[1], 10);
  return null;
}

// 已知产品权威元数据（优先命中，瞬时返回；覆盖线上重点产品）
const ICBC_META_SEEDS = {
  "26G2754A": {
    risk: "R1", established: "2026-06-25", holdDays: 1,
    regCode: "Z7000826000942", cwProdId: "26GS2754", keyword: "天天鑫稳益", manager: "工银理财",
  },
  "26GS2754": {
    risk: "R1", established: "2026-06-25", holdDays: 1,
    regCode: "Z7000826000942", cwProdId: "26GS2754", keyword: "天天鑫稳益", manager: "工银理财",
  },
  // 中银理财-稳富全球配置60天持有期04（ICBC 代销 WFQ60D4A）：持有天数/成立日来自中国理财网(2000864061)
  "WFQ60D4A": {
    risk: "R2", established: "2026-08-27", holdDays: 60,
    regCode: "Z7001026001356", cwProdId: "2000864061", keyword: "稳富全球配置60天持有期04", manager: "中银理财",
  },
  "WFQ60D4": {
    risk: "R2", established: "2026-08-27", holdDays: 60,
    regCode: "Z7001026001356", cwProdId: "2000864061", keyword: "稳富全球配置60天持有期04", manager: "中银理财",
  },
};

/* ----------------------- 中国理财网底层加解密（WebCrypto + BigInt） ----------------------- */

function bytesToB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function b64ToBytes(b64) {
  const s = atob(String(b64).replace(/\s+/g, ""));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
function b64urlToBigInt(s) {
  let b = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (b.length % 4) b += "=";
  return bytesToBigInt(b64ToBytes(b));
}
function bytesToBigInt(bytes) {
  let v = 0n;
  for (let i = 0; i < bytes.length; i++) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}
function bigIntToBytes(bn, len) {
  let hex = bn.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    const start = Math.max(0, hex.length - 2 * (i + 1));
    const slice = hex.slice(start, hex.length - 2 * i) || "0";
    out[len - 1 - i] = parseInt(slice, 16);
  }
  return out;
}
function modPow(base, exp, mod) {
  base %= mod;
  let r = 1n;
  while (exp > 0n) {
    if (exp & 1n) r = (r * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return r;
}
// RSA PKCS#1 v1.5 私钥解密（服务端用我们的公钥加密了 AES key，padding=PKCS1v1.5）
function rsaPkcs1v15Decrypt(cipherBytes, nB64url, dB64url) {
  const c = bytesToBigInt(cipherBytes);
  const n = b64urlToBigInt(nB64url);
  const d = b64urlToBigInt(dB64url);
  const m = modPow(c, d, n);
  const mb = bigIntToBytes(m, cipherBytes.length);
  if (mb[0] !== 0x00 || mb[1] !== 0x02) throw new Error("RSA PKCS1 v1.5 padding invalid");
  let j = 2;
  while (j < mb.length && mb[j] !== 0x00) j++;
  if (j >= mb.length) throw new Error("RSA PKCS1 v1.5 separator missing");
  j++; // 跳过 0x00 分隔符
  let s = "";
  for (let i = j; i < mb.length; i++) s += String.fromCharCode(mb[i]);
  return s; // 解密结果是一段 base64 字符串 → 再 base64 解码即 32 字节 AES key
}

// 全局节流：中国理财网对突发请求敏感（429）。所有请求串行间隔 ≥450ms，削峰后基本不再触发限流。
let cwLastReqAt = 0;
async function cwReq(path, bodyStr, headers) {
  const gap = 450 - (Date.now() - cwLastReqAt);
  if (gap > 0) await new Promise((r) => setTimeout(r, gap));
  cwLastReqAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(CW_HOST + CW_BASE + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        "Accept": "*/*",
        "User-Agent": CW_UA,
        "Referer": CW_REF,
        "Origin": "https://www.chinawealth.com.cn",
        ...(headers || {}),
      },
      body: bodyStr,
      signal: ctrl.signal,
    });
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

// 密钥交换：生成 RSA 密钥对 → 上传公钥(SPKI) → 用私钥(BigInt)解密回传的 AES key
// reqFn(path, bodyStr, headers) → {status, text}；中国理财网旧版(cwReq)与
// 信息披露平台新版(xplReq)共用同一套 /m/n 握手与加解密数学，仅域名与签名密钥不同。
async function cwHandshakeVia(reqFn) {
  const kp = await crypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["encrypt", "decrypt"]
  );
  const spki = await crypto.subtle.exportKey("spki", kp.publicKey);
  const pubB64 = bytesToB64(new Uint8Array(spki));
  let res;
  // 用户规则（2026-10-22）：握手遇 429 限流直接失败，取消退避重试以节省时间
  res = await reqFn("/m/n", pubB64, {});
  if (res.status !== 200) throw new Error("/m/n HTTP " + res.status);
  let payload = res.text.trim();
  try {
    const j = JSON.parse(payload);
    if (j && j.data !== undefined) payload = typeof j.data === "string" ? j.data : String(j.data);
    else if (typeof j === "string") payload = j;
  } catch (e) { /* 裸 base64 */ }
  payload = payload.replace(/^"|"$/g, "").trim();
  const encBytes = b64ToBytes(payload);
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const keyStr = rsaPkcs1v15Decrypt(encBytes, jwk.n, jwk.d);
  const keyBuf = b64ToBytes(keyStr);
  if (keyBuf.length !== 16 && keyBuf.length !== 24 && keyBuf.length !== 32) {
    throw new Error("unexpected AES key length: " + keyBuf.length);
  }
  return keyBuf;
}

// 旧站会话密钥缓存（2026-10-14）：此前每次 metaFromChinaWealt 都重新做一轮 RSA 握手
// （keygen + /m/n + BigInt 解密，实测 ~1.4s），且【完全没落计时】——这就是「信息·中国理财网
// (回退) 1.7s 只有 0.3s 子项、差的 1.4s 找不到」的根因。现与 xplState 同款缓存 5 分钟
// + 并发去重（4 路并发刷新只握一次手）；cwPostEnc 遇非 200/404/429 时主动失效自愈。
let cwKeyState = null;        // {t, keyBuf}
let cwKeyInflight = null;     // 进行中的握手 Promise（并发去重）
const CW_KEY_TTL = 5 * 60 * 1000;
/**
 * 【2026-10-31 用户实测】本机 IP 被中国理财网**旧站**（wechatSearch / cwReq）也风控：
 *   握手 cwHandshake 超时（UPSTREAM_TIMEOUT_MS=25s）→ 旧站名检索整条链白等 10~20s。
 *   与 xpl（新站）是**两套独立风控**，故熔断状态也独立（各自记）。
 *   熔断判定：握手抛错（=不可达/被限流）→ 记熔断 → 后续旧站链路快速失败。
 */
const CW_CIRCUIT = { open: false, until: 0 };
const CW_CIRCUIT_MS = 10 * 60 * 1000;

async function cwHandshake(sink = null) {
  if (cwKeyState && Date.now() - cwKeyState.t < CW_KEY_TTL) return cwKeyState.keyBuf;
  // 熔断中 → 直接快速失败（不白等 25s 握手）
  if (CW_CIRCUIT.open && Date.now() < CW_CIRCUIT.until) throw new Error("cw circuit open");
  if (!cwKeyInflight) {
    const hsT0 = Date.now();
    cwKeyInflight = cwHandshakeVia(cwReq).then((keyBuf) => {
      cwKeyState = { t: Date.now(), keyBuf };
      CW_CIRCUIT.open = false;   // 握手成功 → 风控已解除，清熔断
      navTiming(sink, "cw.handshake", Date.now() - hsT0, "会话握手（AES key，5min 缓存）");
      return keyBuf;
    }).catch((e) => {
      cwKeyState = null;
      // 握手失败 = 本机被风控/不可达 → 记熔断（与 xpl 独立）
      CW_CIRCUIT.open = true;
      CW_CIRCUIT.until = Date.now() + CW_CIRCUIT_MS;
      throw e;
    })
      .finally(() => { cwKeyInflight = null; });
  }
  return cwKeyInflight;
}

// WebCrypto 不提供 ECB 模式（Node 与 Cloudflare Workers 皆然，importKey("AES-*-ECB") 直接抛
// NotSupportedError）。而 ECB 的每块 C_i = E(P_i) 与「零 IV 的 AES-CBC 只加密单块」完全等价：
// CBC 单块输出 = E(P⊕0) = E(P)。故按 16 字节逐块调用 CBC、每块只取前 16 字节（丢弃 CBC 自动补的
// 填充块），即得到标准 PKCS7 填充后的 ECB 密文。
async function cwAesEncrypt(plaintext, keyBuf) {
  const key = await crypto.subtle.importKey("raw", keyBuf, { name: "AES-CBC" }, false, ["encrypt"]);
  const pt = new TextEncoder().encode(plaintext);
  const pad = 16 - (pt.length % 16);
  const padded = new Uint8Array(pt.length + pad);
  padded.set(pt);
  for (let i = pt.length; i < padded.length; i++) padded[i] = pad;
  const iv = new Uint8Array(16);
  const out = new Uint8Array(padded.length);
  for (let off = 0; off < padded.length; off += 16) {
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, padded.slice(off, off + 16)));
    out.set(ct.slice(0, 16), off);
  }
  return bytesToB64(out);
}

async function cwSign(obj) {
  let s = "";
  Object.keys(obj).sort().forEach((k) => { s += `${k}=${obj[k]}&`; });
  s += `signKey=${CW_SIGN_KEY}`;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 用同一把握手密钥发送加密业务请求（/prod/search、/prodInfo/getProductDetail 共用）
async function cwPostEnc(keyBuf, path, payloadObj, sink = null) {
  const payload = JSON.stringify(payloadObj);
  const encData = await cwAesEncrypt(payload, keyBuf);
  let res;
  const t0 = Date.now();
  let attempts = 0;
  for (let attempt = 0; ; attempt++) {
    attempts = attempt + 1;
    const nonce = Math.random().toString(36).slice(2, 12);
    const timestamp = Date.now().toString();
    const sg = await cwSign({ data: encData, timestamp, nonce });
    res = await cwReq(path, encData, { "X-Nonce": nonce, "X-Timestamp": timestamp, "X-Sign": sg });
    // 中国理财网 429 限流：用户规则（2026-10-13）——旧站 wechatSearch 遇 429 不退避、禁重试，
    // 立即失败（前端显示「未抓到」）；其余 cw 接口仍退避重试（限流窗口约 10~15s，nonce/签名
    // 每次重建，避免被当作重放；SKILL 明确「每次请求之间 sleep 12~15 秒」）
    if (res.status !== 429) break;
    __cwLast429At = Date.now(); // Fix B：记录最近一次被限流，供调用方决策（如放弃截短重试）
    // 用户规则（2026-10-22）：任意接口遇 429 一律取消退避重试，立即失败以节省时间
    break;
  }
  navTiming(sink, "cw." + path + (attempts > 1 ? "#试" + attempts : ""), Date.now() - t0,
    "HTTP " + res.status + (attempts > 1 ? "（含退避" + ((attempts - 1) * 5) + "s）" : ""));
  if (res.status === 404) throw new Error("cw 404 transient");
  if (res.status !== 200) {
    // 非 200/404/429：可能是会话密钥被服务端轮换（缓存键失效）→ 主动失效，下次重新握手自愈
    if (res.status !== 429) cwKeyState = null;
    throw new Error(path + " HTTP " + res.status);
  }
  // 响应多为明文 JSON；个别情况可能加密，先尝试 JSON，失败再 base64 解密
  let j;
  try { j = JSON.parse(res.text); }
  catch (e) {
    try { j = JSON.parse(new TextDecoder().decode(b64ToBytes(res.text))); }
    catch (e2) { throw new Error("cw response unparseable"); }
  }
  return j;
}

// 关键词模糊搜索：走 /prod/wechatSearch（prodName 子串匹配，无「二次校验」限制，
// 存续/募集均可命中；/prod/search 的 quickQueryWords 对存续产品恒为空，不可用）
async function cwSearch(keyBuf, keyword, sink = null) {
  const j = await cwPostEnc(keyBuf, "/prod/wechatSearch", {
    quickQueryWords: "", currentPage: 1, pageSize: 50,
    prodName: keyword, orgName: "",
  }, sink);
  const list = (j && j.data && (j.data.data || j.data.list)) || [];
  // 注：「未抓到」不在此处标注（2026-10-15 修正）。长名整串零命中会触发截短重试，
  // 单次空结果是中间态；若在此盖章，截短重试已成功、产品信息已齐全时，首个失败子项
  // 仍残留红色「未抓到」→ 与「齐全」自相矛盾（用户反馈）。改由 metaFromChinaWealth
  // 在整条检索链（原词 + 各级截短变体）最终无果时统一标注。
  return list;
}

// 中国理财网对高频请求会限流（429），且前端自动刷新会对同一产品反复查询：
// 按关键字缓存搜索结果与最终元数据，既降载也避免触发限流。命中结果缓存 10 分钟，未命中 60 秒。
const CW_CACHE_TTL = 10 * 60 * 1000;
const CW_NULL_TTL = 60 * 1000;
const cwSearchCache = new Map();
const cwMetaCache = new Map();

async function cwSearchCached(keyBuf, keyword, sink = null) {
  const hit = cwSearchCache.get(keyword);
  if (hit && Date.now() - hit.t < CW_CACHE_TTL) return hit.list;
  const list = await cwSearch(keyBuf, keyword, sink);
  cwSearchCache.set(keyword, { t: Date.now(), list });
  return list;
}

// 从产品名括号里提取产品代码
function codeInName(name) {
  const m = String(name || "").match(/[（(]([A-Za-z0-9]+)[)）]\s*$/);
  return m ? m[1].toUpperCase() : "";
}

// 代码数字核：26G2754A / 26GS2754 → "262754"（跨库代码形态不同，按数字对齐）
function codeDigits(s) {
  const d = String(s || "").match(/\d+/g);
  return d ? d.join("") : "";
}

// 产品详情：含最短持有期限 minHoldTerm（列表接口该字段不可靠，必须走详情）
async function cwDetail(keyBuf, prodId, sink = null) {
  const j = await cwPostEnc(keyBuf, "/prodInfo/getProductDetail", { prodId }, sink);
  return (j && j.data) || null;
}

// 最短持有期限（天）→ 持有天数：数字 → 原值；"--"/空/NA → 1 天（每日开放式）
function minHoldToHoldDays(v) {
  if (v == null) return 1;
  const s = String(v).trim();
  if (!s || s === "--" || /^(NA|N\/A|无)$/i.test(s)) return 1;
  const n = parseInt(s, 10);
  return isNaN(n) || n < 1 ? 1 : n;
}

// 归一化产品名：去「开放式/开放」、去「理财/固收类/混合类/权益类/类」、去括号与空白，便于跨库精确匹配
function normCwName(name) {
  return String(name || "")
    .replace(/[（(].*?[)）]/g, "")
    .replace(/开放式?/g, "")
    .replace(/(固收|混合|权益|商品|另类)类/g, "")
    .replace(/理财/g, "")
    .replace(/[^\u4e00-\u9fa5]/g, "")
    .replace(/\s+/g, "");
}

// 发行机构（理财子公司）前缀：从产品名剥离，得到可检索的核心名（避免「中银理财-…」因去掉「理财」而失配）
const MANAGER_PREFIX = /^(工银理财|中银理财|建信理财|农银理财|交银理财|招银理财|兴银理财|信银理财|光大理财|华夏理财|宁银理财|杭银理财|青银理财|苏银理财|南银理财|平安理财|民生理财|浦银理财|广银理财|贝莱德建信理财|汇华理财|施罗德交银理财|高盛工银理财|法巴农银理财|上银理财|渝农商理财|恒丰理财|渤银理财|北银理财)[·•\-\s]*/;

// 名称分隔符：连字符 / 各类间隔号（中国财富网存「·」，银行侧普遍用「-」）
const NAME_SEP = /[-–—－·•・～~]+/;
// 取最长连续段：整名里的标点会把「连续子串」切断，故按标点切段后取最长的一段作检索词。
// 例：「中邮理财灵活添利-鸿锦最短持有180天5号理财产品」→「鸿锦最短持有180天5号理财产品」
// （中国财富网实际名为「中邮理财灵活添利·鸿锦最短持有180天5号理财产品」，含「-」的整名
//   做连续子串匹配必然零命中 → 实测直接导致产品判「未抓到」）。
function longestSeg(s) {
  const raw = String(s || "").trim();
  const parts = raw.split(NAME_SEP).map((x) => x.trim()).filter(Boolean);
  if (parts.length <= 1) return raw;
  let best = "";
  for (const p of parts) if (p.length > best.length) best = p;
  return best;
}

// 关键词：剥离发行机构前缀 + 括号内代码 + 类别后缀，但【保留数字】（如「第7期」用于区分同系列 01/07）；
// 再按连接符切段取【最长连续段】（2026-10-16 修订）——/prod/wechatSearch 是连续子串匹配，
// 标点会被当作普通字符参与匹配：银行侧「灵活添利-鸿锦」vs 财富网「灵活添利·鸿锦」→ 整名零命中。
// 切段后只留一段无标点文字，可穿过「·」两侧任一段命中（如「鸿锦最短持有180天5号理财产品」）。
// 个别超长名零命中时仍由 metaFromChinaWealth 的逐步截短兜底。
function metaKeyword(icbcName, seed) {
  if (seed && seed.keyword) return seed.keyword;
  const core = String(icbcName || "")
    .replace(MANAGER_PREFIX, "")
    .replace(/[（(].*?[)）]/g, "")
    .replace(/(固收|混合|权益|商品|另类)类.*$/, "");
  const flat = core.replace(/\s+/g, "").trim();
  return longestSeg(flat) || flat;
}

// 归一化名称：去括号代码、统一间隔符、去空白，【保留中文与数字】——用于跨库精确匹配「04/05」等同系列
function normNameFull(name) {
  return String(name || "")
    .replace(/[（(].*?[)）]/g, "")
    .replace(/[·•]/g, "-")
    .replace(/\s+/g, "");
}

async function metaFromChinaWealth(icbcName, seed, icbcCode, regCode, sink = null) {
  const __NM = __navMock();
  if (__NM && __NM.meta) {
    const r = __NM.meta(icbcName, seed, icbcCode, regCode);
    if (r !== undefined) return r; // 返回 undefined 表示不接管，走真实中国理财网链路
  }
  const keyword = metaKeyword(icbcName, seed);
  if (!keyword) return null;
  // 缓存键带登记编码：同名系列产品（如「稳富中短」系列 10 只）按编码各自独立缓存，互不串档
  const cacheKey = keyword + "#" + (regCode || "");
  const cached = cwMetaCache.get(cacheKey);
  if (cached && Date.now() - cached.t < (cached.meta ? CW_CACHE_TTL : CW_NULL_TTL)) return cached.meta;
  const miss = () => { cwMetaCache.set(cacheKey, { t: Date.now(), meta: null }); return null; };

  const keyBuf = await cwHandshake(sink); // 带 sink：握手耗时以 cw.handshake 子项落账（5min 缓存，见 cwHandshake）
  let list = await cwSearchCached(keyBuf, keyword, sink);
  // 长名整串做子串检索会零命中：逐步截短尾部（系列/份额描述）再试；命中后仍用完整 keyword 打分，保证精度不回退。
  if (!list.length && keyword.length > 4) {
    for (let cut = keyword.length - 4; cut >= 4; cut -= 4) {
      // Fix B：若刚刚被限流（429），再试更短变体也必被限流且每次白等 5s；直接放弃，避免 ZNZQCY115 那样 4 轮 × 5s 全废。
      if (Date.now() - __cwLast429At < 20000) {
        navLog("cw 名称检索遇429限流，放弃截短重试（避免 5s/次退避）");
        break;
      }
      await new Promise((r) => setTimeout(r, 300));
      list = await cwSearchCached(keyBuf, keyword.slice(0, cut), sink);
      if (list.length) break;
    }
  }
  if (!list.length) {
    // 2026-10-15：仅当整条检索链（原关键词 + 各级截短变体）最终都无命中时，才标「未抓到」。
    // 中间态（首次全名零命中、随后截短命中）不标注，避免「信息齐全却显示未抓到」的矛盾。
    markNavNote(sink, "/prod/wechatSearch", "未抓到");
    return miss();
  }
  // 匹配评分：① 全名（含数字后缀）精确一致 =100；② 代码数字核一致 =80（括号内代码不同的同系列）；
  // ③ 关键词（含数字后缀）命中 =60（天然区分 04/05）。取最高分者。
  const normIcbc = normNameFull(icbcName);
  const icbcDigits = codeDigits(icbcCode || codeInName(icbcName));
  let best = null, bestScore = -1;
  for (const p of list) {
    const cn = normNameFull(p.prodName);
    let score = 0;
    if (cn === normIcbc) score = 100;
    else if (cn.includes(keyword) || keyword.includes(cn)) score = 60;
    if (icbcDigits && codeDigits(codeInName(p.prodName) || p.prodRegCode) === icbcDigits) score = Math.max(score, 80);
    // 登记编码精确命中（用户方法一）：即便同名系列有多个，也能唯一锁定目标产品
    if (regCode && p.prodRegCode && String(p.prodRegCode).toUpperCase() === String(regCode).toUpperCase()) {
      score = Math.max(score, 95);
    }
    if (score > bestScore) { bestScore = score; best = p; }
  }
  if (!best || bestScore <= 0) return miss();
  // 详情接口拿最短持有期限（列表里的 minHoldTerm 恒为空，不可用）
  let minHold, riskName, startDate;
  try {
    const d = await cwDetail(keyBuf, best.prodId, sink);
    if (d) {
      minHold = d.minHoldTerm;
      riskName = d.prodRiskLevelName || null;
      startDate = d.prodSdate || d.prodSDate || null;
    }
  } catch (e) { /* 详情失败不致命：退回列表字段 */ }
  riskName = riskName || best.prodRiskLevelName || null;
  startDate = startDate || best.prodSDate || null;
  const termHold = cwTermToHoldDays(best.prodTermName);
  const result = {
    risk: cwRiskToR(riskName),
    established: normDate(startDate),
    holdDays: minHold != null ? minHoldToHoldDays(minHold) : termHold,
    regCode: best.prodRegCode || null,
    name: best.prodName || null,
    manager: best.orgName || null,
    source: "chinawealth",
  };
  cwMetaCache.set(cacheKey, { t: Date.now(), meta: result });
  return result;
}

export async function fetchMeta(bank, code, transport) {
  const b = (bank || "").toLowerCase();
  let base = null;
  try {
    if (b === "boc") {
      code = (code || "").toUpperCase();
      const r = await bocFetch(code, { transport });
      if (r) base = {
        risk: r.risk || null,
        // 2026-10-17：App 端口详情口（isNewVersion:"Y"）现在给出真正的 establishDate
        // （如 668313D 为 2026/05/22），不再是「首条净值日」（05/20，含募集期），
        // 故不再打 _cwEstablished 标记、不再让中国理财网覆盖成立日。
        established: r.established || null,
        holdDays: r.holdDays != null ? r.holdDays : null,
        regCode: r.regCode || null,
        name: r.name || null,
        manager: r.manager || null,
        benchmark: r.benchmark || null,
        source: "boc",
      };
    } else if (b === "spdb") {
      const r = await spdbFetch(code, { transport });
      if (r) base = {
        risk: r.risk || null,
        established: r.established || null,
        holdDays: r.holdDays != null ? r.holdDays : null,
        regCode: r.regCode || null,
        name: r.name || null,
        manager: r.manager || null,
        benchmark: r.benchmark || null,
        source: "spdb",
      };
    } else if (b === "ccb") {
      const codeU = String(code || "").trim().toUpperCase();
      // 与 ccbFetch 同款握手（拿 host + 目录项），再并发查 NLCQ11 详情补元数据
      const { host, boot } = await ccbBootstrapAny(codeU, transport);
      const it = boot.item;
      if (it) {
        const name = it.Fnd_Nm || null;
        // NLCQ11 详情（免登录）：补 风险等级/成立日/业绩基准/剩余额度。
        // 仅「当前在售·存续目录内」产品有数据；拿不到时各字段留空（行为与改造前一致）。
        const det = it.Txn_Mkt_ID
          ? await ccbDetail(codeU, String(it.Txn_Mkt_ID), transport, host, boot.cookieHeader).catch(() => null)
          : null;
        const q = ccbQuotaFields(det);
        base = {
          risk: ccbRiskOf(det),
          established: ccbYmd(det && det.Inpt_SrtDt),
          holdDays: ccbHoldDays(name),
          regCode: null,
          name,
          manager: it.Inst_Nm ? inferManager(it.Inst_Nm) || it.Inst_Nm : null,
          benchmark: det ? (det.PfCmpBss || det.Exg_Pft_Cmnt || null) : null,
          source: "ccb",
          ...(q || {}),
        };
      }
    } else if (b === "cib") {
      const r = await cibFetch(code, { transport });
      if (r) base = {
        risk: r.risk || null,
        established: r.established || null,
        holdDays: r.holdDays != null ? r.holdDays : null,
        regCode: r.regCode || null,
        name: r.name || null,
        manager: r.manager || null,
        benchmark: r.benchmark || null,
        source: "cib",
      };
    } else if (b === "nbcb") {
      // 网关在售产品接口同时覆盖宁银理财自营与跨行代销，一次请求即可补齐风险/持有天数/业绩基准
      const r = await nbcbGwInfo(String(code || "").trim().toUpperCase(), transport);
      if (r) base = {
        risk: r.risk || null,
        established: r.established || null,
        holdDays: r.holdDays != null ? r.holdDays : null,
        regCode: r.regCode || null,
        name: r.name || null,
        manager: r.manager || null,
        benchmark: r.benchmark || null,
        source: "nbcb",
      };
    } else if (b === "comm") {
      // 交通银行：详情接口自带 成立日/风险/登记编码/业绩基准，持有天数按产品名推断
      const r = await bocomFetch(code, { transport });
      if (r) base = {
        risk: r.risk || null,
        established: r.established || null,
        holdDays: r.holdDays != null ? r.holdDays : null,
        regCode: r.regCode || null,
        name: r.name || null,
        manager: r.manager || null,
        benchmark: r.benchmark || null,
        source: "comm",
      };
    } else if (b === "citic") {
      // 中信银行：H5 精选目录回填 成立日；持有天数/风险由中国理财网补全
      const r = await citicFetch(code, { transport });
      if (r && r.name) base = {
        risk: r.risk || null,
        established: r.established || null,
        holdDays: r.holdDays != null ? r.holdDays : null,
        regCode: r.regCode || null,
        name: r.name || null,
        manager: r.manager || null,
        benchmark: r.benchmark || null,
        source: "citic",
      };
    } else if (b === "cgb") {
      // 广发银行：App 端口（MDP 网关）一次拿全 名称/风险/最短持有/成立日/基准/登记编码；
      // infoOnly=true 跳过净值序列（净值由 /api/product 统一抓，避免重复拉 36+ 点）
      const r = await cgbFetch(code, { transport, infoOnly: true });
      if (r && r.name) base = {
        risk: r.risk || null,
        established: r.established || null,
        holdDays: r.holdDays != null ? r.holdDays : null,
        regCode: r.regCode || null,
        name: r.name,
        manager: r.manager || null,
        benchmark: r.benchmark || null,
        source: "cgb",
      };
    } else if (b === "ceb") {
      // 光大银行：App 端口（eoap 分享 H5）一次拿全 名称/风险/最短持有/成立日/登记编码/基准/额度；
      // infoOnly=true 跳过净值曲线（净值由 /api/product 统一抓，避免重复拉 170+ 点）。
      // 未登记 accessId 的码 → 返回 null，继续走末尾通用兜底（中国理财网）。
      const r = await cebAppFetch(code, { transport, infoOnly: true });
      if (r && r.name) base = {
        risk: r.risk || null,
        established: r.established || null,
        holdDays: r.holdDays != null ? r.holdDays : null,
        regCode: r.regCode || null,
        name: r.name,
        manager: r.manager || null,
        benchmark: r.benchmark || null,
        source: "ceb",
      };
    } else if (b === "webank") {
      // 微众银行：App 端口（personal.webank.com 理财网关）一次拿全 名称/发行方/TA/成立日/
      // 风险/期限/最新净值/额度/起购/费率。免登录、免签名。
      // 注：该端口的 210 字段里**没有**理财登记编码与业绩比较基准（已全字段扫描确认），
      // 这两项仍由末尾通用兜底（中国理财网）补齐。
      const r = await webankAppFetch(code, { transport, infoOnly: true });
      if (r && r.name) base = {
        risk: r.risk || null,
        established: r.established || null,
        holdDays: r.holdDays != null ? r.holdDays : null,
        regCode: r.regCode || null,
        name: r.name,
        manager: r.manager || null,
        benchmark: r.benchmark || null,
        source: "webank",
      };
    } else if (b === "fminbank") {
      // 富民银行：App 端口（理财代销 H5 公网网关，2026-10-19 打通）一次拿全
      // 名称/发行方/风险/业绩基准/成立日/最短持有/登记编码/净值序列/剩余额度。
      // 注：本函数（fetchMeta）无产品名入参，内部码映射只走 FMBANK_CODE_MAP 静态表
      // （登记编码/销售代码双键）；未命中时由中国理财网补全（与既有行为一致）。
      const r = await fminbankFetch(code, { transport });
      if (r) base = {
        risk: r.risk || null,
        established: r.established || null,
        holdDays: r.holdDays != null ? r.holdDays : null,
        regCode: r.regCode || null,
        name: r.name || null,
        manager: r.manager || null,
        benchmark: r.benchmark || null,
        source: "fminbank",
      };
    } else if (b === "cmbc" || b === "jsb" || b === "pingan" || b === "dongguan" || b === "mybank" || b === "webank" || b === "nanyin") {
      // 净值按发行方路由；银行侧拿不到 成立日 / 最短持有天数 时，由末尾通用兜底网补
      const fnMap = { cmbc: cmbcFetch, jsb: jsbFetch, pingan: pinganFetch, dongguan: dongguanFetch, mybank: mybankFetch, webank: webankFetch, nanyin: nanyinFetch };
      const r = await fnMap[b](code, { transport });
      if (r) base = {
        risk: r.risk || null,
        established: r.established || null,
        holdDays: r.holdDays != null ? r.holdDays : null,
        regCode: r.regCode || null,
        name: r.name || null,
        manager: r.manager || null,
        benchmark: r.benchmark || null,
        source: b,
      };
    } else if (b === "icbc") {
      const seed = ICBC_META_SEEDS[code];
      if (seed) {
        base = {
          risk: seed.risk || null,
          established: seed.established || null,
          holdDays: seed.holdDays != null ? seed.holdDays : null,
          regCode: seed.regCode || null,
          name: seed.name || null,
          manager: seed.manager || null,
          benchmark: seed.benchmark || null,
          source: "seed",
        };
      } else {
        // 未知代码：尝试中国理财网实时匹配（best-effort）
        const live = await icbcLive(code, { transport }).catch(() => null);
        if (live && live.name) base = {
          risk: live.risk || null,
          established: live.established || null,
          holdDays: live.holdDays != null ? live.holdDays : null,
          regCode: live.regCode || null,
          name: live.name || null,
          manager: live.manager || null,
          benchmark: live.benchmark || null,
          source: "icbc",
        };
      }
    }
  } catch (e) {
    // 银行侧取数异常不致命，仍允许下方通用兜底网按名补全
    base = base || null;
  }

  // —— 通用兜底网：任何银行只要 起始日 / 持有天数 / 风险 / 登记编码 任一项缺失，即回落中国理财网 ——
  // 优先用登记编码精确命中（用户方法一），其次按产品名关键字匹配（用户方法二）。
  // 全流程 best-effort：中国理财网不可达/限流时静默跳过，绝不阻塞主流程。
  if (base && base.name) {
    const needCw = !base.established || base.holdDays == null || !base.risk || !base.regCode;
    if (needCw) {
      const cw = await metaFromChinaWealth(base.name, null, code, base.regCode).catch(() => null);
      if (cw) {
        const cwEst = !!base._cwEstablished; // 中行等接口给的成立日实为「首条净值日」，需优先采用中国理财网
        base = {
          risk: base.risk || cw.risk || null,
          established: cwEst ? (cw.established || base.established || null) : (base.established || cw.established || null),
          holdDays: base.holdDays != null ? base.holdDays : (cw.holdDays != null ? cw.holdDays : null),
          regCode: base.regCode || cw.regCode || null,
          name: base.name,
          manager: base.manager || cw.manager || null,
          benchmark: base.benchmark || cw.benchmark || null,
          source: "chinawealth",
        };
      }
    }
  }
  if (base) delete base._cwEstablished;
  return base;
}

/* ----------------------------- 路由分派 ----------------------------- */

/**
 * 按银行分发到对应的实时抓取实现。
 * 返回 null 表示该行不支持（或该代码未收录），入口处统一转 404，
 * 由前端回退到内嵌快照 —— 与既有线上降级路径完全一致。
 */
async function fetchFromBank(bank, code, opts = {}) {
  const b = (bank || "").toLowerCase();
  const __NM = __navMock();
  if (__NM && __NM.bank) {
    const r = __NM.bank(b, code);
    if (r !== undefined) return r; // 返回 undefined 表示不接管，走真实银行链路
  }
  // 【2026-10-10 修复】分派必须透传 opts（含 transport）：serve.mjs 注入的 nodeTransport
  // 解决 papi.icbc.com.cn 旧版 TLS 重协商（全局 fetch 会 ERR_SSL_UNSAFE_LEGACY_RENEGOTIATION
  // _DISABLED 直接连不上）。此前重构时在此层丢掉 opts，导致 live 实测 icbc 路径全部
  // 「upstream unreachable」、spdb 各源也退化为裸 fetch —— 属 Phase 1 重构引入的回归。

  // 【2026-10-14 全渠道时间分解子项】用户要求：所有时间分解都显示子项，握手时间单列。
  // 除已原生落账的 boc/psbc（psbcPost/bocPost 自带方法级计时）外，把 transport 包一层
  // 计时代理：该银行链路的每一次底层 HTTP（含会话握手请求）都以 "<bank>.<路径>" 子项
  // 落入本次 sink。银行间转发（如 spdb 回落 icbc）也一并计时，挂在
  // 当前父阶段下。未带 __sink 的探针/预测调用零影响。
  if (opts.__sink && b !== "boc" && b !== "psbc") {
    const base = opts.transport || fetch;
    const sink0 = opts.__sink;
    const wrapT = (...args) => {
      const t0 = Date.now();
      return Promise.resolve(base(...args)).then(
        (r) => {
          // 【2026-10-22】note 带上 HTTP 状态码：ok(200) / ok(500)。
          // 此前一律记 "ok"，上游 500 在「时间分解」里跟成功长得一模一样 —— 农行官网
          // 并发必 500 导致静默转 ewealth（慢一个披露日）时，根因完全隐身。现在 500
          // 在时间分解里直接可见，一眼能看出是上游拒了还是我们没抓。
          const st = r && typeof r.status === "number" ? r.status : "?";
          navTiming(sink0, b + "." + urlPathOf(args[0]), Date.now() - t0, "ok(" + st + ")");
          return r;
        },
        (e) => { navTiming(sink0, b + "." + urlPathOf(args[0]), Date.now() - t0, "throw " + ((e && e.message) || e)); throw e; }
      );
    };
    opts = { ...opts, transport: wrapT };
  }

  if (b === "icbc") return icbcLive(code, opts);
  if (b === "boc") return bocFetch(code, opts);
  if (b === "psbc") return psbcFetch(code, opts);
  if (b === "ceb") return cebFetch(code, opts);
  if (b === "abc") return abcFetch(code, opts);
  if (b === "bob") return bobFetch(code, opts);
  if (b === "cmb") return cmbFetch(code, opts);
  if (b === "bosc") return boscFetch(code, opts);
  if (b === "spdb") return spdbFetch(code, opts);
  if (b === "ccb") return ccbFetch(code, opts);
  if (b === "cib") return cibFetch(code, opts);
  if (b === "comm") return bocomFetch(code, opts);
  if (b === "citic") return citicFetch(code, opts);
  if (b === "cgb") return cgbFetch(code, opts);
  if (b === "fminbank") return fminbankFetch(code, opts);
  if (b === "nbcb") return nbcbFetch(code, opts);
  if (b === "cmbc") return cmbcFetch(code, opts);
  if (b === "jsb") return jsbFetch(code, opts);
  if (b === "pingan") return pinganFetch(code, opts);
  if (b === "dongguan") return dongguanFetch(code, opts);
  if (b === "mybank") return mybankFetch(code, opts);
  if (b === "webank") return webankFetch(code, opts);
  if (b === "nanyin") return nanyinFetch(code, opts);
  if (b === "huaxia") return huaxiaFetch(code, opts);
  return null;
}

// ==========================================================================
// 新统一抓取编排（2026-10-10 重构）
//   净值：发行银行(全历史) → 代销银行(全历史) → 中国理财网(xinxipilu 信息披露平台)兜底
//   产品信息(最短持有天数/风险等级/成立日期)：直连银行已回 regCode+risk 则跳过中国理财网；
//       否则(建行/兴业/广发/民生/农行/中信等不回风险等级，或 chinawealth/xpl 主源)仍走中国理财网兜底
//   业绩比较基准：发行银行 → 代销银行
//   额度：发行银行 → 代销银行（目前仅平安银行实现）
//   废除旧的「所有银行挨个试 / 工行·招行兜底」逻辑（只从 发行/代销/中国理财网 三处抓）。
// ==========================================================================

// ---- 分阶段调试日志（NAV_DEBUG=1 时启用；仅本机 Node 生效，Cloudflare 无 process 恒关闭）----
// 用途：live 实测「未抓到」时，定位发行直连 / 代销回落 / 中国理财网兜底 / 信息 / 额度各源
//       哪一环失败、各耗时多少。生产（不带该环境变量）零输出、零行为变化。
function navDebugEnabled() {
  try { return typeof process !== "undefined" && process.env && !!process.env.NAV_DEBUG; } catch (e) { return false; }
}
function navLog(msg) {
  if (!navDebugEnabled()) return;
  try { console.log("[navdebug] " + msg); } catch (e) { /* 日志失败不影响抓取 */ }
}

// —— 分阶段耗时采集（2026-10-12；同日修订：显式 sink 逐层传递）——
// 【为什么不用模块级全局 sink】主页刷新是 4 路并发（BR_CONC=4），多个 fetchProductFull
// 同时在跑；全局变量会被并发调用互相覆盖/提前清空 → 甲产品的阶段写进乙的明细、
// 先结束的调用把 sink 置 null 导致其余产品明细丢失（列表表现为：有的产品「--」、
// 分项合计与总耗时/抓取时间对不上）。故改为 fetchProductFull 创建本次私有的
// timings 数组，作为 sink 参数沿调用链显式下传（safeBank → fetchFromBank → 各银行
// 实现 → bocPost；metaFromChinaWealth → cwPostEnc；xplFetch → xplPostCore）。
// sink 为 null/undefined 时 navTiming 直接丢弃 —— 银行实现单独被调（如探针）零影响。
// Fix B：最近一次中国理财网命中 429 限流的时间戳；调用方据此放弃「再试变体」等浪费性重试。
let __cwLast429At = 0;

function navTiming(sink, stage, ms, note) {
  if (!sink) return;
  try { sink.push({ stage, ms: Math.round(ms), note: String(note || "") }); } catch (e) { /* 采集失败不影响抓取 */ }
}
// 回写「所有」含 stageSub 的计时子项备注（2026-10-15 修正：由「仅最近一条」改为「全部」）。
// 原因：同一阶段可能因截短重试产生多条同名子项；只标最近一条会让「成功/失败」两态在
//   前端 mergeConsec（同 note 才合并）下表现不一致。统一标记后：
//     · 检索最终成功 → 全部 note 为空 → 合并为「cw./prod/wechatSearch ×N」；
//     · 检索最终失败 → 全部 note=「未抓到」→ 合并为「… ×N 未抓到」。两态都干净。
// 语义：「未抓到」表示该阶段【最终无果】（由调用方在整条链判定后调用），不是单次尝试失败。
function markNavNote(sink, stageSub, note) {
  if (!sink) return;
  for (let i = sink.length - 1; i >= 0; i--) {
    if (String((sink[i] && sink[i].stage) || "").includes(stageSub)) sink[i].note = note;
  }
}
// 底层 HTTP 计时子项的展示名：<路径>（去协议/域名；query 过长截断；空路径回落主机名）
function urlPathOf(u) {
  try {
    const x = new URL(String(u));
    let p = x.pathname + (x.search || "");
    if (!p || p === "/") p = x.hostname;
    return p.length > 70 ? p.slice(0, 67) + "..." : p;
  } catch (e) { return String(u).slice(0, 70); }
}

// 单银行抓取容错包装：失败/返回空都归为 null，不阻断后续源链路。
// label：耗时采集的阶段名（如 "1.净值·boc" / "3.基准·icbc"），缺省 "bank:<key>"。
// sink：本产品私有的耗时采集数组（由 fetchProductFull 创建并下传，见 navTiming 注释）。
async function safeBank(bank, code, transport, label, sink, extra) {
  if (!bank) return null;
  const t0 = Date.now();
  let hit = "null";
  // 命中描述按实际拿到的内容拼，不要一律写 "hit series=0 navVia=-"：
  // 刷额度（mode=quota）时本来就没有净值序列，只回额度——旧文案会让「时间分解」
  // 看起来像抓净值失败（2026-10-25 浦发额度接入时发现）。
  const describeHit = (r) => {
    if (!r) return "null";
    const bits = [];
    const pts = r.series ? r.series.length : 0;
    if (pts) bits.push("series=" + pts);
    if (r.navVia) bits.push("navVia=" + r.navVia);
    if (r.remainQuota != null) bits.push("quota=" + (r.remainQuota / 1e4).toFixed(2) + "万");
    else if (r.quotaText) bits.push("quota=" + r.quotaText);
    if (!bits.length) bits.push(r.name ? ("name=" + r.name) : "(空)");
    return "hit " + bits.join(" ");
  };
  try {
    const r = await fetchFromBank(bank, code, { transport, __sink: sink, ...(extra || {}) });
    hit = describeHit(r);
    navTiming(sink, label || ("bank:" + bank), Date.now() - t0, hit);
    navLog("bank=" + bank + " code=" + code + " -> " +
      (r ? (describeHit(r) + " name=" + (r.name || "-")) : "null") +
      " (" + (Date.now() - t0) + "ms)");
    return r || null;
  } catch (e) {
    navTiming(sink, label || ("bank:" + bank), Date.now() - t0, "throw " + ((e && e.message) || e));
    navLog("bank=" + bank + " code=" + code + " -> throw " + ((e && e.message) || e) + " (" + (Date.now() - t0) + "ms)");
    return null;
  }
}

// 中国理财网净值兜底：先拿到登记编码(regCode)，再走 xplFetch 抓全量历史净值。
// 登记编码来源优先级：① 银行直连已回的 regCode；② 用银行回的产品名称在
// 中国理财网按名称定位取到 prodRegCode；③ 调用方直接给的 opts.regCode。
async function chinawealthNav(code, { regCode, name, transport, sink, shareCode } = {}) {
  // 登记编码来源优先级（2026-10-16 调整）：
  //   ① 调用方直接给的 opts.regCode（银行直连已回的 regCode 由上层传入）；
  //   ② XPL_SHARE_REG 已登记的渠道份额码映射——这是**人工核对过**的确定性映射，必须先于
  //      任何名称检索：可省掉一次搜索，也避免搜索失败时在时间分解里落下误导性的红色「未抓到」；
  //   ③ 信披平台 getProductList 按名称检索（2026-10-16 新增）——与旧站 wechatSearch 两套
  //      独立风控，不受其 429 限流牵连；行内 subShareCode 可与产品码精确核对，避免近名错配；
  //   ④ 旧站 wechatSearch 名称定位（仅作降级：连续请求即 429 且用户规则禁退避重试）。
  let reg = regCode || XPL_SHARE_REG[code] || null;
  // 份额码：调用方给的优先（编排层已解析过）；否则名检索命中后按渠道名尾字母推导（见下）。
  let share = String(shareCode || "").trim().toUpperCase() || null;
  // 【2026-10-27 修复】渠道码本身在 XPL_SHARE_REG 中登记 = 已知精确 subShareCode（见下方
  // XPL_SHARE_REG 注释约定：仅当渠道码本身等于 xpl 的 subShareCode 时登记才有效）。
  // 务必用它作 subShareCode，避免「按名检索命中平台默认份额（如 109463N）后 xplShareVariant
  // 推导不出真正在售份额（109463WS）」→ 把兄弟份额净值入库。同时用登记的 regCode，不被代销行
  // 回传的其它登记编码覆盖（后者在 xpl 双键查询下查不到正确份额）。
  if (XPL_SHARE_REG[code]) { share = String(code).trim().toUpperCase(); reg = XPL_SHARE_REG[code]; }
  if (reg && !regCode && !XPL_SHARE_REG[code]) navLog("cw code=" + code + " 命中 XPL_SHARE_REG -> reg=" + reg);
  navLog("cw code=" + code + " start reg=" + (reg || "-") + " name=" + (name || "-"));
  if (!reg && name) {
    // 首选：信披平台 getProductList 按名称检索（2026-10-16）——与旧站 wechatSearch 两套
    // 独立风控，不受其 429 限流牵连；行内 subShareCode 可与产品码精确核对。命中即用其
    // 登记编码走下方双键查询；未命中/异常再回退旧站名检索。
    try {
      const x = await xplNameToReg(name, code, transport, sink);
      if (x && x.regCode) reg = x.regCode;
      // 【2026-10-25】平台按名检索只回「它收录的那个份额」，不一定是代销渠道在售的份额。
      // 实证：信银安盈象2号 平台收录 B 份额(AF223066B, 净值1.104)，浦发卖的是 H 份额
      // (AF223066H, 净值1.0809) —— 同登记编码、同产品名，净值差 2%。若直接拿 B 的份额码
      // 查，会把 B 份额净值当成 H 份额入库（数据错误，比抓不到更糟）。
      // 同一产品的各份额码主体相同、仅尾字母不同 → 用渠道产品名尾部份额字母替换即得渠道份额。
      if (!share && x && x.subShareCode) {
        share = xplShareVariant(x.subShareCode, name, code) || x.subShareCode;
        navLog("cw code=" + code + " 份额码推导 platform=" + x.subShareCode + " -> share=" + share);
      }
      navLog("cw code=" + code + " xpl名检索 -> " + (reg ? ("reg=" + reg + " subShare=" + (x && x.subShareCode || "-")) : "miss"));
    } catch (e) { navLog("cw code=" + code + " xpl名检索 throw " + ((e && e.message) || e)); }
  }
  if (!reg && name) {
    try {
      const m = await metaFromChinaWealth(name, null, code, null, sink);
      if (m && m.regCode) reg = m.regCode;
      navLog("cw code=" + code + " 名称定位 -> " + (reg ? ("reg=" + reg) : "miss") + " name回=" + (m && m.name || "-"));
    } catch (e) { navLog("cw code=" + code + " 名称定位 throw " + ((e && e.message) || e)); /* 名称定位失败不致命 */ }
  }
  if (!reg) { navLog("cw code=" + code + " 无 regCode 可用 -> null"); return null; }
  const t0 = Date.now();
  try {
    const r = await xplFetch(code, { regCode: reg, transport, sink, ...(share ? { shareCode: share } : {}) });
    navLog("cw code=" + code + " xpl reg=" + reg + " share=" + (share || "-") + " -> " + (r && r.series ? ("hit series=" + r.series.length) : "null") + " (" + (Date.now() - t0) + "ms)");
    return r;
  } catch (e) {
    navLog("cw code=" + code + " xpl reg=" + reg + " throw " + ((e && e.message) || e) + " (" + (Date.now() - t0) + "ms)");
    return null;
  }
}

// 新统一抓取：返回 4 项内容 {nav, info(3项), benchmark, quota}。
// issuer/agent 为 /api/predict 给出的 发行银行/代销银行 key（issuerKey/agentKey）。

// Fix D（2026-10-12）：1b 跨源补缺跳过阈值。主源已返回 >= 此点数（≈2 个月日频）即视为
// 「已回足历史」，不再向中国理财网做全量补缺——补缺的目的只是补近期漏发/截断的净值，
// 长序列缺的只是更早期历史，对当前净值展示无影响，却要付出一次中国理财网全量序列请求
// （nbc 等截断型银行可省 ~7-13s）。短序列（< 此值，如广发/招银现金类仅 1 点）仍照常补缺。
const GAPFILL_MIN_BANK_POINTS = 60;

// 净值「跨源补缺」总开关（2026-10-12 用户决策：取消节假日补缺功能，代码保留但不再启用）。
// false = 无论添加产品还是任何刷新净值，都不再向中国理财网做净值序列补缺（含 Fix A 节假日跳过、
// Fix D 足历史跳过等衍生逻辑一并失效，因整块 1b 不复执行）。如需恢复，改为 true 即可。
const GAPFILL_ENABLED = false;

// 支持「按产品名定位份额码」的发行行端口（2026-10-25）：代销渠道码在发行方官网查不到时，
// 把渠道产品名交给发行行端口自己搜——信银官网 /cms.product/api/custom/productInfo/search
// 会返回该产品的全部份额（如安盈象2号 B/G/H/L/M/Y），按渠道名尾字母即可取对。
// 这类产品**无需中国理财网兜底**，是「净值优先走端口」的样板。
// 新增同类端口时把 bank key 加进来即可（端口实现内部需支持 opts.name）。
const ISSUER_NAME_LOOKUP = new Set(["citic"]);
// 发行行按名重试的预算。⚠ 2026-10-25 事故后从 15s 上调到 38s：
// 信银「名检索 + detail + getTAProductNav(459KB)」实测 3.3s，慢时可到 17.5s；而单请求自身
// 超时 CITIC_CMS_TIMEOUT_MS 也是 15s。原预算 15s 与它**同时到期**——桥① 在净值即将回来的
// 同一瞬间把在飞请求判死（实测浦银代销信银 2301232123：getTAProductNav 恰好 15.0s
// 超时，桥① 也在 15.0s 放弃 → 退到份额码重试 17.8s → 再退中国理财网 6.3s，总 35.9s，而数据
// 其实已经拿到了）。预算必须**严格大于**在飞腿的最坏耗时。
// 复用 issuerSlowP 时不发新请求，等待零成本。取 25s：观察值 3.3 / 5.7 / 17.5s，留 7.5s 余量，
// 同时给 ④ 中国理财网（约 6s）留出空间，总时长仍在 45s 预算内。
const ISSUER_NAME_BUDGET_MS = 25000;

// B类银行：直连只回 1 个净值 / 无净值序列（网商/微银；微众 2026-10-19 已打通全序列移出）。
// 2026-10-15 用户规则：净值顺序翻转为 代销银行 → 发行银行 → 中国理财网兜底；这些
// 拿不到全序列的银行，在「代销银行」位直接跳过（试了也白试），走 发行银行 → 中国理财网兜底。
// 2026-10-16：cgb 移出本集合 —— 广发 App 端口（MDP 网关）已能返回完整净值序列 + 七字段，
//   不再是「只回 1 个净值」，代销位应当正常参与（否则会白白跳过一家能出全序列的渠道）。
// 2026-10-17：webank 保留在本集合 —— 微众 App 端口只有「最新净值单点 + 信息字段」，
//   历史序列被服务端拒（23525003），代销位仍应跳过，序列交中国理财网兜底。
// 【已推翻】2026-10-19：微众 App 端口打通历史净值序列（POST wm_product/history/query/stock_rates，
//   免登录全量，NYCF000010 实测 144 点）→ webank 从 BANK_ONE_NAV 移出，代销位正常参与。
// 2026-10-17：huaxia 移出本集合 —— 华夏 App 端口（mobileh5 queryFinancialDetailV1）已能返回
//   完整净值序列（halfYearList 实测 25 点）+ 七字段 + 额度，不再是「只回 1 个净值」。
// 2026-10-18：江苏银行(jsb) 打通 App 端口按产品码直查（全量净值 + 七字段 + 额度 + 登记编码），
//   已从 BANK_ONE_NAV 移出并登记为单端口 app —— 见下方 BANK_PORTS 注释。
//   代销位不再跳过 jsb（此前 120030N 招银理财招睿添金7天11号 被跳过 → 只能落中国理财网）。
// 2026-10-19：富民银行(fminbank) 打通 App 端口（理财代销 H5 公网网关 open.fbank.com，
//   免登录全量净值 + 七字段 + 额度，内部码经 FMBANK_CODE_MAP/排行榜目录映射）→ 移出本集合，
//   登记为单端口 app。映射未命中的产品仍返回 null，交发行行/中国理财网兜底（不丢数据）。
// 2026-10-19：微众银行(webank) 打通 App 端口历史净值序列 → 移出本集合（详见上方 2026-10-19 注记）。
const BANK_ONE_NAV = new Set(["mybank", "weiyin"]);

// 2026-10-27 用户规则：净值更新最快的 5 家官网（一般当天 23:00 后即更新当日净值）。
// 当产品的发行银行(issuer)是其中之一时，抓取 NAV 优先走其官网(web)端口——
// 即便产品货架(agent)是另一家较慢银行，也并发双抓、以这 5 家的「当日官网净值」为新鲜来源。
// 5 家：邮储(psbc) / 中信(citic) / 平安(pingan) / 农业(abc) / 广发(cgb)。
// （这 5 家在 BANK_PORTS 均 web 优先；cgb 虽 App 端口有全序列但滞后到中午，故 web 补充其当日末点。）
// 【当日官网净值更新最快的银行集合】——发行方是集合内银行时，发行方官网的当日净值是最快来源，
//   故并发双抓并以发行方官网为优先源(navLead)，不受 3s 预算节流。
// 2026-10-31 新增 ccb（建信理财）：用户确认建信理财官网 www.wealthccb.com 出净值最快——
//   T+0 当日上午/中午/下午/晚上多次披露，非 T+0 当晚23点出当日净值；均快于建设银行自身端口
//   （wealth.ccb.com / tool3.ccb.cn / finance.txt 静态披露，次日晨出昨日净值）。
//   → 建信理财产品挂在**别行货架**时（如宁波代销 JXJXARGS260529109、中行代销 JXJXZDCY300915002、
//     民生代销 JXLX1M265143），原先代销货架腿「有全量即采用」→ 建信理财官网这条腿根本不会被试，
//     数据停在代销行较旧的披露口径；纳入本集合后两腿并发、发行方官网当优先源，按日期并集合并。
const FAST_WEB_NAV_BANKS = new Set(["psbc", "citic", "pingan", "abc", "cgb", "ccb"]);

// 银行直连端口能力表（源自《银行净值直连端口能力清单.xls》列「直连端口」）。
// 用途：① 决定双端口银行的端口尝试顺序；② 给落盘 navVia 配套 navPort，前端「净值来源」列渲染「银行+端口」。
// 顺序即抓取优先级——用户规则 2026-10-15：双端口银行「先 app 端口，后 web 端口」。
//   app  = 手机银行 / App 通道直连（如招行理财超市、邮储/浦发 H5、宁波银行移动端网关…）
//   web  = 官网 / Web 通道直连（如工行官网、建行官网、宁波银行宁银理财官网…）
//   gw   = 移动端网关（部分银行 app 端口内部即走网关，标 gw 以示区分；落盘时等同 app 端口展示为「App」）
// 下列 2 家无直连端口（纯经路由 / 中国理财网兜底），不进此表：mybank / weiyin。
// 2026-10-17：微众(webank) 已接入 App 端口（信息 + 最新净值单点，无历史序列），故从该名单移出，
// 但仍在 BANK_ONE_NAV 里（作代销行时跳过，维持「只走 3 家」规则）。
// 【已更新】2026-10-19：webank 历史净值序列打通（POST stock_rates 免登录全量）→ 同时移出 BANK_ONE_NAV。
// 2026-10-18：江苏银行(jsb) App 端口打通「按产品码直查」全序列（mbank5h5 H5 无参种子页 +
//   页面内 YT.ajaxData，dateFlag=4 取成立以来全量）→ 从 BANK_ONE_NAV 移出、登记为单端口 app。
//   实测 J04946(324点) / J09652(81点) / 120030N(85点，招银理财招睿添金7天11号 招行N份额 经江苏银行代销)。
// 2026-10-16：民生(cmbc) 手机银行网关 m1.cmbc.com.cn/gw/m_app 打通（免登录全量净值+信息+额度），
// 与民生理财官网 cmbcwm.com.cn / www.cmbc.com.cn（web）并存 → 登记为双端口，先 app 后 web。
// 2026-10-17：中国银行(boc) 打通 App 端口 —— 手机银行 bocFinanceDetail 页面走
//   ebsnew.boc.cn/bocphone/VueLocalCli4/bocFinanceDetail/index.html
//   页面免鉴权，网关只需比 web 多一个 isNewVersion:"Y" 即回 211 字段（含登记编码/
//   风险/成立日/最短持有期/业绩基准/管理人/存续规模），故登记为双端口、先 app 后 web。
const BANK_PORTS = {
  // 单端口（web）：官网 / Web 通道
  ccb: ["web"], abc: ["web"], nanyin: ["web"],
  // 光大银行 = App 端口 eoap 营销 H5（全量净值 + 七字段，2026-10-16 打通，需 accessId）/ 官网 eportal（单点，多被 WAF 拒）
  ceb: ["app", "web"],
  // 双端口（web 优先，后 app）—— 2026-10-23 新增 web 端口：
  //   邮储银行 = 中邮理财官网 www.psbc-wm.com（web，发行方权威净值，**含当日**，带登记编码/成立日/基准）
  //             / 邮储母行微信 H5 wap.psbc.com（app，净值慢一个披露日，但**额度 productLeftAmt 只有它有**）
  //   psbcFetch 内部固定顺序：官网优先取净值，母行只补额度/持有期，官网未收录才回落母行净值。
  //   此前登记为单端口 app，导致官网抓到的净值也被 bankPortOf 标成「App」。
  psbc: ["web", "app"],
  // 双端口（web 优先，后 app）—— 2026-10-23 新增 web 端口：
  //   中信银行 = 信银理财官网 www.citic-wealth.com（web，SPA 走 wechat.citic-wealth.com 的
  //   /cms.product/api/custom/productInfo/*，发行方权威净值**含当日** + 登记编码/基准/风险/成立日，
  //   但 getTAProductNav 只有近 3 年窗口）/ 中信银行 NMBFOServer 直连（app，成立以来全量，
  //   **慢一个披露日**）。两端口并发抓、按日期并集合并，官网覆盖同日值。
  citic: ["web", "app"],
  // 双端口（web 优先，后 app）—— 2026-10-23 新增 web 端口：
  //   平安银行 = 平安理财官网 wm.pingan.com（web，网关 wmm.pingan.com.cn/app，
  //   /product/getProductInfo 明文 + /nvl/getNvlView SM4-ECB 加密，发行方权威真实单位净值
  //   **含当日**、成立以来全量，且直给登记编码/风险/基准/成立日/持有期）
  //             / 平安口袋银行 H5 b.pingan.com.cn（app，净值慢一个披露日且按涨幅反解重建，
  //   但**剩余额度 remainQuota 只有它有**）。此前登记为单端口 app，官网净值会被标成「App」。
  pingan: ["web", "app"],
  // 单端口（app）：手机银行 / App 通道
  cmb: ["app"], spdb: ["app"], dongguan: ["app"], huaxia: ["app"],
  // 富民银行 = App 端口 理财代销 H5 公网网关 open.fbank.com/gateway/（fm-wealth-fund 应用，
  //   AES-128-CBC + PBKDF2，免登录免签名；productDetail 全字段 + getNetInfoList 全量净值 +
  //   financialLeaderboardQry 263 款目录做内部码映射；2026-10-19 打通，Node/Workers 双端通用）
  fminbank: ["app"],
  // 江苏银行 = App 端口 mbank5h5.jsbchina.cn 手机银行 H5（无参种子页 + 页面内 YT.ajaxData 直查，
  //   AES-CBC+RSA+MD5 由页面自己加解密；dateFlag=4 成立以来全量净值 + 七字段 + 额度 + 登记编码；
  //   2026-10-18 打通，按产品码直查、不需要分享链接；需本机 Chrome，Workers 下自动失败回落）
  jsb: ["app"],
  // 微众银行 = App 端口 personal.webank.com 理财网关（信息全字段 + 2026-10-19 打通历史净值序列 POST
  //   wm_product/history/query/stock_rates，免登录全量；XPL 仅兜底并补 regCode/benchmark/发行方）
  webank: ["app"],
  // 双端口（web 优先，后 app）—— 用户规则 2026-10-21 单独指定，是「先 app 后 web」总规则的一个例外：
  //   兴业银行 = 兴银理财官网 www.cibwm.com.cn（web 端口，全量历史净值）
  //             / 兴业手机银行 z.cib.com.cn 国密接口（app 端口，全量净值 + 登记编码/基准/持有天数七字段）
  //   cibFetch 内部即按 web → app 顺序试，web 拿不到有效净值才落 app；
  //   实际命中端口由 fetch 实现回写 navPort（此前 cib 登记为单端口 app，官网抓到的也被误标成「App」）。
  cib: ["web", "app"],
  // 双端口（app 优先，后 web）：
  //   工商银行 = 个人网银 mybank（AsynGetDataServlet 净值 + NoSession 额度）/ 官网披露 papi.icbc.com.cn（净值，无额度）
  //   宁波银行 = 移动端网关 aapw / 宁银理财官网 wmbnb.com
  //   民生银行 = 手机银行网关 m1.cmbc.com.cn/gw/m_app（全量净值+信息+额度）/ 民生理财官网 cmbcwm.com.cn
  //   上海银行 = mbank 网关 / www.bosc.cn
  //   中国银行 = App 端口 bocFinanceDetail 手机银行 H5（isNewVersion:"Y" → 211 字段，2026-10-17 打通）
  //             / web 官网同网关概要版（无详情字段）
  //   交通银行 = App 端口 mbank.95559.com.cn 手机银行网关 PRDAFD0007/0002（全量净值+七字段，
  //             净值比 web 新一天；须登记 shareCode 份额码，2026-10-17 打通）
  //             / web 交银理财官网 bocommwm.com（登记编码 Z7…+成立日+净值序列）
  icbc: ["app", "web"],
  nbcb: ["app", "web"],
  bosc: ["app", "web"],
  cmbc: ["app", "web"],
  cgb: ["web", "app"],  // 2026-10-27 起 web 优先（官网当日净值更新最快的 5 家之一；cgbFetch 并发双抓、官网补 App 滞后末点）
  //   ⚠ 2026-10-27 补记：cgb 的「web」实际由三路组成（cgbFetch 内并发）——
  //     ① 广银理财官网 www.cgbwmc.com.cn（navPort=cgbwmc，发行方自有信披平台，**覆盖全部广银理财产品**，
  //        含中行/微众等其它行代销的份额；广发官网/广发 App 只认「广发自己在售」的产品，认不到它们）；
  //     ② 广发银行官网 www.cgbchina.com.cn（navPort=web，仅广发在售，单点）；
  //     ③ 广发 App MDP 网关（navPort=app，仅广发在售，全序列+七字段）。
  //     完整契约见《银行直连探测-端点清单.md》3.8 节。
  boc: ["app", "web"],
  comm: ["app", "web"],
  // 北京银行 = App 端口 cdnmobibank 手机银行 H5（SM2/SM4 国密加密，借无头 Chrome 解密；
  //   按需单抓：web 无结果时才 fallback 跑一次（TTL 缓存 10 分钟），补全量净值序列+信息+额度；
  //   2026-10-17 晚间 F12 抓包打通历史净值：页面内点图表时间 tab（近一年/近六月/近三月）后
  //   接口回 cd.list=[{navDate,nav,totNav,prdCode}] 全量记录，按交易日发布，与 web 并集合并）
  //   / web 北银理财官网 beijingbobwealth.com.cn（净值序列 + 登记编码，默认热路径只走它）。
  bob: ["app", "web"],
};
// 单端口银行的端口（落盘用）：多端口银行由 fetch 实现显式回写 navPort（如 nbcb 的 app/web 实际命中者）。
function bankPortOf(bank) {
  const ps = BANK_PORTS[bank];
  return ps && ps.length === 1 ? ps[0] : null;
}

/* —— 发行/代销银行「双抓定标」比较（2026-10-14 用户规则）——
   触发：代销银行首抓未达标（series<2 或抛错）触发发行银行补抓，此时两家都被实际试探过。
   比较「有效净值 + 信息完整度」，胜者作为该产品偏好银行回传前端持久化；以后只抓该银行，不再试另一家。
   规则：先比「有效净值(series>=2)」——无有效净值者直接落败（没净值不可用，哪怕信息再多）；
        都有有效净值时，比信息项数 → 比净值点数；全相等则发行银行胜（用户：「一样就在发行银行加标记」）。 */
/* —— 净值腿有效性判定（2026-10-30 增量抓取）——
   完整腿：series>=2 点（沿用旧口径；只回单点的银行不算有效净值源）。
   增量腿（navIncremental=true）：本轮按 since 只回「新增点」，可能只有 0~1 点——
   若沿用 >=2 门槛会被判无效 → 被拒后转去中国理财网/母行做**全量**兜底，
   增量收益被彻底抵消（甚至比全量更慢）。故增量腿只要「跑通了」（源有数据、
   只是本轮没有新披露点）即视为有效净值源。 */
function navLegOk(r) {
  if (!r) return false;
  if (r.series && r.series.length >= 2) return true;
  return !!r.navIncremental;
}
/* —— 净值腿有效性判定（带上下文版，2026-10-31）——
   增量模式（opts.since 存在 = 本地已有序列）下，银行腿**跑通但只回单点**时也采纳：
     ① 该行对本产品只有单点披露；
     ② 官网「历史净值」接口被 WAF 拦（本机 IP 高频抓取时常见，如交银 www.bocommwm.com 的
        queryJylcBreakDetail.do 对本机 IP 返 403 安全拦截页），只剩产品详情里的最新净值——
        那**是真实单位净值**，按日期并集合进本地序列并不丢历史。
   若不放行 → 该腿被拒 → 触发 20s+ 的份额码桥接 + 40s 的中国理财网兜底 → 拖到 60s
   前端预算爆掉 → 表现为「抓取失败」（实测交银 5811221111：本地 63s 未抓到，线上 1.7s 拿到）。
   ⚠ 全量模式（无 since = 本地无序列，如添加产品/首次抓取）**不放行**：此时单点会顶掉
     中国理财网的完整历史 → 必须让兜底先跑。
   ⚠ 单点值 ≈1 的**不放行**（沿用「整段恒 1 = 现金管理类」铁律，避免误判现金类把产品排除）。
   ⚠ BANK_ONE_NAV（网商/微银等已知「只回单点」的银行）**不放行**：它们的单点没有历史价值，
     必须继续走中国理财网兜底（那条兜底可能比货架单点还新一天）。 */
function navLegOkCtx(r, sincePresent, bankKey) {
  if (navLegOk(r)) return true;
  if (!sincePresent || !r || r._excludedCash) return false;
  if (bankKey && BANK_ONE_NAV.has(String(bankKey).toLowerCase())) return false;
  const s = r.series;
  if (!Array.isArray(s) || s.length !== 1) return false;
  const v = Number(s[0] && s[0][1]);
  return Number.isFinite(v) && v > 0 && Math.abs(v - 1) > 1e-6;
}
function validNav(r) { return navLegOk(r); }
function bankInfoScore(r) {
  if (!r) return 0;
  let s = 0;
  if (r.name) s++;
  if (r.regCode || r.regCode) s++;
  if (r.risk) s++;
  if (r.benchmark) s++;
  if (r.holdDays != null) s++;
  if (r.established) s++;
  return s;
}
function compareBankResults(ir, ar, issuerKey, agentKey) {
  const iv = validNav(ir), av = validNav(ar);
  if (iv && !av) return issuerKey;
  if (!iv && av) return agentKey;
  if (!iv && !av) return null;                       // 都无有效净值 → 不标记，交中国理财网兜底
  const ii = bankInfoScore(ir), ai = bankInfoScore(ar);
  if (ii !== ai) return ii > ai ? issuerKey : agentKey;
  const inav = (ir.series || []).length, anav = (ar.series || []).length;
  if (inav !== anav) return inav > anav ? issuerKey : agentKey;
  return issuerKey;                                 // 信息/净值完全相同 → 发行银行胜
}

/* —— 代销 App 端口优先 · 双抓实时定标（2026-10-19 用户规则）——
   适用：代销银行拥有 App 直连端口（BANK_PORTS 含 app）且不在 BANK_ONE_NAV
   （只回单点净值的银行不参与，序列交发行行/中国理财网）。
   规则（用户 2026-10-19 原话：「我的规则还是代销 App 优先；除非发行银行抓到的净值
   更新更全面，或者代销和发行抓到的一样，那个时间短优先那个」）：
     ① 默认代销 App 优先；
     ② 发行净值「更新更全面」→ 发行胜（更新=序列末点净值日期更晚；全面=同日期下点数更多）；
     ③ 代销/发行抓到的一样（末点日期+点数全同）→ 耗时短者胜；
     ④ 耗时也相同 → 代销（App 优先基调）。
   不考虑额度加权（用户明示暂不加）。
   实现：两家并发抓（safeBank 各自计时入 timings），抓完按上面规则选胜者，
   覆盖 nav/navVia/navPort；并发使总耗时≈慢的一家而非串行 2×。 */
function agentHasAppPort(bank) {
  return !!(bank && (BANK_PORTS[bank] || []).includes("app"));
}
// 从 timings 取某银行第①步耗时（safeBank 记的 label = "1.净值·"+bank；
// 2026-10-23 起 info/quota 模式该阶段改名为 "1.信息·"/"1.额度·"，故三种前缀都要认）；缺失记 Infinity
function bankMsOf(timings, bank) {
  if (!Array.isArray(timings)) return Infinity;
  const t = timings.find((x) => x && (x.stage === "1.净值·" + bank || x.stage === "1.信息·" + bank || x.stage === "1.额度·" + bank));
  return t && Number.isFinite(t.ms) ? t.ms : Infinity;
}
export function appFirstPick(ar, ir, agentKey, issuerKey, timings) {
  const av = validNav(ar), iv = validNav(ir);
  if (av && !iv) return agentKey;                 // 代销有效、发行无效 → 代销
  if (!av && iv) return issuerKey;                // 发行有效、代销无效 → 发行
  if (!av && !iv) return null;                    // 都无效 → 不定标（交后续兜底）
  const as = ar.series || [], is = ir.series || [];
  const ad = as.length ? as[as.length - 1][0] : "", id = is.length ? is[is.length - 1][0] : "";
  if (ad !== id) return ad > id ? agentKey : issuerKey;              // 末点日期晚=更新
  // 2026-10-19 用户拍板「保留富民优先，因为富民有额度」：
  // 末点相同时，带「真实剩余额度」的一方优先——额度只在代销渠道有，发行行通常没有。
  // 通用化表述：本条即「代销 App 优先」得以为继的实质理由（额度是选品硬指标）。
  // 注意：quotaText 为「存续规模 xxx」的（建行等）是规模口径，不是剩余额度，不参与本层比较。
  const aq = hasRealQuota(ar), iq = hasRealQuota(ir);
  if (aq !== iq) return aq ? agentKey : issuerKey;                   // 有额度者优先
  if (as.length !== is.length) return as.length > is.length ? agentKey : issuerKey; // 点多=全面
  const am = bankMsOf(timings, agentKey), im = bankMsOf(timings, issuerKey);
  if (am !== im) return am < im ? agentKey : issuerKey;              // 一样→快者优先
  return agentKey;                                                   // 全同→代销 App 优先
}

/* 真实剩余额度判定（供 appFirstPick 定标用）：
 *   ① remainQuota 有正数 → 真额度；
 *   ② quotaState=available/sold_out 且 quotaText 不是「存续规模」口径 → 真额度（文本额度如 ">1亿元"/"售罄"）；
 *   ③ 其余（含 quotaText="存续规模 7507.28万元"）一律不算——那是产品规模，不能拿来给渠道加分。 */
export function hasRealQuota(r) {
  if (!r) return false;
  if (r.remainQuota != null && Number(r.remainQuota) > 0) return true;
  const txt = String(r.quotaText || "");
  if (txt && /存续规模/.test(txt)) return false;
  if (r.quotaState === "available" || r.quotaState === "sold_out") return true;
  if (txt) return true;
  return false;
}

/* 成立日校正用：两个 YYYY-MM-DD 日期相差天数（b - a，正=后者更晚）；不可解析返回 null */
function estGapDays(a, b) {
  const pa = Date.parse(String(a || "").slice(0, 10) + "T00:00:00Z");
  const pb = Date.parse(String(b || "").slice(0, 10) + "T00:00:00Z");
  if (!Number.isFinite(pa) || !Number.isFinite(pb)) return null;
  return Math.round((pb - pa) / 86400000);
}

/* —— 现金管理类统一判定（项目铁律 2026-10-21 立、2026-10-23 用户再次重申）——
 * 本项目只收录「有单位净值的固收产品」，现金管理类（类货基 / 万份收益口径）一律不考虑：
 * 净值、额度、信息三种抓取行为都必须一致地排除，不允许「刷信息/刷额度时把现金类当普通产品收录」。
 *
 * 名称兜底：仅用于「该银行的接口没有产品类型字段、且当前模式不抓净值」的场合
 * （info / quota 模式拿不到序列，就无法用「整段恒 1」判定）。命中即排除，绝不参与任何净值合成。
 *
 * 分两级，避免误杀（2026-10-23 实测教训：民生理财「贵竹固收增利**天天盈**117号」是
 * **净值型固收产品**，被旧的「天天盈」子串判据误排除）：
 *   ① 强信号：这些词只会出现在现金管理类产品上，整串匹配即排除
 *      （现金管理 / 类货基 / 货币市场 / 万份收益 / 七日年化 / 现金宝 / 活期宝 …）。
 *   ② 家族名：业内公认的现金管理类产品家族名。**只在该词后面不跟数字**时才算——
 *      「天天盈117号」「日日欣5期」这类带系列号的是净值型固收产品，不能误杀；
 *      且名称含「固收 / 增利 / 纯债」等净值型固收字样时整条家族名判据作废。
 * 已实测的现金类实例：中邮理财「天天盈」(ZHPSBC0001)、华夏「惠享天天」、平安「天天成长」、
 * 招银「朝招金/日日欣」、民生「天天增利」、光大「阳光碧乐活」、浦银「天添利」。 */
const CASH_NAME_STRONG_RE = /现金管理|类货基|货币市场|万份收益|七日年化|现金宝|活期宝|现金增利|现金添利|类货币/;
const CASH_NAME_FAMILY_RE = /(?:天天盈|天天成长|天天理财|日日金|日日欣|日日盈|日日丰|朝招金|天添利|惠享天天|阳光碧乐活|添利快线|时时付|天天宝|日日宝)[A-Za-z]?(?![0-9])/;
const NAV_FIXED_INCOME_RE = /固收|增利|纯债|债券|稳健增益|增益/;

function isCashProductName(nm) {
  const s = String(nm == null ? "" : nm).trim();
  if (!s) return false;
  if (CASH_NAME_STRONG_RE.test(s)) return true;
  if (NAV_FIXED_INCOME_RE.test(s)) return false; // 净值型固收字样优先：家族名可能只是系列名的一部分
  return CASH_NAME_FAMILY_RE.test(s);
}

/* 净值序列是否「整段恒 1」＝现金管理类单位净值归一（募集期占位不适用：至少 2 点才判） */
function isFlatNavSeries(series) {
  if (!Array.isArray(series) || series.length < 2) return false;
  return series.every((p) => p && Math.abs(Number(p[1]) - 1) < 1e-6);
}


export async function fetchProductFull(code, opts = {}) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  // 发行银行：优先用调用方给的 key；为空时用产品记录里已存的发行机构（产品详情页
  // 最上方卡片红圈字段，经 /api/product 的 manager 参数透传，如「招银理财」）换算——
  // 抓净值不再按 code 调 /api/predict 预判发行行（2026-10-15 用户规则）。
  const issuer = String(opts.issuer || "").toLowerCase() || managerToBankKey(opts.manager);
  const agent = String(opts.agent || "").toLowerCase();
  const transport = opts.transport;
  // fullInfo=true 时强制走中国理财网补齐最短持有天数（详情页用）；列表刷新默认不带，走 Fix C 加速。
  const fullInfo = !!opts.fullInfo;
  // 2026-10-22 用户规则（额度和净值已拆分）：模式决定本次只抓哪一类数据——
  //   nav   只抓净值序列（不调产品信息接口、不抓额度）；
  //   info  只抓产品信息 + 业绩基准（不抓净值、不抓额度）；
  //   quota 只抓额度（跑银行抓取取 bankResults 里的额度字段，不抓净值/信息）；
  //   all   全抓（兼容详情页完整刷新 / 调试端点）。
  // 凡抓净值的地方（nav / all）一律不调产品信息接口（BOB_INFO_EP 等），信息只在添加产品与「刷信息」时抓取。
  const mode = opts.mode || "all";
  // 2026-10-31 优化：按各银行净值披露时间表，未到「下一净值披露时刻」的产品无需回源。
  // 例：中邮当晚23点出当日净值，某产品最新净值日=10-30，则 10-31 23:00 前都不可能出新数据 → 跳过。
  // 返回 navIncremental:true, series:[]，前端/定时脚本按「已是最新、0 新增点」处理（不误判失败、不丢历史）。
  // 此逻辑放在 fetchProductFull（本地 serve.mjs 与线上 Worker 共用）内，单一事实源，两边自动生效。
  if (mode === "nav" && opts.since) {
    // 净值披露时刻由「发行行」决定（数据源头），与走哪条代销渠道无关——
    // 故发行行优先于代销行。先前用 agent||issuer 导致「工行代销的中邮/中信产品」被错按
    // 工行(icbc) default 时间表(次日10:00)判定，把本已出 10-30 净值的中邮/中信产品误跳过。
    const pubMs = nextNavPublishMs(issuer || agent, opts.since);
    if (pubMs && Date.now() < pubMs) {
      return {
        code: c,
        navVia: "schedule-skip",
        navPort: "skip",
        nav: { series: [], kind: "nav", navBasis: "nav", source: "schedule-skip", navIncremental: true },
        name: null, manager: null, info: null, benchmark: null, quota: null, bankInfo: null,
        timings: [{ stage: "schedule-skip", ms: 0, note: "未到净值披露时间，跳过回源" }],
        preferredBank: undefined,
      };
    }
  }
  let isCash = false; // 银行直连识别到的现金管理类（OPEN_TYPE=6 / XJL 等）→ 透传给前端从源头拦截

  // —— 分阶段耗时采集：底层请求自报（boc/cw/xpl），本函数记录编排级阶段。
  // timings 是本次调用私有的 sink，沿 safeBank/metaFromChinaWealth/xplFetch 显式下传，
  // 并发互不串档（2026-10-12 修订，见 navTiming 处注释）。 ——
  const timings = [];
  const T0 = Date.now();
  // 【2026-10-23】第 1 步的阶段名随 mode 变化：刷信息/刷额度时该阶段实际抓的是信息/额度，
  // 仍标「1.净值·X」会让「时间分解」看起来像在抓净值（用户 2026-10-23 明确要求
  // 刷信息只刷信息、刷额度只刷额度）。名字只影响展示，不影响任何抓取行为。
  const bankStage = (b) => (mode === "info" ? "1.信息·" : mode === "quota" ? "1.额度·" : "1.净值·") + b;

  // 【项目规则 2026-10-21 用户重申】净值抓取只走 3 家：代销银行 → 发行银行 → 中国理财网兜底。
  // 工行(icbc)只是 predict 判定代销行时的正常渠道，任何时候不得作为「发行/代销都失败」的
  // 专用兜底通道——旧实现（ceb/spdb/citic 内部回落 icbcLive、前端逐家试含工行）已全部废除，
  // 详见 cebDirectNav 尾部 / spdb / citic 段注释与前端 buildOrder 死代码标记。禁止 reintroduce。
  // abc（农行渠道）内部顺序是 农银理财官网 → 农行e站 → 中国理财网：农行平台的净值由发行人
  // 报送、与官网同源但慢一个披露日，用户要求「与官网同步」故官网优先；e站仍保留（补官网
  // 只存近 ~1081 个披露日的早期历史 + 兜底），详见 abcFetch 段注释。
  // —— 1. 净值：代销银行 → 发行银行（均要求全历史净值 series>=2 才采用）→ 中国理财网兜底 ——
  let nav = null, navVia = null, navPort = null, bankInfo = null;
  // 【2026-10-25】双来源标注：appFirst 并发双抓时，两家都拿到全序列的情形下，
  // 把每家各自的点数/末点一并回传，前端「净值来源」列同时显示（用户 2026-10-25 要求
  // 「保留同时抓，净值来源 2 个都写」）。单来源时为 null，前端按老逻辑显示单个。
  let navSources = null;
  // 中国理财网兜底通道识别到的现金管理类（投资性质=现金管理类，2026-10-23）——
  // 该通道不经过 bankResults，单独用变量带给下方统一收口。
  let cwCash = false;
  try {
  const baseBanks = [];
  // 2026-10-15 用户规则：代销银行优先于发行银行——代销银行（产品所在列表银行）的接口
  // 顺带返回剩余额度，发行银行没有额度，故先抓代销银行。
  // 例外：拿不到全序列的 3 家（BANK_ONE_NAV：网商/微众/微银）在代销位
  // 直接跳过，走 发行银行 → 中国理财网兜底。
  if (agent && agent !== issuer && !BANK_ONE_NAV.has(agent)) baseBanks.push(agent);
  if (issuer) baseBanks.push(issuer);
  // 2026-10-25：nav 模式下前端可能只给代码（刷净值首次 / 添加产品未存名）。若发行行支持按名检索，
  // 先向**代销货架**要一次产品名，让第一腿就带上名字——否则第一腿按渠道码查空、被 3s 定标预算
  // 丢弃，桥① 再用名字重抓一遍，同一产品白抓两次（实测浦银代销信银 2301232123：19.4s → 7s 级）。
  // 只在要抓净值的模式做（info/quota 模式不抓净值，取了也没用）。
  let nameHint = String(opts.name || "").trim();
  const wantNav = opts.mode !== "info" && opts.mode !== "quota";
  if (!nameHint && wantNav && agent === "spdb" && issuer && ISSUER_NAME_LOOKUP.has(issuer)) {
    const hT0 = Date.now();
    const h = await spdbInfo(c, transport).catch(() => null);
    if (h && h.name) {
      nameHint = String(h.name).trim();
      navLog("name-hint 代销货架取到产品名 name=" + nameHint + " (" + (Date.now() - hT0) + "ms)");
    } else {
      navLog("name-hint 代销货架未取到产品名 (" + (Date.now() - hT0) + "ms)");
    }
  }
  // extra 按银行构造（boc 概要齐全透传）——双抓并发时两家各自构造。
  // name/manager/regCode 全银行透传：富民等端口需要产品名做内部码映射（FMBANK_CODE_MAP
  // 未命中时按排行榜目录名匹配），其它银行忽略这些字段，无副作用。
  const extraOf = (b) => ({
    ...(opts.noCache ? { noCache: true } : {}),
    ...(nameHint ? { name: nameHint } : {}),
    ...(opts.manager ? { manager: opts.manager } : {}),
    ...(opts.regCode ? { regCode: opts.regCode } : {}),
    // 2026-11-02 用户规则：富民内部产品码（DX…）回传透传，供 fmResolveCode 优先短路。
    ...(opts.fmInternalCode ? { fmInternalCode: opts.fmInternalCode } : {}),
    ...((b === "boc" && opts.summaryComplete)
      ? { summaryComplete: true, sName: opts.sName, sRegCode: opts.sRegCode, sRisk: opts.sRisk, sBenchmark: opts.sBenchmark }
      : {}),
    // 2026-10-22 修复：把 mode 透传到银行抓取层——nav/quota 模式下 bobFetch 的 navOnly
    // 才能生效，北银只抓 navlist 不再调 BOB_INFO_EP 产品信息接口（刷净值时间分解不再出现 bob.../info）。
    ...(opts.mode ? { mode: opts.mode } : {}),
    // 2026-10-30 增量抓取：刷新（非添加产品）透传本地序列最后净值日 since；
    // 支持增量分页的银行据此只翻到追上 since 的页、只回新增点，避免重翻全量历史。
    // 缺失 → 全量历史（添加产品 / 旧前端）。各银行仅在自身实现了增量分页时才生效，否则忽略（恒全量）。
    ...(opts.since ? { since: opts.since } : {}),
  });
  // 2026-10-19 用户规则：代销 App 端口优先。代销银行有 App 直连端口时：
  //   ① 无视 preferBank 对代销的降级——旧记忆可能在代销端口打通前就定标为发行行，
  //      粘死不再更新（实测：东莞 App 端口打通后，宁银/交银产品仍显示「宁波银行 App」）；
  //   ② 与发行行并发双抓，按 appFirstPick 实时定标（更新更全面→发行；一样→快者；全同→代销）。
  const appFirst = agentHasAppPort(agent) && baseBanks.includes(agent);
  // 2026-10-27 用户规则：发行方(issuer)是「当日官网净值更新最快的 5 家」(FAST_WEB_NAV_BANKS) 时，
  // 即便货架(agent)是另一家较慢银行，也并发双抓并以发行方官网的当日净值为新鲜来源优先。
  // 与 appFirst 共用下方「并发双抓 + 实时定标」分支；区别：优先源(lead)是发行方官网而非代销 App。
  // 例：货架=建行(web-only) + 发行=邮储(psbc) → 此前串行先试建行、有净值即 break，邮储当日官网净值永不被取；
  //     启用后两家并发，邮储官网当日末点并入序列，上午即拿到最新净值。
  const fastWebIssuer = FAST_WEB_NAV_BANKS.has(issuer) && issuer !== agent && baseBanks.includes(issuer);
  const concurrent = appFirst || fastWebIssuer;
  // 优先源银行：appFirst=代销 App；fastWebIssuer=发行方官网（当日净值最快）。非优先源才被预算节流。
  // ⚠ 2026-10-27 修复：fastWebIssuer 优先于 appFirst 取 lead。
  //   此前写成 appFirst ? agent : (fastWebIssuer ? issuer : null)，当「代销行有 App 端口」
  //   且「发行方是 5 家当日快更之一」同时成立时（如 中行代销的广银理财产品：boc 有 App 端口、
  //   发行方广银理财∈cgb），lead 被判成代销行 → 发行方官网腿落到「非优先发行行」分支，
  //   被 3s 预算掐断丢弃 → 官网当日净值永远拿不到（实测 /api/product 3.6s 就返回 boc 的旧末点）。
  //   按用户规则「发行方是这 5 家就优先从这 5 家抓净值」，fastWebIssuer 时 lead 必须是发行方官网。
  //   非优先的代销行腿不受影响：`b !== navLead && b === issuer && b !== agent` 只节流非优先的**发行行**。
  const navLead = fastWebIssuer ? issuer : (appFirst ? agent : null);
  // 偏好银行标记（前端 observer_prefer_bank，首次双抓定标后持久化）：只抓标记银行，另一家仅在其失败兜底。
  // 这样定标之后固定从最优银行抓，不再每次都试另一家（避免冗余请求）。无标记时维持 代销→发行 新序。
  // ⚠ appFirst 为真时本标记不参与（见上）；appFirst 产品的来源每次实时定标，不回写记忆。
  let tryBanks;
  if (appFirst) {
    tryBanks = baseBanks.slice();                 // [agent, issuer]：两家都抓，赛后定标
  } else if (opts.preferBank && baseBanks.includes(opts.preferBank)) {
    const other = baseBanks.filter(b => b !== opts.preferBank);
    tryBanks = [opts.preferBank, ...other];
  } else {
    tryBanks = baseBanks.slice();
  }
  const triedBanks = new Set();     // 第 1 步已抓过的银行（备用标记）
  const bankResults = {};           // 第 3 步基准复用：各银行第 1 步的原始返回（含 series<2 未被采用但带 benchmark 的响应）
  // 2026-10-25：发行腿「定标超时但仍在飞」的 promise（仅 appFirst 分支赋值），
  // 供下方桥接块复用，避免同一产品被重复抓取。声明在此处以便跨分支访问。
  let issuerSlowP = null;
  if (concurrent && tryBanks.length > 1) {
    // —— 代销 App 优先：并发双抓 + 实时定标 ——
    // 定标口径（2026-10-19 修订）：末点日期 → 真实剩余额度 → 点数 → 耗时 → 代销。
    // 用户拍板「保留富民优先，因为富民有额度」：额度只在代销渠道有，故末点相同时带额度者胜；
    // 北银京华远见诚享100天G（TG01230604G）即由本层从 bob(754点) 改判为富民(172点+9212万额度)。
    tryBanks.forEach(b => triedBanks.add(b));
    // 2026-10-23：发行(issuer)腿限时兜底。代销 App 优先场景下，发行端口常对本产品无数据
    // （如建信网关对民生渠道份额恒返 null），且偶发单请求卡到 20s 超时；Promise.all 会干等
    // 这条慢腿，把代销 App 已秒回的产品拖到 10s 外（实测 JXLX1M265143：民生 2.5s vs 建信 21.3s，
    // 来源仍是民生）。故给发行腿加预算：超时即以代销结果定标（appFirstPick 在发行腿=null 时判代销胜）。
    // 代销腿不设限——它是优先源，理应先等它自己回全；发行腿健康时（实测 0.6~1.5s）定标逻辑不变。
    // 2026-10-23 用户拍板收紧：发行腿最多等 3s（原 8s）。代销 App 是优先源，发行行卡死/无数据时
    // 不值得久等，3s 足够健康发行腿（≤1.5s）完成定标，超时即认代销胜。
    const APP_FIRST_ISSUER_BUDGET_MS = 3000;
    // 非优先源银行限时兜底；优先源(navLead)不限时，确保当日官网净值 / 代销 App 不被节流。
    //   · appFirst：优先源=代销 App，非优先源=发行行 → 给发行行 3s（spdb 代销放宽 6s）预算；
    //   · fastWebIssuer：优先源=发行方官网(当日净值)，非优先源=货架行(额度源) → 不节流额度源，
    //     故只对「非优先且为发行行」的情形预算（fastWebIssuer 下非优先=货架行，不会命中此分支）。
    // 2026-10-27：预算方向从「只对发行行节流」明确收敛为「只对非优先的发行行节流」——
    //   此前只对发行行预算，fastWebIssuer 时非优先源=货架行(额度源)若被节流会丢额度，故仅预算发行行。
    const legTasks = tryBanks.map((b) => {
      // 【2026-10-25 双来源·仅 appFirst】浦发代销他行时，发行腿只需补「末点」：
      //   浦发 App 已回全量（2301232123 = 888 点），信银官网 747 点是其子集，唯一新增即最后一天（10-23）。
      //   而 getTAProductDetail 本身就带 nav / navDate —— 只拉 detail（≈2s）就够，
      //   不必再拉 459KB 的 getTAProductNav（3~17s，正是双来源经常拿不到的原因）。
      //   浦发腿万一失败，桥接块会用全量重试兜底，历史点不会丢。
      //   fastWebIssuer 时发行方官网是优先源、需回全量，禁用 navPointOnly。
      const ex = (appFirst && b === issuer && b !== agent && agent === "spdb")
        ? { ...extraOf(b), navPointOnly: true }
        : extraOf(b);
      const p = safeBank(b, c, transport, bankStage(b), timings, ex).catch(() => null);
      if (b === issuer && b !== agent) issuerSlowP = p; // 备下方桥接块复用
      // 仅对非优先「发行行」节流（fastWebIssuer 时货架行=额度源不节流，以免丢额度）；优先源(navLead)永远不限时。
      if (b !== navLead && b === issuer && b !== agent) {
      // 发行腿预算：默认 3s；spdb 6s（要回 459KB）；**cmb 26s**——
      //   招行腿在 cfweb 超市查不到已下架产品时会回落招银理财官网（cmbwm）腿；
      //   该腿现已纯 HTTP + 自实现 SM2（scrape/cmbwm_http.mjs，1~3s，无 Chrome 冷启动），
      //   3s 预算本会把整条掐断 → 保留 26s 宽松上限（实际 1~3s 即回，cmbwmFetch 另有 45s 内部总预算）。
      //   26s 上限保证「前端 60s 预算」内仍留 30s+ 给兜底链。
        const budget = (agent === "spdb") ? 6000
          : (b === "cmb") ? 26000   // cmbwm 现已纯 HTTP+SM2（1~3s），26s 仅作宽松上限，不影响实际耗时
          : APP_FIRST_ISSUER_BUDGET_MS;
        return Promise.race([
          p,
          new Promise((res) => setTimeout(() => res(null), budget)),
        ]);
      }
      return p;
    });
    const rs = await Promise.all(legTasks);
    tryBanks.forEach((b, i) => {
      bankResults[b] = rs[i];
      if (!bankInfo && rs[i]) bankInfo = rs[i]; // 保留第一个有响应的银行信息（名称/登记编码等）
    });
    for (const b of tryBanks) {
      const r = bankResults[b];
      // 仅当返回「全部历史净值」(>=2 点) 才采用；先到先占位，赛后由 appFirstPick 纠正
      // 2026-10-30 增量：增量腿只回新增点（可能 0~1 点），用 navLegOk 放行，
      //   否则会被拒 → 转去中国理财网全量兜底（增量收益归零）。
      if (navLegOkCtx(r, !!opts.since, b) && !nav) {
        nav = r;
        navVia = b;
        navPort = r.navPort || bankPortOf(b);
      }
    }
    const win = appFirstPick(bankResults[agent], bankResults[issuer], agent, issuer, timings);
    if (win && win !== navVia) {
      nav = bankResults[win];
      navVia = win;
      // 双端口银行由 fetch 实现显式回写 navPort（如 nbcb 的 app/web 实际命中者）；
      // 单端口银行从 BANK_PORTS 推导其唯一端口，列显示「银行+端口」用。
      navPort = nav.navPort || bankPortOf(win);
    }
    // bankInfo 与胜出源保持一致（第②步信息补全用胜出银行的名称/登记编码）
    if (win && bankResults[win]) bankInfo = bankResults[win];

    // 【2026-10-25 双来源】序列并集 + 来源标注。
    // 主来源不再由 appFirstPick 的「末点日期」决定 —— 发行方官网通常比代销渠道早一天
    // 披露（信银 10-23 vs 浦发 App 10-22），按末点排序会把「只多 1 个点」的发行腿判成
    // 主源，而数据主体（888/889 点）其实来自代销。现改为：
    //   ① 主来源 = 贡献数据最多的那家（点数多者），同点数时代销优先（符合 2026-10-15
    //      「代销银行优先于发行银行」铁律）；
    //   ② 序列按日期并集：主源优先、另一家只补它缺失的日期（典型就是补最新那一天）；
    //   ③ 两家各自点数/末点一并回传，前端「净值来源」列同时显示，解决「末点来自发行方、
    //      来源却只标代销」的溯源错位。
    {
      const list = [];
      for (const b of tryBanks) {
        const r = bankResults[b];
        if (!r) continue;
        // 2026-10-30 增量：增量腿只回 0~1 个新增点，navLegOk 放行（否则不计入来源明细）
        if (navLegOkCtx(r, !!opts.since, b) && r.series && r.series.length >= 1) {
          const last = r.series[r.series.length - 1];
          list.push({
            bank: b,
            port: r.navPort || bankPortOf(b),
            points: r.series.length,
            lastDate: last[0],
            lastNav: last[1],
            role: "full",
          });
        } else if (r.navLatestDate && Number(r.navLatest) > 0) {
          // 只补末点的附源（navPointOnly：发行方只回了 detail 里的 nav/navDate）
          list.push({
            bank: b,
            port: r.navPort || bankPortOf(b),
            points: 1,
            lastDate: r.navLatestDate,
            lastNav: Number(r.navLatest),
            role: "fill",
          });
        }
      }
      // 2026-10-30 增量：两条腿都只回「新增点」，「按点数定主源」已无意义（点数都是 0~1），
      //   且会把「净值来源」标签在发行/代销之间随机翻转。故增量模式跳过主源重选，
      //   只把另一条腿的新增点按日期并集补进主源（前端与本地旧序列合并后即为完整序列）。
      if (list.length > 1 && !opts.since) {
        list.sort((x, y) =>
          (y.points - x.points) ||
          ((x.bank === agent ? -1 : 0) - (y.bank === agent ? -1 : 0))
        );
        navSources = list;
        const primary = list[0].bank;
        if (primary !== navVia) {
          navVia = primary;
          navPort = list[0].port;
          nav = bankResults[primary];
          if (bankResults[primary]) bankInfo = bankResults[primary];
        }
        const otherKey = primary === agent ? issuer : agent;
        const other = bankResults[otherKey];
        if (nav && other) {
          const before = nav.series.length;
          let merged = nav.series;
          if (other.series && other.series.length >= 2) {
            // 附源有全量 → 按日期并集（主源优先，附源只填空）
            merged = mergeNavByDate(nav.series, other.series);
          } else if (other.navLatestDate && Number(other.navLatest) > 0) {
            // 附源只有末点 → 只在它比主源末点更新时补这一个点
            const d = other.navLatestDate;
            const lastD = merged[merged.length - 1][0];
            if (d > lastD) merged = [...merged, [d, Number(Number(other.navLatest).toFixed(8))]];
          }
          if (merged.length > before) {
            nav = { ...nav, series: merged };
            navLog("双来源补点 code=" + c + " " + navVia + "(" + before + ") + " + otherKey +
              " -> " + merged.length + "（" + merged[merged.length - 1][0] + "）");
          }
        }
      }
      // 增量模式：把另一条腿的新增点按日期并集补进主源（不重选主源，保持来源标签稳定）
      if (opts.since && nav) {
        const otherKey2 = navVia === agent ? issuer : agent;
        const other2 = bankResults[otherKey2];
        if (other2 && other2.series && other2.series.length && nav.series) {
          const before2 = nav.series.length;
          const merged2 = mergeNavByDate(nav.series, other2.series);
          if (merged2.length > before2) {
            nav = { ...nav, series: merged2 };
            navLog("增量补点 code=" + c + " " + navVia + "(" + before2 + ") + " + otherKey2 +
              " -> " + merged2.length);
          }
        }
      }
    }

    // 【2026-10-27 用户规则】5 家「当日官网快更」银行（邮储/中信/平安/农业/广发）直接主导 navVia：
    //   即便代销行序列点数更多（appFirstPick 的「末点/额度/点数」判定 与 双来源「点数多者为主」都会把
    //   代销判为胜方），只要发行方是这 5 家且实际贡献了数据（全量或补末点），navVia 就标发行方——
    //   其官网当日净值是权威快更来源，来源标签应如实反映。净值序列仍是双方并集（nav 已在上方合并，
    //   不替换为 bankResults[issuer]，以免丢失代销历史点）；navPort 取发行方实际命中端口（web/app），
    //   与 navSources 一致。
    if (fastWebIssuer && navSources && navSources.some((s) => s.bank === issuer)) {
      navVia = issuer;
      const _iss = navSources.find((s) => s.bank === issuer);
      navPort = _iss ? _iss.port : bankPortOf(issuer);
      // nav 保持并集对象（含双方序列），仅改标签
    }
  } else {
  for (const b of tryBanks) {
    triedBanks.add(b);
    // 中行概要齐全标记：仅 boc 透传 summaryComplete（跳过 ProductSummaryQueryOutlay 请求）
    // noCache：用户主动刷新时透传，令平安等带进程内缓存的银行绕过缓存、真实回源。
    // name/manager/regCode：富民等端口做内部码映射用（其它银行忽略）。
    const extra = {
      ...(opts.noCache ? { noCache: true } : {}),
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.manager ? { manager: opts.manager } : {}),
      ...(opts.regCode ? { regCode: opts.regCode } : {}),
      // 2026-11-02 用户规则：富民内部产品码（DX…）回传透传，供 fmResolveCode 优先短路。
      ...(opts.fmInternalCode ? { fmInternalCode: opts.fmInternalCode } : {}),
      ...((b === "boc" && opts.summaryComplete)
        ? { summaryComplete: true, sName: opts.sName, sRegCode: opts.sRegCode, sRisk: opts.sRisk, sBenchmark: opts.sBenchmark }
        : {}),
      // 2026-10-22 修复：把 mode 透传到银行抓取层（见 extraOf 注释）。
      ...(opts.mode ? { mode: opts.mode } : {}),
      // 2026-10-30 增量抓取：透传 since（本处是 extraOf 之外的独立副本，勿漏）。
      ...(opts.since ? { since: opts.since } : {}),
    };
    const r = await safeBank(b, c, transport, bankStage(b), timings, extra);
    bankResults[b] = r;
    if (!bankInfo && r) bankInfo = r; // 保留第一个有响应的银行信息（名称/登记编码等）
    // 仅当返回「全部历史净值」(>=2 点) 才采用；只回最新1个的银行(广发/华夏类)不在此采用，继续下一源
    // 2026-10-30 增量：增量腿只回新增点（0~1 点），navLegOk 放行，避免被拒后走全量兜底。
    if (navLegOkCtx(r, !!opts.since, b)) {
      nav = r;
      navVia = b;
      // 双端口银行由 fetch 实现显式回写 navPort（如 nbcb 的 app/web 实际命中者）；
      // 单端口银行从 BANK_PORTS 推导其唯一端口，列显示「银行+端口」用。
      navPort = r.navPort || bankPortOf(b);
      break;
    }
  }
  }
  // 银行 fetch 自身携带的双来源明细（如 cgb 的 App 主源 + 官网补末点）透传，供前端「净值来源」列显示；
  // 仅当本函数未通过 appFirst 自动构造 navSources 时采用（避免覆盖发行/代销双抓的定标结果）。
  if (!navSources && nav && Array.isArray(nav.navSources) && nav.navSources.length > 1) {
    navSources = nav.navSources;
  }
  // 双抓定标：当且仅当代销/发行两家都被实际试探过（即代销首抓未达标、触发了发行补抓，
  // 或偏好银行失败触发了另一家兜底）才比较并回传胜者。胜者前端持久化为 preferBank，后续固定走该银行。
  // ⚠ appFirst 产品每次实时定标，不回写记忆（记忆已在 tryBanks 构造时被忽略）。
  let preferredBank = undefined;
  if (!appFirst && issuer && agent && bankResults[issuer] !== undefined && bankResults[agent] !== undefined) {
    preferredBank = compareBankResults(bankResults[issuer], bankResults[agent], issuer, agent);
  }
  // 银行直连识别到的现金管理类（OPEN_TYPE=6 / XJL 等）→ 透传哨兵给上层（前端从源头拦截）
  for (const b of Object.keys(bankResults || {})) {
    if (bankResults[b] && bankResults[b]._excludedCash) isCash = true;
  }
  // 中国理财网兜底净值：仅 nav / all 模式需要（info / quota 模式不抓净值）
  if ((mode === "nav" || mode === "all") && !nav) {
    const reg = (bankInfo && bankInfo.regCode) || opts.regCode || null;
    const nm = (bankInfo && bankInfo.name) || opts.name || null;
    // 【2026-10-25 新增】渠道码 → 发行方份额码桥接（代销他行理财子产品的通用解法）。
    // 触发条件：本渠道按渠道码已抓空（走到这里即如此），且调用方未显式给份额码。
    // 典型场景：浦发代销信银安盈象2号（渠道码 2301232123 / 发行方份额码 AF223066H）——
    //   代销端口只回元数据、发行行端口按渠道码查空、中国理财网双键缺份额码 → 三处全空。
    // 解析成本≈0：内部名检索与下方 chinawealthNav 的同一次检索共享缓存。
    let shareHint = opts.shareCode ? String(opts.shareCode).trim().toUpperCase() : null;
    // 桥链起点：用于「最后手段」的时间闸门——① 已经把时间耗光时不再白跑 ③。
    const bridgeT0 = Date.now();
    // ① 发行行端口**自带按名检索**时（目前只有信银官网 /custom/productInfo/search），
    //    直接把「渠道码 + 产品名」再交给它一次：它内部会按名搜出该产品全部份额、
    //    按渠道名尾字母取对，再抓净值。这条腿完全不碰中国理财网，符合「净值优先走端口」。
    //    注：银行循环里其实已经调过一次，但 appFirst 分支给发行腿的预算是 3s（2026-10-23
    //    用户拍板收紧），信银「名检索+detail+nav(459KB)」要 5~6s 会被 race 成 null —— 故在此
    //    用更宽的预算重试一次；并发执行不额外拖长总时长。
    // 名称来源三路：nm = 代销行刚回的产品名；nameHint = 前端透传的已存名 / 上面向代销货架补取的名。
    // **只认 nm 会漏掉「代销腿为空/超时但前端有名字」这一大类**——实测
    // `?code=2301232123&agent=spdb&issuer=citic&mode=nav`（不带 name）时 spdb 腿回 null → nm 空
    // → 桥①整块被跳过，产品照旧抓不到。
    const lookupName = (nm && String(nm).trim()) || nameHint || "";
    if (!nav && issuer && issuer !== agent && ISSUER_NAME_LOOKUP.has(issuer) && lookupName) {
      const nT0 = Date.now();
      // 优先复用「定标超时仍在飞」的发行腿，避免同一产品被重复抓第二次。
      // ⚠ 复用条件必须是 nameHint 非空——即**第一腿确实带着名字出发过**（extraOf 已透传），
      // 那条请求会走按名检索、值得等；反之（无名字）它注定返回 null，复用等于白拿一个 null。
      // 复用（=不是新请求）时单独打一条计时，让时间分解能对上账；新请求由 safeBank 自己打标签，
      // 此处不再重复打（否则同一阶段会出现两行）。
      const reused = !!(issuerSlowP && nameHint);
      const p = reused ? issuerSlowP
        : safeBank(issuer, c, transport, "1y.净值·" + issuer + "(按名)", timings,
            { ...extraOf(issuer), name: lookupName }).catch(() => null);
      issuerSlowP = null;
      const r = await Promise.race([
        p,
        new Promise((res) => setTimeout(() => res(null), ISSUER_NAME_BUDGET_MS)),
      ]);
      if (navLegOkCtx(r, !!opts.since, issuer) && !r._excludedCash) {
        nav = r; navVia = issuer; navPort = r.navPort || bankPortOf(issuer);
        bankResults[issuer] = r;
        if (!bankInfo) bankInfo = r;
        else {
          if (bankInfo.holdDays == null && r.holdDays != null) bankInfo.holdDays = r.holdDays;
          if (!bankInfo.regCode && r.regCode) bankInfo.regCode = r.regCode;
        }
        navLog("name-lookup 发行行 " + issuer + " 按名命中 " + r.series.length + " 点 (" + (Date.now() - nT0) + "ms) name=" + lookupName);
        if (reused) navTiming(timings, "1y.净值·" + issuer + "(按名·复用)", Date.now() - nT0, "hit series=" + r.series.length);
      } else {
        navLog("name-lookup 发行行 " + issuer + " 按名无果/超时 (" + (Date.now() - nT0) + "ms) name=" + lookupName);
        if (reused) navTiming(timings, "1y.净值·" + issuer + "(按名·复用)", Date.now() - nT0, "null");
      }
    } else if (!nav && issuer && issuer !== agent && ISSUER_NAME_LOOKUP.has(issuer) && !lookupName) {
      // 没有名字就无从按名检索：明确记一笔，避免以后又把「没名字」误判成「接口失效」。
      navLog("name-lookup 发行行 " + issuer + " 跳过：代销腿未回产品名且前端未透传 name（无检索词）");
    }
    // —— ②③ 份额码路径（代销渠道码 → 发行方份额码）——
    // 抽成可复用函数：**有按名能力的发行行（信银）不再提前跑它**，而是留到 ④ 之后当最后手段。
    // 用户规则（2026-10-25）：「浦银从信银官网按产品名称就能抓净值，不需要信银的产品份额代码」。
    // 份额码路径要多花一次中国理财网名检索 + 一次完整的信银官网往返（实测 17.8s），
    // 在有按名能力时纯属重复劳动——① 拿到就用，① 拿不到直接让 ④ 中国理财网（约 6s）顶上。
    const nameCapableIssuer = !!(issuer && ISSUER_NAME_LOOKUP.has(issuer));
    const SHARE_RETRY_BUDGET_MS = 38000;
    // —— 中国理财网家族（份额码名检索 + 净值兜底）**总预算**（2026-10-31）——
    // 本机 IP 被中国理财网风控时，这两段串起来 = 名检索 21s + 兜底 42s = 64s > 前端 60s 预算
    //   → 前端掐断 → 用户只看到「抓取失败 60.0s」且**时间分解全空**（后端还没返回，零信息）。
    // 给整条链一个硬预算：超时即放弃，保证后端在预算内**带完整分解**返回。
    // 50s：允许中国理财网冷启动（xpl 握手 + getInitData 实测可到 ~40~50s），
    //   同时保证 银行腿(~2s) + 链(50s) < 前端 60s 预算 → 响应一定回得来。
    // ⚠ deadline 锚在 **T0（本次请求起点）** 而非「走到这里时」——前面的银行腿也占时间，
    //   否则 银行腿 20s + 链 50s = 70s 仍会超前端预算。
    const CW_CHAIN_BUDGET_MS = 50000;
    const cwChainDeadline = T0 + CW_CHAIN_BUDGET_MS;
    const cwChainRace = (p) => Promise.race([
      p,
      new Promise((res) => setTimeout(() => res(null), Math.max(0, cwChainDeadline - Date.now()))),
    ]);
    const tryShareBridge = async () => {
      if (nav) return;
      // ② 用中国理财网名检索拿「平台份额码」再按渠道名尾字母替换
      if (!shareHint) {
        const _cUp = String(c || "").trim().toUpperCase();
        // (A) 2026-11-01：渠道码即份额码白名单——与 XPL_SHARE_REG 区分：本表**不携带 regCode**，
        //   仅声明「该渠道码的解析份额码 === 自身」，故 ② 直接置 shareHint=c 跳过中国理财网名检索(0ms)，
        //   不参与主腿 bosc.cn 回落 / gapfill 取数（避免引入已知 0 点的 regCode Z7007124000370）。
        //   净值仍由 ④ 中国理财网按 shareCode=c 兜底（WPBK24M0501T 该路径已验证可用，346 点）。
        if (SHARE_EQ_CHANNEL.has(_cUp)) {
          shareHint = _cUp;
          navTiming(timings, "1x.份额码桥接", 0,
            "SHARE_EQ_CHANNEL 命中(渠道码=份额码) -> 跳过名检索，转中国理财网兜底");
          navLog("share-bridge " + c + " -> SHARE_EQ_CHANNEL 命中，跳过名检索，share=" + shareHint);
        } else {
          // 2026-10-31：XPL_SHARE_REG 已登记的码（人工核对的「渠道码 = xpl 的 subShareCode」精确映射）
          //   **直接用登记值，不做名检索** —— 名检索（getProductList）在被风控的 IP 上要挂 20s+ 白等
          //   （实测 667468WS 宁银代销招银理财：本地桥接 21.3s miss → 整单 64s 超前端预算 → 前端掐断）。
          //   登记的约定即「渠道码本身就是份额码」，故 shareHint = 渠道码。
          const _regd = XPL_SHARE_REG[String(c || "").trim().toUpperCase()];
          if (_regd) {
            shareHint = String(c).trim().toUpperCase();
            navTiming(timings, "1x.份额码桥接", 0,
              "XPL_SHARE_REG 已登记 -> 直接用渠道码作份额码 (reg=" + _regd + ")，跳过名检索");
            navLog("share-bridge " + c + " -> XPL_SHARE_REG 已登记，跳过名检索，share=" + shareHint);
          } else {
            const sbT0 = Date.now();
            // 【2026-11-01】把登记编码透进份额码桥接：优先按**登记编码**取本产品的份额族
            //   （不碰产品名 → 天然排除同名不同码的其它产品）。regCode 来源：调用方透传
            //   （前端已持久化）+ 代销行回传的 regCode。
            const _reg0 = String(opts.regCode || (bankInfo && bankInfo.regCode) || "").trim().toUpperCase();
            shareHint = await cwChainRace(resolveChannelShare(c, lookupName, transport, timings, _reg0).catch(() => null));
            if (shareHint) navLog("share-bridge " + c + " -> " + shareHint + " (" + (Date.now() - sbT0) + "ms)");
          }
        }
      }
      if (!shareHint || !issuer || issuer === agent) return;
      // (A) 2026-11-01：冗余桥接短路——解析出的份额码 === 渠道码 c 时，发行行 ③ 重查与主腿用**完全相同**的码
      //   （主腿已用 c 查过且失败，否则根本不会走到桥接），必冗余；故跳过 ③，直接让外层 ④ 中国理财网
      //   按 shareCode=c 兜底。省掉「净值·issuer(份额码) 1.5s」的纯开销。
      //   命中范围：SHARE_EQ_CHANNEL / XPL_SHARE_REG 登记的码（约定渠道码=份额码）均满足 shareHint===c。
      if (shareHint === String(c).trim().toUpperCase()) {
        navTiming(timings, "1x.份额码桥接", 0,
          "shareHint(" + shareHint + ") === 渠道码 " + c + " => ③发行行重查与主腿同码必冗余，跳过，转中国理财网兜底");
        navLog("share-bridge " + c + " => shareHint===c，跳过③发行行重查（与主腿同码），转中国理财网兜底");
        return;
      }
      // 【2026-10-31】招行(cmb)腿**不认 shareCode**（opts.shareCode 只被 citic/abc 使用），
      //   而 cmbwm 腿（现纯 HTTP+自实现 SM2，命中即完整序列，约 1~3s）一旦命中 → 再按份额码重试
      //   = 用同一个 code 再跑一遍纯 HTTP 请求（徒增耗时）。故命中 cmbwm 后直接跳过桥接。
      if (nav && nav.navPort === "cmbwm") return;
      // ③ 发行行按份额码重试：发行方官网口径通常含当日净值，比中国理财网（T+1）新一天。
      // 预算 38s（2026-10-25 从 12s 上调）：信银 getTAProductNav 要回 459KB，单次可耗 15~17.8s，
      // 原 12s 会在数据即将回来时把请求判死，白跑一趟还照样落到中国理财网。
      const rT0 = Date.now();
      const r = await Promise.race([
        safeBank(issuer, shareHint, transport, "1y.净值·" + issuer + "(份额码)", timings,
          { ...extraOf(issuer), shareCode: shareHint }).catch(() => null),
        new Promise((res) => setTimeout(() => res(null), SHARE_RETRY_BUDGET_MS)),
      ]);
      if (navLegOkCtx(r, !!opts.since, issuer) && !r._excludedCash) {
        nav = r; navVia = issuer; navPort = r.navPort || bankPortOf(issuer);
        bankResults[issuer] = r;
        // bankInfo 此前是代销行（浦发只回名称/风险，无持有期/登记编码）→ 用发行行结果补缺，
        // 但**只补缺失字段、不改名称**（用户列表按代销货架名展示）。
        // 成立日不在此补：信银官网 established 取 firstNavDate（本例 2023-03-29），与中国理财网
        // 登记口径（2022-05-19）不一致，宁缺勿错——留给信息阶段按登记编码直查。
        if (!bankInfo) bankInfo = r;
        else {
          if (bankInfo.holdDays == null && r.holdDays != null) bankInfo.holdDays = r.holdDays;
          if (!bankInfo.regCode && r.regCode) bankInfo.regCode = r.regCode;
        }
        navLog("share-bridge 发行行 " + issuer + " 按份额码 " + shareHint + " 命中 " + r.series.length + " 点 (" + (Date.now() - rT0) + "ms)");
      } else {
        navLog("share-bridge 发行行 " + issuer + " 按份额码 " + shareHint + " 无果/超时 (" + (Date.now() - rT0) + "ms)");
      }
    };
    // ④ 之前：发行行**没有**按名能力时，份额码就是它唯一的端口路径，先跑再落中国理财网。
    if (!nav && !nameCapableIssuer) await tryShareBridge();
    if (!nav) {
      const cwT0 = Date.now();
      // 2026-10-31：兜底纳入「中国理财网家族总预算」——本机 IP 被风控时它会挂 40s+，
      //   与份额码桥接串起来把总耗时顶到 64s > 前端 60s → 前端掐断 → 时间分解全空。
      const cw = await cwChainRace(chinawealthNav(c, { regCode: reg, name: nm, shareCode: shareHint, transport, sink: timings }));
      navTiming(timings, "1.净值·中国理财网兜底", Date.now() - cwT0, cw && cw.series ? "hit series=" + cw.series.length : "null");
      // 中国理财网按「投资性质=现金管理类」排除（2026-10-23）：透传哨兵给统一收口
      if (cw && cw._excludedCash) cwCash = true;
      if (cw && cw.series && cw.series.length) { nav = cw; navVia = "chinawealth"; navPort = null; }
    }
    // 最后手段：有按名能力的发行行，①（按名）与 ④（中国理财网）都没拿到时才试份额码。
    // 信银类产品正常走不到这里；留着是为了「按名检索词不匹配」时仍有一条端口路径兜底。
    // 时间闸门：① 若已耗掉大半预算（>20s），说明是「慢」而非「查不到」，再跑 ③ 只会把
    // 总时长顶出前端 45s 预算、反而拿不到任何数据 → 跳过。① 快速失败（如名检索不匹配）时才值得试。
    if (!nav && nameCapableIssuer && Date.now() - bridgeT0 < 20000) await tryShareBridge();
  }
  if (!bankInfo && nav) bankInfo = nav;

  // —— 1b. 跨源补缺（源无关）：主源序列近期存在断点（如长假后首日漏发净值，9-30→10-09 隔 9 天），
  // 用中国理财网（用户已确认含缺失日期，如 10-08）按日期并集补回缺失点。
  // 仅当「最新点在近 7 天 + 尾部相邻间隔≥2 天」才触发，避免给所有产品都多打一次中国理财网；
  // 主源已有的值优先，中国理财网只填主源缺的日期。navVia 保持主源不变（如 icbc/spdb），
  // 仅数据被补全（用户可在列表「净值来源」看到主源银行）。
  // 触发例：浦银理财天添鑫安泰7号A(PY26203A) 走工行代销(icbc)主源，长假后官方仅回 9-30 与 10-09、
  // 漏 10-08；本步从同产品登记编码的中国理财网全量序列补回 10-08。
  if (GAPFILL_ENABLED && nav && navVia && navVia !== "chinawealth" && navVia !== "xpl") {
    const s = nav.series || [];
    const recent = isRecentTail(s);
    const gap = tailGapDays(s);
    let tailPair = "(序列<2)";
    if (s.length >= 2) {
      const t = s.slice().sort((x, y) => (x[0] < y[0] ? -1 : 1));
      tailPair = t[t.length - 2][0] + "→" + t[t.length - 1][0];
    }
    const willFill = s.length >= 2 && recent && gap >= 2;
    // Fix A：若尾部大间隔完全是休市（国庆/春节等法定假日 + 周末），则不是漏发，跳过补缺
    const prevStr = s[s.length - 2][0], lastStr = s[s.length - 1][0];
    const gapAllHoliday = gapIsAllNonTrading(prevStr, lastStr);
    // Fix D：银行已回足历史（点数足够）则无需补缺，省一次中国理财网全量请求
    const bankHasEnough = s.length >= GAPFILL_MIN_BANK_POINTS;
    if (gapAllHoliday) {
      console.log("[gapfill-debug] " + c + " 主源=" + navVia + " 间隔=" + gap + "天 全部为休市(假日/周末) → 跳过补缺(纯休市非漏发)");
    } else if (bankHasEnough) {
      console.log("[gapfill-debug] " + c + " 主源=" + navVia + " 序列已 " + s.length + " 点(>=" + GAPFILL_MIN_BANK_POINTS + ") 已回足历史 → 跳过补缺(省中国理财网请求)");
    }
    const willFillFinal = willFill && !gapAllHoliday && !bankHasEnough;
    console.log("[gapfill-debug] " + c + " 主源=" + navVia + " 序列点数=" + s.length +
      " 尾部相邻=" + tailPair + " 间隔=" + gap + "天 最新点近7天=" + recent +
      " => " + (willFillFinal ? "触发补缺" : "跳过(条件不满足)"));
    if (willFillFinal) {
      // XPL_SHARE_REG 兜底：icbc 等银行不回 regCode，且 serve.mjs 未转发 regCode 时仍能命中中国理财网
      const gapReg = (bankInfo && bankInfo.regCode) || opts.regCode || XPL_SHARE_REG[c] || null;
      const gapName = (bankInfo && bankInfo.name) || opts.name || null;
      console.log("[gapfill-debug] " + c + " 补缺用 regCode=" + (gapReg || "-") + " name=" + (gapName || "-"));
      const cwT0 = Date.now();
      const cw = await chinawealthNav(c, { regCode: gapReg, name: gapName, transport, sink: timings });
      navTiming(timings, "1b.补缺·中国理财网", Date.now() - cwT0, cw && cw.series ? "hit series=" + cw.series.length : "null");
      if (cw && cw.series && cw.series.length) {
        const before = s.length;
        const merged = mergeNavByDate(s, cw.series);
        if (merged.length > before) {
          nav = { ...nav, series: merged };
          console.log("[gapfill-debug] " + c + " 中国理财网补回 " + (merged.length - before) + " 点（含 10-08）→ 现 " +
            merged.length + " 点，末日=" + merged[merged.length - 1][0]);
        } else {
          console.log("[gapfill-debug] " + c + " 中国理财网序列(" + cw.series.length + "点)未补回任何缺失日（主源已含）");
        }
      } else {
        console.log("[gapfill-debug] " + c + " 中国理财网未返回可用序列(reg=" + (gapReg || "-") + ") → 缺口未补");
      }
    }
  }

  // —— 2. 产品信息（最短持有天数/风险等级/成立日期/登记编码）——
  // 2026-10-16：regCode 兜底顺序 = 银行直连 regCode → 调用方 opts.regCode →
  //   XPL_SHARE_REG 按产品码直查（已补录的份额映射）→ 都缺才走中国理财网按名检索。
  //   按名检索会把名称相近的不同产品错配（聚宝盈60天2号 曾错挂 1 号的登记 Z7001026001429），
  //   故已补录的码一律走直查，名检索只作最后手段。
  let info = null, benchmark = null;
  if (mode === "info" || mode === "all") {
  const regCode = (bankInfo && bankInfo.regCode) || opts.regCode || XPL_SHARE_REG[String(c || "").trim().toUpperCase()] || null;
  const pname = (bankInfo && bankInfo.name) || opts.name || (nav && nav.name) || null;
  // infoComplete：前端标记本产品四项信息已补全过 → 跳过中国理财网重抓（spec「只抓一次」保证，
  // 见前端 observer_info_complete）。fullInfo（详情页强制）会否决它，确保仍可手动补一次。
  const infoComplete = !!opts.infoComplete && !fullInfo;
  const infoT0 = Date.now();
  const bankReg = !!(bankInfo && bankInfo.regCode);
  const bankRisk = !!(bankInfo && bankInfo.risk);
  const bankEst = !!(bankInfo && bankInfo.established);
  const bankHold = !!(bankInfo && bankInfo.holdDays != null);
  if (infoComplete) {
    // 四项已知齐全：跳过中国理财网，直接用银行直连字段组装（holdDays/established 由前端本地已存记录合并补齐，不在此重复抓）
    info = {
      risk: (bankInfo && bankInfo.risk) || null,
      established: (bankInfo && bankInfo.established) || null,
      holdDays: null,
      regCode: (bankInfo && bankInfo.regCode) || null,
      name: (bankInfo && bankInfo.name) || null,
      manager: (bankInfo && bankInfo.manager) || null,
      source: navVia || null,
    };
    navTiming(timings, "2.信息·已补全(跳过中国理财网)", Date.now() - infoT0, "reg=" + (info.regCode || "-") + " 四项已齐→本轮不重抓");
  } else if (bankReg && bankRisk && bankEst && bankHold) {
    // 直连银行一次性回齐四项（极少见）→ 跳过中国理财网
    info = { risk: bankInfo.risk, established: bankInfo.established, holdDays: bankInfo.holdDays, regCode: bankInfo.regCode, name: bankInfo.name, manager: bankInfo.manager, source: navVia };
    navTiming(timings, "2.信息·直连(跳过中国理财网)", Date.now() - infoT0, "四项齐全");
  } else {
    // 缺任意一项 → 中国理财网补全（优先 xinxipilu 按登记编码直查，避开旧站 wechatSearch 的 429 高发；
    //   仍只抓一次，由前端 infoComplete 标记保证后续不再重抓）。计时由 metaFromChinaWealthXpl 内部统一记，避免重复。
    try { info = await metaFromChinaWealthXpl(pname, c, regCode, timings, transport); }
    catch (e) {
      info = null;
      // 2026-10-14：内部抛错（如旧站 HTTP 5xx）时不会有任何阶段包络落账 → 已产生的 cw.*
      // 子项变成孤儿、被归到后续阶段名下（用户看到「基准阶段下面挂着 wechatSearch」）。
      // 补一个失败包络，让子项有父级可归、顶层分项与总耗时对得上。
      navTiming(timings, "2.信息·中国理财网(回退)", Date.now() - infoT0, "throw " + ((e && e.message) || e));
    }
  }
  // 2026-10-17 全量重订成立日优先级（85 产品扫描 + 三批直连探针实证，规则=用户拍板：
  // 「成立日期不得以净值系列判断，除非抓不到成立日期」）：
  //   ① 银行直连【真字段】（boc det.establishDate / bosc EstabDate / abc estblDate /
  //      nbcb projectsetupdate / huaxia licaiFoundDay / cmbc ESTAB_DATE / bob ESTABLISH_DATE…）
  //      恒优先于中国理财网名检索值——实测名检索错配频发且幅度大：
  //      BE31303A 被错配 2025-03-06（差 15 个月）、NYJXLDDBDCL14 与 NYJXLDYX14 两个不同
  //      产品撞同一登记编码 Z7001126000920、FLJYXC18001 错配 +50 天、ZGN2660104A 错配 +149 天。
  //   ② 银行只有【序列首点】（establishedFromSeries，icbc/psbc/ccb/光大自营等无真字段的行）时，
  //      名检索值仅在与序列首点相差 0<gap≤45 天时采用（募集期模式：成立日晚于首条净值日
  //      1~45 天，boc/bosc 真字段实测 +1/+2/+4/+5/+8 天均落此窗）；超出即判名检索错配，用序列首点。
  //   ③ 名检索完全没给成立日 → 用银行值补缺（修复 AF258630G 类 boc 真字段被整体丢弃：
  //      establishDate=2025-02-26 而序列首点 2025-11-25，此前 xpl 未命中即 info=null 丢失）。
  if (bankInfo && bankInfo.established && info && info.established && info.established !== bankInfo.established) {
    const bankReal = !bankInfo.establishedFromSeries;
    const gap = estGapDays(bankInfo.established, info.established); // 正=名检索值更晚
    const xplOk = !bankReal && gap != null && gap > 0 && gap <= 45; // 仅序列口径下行才容忍名检索（募集期窗）
    if (!xplOk) {
      navTiming(timings, "2.信息·成立日校正(银行直连优先)", 0,
        "采用 " + bankInfo.established + "（名检索原值 " + info.established + (bankReal ? "，银行真字段" : "，相差 " + gap + " 天超募集期窗口") + "）");
      info.established = bankInfo.established;
    }
  }
  if (bankInfo && bankInfo.established && (!info || !info.established)) {
    if (!info) info = {};
    info.established = bankInfo.established;
    navTiming(timings, "2.信息·成立日补缺(银行直连)", 0,
      "名检索未给成立日，采用银行值 " + bankInfo.established + (bankInfo.establishedFromSeries ? "（序列首点口径）" : "（真字段）"));
  }
  // 2026-10-19：risk/holdDays/manager 同款补缺——银行端口直连给了值（如东莞银行 App 端口回
  // riskLevel=R1/holdDays、建行 NLCQ11 回 R2），但信息阶段因缺 regCode 走了中国理财网名检索、
  // info 被整体替换导致这些字段丢失（实测 RRK01A risk/holdDays 双双变 null）。规则与成立日
  // 补缺一致：名检索没给的才用银行直连值补，名检索给了的以名检索为准（不覆盖）。
  if (bankInfo) {
    if (!info) info = {};
    if (!info.risk && bankInfo.risk) {
      info.risk = bankInfo.risk;
      navTiming(timings, "2.信息·风险补缺(银行直连)", 0, "名检索未给风险，采用银行值 " + bankInfo.risk);
    }
    if (info.holdDays == null && bankInfo.holdDays != null) {
      info.holdDays = bankInfo.holdDays;
      navTiming(timings, "2.信息·持有期补缺(银行直连)", 0, "名检索未给持有天数，采用银行值 " + bankInfo.holdDays);
    }
    if (!info.manager && bankInfo.manager) info.manager = bankInfo.manager;
  }
  navLog("info code=" + c + " pname=" + (pname || "-") + " reg=" + (regCode || "-") + " -> " +
    (info ? ("hit regCode=" + (info.regCode || "-") + " holdDays=" + (info.holdDays != null ? info.holdDays : "-") + " risk=" + (info.risk || "-")) : "null") +
    " (" + (Date.now() - infoT0) + "ms)");

  // —— 3. 业绩比较基准：复用第 1 步已抓结果（优先主源/首响应银行，再试代销银行；不重抓）——
  // 2026-10-12 修订：第 1 步已把发行/代销银行各抓过一次，这里【复用其结果】，只有该银行
  // 确实没抓过（理论上不会发生，agent 恒在 tryBanks 里）才重新抓。此前每次都 safeBank(agent)
  // 重抓一遍，对 psbc 这类 3~4s/次的银行等于每个产品白付一次全量抓取 —— 是「同一产品第二次
  // 刷新反而更慢」的主要放大器之一（psbc 对并发/高频限流，重复请求进一步拖慢后续产品）。
  // 2026-10-12 续：新增「本地缓存复用」——前端已标记本产品业绩比较基准查过（含查到空白），
  // 直接复用本地值、不再从中国理财网/银行重查（用户规则：空白也只查一次，之后不再查）。
  // 2026-10-22 修复作用域遮蔽 bug：此处原是 `let benchmark = null;`（info/all 包裹内，depth 3），
  // 把上方 try 级 L2721 的 benchmark 遮住——所有赋值写进影子变量，末尾 return 读到的
  // try 级变量恒为 null → **所有产品的业绩比较基准恒返回 null**（系统性 bug）。
  // 去掉 let 后赋值直落 try 级变量，return 正常读到。
  benchmark = null;
  if (opts.benchmarkKnown) {
    benchmark = (opts.benchmark != null) ? opts.benchmark : null;
    navTiming(timings, "3.基准·复用本地缓存", 0,
      (benchmark != null && benchmark !== "") ? ("hit " + benchmark) : "已知空白(不再重查)");
  } else {
    benchmark = (bankInfo && bankInfo.benchmark) || null;
    if (!benchmark && agent) {
      const prev = bankResults[agent]; // 第 1 步该银行的原始返回（可能是 series<2 未被采用但带 benchmark 的响应）
      if (prev) {
        if (prev.benchmark) benchmark = prev.benchmark;
      } else {
        // 2026-10-23 修复：这里原来不带 mode —— 第 1 步没抓过该银行时会重抓一次**全量**（含净值）。
        // 刷信息时「3.基准·boc」下面出现 HistoryNavQueryOutlay 就是这条路径（用户审计发现）。
        // 现透传 mode，银行函数按同一套门控只取信息/额度。
        const a = await safeBank(agent, c, transport, "3.基准·" + agent, timings,
          { ...(opts.noCache ? { noCache: true } : {}), ...(opts.mode ? { mode: opts.mode } : {}) });
        if (a && a.benchmark) benchmark = a.benchmark;
      }
    }
    // 2026-10-19 补：代销行结果不带基准时，再试发行行已抓结果。webank 自 2026-10-19 可成
    //   净额主源（bankInfo 即 webank，而 App 端口 210 字段无 benchmark、XPL 未登记该份额码
    //   时也为 null）——若不回看发行行，jsb/fminbank 等端口会回基准的发行产品，其基准会被
    //   白白漏掉（原本发行行胜出时由 bankInfo 顺带提供）。发行行也无则保持 null（日开产品
    //   普遍无业绩基准，前端按 benchmarkKnown 语义只查一次、之后不再重查）。
    if (!benchmark && issuer && bankResults[issuer] && bankResults[issuer].benchmark) {
      benchmark = bankResults[issuer].benchmark;
    }
  }
  } // 关闭「仅 info/all 模式抓产品信息+基准」包裹

  // —— 4. 额度：从已抓取的代销/发行银行结果里取（平安/邮储/中行/富民已实现 remainQuota）——
  // 优先主源(nav)，其次首响应银行(bankInfo)；两者都无额度时，再遍历第 1 步已抓到的其它银行
  // （代销 bankResults[agent] → 发行 bankResults[issuer] → 其余），取第一家带额度的。
  // 复用第1步已抓到的银行对象，避免为额度再打一次网络（psbc/boc 的 fetch 已顺带返回额度）。
  // 2026-10-15：第 1 步翻转为「代销银行优先」后，nav 通常即代销银行——代销接口顺带
  // 返回剩余额度（发行银行没有额度），与本轮顺序调整的动机一致。
  // 2026-10-19 修复：净值由发行行胜出（如北银京华远见 754 点 > 富民 172 点）时，nav/bankInfo
  //   都指向发行行，而发行行通常无额度字段 → 额度整列落空（截图里显示 "--"），与此同时代销
  //   银行其实已返回额度（富民 residual_amount）。故补「已抓结果遍历」这一层，净值定标不变。
  let quota = null;
  if (mode === "quota" || mode === "all") {
  const quotaSrcOf = (cand) => (cand && (cand.remainQuota != null || cand.remainQuotaPct != null || cand.quotaState != null || cand.quotaText != null)) ? cand : null;
  let quotaFrom = null;
  const quotaOrder = [];
  const pushCand = (k, v) => { if (v && quotaOrder.indexOf(v) === -1) quotaOrder.push(v); };
  pushCand("nav", nav); pushCand("bankInfo", bankInfo);
  if (agent && bankResults[agent]) pushCand("agent:" + agent, bankResults[agent]);
  if (issuer && bankResults[issuer]) pushCand("issuer:" + issuer, bankResults[issuer]);
  for (const k of Object.keys(bankResults || {})) pushCand(k, bankResults[k]);
  const quotaKeys = [];
  {
    // 与 quotaOrder 对齐的标签（nav/bankInfo 之外的直接标银行 key）
    let i = 0;
    for (const v of quotaOrder) {
      let label;
      if (v === nav) label = "nav";
      else if (v === bankInfo) label = "bankInfo";
      else label = Object.keys(bankResults || {}).find((k) => bankResults[k] === v) || ("#" + i);
      quotaKeys.push(label);
      i++;
    }
  }
  for (let i = 0; i < quotaOrder.length; i++) {
    const cand = quotaSrcOf(quotaOrder[i]);
    if (!cand) continue;
    quota = {
      remainQuota: cand.remainQuota != null ? cand.remainQuota : null,
      remainQuotaPct: cand.remainQuotaPct != null ? cand.remainQuotaPct : null,
      saleStatus: cand.saleStatus || null,
      currency: cand.currency || null,
      quotaState: cand.quotaState || null,
      quotaText: cand.quotaText || null, // 工行网银文本额度（如 ">1亿元"/"8000万"），数值不可靠时前端直接显示文本
    };
    quotaFrom = quotaKeys[i];
    break;
  }
  if (quota) {
    navLog("quota code=" + c + " via=" + (quotaFrom || "-") +
      " remainQuota=" + quota.remainQuota + " pct=" + quota.remainQuotaPct + " status=" + (quota.saleStatus || "-") + " currency=" + (quota.currency || "-") +
      " remainQuotaType=" + typeof quota.remainQuota);
  } else {
    navLog("quota code=" + c + " -> null（该银行免登录接口不提供额度字段）");
  }

  // —— 4b. 工行额度独立补抓（2026-10-12 修复）——
  // 第1步净值由他行（如中银理财 boc 发行）先返回并 break，icbc 未被调用；而额度仅 icbc 通道有
  // （icbc 额度走独立 NoSession 端点，与净值接口解耦）。故发行/代销含 icbc 且额度仍空时，
  // 显式补抓 icbc 额度接口，命中即采用。避免「中银/民生/信银/浦银等发行、工行代销」的产品额度全空白。
  if (!quota && (issuer === "icbc" || agent === "icbc")) {
    const qT0 = Date.now();
    const q = await icbcQuota(c, transport).catch(() => null);
    navTiming(timings, "4b.额度·icbc补抓", Date.now() - qT0, q ? ("hit status=" + (q.quotaState || q.quotaText || "-")) : "null");
    if (q) {
      quota = {
        remainQuota: q.remainQuota != null ? q.remainQuota : null,
        remainQuotaPct: null,
        saleStatus: q.saleStatus || null,
        currency: q.currency || null,
        quotaState: q.quotaState || null,
        quotaText: q.quotaText || null,
      };
      navLog("quota code=" + c + " via=icbc(补抓·净值由他行提供) status=" + (q.quotaState || "-") + " text=" + (q.quotaText || "-"));
    }
  }
  } // 关闭「仅 quota/all 模式抓额度」包裹

  const name = (bankInfo && bankInfo.name) || (info && info.name) || (nav && nav.name) || null;
  const manager = (bankInfo && bankInfo.manager) || (info && info.manager) || null;

  // ===== 【项目铁律·统一收口】现金管理类一律不考虑（2026-10-23 用户再次重申）=====
  // 只收录「有单位净值的固收产品」。三种抓取行为（净值 / 信息 / 额度）必须一致：
  // 一旦判定为现金类，本次请求**不下发任何数据**（nav/info/quota 全 null，只回 isCash 哨兵），
  // 前端据此提示「该产品为现金管理类」并拒绝收录；已入列产品刷新时也不会被写回。
  // 此前只有 nav/all 模式能靠「整段恒 1」判定，info/quota 不抓序列 → 现金类被当普通产品收录
  // （实测：中邮理财天天盈 ZHPSBC0001 刷信息回「持有1天/R1/登记编码」、刷额度回 1000 亿）。
  // 判定信号按可靠性排序，任一命中即排除：
  //   ① 银行直连类型哨兵 _excludedCash（bob/ccb 的 OPEN_TYPE=6 等）
  //   ② 银行返回对象上的 cash:true（中邮官网模板码 1702 / 平安 isCashManagementCategory /
  //      上银 indCashManageProduct / 农行官网 cash / 南银 variety=3 / 兴业 productType1=XJL …）
  //   ③ 净值序列整段恒 1（±1e-6）—— 现金管理类单位净值归一，任一源（含中国理财网）拿到都算
  //   ④ 产品名强信号（该行无类型字段且本模式不抓净值时的兜底，见 CASH_NAME_RE）
  if (!isCash) {
    for (const b of Object.keys(bankResults || {})) {
      const r = bankResults[b];
      if (r && (r._excludedCash === true || r.cash === true)) { isCash = true; break; }
    }
  }
  if (!isCash && nav && nav.cash === true) isCash = true;
  if (!isCash && nav && isFlatNavSeries(nav.series)) isCash = true;
  // ⑤ 中国理财网兜底通道的投资性质=现金管理类（2026-10-23 新增，覆盖 info/quota 模式）
  if (!isCash && cwCash) isCash = true;
  // ⑥ 中国理财网产品信息（info 来源）的投资性质=现金管理类
  if (!isCash && info && info.cash === true) isCash = true;
  if (!isCash) {
    const nm = name || opts.name || null;
    if (nm && isCashProductName(nm)) isCash = true;
  }
  if (isCash) {
    navLog("code=" + c + " 判定为现金管理类 -> 按项目铁律不收录（mode=" + mode + "，数据全部丢弃）");
    navTiming(timings, "现金管理类·不收录", 0, "按项目铁律排除，不下发净值/信息/额度");
    return {
      code: c,
      isCash: true,
      navVia: null,
      navPort: null,
      nav: null,
      name: null,
      manager: null,
      info: null,
      benchmark: null,
      quota: null,
      bankInfo: null,
      timings,
      preferredBank: undefined,
    };
  }

  // —— 耗时汇总：阶段自报明细 + 总耗时，随返回值带出（前端/探针可展示，生产无消费者零影响）——
  navTiming(timings, "总耗时", Date.now() - T0, "navVia=" + (navVia || "-"));
  // 2026-10-22 模式门控：只下发当前模式对应的字段，其余置 null（前端只写对应字段，互不影响）
  const retNav = (mode === "nav" || mode === "all");
  const retInfo = (mode === "info" || mode === "all");
  const retQuota = (mode === "quota" || mode === "all");
  return {
    code: c,
    isCash: isCash || undefined,              // 银行直连识别到现金管理类（OPEN_TYPE=6/XJL 等）→ 前端从源头拦截
    navVia: retNav ? navVia : null,           // 净值实际来源：发行银行key / 代销银行key / "chinawealth"
    navPort: retNav ? navPort : null,         // 实际命中端口：app / web / null(中国理财网)；配合 navVia 前端渲染「银行+端口」
    nav: retNav && nav ? { series: nav.series, kind: nav.kind || "nav", navBasis: nav.navBasis || "nav", source: navVia, navIncremental: !!nav.navIncremental, regCode: nav.regCode || null, navShare: nav.navShare || null, navViaCode: nav.navViaCode || null } : null,
    // 双来源明细（仅 appFirst 并发双抓且两家都拿到全序列时非空）：
    // [{bank, port, points, lastDate, lastNav}]，主来源（=navVia）排第一。
    // 前端「净值来源」列据此同时显示两家（用户 2026-10-25 要求「2 个都写」）。
    navSources: retNav ? navSources : null,
    name: (mode !== "quota") ? name : null,
    manager: (mode !== "quota") ? manager : null,
    // 发行方权威标记（代销行/官网自己披露的 taName）→ 前端据此覆盖种子里的手填值
    managerAuthoritative: !!(retNav && nav && nav.managerAuthoritative),
    info: retInfo && info ? {
      holdDays: info.holdDays != null ? info.holdDays : null,
      risk: info.risk || null,
      established: info.established || null,
      regCode: info.regCode || null,
    } : null,
    benchmark: retInfo ? ((benchmark != null) ? benchmark : null) : null,  // 保留空串「已知无基准」哨兵，供前端缓存复用（不再重查）
    quota: retQuota ? (quota != null ? quota : null) : null,
    bankInfo: retInfo ? (bankInfo ? { source: bankInfo.source || null, bank: bankInfo.bank || null, regCode: bankInfo.regCode || null } : null) : null,
    timings,                                  // [{stage, ms, note}] 分阶段耗时（2026-10-12 新增）
    // 双抓定标：发行/代销两家都被试探且分出胜负时，回传偏好银行（前端持久化为 preferBank，
    // 以后只抓该银行，不再试另一家）。undefined 时不下发，避免覆盖前端已有的有效标记。
    // 仅 nav 模式参与（定标是针对净值来源的判断）。
    preferredBank: (retNav && typeof preferredBank === "string") ? preferredBank : undefined,
  };
  } catch (e) {
    throw e;
  }
}

/**
 * 光大银行（ceb）—— 净值链路（2026-10-22 重排）：**官网静态页主源 + eoap App 端口补字段**，
 * 两者并发跑；官网/直连全失败才交编排层中国理财网兜底。
 * （2026-10-15「只走 3 家」规则起，工行代销通道已废除为 ceb 的回落源——见下方
 *  cebDirectNav 尾部注释；代销阶段缺口统一由编排层「代销→发行→中国理财网」覆盖。
 *  ICBC 只会以 predict 判定的「代销银行」身份进入编排，不再是 ceb 的专用兜底。）
 *
 * 2026-10-22 用户要求：刷净值 / 刷信息 / 刷额度**都走新的官网**。官网「历史业绩」静态页
 *   （ceb_direct_nav.mjs 的 cebWebNav：真 Chrome 跑页面自身 getLsjz 读 window.dataList）
 *   提供全量净值（含当天，EW7746A 91 点实测）+ 产品名（cpname）；eoap 端口只补官网没有的
 *   信息七件套 / 额度字段，官网无序列时其序列兜底。旧「quota 模式 eoap 直接返回」「eoap 有
 *   全序列时所有模式直接返回」已废除——那正是刷额度/刷信息从不走官网的根因。
 *
 * 为什么不裸 HTTP 抓光大官网：光大 www.cebbank.com 全线走瑞数（$_ts）动态令牌防护，
 *   /eportal/ui 上的 getLsjz 接口必须先在真实浏览器里执行挑战脚本拿到令牌才能访问。
 *   Cloudflare Workers 没有浏览器环境、出网 IP 也与令牌绑定，无法完成挑战，
 *   实测 headless Chrome 一律 400 空白响应。故生产（Workers）恒走中国理财网兜底，
 *   官网通道仅在本机 Node（serve.mjs）环境生效。
 *
 * 注（2026-10-10 验证）：光大 WAF 对出口 IP 风险分层——云/机房出口给 412 瑞数挑战（真浏览器可解），
 *   住宅 IP 直接 400 硬拒（用户本机即此情况）。但静态页 + 页面自身 getLsjz 的组合在用户网络实测可用
 *   （EW7746A/EW6210A/EW7899A 三码验证）；legacy TLS 直连仍可能 400/412 时灵时不灵，只作兜底。
 *
 * 净值口径（项目规则 2026-10-21 立）：现金管理类（阳光碧乐活等，nav 恒 1 + 万份收益）
 * 一律排除不抓；其余按单位净值。
 */

/* ==========================================================================
 * 光大银行 App 端口（eoap 营销 H5）—— 2026-10-16 新增，ceb 的首选端口
 *
 * 端口形态：手机银行把产品分享到微信 → 得到
 *   https://eoap.cebbank.com/uiap/ebdc/?...#/productDetail?...&accessId=<accessId>&fromShareChannel=mobileBank
 * 该 H5 经 ebdService 网关取数，接口带国密（SM2 握手 + SM4 报文）与瑞数 RS5 双保护。
 * 实现见 scrape/ceb_eoap.mjs：用真 Chrome（必须带 --disable-blink-features=AutomationControlled，
 * 否则瑞数判定自动化并毒化 P cookie → 全部 400）跑通，再借 App 自己的 webpack 模块调它的 $ajax，
 * 由 App 完成加解密 —— 我们直接拿解密后的对象。免登录、免签名、免 PDF。
 *
 * 拿到什么（比原官网通道多得多）：
 *   名称 / 发行机构 / 风险等级 / 最短持有天数 / 成立日 / 登记编码 / 业绩比较基准 /
 *   剩余额度 / 起购金额 / 最新净值日期 / 阶段涨跌（近1·3·6月·1年，App 直出）/
 *   **全量净值序列**（performanceGraph，xaxis+yaxis，本例 170 点 2026-01-28→2026-10-15）。
 *
 * ⚠ 硬约束：**一个 accessId 只对应一个产品**（productDetail 必须带 accessId）。
 *   performanceGraph 虽按 proCode 查，但实测只对当前会话产品有数据，换别的码一律 emptyGraph。
 *   所以要新增覆盖产品，必须拿到它自己的分享链接 —— 见下方 CEB_APP_ACCESS 与
 *   /api/cebapp?link=<分享链> 路由（会自动把 code→accessId 落盘到 scrape/ceb_eoap_access.json）。
 *
 * ⚠ Cloudflare Workers 无 Chrome，本段整体不执行（动态 import 只在 Node 运行时解析）。
 * ========================================================================== */

/** 已覆盖的产品：产品代码 → 分享链 accessId（新增产品往这里加，或走 /api/cebapp 自动落盘） */
const CEB_APP_ACCESS = {
  // 阳光金创利稳健日开33号（7天最低持有）A —— 2026-10-16 由用户提供分享链打通
  EW6210A: "8799661575121608704796524",
};

/** 允许把 code→accessId 放在外部 JSON 里增量维护（不存在就只用内置表） */
let _cebAccessCache = null;
async function cebAccessMap() {
  if (_cebAccessCache) return _cebAccessCache;
  const map = Object.assign({}, CEB_APP_ACCESS);
  if (typeof process !== "undefined" && process.versions && process.versions.node) {
    try {
      const fs = await import("node:fs/promises");
      const url = new URL("./ceb_eoap_access.json", import.meta.url);
      const j = JSON.parse(await fs.readFile(url, "utf8"));
      for (const k of Object.keys(j || {})) {
        if (/^[A-Za-z0-9]{4,20}$/.test(k) && typeof j[k] === "string") map[String(k).toUpperCase()] = j[k];
      }
    } catch (e) { /* 文件不存在 / 解析失败 → 用内置表 */ }
  }
  _cebAccessCache = map;
  return map;
}

/** 供宿主（serve.mjs）在拿到新分享链时登记映射，免重启 */
export function setCebAppAccess(code, accessId) {
  const c = String(code || "").trim().toUpperCase();
  const a = String(accessId || "").trim();
  if (!c || !a) return false;
  CEB_APP_ACCESS[c] = a;
  if (_cebAccessCache) _cebAccessCache[c] = a;
  return true;
}

/**
 * 光大 App 端口抓取（仅本机 Node）
 * @param {string} code 产品代码（须已在 CEB_APP_ACCESS 里登记 accessId）
 * @param {{accessId?:string, link?:string, period?:string}} opts
 */
export async function cebAppFetch(code, opts = {}) {
  const c = String(code || "").trim().toUpperCase();
  const accessId = String(opts.accessId || "").trim() || (c ? (await cebAccessMap())[c] : "") || "";
  if (!accessId) {
    navLog("ceb app code=" + c + " 未登记 accessId（需该产品的分享链）-> null");
    return null;
  }
  const t0 = Date.now();
  try {
    const mod = await import(new URL("./ceb_eoap.mjs", import.meta.url).href);
    const d = await mod.cebEoapFetch({ accessId: accessId, proCode: c, period: opts.period || "Y1", infoOnly: !!opts.infoOnly || opts.mode === "quota" });
    if (!d) {
      navLog("ceb app code=" + c + " -> null (" + (Date.now() - t0) + "ms)");
      return null;
    }
    // 2026-10-22：序列为空**不再丢弃**。天天购类产品（如 EW7746A）performanceGraph 服务器
    // 恒回 emptyGraph:true（所有周期/所有类型，App 自身页面也不渲染净值图），但详情字段
    // （名称/登记编码/风险/持有/成立日/基准/额度/净值日期）齐全 —— 由调用方 cebFetch 决定
    // 用途（净值仍走中国理财网兜底，信息/额度从这里落）。
    if (!opts.infoOnly && opts.mode !== "quota" && (!d.series || !d.series.length)) {
      navLog("ceb app code=" + c + " -> info-only（emptyGraph，净值交中国理财网兜底）(" + (Date.now() - t0) + "ms)");
    }
    navLog("ceb app code=" + c + " -> " + (opts.infoOnly ? "infoOnly" : ("n=" + (d.series || []).length)) + " name=" + (d.name || "-") + " (" + (Date.now() - t0) + "ms)");
    return {
      name: d.name || c,
      manager: d.manager || "光大理财",
      established: d.established || (d.series && d.series.length ? d.series[0][0] : null),
      establishedFromSeries: !d.established, // 分享 H5 无成立日字段时退序列首点
      series: d.series || [],
      kind: "nav",
      navBasis: "nav",
      risk: d.risk || null,
      holdDays: (d.holdDays != null) ? d.holdDays : null,
      regCode: d.regCode || null,
      // 2026-10-22：编排层信息阶段四项齐全检查与 chinawealthNav 的登记编码来源读的是
      // registryCode（boc 口径），ceb 对象一直只给 regCode → 恒判「缺登记编码」而多跑一次
      // 中国理财网信息查询。曾补 registryCode 别名让直连四项齐全时跳过该查询（EW7746A 省 ~2.3s）。
      // 2026-11-02 登记编码字段名统一为 regCode：编排层读取一并折叠，别名不再需要（否则成重复键）。
      benchmark: d.benchmark || null,
      remainQuota: (d.remainQuota != null) ? d.remainQuota : null,
      remainQuotaText: d.remainQuotaText || null,
      minFirstAmount: d.minFirstAmount || null,
      netvalueDate: d.netvalueDate || null,
      periodRiseFall: d.periodRiseFall || null,
      proId: d.proId || null,
      accessId: d.accessId || accessId,
      source: "live",
      bank: "ceb",
      navVia: "ceb",
      navPort: "app",
    };
  } catch (e) {
    navLog("ceb app code=" + c + " throw " + ((e && e.message) || e) + " (" + (Date.now() - t0) + "ms)");
    return null;
  }
}

export async function cebFetch(code, opts = {}) {
  // 【2026-10-22 用户要求：刷净值/刷信息/刷额度都走新的官网】链路重排为「官网主源 + eoap 补字段」：
  //   ① 官网「历史业绩」静态页（cebWebNav，真 Chrome 跑页面自身 getLsjz）：全量净值
  //     （含当天，EW7746A 91 点实测）+ 产品名（window.cpname）——净值主源；
  //   ② eoap App 端口：只补官网没有的字段（信息七件套 / 额度），官网无序列时其序列兜底；
  //   ③ legacy TLS 直连（cebDirectNav）：静态页失败时的兜底。
  // ①② 并发跑（总耗时≈较慢一方而非相加）；净值一律取官网（更新到当天），官网失败才用 eoap 序列。
  // 旧行为「quota 模式 eoap 直接返回」「eoap 有全序列时所有模式直接返回」已废除——
  // 那正是刷额度/刷信息从不走官网的根因（用户 2026-10-22 反馈：刷额度或刷信息没走新的官网）。
  // App 端口仅对「已登记 accessId」的产品生效；未登记码秒级 null，不影响官网主链路。
  let appInfo = null;
  let web = null;
  // 【2026-10-23 用户规则】刷信息只刷信息、刷额度只刷额度——两者都不抓净值。
  // 光大净值唯一来源是官网静态页/legacy 直连（cebWebNav / cebDirectNav），
  // 信息与额度全在 eoap App 端口（cebAppFetch）。故 info/quota 只跑 eoap 且要求 infoOnly，
  // 不再启动官网静态页抓取（原实现无条件并发跑，是「刷信息也要拉全量净值」的根因）。
  const __noNav = opts.mode === "info" || opts.mode === "quota";
  if (typeof process !== "undefined" && process.versions && process.versions.node) {
    const webP = __noNav ? Promise.resolve(null) : (async () => {
      try {
        const mod = await import(new URL("./ceb_direct_nav.mjs", import.meta.url).href);
        // 先试官网「历史业绩」静态页方案；拿不到再回落 legacy TLS 直连（瑞数 412 时灵时不灵的那条）
        let d = null;
        try { d = await mod.cebWebNav(code); } catch (e) { /* 静态页异常 → 回落 legacy */ }
        if (!d || !d.navs || !d.navs.length) d = await mod.cebDirectNav(code);
        navLog("ceb direct code=" + code + " -> " + (d && d.navs && d.navs.length ? ("hit n=" + d.navs.length + " name=" + (d.name || "-")) : "null"));
        return d;
      } catch (e) { return null; }
    })();
    const appP = cebAppFetch(code, __noNav ? { ...opts, infoOnly: true } : opts).catch(() => null);
    const [w, app] = await Promise.all([webP, appP]);
    web = w;
    // 官网无序列时，eoap 的全序列兜底（如 App 端口已打通、静态页恰好无数据的产品）
    if (app && app.series && app.series.length >= 2 && !(web && web.navs && web.navs.length)) return app;
    // eoap 信息/额度对象暂存：官网静态页只有净值+名称，基准/额度/风险/持有/登记编码全在 eoap 上
    if (app && (app.name || app.remainQuota != null || app.remainQuotaText || app.benchmark)) appInfo = app;
  }
  if (web && web.navs && web.navs.length) {
    const navs = web.navs;
    // 现金管理类判据（光银现金 / 阳光碧乐活等）：nav 恒为 1.0，真实收益在 income（万份收益）。
    // 【项目规则 2026-10-21 立】现金管理类一律不抓：历史上的「从 1.0 复利合成单位净值
    // + navBasis:"wan"」处理已删除，命中即 return null 排除，勿再 reintroduce。
    const navFlat = navs.every((n) => {
      const v = parseFloat(n.nav);
      return Number.isFinite(v) && Math.abs(v - 1) < 1e-4;
    });
    const maxIncome = navs.reduce((m, n) => Math.max(m, Number(n.income) || 0), 0);
    if (navFlat && maxIncome > 0) return { _excludedCash: true, code };
    // 统一升序（web 静态页 dataList 为最新在前；旧 legacy 路径亦非保证升序）——
    // 升序后 series[0][0] 即最早净值日（≈成立日，募集期占位点），供下方 established 取用。
    const series = navs
      .map((n) => [n.date, Number(parseFloat(n.nav).toFixed(8))])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    // eoap 端口（appInfo）拿到的信息/额度字段补入：web 静态页只有净值序列，
    // 而基准(benchmark)/额度(remainQuota)/风险/持有/登记编码全在 appInfo 上——
    // 不合并会让 all/info 模式 bench=N/quota=N（2026-10-22 实测缺口）。
    const ai = appInfo || {};
    return {
      name: web.name || ai.name || code,
      manager: "光大理财",
      established: ai.established || series[0][0],
      establishedFromSeries: !ai.established, // eoap 无成立日时退序列首点（含募集期）
      series,
      kind: "nav",
      navBasis: "nav",
      source: "live",
      bank: "ceb",
      navVia: "ceb",
      navPort: "web",
      risk: ai.risk || null,
      holdDays: ai.holdDays != null ? ai.holdDays : null,
      regCode: ai.regCode || null,
      // 2026-11-02 登记编码字段名统一为 regCode：原 registryCode 别名已折叠（见 cebAppFetch 同款注释）
      benchmark: ai.benchmark || null,
      remainQuota: ai.remainQuota != null ? ai.remainQuota : null,
      remainQuotaText: ai.remainQuotaText || null,
      minFirstAmount: ai.minFirstAmount || null,
      netvalueDate: ai.netvalueDate || null,
    };
  }
  // 官网/直连全失败：回落 eoap 端口的信息/额度对象（无序列）——编排层不会把它当净值源
  // （series<2 不采用），但 bankInfo 与额度步骤能吃到 名称/登记编码/基准/额度。
  return appInfo || null;
}

/* ==========================================================================
 * 招商银行（CMB）实时抓取 —— cfweb 理财超市（cfweb.paas.cmbchina.com）
 *
 * 鉴权：SM4-ECB-PKCS7 国密签名（appId + "|" + timespan）。cmbSign 复用文件顶部
 *       「国密工具箱」里的 SM4（Byte-wise 对齐 Python cmb.py，也对齐 sm-crypto），
 *       避免再抄一份 SBOX／轮密钥；且国密实现与本文件一起单文件部署，不依赖第三方包。
 * 接口（均已实测可用；CORS 同其它行，须服务端/Worker 代理）：
 *   ① 产品信息：POST /ProductInfo/getProductByPrdCode?prdCode=<码> → body[0] 含
 *      名称/发行机构(comNam)/风险(risk)/期限(term)/持有(finDate)/登记编码(regCode)/
 *      是否代销(isSA)/代销码(saaCod,funCod)/销售期(beginDate,endDate)/到期(expireDate)。
 *   ② 净值-代销：POST /ProductValue/getSAValueByPrdCodeOrTypeCode，参数放【顶层】
 *      {saaCod,funCod,pageIndex,pageSize}（包 data 会报 CFN0510）；响应 data[] 含
 *      znavDat(YYYYMMDD) / znavVal(单位净值)。按 totalPage 翻页。
 *   ③ 净值-自营：POST /ProductValue/getProductValueByPage，参数包 {data:{prdCode,...}}。
 * 净值口径：招行净值型产品 znavVal 即单位净值，一律按 nav 处理（无万份收益字段）。
 * ========================================================================== */

const CMB_BASE = "https://cfweb.paas.cmbchina.com/api";
const CMB_APP_ID = "LB50.22_CFWebUI";
const CMB_KEY = "9qwBGju73JAXid48";
const CMB_REFERER = "https://cfweb.paas.cmbchina.com/personal/prodvalue";
const CMB_TIMEOUT_MS = 20000;
const CMB_PAGE_SIZE = 50;

function cmbB64(u8){ let s=""; for(let i=0;i<u8.length;i++) s+=String.fromCharCode(u8[i]); return btoa(s); }
/* SM4 的实现已统一到文件顶部的「国密工具箱」(sm4Ecb)，此处不再重复造轮子 */
function cmbSign(){ const ts=String(Date.now()); const plain=CMB_APP_ID+"|"+ts; return { signature: cmbB64(sm4Ecb(gmU8(CMB_KEY), gmPkcs7(gmU8(plain)))), ts }; }

export async function cmbPost(path, body, transport){
  const { signature, ts } = cmbSign();
  const ctrl=new AbortController(); const timer=setTimeout(()=>ctrl.abort(), CMB_TIMEOUT_MS);
  try{
    const res=await (transport||fetch)(CMB_BASE+path, {
      method:"POST",
      headers:{ "Content-Type":"application/json;charset=UTF-8", "Accept":"application/json, text/plain, */*", "User-Agent":UA, "Referer":CMB_REFERER, "Origin":"https://cfweb.paas.cmbchina.com", "appId":CMB_APP_ID, "timespan":ts, "signature":signature, "X-B3-BusinessId":"CFWEB" },
      body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal,
    });
    return await res.json();
  }catch(e){ return null; } finally{ clearTimeout(timer); }
}

/* 招银理财官网腿的总预算（毫秒）。须 < 前端 60s 预算，否则这条腿失败会把整单拖到超时。 */
const CMBWM_TIMEOUT_MS = 45000;

/* 招银理财官网端口（www.cmbchinawm.com）—— 纯 HTTP + 自实现 SM2，**Node 与 Cloudflare Workers 通用**。
 *
 * 【2026-10-31 用户实证】官网产品详情页 https://www.cmbchinawm.com/proDetail?prodTradeCode=132112D
 *   **能看到净值**（2026-10-28 / 1.0177），而我们的 cfweb 超市腿拿不到 → 抓不到。
 *   根因分层：
 *     ① cfweb 超市（getProductByPrdCode / 目录检索）对**已从招行货架下架**的产品返空
 *        （实测 132112D / 132112MS / 132112N 三个兄弟份额全部 body=0，PB132112D 代销渠道码也空）；
 *     ② 招银理财**官网**是发行方自己的信披渠道，**产品下架后仍保留历史净值与详情** → 官网是这类产品的唯一出口。
 *
 * 为什么可以纯 HTTP（不再依赖无头 Chrome）：
 *   官网 POST 接口请求体是 **SM2 加密**的（body = JSON.stringify(SmAencrypt(payload))，C1C3C2 / cipherMode=1）。
 *   现已用纯 JS 自实现 SM2+SM3（scrape/cmbwm_sm2.mjs，零依赖、BigInt，Worker 可跑），公钥从官网 bundle
 *   运行期反查并硬编码于 scrape/cmbwm_http.mjs（curve-validated 公开值）。nginx WAF 仅需同源 Origin+Referer
 *   （缺则 403），无需 cookie；/web/api/* 境外 IP 地域封禁，必须走 /prod-api 反代前缀。
 *   实现见 scrape/cmbwm_http.mjs（替代 cmbwm_app.mjs 的 CDP 腿）。
 */
export async function cmbwmFetch(code, opts = {}) {
  // 纯 HTTP + 自实现 SM2 腿（scrape/cmbwm_http.mjs），无 Chrome 冷启动 → 通常 1~3s；
  // 仍保留总预算兜底，避免极端情况下烧光编排层 60s 前端预算。
  const budgetMs = CMBWM_TIMEOUT_MS;
  const t0 = Date.now();
  try {
    const p = cmbwmHttpByCode(code, { since: opts.since, log: opts.log });
    const r = await Promise.race([
      p,
      new Promise((res) => setTimeout(() => res(null), Math.max(budgetMs - (Date.now() - t0), 500))),
    ]);
    return r || null;
  } catch (e) {
    return null;
  }
}

export async function cmbFetch(code, opts = {}) {
  const transport = opts.transport;
  const info = await cmbPost("/ProductInfo/getProductByPrdCode?prdCode=" + encodeURIComponent(code), null, transport);
  const body = (info && info.body) || [];
  if (!body.length) {
    // 【2026-10-31】cfweb 超市查不到（产品已下架/非货架份额）→ 回落**招银理财官网**腿。
    // 官网对下架产品仍保留历史净值与详情（用户实证 132112D 官网页面可见净值）。
    const wm = await cmbwmFetch(code, opts);
    if (wm && wm.series && wm.series.length) return wm;
    // ⚠ 增量模式的「0 新增点」= **已是最新**，不能当失败丢弃（2026-10-31 本地 404 的第二重原因）：
    //   本地末点 10-29 = 官网末点 10-29 → since 过滤后官网无新点 → 旧代码返回 null →
    //   整条腿失败 → 回落中国理财网（本机 IP 被风控 → 冷启动挂 42s）→ 60s 预算爆掉 → 404。
    //   判定依据：官网接口跑通（navRaw 有数据）+ 该产品确有净值披露 → 0 新增点即「已是最新」。
    if (wm && wm.navIncremental && !wm.infoOnly) return wm;
    return null;
  }
  const it = body[0];
  if (globalThis.__QPROBE) console.log("QPROBE:cmb:" + code + " " + JSON.stringify(body.slice(0, 3)));
  if (!it || !it.prdName) return null;
  const isSA = String(it.isSA) === "1";
  const saaCod = it.saaCod, funCod = it.funCod;
  // 【2026-10-23 用户规则】刷信息只刷信息、刷额度只刷额度——两者都不抓净值。
  // 招行的产品信息在 getProductByPrdCode（上面已取），净值要按代销/自营两条路径各翻最多 40 页，
  // 是刷信息的主要耗时来源。info/quota 直接跳过全部翻页；招行无额度接口，quota 返回信息壳。
  const __noNav = opts.mode === "info" || opts.mode === "quota";
  let ded = [];
  let navIncremental = false;
  let navFound = true;
  if (__noNav) {
    /* info/quota：跳过净值翻页（无请求） */
  } else {
    // 2026-10-31 增量：since 给定时走 incrementalNavPages（DESC/ASC 自动判定，提前停翻页只回新增点）
    const pageSize = isSA ? CMB_PAGE_SIZE : 200;
    const getPage = async (pn) => {
      const r = isSA
        ? await cmbPost("/ProductValue/getSAValueByPrdCodeOrTypeCode", { saaCod, funCod, pageIndex: pn, pageSize }, transport)
        : await cmbPost("/ProductValue/getProductValueByPage", { data: { prdCode: code, pageIndex: pn, pageSize } }, transport);
      const b = (r && r.body) || {};
      const data = b.data || [];
      const rows = data
        .map((d) => ({ date: bobNormDate(d.znavDat), value: parseFloat(d.znavVal) }))
        .filter((x) => x.date && Number.isFinite(x.value) && x.value > 0);
      const totalPages = Number.isFinite(Number(b.totalPage)) ? Number(b.totalPage) : null;
      const isLast = pn >= (totalPages || 0) || data.length < pageSize;
      return { rows, totalPages, isLast, pageSize };
    };
    const res = await incrementalNavPages(getPage, opts.since);
    navIncremental = !!opts.since && res.ok;
    ded = res.rows;
    navFound = res.ok;
  }
  if (!__noNav && !navFound) return null;
  let manager = it.comNam ? (inferManager(it.comNam) || it.comNam) : null;
  return {
    name: it.prdName || null,
    manager,
    established: bobNormDate(it.beginDate) || (ded.length ? ded[0][0] : null),
    establishedFromSeries: !bobNormDate(it.beginDate) && ded.length > 0, // 招行超市无 beginDate 时退序列首点
    series: ded,
    kind: "nav",
    risk: bobRiskToR(it.risk),
    benchmark: null,
    holdDays: cmbHoldDays(it.prdName, it.finDate, bobNormDate(it.expireDate), bobNormDate(it.beginDate)),
    regCode: it.regCode || null,
    source: "live",
    // 2026-10-31 修复（本函数此前算出了 navIncremental 却**没放进返回对象**）：
    //   增量模式下招行腿只回 0~1 个新增点，编排层 navLegOk(series>=2 || navIncremental)
    //   判定失败 → 该腿被拒 → 回落中国理财网**全量**兜底（实测 14~46s、来源被改写为 chinawealth），
    //   前端还因 nav.navIncremental 缺失把「0 新增点」判成「未抓到」（招行 5 只全未抓到）。
    //   带上网Incremental 后：接口跑通即放行 → 0 新增点被当作「已是最新」（前端判成功、历史不丢）。
    navIncremental,
  };
}

/* 招行理财超市全量目录枚举（cfweb）—— 用于发现「招行代销它行」产品。
 * 接口 /ProductInfo/getProductByFilterByPage，SM4 签名复用 cmbPost（见 cmbFetch 区块顶部）。
 * ⚠ 参数必须**顶层** {keyWord, pageIndex, pageSize}；一旦包成 {data:{...}}，pageIndex 被忽略，
 *    全部返回第 1 页（已踩坑）。空 keyWord + 翻页 = 全量（对方实测 7482 条 / 150 页）。
 * 返回 { totalPage, totalRecord, data }，data[] 每项含 prdCode / prdName / comNam(发行机构) /
 *      isSA(是否代销) / regCode / risk / finDate / beginDate / expireDate 等 —— 足以筛出「代销它行」候选。
 */
export async function __cmbSearchPage(keyWord = "", pageIndex = 1, pageSize = 50, opts = {}) {
  const j = await cmbPost("/ProductInfo/getProductByFilterByPage", { keyWord, pageIndex, pageSize }, opts.transport);
  if (!j) return null;
  const body = (j && j.body) || {};
  const data = Array.isArray(body.data) ? body.data : (Array.isArray(j.data) ? j.data : []);
  return {
    totalPage: Number(body.totalPage || (j && j.totalPage) || 0),
    totalRecord: Number(body.totalRecord || (j && j.totalRecord) || data.length),
    data,
  };
}

/* ==========================================================================
 * 浦发银行（SPDB）实时抓取
 *
 * ① 产品信息（浦发自有接口，免登录、免签名）：
 *      POST https://per.spdb.com.cn/api/search
 *      headers: Content-Type: application/json
 *               Origin / Referer: https://per.spdb.com.cn/bank_financing/cxpt/
 *      body: { metadata:"pName|pCode|pType|pZpD|pGpS|pPub|pRisk|pStatus|pForm",
 *              chlid:1066, page:1, size:20, searchword:"(pCode='%<码>%')" }
 *      响应 data.content[]：pName / pCode / pType / pZpD(自营|代理销售) / pGpS(公募) /
 *           pPub(发行机构) / pRisk(R1..R5) / pStatus(在售) / pForm / TACODE。
 *      字段集合由服务端固定，**不含任何净值字段**（metadata 写 * 或自定义均返回同一套）。
 *
 * ① 净值（主通道）：浦银理财官方站 www.spdb-wm.com（浦银理财有限责任公司官网）。
 *      详情页 /financialProducts/cpxq.shtml 经同一个 /api/search 接口、chlid=1008、
 *      按 subShareCode（= SPDB 平台代码 pCode）检索，返回历史单位/累计净值
 *      （netValueDate YYYYMMDD / shareNetVal 单位净值 / acumltNetVal 累计净值）。
 *      这是「浦发自营且不在工行代销/招行目录」的浦银理财产品的权威真实净值序列来源。
 * ② 净值（兜底）：浦发公网 per.spdb.com.cn / www.spdb.com.cn 拿不到净值序列，
 *      已排除的路径有——
 *      · 官网「产品净值」tab 已被 HTML 注释掉（financial_product 页面）：
 *        <!--<a href=".../financial_product/cpjz/" class="cTab">产品净值</a>-->
 *      · personProductValue.js 驱动的 /was5/web/search（channelid 214059）在
 *        www / per / 95528 三个 host 上均 404；
 *      · 该 channelid 也不是检索平台的 chlid，检索平台只有 chlid=1066 一个频道；
 *      · ebank.spdb.com.cn/nbper/SearchHistoryNav.do 需登录会话（无 session 404）；
 *      · 移动端 wap0.spdb.com.cn 是 Vue SPA 外壳，无公开净值接口。
 *      故对 浦银官方站未收录的代码，仍走【发行方路由】：把浦发产品名归一化后到招商银行
 *      理财超市目录按名称检索，命中即取招行真实净值序列；未收录的渠道专属份额只能返回产品信息。
 *
 * ⚠ 招行列表接口坑：参数必须放【顶层】{keyWord,pageIndex,pageSize}；
 *    一旦包成 {data:{...}}，pageIndex 被完全忽略，739 页全部返回第 1 页（实测）。
 * ========================================================================== */

const SPDB_SEARCH_URL = "https://per.spdb.com.cn/api/search";
const SPDB_FIELDS = "pName|pCode|pType|pZpD|pGpS|pPub|pRisk|pStatus|pForm";

// 浦银理财官方站（发行方权威净值源）：详情页 cpxq.shtml 经 /api/search chlid=1008 取净值
const SPD_WM_HOST = "https://www.spdb-wm.com";
const SPD_WM_SEARCH = SPD_WM_HOST + "/api/search";
const SPD_WM_REF = SPD_WM_HOST + "/financialProducts/cpxq.shtml";

/* ==========================================================================
 * 浦发 App 端口（mspmk H5 网关）—— 2026-10-25 打通，代销他行产品的权威净值来源
 *
 * 背景：浦银理财官网（www.spdb-wm.com / per.spdb.com.cn chlid=1008）只收录**浦银自营**
 * 产品；浦发代销的信银/中银/招银等产品在官网全 0 命中。但浦发手机银行 App 的代销货架
 * 里这些产品是**免登录可见、且带净值曲线**的 —— 数据一定在 App 后端，只是入口不在官网。
 *
 * 网关结构（手机抓包 + bundle 逆向确认）：
 *   POST https://wap32.spdb.com.cn/mspmk-web-<业务域>/<交易码>.<后缀>
 * 三种后缀语义（实测）：
 *   .json → 只回状态头，RspBody 为空（无用）
 *   .ah   → App 原生加密通道，响应为 Base64 密文（Node 无法复现 isEncrypt 的原生桥）
 *   .hh   → **Web 明文通道，Node 可直连**（b775/Se 模块走的就是这条）
 * 请求信封（缺 ReqHeader 会回 H50006「第三方参数解密失败」）：
 *   {"ReqHeader":{"DeviceInfo":"","DeviceDigest":"","NetWorkType":"","NetWorkName":""},
 *    "ReqBody":{...业务参数}}
 * 成功码：RspHeader.ResponseCode === "AAAAAAA"
 *
 * 两个必需交易（均为免登录、免会话、免签名）：
 *   ① /mspmk-web-finance/QueryFinanceProduct.hh
 *        ReqBody {FinanceNo}            （FinanceNo = 银行平台代码，即本系统的产品代码）
 *        → 111 字段：FinanceType(005) / FinanceBrand(64) / FinanceOwner(1) /
 *          FinanceAccumulativeNet(最新累计净值) / FinanceFoundedDate / FinanceIssuer(发行机构) /
 *          FinanceRiskLevelDesc / FinanceLimittime / FinanceBenchmark / ChartConfig / MovementsType
 *   ② /mspmk-web-financehold/FinHoldDetailProductCharts.hh
 *        ReqBody {Type:"6-1", FinanceNo, FinanceType, FinanceBrand, FinanceOwner,
 *                 BeginNumber:"0", QueryNumber:"5000"}
 *        Type="6-1" = 历史净值（图表类型 6 净值走势 / 1 表格视图）；
 *        **FinanceType 必需**（缺则 H50006）；FinanceBrand/FinanceOwner 可省但建议带上。
 *        → List[]: {Date:"YYYY.MM.DD", FinanceNav:单位净值, FinanceAccumulatedValue:累计净值}
 *          Count:["888","0"]（总数, 已返回数）；LatestUpdateTime:"2026年10月22日"
 *        实测 QueryNumber=5000 一次回全量 888 点（2023-03-29 → 2026-10-22），无需翻页。
 *
 * 数据质量核对（2026-10-25）：2301232123「安盈象固收稳健十四天持有期2号H」
 *   App 端口最新 2026-10-22 = 1.080900，与浦发 App 截图、信银官网 747 点序列逐点一致。
 *
 * ⚠ 已排除的同域路径（不要重试）：
 *   QueryCumulaRateHistory.hh —— 参数是 App 内部 productId（非 FinanceNo），
 *     传 FinanceNo 恒回 AAAAAAA + 空 List（自营/代销都一样），无法用于本系统代码。
 *   QryCompositeProductInfo（mspmk-web-stockfuture）—— 服务端未在 .hh 暴露，恒回空体。
 * ========================================================================== */
const SPDB_APP_HOST = "https://wap32.spdb.com.cn";
const SPDB_APP_REF = SPDB_APP_HOST + "/mspmk-cli-financebuy/";
const SPDB_APP_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";

/** mspmk 网关统一 POST：自动套 ReqHeader/ReqBody 信封，只认 AAAAAAA 成功码，失败一律回 null。 */
async function spdbAppPost(path, reqBody, transport) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await (transport || fetch)(SPDB_APP_HOST + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Accept: "application/json",
        "User-Agent": SPDB_APP_UA,
        Origin: SPDB_APP_HOST,
        Referer: SPDB_APP_REF,
      },
      body: JSON.stringify({
        ReqHeader: { DeviceInfo: "", DeviceDigest: "", NetWorkType: "", NetWorkName: "" },
        ReqBody: reqBody || {},
      }),
      signal: ctrl.signal,
    });
    const txt = await res.text();
    if (!txt || txt.length < 20) return null;
    let j;
    try {
      j = JSON.parse(txt);
    } catch (e) {
      return null;
    }
    const hdr = (j && j.RspHeader) || null;
    if (!hdr || hdr.ResponseCode !== "AAAAAAA") return null;
    return j.RspBody || null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 浦发 App 端口抓净值（代销他行产品专用，自营产品仍优先走 spdbWmNav）。
 * 先取产品详情拿 FinanceType/FinanceBrand/FinanceOwner，再取图表净值全量。
 * 返回结构与 spdbWmNav 对齐，navVia="spdb" / navPort="app"。
 */
async function spdbAppFetch(code, transport) {
  const c = String(code || "").trim();
  if (!c) return null;

  // ① 产品详情（同时拿到最新累计净值，作为图表接口失败时的兜底单点）
  const det = await spdbAppPost("/mspmk-web-finance/QueryFinanceProduct.hh", { FinanceNo: c }, transport);
  if (!det) return null;
  const ftype = String(det.FinanceType || "").trim();
  if (!ftype) return null;

  // ② 历史净值全量（Type=6-1 历史净值；QueryNumber 给大值一次拉全）
  const q = {
    Type: "6-1",
    FinanceNo: c,
    FinanceType: ftype,
    BeginNumber: "0",
    QueryNumber: "5000",
  };
  if (det.FinanceBrand) q.FinanceBrand = String(det.FinanceBrand);
  if (det.FinanceOwner) q.FinanceOwner = String(det.FinanceOwner);
  const chart = await spdbAppPost(
    "/mspmk-web-financehold/FinHoldDetailProductCharts.hh",
    q,
    transport
  );

  const map = new Map();
  for (const r of ((chart && chart.List) || [])) {
    const d = String((r && r.Date) || "").replace(/[.\-/]/g, "");
    const v = parseFloat(r && r.FinanceNav);
    if (!/^\d{8}$/.test(d) || !Number.isFinite(v) || v <= 0) continue;
    map.set(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, Number(v.toFixed(8)));
  }
  let series = [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  // 图表接口空但详情有最新净值 → 至少给一个单点，避免整条链路判空
  if (!series.length) {
    const nav = parseFloat(det.FinanceAccumulativeNet);
    const d0 = String(det.CurrentDate || det.UpdateTime || "").slice(0, 8);
    if (Number.isFinite(nav) && nav > 0 && /^\d{8}$/.test(d0)) {
      series = [[`${d0.slice(0, 4)}-${d0.slice(4, 6)}-${d0.slice(6, 8)}`, Number(nav.toFixed(8))]];
    }
  }
  if (!series.length) return null;

  // 成立日：详情 FinanceFoundedDate(YYYYMMDD) 优先；缺失时退回序列首点
  const fd = String(det.FinanceFoundedDate || "");
  const established = /^\d{8}$/.test(fd)
    ? `${fd.slice(0, 4)}-${fd.slice(4, 6)}-${fd.slice(6, 8)}`
    : series[0][0];

  const issuer = String(det.FinanceIssuer || "").trim();
  const name = String(det.FinanceAbbrName || det.FinanceName || "").trim();
  const limit = String(det.FinanceLimittime || "").trim();
  const bench = String(det.FinanceBenchmark || "").trim();

  return {
    series,
    name: name || null,
    manager: issuer ? inferManager(issuer) || issuer : null,
    risk: String(det.FinanceRiskLevelDesc || "").trim() || null,
    holdDays: /^\d+$/.test(limit) ? Number(limit) : spdbHoldDays(name),
    established,
    establishedFromSeries: !/^\d{8}$/.test(fd),
    benchmark: bench || null,
    regCode: null, // RegistrantNo 是登记机构码（ZX=信银），非产品登记编码 Z7…
    latestNav: parseFloat(det.FinanceAccumulativeNet) || series[series.length - 1][1],
    latestNavDate: series[series.length - 1][0],
    kind: "nav",
    source: "live",
    bank: "spdb",
    navVia: "spdb",
    navPort: "app",
    navViaCode: c,
  };
}

/**
 * 浦发 App 端口额度（2026-10-25 新增）—— 手机银行详情页底部「剩余额度 xxx 万元」即此接口。
 *
 *   POST /mspmk-web-finance/QueryFinanceProductAvailability.hh   {FinanceNo}
 *   → RspBody.FinanceAvailableShare = 剩余可用金额（**元**，字符串两位小数）
 *     FinancePurchaseLabel = "购买"（在售）｜SubscribeStatus = "2"
 *
 * 实测（2026-10-25 09:15）：
 *   2301261128 月月鑫稳利103号A → 1903274233.00 元 = 190,327.42 万元
 *      （用户 App 截图 08:18 显示 190,466.61 万元；同一会话内两次连发从 1903324233
 *        递减到 1903274233 —— 确认是**实时额度**，不是静态快照，差值即被买走的量）
 *   2301232123 安盈象2号H        →  443168602.15 元 = 44,316.86 万元
 *
 * ⚠ 同域其它额度候选（不要重试）：
 *   QueryAvlLimitAmnt.hh          → 任何参数组合都回 H50006（第三方参数解密失败）
 *   QueryFinanceProductForPurchase.hh → role.invalid_user（用户未登录，需会话）
 *
 * 无「总额度」字段 → remainQuotaPct 恒 null（与 ccb 的 SplLmt 同口径，只给绝对值）。
 */
async function spdbQuota(code, transport) {
  const c = String(code || "").trim();
  if (!c) return null;
  const b = await spdbAppPost(
    "/mspmk-web-finance/QueryFinanceProductAvailability.hh",
    { FinanceNo: c },
    transport
  );
  if (!b) return null;
  const raw = b.FinanceAvailableShare;
  if (raw == null || String(raw).trim() === "") return null; // 未披露额度字段
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return {
    remainQuota: n > 0 ? n : 0, // 负值（异常数据）按 0 处理
    remainQuotaPct: null,
    quotaState: n > 0 ? "available" : "sold_out",
    saleStatus: null, // SubscribeStatus="2" 语义未确认，不猜
    currency: "CNY",
    quotaText: null,
  };
}

async function spdbInfoRaw(code, transport) {
  const c = String(code || "").trim();
  if (!c) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await (transport || fetch)(SPDB_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
        "User-Agent": UA,
        Origin: "https://per.spdb.com.cn",
        Referer: "https://per.spdb.com.cn/bank_financing/cxpt/",
      },
      body: JSON.stringify({
        metadata: SPDB_FIELDS,
        chlid: 1066,
        page: 1,
        size: 20,
        searchword: "(pCode='%" + c + "%')",
      }),
      signal: ctrl.signal,
    });
    const j = await res.json();
    const list = (j && j.data && j.data.content) || [];
    if (!list.length) return null;
    const it = list.find((x) => String(x.pCode) === c) || list[0];
    if (!it || !it.pName) return null;
    return {
      code: String(it.pCode || c),
      name: String(it.pName),
      manager: it.pPub || null,
      risk: /^R[1-5]$/.test(String(it.pRisk || "")) ? String(it.pRisk) : null,
      status: it.pStatus || null,
      saleType: it.pZpD || null,
    };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 代销货架产品信息（chlid=1066）的 60 秒进程内记忆。
// 用途：nav/all 模式下编排层要先拿产品名（见 fetchProductFull 的 nameHint），而 all 模式下
// spdbFetch 内部还会再取一次；没有记忆就是两次 /api/search（各 ~1.1s）。名称/风险等级
// 在 60 秒内不会变，缓存无副作用；只缓存成功结果，失败仍每次回源（避免瞬时故障被放大成 60s 黑洞）。
const SPDB_INFO_TTL = 60 * 1000;
const spdbInfoCache = new Map();          // code -> { t, v }
async function spdbInfo(code, transport) {
  const c = String(code || "").trim();
  if (!c) return null;
  const hit = spdbInfoCache.get(c);
  if (hit && Date.now() - hit.t < SPDB_INFO_TTL) return hit.v;
  const v = await spdbInfoRaw(c, transport).catch(() => null);
  if (v) spdbInfoCache.set(c, { t: Date.now(), v });
  return v;
}

// 名称归一化：去掉尾部的份额字母（D / P / ZX / AM / V …）与括号空白
function spdbBaseName(name) {
  let s = String(name || "").trim();
  s = s.replace(/(理财产品|理财计划|人民币理财)$/u, "");
  s = s.replace(/[A-Za-z]{1,3}$/u, "");
  return s.replace(/[\s（）()【】[\]]/gu, "");
}

// 数字签名：如「招睿添金14天持有4」→ "14|4"，用于核对期号/持有期是否同一只产品
function spdbDigits(s) {
  return (String(s || "").match(/\d+/g) || []).join("|");
}

function spdbHoldDays(name) {
  const t = String(name || "");
  if (/日开|每日开放|天天开|天天购|现金管理|活期|现金宝|天添利|天天利/.test(t)) return 1;
  const m = t.match(/(\d+)\s*天持有/);
  if (m) return Number(m[1]);
  // 前置 (?:^|\D) 防止期号（如「73号」）被当成天数
  const m2 = t.match(/(?:^|\D)(\d{1,4})\s*天/);
  if (m2) return Number(m2[1]);
  const mo = t.match(/(?:^|\D)(\d{1,2})\s*个?月/);
  if (mo) return Number(mo[1]) * 30;
  const y = t.match(/(?:^|\D)(\d{1,2})\s*年/);
  if (y) return Number(y[1]) * 365;
  // 浦银理财系列命名（无数字，按系列推断持有期）
  if (/月月鑫/.test(t)) return 30;
  if (/双周鑫/.test(t)) return 14;
  if (/周周鑫|周周|周鑫/.test(t)) return 7;
  if (/季季鑫|季度/.test(t)) return 90;
  if (/半年鑫/.test(t)) return 180;
  return null;
}

// 招行目录关键字检索（参数必须顶层；pageSize 上限 50）
async function cmbSearchByKeyword(kw, transport) {
  const r = await cmbPost(
    "/ProductInfo/getProductByFilterByPage",
    { keyWord: kw, pageIndex: 1, pageSize: 50 },
    transport
  );
  const b = (r && r.body) || {};
  return Array.isArray(b.data) ? b.data : [];
}

// 临时调试出口（验证完删除）
export async function __probeCmbSearch(kw, opts = {}) {
  return await cmbSearchByKeyword(kw, opts.transport);
}

/**
 * 浦发名 → 招行目录条目。
 * 逐字缩短关键字直到有结果，再用「发行机构前缀 + 数字签名」双重校验，
 * 避免把「30天持有期12号」错配到「30天持有期13号」。
 */
async function spdbFindInCmb(info, transport) {
  let kw = spdbBaseName(info.name);
  const wantDigits = spdbDigits(kw);
  const issuer = String(info.manager || "")
    .replace(/(有限责任公司|有限公司|股份)$/gu, "")
    .trim();
  for (let guard = 0; guard < 12 && kw.length >= 4; guard++) {
    const list = await cmbSearchByKeyword(kw, transport);
    if (list.length) {
      let best = null;
      for (const it of list) {
        const nm = String(it.prdName || "");
        if (!nm || !it.prdCode) continue;
        if (issuer && nm.indexOf(issuer) === -1) continue;
        if (wantDigits && spdbDigits(nm) !== wantDigits) continue;
        // 有多只同名期号时，取名称最短的（最贴近主份额）
        if (!best || nm.length < String(best.prdName || "").length) best = it;
      }
      if (best) return best;
    }
    kw = kw.slice(0, -1);
    // 关键字已经把数字（期号/持有期）全部削掉了，再缩短只会降低精度、不会更准 → 停
    if (wantDigits && !spdbDigits(kw)) break;
  }
  return null;
}

/**
 * 浦银理财官方直连净值源（发行方权威通道）。
 * 站点 www.spdb-wm.com（浦银理财有限责任公司官网）的详情页 cpxq.shtml 通过同一个
 * /api/search 接口、chlid=1008、按 subShareCode（= SPDB 平台代码 pCode）检索，
 * 返回历史单位/累计净值（netValueDate YYYYMMDD / shareNetVal / acumltNetVal）。
 * 这是「浦发自营且不在工行代销/招行目录」的浦银理财产品的唯一真实净值序列来源。
 */
async function spdbWmNav(code, transport) {
  const c = String(code || "").trim();
  if (!c) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await (transport || fetch)(SPD_WM_SEARCH, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
        "User-Agent": UA,
        Origin: SPD_WM_HOST,
        Referer: SPD_WM_REF,
      },
      body: JSON.stringify({
        chlid: 1008,
        cutsize: 150,
        dynexpr: [],
        dynidx: 1,
        extopt: [],
        orderby: "",
        page: 1,
        size: 999,
        searchword: `(subShareCode='${c}')`,
      }),
      signal: ctrl.signal,
    });
    const j = await res.json();
    const list = (j && j.data && j.data.content) || [];
    if (!list.length) return null;
    const out = [];
    let reg = null;
    for (const r of list) {
      const d = String(r.netValueDate || "");
      const v = parseFloat(r.shareNetVal);
      if (!/^\d{8}$/.test(d) || !Number.isFinite(v) || v <= 0) continue;
      const dt = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
      out.push([dt, Number(v.toFixed(8))]);
      if (!reg && r.prodRegCode) reg = String(r.prodRegCode);
    }
    out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    if (!out.length) return null;
    return {
      series: out,
      regCode: /^Z\d{9,}$/.test(reg || "") ? reg : null,
      established: out[0][0],
      establishedFromSeries: true, // 浦发网银净值路径无成立日字段
      kind: "nav",
      bank: "spdb",
      navVia: "spdbwm",
      navViaCode: c,
    };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* 净值序列按日期并集合并：a 优先（已存在的点不被 b 覆盖），b 仅填补 a 中缺失的日期。
 * 用途：主源序列近期断点（如长假后首日漏发）时用中国理财网全量序列补缺
 * （GAPFILL_ENABLED=false，2026-10-12 用户决策已停用；此前用工行代销补缺的旧路已废）。 */
function mergeNavByDate(a, b) {
  const m = new Map();
  for (const p of (a || [])) if (p && p[0]) m.set(p[0], Number(p[1]));
  for (const p of (b || [])) if (p && p[0] && !m.has(p[0])) m.set(p[0], Number(p[1]));
  return [...m.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([d, v]) => [d, v]);
}

/**
 * 增量翻页通用器（2026-10-31）—— 把 psbcwm/cibwm/ccb 已落地的「since 提前停翻页」复用到所有翻页银行。
 * 关键：各银行净值分页排序并不统一——
 *   · 多数银行 page1=最新(DESC)，如 psbcwm/cibwm/ccb/工行/中行/招行/南银…，日常刷新 page1 即止；
 *   · 少数银行 page1=最旧(ASC)（按成立日正序）。ASC 时若照搬「页内最旧<=since 即停」会**立刻误停**、
 *     永远翻不到最新页 —— 故本函数自动判定排序：
 *       DESC → 正向翻页，页内最旧点<=since 即停；
 *       ASC  → 直接跳最后一页(最新)，反向翻页，页内最新点<=since 即停；
 *             若响应未给 totalPages（无法跳末页），则退化「正向翻到底、只收 >since 的点」（仍正确，只是不提前停）。
 * getPage(pn) → { rows:[{date,value}], totalPages:number|null, isLast:boolean, pageSize:number }
 *   rows 必须是该页【接口原序】记录（首末日期由本函数自动判定排序），date 形如 "YYYY-MM-DD"（按字典序==按时间序）。
 * 返回 { rows:[新增点(已按日期升序去重)], ok }；
 *   ok=false 仅表示「首页即无数据」(产品未收录/无净值)；增量分支(有 since) ok 恒 true（0 新增点=已最新，有效结果，靠 navIncremental 放行）。
 */
async function incrementalNavPages(getPage, since) {
  const out = [];
  const seen = new Set();
  const add = (rows) => {
    for (const r of (rows || [])) {
      if (r && r.date && Number.isFinite(r.value) && r.value > 0 && !seen.has(r.date)) {
        seen.add(r.date);
        out.push([r.date, Number(Number(r.value).toFixed(8))]);
      }
    }
  };
  const sortOut = () => out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  // 无 since（添加产品/旧前端）→ 全量翻到底
  if (!since) {
    for (let pn = 1; pn <= 400; pn++) {
      const pg = await getPage(pn);
      if (!pg || !pg.rows || !pg.rows.length) break;
      add(pg.rows);
      if (pg.isLast || (pg.totalPages && pn >= pg.totalPages)) break;
    }
    sortOut();
    return { rows: out, ok: out.length > 0 };
  }

  // 增量：先取第 1 页判定排序 + 拿 totalPages
  const first = await getPage(1);
  if (!first || !first.rows || !first.rows.length) return { rows: [], ok: false };
  const desc = first.rows.length >= 2
    ? (String(first.rows[0].date) >= String(first.rows[first.rows.length - 1].date))
    : true; // 单点页无法判定 → 按 DESC 处理（首点即最新）

  if (desc) {
    let pn = 1;
    for (;;) {
      const pg = pn === 1 ? first : await getPage(pn);
      add(pg.rows.filter((r) => r.date > since));
      const pd = (pg.rows || []).map((r) => r.date).filter(Boolean);
      const oldest = pd.length ? pd.reduce((a, b) => (String(a) < String(b) ? a : b)) : "";
      if (oldest && oldest <= since) break;                                   // 已追上 since，后续页更旧
      if (pg.isLast || (pg.totalPages && pn >= pg.totalPages) || !pd.length) break;
      if (pg.rows.length < (pg.pageSize || pg.rows.length)) break;             // 短页=末页
      pn++;
    }
    sortOut();
    return { rows: out, ok: true };
  }

  // ASC：页首最旧 → 跳最后一页(最新)反向翻
  const total = first.totalPages;
  if (!total) {
    // 无 totalPages 无法跳末页：正向翻到底，只收 >since 的点（正确，只是不提前停）
    add(first.rows.filter((r) => r.date > since));
    for (let pn = 2; pn <= 400; pn++) {
      const pg = await getPage(pn);
      if (!pg || !pg.rows || !pg.rows.length) break;
      add(pg.rows.filter((r) => r.date > since));
      if (pg.isLast || (pg.totalPages && pn >= pg.totalPages)) break;
    }
    sortOut();
    return { rows: out, ok: true };
  }
  let pn = total;
  for (;;) {
    const pg = pn === 1 ? first : await getPage(pn);
    add(pg.rows.filter((r) => r.date > since));
    const pd = (pg.rows || []).map((r) => r.date).filter(Boolean);
    if (!pd.length) break;                  // 本页空（已越过真实数据 / totalPages 虚高）→ 更早的页也必空，停翻
    const newest = pd.reduce((a, b) => (String(a) > String(b) ? a : b));
    if (newest && newest <= since) break;   // 本页最新都<=since → 更早的页更旧，全不用翻
    if (pn <= 1) break;
    pn--;
  }
  sortOut();
  return { rows: out, ok: true };
}
/* 序列尾部相邻两点的间隔天数（升序后最后两点）。 */
function tailGapDays(series) {
  if (!series || series.length < 2) return 0;
  const s = series.slice().sort((x, y) => (x[0] < y[0] ? -1 : 1));
  const last = new Date(s[s.length - 1][0]);
  const prev = new Date(s[s.length - 2][0]);
  if (isNaN(last) || isNaN(prev)) return 0;
  return Math.round((last - prev) / 86400000);
}
/* 序列最新点是否落在近 withinDays 天内（用于只在「近期刷新且断点」时触发补缺，避免给所有产品都打工行）。 */
function isRecentTail(series, withinDays = 7) {
  if (!series || !series.length) return false;
  const s = series.slice().sort((x, y) => (x[0] < y[0] ? -1 : 1));
  const d = new Date(s[s.length - 1][0]);
  if (isNaN(d)) return false;
  const diff = (Date.now() - d.getTime()) / 86400000;
  return diff >= 0 && diff <= withinDays;
}

/* —— Fix A（2026-10-12）：中国 A 股交易日历，用于判断「尾部间隔」是否纯休市 ——
 * 跨行净值接口在长假（国庆/春节/劳动节等）期间本就停更，序列尾部出现 8~9 天大间隔是
 * 正常休市，并非「断点漏发」。此前 1b 补缺条件「间隔≥2天」被国庆假期误触发，白白对中国
 * 理财网打 3 个请求却补回 0 点。本日历用来精准跳过这类纯休市间隔，避免无谓的联网与 429。
 * 仅收录 2025~2027 主要法定假日（非交易工作日），够覆盖理财产品的历史窗口；
 * 周末自动按非交易处理，调休补班日单独登记为「交易日」。
 * 注：列表略有偏差的最坏后果仅是「多打一次中国理财网」（无害），不误删真实数据。 */
function fmtYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}
// 解析 "YYYY-MM-DD" 为本地午夜（避免 new Date(str) 按 UTC 解析在本机 PDT 时区下整体偏移一天，
// 导致 getDay() 星期判定与节假日比对错乱）。理财日期均为「日历日」语义，须按本地构造。
function parseYmd(s) {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return new Date(NaN);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
const CN_HOLIDAYS = new Set([
  // 2025
  "2025-01-01", // 元旦
  "2025-01-28", "2025-01-29", "2025-01-30", "2025-01-31", // 春节
  "2025-02-03", "2025-02-04", // 春节
  "2025-04-04", // 清明
  "2025-05-01", "2025-05-02", "2025-05-05", // 劳动节
  "2025-05-30", // 端午
  "2025-10-01", "2025-10-02", "2025-10-03", "2025-10-06", "2025-10-07", "2025-10-08", // 国庆中秋
  // 2026
  "2026-01-01", // 元旦
  "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20", // 春节
  "2026-04-06", // 清明（4/4-4/5 周末）
  "2026-05-01", "2026-05-04", "2026-05-05", // 劳动节
  "2026-06-19", // 端午
  "2026-09-25", // 中秋（9/26-9/27 周末）
  "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", // 国庆
  // 2027
  "2027-01-01", // 元旦
  "2027-02-07", "2027-02-08", "2027-02-09", "2027-02-10", "2027-02-11", "2027-02-12", // 春节（初一定）
  "2027-04-05", // 清明
  "2027-05-03", "2027-05-04", "2027-05-05", // 劳动节
  "2027-06-09", // 端午
  "2027-09-15", // 中秋
  "2027-10-01", "2027-10-04", "2027-10-05", "2027-10-06", "2027-10-07", // 国庆
]);
// 调休补班日（周末但为交易日）：与上面假日配套的调整工作日
const CN_WORKDAY_MAKEUP = new Set([
  "2025-01-26", "2025-02-08", "2025-04-27", "2025-05-09", "2025-09-28", "2025-10-11",
  "2026-02-14", "2026-02-28", "2026-05-09", "2026-09-26", "2026-10-10",
  "2027-02-13", "2027-02-21", "2027-04-25", "2027-05-08", "2027-09-19", "2027-10-09",
]);
function cnIsTradingDay(d) {
  const wd = d.getDay(); // 0=周日 .. 6=周六
  if (wd === 0 || wd === 6) return CN_WORKDAY_MAKEUP.has(fmtYmd(d)); // 周末仅调休补班日为交易日
  return !CN_HOLIDAYS.has(fmtYmd(d));
}
/* 判断 prevStr→lastStr 之间的每个自然日是否「全为非交易日」：
 * 若间隔里不存在任何真实交易日，则该大间隔是休市所致（如国庆 10-01~10-07），
 * 不是漏发净值，无需补缺。返回 true = 可安全跳过补缺。 */
function gapIsAllNonTrading(prevStr, lastStr) {
  const prev = parseYmd(prevStr), last = parseYmd(lastStr);
  if (isNaN(prev) || isNaN(last) || last <= prev) return false;
  // 只检查 prev+1 .. last-1 之间的「真正空档」（prev/last 两端本身就是已发布日，不算缺失）
  const start = new Date(prev); start.setDate(start.getDate() + 1);
  for (let t = start; t < last; t.setDate(t.getDate() + 1)) {
    if (cnIsTradingDay(t)) return false; // 空档内存在真实交易日 → 确有漏发可能，需补缺
  }
  return true;
}

export async function spdbFetch(code, opts = {}) {
  const transport = opts.transport;
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  // 2026-10-22 修复：nav 模式只抓净值（跳过产品信息接口 spdbInfo）；quota 模式同理跳过净值/信息。
  const __navMode = opts.mode === "nav";
  const __quotaMode = opts.mode === "quota";
  const __infoMode = opts.mode === "info";
  // 【2026-10-23 用户规则】刷信息只刷信息、刷额度只刷额度——两者都不抓净值。
  // 浦发净值：自营走浦银理财官网（spdbWmNav，一次回全量）；代销他行走浦发 App 端口
  // （spdbAppFetch，mspmk 网关明文 .hh，2026-10-25 打通）。信息来自 per.spdb.com.cn/api/search。
  const __noNav = __infoMode || __quotaMode;

  // 【2026-10-25 新增】额度：手机银行详情页底部「剩余额度 xxx 万元」= QueryFinanceProductAvailability。
  // 刷额度(quota)与全抓(all)都要；刷净值(nav)/刷信息(info)一律不要（2026-10-23 用户规则：
  // 三件事互不越界）。并发发起、各 return 分支统一展开，不额外拖长净值链路。
  const __wantQuota = !__navMode && !__infoMode;
  const quotaT0 = Date.now();
  const quotaP = __wantQuota
    ? spdbQuota(c, transport)
        .catch(() => null)
        .then((q) => {
          navLog(
            "spdb quota code=" + c + " -> " +
              (q ? ("remainQuota=" + q.remainQuota + " 元 (" + (q.remainQuota / 1e4).toFixed(2) + " 万元)") : "null") +
              " (" + (Date.now() - quotaT0) + "ms)"
          );
          return q;
        })
    : Promise.resolve(null);

  // ① 浦银理财官方直连净值（发行方权威源，按 subShareCode = SPDB 平台代码 pCode 查询）
  const wmT0 = Date.now();
  const viaWm = __noNav ? null : await spdbWmNav(c, transport).catch(() => null);
  navLog("spdb wm code=" + c + " -> " + (viaWm && viaWm.series ? ("hit series=" + viaWm.series.length) : "null") + " (" + (Date.now() - wmT0) + "ms)");
  if (viaWm && viaWm.series && viaWm.series.length) {
    const info = __navMode ? null : await spdbInfo(c, transport).catch(() => null);
    let series = viaWm.series;
    // 「只走 3 家」规则（2026-10-15）：不再用工行代销通道(icbcLive)补缺口；净值序列的跨源补缺
    // 由编排层 fetchProductFull 第 1b 步统一走中国理财网（规则允许的第 3 家）完成。
    const name = (info && info.name) || null;
    return {
      ...viaWm,
      ...((await quotaP) || {}),
      series,
      name: name || null,
      manager:
        (info && info.manager ? inferManager(info.manager) || info.manager : null) ||
        "浦银理财",
      risk: (info && info.risk) || null,
      holdDays: spdbHoldDays(name),
      bank: "spdb",
      navVia: "spdbwm",
      navViaCode: c,
    };
  }

  // ② 浦发 App 端口（mspmk H5 网关，2026-10-25 打通）：**代销他行产品**的权威净值来源。
  //    浦银官网只收录自营，代销的信银/中银/招银等产品官网全 0 命中，但 App 代销货架免登录
  //    可见且带净值曲线 —— 走 QueryFinanceProduct + FinHoldDetailProductCharts（明文 .hh）。
  const appT0 = Date.now();
  const viaApp = __noNav ? null : await spdbAppFetch(c, transport).catch(() => null);
  navLog(
    "spdb app code=" + c + " -> " +
      (viaApp && viaApp.series ? ("hit series=" + viaApp.series.length + " last=" + viaApp.latestNavDate) : "null") +
      " (" + (Date.now() - appT0) + "ms)"
  );
  if (viaApp && viaApp.series && viaApp.series.length) {
    const info = __navMode ? null : await spdbInfo(c, transport).catch(() => null);
    return {
      ...viaApp,
      ...((await quotaP) || {}),
      name: viaApp.name || (info && info.name) || null,
      manager:
        viaApp.manager ||
        (info && info.manager ? inferManager(info.manager) || info.manager : null) ||
        null,
      risk: viaApp.risk || (info && info.risk) || null,
      bank: "spdb",
      navVia: "spdb",
      navPort: "app",
      navViaCode: c,
    };
  }

  // ③「只走 3 家」规则（2026-10-15）：浦银自有源取不到时，不再试探工行代销(icbcLive)，
  // 由编排层「代销银行→发行银行→中国理财网兜底」的发行阶段/中国理财网兜底覆盖。
  // ④ 产品信息：浦发 per.spdb.com.cn/api/search（按平台代码 pCode 检索，含发行机构/风险）
  const spT0 = Date.now();
  const info = __navMode ? null : await spdbInfo(c, transport).catch(() => null);
  navLog("spdb info code=" + c + " -> " + (info ? ("hit name=" + (info.name || "-")) : "null") + " (" + (Date.now() - spT0) + "ms)");

  if (!info) {
    // 信息接口未收录但额度抓到了（浦银官网/搜索索引滞后于 App 货架时会发生）——
    // 仍回额度，避免「刷额度」白跑一趟。
    const qf = (await quotaP) || null;
    if (qf) {
      return { ...qf, name: null, manager: null, series: null, kind: "nav", source: "live", bank: "spdb", infoOnly: true };
    }
    return null;
  }
  const manager = info.manager ? inferManager(info.manager) || info.manager : null;
  const base = {
    name: info.name,
    manager,
    established: null,
    series: null,
    kind: "nav",
    risk: info.risk,
    benchmark: null,
    holdDays: spdbHoldDays(info.name),
    regCode: null,
    source: "live",
    bank: "spdb",
    infoOnly: true,
    ...((await quotaP) || {}),
  };
  // 「只走 3 家」规则（2026-10-15）：不再经招行目录路由(cmbFetch)兜底；代销阶段缺口
  // 由编排层中国理财网兜底覆盖。此处仅返回浦发官网已确认的产品信息（infoOnly）。
  return base;
}

/* ==========================================================================
 * 交通银行（BOCOM / comm）实时抓取 —— 双端口：App（手机银行 H5，优先）+ web（交银理财官网）
 *
 * ① App 端口（2026-10-17 打通）：手机银行分享详情页
 *      https://mbank.95559.com.cn/mobs6/wm/WM1/NWM1001.html?productNo=<销售码>&shareCode=<份额码>
 *    页面 Vue SPA，数据走唯一业务网关（免登录、免签名、免会话——实测空 MSessionId 即可调）：
 *      POST https://mbank.95559.com.cn/mobs6/MobileBank//MOBS.MOBS-PRODUCTSRV.V-1.0/<txn>.ajax
 *      Content-Type: application/x-www-form-urlencoded
 *      body: processCode=<txn>&MSessionId=&isWap=1&pageCode=NWM1001&targetPageCode=NWM1001&
 *            contractNo=&diviceId=&method=&ninePageCode=NWM1001&fivePointLost=0&cardDateLost=0&
 *            timeStamph5=<ms>&bcm_channel=WAP&servNm=MOBS.MOBS-PRODUCTSRV.V-1.0&isNewJump=true&
 *            productNo=<销售码>&shareCode=<份额码>&category=01
 *      响应：{RSP_BODY:{...}, RSP_HEAD:{TRAN_SUCCESS:"1"}}
 *    ⚠ shareCode（份额码）**必需**：缺失/错误均只回显入参、无业务数据（实测）。
 *       2026-10-17 晚补齐：实测 shareCode=「JY」是 App 产品超市的**通用访问码**——
 *       凡 App 仍在架的产品（6426/6428/1110/2069 实测均通，含中信代销的鑫荣日日开），
 *       传 JY 即回全字段；已下架（如 5811221111，2023-01 已停更）/ 他行渠道专售
 *       （5811226201 微众 / 5811225599 中行）则任何码都无数据 → 回退 web 端口。
 *       故默认码取 JY，分享链登记表（内置 COMM_REGISTER_CODES + 外置
 *       scrape/comm_share.json，/api/commapp?link= 自动落盘）仅作覆盖，用于个别
 *       需要非 JY 码的产品。安全性：productNo 严格驱动产品（response.prdCode === 入参，
 *       假码返回空），不存在「JY 把 A 产品数据返给 B 码」的串数据风险。
 *    交易码与字段：
 *      PRDAFD0007（category=01 即回全字段，无需 02）→
 *        baseInfo.prdName(短名)/prdLongName(全名)/prdCode/prdBaseInfoList(投资期限「最低持有7天」)
 *        /prdTagList(「2R稳健型」) / agencyInfo.agencyInfoList(发行机构) /
 *        extInfo.productRiskLevel(「2R」)/minInvestTerm(「7」) / performanceBenchmarkInfo(业绩基准全文)
 *      PRDAFD0002 → historyInfo[0].list[]：
 *        list[title=历史净值].dataList = [日期,单位净值,累计净值,日涨跌幅%]（全量历史序列，
 *          实测 5811226426 共 73 点 2026-06-30→2026-10-16，**比 web 端口新一天**；
 *          ⚠ 长产品只回**近 3 年滚动窗**：5811221110 app 748 点(2023-10-16 起) vs web 1251 点
 *          (2021-10-09 起) → 合并时须按日期并集，不能按点数多者胜，否则老产品白丢 app 的新数据）；
 *        list[0=历史业绩].dataList 含「成立以来」区间（起点≈产品起始日）。
 *    拿不到：产品登记编码（Z7…，app 无此字段 → 取 web 端口 c_productcode）；
 *      额度（本产品页面无额度区块；FINSHS0002 是埋点、FINSPD0011/2001 需登录）→ 额度仍为否。
 *
 * ② web 端口（交银理财官网 www.bocommwm.com，补登记编码/成立日 + 净值兜底）：
 *    网关：POST https://www.bocommwm.com/SITE/<txn>.do
 *      body: REQ_MESSAGE=<encodeURI(JSON.stringify({REQ_HEAD:{TRAN_PROCESS:"",TRAN_ID:""}, REQ_BODY:{...}}))>
 *      Content-Type: application/x-www-form-urlencoded（XHR 默认）
 *      响应：{RSP_BODY:{result:...}, RSP_HEAD:{TRAN_SUCCESS:"1"}}
 *      免登录、免签名、免 Token，仅校验 Referer。
 *    ① 产品信息：queryJylcProductDetail.do  {c_fundcode}
 *        result.jylcProductBo: c_fundname(名称) / d_setupdate(成立日 YYYYMMDD) /
 *          c_productcode(登记编码 Z7…) / c_level(风险描述) / c_reserve0(业绩比较基准) /
 *          f_netvalue(最新单位净值) / d_date(净值日期) / c_agencyno(发行机构) / c_interestway
 *    ② 历史净值：queryJylcBreakDetail.do  {c_fundcode, c_interestway, type:"max", queryList:1}
 *        result.profitList[]: d_cdate(YYYY-MM-DD) / f_netvalue(单位净值) / f_totalnetvalue(累计净值)
 *        type:"max" 一次返回全量历史，无需翻页。
 *    净值口径：净值型，一律取 f_netvalue 当单位净值，kind:"nav"。
 *
 * 合并口径（bocomFetch）：app/web 并行，净值序列按**日期并集**合并（同日 app 优先，
 *   app 新一天 + web 老 history 互补），navPort 由「谁提供最新净值日」决定；
 *   登记编码/成立日取 web（app 无），风险/持有天数/基准/管理人 app 优先 web 兜底；
 *   app 无数据（未上架/已下架）→ 只走 web（原链路，行为不变）。
 * ========================================================================== */

const BOCOM_HOST = "https://www.bocommwm.com";
const BOCOM_TXN = BOCOM_HOST + "/SITE/";
const BOCOM_REF = BOCOM_HOST + "/BankCommSite/index.shtml";
const BOCOM_TIMEOUT_MS = 20000;

// —— App 端口常量 ——
const COMM_APP_HOST = "https://mbank.95559.com.cn";
const COMM_APP_SERV = "MOBS.MOBS-PRODUCTSRV.V-1.0";
const COMM_APP_REF = COMM_APP_HOST + "/mobs6/wm/WM1/NWM1001.html";
const COMM_APP_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.40(0x1800282a) NetType/WIFI Language/zh_CN";
const COMM_APP_TIMEOUT_MS = 20000;

/**
 * App 产品超市通用 shareCode（2026-10-17 晚实测）：凡 App 仍在架的产品传 JY 即回全字段
 * （6426/6428/1110/2069 均通）；已下架/他行渠道专售的产品任何码都无数据 → 由 bocomFetch
 * 回退 web 端口。登记表优先级更高，用于个别需要非 JY 码的产品。
 */
const COMM_APP_DEFAULT_RC = "JY";

/** 已覆盖的产品：销售码 → shareCode（分享链参数；默认 JY 之外的个别产品才需要登记） */
const COMM_REGISTER_CODES = {
  // 灵动慧利123号7天持有（交银理财稳享灵动慧利日开123号 7天持有期）—— 2026-10-17 用户分享链
  "5811226426": "JY",
  // 灵动慧利123号7天持有·私银尊享份额（与 6426 同一产品不同份额，登记编码同为 Z7000926001039）
  "5811226428": "JY",
  // 稳享悦添利私银特邀28天持有期（app 748 点 3 年滚动窗 + web 1251 点全 history 并集）
  "5811221110": "JY",
};

/** 允许把 code→shareCode 放外部 JSON 增量维护（不存在就只用内置表；同 ceb_eoap_access.json 模式） */
let _commRegCache = null;
async function commShareMap() {
  if (_commRegCache) return _commRegCache;
  const map = Object.assign({}, COMM_REGISTER_CODES);
  if (typeof process !== "undefined" && process.versions && process.versions.node) {
    try {
      const fs = await import("node:fs/promises");
      const j = JSON.parse(await fs.readFile(new URL("./comm_share.json", import.meta.url), "utf8"));
      for (const k of Object.keys(j || {})) {
        if (/^[A-Za-z0-9]{4,20}$/.test(k) && typeof j[k] === "string") map[String(k).toUpperCase()] = j[k];
      }
    } catch (e) { /* 文件不存在 / 解析失败 → 用内置表 */ }
  }
  _commRegCache = map;
  return map;
}

/** 供宿主（serve.mjs）拿到新分享链时登记映射，免重启 */
export function setCommShareCode(code, rc) {
  const c = String(code || "").trim().toUpperCase();
  const r = String(rc || "").trim();
  if (!c || !r) return false;
  COMM_REGISTER_CODES[c] = r;
  if (_commRegCache) _commRegCache[c] = r;
  return true;
}

// App 网关单次调用（免登录免签名免会话）
async function commAppPost(txn, data, transport) {
  const params = {
    processCode: txn, MSessionId: "", isWap: "1", pageCode: "NWM1001", targetPageCode: "NWM1001",
    contractNo: "", diviceId: "", method: "", ninePageCode: "NWM1001", fivePointLost: "0",
    cardDateLost: "0", timeStamph5: String(Date.now()), bcm_channel: "WAP",
    servNm: COMM_APP_SERV, isNewJump: "true",
  };
  const body = Object.entries(Object.assign({}, params, data))
    .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v == null ? "" : String(v)))
    .join("&");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), COMM_APP_TIMEOUT_MS);
  try {
    const res = await nyHttp(COMM_APP_HOST + "/mobs6/MobileBank//" + COMM_APP_SERV + "/" + txn + ".ajax", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Accept: "application/json, text/plain, */*",
        "User-Agent": COMM_APP_UA,
        Referer: COMM_APP_REF,
      },
      body,
      signal: ctrl.signal,
    }, transport);
    if (!res || !res.ok) return null;
    const txt = (await res.text()).trim();
    if (!txt || txt[0] !== "{") return null;
    const j = JSON.parse(txt);
    return (j && j.RSP_BODY) || null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 风险：「2R稳健型」→ R2（wi 映射：1R保守/2R稳健/3R平衡/4R增长/5R进取/6R激进）
function commAppRisk(level, tagText) {
  const m = String(level || "").match(/^\s*([1-6])\s*R/i);
  if (m) {
    const n = Number(m[1]);
    return "R" + (n >= 6 ? 5 : n);
  }
  const t = String(tagText || "");
  if (/谨慎|保守/.test(t)) return "R1";
  if (/稳健|中低/.test(t)) return "R2";
  if (/平衡|中等/.test(t)) return "R3";
  if (/增长|较高|中高/.test(t)) return "R4";
  if (/进取|激进|高/.test(t)) return "R5";
  return null;
}
// 最短持有天数：minInvestTerm(真实字段) → prdBaseInfoList「投资期限=最低持有N天」→ 名称推断
function commAppHoldDays(minTerm, baseInfoList, name) {
  const n = parseInt(String(minTerm == null ? "" : minTerm).replace(/[^0-9]/g, ""), 10);
  if (Number.isFinite(n) && n > 0) return n;
  for (const it of (Array.isArray(baseInfoList) ? baseInfoList : [])) {
    if (String(it && it.baseInfoName || "") === "投资期限") {
      const m = String(it.baseInfoValue || "").match(/(\d+)\s*天/);
      if (m) return Number(m[1]);
    }
  }
  return bocomHoldDays(name);
}
// 业绩比较基准全文 → 只取公式部分（首个「，」前），与 web 端口 c_reserve0 口径一致
function commAppBench(tip) {
  let t = String(tip || "").trim();
  if (!t) return null;
  t = t.replace(/^业绩比较基准值?[:：]?\s*/, "").trim();
  const i = t.indexOf("，");
  return (i > 0 ? t.slice(0, i) : t).trim() || null;
}
// 「成立以来 2026/06/29-2026/10/15」→ 起始日 2026-06-29
function commAppEstablished(perfList) {
  for (const row of (Array.isArray(perfList) ? perfList : [])) {
    const cell = row && row[0];
    if (cell && String(cell.date || "") === "成立以来") {
      const m = String(cell.dateDetail || "").match(/(\d{4})\/(\d{2})\/(\d{2})/);
      if (m) return m[1] + "-" + m[2] + "-" + m[3];
    }
  }
  return null;
}

/**
 * 交通银行 App 端口抓取（mbank.95559.com.cn 手机银行网关，免登录直连）。
 * @param {string} code 销售码（如 5811226426）
 * @param {{shareCode?:string, transport?:function}} opts
 * @returns {Promise<object|null>} { name, manager, risk, holdDays, established, benchmark,
 *   series, navLatest, navLatestDate, navViaCode, shareCode } 或 null（未登记 shareCode / 抓取失败）
 */
export async function commAppFetch(code, opts = {}) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  // 2026-10-22 用户规则：nav 模式跳过信息接口 PRDAFD0007（不再当存在性/现金类闸门，直接抓净值）
  const __navMode = (opts.mode || "all") === "nav";
  // 【2026-10-23 用户规则】刷信息只刷信息、刷额度只刷额度——两者都不抓净值。
  // 交银 App 端口的净值走 PRDAFD0002（历史净值全量），信息走 PRDAFD0007，两者解耦。
  const __noNav = opts.mode === "info" || opts.mode === "quota";
  // 登记表（分享链/非 JY 个别产品）优先 → 默认 JY（App 产品超市通用访问码）
  const rc = String(opts.shareCode || "").trim() || (await commShareMap())[c] || COMM_APP_DEFAULT_RC;
  const t0 = Date.now();
  try {
    // ① 产品信息（2026-10-22：nav 模式跳过——信息接口不再当存在性/现金类闸门，直接抓净值）
    let info;
    if (__navMode) {
      info = { baseInfo: {}, extInfo: {}, agencyInfo: {} }; // 空占位：nav 模式信息字段为 null
    } else {
      info = await commAppPost("PRDAFD0007", { productNo: c, registerCode: rc, category: "01" }, opts.transport);
      const base = info && info.baseInfo;
      if (!base || !base.prdName) {
        navLog("comm app code=" + c + " rc=" + rc + " -> 无产品信息(" + (Date.now() - t0) + "ms)");
        return null;
      }
      // 安全校验：productNo 严格驱动产品，回显 prdCode 必须与入参一致，防串数据
      if (base.prdCode && String(base.prdCode).toUpperCase() !== c) {
        navLog("comm app code=" + c + " rc=" + rc + " -> prdCode 不符(" + base.prdCode + ")，拒绝");
        return null;
      }
    }
    const base = (info && info.baseInfo) || {};
    const ext = info.extInfo || {};
    // ② 历史净值序列（全量，升序）—— info/quota 不抓净值，整段跳过
    const hist = __noNav ? null : await commAppPost("PRDAFD0002", { productNo: c, registerCode: rc, category: "01" }, opts.transport);
    const lists = (hist && Array.isArray(hist.historyInfo) && hist.historyInfo[0] && hist.historyInfo[0].list) || [];
    const series = [];
    let established = null;
    for (const blk of lists) {
      if (!blk || !Array.isArray(blk.dataList)) continue;
      if (blk.title === "历史净值") {
        for (const row of blk.dataList) {
          const d = String((row && row[0]) || "");
          const v = parseFloat(row && row[1]);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(v) || v <= 0) continue;
          series.push([d, Number(v.toFixed(8))]);
        }
      } else if (blk.title === "历史业绩" && !established) {
        established = commAppEstablished(blk.dataList);
      }
    }
    series.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const last = series.length ? series[series.length - 1] : null;
    // 发行机构：交银理财有限责任公司 → 交银理财
    const agency = (info.agencyInfo && Array.isArray(info.agencyInfo.agencyInfoList) && info.agencyInfo.agencyInfoList[0]) || {};
    const mgr = String(agency.keyValue || "").replace(/有限责任公司|有限公司/g, "") || null;
    const out = {
      name: base.prdLongName || base.prdName || null,
      manager: mgr || null,
      risk: commAppRisk(ext.productRiskLevel, (base.prdTagList || []).map((t) => t && t.tagName).join(" ")),
      holdDays: commAppHoldDays(ext.minInvestTerm, base.prdBaseInfoList, base.prdName),
      established: established || null,
      benchmark: commAppBench(info.performanceBenchmarkInfo && info.performanceBenchmarkInfo.tipContent),
      series,
      navLatest: last ? last[1] : null,
      navLatestDate: last ? last[0] : null,
      navViaCode: c,
      shareCode: rc,
    };
    navLog("comm app code=" + c + " rc=" + rc + " -> n=" + series.length + " name=" + (out.name || "-") +
      " risk=" + (out.risk || "-") + " hold=" + (out.holdDays == null ? "-" : out.holdDays) +
      " estab=" + (out.established || "-") + " (" + (Date.now() - t0) + "ms)");
    return out;
  } catch (e) {
    navLog("comm app code=" + c + " throw " + ((e && e.message) || e) + " (" + (Date.now() - t0) + "ms)");
    return null;
  }
}

async function bocomPost(txn, data, transport) {
  const payload = { REQ_HEAD: { TRAN_PROCESS: "", TRAN_ID: "" }, REQ_BODY: data };
  const body = "REQ_MESSAGE=" + encodeURI(JSON.stringify(payload));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BOCOM_TIMEOUT_MS);
  try {
    const res = await (transport || fetch)(BOCOM_TXN + txn, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Accept: "application/json, text/plain, */*",
        "User-Agent": UA,
        Referer: BOCOM_REF,
      },
      body,
      signal: ctrl.signal,
    });
    const txt = (await res.text()).trim();
    if (!txt || txt[0] !== "{") return null;
    const j = JSON.parse(txt);
    return (j && j.RSP_BODY && j.RSP_BODY.result) || null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 交银风险描述 → R 级（与招行/建行口径一致）
function bocomRisk(level) {
  const t = String(level || "");
  if (/极低|低风险/.test(t)) return "R1";
  if (/较低风险|中低/.test(t)) return "R2";
  if (/中等风险|中风险/.test(t)) return "R3";
  if (/较高风险|中高/.test(t)) return "R4";
  if (/高风险/.test(t)) return "R5";
  return null;
}

// 从产品名推断最短持有天数（交银接口无该字段）
function bocomHoldDays(name) {
  const t = String(name || "");
  const d = t.match(/(?:^|\D)(\d{1,4})\s*天/);
  if (d) return Number(d[1]);
  const mo = t.match(/(?:^|\D)(\d{1,2})\s*个?月/);
  if (mo) return Number(mo[1]) * 30;
  const y = t.match(/(?:^|\D)(\d{1,2})\s*年/);
  if (y) return Number(y[1]) * 365;
  if (/日开|每日开放|天天开|现金管理|活期|随时/.test(t)) return 1;
  return null;
}

function bocomDate8(s) {
  const t = String(s || "");
  return /^\d{8}$/.test(t) ? t.slice(0, 4) + "-" + t.slice(4, 6) + "-" + t.slice(6, 8) : null;
}

async function bocomDetail(code, transport) {
  const r = await bocomPost("queryJylcProductDetail.do", { c_fundcode: code }, transport);
  return (r && r.jylcProductBo) || null;
}

async function bocomNav(code, interestway, transport) {
  const r = await bocomPost(
    "queryJylcBreakDetail.do",
    { c_fundcode: code, c_interestway: interestway != null ? String(interestway) : "0", type: "max", queryList: 1 },
    transport
  );
  const list = (r && r.profitList) || [];
  const out = [];
  for (const it of list) {
    const d = String(it.d_cdate || "");
    const v = parseFloat(it.f_netvalue);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(v) || v <= 0) continue;
    out.push([d, Number(v.toFixed(8))]);
  }
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return out;
}

// web 端口抓取（交银理财官网 www.bocommwm.com）：登记编码 + 成立日 + 净值序列 + 风险 + 基准
async function bocomWebFetch(code, transport) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  const bo = await bocomDetail(c, transport);
  if (!bo || !bo.c_fundname) return null;

  const series = await bocomNav(c, bo.c_interestway, transport).catch(() => []);
  const reg = /^Z\d{9,}$/.test(String(bo.c_productcode || "")) ? String(bo.c_productcode) : null;
  const base = {
    name: bo.c_fundname,
    manager: /交银/.test(bo.c_fundname) ? "交银理财" : inferManager(bo.c_agencyno || "") || bo.c_agencyno || null,
    established: bocomDate8(bo.d_setupdate),
    series,
    kind: "nav",
    risk: bocomRisk(bo.c_level),
    benchmark: bo.c_reserve0 || null,
    holdDays: bocomHoldDays(bo.c_fundname),
    regCode: reg,
    source: "live",
    bank: "comm",
    navVia: "comm",
    navPort: "web",
  };
  if (series.length) return base;

  // 无历史序列（新发/未披露）→ 用详情里的最新单位净值构造单点，仅回填真实信息
  const d = bocomDate8(bo.d_date);
  const v = parseFloat(bo.f_netvalue);
  if (d && Number.isFinite(v) && v > 0) return { ...base, series: [[d, Number(v.toFixed(8))]] };
  return { ...base, infoOnly: true };
}

export async function bocomFetch(code, opts = {}) {
  const transport = opts.transport;
  const sink = opts.__sink || null; // 耗时采集（fetchFromBank 下传）——用于分端口计时
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  // App 端口（shareCode 默认 JY，登记表可覆盖）与 web 端口并行发起，总耗时≈二者较大值；
  // App 无数据（未上架/已下架）时秒级返回 null，不影响原 web 链路。
  // 2026-10-22 分端口计时：并发双抓时把 App / web 各自总耗时单独落账，便于在「时间分解」里
  //   直接对比哪个端口更快（否则只有一串按路径命名的子请求，看不出端口级快慢）。
  const tApp = Date.now();
  const appP = commAppFetch(c, { shareCode: opts.shareCode, transport, mode: opts.mode }).then(
    (r) => { navTiming(sink, "comm.App端口", Date.now() - tApp, r && r.series && r.series.length ? ("series=" + r.series.length) : (r ? "infoOnly" : "null")); return r; },
    (e) => { navTiming(sink, "comm.App端口", Date.now() - tApp, "throw " + ((e && e.message) || e)); return null; }
  );
  // 【2026-10-23 用户规则】刷信息只刷信息、刷额度只刷额度——两者都不抓净值。
  // 交银双端口里 web（交银理财官网）是纯净值端口（详情 + 历史净值），info/quota 一律不跑；
  // App 端口按 mode 自行门控（commAppFetch 内部跳过 PRDAFD0002）。
  const __noNav = opts.mode === "info" || opts.mode === "quota";
  const tWeb = Date.now();
  const webP = __noNav ? Promise.resolve(null) : bocomWebFetch(c, transport).then(
    (r) => { navTiming(sink, "comm.web端口", Date.now() - tWeb, r && r.series && r.series.length ? ("series=" + r.series.length) : (r ? "infoOnly" : "null")); return r; },
    (e) => { navTiming(sink, "comm.web端口", Date.now() - tWeb, "throw " + ((e && e.message) || e)); return null; }
  );
  const [app, web] = await Promise.all([appP, webP]);
  if (!web && !app) return null;
  if (!app) return web; // app 无数据 → 原 web 链路行为不变

  const appSeries = app.series || [];
  const webSeries = (web && web.series) || [];
  if (!web) {
    // web 无结果（罕见）→ 纯 app 结果（无登记编码/成立日）
    const last = appSeries.length ? appSeries[appSeries.length - 1] : null;
    return {
      name: app.name,
      manager: app.manager,
      established: app.established,
      series: appSeries,
      kind: "nav",
      risk: app.risk,
      benchmark: app.benchmark,
      holdDays: app.holdDays,
      regCode: null,
      source: "live",
      bank: "comm",
      navVia: "comm",
      navPort: "app",
      navViaCode: c,
      navLatest: last ? last[1] : null,
      navLatestDate: last ? last[0] : null,
      infoOnly: appSeries.length < 2,
    };
  }
  // 双端口合并：净值序列按【日期并集】（同日 app 优先——app 通常新一天，web 补老 history；
  //   app 对长产品只回近 3 年滚动窗，按点数多者胜会白丢 app 新数据，故必须并集）。
  //   navPort 由「谁提供最新净值日」决定：app 最新日 >= web 最新日 → app，否则 web。
  const byDate = new Map();
  for (const [d, v] of webSeries) byDate.set(d, v);
  for (const [d, v] of appSeries) byDate.set(d, v); // app 覆盖同日值
  const series = [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const appLast = appSeries.length ? appSeries[appSeries.length - 1][0] : "";
  const webLast = webSeries.length ? webSeries[webSeries.length - 1][0] : "";
  const useApp = appSeries.length > 0 && appLast >= webLast;
  const last = series.length ? series[series.length - 1] : null;
  return {
    name: app.name || web.name,
    manager: app.manager || web.manager,
    established: web.established || app.established,
    series,
    kind: "nav",
    risk: app.risk || web.risk,
    benchmark: app.benchmark || web.benchmark,
    holdDays: app.holdDays != null ? app.holdDays : web.holdDays,
    regCode: web.regCode || null,
    source: "live",
    bank: "comm",
    navVia: "comm",
    navPort: useApp ? "app" : "web",
    navViaCode: c,
    navLatest: last ? last[1] : null,
    navLatestDate: last ? last[0] : null,
    infoOnly: series.length < 2,
  };
}

/* ==========================================================================
 * 中信银行（CITIC）实时抓取 —— 信银理财产品
 *
 * 【2026-10-23 起】双端口并发 + 按日期并集合并：
 *   ① 信银理财官网（web 端口，**主**）—— wechat.citic-wealth.com
 *      /cms.product/api/custom/productInfo/getTAProductDetail + getTAProductNav
 *      发行方权威：净值**含当日**、带登记编码/业绩基准/风险等级/成立日（直连全没有）；
 *      缺点：getTAProductNav 只有近 3 年窗口（queryUnit=5）。
 *      → 见下方 citicCmsFetch 注释。
 *   ② 中信银行 NMBFOServer 直连（app 端口）—— citic_direct_nav.mjs
 *      握手 RSA + 3DES-ECB（Node 原生 crypto / Workers Web Crypto），成立以来全量
 *      （实测 AF23231A 878 点、AM23013A 1407 点），但**比官网慢一个披露日**。
 *   两端口并发，日期并集：官网补最新一天 + 信息，直连补长历史。
 *   同日冲突以官网为准（发行人自己披露的口径）。
 *   【历史】2026-10-21 前经工行代销通道（复用 icbcLive）取净值，直连打通后已废弃，
 *   citicFetch 不再调用 icbcLive。
 *
 * ③ 信银理财 H5 精选目录（老接口，仅兜底信息）：
 *      GET https://wechat.citic-wealth.com/cms.product/api/productInfo/<api>
 *        search?key=<码> → fundCode / fundName / fundType / fundTypeName
 *        fundList?fundType=<0货币|1开放式|2> → 含 fundSetupDate / riskLevel /
 *        perNetvalue / navDate / performanceBenchMark / tags。
 *      ⚠ 该目录是「精选」小集合且数据陈旧（实测净值停在 2022），**不作为净值来源**。
 *
 * 净值口径：单位净值（kind 沿用上游 nav/wan 判定）；整段恒 1 的现金管理类按项目规则排除。
 * ========================================================================== */

const CITIC_API = "https://wechat.citic-wealth.com";
const CITIC_REF = "https://www.citic-wealth.com/trade/";
const CITIC_TIMEOUT_MS = 20000;

async function citicGet(api, params, transport) {
  const qs = Object.entries(params || {})
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v))
    .join("&");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CITIC_TIMEOUT_MS);
  try {
    const res = await (transport || fetch)(CITIC_API + "/cms.product/api/productInfo/" + api + (qs ? "?" + qs : ""), {
      headers: {
        "User-Agent": UA,
        Accept: "application/json, text/plain, */*",
        Referer: CITIC_REF,
        Origin: "https://www.citic-wealth.com",
      },
      signal: ctrl.signal,
    });
    const txt = (await res.text()).trim();
    if (!txt || txt[0] !== "{") return null;
    const j = JSON.parse(txt);
    return (j && j.code === "0000" && Array.isArray(j.data)) ? j.data : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function citicRisk(item) {
  const n = parseInt(item && item.riskLevel, 10);
  if (n >= 1 && n <= 5) return "R" + n;
  const t = String((item && item.riskLevelStr) || "");
  if (/极低|低风险/.test(t)) return "R1";
  if (/中低|较低/.test(t)) return "R2";
  if (/中高|较高/.test(t)) return "R4";
  if (/高风险/.test(t)) return "R5";
  if (/中风险/.test(t)) return "R3";
  return null;
}

// 中文数字 → 阿拉伯数字（1~99），只处理「一/二/两/三…/十/十四/二十」这类产品名常见写法
function cnSmallNum(s) {
  const m = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (m[s] != null) return m[s];
  const parts = String(s).split("十");
  if (parts.length === 2) {
    const hi = parts[0] ? m[parts[0]] : 1;
    const lo = parts[1] ? m[parts[1]] : 0;
    if (hi == null || lo == null) return null;
    return hi * 10 + lo;
  }
  return null;
}

// 从名称/标签推断最短持有天数（信银列表接口无该字段）
function citicHoldDays(item) {
  const t = String((item && (item.fundName || item.fundFullName)) || "");
  const tag = String((item && item.tags) || "");
  // 2026-10-23：信银产品名常用中文数字（「七天持有期」「六个月持有期」「十四个月」），先归一成阿拉伯数字
  const all = (t + " " + tag).replace(/([零一二两三四五六七八九十]{1,3})\s*(?=天|个月|月|年)/g, (s0) => {
    const n = cnSmallNum(s0);
    return n != null ? String(n) : s0;
  });
  const d = all.match(/(?:^|\D)(\d{1,4})\s*天/);
  if (d) return Number(d[1]);
  const mo = all.match(/(?:^|\D)(\d{1,2})\s*个?月/);
  if (mo) return Number(mo[1]) * 30;
  // 信银官网短名用「6M持有期」这种英文月写法（如「(安享+)安盈象固收稳健6M持有期19号D」）
  const moEn = all.match(/(?:^|[^A-Za-z0-9])(\d{1,3})\s*M(?![A-Za-z0-9])/i);
  if (moEn) return Number(moEn[1]) * 30;
  const yr = all.match(/(?:^|\D)(\d{1,2})\s*年/);
  if (yr) return Number(yr[1]) * 365;
  if (/季开|季度|3个月/.test(all)) return 90;
  if (/月定开|月开|月享/.test(all)) return 30;
  if (/周开|周享|7天/.test(all)) return 7;
  if (/日开|天天|日日|每日开放|现金管理|活期|随时/.test(all)) return 1;
  return null;
}

function citicDate8(s) {
  const t = String(s || "");
  return /^\d{8}$/.test(t) ? t.slice(0, 4) + "-" + t.slice(4, 6) + "-" + t.slice(6, 8) : null;
}

/* ==========================================================================
 * 信银理财官网（www.citic-wealth.com → wechat.citic-wealth.com）—— 发行方权威净值/信息源
 * 2026-10-23 接入（用户报障：官网 AF245689D 有 10-23 净值，我们只到 10-22）
 *
 * 为什么加：中信银行 NMBFOServer 直连接口（citic_direct_nav.mjs）**比发行人官网慢一个
 *   披露日**，且只有净值、没有登记编码/业绩基准/风险等级（信息要跑中国理财网，实测 +2~5s）。
 *   实测 AF245689D（(安享+)安盈象固收稳健6M持有期19号D(可转债)）：
 *     官网 10-23 已披露 1.0553，直连只到 10-22 → 用户 2026-10-23 报障的直接成因；
 *     官网 detail 直接给 registCode=Z7002624000769 + benchmarks + riskLevel（直连全无）。
 *
 * 站点结构（2026-10-23 实测）：产品展示页 /yymk/lccs/ 只是个壳，真正的内容是
 *   iframe → /wechat/product/（Vue SPA，app.js 里写着接口）。
 *   接口 host 是 **wechat.citic-wealth.com**（不是 www，www 下 /cms.product/* 会 302 到
 *   /yyym/failure/index.html）；免登录、免签名、免 Cookie、只需普通 UA。
 *
 *   ① GET /cms.product/api/custom/productInfo/getTAProductDetail?prodCode=<份额码>
 *      → data: prodName / prodNameShort / prodCode(份额码) / fprodCode(产品码) /
 *        registCode(登记编码) / benchmarks(基准公式) / benchmarksBasisCal(基准全文) /
 *        riskLevel("2"→R2) / firstNavDate(首个净值日 YYYYMMDD，作成立日) /
 *        nav / totalNav / navDate / respProductTypeStr(每日购/封闭…) / raiseCcy
 *   ② GET /cms.product/api/custom/productInfo/getTAProductNav?prodCode=<份额码>&queryUnit=N
 *      → data: total / productNavList[] / productNavPic[]
 *        productNavList[]: navDate(YYYYMMDD) / nav / totalNav / priceBuy / priceRedeem / assetNav
 *        ⚠ queryUnit 是「区间档位」不是全量：1=近1月 2=近3月 3=近6月 4=近1年 **5=近3年**；
 *          6=自定义但需 beginDate/endDate（格式未探明，一律报「参数[beginDate]存在异常」）。
 *          实测 AM23013A 档位5 只回 1096 点（2023-10-25→2026-10-24），而直连有 1407 点
 *          → **官网只有近 3 年窗口**，长历史必须与直连按日期并集合并，不能单用官网。
 *   ③ GET /cms.product/api/custom/productInfo/getRiskWarningDesc（风险提示文案，不用）
 *
 * 覆盖边界：信银理财自营产品（含各份额字母码）。他行理财子产品 search 不到 → 返回 null。
 * ========================================================================== */
const CITIC_CMS_API = "https://wechat.citic-wealth.com/cms.product/api/custom/productInfo";
const CITIC_CMS_REF = "https://www.citic-wealth.com/wechat/product/";
const CITIC_CMS_TIMEOUT_MS = 15000;

async function citicCmsGet(api, params, transport) {
  const qs = Object.entries(params || {})
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v))
    .join("&");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CITIC_CMS_TIMEOUT_MS);
  try {
    const res = await (transport || fetch)(CITIC_CMS_API + api + (qs ? "?" + qs : ""), {
      headers: {
        "User-Agent": UA,
        Accept: "application/json, text/plain, */*",
        Referer: CITIC_CMS_REF,
        Origin: "https://www.citic-wealth.com",
      },
      signal: ctrl.signal,
    });
    if (!res || !res.ok) return null;
    const txt = (await res.text()).trim();
    if (!txt || txt[0] !== "{") return null;
    const j = JSON.parse(txt);
    return (j && j.code === "0000" && j.data && typeof j.data === "object") ? j.data : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ==========================================================================
// 信银官网「按名检索」→ 份额码（2026-10-25 打通）
//
// 用途：解决「代销渠道码 ≠ 发行方份额码」——浦发代销的信银产品，浦发码 2301232123
//   在信银官网 /getTAProductDetail 查不到（官网只认份额码 AF223066H），此前的唯一出路
//   是回落到中国理财网按名检索（慢、且受 per-IP 限流），与本项目「净值优先走端口」的
//   目标相悖。官网自带检索接口后，代销→发行方官网的净值链完全闭合。
//
// 接口（从 SPA bundle app.js 挖出，参数只有一个 key）：
//   GET /cms.product/api/custom/productInfo/search?key=<名称或代码片段>
//   → data: 数组，每项含 prodCode(份额码) / prodName(产品全名) 等
//   实测「安盈象固收稳健十四天持有期2号」→ B/G/H/L/M/Y 六个份额（同一 prodName），
//        按代码片段「AF223066」同样返回这六个；按渠道码「2301232123」返回 0（它是浦发码）。
//
// 选份额规则：渠道产品名尾部字母 = 份额字母（「…2号H」的 H）→ 精确取 AF223066H。
//   无尾字母或尾字母无匹配时，**仅当官网只返回一个份额**才采用，多份额一律不猜
//   （同登记编码下各份额净值不同：B=1.104 / H=1.0809，猜错等于把别人的净值入库）。
// ==========================================================================
const CITIC_SEARCH_TTL = 10 * 60 * 1000;
const citicSearchCache = new Map();          // 检索词 → { t, list }

async function citicSearchShares(name, transport) {
  // 去掉尾部份额字母与括号说明：官网 prodName 不含份额字母，带字母整词会 0 命中
  const kw = xplStripShareLetter(xplSearchKeyword(name));
  if (!kw) return [];
  const hit = citicSearchCache.get(kw);
  if (hit && Date.now() - hit.t < CITIC_SEARCH_TTL) return hit.list;
  const d = await citicCmsGet("/search", { key: kw }, transport).catch(() => null);
  const list = Array.isArray(d) ? d : [];
  citicSearchCache.set(kw, { t: Date.now(), list });
  navLog("citic 名检索 kw=" + kw + " -> " + list.length + " 个份额 " +
    list.map((r) => r && r.prodCode).filter(Boolean).join(","));
  return list;
}

async function citicResolveShareByName(name, transport) {
  const letter = xplNameShareLetter(name);
  const list = await citicSearchShares(name, transport);
  const codes = list.map((r) => String((r && r.prodCode) || "").trim().toUpperCase()).filter(Boolean);
  if (!codes.length) return null;
  if (letter) {
    const hit = codes.find((x) => x.endsWith(letter));
    if (hit) return hit;
    navLog("citic 名检索 name=" + name + " 尾字母 " + letter + " 在 " + codes.join(",") + " 中无匹配");
    return null; // 尾字母明确但官网没有该份额 → 不猜
  }
  return codes.length === 1 ? codes[0] : null; // 无尾字母：仅唯一份额时采用
}

/**
 * 信银理财官网抓取（web 端口）。
 * @param {string} code 份额代码（如 AF245689D）
 * @param {{transport?:Function, infoOnly?:boolean, __det?:object}} opts
 *   infoOnly=true 只取 detail（信息壳），**不拉 getTAProductNav**（刷信息模式用）。
 *   __det = 调用方已经取好的 detail（省一次往返，citicFetch 要用 firstNavDate 做判断）。
 */
// 信银官网净值结果的 60 秒进程内记忆。
// 动机：getTAProductNav 单次要回 459KB，实测 3.3~17.8s，是整条链最贵的一步。而同一产品
// 常在一次操作里被调两次（appFirst 发行腿 + 桥① 复用/重试；用户连点刷新；批量刷新重入），
// 没有记忆就要重复下载。60s 足够短——信银每天只披露一次净值，不存在「缓存挡住新净值」。
// 手动刷新（noCache=1）绕过缓存，保证用户点「刷新」时一定回源。
const CITIC_CMS_CACHE_TTL = 60 * 1000;
const citicCmsCache = new Map();          // "code|n" / "code|i" -> { t, v }

export async function citicCmsFetch(code, opts = {}) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  const transport = opts.transport;
  // navPointOnly：只取 detail（含 nav / navDate 末点），不拉 459KB 的 getTAProductNav。
  // 供「双来源」场景下当附源补末点用（2026-10-25）；缓存 key 单独一档，不污染全量结果。
  const pointOnly = !!opts.navPointOnly;
  const ck = c + (opts.infoOnly ? "|i" : pointOnly ? "|p" : "|n");
  if (!opts.noCache) {
    const hit = citicCmsCache.get(ck);
    if (hit && Date.now() - hit.t < CITIC_CMS_CACHE_TTL) {
      navLog("citic cms 缓存命中 code=" + c + (opts.infoOnly ? " info" : pointOnly ? " point" : " nav") +
        " 点数=" + ((hit.v && hit.v.series) ? hit.v.series.length : 0) + " age=" + Math.round((Date.now() - hit.t) / 1000) + "s");
      return hit.v;
    }
  }

  const det = opts.__det || await citicCmsGet("/getTAProductDetail", { prodCode: c }, transport);
  if (!det || !det.prodCode) return null; // 官网未收录（他行理财子产品）

  let series = [];
  let cash = false;
  if (!opts.infoOnly && !pointOnly) {
    const nav = await citicCmsGet("/getTAProductNav", { prodCode: c, queryUnit: 5 }, transport);
    const rows = (nav && Array.isArray(nav.productNavList)) ? nav.productNavList : [];
    const byDate = new Map();
    for (const r of rows) {
      const dt = citicDate8(r && r.navDate);
      const v = Number(r && r.nav);
      if (dt && Number.isFinite(v) && v > 0) byDate.set(dt, Number(v.toFixed(8)));
    }
    series = [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    // 【项目规则 2026-10-21】现金管理类（单位净值整段恒 1）不抓
    if (series.length && series.every(([, v]) => Math.abs(v - 1) <= 1e-6)) {
      cash = true;
      series = [];
    }
  }

  const established = citicDate8(det.firstNavDate) || (series.length ? series[0][0] : null);
  const holdSrc = { fundName: det.prodNameShort || det.prodName, tags: "" };

  const out = {
    name: det.prodName || det.prodNameShort || null,
    // web 端口只收录信银理财自家产品，故默认「信银理财」；若调用方给了真实发行机构则优先用之
    // （避免中信代销他行产品被误标发行方）。
    manager: (opts.manager && managerToBankKey(opts.manager) ? opts.manager : "信银理财"),
    established,
    establishedFromSeries: !citicDate8(det.firstNavDate) && series.length > 0,
    series,
    cash,
    kind: "nav",
    risk: citicRisk({ riskLevel: det.riskLevel, riskLevelStr: "" }),
    benchmark: det.benchmarks || null,
    holdDays: citicHoldDays(holdSrc),
    regCode: det.registCode || null,
    source: "live",
    bank: "citic",
    navVia: "citic",
    navPort: "web",
    navViaCode: c,
    infoOnly: !!opts.infoOnly,
    navLatest: series.length ? series[series.length - 1][1]
      : (Number(det.nav) > 0 ? Number(det.nav) : null),
    navLatestDate: series.length ? series[series.length - 1][0] : citicDate8(det.navDate),
  };
  // 只缓存成功结果（null / 未收录不缓存，避免把瞬时故障放大成 60s 黑洞）
  citicCmsCache.set(ck, { t: Date.now(), v: out });
  return out;
}

/* ==========================================================================
 * 中信银行官网「代销产品信息查询平台」端口（2026-11-02 新增）
 * ------------------------------------------------------------------------
 * 页面：https://www.citicbank.com/personal/investment/lcjdxcpxx/proxy/
 *       （中信银行代销产品信息查询平台，静态页 + jQuery JSONP，无登录）
 * 接口：https://etrade.citicbank.com/portalweb/cms/getConsignProdList.htm
 *       GET ?callback=cb&prdCode=<产品代码>&prdName=<产品名称>&pageSize=&currentPage=
 *       （portalURL 由页面 api.js 定义；接口路径来自页面 option 的 ds_url 属性）
 * 参数（页面 finProxy.js 的 switch(cpType) 分支，cpType=6=代销理财产品）：
 *       prdCode（产品代码）/ prdName（产品名称）/ pageSize / currentPage。
 *       taCode=发行机构代码，页面靠 getCmpSimpList 映射；**按码查时无需传**。
 *
 * 响应（JSONP 包 cb(...)）：{ totalCount, pageCount, retCode:"AAAAAAA", content:{ resultList:[{
 *   taName  发行方（**权威口径**，如「光大理财」「信银理财」）
 *   prdCode 产品代码 / prdName 产品名称
 *   nav     最新单位净值（字符串，12 位小数）
 *   navDate 净值日期（yyyyMMdd）—— **比 App 端口新**（App 慢一个披露日）
 *   riskLevel 风险等级（"1".."5" → R1..R5；"2"=较低风险）
 *   status  产品状态（"0"=开放期，其余见页面 cpzt 映射）
 *   ipoMode 募集方式 / saleArea 销售区域 / cpfl 产品分类 / dePid / prdType
 * ]}}
 *
 * 特性：① 免登录免签名、**不带 Referer 也通**（无 WAF，Worker 可直连）；
 *       ② **收录中信代销的全部产品**（含他行发行，如光大理财 EW7019D），
 *          而信银理财官网 web 端口只收信银自家产品 —— 这是本端口的核心价值；
 *       ③ 单点净值（无历史序列），故只作「末点/发行方/风险等级」补充源，
 *          历史序列仍走信银官网 web 端口或 App 端口。
 * ========================================================================== */
const CITICBANK_WEB_API = "https://etrade.citicbank.com/portalweb/cms/getConsignProdList.htm";
const CITICBANK_WEB_TIMEOUT_MS = 15000;
// 官网状态码 → 文案（页面 finProxy.js 的 cpzt 映射，仅列我们用得到的）
function citicBankStatusText(s) {
  const m = { "0": "开放期", "1": "停售", "2": "即将开售", "3": "暂停申购", "4": "停止申购", "5": "停止赎回",
    "6": "权益登记", "7": "红利发放", "8": "产品封闭", "9": "产品终止", a: "预约认购期" };
  return m[String(s)] || null;
}

export async function citicBankWebFetch(code, opts = {}) {
  const transport = opts.transport;
  const c = String(code || "").trim().toUpperCase();
  const nm = String(opts.name || "").trim();
  if (!c && !nm) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CITICBANK_WEB_TIMEOUT_MS);
  let txt = null;
  try {
    const q = new URLSearchParams();
    q.set("callback", "cb");
    if (c) q.set("prdCode", c);
    if (nm && !c) q.set("prdName", nm);
    q.set("pageSize", "10");
    q.set("currentPage", "1");
    const res = await (transport || fetch)(CITICBANK_WEB_API + "?" + q.toString(), {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36" },
      signal: ctrl.signal,
    });
    txt = await res.text();
  } catch (e) {
    clearTimeout(timer);
    navLog("citicbank 官网查询异常 code=" + c + " -> " + ((e && e.message) || e));
    return null;
  }
  clearTimeout(timer);
  // 剥 JSONP 包裹：cb({...})
  const m = String(txt || "").match(/^[^(]*\(([\s\S]*)\)\s*;?\s*$/);
  let j = null;
  try { j = JSON.parse(m ? m[1] : txt); } catch (e) { j = null; }
  if (!j || j.retCode !== "AAAAAAA") {
    navLog("citicbank 官网查询无结果 code=" + c + " retCode=" + (j && j.retCode));
    return null;
  }
  const list = (j.content && Array.isArray(j.content.resultList)) ? j.content.resultList : [];
  if (!list.length) {
    navLog("citicbank 官网查询 resultList 空 code=" + c);
    return null;
  }
  // 按码查时取码完全一致者；按名查时取首条（页面本身也只按名模糊匹配）
  let row = c ? (list.find((r) => String(r.prdCode || "").toUpperCase() === c) || list[0]) : list[0];
  if (!row) return null;
  const navVal = Number(row.nav);
  const navDate = String(row.navDate || "").trim();
  const navIso = /^\d{8}$/.test(navDate)
    ? navDate.slice(0, 4) + "-" + navDate.slice(4, 6) + "-" + navDate.slice(6, 8)
    : (navDate || null);
  const riskLv = String(row.riskLevel || "").trim();
  return {
    code: c,
    name: row.prdName || null,
    manager: row.taName || null,          // 发行方权威口径
    managerAuthoritative: true,             // 代销行自己披露的发行方 → 前端可据此覆盖种子值
    nav: Number.isFinite(navVal) ? navVal : null,
    navDate: navIso,
    risk: /^[1-5]$/.test(riskLv) ? ("R" + riskLv) : null,
    status: citicBankStatusText(row.status),
    series: (navIso && Number.isFinite(navVal) && navVal > 0) ? [[navIso, navVal]] : [],
    kind: "nav",
    source: "live",
    bank: "citic",
    navVia: "citic",
    navPort: "citicbank-web",
    navViaCode: c,
    infoOnly: false,
  };
}

export async function citicFetch(code, opts = {}) {
  const transport = opts.transport;
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  // 【2026-10-25】份额码桥接：渠道码（浦发 2301232123 等）在信银官网查不到产品，
  // 编排层解析出发行方份额码（AF223066H）后经 opts.shareCode 下传，此处改用它重走全链路。
  // 该分支只在「本行按渠道码已抓空」后才会被触发，故不必先探渠道码、零额外请求。
  const shareAlt = String(opts.shareCode || "").trim().toUpperCase();
  if (shareAlt && shareAlt !== c) return await citicFetch(shareAlt, { ...opts, shareCode: null });
  // 【2026-10-25 额度打通】信银理财 App「剩余可购买金额」实抓：
  //   官网 wechat.citic-wealth.com 两个端口确实都没有额度字段（已穷举 25 路径 + 48 字段确认），
  //   但中信银行 App 端口 NMBFOServer 的 PEMBFIPL（**必须带 TACODE:"YZX"**）单次 ~450ms
  //   回 187 字段，其 TOTUSEAMT 与 App「剩余可购买金额」实测一致（AF247339H：
  //   App 1,930,241,709.89 ｜ TOTUSEAMT 1,930,241,710.53，折万元 193,024.17万 与截图逐位同；
  //   且在 2206 只全量中「已用≈该值」唯一命中、「上限−已用≈该值」零命中）。
  //   覆盖面 = 中信代销的信银产品（与净值直连同覆盖面）；纯他行代销份额回 null。
  if (opts.mode === "quota") {
    try {
      const q = await citicDirectQuota(c, { transport, noCache: opts.noCache });
      if (q) {
        navLog("citic quota code=" + c + " -> remainQuota=" + q.remainQuota + " 元 (" + (q.remainQuota / 1e4).toFixed(2) + " 万)" +
          " 上限=" + q.capQuota + " 状态=" + (q.saleStatus || "-"));
        return q;
      }
      navLog("citic quota code=" + c + " -> null（中信未代销/查无此码）");
    } catch (e) {
      navLog("citic quota code=" + c + " -> 异常 " + ((e && e.message) || e));
    }
    return null;
  }

  // 【2026-11-02 修复】中信 tab 内「非信银理财」代销产品（如光大 EW7019D）：
  //   信银官网 web 端口（wechat.citic-wealth.com）只收录信银理财自家产品 → 必然查无；
  //   中信银行 App 端口（NMBFOServer）才收录中信代销的全部产品。此类产品直接走 App 端口，
  //   跳过 web 端口（否则 web 落空 → 掉中国理财网兜底；且 App 端口因 needLong 不成立从未启用）。
  //   仅当 manager 已知且非信银时启用；manager 未知时维持原行为（web 优先、超 3 年补 App）。
  // ⚠ manager 可能被前端传成「产品名」（前端在发行机构缺失时以名称兜底，见 index.html _effMgr），
  //   故用 managerToBankKey 能否识别出银行 key 来判定「这是不是一个真正的机构名」：
  //   识别不出（key=""）→ 视为未知，不拿它回填 manager，避免把产品名写成发行机构。
  const _mgrKey = managerToBankKey(opts.manager || "");
  const _isCiticOwn = _mgrKey === "citic";
  const _mgrName = _mgrKey ? (opts.manager || "").trim() : null; // 可信的真实发行机构名
  const directOnce = async () => {
    try {
      const d = await citicDirectNav(c, { transport, manager: _mgrName || undefined });
      return (d && d.series && d.series.length) ? d : null;
    } catch (e) { return null; }
  };
  // 【2026-11-02】中信银行官网「代销产品信息查询平台」端口（收录中信代销的**全部**产品，含他行发行）：
  //   taName = **发行方权威口径**；nav/navDate = 当日单点（比 App 端口新）；riskLevel；status。
  //   它只给单点（无历史序列），故定位为「末点 + 发行方 + 风险」补充源，历史由 App 端口补全。
  //
  // ⚠ 判定发行方**不能只靠 opts.manager**：添加产品时前端还没存过 manager（走 /api/product
  //   且不传 manager 参数），此时 _mgrName 为 null → 旧条件恒不成立 → 走主路径时 App 端口
  //   因 needLong（成立不满 3 年）不启用 → 只剩官网单点 1 点 → 被编排层「全量模式单点不放行」
  //   拒收 → 落中国理财网兜底，末点退回旧披露日（实测新增 EW8668D：末点 10-30 而非 11-02）。
  //   故改为：**官网 taName 即权威发行方**，据此决定是否需要 App 端口补历史，两条路径行为一致。
  const _web0 = await citicBankWebFetch(c, { transport, name: opts.name }).catch(() => null);
  const _webTa = (_web0 && _web0.manager) ? String(_web0.manager).trim() : null;
  // 发行方判定优先级：官网 taName（权威） > 调用方传入且能被识别的机构名
  const _effMgrName = _webTa || _mgrName || null;
  const _effMgrKey = _effMgrName ? managerToBankKey(_effMgrName) : "";
  const _isCiticOwn2 = _effMgrKey === "citic";
  if (_effMgrName && !_isCiticOwn2) {
    // 非信银代销产品（光大理财等）：官网 + App 两腿并集
    // 【2026-11-02】App 端口偶发失败（PENFHNLC 空响应等）→ **并发**发起两轮，先成功者胜：
    //   否则官网单点（1 点）单独成立会被编排层「全量模式单点不放行」规则拒收 → 白抓一次。
    //   并发而非串行重试：串行要多等一整轮（~1.6s），并发总耗时≈一轮。
    const _appRace = await Promise.all([
      directOnce().catch(() => null),
      directOnce().catch(() => null),
    ]);
    let _app = _appRace.find((x) => x && x.series && x.series.length) || null;
    const _web = _web0;
    if (_web || _app) {
      const byD = new Map();
      if (_app && _app.series) for (const [d, v] of _app.series) if (d) byD.set(d, v);
      if (_web && _web.series) for (const [d, v] of _web.series) if (d) byD.set(d, v); // 官网覆盖同日（更权威）
      const series = [...byD.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      if (series.length) {
        // 【2026-11-02】官网单点单独成立（App 端口两次都失败）：标 navIncremental，
        //   让编排层在增量模式走单点放行（navLegOkCtx），避免这唯一的新鲜净值被白丢。
        const _onlyWebPoint = series.length === 1 && !(_app && _app.series && _app.series.length);
        const base = _app || _web;
        const last = series[series.length - 1];
        return {
          code: c,
          name: (_web && _web.name) || (base && base.name) || null,
          // 发行方：官网 taName 优先（权威），其次调用方传入的真实机构名；都无则 null（不臆测）
          manager: _effMgrName,
          managerAuthoritative: !!_webTa,
          established: (base && base.established) || series[0][0],
          series,
          kind: "nav",
          risk: (_web && _web.risk) || (base && base.risk) || null,
          source: "live",
          bank: "citic",
          navVia: "citic",
          navPort: (_web && last[0] === _web.series[_web.series.length - 1][0]) ? "citicbank-web" : "app",
          navViaCode: c,
          navIncremental: _onlyWebPoint ? true : undefined,
        };
      }
    }
    navLog("citic 非信银代销产品 官网+App 端口均未抓到（code=" + c + "）→ 返回 null");
    return null;
  }

  // 官网 detail 先探一次（仅信银自家产品走 web 端口；非信银已在上方直走 App 端口）
  const det0 = await citicCmsGet("/getTAProductDetail", { prodCode: c }, transport).catch(() => null);
  // 【2026-10-25】渠道码 → 份额码：官网 detail 查不到（代销渠道卖的产品，官网只认份额码）时，
  // 用**产品名称**调官网按名检索，返回该产品全部份额，再按渠道名尾字母精确取。
  // 实证「安盈象固收稳健十四天持有期2号」→ B/G/H/L/M/Y 六个份额，浦发卖的是 H。
  // 这样「代销渠道 → 发行方官网」的净值链完全打通，不再依赖中国理财网兜底。
  if (!det0 && opts.name && !opts.__named) {
    const alt = await citicResolveShareByName(opts.name, transport).catch(() => null);
    if (alt && alt !== c) {
      navLog("citic 渠道码 " + c + " 官网无此产品 → 按名检索定位份额 " + alt + "（name=" + opts.name + "）");
      return await citicFetch(alt, { ...opts, shareCode: null, __named: true });
    }
    navLog("citic 渠道码 " + c + " 官网无此产品，按名检索未定位到份额（name=" + opts.name + "）");
  }

  if (opts.mode === "info") {
    return await citicCmsFetch(c, { transport, infoOnly: true, __det: det0, noCache: opts.noCache }).catch(() => null);
  }
  // （quota 模式已在函数开头短路返回，此处不会到达）

  // 【2026-10-25 双来源·只补末点】detail 已带 nav / navDate，直接回单点壳，
  // 不拉 459KB 的 getTAProductNav（那是 3~17s 的瓶颈）。供「浦发 App 已回全量、
  // 只需发行方补最新一天」的场景使用；调用方若拿它当主源会因 series 不足被跳过，
  // 编排层随后用全量重试兜底，不会丢历史。
  if (opts.navPointOnly) {
    return await citicCmsFetch(c, { transport, navPointOnly: true, __det: det0, noCache: opts.noCache }).catch(() => null);
  }

  // 【双源并集（2026-10-23）】
  //   官网 web 端口：净值**含当日**，但只有近 3 年窗口；
  //   直连 app 端口：成立以来全量，但**慢一个披露日**。
  //   策略：先花 ~250ms 拿官网 detail（本来也要用），看成立日 ——
  //     · 成立不满 3 年 → 官网窗口已覆盖全部历史，**不必**再打直连（省 2~4s，多数产品走这条）；
  //     · 成立超过 3 年 → 官网只给近 3 年，并发直连补长历史，按日期并集合并；
  //   同一天两端口都有时以官网为准（发行人自己披露的口径）。
  // detail 已在函数开头探过（det0，供份额码桥接与 info 模式共用），此处直接复用，不重复请求
  const det = det0;
  const estD = citicDate8(det && det.firstNavDate);
  const cut3y = new Date(Date.now() - Math.round(3 * 365.25 * 864e5)).toISOString().slice(0, 10);
  const needLong = !estD || estD < cut3y; // 官网 3 年窗口覆盖不到成立以来
  // 【2026-11-02】中信银行官网代销查询端口并发参与：单点最新净值（比信银官网/App 都新）+ taName 发行方权威口径。
  // 复用上游已查好的 _web0（避免同一产品查两次官网）。
  const cbwP = Promise.resolve(_web0);
  const cmsP = det ? citicCmsFetch(c, { transport, __det: det, noCache: opts.noCache }).catch(() => null) : Promise.resolve(null);
  const dirP = needLong ? directOnce() : Promise.resolve(null);
  const [cms0, dir0, cbw0] = await Promise.all([cmsP, dirP, cbwP]);
  let cms = cms0;
  let dir = dir0;
  // 官网序列抓空（detail 有、nav 失败）时补一枪直连，别让产品掉成 null
  if (cms && !cms.cash && !cms.series.length && !dir) dir = await directOnce();

  // 官网明确是现金管理类 → 按项目规则排除（与直连同口径）。
  // 返回哨兵而非 null：让编排层能下发 isCash（前端提示「现金管理类」），
  // 而不是与「查无此码」混为一种「未抓到」（2026-10-23 审计统一）。
  if (cms && cms.cash) return { _excludedCash: true, code: c };
  if (!cms && !dir && !cbw0) return null;

  const byDate = new Map();
  if (dir && dir.series) for (const [d, v] of dir.series) if (d) byDate.set(d, v);
  if (cms && cms.series) for (const [d, v] of cms.series) if (d) byDate.set(d, v); // 官网覆盖同日
  // 【2026-11-02】中信银行官网的当日单点并入（同日以官网为准：它是最新的官方披露口径）。
  if (cbw0 && cbw0.series) for (const [d, v] of cbw0.series) if (d) byDate.set(d, v);
  const series = [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (!series.length) return null;
  // 现金类兜底排除：返回哨兵让编排层下发 isCash（而非与「查无此码」混同）
  if (series.every(([, v]) => Math.abs(v - 1) <= 1e-6)) return { _excludedCash: true, code: c };

  const lastDate = series[series.length - 1][0];
  const cmsLast = cms && cms.series && cms.series.length ? cms.series[cms.series.length - 1][0] : null;
  const dirLast = dir && dir.series && dir.series.length ? dir.series[dir.series.length - 1][0] : null;
  // 端口归属：谁提供最后一天算谁的（通常官网）
  const cbwLast = cbw0 && cbw0.series && cbw0.series.length ? cbw0.series[cbw0.series.length - 1][0] : null;
  // 端口归属：谁提供最后一天算谁的（官网代销查询最权威且最新 → 优先）
  const navPort = (cbwLast && cbwLast === lastDate) ? "citicbank-web"
    : (cmsLast && cmsLast === lastDate) ? "web" : (dirLast === lastDate ? "app" : (cbw0 ? "citicbank-web" : "web"));

  const base = cms || dir || {};
  const established = (cms && cms.established) || (dir && dir.established) || series[0][0];
  // 成立日来源：只有官网 firstNavDate 是官方字段；直连的 established 本身就是序列首点推出来的
  const establishedFromSeries = !(cms && cms.established && cms.establishedFromSeries === false);

  return {
    name: (cbw0 && cbw0.name) || base.name || null,
    // 【2026-11-02】原为 base.manager || "信银理财" —— 硬编码会把「中信代销他行产品」
    // （如光大 EW7019D）误标成信银理财，正是种子数据被写错发行方的根因。
    // 现口径：web 端口(信银自家产品)自带 manager；App 端口用调用方传入的真实发行机构；
    // 都拿不到就留 null（前端保留种子值），绝不臆测成信银理财。
    manager: (cbw0 && cbw0.manager) || (cms && cms.manager) || (dir && dir.manager) || null,
    managerAuthoritative: !!(cbw0 && cbw0.manager),
    established,
    establishedFromSeries,
    series,
    kind: "nav",
    risk: (cbw0 && cbw0.risk) || (cms && cms.risk) || (dir && dir.risk) || null,
    benchmark: (cms && cms.benchmark) || (dir && dir.benchmark) || null,
    holdDays: (cms && cms.holdDays != null) ? cms.holdDays : (dir && dir.holdDays != null ? dir.holdDays : null),
    regCode: (cms && cms.regCode) || (dir && dir.regCode) || null,
    source: "live",
    bank: "citic",
    navVia: "citic",
    navPort,
    navViaCode: c,
  };
}


/* ==========================================================================
 * 建设银行（CCB）实时抓取 —— 理财频道「理财产品净值」披露页
 *
 * 网关：GET <host>/tran/WCCMainPlatV5?CCB_IBSVersion=V5&SERVLET_NAME=WCCMainPlatV5
 *       必须带 Referer: <host>/cn/finance/products/net_value/list.html，免登录免签名。
 *
 * 双 host（2026-10-18 实测）：tool3.ccb.cn 与 wealth.ccb.com 是同一个
 * WCCMainPlatV5 网关的两个前端——detail.html / js/detail.js 字节数完全一致，
 * NLC165 / NLC164 / txt 三类请求在两者上都返回同样的数据（374/374 点对账相同）。
 * 两者都是 web/H5 官网端口（建行 App 理财模块即 WebView 套这些公开页）。
 * 抓取时以「上次成功的 host」优先做主备切换，详见下方 ccbHostIdx 注释。
 *
 * ① 产品信息（按码精确过滤 —— 这是关键，省掉 38 页全量枚举）：
 *      …&TXCODE=NLC165&Rs_MtdCd=1&REC_IN_PAGE=200&PAGE_JUMP=1&IvsmPd_ECD=<码>
 *      → PROD_MARKET_LIST[]：IvsmPd_ECD / Fnd_Nm / Inst_Nm(发行机构) / Txn_Mkt_ID /
 *        FndCo_Agnc_Sale_InsID / Unit_Ast_NetVal(最新单位净值) / Lot_AcNetVal /
 *        Each_TenThsnd_Pft_Amt(万份收益) / CrFd_7_Day_AnulRtRet(七日年化) / Valt_Dt / SubTp_ID
 *      ⚠ 该接口无风险等级、无登记编码、无业绩比较基准（NLC164 详情接口需登录，
 *        服务端直连返回「交易失败…请重新登录」），故这几项置 null。
 *
 * ② 历史净值：静态披露文件（全量，无需翻页）
 *      GET /newsinfo/finance/{IvsmPd_ECD}{Txn_Mkt_ID}{FndCo_Agnc_Sale_InsID}40{Ctrl_Ind_Cgy}.txt
 *      Ctrl_Ind_Cgy：09=单位净值 10=累计净值 15=万份收益 01=七日年化 07=成立以来年化
 *      → { Index_Group:[{Qtn_Dt:YYYYMMDD, Exp_YldRto:<值>}] }
 *      文件名由 NLCZST 校验（只回 {"result":"y"}，无额外信息），故这里直接拼。
 *      Txn_Mkt_ID 只有 16 种、FndCo_Agnc_Sale_InsID 恒为 005，且与 Inst_Nm 一一对应
 *      → 万一码不在列表里，可并行试 16 个组合兜底。
 *
 * ⚠ 时效坑：txt 是定期再生的静态文件，实测滞后可达 2 个月（样例末点 07-22，
 *   而列表 Unit_Ast_NetVal 已披露到 09-30）。故末尾用列表的最新披露点补齐，
 *   两个来源都是建行同一产品的官方披露，取更晚的那个。
 *
 * 净值口径（项目规则 2026-10-21 立）：只取 09 单位净值（固收产品口径）。
 *          09 整段恒 1 ＝现金管理类净值归一 → 判定为现金类，直接 return null 排除，
 *          不再退 10/15 口径、不再做万份收益复利合成（ccbCompound 已按规则删除）。
 *          09 完全无披露的少数产品退 10 累计净值（固收兜底，与现金类无关）。
 * ========================================================================== */

/* 双 host 互备（2026-10-18）：wealth.ccb.com 与 tool3.ccb.cn 是同一个
 * WCCMainPlatV5 网关的两个前端（实测 detail.html 101301 字节、detail.js 16767 字节
 * 完全一致；NLC165/NLC164/txt/NLCQ11 四类请求两者均返回相同数据）。切换只在握手
 * （NLC165）层做：happy path 仍只发 1 次握手，不增加抓净值耗时；仅当首选 host
 * 网关级失败（连接失败/超时/回「交易失败」HTML）时才切备用 host 重试一次。
 * ccbHostIdx 是进程内「上次成功的 host」记忆，正常时零额外请求。
 * ⚠ 一次抓取内必须锁定同一 host：NLC164 依赖 NLC165 下发的会话 Cookie，
 *   Cookie 按域名隔离，跨 host 不通用；故 host 由握手结果决定后全程透传。 */
// ⚠ 主备顺序（2026-10-18 修订）：wealth 首选、tool3 备选。tool3.ccb.cn 的 TLS 要求
//   「旧式不安全重协商」（SSL_OP_LEGACY_SERVER_CONNECT），Node 默认 fetch 栈
//   （undici/OpenSSL 3）直接拒连（实测 ERR_SSL_UNSAFE_LEGACY_RENEGOTIATION_DISABLED），
//   Cloudflare 出网栈是否支持未经证实；wealth.ccb.com 默认栈即可连（实测）。
//   故把默认栈确定可用的 wealth 放首选，tool3 只当真备份——避免 tool3 首选时
//   每次抓取（或每个 isolate 首次）白付一次失败的 TLS 握手。
const CCB_HOSTS = ["https://wealth.ccb.com", "https://tool3.ccb.cn"];
let ccbHostIdx = 0;
const ccbTran = (host) => host + "/tran/WCCMainPlatV5?CCB_IBSVersion=V5&SERVLET_NAME=WCCMainPlatV5";
const ccbRefOf = (host) => host + "/cn/finance/products/net_value/list.html";
// 兜底 Referer；实际请求会按 URL 的 origin 动态推导，双 host 自动跟随
const CCB_REF = ccbRefOf(CCB_HOSTS[0]);
const CCB_TIMEOUT_MS = 20000;
// Txn_Mkt_ID 全量取值（2026-10 实测 16 种；FndCo_Agnc_Sale_InsID 恒为 005）
const CCB_TXN_IDS = ["0JH", "0BK", "0Y05", "0MS", "0EW", "0YZX", "0Y4", "0ZY1",
  "066", "0Y88", "0LNY", "0PWM", "0PAWM", "0Y3", "0Y04"];
// NLC164 的 TmDt（查询截止日）：取北京时间次日。TmDt 只是上界，取后一天可保证
// 覆盖「当天已披露、但本地时区还差一天」的情形（实测美西下午调用时北京已是次日）。
const CCB_TODAY = (() => {
  const d = new Date(Date.now() + (8 + 24) * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
})();

/* 带 Cookie 透传的 GET：NLC164（历史净值）必须带 NLC165 下发的会话 Cookie 才放行。
 * 免登录——只是要先「握手」一次（NLC165 响应 Set-Cookie 5 个，原样带回即可）。
 * 返回 { json, cookieHeader }，后者供后续请求复用。 */
async function ccbGetRaw(url, transport, cookieHeader) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CCB_TIMEOUT_MS);
  // Referer 按请求 URL 的 origin 推导：双 host 切换时自动跟随，无需调用方传 host
  let ref = CCB_REF;
  try { ref = new URL(url).origin + "/cn/finance/products/net_value/list.html"; } catch (e) { /* 用兜底 */ }
  const headers = { "User-Agent": UA, Referer: ref, Accept: "application/json, text/plain, */*" };
  if (cookieHeader) headers.Cookie = cookieHeader;
  try {
    const res = await (transport || fetch)(url, { headers, signal: ctrl.signal });
    // 上游失败会回 HTML「交易失败…请重新登录」；成功时响应体开头带 CRLF，必须先 trim
    // （实测首两字节是 \r\n，不 trim 会把正常 JSON 误判成错误页）
    const txt = (await res.text()).trim();
    let json = null;
    if (txt && (txt[0] === "{" || txt[0] === "[")) {
      try { json = JSON.parse(txt); } catch (e) { json = null; }
    }
    let ck = "";
    try {
      const sc = (res.headers && res.headers.getSetCookie) ? res.headers.getSetCookie() : [];
      ck = sc.map((s) => String(s).split(";")[0].trim()).filter(Boolean).join("; ");
    } catch (e) { /* 老 transport 无 getSetCookie → 退化到不带 Cookie */ }
    return { json, cookieHeader: ck };
  } catch (e) {
    return { json: null, cookieHeader: "" };
  } finally {
    clearTimeout(timer);
  }
}

async function ccbGetJson(url, transport, cookieHeader) {
  const r = await ccbGetRaw(url, transport, cookieHeader);
  return r.json;
}

/* NLC165 目录查询 + 捕获会话 Cookie（后者是 NLC164 历史净值接口的敲门砖）
 * host：本次抓取锁定的网关前端。返回值 ok=true 仅代表「网关正常应答」；
 * ok=true 且 item=null 才是「该码不属于建行体系」（应直接放弃，不换 host 重试）；
 * ok=false 是网关级失败（连接失败/超时/错误页），调用方应换备用 host 重试。 */
async function ccbBootstrap(code, transport, host) {
  const url = ccbTran(host) +
    "&TXCODE=NLC165&Rs_MtdCd=1&REC_IN_PAGE=200&PAGE_JUMP=1&IvsmPd_ECD=" + encodeURIComponent(code);
  const { json: j, cookieHeader } = await ccbGetRaw(url, transport);
  if (!j || j.SUCCESS !== "true") return { item: null, cookieHeader, ok: false };
  const list = j.PROD_MARKET_LIST || [];
  const up = String(code).toUpperCase();
  return { item: list.find((x) => String(x.IvsmPd_ECD) === up) || list[0] || null, cookieHeader, ok: true };
}

// 双 host 互备的握手：优先上次成功的 host；happy path 只发 1 次请求（与改造前相同）。
// 返回 { host, boot }；全部 host 网关级失败时 boot.ok=false、item=null。
async function ccbBootstrapAny(code, transport) {
  let last = null;
  for (let i = 0; i < CCB_HOSTS.length; i++) {
    const host = CCB_HOSTS[(ccbHostIdx + i) % CCB_HOSTS.length];
    const r = await ccbBootstrap(code, transport, host);
    if (r.ok) {
      if (i !== 0) ccbHostIdx = CCB_HOSTS.indexOf(host); // 切换成功后记住新 host，后续请求优先
      return { host, boot: r };
    }
    last = r;
  }
  return { host: CCB_HOSTS[ccbHostIdx], boot: last || { item: null, cookieHeader: "", ok: false } };
}

// 取某一 Ctrl_Ind_Cgy 的历史序列 → [[YYYY-MM-DD, 值]]（host 与本次抓取握手锁定的一致）
async function ccbNavTxt(code, txn, ins, cgy, transport, host) {
  const fn = String(code) + txn + ins + "40" + cgy;
  const j = await ccbGetJson(host + "/newsinfo/finance/" + fn + ".txt", transport);
  const g = (j && j.Index_Group) || [];
  if (!Array.isArray(g) || !g.length) return [];
  const key = Object.keys(g[0]).find((k) => k !== "Qtn_Dt");
  if (!key) return [];
  const out = [];
  for (const it of g) {
    const dt = String(it.Qtn_Dt || "");
    if (!/^\d{8}$/.test(dt)) continue;
    const v = parseFloat(it[key]);
    if (!Number.isFinite(v) || v <= 0) continue;
    out.push([dt.slice(0, 4) + "-" + dt.slice(4, 6) + "-" + dt.slice(6, 8), v]);
  }
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return out;
}

/* ==========================================================================
 * NLCQ11 产品详情（建行 App 理财详情页同款数据源 · 2026-10-18 逆向打通）
 *
 * 来源：mobilev3 H5（m1.ccb.com/cn/finance/mobilev3/products/self/product_detail.html，
 *   搜索引擎收录、公开可访问）→ js/product_detail.js → js/component.js 里的购买流
 *   TXCODE；同接口在公网 wealth.ccb.com/tran/WCCMainPlatV5 上免登录可直接调。
 *   ⚠ 与 App 原生端口（ibsbjstar.ccb.com.cn/CCBIS/B2CMainPlat，TXCODE 家族完全不同）
 *   是两套网关——PCAPdroid 抓包看到的 App 流量主走后者，但其接口需登录态；
 *   NLCQ11 是「App 详情页 WebView 实际拉数的公开同款」，故以此替代。
 *
 * 关键参数口径（都实测过）：
 *   Sel_StCd=1 是「存续/已成立」口径——传 0 对已成立产品回 0 条（165期实测：0→0条/1→1条）。
 *
 * 覆盖边界（best-effort 语义，必须接受）：
 *   只回「当前在售/存续目录内」产品。实测 165期有数据；14A（老期数）、恒赢按日、
 *   惠众系列、天天利法人版均回 0 条（与 App 产品超市行为一致——超市里根本没有它们）。
 *   回 0 条时调用方按「没有详情」处理，净值主链路不受影响。
 *
 * 字段与 App 详情页的对应（165期实测值）：
 *   Rsk_Grd_Cd       02 → 风险等级 R2
 *   PfCmpBss         业绩比较基准（Exg_Pft_Cmnt 同值兜底）
 *   SplLmt           剩余可购额度（元）——App「额度不足1万」即此值 18.46<1万
 *   BnNm_Sz_UpLm_Val 总额度（元）——与 SplLmt 配合算已售比例
 *   Unit_Ast_NetVal + NetVal_Dt  最新净值——常比 NLC165 目录新一天（目录10-17/详情10-18）
 *   Inpt_SrtDt       产品成立日（与 App「产品成立日」一致：2026-08-27）
 *   CcyCd            ISO 4217 数字币种码（156=CNY）
 *   Co_Nm / LCS_Cd / StTm / EdTm  发行机构全称 / 申赎频率 / 交易时间（备用，暂不消费）
 *
 * 额度口径来自 product_public.js 的 saledRatio（逆向自 mobilev3 H5）：
 *   SplLmt 为空                → 无额度字段（不显示）
 *   SplLmt = 99999999999999999.99 → 不限额度（有可买=available）
 *   SplLmt <= 0                → 已售罄（sold_out）
 *   否则                        → 已售比例 (1 - SplLmt/BnNm_Sz_UpLm_Val)*100
 * ==========================================================================*/
async function ccbDetail(code, mkt, transport, host, cookieHeader) {
  if (!mkt) return null;
  const url = ccbTran(host) +
    "&isAjaxRequest=true&TXCODE=NLCQ11&Fcn_Cd=0&REC_IN_PAGE=1&PAGE_JUMP=1" +
    "&IvsmPd_ECD=" + encodeURIComponent(code) +
    "&Sel_StCd=1&Txn_BO_ID=110000000&Chnl_ID=10060009" +
    "&Txn_Mkt_ID=" + encodeURIComponent(mkt) +
    "&FndCo_Agnc_Sale_InsID=005&Crt_Chnl_ID=9999999999" +
    "&PD_Sl_Obj_Cd=01&Bkstg_PD_Tp_ECD=01";
  // 免登录、无需 Cookie；带上握手 Cookie 只是防御（同域名，无害）
  const j = await ccbGetJson(url, transport, cookieHeader);
  if (!j || j.SUCCESS !== "true") return null;
  const g = j.PROD_INFO_GRP || [];
  if (!Array.isArray(g) || !g.length) return null;
  return g.find((x) => String(x.IvsmPd_ECD) === String(code)) || g[0] || null;
}

// 风险等级码 → R1~R5（建行 Rsk_Grd_Cd：01=低 02=中低 03=中 04=中高 05=高）。
// ⚠ 实测是两位零填充字符串（"02" 不是 "2"），正则必须容忍前导零。
function ccbRiskOf(det) {
  const m = String((det && det.Rsk_Grd_Cd) || "").match(/^0*([1-5])$/);
  return m ? "R" + m[1] : null;
}

// YYYYMMDD → YYYY-MM-DD（非法输入回 null）
function ccbYmd(s) {
  const t = String(s == null ? "" : s);
  return /^\d{8}$/.test(t) ? t.slice(0, 4) + "-" + t.slice(4, 6) + "-" + t.slice(6, 8) : null;
}

// ISO 4217 数字币种码 → 字母码（复用邮储的通用映射表；未知回落 null，
// 前端 fmtQuota 默认按「元」显示，对人民币产品即正确）
function ccbCurrency(code) {
  return psbcCurrency(code);
}

/* NLCQ11 详情 → 额度字段（与平安/邮储/中行同款形状，供 fetchProductFull 第4步与
 * 前端 MULTI_REAL 持久化结构直接消费）。无额度信息返回 null。 */
function ccbQuotaFields(det) {
  if (!det) return null;
  const raw = det.SplLmt;
  if (raw == null || raw === "") return null; // 未披露额度字段
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const currency = ccbCurrency(det.CcyCd);
  // 不限额度哨兵值（建行用 99999999999999999.99 表示无上限）→ 只标「有额度」
  if (n >= 9e14) {
    return { remainQuota: null, remainQuotaPct: null, quotaState: "available", saleStatus: null, currency, quotaText: null };
  }
  // 剩余比例 0~1（与平安 remainQuotaPct 同口径）；总额度缺失/为 0 时不算比例
  const up = Number(det.BnNm_Sz_UpLm_Val);
  const pct = (Number.isFinite(up) && up > 0 && n > 0) ? Math.min(1, n / up) : null;
  return {
    remainQuota: n > 0 ? n : 0, // 负值（异常数据）按 0 处理
    remainQuotaPct: pct,
    quotaState: n > 0 ? "available" : "sold_out",
    saleStatus: null,
    currency,
    quotaText: null,
  };
}

/* 最新净值取「更晚的一源」：NLCQ11 详情的 NetVal_Dt 常比 NLC165 目录的 Valt_Dt
 * 新一天（165期实测：目录 10-17 → 详情 10-18）。两者都是建行官方披露，取新即可。 */
function ccbLatestNav(it, det) {
  let dt = null, v = null;
  const vd = it && String(it.Valt_Dt || "");
  if (/^\d{8}$/.test(vd)) {
    const n = parseFloat(it.Unit_Ast_NetVal);
    if (Number.isFinite(n) && n > 0) { dt = ccbYmd(vd); v = n; }
  }
  const nd = det && String(det.NetVal_Dt || "");
  if (/^\d{8}$/.test(nd)) {
    const n2 = parseFloat(det.Unit_Ast_NetVal);
    if (Number.isFinite(n2) && n2 > 0 && (!dt || ccbYmd(nd) > dt)) { dt = ccbYmd(nd); v = n2; }
  }
  return dt ? { date: dt, value: Number(v.toFixed(8)) } : null;
}

/* NLC164 历史净值 —— 建行 App 理财详情页（wealth.ccb.com/…/net_value/detail.html）
 * 同款接口，免登录，翻页拉全量。2026-10-18 实测打通。
 *
 * 为什么用它替代静态 txt 做主路径：
 *   /newsinfo/finance/*.txt 是定期再生的静态文件，实测可滞后达 2 个月
 *   （样例末点 07-22，而目录 Unit_Ast_NetVal 已披露到 09-30）；NLC164 是实时接口，
 *   更新到披露日当天，且不需要猜文件名（不再有 3 口径 × 15 市场ID 的盲试开销）。
 *
 * ⚠ 两个坑（都实测踩过）：
 *   ① 单页上限 REC_IN_PAGE=400，传 500 会被网关拒成「交易失败」HTML；
 *   ② 必须带 ccbBootstrap 捕获的会话 Cookie，否则同样回「交易失败」HTML。
 *   长历史产品（如恒赢按日 2987 点）需翻 8 页；响应按日期倒序，这里按日期升序返回。
 */
const CCB_NAV_PAGE = 400;
const CCB_NAV_MAX_PAGES = 25; // 上限 1 万点，足够覆盖任何理财产品的全历史
async function ccbNavSeries(code, mkt, ins, cgy, cookieHeader, transport, stopIf, host, since) {
  if (!mkt || !ins) return { rows: [], ok: false };
  const seen = new Set();
  const out = [];
  let ok = false; // 首页是否成功返回数据（增量腿据此区分「无新增点」与「抓不到」）
  for (let page = 1; page <= CCB_NAV_MAX_PAGES; page++) {
    const url = ccbTran(host) +
      "&TXCODE=NLC164&IvsmPd_ECD=" + encodeURIComponent(code) +
      "&Txn_Mkt_ID=" + encodeURIComponent(mkt) +
      "&FndCo_Agnc_Sale_InsID=" + encodeURIComponent(ins) +
      "&PD_Grp_ECD=40&Ctrl_Ind_Cgy=" + cgy +
      "&SrtDt=19900101&TmDt=" + CCB_TODAY +
      "&REC_IN_PAGE=" + CCB_NAV_PAGE + "&PAGE_JUMP=" + page;
    const j = await ccbGetJson(url, transport, cookieHeader);
    if (!j || j.SUCCESS !== "true") break;
    const total = Number(j.TOTAL_REC) || 0;
    const g = j.Index_Group || [];
    if (page === 1 && g.length) ok = true;
    let oldest = "";
    for (const row of g) {
      const dt = String(row.Qtn_Dt || "");
      if (!/^\d{8}$/.test(dt) || seen.has(dt)) continue;
      const v = parseFloat(row.Exp_YldRto);
      if (!Number.isFinite(v) || v <= 0) continue;
      const iso = dt.slice(0, 4) + "-" + dt.slice(4, 6) + "-" + dt.slice(6, 8);
      seen.add(dt);
      if (!oldest || iso < oldest) oldest = iso;
      // 2026-10-30 增量：只保留 since 之后的（缺失/新增）点
      if (since && !(iso > since)) continue;
      out.push([iso, v]);
    }
    // 2026-10-30 增量：响应按日期倒序（page 1 最新、每页 400 点）→ 页内最旧点已 <= since
    //   即说明后面的页只会更旧 → 提前停翻页（日常刷新通常 page 1 即止，省掉后续 7 页）。
    if (since && oldest && oldest <= since) break;
    // 调用方判定可提前收手（已收集的片段仍返回）：用于「整页都≈1」时不再白翻后续页
    if (stopIf && stopIf(out)) break;
    if (g.length < CCB_NAV_PAGE || (total && out.length >= total)) break;
  }
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { rows: out, ok };
}

const CCB_CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const ccbNum = (s) => CCB_CN_NUM[s] || Number(s) || 0;

// 从产品名猜持有期天数（建行接口无该字段）。
// ⚠ 数字必须限长度：产品名里的「封闭式2023年31期」会被 /(\d+)年/ 吃成年数 → 738395 天（实测踩过），
//   故年/月只认 1~2 位数字或中文数字。
function ccbHoldDays(name) {
  const t = String(name || "");
  if (/按日开放|日开|每日开放|天天开|现金管理|活期/.test(t)) return 1;
  // 前置 (?:^|\D) 是必须的：否则「2023年」会被拆出「23年」→ 8395 天
  const d = t.match(/(?:^|\D)(\d{1,4})\s*天/);
  if (d) return Number(d[1]);
  const mo = t.match(/(?:^|\D)([一二三四五六七八九十两]|\d{1,2})\s*个?月/);
  if (mo) return ccbNum(mo[1]) * 30;
  const y = t.match(/(?:^|\D)([一二三四五六七八九十两]|\d{1,2})\s*年/);
  if (y) return ccbNum(y[1]) * 365;
  return null;
}

export async function ccbFetch(code, opts = {}) {
  const transport = opts.transport;
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  // 2026-10-22 修复：nav/quota 模式跳过产品详情 NLCQ11（仅信息字段，非净值主链路，避免分解杂项）。
  const __navMode = opts.mode === "nav";
  const __quotaMode = opts.mode === "quota";
  const __infoMode = opts.mode === "info";
  // 【2026-10-23 用户规则】刷信息只刷信息、刷额度只刷额度——两者都不抓净值。
  // 建行的净值走 NLC164 实时接口 + 静态披露 txt（含翻页，是耗时大头）；信息与额度同在
  // NLCQ11 详情接口。故 info/quota 保留 NLCQ11、跳过全部净值口径抓取。
  const __noNav = __infoMode || __quotaMode;

  // 2026-10-31 用户规则：建设银行净值优先从发行方建信理财官网（www.wealthccb.com）抓——
  // 建信理财出净值最快（T+0 当日上午/中午/下午/晚上多次披露，非 T+0 当晚23点出当日净值），
  // 均快于建设银行自身端口（wealth.ccb.com / tool3.ccb.cn / finance.txt 静态披露，次日晨出昨日净值）。
  // 故 NAV 先问建信理财，命中有效序列即用；否则回落建设银行自身端口（下方 it 分支）。
  // 建信理财有 IP 级 WAF：被封/无此产品时 ccbwmFetch 返回 null（首封后进程内 5 分钟记忆，瞬时回落），不丢数据。
  // ⚠ 建行货架也卖**别家理财子**的产品（中邮/农银/兴银…）：那些产品的净值归其发行行官网管，
  //   建信理财官网必然查无此产品 → 白跑一次还多一次 WAF 叩门。故发行行明确不是建信系时跳过官网腿。
  const __mgrKey = opts.manager ? managerToBankKey(opts.manager) : "";
  const __ccbwmAllowed = !__mgrKey || __mgrKey === "ccb";
  let wm = null, __wmCalled = false;
  if (!__noNav && __ccbwmAllowed) {
    __wmCalled = true;
    wm = await ccbwmFetch(c, { ...opts, mode: "nav" }).catch(() => null);
    if (wm && wm._excludedCash) {
      return { _excludedCash: true, code: c, name: wm.name, bank: "ccb", source: "live-ccbwm" };
    }
  }
  const wmHasNav = !!(wm && Array.isArray(wm.series) && wm.series.some((p) => Math.abs(p[1] - 1) > 1e-9));
  const wmInfo = (wm && !wm._excludedCash) ? wm : null;

  // 双 host 互备握手：happy path 只发 1 次 NLC165（与改造前完全相同，不增加耗时）；
  // 仅当首选 host 网关级失败（连接失败/超时/错误页）才切备用 host 重试一次。
  // host 一经锁定全程透传——NLC164 要用的会话 Cookie 按域名隔离，不能跨 host。
  const { host, boot } = await ccbBootstrapAny(c, transport);
  const it = boot.item;
  // 2026-10-16/25：目录 NLC165 按码精确查零命中 = 该码不在建行货架（多为他行渠道专属份额码）。
  // 建信理财官网（wealthccb.com）收录建信全部产品，故：
  //   · nav 模式：官网腿已在上面问过（wm）→ 有有效序列就用它（无建行额度/权威信息，但 NAV 已最新）；
  //   · info/quota 模式或非建信系发行行：官网腿此刻才问（官网腿 info/quota 不抓净值，成本低）；
  //   · 都没有 → 返回 null，与改造前行为完全一致。
  if (!it) {
    if (!__wmCalled && __ccbwmAllowed) {
      __wmCalled = true;
      wm = await ccbwmFetch(c, opts).catch(() => null);
      if (wm && wm._excludedCash) return wm;
    }
    if (wm) {
      return { ...wm, navVia: wm.navVia || "ccbwm", navPort: wm.navPort || "ccbwm" };
    }
    return null;
  }

  const ins = (it && it.FndCo_Agnc_Sale_InsID) || "005";
  const txns = (it && it.Txn_Mkt_ID) ? [String(it.Txn_Mkt_ID)] : Array.from(new Set(CCB_TXN_IDS));

  // NLCQ11 产品详情（App 详情页同款）：与历史净值【并发】发起，把它的 ~0.8s 耗时
  // 藏进 NLC164 翻页时间里（happy path 不增加总耗时，A/B 计时已验证）。
  // 只在目录给了确定市场ID时可查；失败/不在当前在售目录 → null，不影响净值主链路。
  // 2026-10-23 修复：quota 模式**必须**查 NLCQ11——它是建行唯一的额度来源
  // （ccbQuotaFields 读 det 的额度字段）。原条件多写了 `&& !__quotaMode`，
  // 导致刷额度时 NLCQ11 被跳过 → 额度恒空且仍白抓 NLC164 净值（用户 2026-10-23 审计发现）。
  const detP = (it && it.Txn_Mkt_ID && !__navMode)
    ? ccbDetail(c, String(it.Txn_Mkt_ID), transport, host, boot.cookieHeader).catch(() => null)
    : Promise.resolve(null);

  // 「有意义」＝序列存在且不全为 1（固收产品的单位净值必然偏离 1）。
  // 【项目规则 2026-10-21 立】只收录有净值的固收产品：09 单位净值整段恒 1
  // ＝现金管理类净值归一 → 直接返回 null 排除。历史上的「退 10 累计净值 /
  // 15 万份收益复利合成（kind:"wan"）」现金类处理已全部删除，勿再 reintroduce。
  const meaningful = (s) => s.length > 0 && s.some((p) => Math.abs(p[1] - 1) > 1e-9);
  // 现金管理类单位净值整段归一为 1：响应按日期倒序，第一页就是最新 400 点。
  // 若整页都≈1，说明该口径画出来是直线 → 立刻收手，不必白翻后续 7 页全 1 数据。
  const earlyStop = (acc) => acc.length >= CCB_NAV_PAGE && !meaningful(acc);
  // 2026-10-30 增量：since = 本地已有序列的最后净值日（刷新时前端透传；添加产品无 → 全量）。
  const since = opts.since || null;
  // NLC164 接口是否成功返回过数据：增量腿据此区分「无新增点(=已是最新)」与「抓不到(=该走兜底)」
  let __apiOk = false;
  // 每个口径两条路：
  //   ① NLC164 实时接口（建行 App 详情页同款，带 Cookie 免登录）——主路径；
  //   ② 静态披露 txt（定期再生、可滞后 2 个月）——仅当 NLC164 拿不到时兜底。
  const viaApi = async (cgy) => {
    const r = await ccbNavSeries(c, txns[0], ins, cgy, boot.cookieHeader, transport, earlyStop, host, since);
    if (r.ok) __apiOk = true;
    // 触到翻页上限说明可能还有更多点 → 视为不完整，交给 txt 兜底
    if (r.rows.length >= CCB_NAV_MAX_PAGES * CCB_NAV_PAGE) return [];
    return r.rows;
  };
  const viaTxt = async (cgy) => {
    // 列表已给出确定的 Txn_Mkt_ID → 单次请求；否则并行试全量市场ID，取最长的一条
    if (it) return ccbNavTxt(c, txns[0], ins, cgy, transport, host);
    const all = await Promise.all(txns.map((t) => ccbNavTxt(c, t, ins, cgy, transport, host)));
    let best = [];
    for (const s of all) if (s.length > best.length) best = s;
    return best;
  };
  const caliber = async (cgy) => {
    const s = await viaApi(cgy);
    if (s.length) return s;
    // 2026-10-30 增量：接口跑通但本轮无新增点 → 不回落静态 txt（那是全量历史，抵消增量收益）
    if (since && __apiOk) return s;
    return viaTxt(cgy);
  };

  let series = [];
  let calUsed = "09"; // series 实际来自哪个口径（末尾补最新点时用：累计净值口径不能补单位净值点）
  let navVia = "ccb", navPort = "ccb", navIncrementalFlag = !!since;
  // 【2026-10-23 用户规则】info/quota 不抓净值——NLC164 翻页与静态 txt 全部跳过。
  if (!__noNav) {
    if (wmHasNav) {
      // 建信理财已给最新序列 → 建设银行自身端口仅作信息/额度源，不再重翻 NAV 全量（保留增量收益）
      series = wm.series; calUsed = "09";
      navVia = "ccbwm"; navPort = "ccbwm"; navIncrementalFlag = !!wm.navIncremental;
    } else {
      const s09 = await caliber("09");
      if (meaningful(s09)) {
        series = s09; // 固收产品正常路径：单位净值
      } else if (s09.length) {
        // 有点但整段恒 1 ＝现金管理类（单位净值归一）→ 项目规则：现金管理类不抓
        return null;
      } else if (since && __apiOk) {
        // 2026-10-30 增量：接口跑通但本轮无新披露点 → 不再试 10 口径（那也要翻全量页）
      } else {
        // 09 完全无披露的少数产品：退 10 累计净值（固收兜底；现金类在上一步已排除）
        const s10 = await caliber("10");
        if (meaningful(s10)) { series = s10; calUsed = "10"; }
      }
    }
  }
  // NLCQ11 详情结果（并发已在跑，到这里通常已完成；未完成也只需再等余下时间）
  const det = await detP;
  const quotaFields = ccbQuotaFields(det); // { remainQuota, remainQuotaPct, quotaState, saleStatus, currency, quotaText } | null
  const risk = ccbRiskOf(det);             // "R2" | null
  const benchmark = det ? (det.PfCmpBss || det.Exg_Pft_Cmnt || null) : null;
  const latest = ccbLatestNav(it, det);    // 更晚一源的最新净值 { date, value } | null
  // 成立日：NLCQ11 的 Inpt_SrtDt 是【真字段】（与 App「产品成立日」一致），按用户规则
  // 「成立日期不得以净值系列判断，除非抓不到成立日期」优先采用；拿不到才退序列首点。
  const estReal = ccbYmd(det && det.Inpt_SrtDt);

  if (!series.length) {
    // 目录里查得到、但没有净值披露文件（新发产品 / 该份额暂未披露历史净值）→
    // 不编造净值，只把真实的名称、管理人带回去，前端按 infoOnly 填表（与浦发同一处理）。
    return {
      name: it.Fnd_Nm || (wmInfo ? wmInfo.name : null),
      manager: it.Inst_Nm ? (inferManager(it.Inst_Nm) || it.Inst_Nm) : (wmInfo ? "建信理财" : null),
      established: estReal || (wmInfo ? wmInfo.established : null) || null,
      establishedFromSeries: !estReal && !(wmInfo && wmInfo.established),
      series: [],
      kind: "nav",
      ...(quotaFields || {}),
      risk: risk || (wmInfo ? wmInfo.risk : null),
      benchmark: benchmark || (wmInfo ? wmInfo.benchmark : null),
      holdDays: ccbHoldDays(it.Fnd_Nm),
      regCode: null,
      source: "live",
      bank: "ccb",
      navLatest: latest ? latest.value : null,
      navLatestDate: latest ? latest.date : null,
      // 2026-10-30 增量：本轮无新增点（=已是最新）是有效结果，不是「没抓到」
      navIncremental: !!(since && __apiOk),
      infoOnly: true,
    };
  }

  // 列表/详情披露的最新单位净值比历史序列还新 → 补到末尾（两者都是建行官方披露）。
  // ⚠ 只在 09 单位净值口径下补：给累计净值(10)序列补一个单位净值点会把曲线砸下去；
  //   现金管理类已在上面「整段恒 1」处排除，不存在「补 1.0 到万份收益复利曲线」的问题
  //   （该复利合成逻辑已按项目规则删除）。
  if (calUsed === "09" && latest && latest.date > series[series.length - 1][0]) {
    series = series.concat([[latest.date, latest.value]]);
  }

  const ded = [];
  for (const r of series) {
    if (ded.length && ded[ded.length - 1][0] === r[0]) ded[ded.length - 1] = r;
    else ded.push(r);
  }
  const name = (it && it.Fnd_Nm) || (wmInfo ? wmInfo.name : null);
  const manager = (it && it.Inst_Nm) ? (inferManager(it.Inst_Nm) || it.Inst_Nm) : (wmInfo ? "建信理财" : null);
  return {
    name,
    manager,
    established: estReal || ded[0][0],
    establishedFromSeries: !estReal, // 建行目录无成立日字段；NLCQ11 详情补上后为真字段口径
    series: ded,
    kind: "nav", // 现金管理类已排除，走到这里的都是单位净值型固收产品
    ...(quotaFields || {}),
    risk: risk || (wmInfo ? wmInfo.risk : null),
    benchmark: benchmark || (wmInfo ? wmInfo.benchmark : null),
    holdDays: ccbHoldDays(name),
    regCode: null,
    source: "live",
    bank: "ccb",
    navVia, navPort,
    navIncremental: navIncrementalFlag,
  };
}

/* ==========================================================================
 * 建信理财官网端口（www.wealthccb.com · 发行方官网 · 2026-10-25 写入，待国内 IP 实测）
 *
 * 为什么需要它：ccb 网关（wealth.ccb.com/tran/WCCMainPlatV5）只收录「建行货架」产品；
 *   发行方建信理财的部分产品不在货架上——尤其他行渠道专属份额码（网商银行代销的
 *   JXJXZDCY300722006 实证：NLC165 目录 0 命中、15 市场ID × 双接口全矩阵查无）。
 *   发行方官网收录建信全部产品（含各渠道份额），且【当天上午即披露当天净值】
 *   （T+0，周末同——2026-10-25 周日 13:50 用户手机 IP 实证已见 10-25 净值 1.051056），
 *   比中国理财网（T+1）快一天。
 *
 * 端口形态（2026-10-23 读 JS bundle 逆向 + 10-25 实证）：
 *   Vue hash 路由 SPA，接口前缀 /website/v1/api/，免登录免签名，GET 明文 JSON，
 *   id 参数即产品代码（ecd）：
 *     GET product/detail?id=  名称/登记编码 pdCd/最新净值 netVal@netValDt/风险 riskLevel/
 *                            成立日 srtdt/期限 trm/现金判据 opnTpcd+lblId/业绩基准
 *     GET product/chart?id=   全量净值曲线（一次返回；JXJXZDCY14061612A 实测 416 点）
 *     GET product/netVal?id=&page=&pageSize=  分页净值史（drivDt/netVal/acNetVal/…）
 *   现金类判据：opnTpcd=="0" → 万份收益/七日年化口径；lblId 0/2 → 七日年化展示；
 *   净值型 = opnTpcd 1-5 且 lblId=="1"（项目铁律：现金管理类一律不抓）。
 *
 * ⚠ IP 级瑞数 WAF（纯黑名单、无 JS 挑战）：国内住宅/手机 IP 可达；被封时全域名
 *   （含 API）返回「访问拦截」HTML。纪律：全局 ≤2 req/s 慢爬；见拦截页立即停手不重试
 *   （重试只会延长封禁）；进程内 5 分钟封锁记忆。本机（加拿大出口）当前即在封禁中，
 *   故本端口【未经 live 实测】，两处按「未实测」标准处理：
 *     · chart 响应字段名未留存 → 解析用字段无关的通用遍历（wmExtractSeries：对象行/
 *       二元组两种形态），netVal 分页（字段名已确认）作兜底；
 *     · pdCd 的 14 位数字形态（官网展示的「建行产品编码」）按 2026-10-25 单例观测的
 *       规则转换（27000724000797 = 「2」+ 去 Z 登记编码 Z7000724000797），待复测确认普遍性。
 *
 * 接入点：ccbFetch 的 NLC165 目录零命中处（货架没有 → 问发行方要）。各模式均生效：
 *   nav/all 走 详情 + chart（+ netVal 兜底）；info/quota 只走详情（回信息、不抓净值）。
 *   被封/超时/官网无此产品 → null，与改造前行为完全一致。
 * ========================================================================== */
const CCBWM_HOST = "https://www.wealthccb.com";
const CCBWM_API = CCBWM_HOST + "/website/v1/api";
const CCBWM_REF = CCBWM_HOST + "/";
const CCBWM_TIMEOUT_MS = 20000;
// ≤2 req/s：全局串行闸门的最小请求间隔（留 30ms 余量防边界）
const CCBWM_MIN_INTERVAL_MS = 530;
// 见拦截页后的进程内封锁记忆时长：期间所有 ccbwm 请求直接放弃，避免持续叩门延长封禁
const CCBWM_BLOCK_TTL_MS = 5 * 60 * 1000;
// netVal 分页兜底：单页请求条数与页数上限（chart 解析失败时的第二路径）
const CCBWM_PAGE_SIZE = 200;
const CCBWM_MAX_PAGES = 60;

let __ccbwmBlockedUntil = 0;
// 进程内串行闸门：fetchProductFull 多产品并发（BR_CONC）时也保证全局 ≤2 req/s
let __ccbwmTail = Promise.resolve();
let __ccbwmLastAt = 0;
function ccbwmSlot() {
  const run = __ccbwmTail.then(async () => {
    const gap = Date.now() - __ccbwmLastAt;
    if (gap < CCBWM_MIN_INTERVAL_MS) await new Promise((r) => setTimeout(r, CCBWM_MIN_INTERVAL_MS - gap));
    __ccbwmLastAt = Date.now();
  });
  __ccbwmTail = run.catch(() => {});
  return run;
}

/* 字段名大小写不敏感取值（bundle 逆出的命名以 live 实测为准，这里留容错）。
 * 注意 0 是合法值（opnTpcd=0 表示现金类），不能用真值判断跳过。 */
function wmField(obj, names) {
  if (!obj || typeof obj !== "object") return null;
  for (const n of names) {
    const v = obj[n];
    if (v != null && v !== "") return v;
  }
  const lower = {};
  for (const k of Object.keys(obj)) lower[k.toLowerCase()] = obj[k];
  for (const n of names) {
    const v = lower[String(n).toLowerCase()];
    if (v != null && v !== "") return v;
  }
  return null;
}

/* 日期归一为 YYYY-MM-DD。兼容：2026-10-22 / 2026/10/22 / 2026.10.22 / 20261022 /
 * 10 位秒级或 13 位毫秒级时间戳（按北京时间取日历日——净值日是北京口径）。
 * ⚠ 小数字（trm=30 这类）不得当时间戳：仅 >1e9 才可能是秒级时间戳。 */
function wmNormDate(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number" || /^\d{10,13}$/.test(String(v).trim())) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 1e9 || n > 1e14) return null;
    const d = new Date((n > 1e12 ? n : n * 1000) + 8 * 3600 * 1000);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (m) return m[1] + "-" + String(m[2]).padStart(2, "0") + "-" + String(m[3]).padStart(2, "0");
  if (/^\d{8}$/.test(s)) return s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6, 8);
  return null;
}

/* pdCd → 信披平台登记编码。两种形态：
 *   Z+13 位（标准登记编码，可直接喂中国理财网双键查询）；
 *   14 位数字（官网展示的「建行产品编码」）——2026-10-25 实证一例：
 *   27000724000797 = 「2」+ 去 Z 登记编码（Z7000724000797），按此规则转换；
 *   普遍性待国内 IP 复测确认，转不出原样带回（下游名检索兜底不受影响）。 */
function wmRegCode(pdCd) {
  const s = String(pdCd == null ? "" : pdCd).trim().toUpperCase();
  if (!s) return null;
  if (/^Z[0-9A-Z]{12,}$/.test(s)) return s;
  if (/^2\d{13}$/.test(s)) return "Z" + s.slice(1);
  return s;
}

// 期限字段 → 天数（trm 可能是「30天」/「30」/「--」；名称里的持有期优先，见 ccbHoldDays）
function wmTrmDays(trm) {
  const s = String(trm == null ? "" : trm).trim();
  const m = s.match(/(\d{1,4})\s*天/);
  if (m) return Number(m[1]);
  if (/^\d{1,4}$/.test(s)) return Number(s);
  return null;
}

/* —— 通用曲线解析（chart 响应字段名未实测，故字段无关）——
 * 数值键偏好 netVal/nav 语义，排除 acNetVal(累计)/mktVal/bcostPrc(申购价)/
 * sellCostPrc(赎回价)/tenthPft/sdyAnulrtret(年化) 等非单位净值字段。 */
const WM_NAV_KEY_RE = /netval|net_value|unitnav|navvalue|\bnav\b/i;
const WM_SKIP_KEY_RE = /acnetval|accum|mktval|bcostprc|sellcostprc|tenthpft|anulrt|rate|pft|amt|price|prc|fee|ratio/i;

// 对象行 → [date, value]：行内第一个可解析日期 + nav 语义数值（兜底：第一个非排除正数）
function wmRowPoint(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const keys = Object.keys(row);
  let dt = null;
  for (const k of keys) { const d = wmNormDate(row[k]); if (d) { dt = d; break; } }
  if (!dt) return null;
  let val = null;
  for (const k of keys) {
    if (WM_SKIP_KEY_RE.test(k) || !WM_NAV_KEY_RE.test(k)) continue;
    const v = Number(row[k]);
    if (Number.isFinite(v) && v > 0) { val = v; break; }
  }
  if (val == null) {
    for (const k of keys) {
      if (WM_SKIP_KEY_RE.test(k)) continue;
      const v = Number(row[k]);
      if (Number.isFinite(v) && v > 0 && v < 1e6) { val = v; break; }
    }
  }
  return val != null ? [dt, Number(val.toFixed(8))] : null;
}

// 二元数组行 → [date, value]（ECharts 原生 [[x,y],…] / [[timestamp,val],…]）
function wmPairPoints(arr) {
  if (!Array.isArray(arr) || arr.length < 2) return null;
  const out = [];
  for (const el of arr) {
    if (!Array.isArray(el) || el.length < 2) return null;
    const d = wmNormDate(el[0]);
    const v = Number(el[1]);
    if (!d || !Number.isFinite(v) || v <= 0) return null;
    out.push([d, Number(v.toFixed(8))]);
  }
  return out;
}

// 递归整棵 JSON，取最长的一条曲线（对象行 / 二元组两种形态都认）
function wmExtractSeries(node, best) {
  if (Array.isArray(node)) {
    const pairs = wmPairPoints(node);
    if (pairs && pairs.length > (best ? best.length : 0)) best = pairs;
    if (node.length && node.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
      const pts = [];
      for (const row of node) { const p = wmRowPoint(row); if (p) pts.push(p); }
      if (pts.length >= 2 && pts.length > (best ? best.length : 0)) best = pts;
    }
    for (const el of node) if (el && typeof el === "object") best = wmExtractSeries(el, best);
  } else if (node && typeof node === "object") {
    for (const k of Object.keys(node)) best = wmExtractSeries(node[k], best);
  }
  return best;
}

// 按日期排序 + 同日去重（后写覆盖）
function wmSortDedup(rows) {
  const map = new Map();
  for (const p of rows) map.set(p[0], p[1]);
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/* 单次 GET：过闸门 → 请求 → 判定「访问拦截」。
 * 返回 { json, blocked }：blocked=true 表示 IP 级封禁（调用方立即收手，不重试）。 */
async function ccbwmGet(path, transport) {
  if (Date.now() < __ccbwmBlockedUntil) return { json: null, blocked: true };
  await ccbwmSlot();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CCBWM_TIMEOUT_MS);
  try {
    const res = await (transport || fetch)(CCBWM_API + path, {
      headers: { "User-Agent": UA, Referer: CCBWM_REF, Accept: "application/json, text/plain, */*" },
      signal: ctrl.signal,
    });
    const txt = (await res.text()).trim();
    // 瑞数拦截页是 200 + HTML（<!DOCTYPE html>…「访问拦截」）；403 同属封禁
    if (res.status === 403 || (txt && txt[0] === "<") || /访问拦截|人机识别|安全验证/.test(txt)) {
      __ccbwmBlockedUntil = Date.now() + CCBWM_BLOCK_TTL_MS;
      navLog("ccbwm " + path.slice(0, 40) + " -> 访问拦截（IP 封禁，5 分钟内不再叩门）");
      return { json: null, blocked: true };
    }
    if (!txt) return { json: null, blocked: false };
    try { return { json: JSON.parse(txt), blocked: false }; }
    catch (e) { return { json: null, blocked: false }; }
  } catch (e) {
    return { json: null, blocked: false };
  } finally { clearTimeout(timer); }
}

// 净值序列：chart 一次到位优先；解析不出 → netVal 分页兜底（字段名已确认）
async function ccbwmSeries(code, transport, since) {
  const ch = await ccbwmGet("/product/chart?id=" + encodeURIComponent(code), transport);
  if (ch.blocked) return { blocked: true, series: [], navIncremental: !!since };
  const fromChart = ch.json ? wmExtractSeries(ch.json, null) : null;
  if (fromChart && fromChart.length) {
    // chart 一次到位：增量模式按 since 只留新增点（无 since 则全量）
    let s = wmSortDedup(fromChart);
    if (since) s = s.filter((p) => p[0] > since);
    return { blocked: false, series: s, navIncremental: !!since };
  }
  // pageSize 是否被服务端裁剪以实测为准——按「短页即停」翻页，天然兼容 10 条/页的硬上限
  // 增量模式(since)：netVal 兜底分页走通用 early-stop（DESC/ASC 自动判定，只回 >since 新增点）
  if (since) {
    const getPage = async (pn) => {
      const nv = await ccbwmGet("/product/netVal?id=" + encodeURIComponent(code) +
        "&page=" + pn + "&pageSize=" + CCBWM_PAGE_SIZE, transport);
      if (nv.blocked) return { rows: [], totalPages: null, isLast: true, pageSize: CCBWM_PAGE_SIZE };
      const arr = nv.json ? (wmExtractSeries(nv.json, null) || []).map((p) => ({ date: p[0], value: p[1] })) : [];
      const totalPages = (nv.json && Number.isFinite(Number(nv.json.totalPages))) ? Number(nv.json.totalPages)
        : (nv.json && Number.isFinite(Number(nv.json.pages))) ? Number(nv.json.pages) : null;
      const isLast = arr.length < CCBWM_PAGE_SIZE;
      return { rows: arr, totalPages, isLast, pageSize: CCBWM_PAGE_SIZE };
    };
    const res = await incrementalNavPages(getPage, since);
    return { blocked: false, series: res.rows, navIncremental: true };
  }
  const acc = [];
  for (let page = 1; page <= CCBWM_MAX_PAGES; page++) {
    const nv = await ccbwmGet("/product/netVal?id=" + encodeURIComponent(code) +
      "&page=" + page + "&pageSize=" + CCBWM_PAGE_SIZE, transport);
    if (nv.blocked) break; // 已抓到的部分仍然有效
    const rows = nv.json ? wmExtractSeries(nv.json, null) : null;
    if (!rows || !rows.length) break;
    const before = acc.length;
    for (const p of rows) acc.push(p);
    if (acc.length - before < CCBWM_PAGE_SIZE) break; // 短页 = 末页
  }
  return { blocked: false, series: wmSortDedup(acc) };
}

export async function ccbwmFetch(code, opts = {}) {
  const transport = opts.transport;
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  const noNav = opts.mode === "info" || opts.mode === "quota";

  // ① 详情：信息 + 最新净值点 + 现金类判据（info/quota 模式到此为止，不抓净值）
  const d = await ccbwmGet("/product/detail?id=" + encodeURIComponent(c), transport);
  if (d.blocked) return null;
  const det = d.json
    ? ((d.json.data && typeof d.json.data === "object" && !Array.isArray(d.json.data)) ? d.json.data : d.json)
    : null;
  const name = det ? wmField(det, ["name", "prodName", "fndNm", "prodNm"]) : null;
  if (!name) return null; // 官网无此产品 / 响应异常 → 与改造前返回 null 一致
  const ecd = det ? wmField(det, ["ecd", "prodCode", "prodCodeId"]) : null;
  if (ecd && String(ecd).trim().toUpperCase() !== c) return null; // 响应与请求码不一致，不采用
  // 现金管理类判据（项目铁律：现金类一律不抓）
  const opnTpcd = det ? String(wmField(det, ["opnTpcd"]) ?? "") : "";
  const lblId = det ? String(wmField(det, ["lblId"]) ?? "") : "";
  if (opnTpcd === "0" || lblId === "0" || lblId === "2") {
    navLog("ccbwm code=" + c + " opnTpcd=" + opnTpcd + " lblId=" + lblId + " -> 现金管理类，按铁律不收录");
    return { _excludedCash: true, code: c, name, bank: "ccb", source: "live-ccbwm" };
  }
  const risk = det ? wmField(det, ["riskLevel", "riskLvl", "risk"]) : null;
  const benchmark = det ? wmField(det, ["fndPerfcmprbssAmt", "perfcmprbssAmt", "perfCmpBss", "benchmark"]) : null;
  const estReal = det ? wmNormDate(wmField(det, ["srtdt", "srtDt", "estabDate", "establishDate"])) : null;
  const trm = det ? wmField(det, ["trm", "term", "prodTerm"]) : null;

  const base = {
    name,
    manager: "建信理财",
    risk: risk != null ? String(risk) : null,
    benchmark: benchmark != null ? String(benchmark) : null,
    established: estReal,
    establishedFromSeries: !estReal,
    holdDays: ccbHoldDays(name) || wmTrmDays(trm),
    regCode: wmRegCode(det ? wmField(det, ["pdCd", "regCode", "prodRegCode"]) : null),
    kind: "nav",
    source: "live-ccbwm",
    bank: "ccb",
    navVia: "ccbwm",
    navPort: "ccbwm",
    navViaCode: c,
  };
  if (noNav) return { ...base, series: [], infoOnly: true };

  // ② 净值序列：chart 一次到位；解析不出 → netVal 分页兜底
  const s = await ccbwmSeries(c, transport, opts.since);
  let series = s.series;
  // 万份收益归一漏网（详情无 opnTpcd 字段时）→ 整段恒 1 仍按现金类排除
  if (series.length && series.every((p) => Math.abs(p[1] - 1) < 1e-4)) {
    return { _excludedCash: true, code: c, name, bank: "ccb", source: "live-ccbwm" };
  }
  // ③ 详情最新净值点比序列还新 → 补到末尾（官网同源；同日不覆盖，宁缺勿错）
  const lv = det ? Number(wmField(det, ["netVal", "unitNetVal", "unitNav"])) : NaN;
  const ld = det ? wmNormDate(wmField(det, ["netValDt", "netValueDate", "navDate", "drivDt"])) : null;
  if (Number.isFinite(lv) && lv > 0 && ld && (!series.length || ld > series[series.length - 1][0])) {
    series = series.concat([[ld, Number(lv.toFixed(8))]]);
  }
  const last = series.length ? series[series.length - 1] : null;
  navLog("ccbwm code=" + c + " -> series=" + series.length + (last ? (" 末点 " + last[0] + "@" + last[1]) : "") +
    (s.blocked ? "（分页中断）" : ""));
  return {
    ...base,
    // 增量模式(since)下 series 仅含新增点，series[0] 是最新而非成立日，不可据此推成立日
    established: estReal || (opts.since ? null : (series.length ? series[0][0] : null)),
    series,
    infoOnly: series.length < 2,
    navLatest: last ? last[1] : null,
    navLatestDate: last ? last[0] : null,
    navIncremental: !!s.navIncremental,
  };
}

/* ==========================================================================
 * 广发银行 App 端口（wap.cgbchina.com.cn · MDP/H5 网关，2026-10-16 打通，免登录）
 *
 * 背景：App / 微信分享的理财详情页
 *   /mdp/hmba/investment/self/detail?flowNo=<分享链>&shortCode=N 是 MDP 2.0 的 Vue SPA，
 *   HTML 只有壳，数据全由 XHR 取；移动/桌面 UA 都能开，**不需要微信授权**。
 *
 * 会话号：页面加载下发 cookie MDP_A_KEY / MDP_G_KEY，**MDP_A_KEY 就是网关要的 mpSId**
 *   （放进 body.header.mpSId；不带时网关一律回 HB1021「交易缺少会话ID」）。实测无需 flowNo，
 *   只要拿到 cookie 就能按产品代码查任意在售/代销产品。
 *
 * 网关：POST https://wap.cgbchina.com.cn/h5-mobilebank-app/noSessionServlet/hbss/<svc>.lgx
 *   报文 {header:{senderSN,os,bizScene,channel:"MB",scope:"2",mpSId}, body:{…}}，纯 JSON、免签名、免登录。
 *   必备头：Tcom-trxChanAppCode=O02HMBA / Tcom-trxTrgRoleCode=1 /
 *           Tcom-trxSrcSysCode=HMBA_WECHAT0000000000000 / Tcom-equipId=<任意串>。
 *
 * 服务：
 *   · mps005billquery.lgx  {shortCode, flowNo} → tradeData 竖线串（内含 prdCode，分享链 → 产品代码）
 *   · fn10025.lgx          {prdCode} → 产品全量 133 字段：prdName / riskLevel / sharedetailMinHold /
 *                          estabDate / perforMark(业绩基准) / nAV+nAVDate / investmentCycleDesc /
 *                          prdManagerName / endDate / shareClass
 *   · fn10003.lgx          {prdCode, beginNum, fetchNum, beginDate, endDate} → 净值分页，
 *                          totalNum=总点数，list[{nAV,nAVDate,navFloatRate,totalNAV}]；**日期跨度≤1 年**，故按年窗口取
 *   · fn20004.lgx          {prdCode, fileType}（2=产品说明书 / 0=风险揭示书）→ PDF 路径，登记编码在说明书首页
 *   · fn20001.lgx          {prdCode} → 公告列表
 *   · qryfinproductstageperfrangedata.lgx {prodCode, prodType:"FINA"} → 近1月/近3月/成立至今 年化
 *
 * 与官网 web 端口的差别：官网 financing_details.jsp 只有「最新净值单点 + 名称/风险/期限」；
 *   App 端口给**完整净值序列 + 七字段**（含成立日、业绩比较基准、登记编码），是本行的主通道。
 * 覆盖边界：仅「广发在售/代销」产品（fn10025 认不得即返回空 → 天然充当「本行是否销售」判据）；
 *   代销产品净值只保留上架后点数（比发行方全历史短），需要更长历史由编排层另走发行方端口。
 * ========================================================================== */
const CGB_APP_HOST = "https://wap.cgbchina.com.cn";
const CGB_APP_EP = CGB_APP_HOST + "/h5-mobilebank-app/noSessionServlet/hbss/";
const CGB_APP_REF = CGB_APP_HOST + "/mdp/hmba/investment/self/detail";
const CGB_APP_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.40";
const CGB_APP_TIMEOUT_MS = 20000;
/**
 * 【2026-10-31 用户实测】本机（家宽/境外 IP）连 wap.cgbchina.com.cn **TCP 层不通**
 * （curl --noproxy 直连 15s 无响应、HTTP 000；主站 www.cgbchina.com.cn 则返 403 静态拦截页）。
 * 线上 Worker IP 完全正常（会话页 200、fn10025/fn10003 全 200）。
 *
 * 后果：广发 App 腿每只产品白等 20s 会话超时 → 加上广银理财腿的探针/净值页超时，
 *       单只产品 50s、批量刷新直接爆掉前端 60s 预算 → 全部显示「未抓到」。
 *
 * 修法（进程内熔断）：会话建立超时 = 本机不可达 → 记熔断 → 后续该腿**直接返回 null 快速失败**，
 *   让编排层立刻走兜底/下一源。10 分钟窗口，站点恢复后自动恢复。
 */
const CGB_APP_CIRCUIT = { open: false, until: 0 };
const CGB_APP_CIRCUIT_MS = 10 * 60 * 1000;
// 首笔（尚未熔断）的会话探测用**短超时**：本机 IP 被封时，快速失败比干等 20s 更好——
// 编排层还有其它腿（发行行 / 中国理财网）可以试，把 60s 预算留给它们。
// 线上 IP 正常时会话建立仅 1~2s，短超时(6s)完全够用。
const CGB_APP_PROBE_TIMEOUT_MS = 6000;
// 年窗口最多回看多少年（防止畸形成立日把循环拖长）
const CGB_APP_MAX_YEARS = 12;

// ⚠ 2026-10-16 用户规则：产品信息（含登记编码）**一律不从说明书 PDF 解析**。
//   原因：fn20004 的说明书是扫描件/无文本层的比例不低（如 XFTLD98A），pypdf 抠不到 Z7 码；
//   一旦抠不到，fetchMeta 会判定信息不全 → 回落中国理财网名称检索，整体耗时被推到 10s+，
//   反而让前端判超时、落盘不更新（表现为「净值来源」少了 ·App）。
//   故这里不再取 fn20004，regCode 恒为 null，登记编码统一由 fetchMeta 的通用兜底走中国理财网补齐。

// 网关 senderSN：(时间戳 + 服务名第2~5位 + 4位随机).slice(0,30)，与前端 Qn() 同算法
function cgbAppSenderSN(svc) {
  return (String(Date.now()) + String(svc).substring(1, 5) + Math.floor(1e4 * Math.random())).substring(0, 30);
}

// "20260511" / "2026-05-11" → "2026-05-11"
function cgbAppDate(s) {
  const d = String(s || "").replace(/[^0-9]/g, "");
  if (d.length < 8) return null;
  const y = d.slice(0, 4), m = d.slice(4, 6), dd = d.slice(6, 8);
  if (!Number(y) || !Number(m) || !Number(dd)) return null;
  return `${y}-${m}-${dd}`;
}
function cgbAppCompact(dt) {
  return `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, "0")}${String(dt.getDate()).padStart(2, "0")}`;
}
// riskLevel "2" → "R2"
function cgbAppRisk(v) {
  const n = String(v == null ? "" : v).replace(/[^0-9]/g, "");
  return n && Number(n) >= 1 && Number(n) <= 5 ? "R" + n : null;
}
// sharedetailMinHold=0 且「每日开放」→ 1（沿用本项目 cgbHoldDays/cmbcHoldDays 的日开口径）
function cgbAppHoldDays(fd) {
  const h = Number(fd && fd.sharedetailMinHold);
  if (Number.isFinite(h) && h > 0) return Math.round(h);
  const desc = String((fd && (fd.investmentCycleDesc || fd.investmentCycle)) || "") + String((fd && fd.prdName) || "");
  if (/每日开放|日开|天天|现金管理|活期|无固定期限/.test(desc)) return 1;
  return h === 0 ? 0 : null;
}

// 打开详情页拿会话号。MDP_A_KEY 即 mpSId；拿不到就别继续（后续必 HB1021）
async function cgbAppSession(transport) {
  // 【2026-10-31 熔断】本机到 wap.cgbchina.com.cn 不通时，直接快速失败（别再等 20s）。
  if (CGB_APP_CIRCUIT.open && Date.now() < CGB_APP_CIRCUIT.until) return null;
  const ctrl = new AbortController();
  let timedOut = false;
  // 首笔用短超时（快速失败）；已熔断则上面直接返回，故这里恒为短超时。
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, CGB_APP_PROBE_TIMEOUT_MS);
  try {
    const res = await nyHttp(CGB_APP_REF + "?shortCode=N", {
      headers: { "User-Agent": CGB_APP_UA, Accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
      signal: ctrl.signal,
    }, transport);
    if (!res) return null;
    // ⚠ 不带完整 query（flowNo/MDP_STACK_HASH）时该地址回 302，但 Set-Cookie 照发，
    //   会话号就在 302 响应里 —— 所以这里不能按 res.ok 拦截，只认 cookie 有没有到。
    let list = [];
    try { list = res.headers.getSetCookie ? res.headers.getSetCookie() : []; } catch (e) { list = []; }
    if (!list || !list.length) {
      const sc = res.headers.get("set-cookie");
      if (sc) list = [sc];
    }
    const jar = {};
    for (const c of (list || [])) {
      const kv = String(c).split(";")[0];
      const i = kv.indexOf("=");
      if (i > 0) jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    }
    try { await res.text(); } catch (e) { /* 丢弃页面体 */ }
    const mpSId = jar.MDP_A_KEY || jar.MDP_G_KEY || "";
    if (!mpSId) return null;
    const cookie = Object.keys(jar).map((k) => k + "=" + jar[k]).join("; ");
    // 会话成功 → 清熔断（站点已恢复）
    CGB_APP_CIRCUIT.open = false;
    return { mpSId, cookie };
  } catch (e) {
    // 超时 = 本机到该站不可达 → 熔断，后续快速失败
    if (timedOut) {
      CGB_APP_CIRCUIT.open = true;
      CGB_APP_CIRCUIT.until = Date.now() + CGB_APP_CIRCUIT_MS;
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 网关统一调用：成功返回 body（对象），业务码非 0 / 网络异常返回 null（由调用方决定兜底）
async function cgbAppCall(svc, body, ctx, transport) {
  if (!ctx || !ctx.mpSId) return null;
  const sn = cgbAppSenderSN(svc);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CGB_APP_TIMEOUT_MS);
  try {
    const res = await nyHttp(CGB_APP_EP + svc, {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=utf-8",
        Accept: "application/json, text/plain, */*",
        Origin: CGB_APP_HOST,
        Referer: CGB_APP_REF,
        "User-Agent": CGB_APP_UA,
        senderSN: sn,
        "Tcom-trxChanAppCode": "O02HMBA",
        "Tcom-trxTrgRoleCode": "1",
        "Tcom-trxSrcSysCode": "HMBA_WECHAT0000000000000",
        "Tcom-equipId": "2026101612345678901234567890",
        Cookie: ctx.cookie,
      },
      body: JSON.stringify({
        header: { senderSN: sn, os: "iPhone", bizScene: CGB_APP_REF, channel: "MB", scope: "2", mpSId: ctx.mpSId },
        body: body || {},
      }),
      signal: ctrl.signal,
    }, transport);
    if (!res || !res.ok) return null;
    const txt = await res.text();
    let j = null;
    try { j = JSON.parse(txt); } catch (e) { return null; }
    const code = j && j.header && j.header.errorCode;
    if (code !== "0") return null;
    return (j && j.body) || {};
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ① 产品全量信息（fn10025）
async function cgbAppInfo(code, ctx, transport) {
  const b = await cgbAppCall("fn10025.lgx", { prdCode: code, intlFinaFlag: "", channel: "400", sChannel: "WX" }, ctx, transport);
  if (!b || !b.prdName) return null;
  return b;
}

// ② 净值序列（fn10003）。日期跨度≤1 年 → 按年窗口推进，窗口内按 beginNum 翻页
async function cgbAppNav(code, established, ctx, transport) {
  const today = new Date();
  let cursor = established ? new Date(established + "T00:00:00") : new Date(today.getFullYear() - 3, today.getMonth(), today.getDate());
  if (isNaN(cursor.getTime())) cursor = new Date(today.getFullYear() - 3, today.getMonth(), today.getDate());
  const raw = [];
  for (let guard = 0; guard < CGB_APP_MAX_YEARS; guard++) {
    if (cursor > today) break;
    const winEnd = new Date(cursor.getFullYear() + 1, cursor.getMonth(), cursor.getDate() - 1);
    const end = winEnd > today ? today : winEnd;
    const b = cgbAppCompact(cursor), e = cgbAppCompact(end);
    let page = await cgbAppCall("fn10003.lgx", { prdCode: code, beginNum: 0, fetchNum: 200, beginDate: b, endDate: e, channel: "400", sChannel: "WX" }, ctx, transport);
    if (page) {
      let list = (page.list || []).slice();
      const total = Number(page.totalNum || 0);
      let guard2 = 0;
      while (list.length < total && guard2++ < 20) {
        const more = await cgbAppCall("fn10003.lgx", { prdCode: code, beginNum: list.length, fetchNum: 200, beginDate: b, endDate: e, channel: "400", sChannel: "WX" }, ctx, transport);
        const got = (more && more.list) || [];
        if (!got.length) break;
        list = list.concat(got);
      }
      raw.push(...list);
    }
    cursor = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
  }
  // 归一 + 去重 + 升序
  const seen = {};
  const pts = [];
  for (const x of raw) {
    const d = cgbAppDate(x && x.nAVDate);
    const nav = parseFloat(x && x.nAV);
    const tot = parseFloat(x && x.totalNAV);
    if (!d || !Number.isFinite(nav) || nav <= 0 || seen[d]) continue;
    seen[d] = 1;
    pts.push({ d, nav, tot: Number.isFinite(tot) ? tot : nav });
  }
  if (!pts.length) return { series: [], kind: "nav", navBasis: "nav" };
  pts.sort((a, b2) => (a.d < b2.d ? -1 : 1));
  // 【项目规则 2026-10-21 立】现金管理类：单位净值恒 1、累计净值递增 → 一律排除。
  // 历史上的「展示累计净值（navBasis:"tot"）」现金类处理已删除：标记 cash 让上层
  // 直接返回 null，不做任何展示序列合成，勿再 reintroduce。
  const flatNav = pts.every((p) => Math.abs(p.nav - 1) < 1e-4);
  const totVar = pts.some((p) => Math.abs(p.tot - 1) > 1e-4);
  if (flatNav && totVar) return { series: [], kind: "nav", navBasis: "nav", cash: true };
  const series = pts.map((p) => [p.d, Number(p.nav.toFixed(8))]);
  return { series, kind: "nav", navBasis: "nav" };
}

// ③ 阶段年化（近1月 / 近3月 / 成立至今）
async function cgbAppStagePerf(code, ctx, transport) {
  const b = await cgbAppCall("qryfinproductstageperfrangedata.lgx", { prodCode: code, prodType: "FINA" }, ctx, transport);
  if (!b || !Array.isArray(b.details)) return null;
  return b.details.map((x) => ({ name: x.dateAreaName, rate: Number(x.yieldRate), beg: cgbAppDate(x.yieldBegDate), end: cgbAppDate(x.yieldEndDate) }));
}

/**
 * App 端口一键抓取：会话 → 产品信息 → 净值序列（+ 阶段年化）
 * 产品信息全部取自 fn10025 接口字段，**不解析说明书 PDF**（见上方规则说明）。
 * opts.infoOnly = true 时跳过净值（供 fetchMeta 只取信息用，避免与 /api/product 重复拉序列）
 */
export async function cgbAppFetch(code, opts = {}) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  const transport = opts.transport;
  const ctx = await cgbAppSession(transport);
  if (!ctx) return null;
  // 【2026-10-23 用户规则】刷信息只刷信息、刷额度只刷额度——两者都不抓净值。
  // 广发 App 端口 fn10025 一次回全字段（信息+起购金额），净值另走 fn10003 按年窗口翻页。
  const infoOnly = opts.infoOnly === true || opts.mode === "info" || opts.mode === "quota";

  const fd = await cgbAppInfo(c, ctx, transport);
  if (!fd) return null; // 广发不卖这个码

  const established = cgbAppDate(fd.estabDate) || null;
  const [nav, stage] = await Promise.all([
    infoOnly ? Promise.resolve({ series: [], kind: "nav", navBasis: "nav" }) : cgbAppNav(c, established, ctx, transport).catch(() => ({ series: [], kind: "nav", navBasis: "nav" })),
    infoOnly ? Promise.resolve(null) : cgbAppStagePerf(c, ctx, transport).catch(() => null),
  ]);

  // 登记编码：fn10025 无该字段；按用户规则不从说明书 PDF 抠 → 留 null，由 fetchMeta 兜底走中国理财网
  const regCode = null;

  // 【项目规则 2026-10-21】现金管理类（单位净值恒 1 + 累计净值递增）不抓：
  // 返回哨兵（产品信息也不收录），交编排层下发 isCash 让前端提示原因。
  if (!infoOnly && nav && nav.cash) return { _excludedCash: true, code: c };

  const series = nav.series || [];
  const last = series.length ? series[series.length - 1] : null;
  const latestNav = last ? last[1] : (parseFloat(fd.nAV) || null);
  const latestDate = last ? last[0] : (cgbAppDate(fd.nAVDate || fd.newRateDate) || null);
  const out = {
    name: fd.prdName || null,
    manager: fd.prdManagerName ? (inferManager(fd.prdManagerName) || fd.prdManagerName) : null,
    established,
    risk: cgbAppRisk(fd.riskLevel),
    benchmark: fd.perforMark || null,
    holdDays: cgbAppHoldDays(fd),
    regCode,
    series,
    kind: nav.kind || "nav",
    navBasis: nav.navBasis || "nav",
    source: "live",
    bank: "cgb",
    navVia: "cgb",
    navPort: "app",
    navViaCode: c,
    navLatest: latestNav,
    navLatestDate: latestDate,
    // 附加可见信息（详情页展示用）
    appOpenDesc: fd.investmentCycleDesc || null,
    appEndDate: cgbAppDate(fd.endDate),
    appShareClass: fd.shareClass || null,
    appStatus: fd.status === "0" ? "在售" : fd.status || null,
    appStagePerf: stage || null,
  };
  if (series.length < 2) out.infoOnly = true;
  return out;
}

/* ==========================================================================
 * 广发银行（CGB）实时抓取 —— 官网「银行理财」产品详情页（web 端口，保留作兜底）
 *
 * 通道：GET https://www.cgbchina.com.cn/jsp/financing_details.jsp?channelId=16684283&pkind=0&pno=<码>
 *   服务端渲染的 JSP 页面（GBK 编码），免登录、免签名，仅校验 Referer。
 *   页面 .product_right 区块含：<h2>产品全称</h2> / 成立至今年化收益率 /
 *   投资期限（天） / 最新净值 / 净值日期 / 风险等级（PRx…）。
 *   广发「银行理财」是「自营+代销」混合展示：既有自营「广银理财」系列，
 *   也有他行代销（实测含招银理财等）。
 *
 * 数据源限制：官网只披露「最新单位净值」单点（按周/开放日公告），不提供历史序列接口，
 *   故净值以该最新点构造单点序列（kind:"nav"）；产品名称/管理人/风险/最短持有期
 *   均来自页面真实字段。成立日期不在页面（「确认日」是下一次确认日，非成立日），
 *   由前端 /api/meta 从中国理财网补全。
 *
 * ⚠ 2026-10-16 起本函数降级为**兜底通道**：主通道是上面的 App 端口 cgbAppFetch（全序列 + 七字段），
 *   由 cgbFetch 统一调度。官网仍保留的原因：App 端口只覆盖「广发在售/代销」产品，
 *   且页面本身对自营/代销都能给出名称与风险，是 App 端口认不得时的最后一道自源兜底。
 * ========================================================================== */

const CGB_HOST = "https://www.cgbchina.com.cn";
const CGB_REF = CGB_HOST + "/CN/finance/index.html";
const CGB_TIMEOUT_MS = 15000;

// 广发「PRx」风险描述 → R 级
function cgbRisk(t) {
  const s = String(t || "");
  const m = s.match(/PR\s*([1-5])/i);
  if (m) return "R" + m[1];
  if (/极低|低风险/.test(s)) return "R1";
  if (/中低|较低/.test(s)) return "R2";
  if (/中高|较高/.test(s)) return "R4";
  if (/高风险/.test(s)) return "R5";
  if (/中风险/.test(s)) return "R3";
  return null;
}

// 投资期限描述 → 最短持有天数（每日开放/长期 → 1）
function cgbHoldDays(term) {
  const t = String(term || "").trim();
  if (!t) return null;
  if (/每日开放|日开|天天开|现金管理|活期|长期|长\s*期/.test(t)) return 1;
  const d = t.match(/(\d{1,4})\s*天/);
  if (d) return Number(d[1]);
  const mo = t.match(/(\d{1,2})\s*个?月/);
  if (mo) return Number(mo[1]) * 30;
  if (/半年/.test(t)) return 180;
  const y = t.match(/(\d{1,2})\s*年/);
  if (y) return Number(y[1]) * 365;
  return null;
}

async function cgbPage(code, transport) {
  const url = CGB_HOST + "/jsp/financing_details.jsp?channelId=16684283&pkind=0&pno=" + encodeURIComponent(code);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CGB_TIMEOUT_MS);
  try {
    const res = await (transport || fetch)(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
        Referer: CGB_REF,
      },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    // 页面是 GBK：按 charset 用原始字节二次解码（Node 支持 gbk；Workers 退化 utf-8）
    if (typeof res.arrayBuffer === "function") {
      const ab = await res.arrayBuffer();
      const bytes = new Uint8Array(ab);
      const head = new TextDecoder("ascii").decode(bytes.slice(0, 2000));
      const cs = (head.match(/charset\s*=\s*["']?([\w-]+)/i) || [, "gbk"])[1];
      try { return new TextDecoder(cs).decode(bytes); }
      catch (e) { return new TextDecoder("utf-8").decode(bytes); }
    }
    return await res.text();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function cgbWebFetch(code, opts = {}) {
  const transport = opts.transport;
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;

  const html = await cgbPage(c, transport);
  // 官网取不到（页面不存在 / 广发 CDN 对本机出口返回 403「Invalid Request」）时，
  // 回退跨行认领：广发代销的他行理财子份额里，招行目录可认领一部分（实测招银理财
  // 13214P 经 cmb 拿到 369 条）。⚠ 广银理财自营产品（广发代销里占约 59%）实测
  // icbc/cmb/comm/abc/boc/spdb/cmbc/bob/citic 九家均认领不到，只能靠广发自源，
  // 故这里只挂 cmb + icbc 两路，避免无谓拖慢查询。
  if (!html || /无此类产品/.test(html) || !/<div class="product_right">/.test(html)) {
    // 【2026-10-27】并发补充模式下（noXpl=true）官网只贡献自身单点，不回落中国理财网——
    // 中国理财网兜底由编排层统一负责，否则会塞进一整条系列、破坏「只补末点」语义。
    if (opts.noXpl) return null;
    // 「只走 3 家」规则（2026-10-15）：代销阶段只保留中国理财网信息披露平台（XPL = 规则允许的第 3 家），
    // 不再试探招行/工行等其它银行。广发自营页面取不到时，交由编排层中国理财网兜底。
    return xplShareFastLane("cgb", c, opts);
  }

  const grab = (re) => { const m = html.match(re); return m ? m[1].trim() : null; };
  const name = grab(/<div class="product_right">[\s\S]*?<h2>([^<]+)<\/h2>/);
  if (!name) return null;
  const navRaw = grab(/<dt>\s*最新净值：\s*<\/dt>\s*<dd>\s*([\d.]+)\s*<\/dd>/);
  const navDate = grab(/<dt>\s*净值日期：\s*<\/dt>\s*<dd>\s*([\d-]+)\s*<\/dd>/);
  const term = grab(/<dt>\s*投资期限（天）：\s*<\/dt>\s*<dd>\s*([^<]*?)\s*<\/dd>/);
  const riskRaw = grab(/<dt>\s*风险等级：\s*<\/dt>\s*<dd>\s*([^<]*?)\s*<\/dd>/);

  const matched = MANAGER_HINTS.some(([kw]) => name.includes(kw));
  const manager = matched ? inferManager(name) : null;

  const series = [];
  const v = parseFloat(navRaw);
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(navDate || "")) && Number.isFinite(v) && v > 0) {
    series.push([navDate, Number(v.toFixed(8))]);
  }
  return {
    name,
    manager,
    established: null,
    series,
    kind: "nav",
    risk: cgbRisk(riskRaw),
    benchmark: null,
    holdDays: cgbHoldDays(term),
    regCode: null,
    source: "live",
    bank: "cgb",
    navVia: "cgb",
    navPort: "web",   // 官网通道；App 端口命中时由 cgbAppFetch 覆盖为 app
    navLatest: series.length ? series[0][1] : null,
    navLatestDate: series.length ? series[0][0] : null,
    infoOnly: series.length === 0,
  };
}

/* ==========================================================================
 * 广银理财官网（cgbwmc）—— 发行方「广银理财」自有信息披露平台（2026-10-27 新增）
 *
 * 为什么必须新开这条通道（2026-10-27 实测结论，勿再退化）：
 *   我们此前只接了「广发银行」的两条通道（广发官网 financing_details.jsp + 广发 App MDP 网关），
 *   但发行方「广银理财」有独立官网 www.cgbwmc.com.cn，二者覆盖面完全不同：
 *     · 广发两条通道只覆盖「广发自己在售/代销」的产品。实测：
 *         广发货架的广银理财产品（XFTLCY21D53A / XFTLD98A / XFTLD18A / TLWXD01A / TLDCLCY0406A）
 *           → 广发官网都查得到（净值日期 2026-10-26）；
 *         中行(boc)货架的 XFTLCY14D05A、微众(webank)货架的 TLDCLCY14D06A
 *           → 广发官网一律「无此类产品」（5 个 channelId × 4 个 pkind 组合全试过），
 *             广发 App fn10025 亦返空（端点清单：fn10025 返空 = 天然「本行是否销售」判据）。
 *     ⇒ 「中国银行代销的广银理财产品」在广发侧根本不存在 → 永远抓不到；
 *       只有发行方自己的官网能覆盖。此前 5 家快更规则把「广银理财」当成 cgb 去找广发官网，
 *       找的是一个不认识该产品的站点 → 抓不到当日净值。
 *
 * 通道（免登录、免签名；GET 实测可用）：
 *   base = https://www.cgbwmc.com.cn/wmpcext/noSessionServlet
 *   ① 净值公告（主通道）：GET /noticeQuery/queryNoticeAllList.fun
 *      参数 belong=netNotice, belongSecond=, prodCd=<子份额码>, prodSerch=, parentProdCode=<父码>,
 *            startDate=, endDate=, fetchNum=<每页条数>, beginNum=<偏移量>
 *      响应 {retPage:{beginNum,fetchNum,list:[…],totalNum}, retInfo:"交易成功", retCode:"000000"}
 *      list 元素字段：id / prodCode / prodShtnm / navDate / nav(单位净值) / totalNav(累计单位净值) /
 *                    isCashManage("0"=净值型,"1"=现金管理类) / tenThousandIncomeAmt / sevenDaysIncomeRate
 *      ⚠ 分页参数名是 fetchNum/beginNum（不是 pageNum/pageSize）——本项目其它银行用 pageXxx，
 *        此站用 fetchNum（每页条数）+ beginNum（偏移 = 每页 ×(页号-1)），搞错会返回 999999。
 *      实测 XFTLCY14D05A：totalNum=401（成立以来全序列），末点 2026-10-26 = 1.0362。
 *   ② 子份额码字典：GET /noticeQuery/queryProdCodeList.fun?parentProdCode=<父码>
 *      → {retList:[{label:"产品全称",value:"子份额码"}], retCode:"000000"}
 *      实测 parentProdCode=XFTLCY14D05 → XFTLCY14D05A / B / C 三个兄弟份额。
 *      ★ 这正是项目《份额族》铁律同型问题：按父码/按名检索会串到兄弟份额，
 *        净值必须按**子份额码 prodCd** 精确取（与 109463WS vs 109463N 同型）。
 *   ③ 父产品清单：GET /noticeQuery/queryParentProdCodeList.fun → {retList:[{label,value}]}
 *
 * 定位：按项目既有约定（psbc→中邮理财官网、cib→兴银理财官网、citic→信银理财官网、
 *   pingan→平安理财官网），本通道即 cgb 的「发行方官网」侧；navPort 记 "cgbwmc"，
 *   前端单独标注为「广银理财官网」，与 ccbwm（建信理财官网）同型。
 * ========================================================================== */

const CGBWMC_HOST = "https://www.cgbwmc.com.cn";
const CGBWMC_API = CGBWMC_HOST + "/wmpcext/noSessionServlet";
const CGBWMC_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const CGBWMC_TIMEOUT_MS = 15000;
// 份额字典探针用短超时：站点不可达时快速否决，别让编排层干等两个长超时。
const CGBWMC_PROBE_TIMEOUT_MS = 6000;

/**
 * 【2026-10-31 用户实测】本机（家宽/境外 IP）连 www.cgbwmc.com.cn **TCP 层不通**
 * （curl 直连 20s 无响应、HTTP 000；--noproxy 绕过代理同样不通），
 * 而招行/兴银/农行等其它站点本机均正常 200 ⇒ 是**该站点对本机 IP 不可达**，
 * 不是我们的 UA/Referer/签名问题。线上 Worker IP 则完全正常（200）。
 *
 * 后果：每只广发/广银理财产品刷新都要白等「探针 6s × 2 + 净值页 15s」，
 * 再叠上编排层的份额码桥接与兜底 → 单只 50s、批量刷新直接爆掉 60s 预算。
 *
 * 修法（进程内熔断）：探针**超时**（区别于「HTTP 正常但查无此产品」的空返回）
 * 判定为本机不可达 → 记下熔断状态 → 后续该腿**直接返回 null 快速失败**，
 * 让编排层立刻走兜底/下一源，而不是每次重试白等十几秒。
 * 熔断窗口 10 分钟（站点恢复后自动恢复；也可由下一次成功请求提前清零）。
 */
const CGBWMC_CIRCUIT = { open: false, until: 0 };
const CGBWMC_CIRCUIT_MS = 10 * 60 * 1000;

// GET 请求（query 参数 qs 序列化 + _t 时间戳）；失败一律返回 null（不抛，避免拖垮编排层）。
// timeoutMs：探针用短超时（快速否决），净值公告用正常超时。
// 返回 { ok, data }：ok=false 且 timedOut=true 表示**请求超时**（= 本机到该站不可达），
//   与「HTTP 正常但查无此产品」（ok=true, data 为空/无 retList）区分开——后者不能熔断。
async function cgbwmcGet(ep, params, transport, timeoutMs) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs || CGBWMC_TIMEOUT_MS);
  try {
    const qs = new URLSearchParams({ ...params, _t: String(Date.now()) }).toString();
    const res = await (transport || fetch)(CGBWMC_API + ep + "?" + qs, {
      headers: {
        "User-Agent": CGBWMC_UA,
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        Referer: CGBWMC_HOST + "/",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: true, data: null, timedOut: false };
    const txt = await res.text();
    try { return { ok: true, data: JSON.parse(txt), timedOut: false }; } catch (e) { return { ok: true, data: null, timedOut: false }; }
  } catch (e) {
    return { ok: false, data: null, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 广银理财官网抓取：按子份额码取净值公告全序列 + 份额族字典。
 * 返回结构与其它银行 fetch 一致（series / navLatest / navLatestDate / navPort …）。
 */
export async function cgbwmcFetch(code, opts = {}) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  const transport = opts.transport;
  const infoOnly = opts.infoOnly === true || opts.mode === "info" || opts.mode === "quota";
  // 父产品码：份额码去掉末尾份额字母（XFTLCY14D05A → XFTLCY14D05），用于份额族字典反查。
  const parent = c.replace(/[A-Z]$/, "");

  // ① 份额族字典（**探针**）：确认本码确为广银理财份额，并拿到兄弟份额码（份额族铁律的护栏）。
  //   父码候选 = 去掉末尾份额字母；字典里不含本码时，再试「码本身」当父码。
  //   ⚠ 探针兼做**快速否决**：广发货架上也有他行理财子产品（招银理财等），这些码不是广银理财份额，
  //   字典查不到 → 立即返回 null，不再去拉净值公告（否则每次白等 2 个超时）。
  // 【2026-10-31 熔断】本机到 www.cgbwmc.com.cn 不通时（探针超时），本腿直接快速失败，
  //   不再白等「探针 6s × 2 + 净值页 15s」——让编排层立刻走兜底/下一源。
  if (CGBWMC_CIRCUIT.open && Date.now() < CGBWMC_CIRCUIT.until) return null;
  let shares = null, prodLabel = null, isCgbwmc = false;
  let probeTimedOut = false;
  const parentCands = parent !== c ? [parent, c] : [parent];
  for (const pc of parentCands) {
    const r = await cgbwmcGet("/noticeQuery/queryProdCodeList.fun", { parentProdCode: pc }, transport, CGBWMC_PROBE_TIMEOUT_MS);
    // 探针超时 = 本机到该站不可达（不是「查无此产品」）→ 记熔断并快速失败。
    if (r && !r.ok && r.timedOut) { probeTimedOut = true; break; }
    const dict = r && r.data;
    if (!dict || !Array.isArray(dict.retList) || !dict.retList.length) continue;
    const vals = dict.retList.map((x) => x && x.value).filter(Boolean);
    if (!shares) {
      shares = vals;
      prodLabel = (dict.retList[0] && dict.retList[0].label) || null;
    }
    if (vals.indexOf(c) >= 0) { isCgbwmc = true; break; }
  }
  if (probeTimedOut) {
    CGBWMC_CIRCUIT.open = true;
    CGBWMC_CIRCUIT.until = Date.now() + CGBWMC_CIRCUIT_MS;
    return null;
  }
  if (!isCgbwmc) return null;

  // ② 净值公告：按子份额码精确取，分页 fetchNum/beginNum。
  //   分页有总时间预算（12s）：单产品全历史通常 2~3 页即取完（实测 XFTLCY14D05A 共 401 点）；
  //   预算用于防「站点慢 → 无限翻页」把编排层拖死，超预算时用已取到的页（末点通常已在首页）。
  const rows = [];
  let total = 0;
  const PAGE = 200;
  const tList = Date.now();
  for (let begin = 0; begin < 4000; begin += PAGE) {
    const rj = await cgbwmcGet("/noticeQuery/queryNoticeAllList.fun", {
      belong: "netNotice", belongSecond: "",
      prodCd: c, prodSerch: "", parentProdCode: parent,
      startDate: "", endDate: "",
      fetchNum: String(PAGE), beginNum: String(begin),
    }, transport);
    // 净值公告页超时 = 本机不可达 → 熔断并快速失败（别再翻下一页）
    if (rj && !rj.ok && rj.timedOut) {
      CGBWMC_CIRCUIT.open = true;
      CGBWMC_CIRCUIT.until = Date.now() + CGBWMC_CIRCUIT_MS;
      break;
    }
    const j = rj && rj.data;
    const rp = j && j.retPage;
    if (!rp || !Array.isArray(rp.list) || !rp.list.length) break;
    for (const r of rp.list) rows.push(r);
    total = Number(rp.totalNum) || 0;
    if (rows.length >= total) break;
    if (Date.now() - tList > 12000) break; // 分页总时间预算
  }
  if (!rows.length) return null;

  // 归一：现金管理类（isCashManage="1"，净值口径是万份收益）按项目规则不抓。
  const seen = {};
  const pts = [];
  let name = null;
  for (const r of rows) {
    if (String(r.isCashManage) === "1") continue;
    const d = String(r.navDate || "").trim();
    const nav = parseFloat(r.nav);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(nav) || nav <= 0) continue;
    if (seen[d]) continue;
    seen[d] = 1;
    pts.push([d, Number(nav.toFixed(8))]);
    if (!name && r.prodShtnm) name = r.prodShtnm;
  }
  pts.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (!pts.length) return null;

  const last = pts[pts.length - 1];
  return {
    name: name || prodLabel || null,
    manager: "广银理财",
    established: null, // 成立日不在此站披露，由 /api/meta 中国理财网补全
    series: infoOnly ? [] : pts,
    kind: "nav",
    navBasis: "nav",
    source: "live",
    bank: "cgb",
    navVia: "cgb",
    navPort: "cgbwmc",
    navViaCode: c,
    navLatest: last[1],
    navLatestDate: last[0],
    infoOnly: pts.length < 2,
    // 份额族信息（供上层做「兄弟份额」护栏：同一 parentProdCode 下的其它份额码）
    cgbwmcShares: shares,
    cgbwmcParent: parent,
    cgbwmcProdLabel: prodLabel,
  };
}

/**
 * 广发银行入口
 *   ① App 端口（wap.cgbchina.com.cn MDP 网关，免登录）：全量净值序列 + 七字段（名称/风险/最短持有/
 *      成立日/业绩基准/登记编码/净值）→ 信息最全，序列主体；**只覆盖广发在售/代销产品**。
 *   ② 官网 web 端口（financing_details.jsp）：仅最新净值单点（上午即更新）+ 名称/风险/期限；
 *      **同样只覆盖广发在售/代销产品**（实测中行代销的 XFTLCY14D05A 在广发官网 =「无此类产品」）。
 *   ③ 【2026-10-27 新增】广银理财官网（www.cgbwmc.com.cn，cgbwmcFetch）：发行方自有信披平台，
 *      **覆盖全部广银理财产品**（含中行/微众等其它行代销的份额），按子份额码给成立以来全序列，
 *      且当日 23:00 后即更新当日净值 —— 这才是「5 家当日快更发行方」里 cgb 的正确落点。
 *   ④ 【2026-10-27 用户规则】刷净值：App 与官网**并发**抓取，用官网最新单点弥补 App 净值滞后
 *      （App 端口净值常中午后才更新 → 我们的净值整体滞后到中午；官网上午就公布最新单点）。
 *      官网仅补「比 App 更新」的那一个末点，不替换 App 的历史序列；官网页面取不到时放弃补充（不回落 XPL）。
 *   ⑤ info/quota 模式：只回 App 端口信息壳（官网只有净值单点，属净值，不该在刷信息/刷额度时抓）。
 */
export async function cgbFetch(code, opts = {}) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;

  // 【2026-10-23 用户规则】info/quota 只回 App 端口信息壳（cgbAppFetch 已按 infoOnly 跳过净值），
  // 官网只有「最新净值单点」属净值，不该在刷信息/刷额度时抓。
  if (opts.mode === "info" || opts.mode === "quota") {
    const app = await cgbAppFetch(c, opts).catch(() => null);
    if (app && app._excludedCash) return app; // 现金管理类哨兵
    return app || null;
  }

  // 刷净值：App（全序列+七字段）/ 广发官网（单点）/ 广银理财官网（全序列，覆盖非广发货架的份额）
  // 三路并发。2026-10-27 起新增第三路：此前只有前两路，而它们**只认识广发自己在售的产品**，
  // 导致「中行/微众代销的广银理财产品」永远抓不到（广发官网返回「无此类产品」、App fn10025 返空）。
  const [app, gw, wmc] = await Promise.all([
    cgbAppFetch(c, opts).catch(() => null),
    cgbWebFetch(c, { ...opts, noXpl: true }).catch(() => null), // 官网只贡献自身单点，不回落中国理财网（编排层统一兜底）
    cgbwmcFetch(c, opts).catch(() => null),                   // 广银理财官网：发行方权威，覆盖全部份额
  ]);
  // 现金管理类哨兵：直接透传给编排层（不参与下方的 App/官网合并，避免信息被重新收录）
  if (app && app._excludedCash) return app;

  // —— 三源合并 ——
  // 值优先级：广银理财官网(发行方权威) > 广发 App > 广发官网；日期并集，谁都没有的日期才补。
  // 末点端口标注：谁提供了**最新那个日期**，就标谁的端口（官网当日快更 → 标 cgbwmc 官网）。
  const srcs = [];
  const push = (r, port) => {
    if (!r) return;
    const s = Array.isArray(r.series) ? r.series : [];
    if (s.length) srcs.push({ r, port, points: s.length, last: s[s.length - 1], role: "full" });
    else if (r.navLatestDate && Number(r.navLatest) > 0) {
      srcs.push({ r, port, points: 1, last: [r.navLatestDate, Number(r.navLatest)], role: "fill" });
    }
  };
  push(wmc, "cgbwmc");
  push(app, "app");
  push(gw, "web");
  if (!srcs.length) return null;

  const byDate = {};
  for (const s of srcs) {
    for (const p of (s.r.series || [])) {
      if (!Array.isArray(p) || !p[0]) continue;
      if (!(p[0] in byDate)) byDate[p[0]] = Number(p[1]);
    }
    // 只回末点的附源（role=fill）：若其日期比已有日期新，也补进来
    if (!s.r.series || !s.r.series.length) {
      const d = s.last[0];
      if (d && !(d in byDate)) byDate[d] = Number(s.last[1]);
    }
  }
  const dates = Object.keys(byDate).sort();
  if (!dates.length) return null;
  const merged = dates.map((d) => [d, byDate[d]]);

  // 末点由谁提供 → 端口标注
  const lastDate = merged[merged.length - 1][0];
  const lastOwner = srcs.find((s) => (s.r.series || []).some((p) => Array.isArray(p) && p[0] === lastDate))
    || srcs.find((s) => s.last && s.last[0] === lastDate);
  const port = lastOwner ? lastOwner.port : "app";

  // 序列主体取「点数最多」的那一路；其余来源只补缺失日期。
  // ⚠ 信息字段（风险/最短持有/成立日/基准/登记编码/名称）**不能**跟着主体走：
  //   广银理财官网只给名称+净值，风险/持有期/成立日/基准在广发 App 的七字段里；
  //   infoOnly 模式下三路都只有 1 点、主体随机 → 必须按端口优先级单独挑字段，否则 meta 字段会被抹掉。
  const order = srcs.slice().sort((a, b) => (b.points - a.points) || (a.port === "cgbwmc" ? -1 : 1));
  const base = order[0].r || (wmc || app || gw);
  const out = {
    ...base,
    series: merged,
    kind: "nav",
    navBasis: "nav",
    source: "live",
    bank: "cgb",
    navVia: "cgb",
    navPort: port,
    navViaCode: c,
    navLatest: merged[merged.length - 1][1],
    navLatestDate: lastDate,
    infoOnly: merged.length < 2,
  };
  // 信息字段优先级：广发 App（七字段最全）→ 广银理财官网（名称/管理人）→ 广发官网
  const INFO_ORDER = ["app", "cgbwmc", "web"];
  const pick = (f) => {
    for (const p of INFO_ORDER) {
      const s = srcs.find((x) => x.port === p);
      if (s && s.r && s.r[f] != null && s.r[f] !== "") return s.r[f];
    }
    for (const s of srcs) if (s.r && s.r[f] != null && s.r[f] !== "") return s.r[f];
    return undefined;
  };
  for (const f of ["name", "manager", "risk", "benchmark", "holdDays", "established", "regCode"]) {
    const v = pick(f);
    if (v != null && v !== "") out[f] = v;
  }
  // 广发 App 的附加展示字段（详情页用），主体不是 App 时补回来
  if (app) {
    for (const f of ["appOpenDesc", "appEndDate", "appShareClass", "appStatus", "appStagePerf"]) {
      if (out[f] == null && app[f] != null) out[f] = app[f];
    }
  }
  // 双来源明细：贡献过数据的端口都列出，前端「净值来源」列据此同时显示
  const ns = srcs
    .map((s) => ({
      bank: "cgb", port: s.port, points: s.points,
      lastDate: s.last[0], lastNav: Number(s.last[1]), role: s.role,
    }))
    .sort((a, b) => (b.points - a.points));
  if (ns.length > 1) out.navSources = ns;
  // 份额族信息透传（兄弟份额护栏）
  if (wmc && wmc.cgbwmcShares) out.cgbwmcShares = wmc.cgbwmcShares;
  if (wmc && wmc.cgbwmcProdLabel) out.cgbwmcProdLabel = wmc.cgbwmcProdLabel;
  return out;
}

/* ==========================================================================
 * 富民银行（fminbank）App 端口 —— 理财代销 H5 公网网关（2026-10-19 打通）
 *
 * 逆向来源：富民银行 App「理财」频道的代销应用（fm-wealth-fund）H5 栈：
 *   入口 https://cf.fbank.com/pm2/dis-h5/fund/fund/home（SPA，basename=/pm2/dis-h5/fund）
 *   网关 https://open.fbank.com/gateway/（cf/edge 同网关；blackhole.cqfmbank.com 为原生栈+图片域）
 *   素材 fsp.fbank.com/static/fm-wealth-fund/2vans8wg/（index + vendor bundle；
 *   完整逆向见《富民银行_App端口净值抓取逆向报告.md》）。
 *
 * 协议（免登录、免签名、无 cookie；WebCrypto 加解密，本地 Node 与 Workers 双端通用）：
 *   请求：POST 平铺 body {siteId, appId, merchantNo, data:<AES(params)>}；
 *         head 只走 HTTP 头（api_name/api_code/module_code/client_serial_no/
 *         channel_no/api_version/algorithm:aesH5Service）——head 不进 body（曾踩坑）。
 *   加密：AES-128-CBC/PKCS7/base64；
 *         key = PBKDF2-SHA1(AK, salt=String(javaHashCode(AK)), 1000 iter, 16B)，IV = AK.substr(0,16)；
 *         AK = "IYYREaHVGE7pCmrW"（H5 页面 fmbase 明文，vendor.js 的 aesEncData/getIv）。
 *   响应：{data:<密文>, success, timestamp} → 解密得 {head:{rsp_code,rsp_msg}, body}。
 *
 * 服务（匿名可用性已实测）：
 *   · …product.financial.product.detail   产品详情（登记编码/销售代码/风险/基准/起购/
 *     开放时间/剩余额度 residual_amount/产品总额 product_total 等全字段）
 *   · …financial.getNetInfoList           净值全序列（一次回全量，正序旧→新；自上架日起）
 *   · dfs.chrematistic.financialLeaderboardQry   代销产品排行榜（263 款，带 product_no/
 *     product_name/product_manager）——内部码映射的匿名来源
 *   · dfs.chrematistic.smallProgramHistoryAchievement  历史业绩（近1月/3月/6月/1年/成立以来）
 *   · …product.financial-getPageNetList   分页净值（25/页倒序；page_no/page_size 须传字符串）
 *   ⚠ 目录服务 queryAreaContext / product.list / smallProgramFnclPrdt 被 gw10008
 *   「非法的安全等级」门控（需微信 open_idtoken，纯 Node/Workers 走不通）；
 *   ⚠ 登记编码/销售代码不被详情接口接受（400023 产品不存在）——富民自用内部
 *   product_no（如 DXHXRK516：DX=代销，HX=发行机构缩写，RK=产品类型，516=序号）。
 *
 * 产品码映射（Z7003925001182 → DXHXRK516）三条路径，逐级降级：
 *   ① code 已是 DX 内部码 → 直接查；
 *   ② FMBANK_CODE_MAP 静态映射表（2026-10-19 由排行榜 262 款产品批量拉详情生成，
 *      登记编码+销售代码双键 522 条，覆盖 13 家理财公司；快照会随上下架过期，
 *      过期项查不到即走下一级，无害）；
 *   ③ 排行榜目录（内存缓存 30min）按产品名归一化匹配（opts.name 由 fetchProductFull
 *      经 extraOf 透传；包含匹配要求唯一候选，防 A/B/C 份额误配）。
 *   全未命中 → 返回 null，交编排层中国理财网兜底（数据不丢）。
 *
 * ⚠ 瑞数 WAF（bsfit/dfppro.bsfit.com.cn）：无头 Chrome 跑真实 H5 页初始化即被拦
 *   （ZXSDKError 103111 -10001 -2 网关出错），但 Node/Workers 直连网关不受影响
 *   （与东莞银行剧本一致）——本端口不需要 Chrome。
 * ⚠ 净值深度：富民仅持有自上架日以来的序列（实测目标产品 95 点，2026-05-28 起），
 *   成立以来全量以发行行/中国理财网为准；本端口末点与 App 截图逐点对账通过
 *   （1.027300@2026-10-16）。
 * ========================================================================== */
const FMBANK_GW = "https://open.fbank.com/gateway/";
const FMBANK_AK = "IYYREaHVGE7pCmrW";
const FMBANK_APP_ID = "100003279963591568";
const FMBANK_SITE_ID = "100002596040673655";
const FMBANK_MERCHANT_NO = "8888001000198828";
const FMBANK_CHANNEL_NO = "801002";
const FMBANK_REF = "https://cf.fbank.com/pm2/dis-h5/fund/fund/";
const FMBANK_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const FMBANK_TIMEOUT_MS = 9000;
const FMBANK_CATALOG_TTL = 30 * 60 * 1000;
const FMBANK_API_DETAIL = "com.fbank.open-api.dis-cloud.product.financial.product.detail";
const FMBANK_API_NETLIST = "com.fbank.open-api.dis-cloud.financial.getNetInfoList";
const FMBANK_API_RANKING = "com.fbank.dfs.chrematistic.financialLeaderboardQry";
const FMBANK_API_ACHIEVE = "com.fbank.dfs.chrematistic.smallProgramHistoryAchievement";

// 静态映射表：登记编码 / 销售代码 → 富民内部 product_no（2026-10-19 由排行榜目录
// 262 款产品批量拉详情生成，522 条双键，覆盖 13 家理财公司；快照随上下架过期，
// 过期项查不到即回退目录名匹配 / 中国理财网兜底，无害）。
const FMBANK_CODE_MAP = {
  "24115024A":"DXHXCYQ376", "25112048D":"DXHXRK388", "25112053V":"DXHXRK503", "25112609B":"DXHXCYQ379",
  "25112648B":"DXHXRK491", "25115042C":"DXHXCYQ492", "25115058D":"DXHXCYQ385", "25115060A":"DXHXCYQ458",
  "25115061D":"DXHXCYQ386", "25115064D":"DXHXCYQ387", "25115086A":"DXHXCYQ457", "25812002A":"DXHXRK516",
  "9B31009F":"DXXYHB218", "9K20919B":"DXXYDK1MHY034", "9K218017":"DXXYDK12MHY005", "9K218031":"DXXYDK6MHY003",
  "9K40018C":"DXXYCYQ307", "9K40020B":"DXXYCYQ415", "9K40051A":"DXXYCYQ308", "9K41066B":"DXXYCYQ474",
  "9K43024A":"DXXYCYQ309", "9K43052C":"DXXYCYQ472", "9K45021B":"DXXYCYQ310", "9K53301D":"DXXYCYQ413",
  "9K91012B":"DXXYCYQ217", "9K92361E":"DXXYKFS459", "9TTL953C":"DXXYHB370", "9TTL978D":"DXXYHB461",
  "A22001":"DXNYHB141", "A22006":"DXHYHB188", "A32001":"DXNYCYQ149", "A32005":"DXNYCYQ151",
  "A32042":"DXNYCYQ391", "A32044":"DXNYCYQ339", "A32055":"DXNYCYQ338", "A32056":"DXNYCYQ354",
  "A32058":"DXNYCYQ355", "A32063":"DXNYCYQ384", "A32102":"DXNYCYQ403", "A32104":"DXNYCYQ407",
  "CCRSFD07A":"DXQYDK1WFD045", "CCRSFD07C":"DXQYDK176", "CCRSFD07F":"DXQYDK1WFD044", "CCRSFD3021":"DXQYDK1MFD049",
  "CCRSFDKFJZA":"DXQYKFS184", "FBAE31002E":"DXMSRK293", "FBAE31003E":"DXMSRK355", "FBAE31009E":"DXMSRK374",
  "FBAE31010E":"DXMSRK375", "FBAE31013E":"DXMSRK389", "FBAE32115E":"DXMSCYQ482", "FBAE32155E":"DXMSCYQ303",
  "FBAE32214E":"DXMSCYQ441", "FBAE32351E":"DXMSCYQ304", "FBAE32503E":"DXMSCYQ356", "FBAE32551E":"DXMSCYQ305",
  "FBAE32651E":"DXMSCYQ349", "FBAE34307E":"DXMSCYQ398", "FBAE41042F":"DXMSRK319", "FBAE41077F":"DXMSRK410",
  "FBAE41080F":"DXMSRK460", "FBAE41100F":"DXMSRK512", "FBAE41130E":"DXMSCYQ409", "FBAE41166E":"DXMSCYQ427",
  "FBAE60202F":"DXMSCYQ251", "FBAE61006F":"DXMSCYQ252", "FBAE61106F":"DXMSCYQ253", "FBAE68018E":"DXMSRK283",
  "FSAE68011A":"DXMSCYQ223", "HRFRWL7D0101":"DXHFCYQ201", "HRSXB0103":"DXHFKFS224", "HRSXB08A":"DXHFKFS314",
  "HRSXY180D01A":"DXHFCYQ294", "HRSXY60D0103":"DXHFCYQ204", "HRSXY90D001A":"DXHFCYQ279", "HRSXY90D02A":"DXHFCYQ312",
  "HYGC300D2502C":"DXHXCYQ504", "JQB2331D":"DXHYHB248", "JQB2332C":"DXHYHB258", "JQB2434B":"DXHYHB268",
  "JQB2435C":"DXHYHB278", "JQB2543B":"DXHYHB378", "JQB2546B":"DXHYHB367", "JQB2547B":"DXHYHB353",
  "JQB2555C":"DXHYHB448", "JQB2558C":"DXHYHB466", "JQB2663B":"DXHYHB506", "LCYS14CY001":"DXBYCYQ288",
  "LCYS14CY006B":"DXBYCYQ372", "LCYS14CYZ03A":"DXBYCYQ347", "LCYS14CYZ05A":"DXBYCYQ396", "LCYS14CYZ06A":"DXBYCYQ397",
  "LCYS180CYZ2D":"DXBYCYQ371", "LCYS30CY001A":"DXBYCYQ312", "LCYS7CY01A":"DXBYCYQ311", "LCYS90CY002":"DXBYCYQ289",
  "LCYS90CYZ03A":"DXBYCYQ400", "LCYSRK006":"DXBYRK239", "LCYSRK07A":"DXBYRK294", "LCYSRK10B":"DXBYRK346",
  "LCYSRK14A":"DXBYCYQ378", "LCYSRK15D":"DXBYRK483", "LCYSRK16D":"DXBYRK438", "LCYSRK17D":"DXBYRK502",
  "LCYSRK19C":"DXBYRK415", "LHCZGS2100141A":"DXPACYQ219", "LHCZGS2100301A":"DXPACYQ220", "LHCZGS2100601A":"DXPACYQ221",
  "LHCZGS2100901A":"DXPACYQ222", "LQB2001C":"DXHYHBSY059", "LQB2001D":"DXHYHB198", "LZCG00713C":"DXPACYQ295",
  "LZCG09004B":"DXPACYQ357", "LZTG00601D":"DXPACYQ369", "LZTG00702C":"DXPACYQ330", "LZTG00703A":"DXPACYQ350",
  "LZTG00704C":"DXPACYQ315", "LZTG06006A":"DXPACYQ358", "LZTG09003D":"DXPACYQ284", "PNHY210110":"DXHSYDK185",
  "PNHY210208":"DXHSYCYQ248", "PNHY220035_B":"DXHSYCYQ219", "PNHY230115_D":"DXHYHB238", "PNHY230390_A":"DXHSYHB268",
  "PNHY240051_A":"DXHSYHB278", "PNHY240108_B":"DHHSYCYQ247", "PNHY250049_D":"DXHSYCYQ329", "PNHY250116_A":"DXHSYCYQ362",
  "PNHY250121_A":"DHHSYCYQ363", "QTCG03002A":"DXPACYQ255", "QTCG03009C":"DXPACYQ317", "QTCG09011C":"DXPACYQ302",
  "QTCZGS0121001H":"DXPACYQ215", "QWCG00712D":"DXPACYQ366", "QWCG03013B":"DXPACYQ365", "QYTLGS01221001":"DXPACYQ254",
  "TG01230601F":"DXBYKFS244", "TG01230604G":"DXBYCYQ477", "TG01240106B":"DXBYKFS280", "TG01240114F":"DXBYCYQ343",
  "TG01240351A":"DXBYKFS392", "TG01240362B":"DXBYKFS301", "TG01240364B":"DXBYKFS430", "TG01250402A":"DXBYKFS382",
  "TG01250403A":"DXBYKFS406", "TLWXCY0301A":"DXGYJDK236", "TLWXD01A":"DXGYRK235", "TLWXD02A":"DXGYRK245",
  "TYG1D2201B":"DXHYKFS230", "TYG1D2507E":"DXHYKFS354", "TYG1D2509B":"DXHYKFS394", "TYG1D2513D":"DXHYKFS507",
  "TYG1M2001":"DXHYDK1MTY066", "TYG3M1901":"DXHYDK3MTY071", "TYG6M2006":"DXHYDK6MTY070", "TYG7D2101":"DXHYDK1WTY055",
  "TYGC14D2505C":"DXHXCYQ405", "TYGC30D2502B":"DXHXCYQ399", "TYGC30D2503B":"DXHXCYQ428", "TYGC7D2507E":"DXHXCYQ383",
  "TYGC7D2508E":"DXHXCYQ419", "TYGC7D2510B":"DXHXCYQ416", "TYGC7D2511B":"DXHXCYQ440", "TYGC7D2516C":"DXHXCYQ475",
  "TYGC7M2201":"DXHXCYQ412", "TYGC90D2508B":"DXHXCYQ424", "TYGC9M2202D":"DXHXCYQ411", "TYGZ1D2620D":"DXHYKFS518",
  "TYGZC2605C":"DXHXCYQ506", "TYGZC2607C":"DXHXCYQ493", "TYGZC2609C":"DXHXCYQ505", "WPBK24M0101B":"DXSYCYQ459",
  "WPBK24M0401B":"DXSYCYQ523", "WPBK24M0501B":"DXSYCYQ408", "WPBK24M0901B":"DXSYCYQ511", "WPBK25M0303B":"DXSYCYQ337",
  "WPBK26M0201B":"DXSYCYQ473", "WPEK23M1203C":"DXSYCYQ341", "WPEK24D2101C":"DXSYCYQ316", "WPEK24M0201C":"DXSYCYQ301",
  "WPEK24M0305Q":"DXSYCYQ256", "WPEK24M0306Q":"DXSYCYQ296", "WPEK24M1201C":"DXSYCYQ342", "WPEK25D0706C":"DXSYCYQ321",
  "WPEK25D0708C":"DXSYCYQ323", "WPEK25D0710C":"DXSYCYQ479", "WPEK25D0711C":"DXSYCYQ483", "WPEK25D2104C":"DXSYCYQ320",
  "WPEK25D2105C":"DXSYCYQ452", "WPEK25D2804C":"DXSYCYQ324", "WPEK25D2808C":"DXSYCYQ456", "WPEK25M0202C":"DXSYCYQ325",
  "WPEK25M0204C":"DXSYCYQ453", "WPEK25M0205C":"DXSYCYQ455", "WPEK25M0307B":"DXSYCYQ326", "WPEK25M0310B":"DXSYCYQ331",
  "WPEK25M0311B":"DXSYCYQ332", "WPEK25M0312B":"DXSYCYQ333", "WPEK25M0316B":"DXSYCYQ462", "WPEK25M0317B":"DXSYCYQ468",
  "WPEK25M0403B":"DXSYCYQ327", "WPEK25M0605B":"DXSYCYQ334", "WPEK25M0609B":"DXSYCYQ463", "WPEK25M0610B":"DXSYCYQ464",
  "WPEK25M0611B":"DXSYCYQ467", "WPEK25M0702B":"DXSYCYQ335", "WPEK25M0901B":"DXSYCYQ336", "WPEK26D0713C":"DXSYCYQ509",
  "WPEK26D0714C":"DXSYCYQ510", "WPEK26D1401C":"DXSYCYQ480", "WPEK26D1402C":"DXSYCYQ484", "WPEK26D1403C":"DXSYCYQ487",
  "WPEK26D1404C":"DXSYCYQ497", "WPEK26D2106C":"DXSYCYQ490", "WPEK26D2809C":"DXSYCYQ499", "WPEK26M0206C":"DXSYCYQ519",
  "WPEK26M0207C":"DXSYCYQ521", "WPEK26M0208C":"DXSYCYQ524", "WPEK26M0318B":"DXSYCYQ481", "WPEK26M0319B":"DXSYCYQ485",
  "WPEK26M0320B":"DXSYCYQ486", "WPEK26M0321B":"DXSYCYQ512", "WPEK26M0322B":"DXSYCYQ513", "WPEK26M0323B":"DXSYCYQ514",
  "WPEK26M0324B":"DXSYCYQ515", "WPEK26M0325B":"DXSYCYQ516", "WPEK26M0326B":"DXSYCYQ517", "WPEK26M0327B":"DXSYCYQ518",
  "WPEK26M0336B":"DXSYCYQ520", "WPEK26M0612B":"DXSYCYQ488", "WPEK26M0613B":"DXSYCYQ489", "WPEK26M0614B":"DXSYCYQ498",
  "WPLK22M1401B":"DXSYCYQ522", "WPLK25M0301A":"DXSYCYQ471", "WPLK26D0101A":"DXSYRK494", "WPLK26D0102A":"DXSYRK495",
  "WPLK26D0103A":"DXSYRK496", "WPTK25D1406C":"DXSYCYQ322", "XFTLCY0101A":"DXGYCYQ1M240", "XFTLCY0102D":"DXGYCYQ1M242",
  "XFTLCY7D01A":"DXGYCYQ1W241", "YJ01240793A":"DXBYCYQ282", "YJ01240794A":"DXBYCYQ281", "YJ01240971A":"DXBYCYQ476",
  "YJ01250334A":"DXBYCYQ432", "YJ01250347A":"DXBYCYQ443", "YJ01250348A":"DXBYCYQ429", "YJ01250495A":"DXBYCYQ361",
  "YJ01250496A":"DXBYCYQ390", "YJ01251048B":"DXBYKFS478", "YJ01251052C":"DXBYKFS501", "YJ01251060A":"DXBYCYQ450",
  "YJ01260315A":"DXBYKFS518", "YJ01260449B":"DXBYKFS517", "YJ01260504A":"DXBYKFS519", "Z01003":"DXNYCYQ422",
  "Z10003":"DXNYDK1MCX039", "Z20008":"DXNYCYQ152", "Z60001":"DXNYRSJSYW058", "Z60002":"DXNYRSMSYW057",
  "Z70005":"DXNYCYQ150", "Z7002020000011":"DXXYDK12MHY005", "Z7002020000021":"DXXYDK6MHY003", "Z7002021000107":"DXXYHB218",
  "Z7002021000131":"DXXYDK1MHY034", "Z7002022000075":"DXXYCYQ217", "Z7002023001467":"DXXYCYQ308", "Z7002024001061":"DXXYCYQ310",
  "Z7002024001088":"DXXYCYQ309", "Z7002024001169":"DXXYCYQ307", "Z7002024001170":"DXXYCYQ415", "Z7002024003299":"DXXYCYQ472",
  "Z7002025000031":"DXXYCYQ413", "Z7002025000127":"DXXYHB370", "Z7002025000858":"DXXYCYQ474", "Z7002025000890":"DXXYHB461",
  "Z7002025001400":"DXXYKFS459", "Z7002220000004":"DXHYHB198", "Z7002221000111":"DXHYDK1WTY055", "Z7002221000173":"DXHYDK6MTY070",
  "Z7002221000271":"DXHYDK1MTY066", "Z7002221000272":"DXHYDK3MTY071", "Z7002222000055":"DXHXCYQ412", "Z7002222000071":"DXHXCYQ411",
  "Z7002222000087":"DXHYKFS230", "Z7002223000304":"DXHYHB258", "Z7002223000305":"DXHYHB248", "Z7002224000068":"DXHYHB268",
  "Z7002224000069":"DXHYHB278", "Z7002225000030":"DXHYKFS354", "Z7002225000088":"DXHXCYQ383", "Z7002225000108":"DXHYHB378",
  "Z7002225000111":"DXHYHB367", "Z7002225000115":"DXHXCYQ419", "Z7002225000123":"DXHYHB353", "Z7002225000162":"DXHXCYQ504",
  "Z7002225000198":"DXHXCYQ416", "Z7002225000199":"DXHYKFS394", "Z7002225000226":"DXHXCYQ428", "Z7002225000227":"DXHXCYQ424",
  "Z7002225000232":"DXHXCYQ440", "Z7002225000234":"DXHXCYQ405", "Z7002225000235":"DXHXCYQ399", "Z7002225000271":"DXHYKFS507",
  "Z7002225000272":"DXHXCYQ475", "Z7002225000364":"DXHYHB448", "Z7002225000469":"DXHYHB466", "Z7002226000038":"DXHXCYQ493",
  "Z7002226000045":"DXHXCYQ506", "Z7002226000049":"DXHXCYQ505", "Z7002226000056":"DXHYHB506", "Z7002226000149":"DXHYKFS518",
  "Z7002421000077":"DXHSYDK185", "Z7002421000136":"DXHSYCYQ248", "Z7002422000058":"DXHSYCYQ219", "Z7002423000076":"DXHYHB238",
  "Z7002423000311":"DXHSYHB268", "Z7002424000036":"DXHSYHB278", "Z7002424000093":"DHHSYCYQ247", "Z7002425000042":"DXHSYCYQ329",
  "Z7002425000088":"DHHSYCYQ363", "Z7002425000098":"DXHSYCYQ362", "Z70026":"DXNYCYQ470", "Z7003220000002":"DXNYDK1MCX039",
  "Z7003220000009":"DXHYHB188", "Z7003220000013":"DXNYRSJSYW058", "Z7003220000016":"DXNYRSMSYW057", "Z7003222000016":"DXNYCYQ150",
  "Z7003222000021":"DXNYCYQ149", "Z7003222000027":"DXNYCYQ152", "Z7003222000028":"DXNYCYQ151", "Z7003224000089":"DXNYCYQ391",
  "Z7003224000201":"DXNYCYQ339", "Z7003224000207":"DXNYCYQ384", "Z7003224000213":"DXNYCYQ338", "Z7003224000253":"DXNYCYQ354",
  "Z7003224000255":"DXNYCYQ355", "Z7003225000011":"DXNYCYQ422", "Z7003225000198":"DXNYCYQ407", "Z7003225000199":"DXNYCYQ403",
  "Z7003225000398":"DXNYCYQ470", "Z7003321000143":"DXPACYQ215", "Z7003321000343":"DXPACYQ221", "Z7003322000005":"DXPACYQ222",
  "Z7003322000006":"DXPACYQ220", "Z7003322000117":"DXPACYQ219", "Z7003322000177":"DXPACYQ254", "Z7003323000458":"DXPACYQ255",
  "Z7003324000594":"DXPACYQ284", "Z7003324000674":"DXPACYQ295", "Z7003324000804":"DXPACYQ330", "Z7003324000805":"DXPACYQ350",
  "Z7003324000831":"DXPACYQ366", "Z7003324000834":"DXPACYQ365", "Z7003324000840":"DXPACYQ357", "Z7003324000858":"DXPACYQ317",
  "Z7003324000859":"DXPACYQ302", "Z7003324000860":"DXPACYQ315", "Z7003324000911":"DXPACYQ358", "Z7003325000120":"DXPACYQ369",
  "Z7003520000008":"DXQYDK176", "Z7003520000013":"DXQYDK1WFD045", "Z7003520000034":"DXQYDK1MFD049", "Z7003521000772":"DXQYDK1WFD044",
  "Z7003522000200":"DXQYKFS184", "Z7003924000476":"DXHXCYQ376", "Z7003925000035":"DXHXCYQ379", "Z7003925000127":"DXHXCYQ492",
  "Z7003925000569":"DXHXCYQ458", "Z7003925000572":"DXHXRK388", "Z7003925000575":"DXHXCYQ385", "Z7003925000578":"DXHXCYQ387",
  "Z7003925000584":"DXHXCYQ386", "Z7003925000685":"DXHXRK503", "Z7003925000700":"DXHXCYQ457", "Z7003925001182":"DXHXRK516",
  "Z7003925001943":"DXHXRK491", "Z7006622000104":"DXGYCYQ1W241", "Z7006622000106":"DXGYCYQ1M240", "Z7006622000139":"DXGYJDK236",
  "Z7006622000141":"DXGYRK235", "Z7006623000095":"DXGYRK245", "Z7006624000020":"DXGYCYQ1M242", "Z7007122000001":"DXSYCYQ522",
  "Z7007123000105":"DXSYCYQ341", "Z7007124000082":"DXSYCYQ256", "Z7007124000083":"DXSYCYQ296", "Z7007124000213":"DXSYCYQ316",
  "Z7007124000221":"DXSYCYQ301", "Z7007124000299":"DXSYCYQ511", "Z7007124000364":"DXSYCYQ523", "Z7007124000365":"DXSYCYQ459",
  "Z7007124000370":"DXSYCYQ408", "Z7007124000431":"DXSYCYQ342", "Z7007124000461":"DXSYCYQ325", "Z7007124000462":"DXSYCYQ322",
  "Z7007124000470":"DXSYCYQ324", "Z7007125000035":"DXSYCYQ326", "Z7007125000038":"DXSYCYQ335", "Z7007125000040":"DXSYCYQ327",
  "Z7007125000042":"DXSYCYQ331", "Z7007125000059":"DXSYCYQ332", "Z7007125000064":"DXSYCYQ333", "Z7007125000071":"DXSYCYQ336",
  "Z7007125000074":"DXSYCYQ334", "Z7007125000080":"DXSYCYQ321", "Z7007125000083":"DXSYCYQ320", "Z7007125000085":"DXSYCYQ323",
  "Z7007125000131":"DXSYCYQ337", "Z7007125000465":"DXSYCYQ453", "Z7007125000473":"DXSYCYQ452", "Z7007125000474":"DXSYCYQ456",
  "Z7007125000483":"DXSYCYQ479", "Z7007125000487":"DXSYCYQ483", "Z7007125000491":"DXSYCYQ455", "Z7007125000504":"DXSYCYQ510",
  "Z7007125000506":"DXSYCYQ471", "Z7007125000508":"DXSYCYQ509", "Z7007125000516":"DXSYCYQ462", "Z7007125000517":"DXSYCYQ468",
  "Z7007125000520":"DXSYCYQ467", "Z7007125000523":"DXSYCYQ464", "Z7007125000527":"DXSYCYQ463", "Z7007126000014":"DXSYCYQ473",
  "Z7007126000040":"DXSYCYQ499", "Z7007126000042":"DXSYCYQ490", "Z7007126000047":"DXSYCYQ480", "Z7007126000048":"DXSYCYQ487",
  "Z7007126000050":"DXSYCYQ484", "Z7007126000054":"DXSYCYQ497", "Z7007126000077":"DXSYCYQ486", "Z7007126000080":"DXSYCYQ485",
  "Z7007126000082":"DXSYCYQ481", "Z7007126000093":"DXSYCYQ498", "Z7007126000094":"DXSYCYQ489", "Z7007126000095":"DXSYCYQ488",
  "Z7007126000099":"DXSYRK494", "Z7007126000101":"DXSYRK495", "Z7007126000102":"DXSYRK496", "Z7007126000248":"DXSYCYQ515",
  "Z7007126000249":"DXSYCYQ512", "Z7007126000251":"DXSYCYQ514", "Z7007126000252":"DXSYCYQ516", "Z7007126000255":"DXSYCYQ513",
  "Z7007126000272":"DXSYCYQ521", "Z7007126000276":"DXSYCYQ519", "Z7007126000322":"DXSYCYQ518", "Z7007126000324":"DXSYCYQ520",
  "Z7007126000329":"DXSYCYQ517", "Z7007126000434":"DXSYCYQ524", "Z7007922000005":"DXMSCYQ223", "Z7007923000090":"DXMSRK283",
  "Z7007923000348":"DXMSCYQ251", "Z7007923000349":"DXMSCYQ252", "Z7007923000351":"DXMSCYQ253", "Z7007924000335":"DXMSRK293",
  "Z7007924000712":"DXMSRK319", "Z7007924000925":"DXMSCYQ305", "Z7007924000926":"DXMSCYQ303", "Z7007924000927":"DXMSCYQ304",
  "Z7007924000928":"DXMSCYQ349", "Z7007924001013":"DXMSCYQ409", "Z7007924001040":"DXMSCYQ356", "Z7007924001078":"DXMSRK355",
  "Z7007924001282":"DXMSRK410", "Z7007924001286":"DXMSRK460", "Z7007925000315":"DXMSCYQ398", "Z7007925000588":"DXMSRK374",
  "Z7007925000589":"DXMSRK375", "Z7007925000680":"DXMSRK389", "Z7007925000752":"DXMSRK512", "Z7007925000880":"DXMSCYQ427",
  "Z7007925001133":"DXMSCYQ441", "Z7007926000088":"DXMSCYQ482", "Z7008122000025":"DXHFCYQ201", "Z7008122000027":"DXHFCYQ204",
  "Z7008122000041":"DXHFKFS224", "Z7008123000025":"DXHFCYQ279", "Z7008124000347":"DXHFCYQ294", "Z7008124000392":"DXHFCYQ312",
  "Z7008124000572":"DXHFKFS314", "Z7008423000252":"DXBYRK239", "Z7008423000449":"DXBYCYQ289", "Z7008424000001":"DXBYCYQ288",
  "Z7008424000251":"DXBYRK294", "Z7008424000299":"DXBYCYQ311", "Z7008424000329":"DXBYCYQ312", "Z7008424000412":"DXBYRK346",
  "Z7008425000053":"DXBYCYQ347", "Z7008425000134":"DXBYCYQ372", "Z7008425000135":"DXBYCYQ396", "Z7008425000136":"DXBYCYQ397",
  "Z7008425000163":"DXBYCYQ378", "Z7008425000166":"DXBYRK438", "Z7008425000169":"DXBYRK502", "Z7008425000171":"DXBYRK483",
  "Z7008425000172":"DXBYRK415", "Z7008425000183":"DXBYCYQ371", "Z7008425000342":"DXBYCYQ400", "Z7008923000082":"DXBYKFS244",
  "Z7008923000087":"DXBYCYQ477", "Z7008924000027":"DXBYKFS280", "Z7008924000041":"DXBYCYQ343", "Z7008924000137":"DXBYKFS392",
  "Z7008924000148":"DXBYKFS301", "Z7008924000150":"DXBYKFS430", "Z7008924000287":"DXBYCYQ282", "Z7008924000288":"DXBYCYQ281",
  "Z7008924000482":"DXBYCYQ476", "Z7008925000070":"DXBYKFS382", "Z7008925000073":"DXBYKFS406", "Z7008925000110":"DXBYCYQ443",
  "Z7008925000114":"DXBYCYQ429", "Z7008925000115":"DXBYCYQ432", "Z7008925000252":"DXBYCYQ361", "Z7008925000253":"DXBYCYQ390",
  "Z7008925000628":"DXBYKFS478", "Z7008925000631":"DXBYCYQ450", "Z7008925000635":"DXBYKFS501", "Z7008926000197":"DXBYKFS518",
  "Z7008926000281":"DXBYKFS517", "Z7008926000286":"DXBYKFS519",
};

// Java 风格 String.hashCode()（vendor.js 的 l()；PBKDF2 salt = 其结果）
function fmJavaHash(str) {
  let e = 0;
  for (let i = 0; i < str.length; i++) { e = (e << 5) - e + str.charCodeAt(i); e |= 0; }
  return e;
}

// 派生 16B 密钥（PBKDF2-SHA1，1000 iter）——进程内只算一次
let __fmKeyBits = null;
async function fmKeyBits() {
  if (!__fmKeyBits) {
    __fmKeyBits = (async () => {
      const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(FMBANK_AK), "PBKDF2", false, ["deriveBits"]);
      return new Uint8Array(await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt: new TextEncoder().encode(String(fmJavaHash(FMBANK_AK))), iterations: 1000, hash: "SHA-1" },
        base, 128));
    })();
  }
  return __fmKeyBits;
}

async function fmEnc(obj) {
  const bits = await fmKeyBits();
  const key = await crypto.subtle.importKey("raw", bits, { name: "AES-CBC" }, false, ["encrypt"]);
  const iv = new TextEncoder().encode(FMBANK_AK.substr(0, 16));
  const ct = await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return bytesToB64(new Uint8Array(ct));
}
async function fmDec(b64) {
  const bits = await fmKeyBits();
  const key = await crypto.subtle.importKey("raw", bits, { name: "AES-CBC" }, false, ["decrypt"]);
  const iv = new TextEncoder().encode(FMBANK_AK.substr(0, 16));
  const pt = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, b64ToBytes(b64));
  return new TextDecoder().decode(pt);
}

function fmSerial() {
  return "H5" + Date.now() + Math.random().toString(36).slice(2, 10).toUpperCase();
}

// 网关调用：返回解密后的业务对象 {head, body}；任何一步失败回 null（不抛）
async function fmCall(api, params, transport) {
  const csn = fmSerial();
  let data;
  try { data = await fmEnc(params); } catch (e) { return null; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FMBANK_TIMEOUT_MS);
  try {
    const res = await (transport || fetch)(FMBANK_GW, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        api_version: "", algorithm: "aesH5Service",
        api_name: api, api_code: "", module_code: "", client_serial_no: csn,
        channel_no: FMBANK_CHANNEL_NO,
        Referer: FMBANK_REF, "User-Agent": FMBANK_UA, Accept: "application/json",
      },
      body: JSON.stringify({ siteId: FMBANK_SITE_ID, appId: FMBANK_APP_ID, merchantNo: FMBANK_MERCHANT_NO, data }),
      signal: ctrl.signal,
    });
    const txt = await res.text();
    let j = null;
    try { j = JSON.parse(txt); } catch (e) { return null; }
    if (!j || typeof j.data !== "string" || j.data.length < 8) return null;
    let dec;
    try { dec = await fmDec(j.data); } catch (e) { return null; }
    let biz = null;
    try { biz = JSON.parse(dec); } catch (e) { return null; }
    return biz && typeof biz === "object" ? biz : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 排行榜目录（263 款代销产品）内存缓存 30min；拉取失败退回旧缓存
let __fmCatalog = { t: 0, list: null };
async function fmCatalog(transport) {
  if (__fmCatalog.list && Date.now() - __fmCatalog.t < FMBANK_CATALOG_TTL) return __fmCatalog.list;
  const biz = await fmCall(FMBANK_API_RANKING, { client_serial_no: fmSerial() }, transport);
  const list = biz && biz.body && Array.isArray(biz.body.list) ? biz.body.list : null;
  if (list && list.length) __fmCatalog = { t: Date.now(), list };
  return __fmCatalog.list || null;
}

// 产品名归一化：去空白、全角括号转半角、去间隔号
function fmNormName(s) {
  return String(s || "").replace(/\s+/g, "").replace(/（/g, "(").replace(/）/g, ")").replace(/[·・]/g, "");
}

// 内部 product_no 解析（四级降级：已存内部码 → DX 直查 → 静态映射表 → 目录名匹配；见文件头注释）
// 2026-11-02 用户规则：第 1 级为「数据库已落库的 fmInternalCode（DX…）」——添加产品/首次抓取时富民
//   回传内部码，前端存盘；之后刷新直接用它，跳过静态映射表 + 30min 排行榜目录缓存请求。
async function fmResolveCode(code, name, transport, fmInternalCode) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  // 2026-11-02 用户规则：已落库的内部产品码（DX…）优先直接采用，跳过静态映射表 + 30min 目录缓存。
  if (fmInternalCode && String(fmInternalCode).trim().toUpperCase().startsWith("DX")) return String(fmInternalCode).trim().toUpperCase();
  if (c.startsWith("DX")) return c;                   // 已是富民内部码
  if (FMBANK_CODE_MAP[c]) return FMBANK_CODE_MAP[c];  // 静态映射表（登记编码/销售代码双键）
  if (!name) return null;
  const cat = await fmCatalog(transport);
  if (!cat) return null;
  const want = fmNormName(name);
  if (!want) return null;
  for (const it of cat) {                              // ① 归一化全等
    if (fmNormName(it.product_name) === want) return it.product_no;
  }
  if (want.length >= 6) {                              // ② 包含匹配（须唯一候选，防 A/B/C 份额误配）
    const hits = [];
    for (const it of cat) {
      const n = fmNormName(it.product_name);
      if (n && (n.includes(want) || want.includes(n))) hits.push(it.product_no);
    }
    if (hits.length === 1) return hits[0];
  }
  return null;
}

/**
 * 富民银行 App 端口抓取（理财代销 H5 公网网关，免登录，Node/Workers 双端通用）
 * 返回与其它银行端口同构的结果对象；内部码映射未命中 / 全失败返回 null。
 * @param {string} code 产品代码（登记编码 / 销售代码 / 富民内部码均可）
 * @param {{transport?:Function, name?:string}} opts name = 产品名称（目录名匹配用）
 */
async function fminbankAppFetch(code, opts = {}) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  const transport = opts.transport;
  const t0 = Date.now();
  const pno = await fmResolveCode(c, opts.name, transport, opts.fmInternalCode);
  if (!pno) {
    navLog("fminbank app code=" + c + " name=" + (opts.name || "-") + " -> 内部码映射未命中 (" + (Date.now() - t0) + "ms)");
    return null;
  }
  // 【2026-10-23 用户规则】刷信息只刷信息、刷额度只刷额度——两者都不抓净值。
  // 富民 App 端口三接口解耦：detail（信息+额度 residual_amount）/ netList（净值全量）/ achieve（成立日）。
  // info → detail + achieve（成立日属信息）；quota → 只 detail；nav → 只 netList。
  // 2026-11-02 用户规则：nav 模式只抓净值，不调 detail（name/regCode/risk/quota）与 achieve（成立日），
  //   这两类字段一律用数据库已存的 opts.name / opts.regCode（extraOf 已从 registry 透传），不回源富民接口。
  //   唯一仍要解析的是「内部产品码 pno」（靠 FMBANK_CODE_MAP 静态表/缓存目录，零网络或 30min 缓存），
  //   因为 netList 接口只认 pno；但这属于「码解析」而非「探测名字/登记编码」。
  const __mode = opts.mode || "all";
  const __noNav = __mode === "info" || __mode === "quota";
  const __navMode = __mode === "nav";
  // 详情 + 净值 + 历史业绩三并发（业绩仅用于补成立日，失败不致命）；nav 模式只发净值(netList)。
  const [det, net, ach] = await Promise.all([
    __navMode ? Promise.resolve(null) : fmCall(FMBANK_API_DETAIL, { client_serial_no: fmSerial(), product_no: pno, channel_no: FMBANK_CHANNEL_NO }, transport),
    __noNav ? Promise.resolve(null) : fmCall(FMBANK_API_NETLIST, { client_serial_no: fmSerial(), product_no: pno, channel_no: FMBANK_CHANNEL_NO }, transport),
    (__navMode || __mode === "quota") ? Promise.resolve(null) : fmCall(FMBANK_API_ACHIEVE, { params: { client_serial_no: fmSerial() }, product_no: pno }, transport),
  ]);
  const d = (det && det.body && typeof det.body === "object") ? det.body : null;
  // nav 模式不依赖详情：详情缺失（d 为空）但净值仍在，继续往下走；
  // 非 nav 模式详情缺失则视为抓取失败（无身份、无净值源）。
  if (!d && !__navMode) {
    navLog("fminbank app pno=" + pno + " -> 详情失败 (" + (Date.now() - t0) + "ms)");
    return null;
  }
  // 净值序列：netList 正序（旧→新）；做一次容错排序
  const raw = (net && net.body && Array.isArray(net.body.list)) ? net.body.list : [];
  const series = [];
  for (const it of raw) {
    const m = String((it && it.net_date) || "").match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
    const v = Number(it && it.net_value);
    if (m && Number.isFinite(v) && v > 0) series.push([m[1] + "-" + m[2] + "-" + m[3], v]);
  }
  series.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const first = series.length ? series[0] : null;
  const last = series.length ? series[series.length - 1] : null;
  // nav 模式 d 为空：name/regCode 回退数据库已存值（opts.name / opts.regCode，extraOf 已透传）；
  // 非 nav 模式 d 为详情，优先用富民权威字段，缺失才回退库值。
  const name = d ? (d.product_name || d.product_short_name || null) : (opts.name || null);
  const risk = d ? (/^R[1-9]$/.test(String(d.risk_level || "")) ? String(d.risk_level) : null) : null;
  const benchmark = d ? (d.performance_benchmark || null) : null;
  const regCode = d ? (d.product_register_code || null) : (opts.regCode || null);
  // 成立日：历史业绩「成立以来」档的 yield_start_date（如 20250905）；缺位退序列首点
  let established = null, establishedFromSeries = true;
  const achList = (ach && ach.body && Array.isArray(ach.body.list)) ? ach.body.list : [];
  for (const it of achList) {
    const y = String((it && it.yield_start_date) || "");
    if (it && it.label === "成立以来" && /^\d{8}$/.test(y)) {
      established = y.slice(0, 4) + "-" + y.slice(4, 6) + "-" + y.slice(6, 8);
      establishedFromSeries = false;
      break;
    }
  }
  if (!established && first) established = first[0];
  // 最短持有天数：日开/每日开放 → 1；名称「最短持有X天」「X天持有期」→ X
  let holdDays = null;
  if (/日开|每日开放|日日/.test(String(name || ""))) holdDays = 1;
  else {
    const m = String(name || "").match(/最短持有\s*(\d+)\s*天|(\d+)\s*天持有/);
    if (m) holdDays = Number(m[1] || m[2]);
  }
  // 额度/规模/起购：仅详情(detail)提供，nav 模式不抓 -> 全部为 null（符合「nav 只抓净值」）
  let remainQuota = null, quotaState = null, quotaText = null;
  let scale = null, minFirstAmount = null;
  if (d) {
    const residual = Number(d.residual_amount);
    const total = Number(d.product_total);
    const minFirst = Number(d.single_min_buy);
    if (Number.isFinite(residual)) {
      remainQuota = residual;
      quotaState = residual > 0 ? "available" : "sold_out";
      quotaText = "剩余额度 " + (residual >= 1e8 ? (residual / 1e8).toFixed(2) + "亿元" : (residual / 1e4).toFixed(2) + "万元");
    }
    scale = Number.isFinite(total) && total > 0 ? total : null;
    minFirstAmount = Number.isFinite(minFirst) && minFirst > 0 ? minFirst : null;
  }
  // 管理人：端口自带的 product_manager 是权威口径（含 inferManager 提示表外的徽银理财等），
  // 直接采用；仅缺失时按名称推断。
  const manager = d && d.product_manager ? String(d.product_manager) : (name ? inferManager(name) : null);
  navLog("fminbank app pno=" + pno + " -> nav=" + (last ? last[1] : "-") + "@" + (last ? last[0] : "-")
    + " series=" + series.length + " name=" + (name || "-") + " (" + (Date.now() - t0) + "ms)");
  return {
    name,
    manager,
    established, establishedFromSeries,
    series,
    kind: "nav", navBasis: "nav",
    holdDays,
    risk,
    benchmark,
    regCode,
    source: "live",
    bank: "fminbank",
    navVia: "fminbank", navPort: "app", navViaCode: pno,
    navLatest: last ? last[1] : null,
    navDate: last ? last[0] : null,
    latestNav: last ? last[1] : null,
    remainQuota, remainQuotaPct: null,
    saleStatus: null, currency: "CNY",
    quotaState, quotaText,
    scale,
    minFirstAmount,
    infoOnly: series.length < 2,
  };
}

export async function fminbankFetch(code, opts = {}) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  // ① 富民银行 App 端口（理财代销 H5 公网网关，2026-10-19 打通，免登录）
  try {
    const r = await fminbankAppFetch(c, opts);
    if (r && r.series && r.series.length >= 2) return r;
    // 有产品信息但净值不足 2 点（新发/募集期）：带信息返回，让编排层显示名称风险并继续兜底
    if (r && (r.name || r.regCode || r.risk)) return { ...r, series: r.series || [], infoOnly: true };
  } catch (e) { navLog("fminbank app throw " + ((e && e.message) || e)); /* 端口异常 → 回落 XPL */ }
  // ② 回落：中国理财网渠道份额快速通道（XPL = 规则允许的第 3 家，仅已登记份额码生效）
  return xplShareFastLane("fminbank", c, opts);
}

/* ==========================================================================
 * 民生 / 江苏 / 平安 / 东莞 —— 渠道份额产品的「发行方路由」抓取
 *
 * 为什么这四家不走各自官网（实测结论，避免重复踩坑）：
 *   · 民生理财官网 www.cmbcwm.com.cn：产品列表为服务端渲染静态页（/grlc/index.html），
 *     只披露最新单位净值单点，没有「按份额查历史净值」的公开 JSON 接口；
 *   · 苏银理财官网 www.suyinwealth.com：WAF 直接拒绝服务端请求（HTTP 445），无法匿名抓取；
 *   · 平安理财官网：无对外公开的净值查询站点（bank.pingan.com 财富专区需登录态/会话）；
 *   · 东莞银行 www.dongguanbank.cn：官网无理财产品净值披露专区。
 * 而 App 里这几行的入围产品本身就是**大行渠道份额**（如「苏银理财启源现金9号（工行私银专享）」、
 * 「民生理财天天增利现金管理48号（私银）」），理财子作为发行人是法定披露义务人。
 *
 * 故沿用本项目既有模式（与 citic / spdb / nbcb / fminbank 一致）：
 *   净值  —— 由各银行自身端口抓取（上述份额多为工行渠道份额，工行代销池数据经
 *            predict 判定 agent=icbc 后在编排层 icbcLive 命中；本组各 fetch 不再
 *            内部试探其它银行，「只走 3 家」规则 2026-10-15 起 routeViaIssuers 已删除）；
 *   产品  —— 成立日期 / 最短持有天数 / 风险 / 登记编码由 /api/meta 从中国理财网补全，
 *            严格遵守「净值不走中国理财网」的约定，避免额外消耗额度。
 * ========================================================================== */

// 「只走 3 家」规则（2026-10-15）：routeViaIssuers / ISSUER_LANE_TIMEOUT_MS 已删除——
// 各银行 fetch 不再内部试探其它银行，代销阶段缺口统一由编排层中国理财网兜底覆盖。

// 民生银行（cmbc）净值 / 产品抓取。
// 自有接口：www.cmbc.com.cn/gw/po_web/QuerypfpProductTrans.do（神州数码 CSII PE 框架，
//   注意是「表单平铺字段」而非 condition JSON 嵌套——嵌套写法服务端报
//   tesla-parameter-mandatory「输入项[产品类型]为必输值 null」）。
//   · 必填 prodGroup（产品类型）："16"=自营理财，"11"=代销公募理财；二者各含不同产品，
//     故两个分组都试，取首个非空命中。
//   · 成功 returnCode.code==="AAAAAAA"，prodInfoList[0] 含：
//     prodName / issuer / riskLevel("2") / riskLevelName / managerName /
//     nav(单位净值字符串) / navDate("2026-09-28") / totNav(累计净值)。
//   · 仅最新净值「单点」（历史净值在登录态个人网银 SPA 后，无法匿名抓取）→ series 单点。
//   · 自有接口认不得的码（民生渠道里他行理财子发行的份额，如工行私银专享）回退发行方路由。
const CMBC_HOST = "https://www.cmbc.com.cn";
const CMBC_TRANS_EP = CMBC_HOST + "/gw/po_web/QuerypfpProductTrans.do";

function cmbcRiskToR(t) {
  const n = String(t || "").replace(/[^0-9]/g, "");
  return n ? "R" + n : null;
}
function cmbcNormDate(s) {
  const d = String(s || "").replace(/[^0-9]/g, "");
  const m = d.match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// 民生自有产品/净值接口（仅最新净值单点）。命中返回标准结构，未命中返回 null。
async function minshengApi(code, opts = {}) {
  const transport = opts.transport;
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  for (const grp of ["16", "11"]) {
    const body = new URLSearchParams({
      prodGroup: grp, prodCode: c, prodName: "", index: "1", dataSize: "20",
    }).toString();
    let json = null;
    try {
      const res = await nyHttp(CMBC_TRANS_EP, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Accept: "application/json, text/plain, */*",
          Origin: CMBC_HOST,
          Referer: CMBC_HOST + "/",
        },
        body,
      }, transport);
      if (!res || !res.ok) continue;
      const txt = await res.text();
      try { json = JSON.parse(txt); } catch { json = null; }
    } catch (e) { continue; }
    if (!json || !json.prodInfoList || !json.prodInfoList.length) continue;
    if (json.returnCode && json.returnCode.code && json.returnCode.code !== "AAAAAAA") continue;
    const p = json.prodInfoList[0];
    const name = p.prodName || null;
    if (!name) continue;
    const nav = parseFloat(p.nav);
    const dt = cmbcNormDate(p.navDate);
    const series = (dt && Number.isFinite(nav) && nav > 0) ? [[dt, Number(nav.toFixed(8))]] : [];
    return {
      name,
      manager: p.managerName || p.issuer || null,
      established: null,
      series,
      kind: "nav",
      risk: cmbcRiskToR(p.riskLevel),
      benchmark: null,
      holdDays: null,
      regCode: null,
      navVia: "cmbc",
      navPort: "web",
      source: "live-cmbc",
      infoOnly: series.length === 0,
    };
  }
  return null;
}

/* ==========================================================================
 * 民生银行（CMBC）历史净值直连 —— 民生理财官网 www.cmbcwm.com.cn
 *
 * 背景：此前 cmbcFetch 只能拿到「最新净值单点」——
 *   www.cmbc.com.cn/gw/po_web/QuerypfpProductTrans.do 的 prodInfoList 只带 nav/navDate，
 *   旧注释认为「历史净值在登录态个人网银 SPA 后，无法匿名抓取」。
 * 实测民生理财官网（cmbcwm.com.cn，App 与官网同源且**免登录**）已公开两个 JSON 交易：
 *   ① 产品信息：POST /gw/po_web/BTAProductQry
 *      参数 prd_type(0=个人/1=机构) & pageNo & pageSize & code_or_name=<产品码>
 *      list[] 含 PRD_NAME / REAL_PRD_CODE(销售码) / RISK_LEVEL / ESTAB_DATE /
 *             SUB_SHARE_ESTAB_DATE(份额成立日) / BENCHMARK_CUSTO(业绩基准) /
 *             TBPRDEXTEND_DEBT_REGIST_CODE(登记编码) / NAV / NAV_DATE
 *   ② 历史净值：POST /gw/po_web/BTADailyQry
 *      参数 chart_type=0 & real_prd_code=<产品码> & begin_date= & end_date=
 *      → list[] **按日正序**（从份额成立日起），字段：
 *        ISS_DATE(YYYYMMDD) / NAV(单位净值) / TOT_NAV(累计) / INCOME / WEEK_CLIENTRATE
 *      ⚠ chart_type=1 是「图表+分页倒序」口径，返回字段改名为 btaDailyAddFieldList 且
 *        默认只给最新 10 条；这里固定用 chart_type=0 一次性取全序列（实测 1272 条）。
 *
 * TLS 注意事项（与工行 papi 同源的老问题）：
 *   cmbcwm.com.cn 握手走「旧版不安全重协商」，OpenSSL 3 默认禁止 → Node 全局 fetch 报
 *   ERR_SSL_UNSAFE_LEGACY_RENEGOTIATION_DISABLED。本地 serve.mjs 注入的 nodeTransport
 *   已带 secureOptions: SSL_OP_LEGACY_SERVER_CONNECT，故直接 nyHttp(…, transport) 即可；
 *   Workers 出网由 Cloudflare 自有 TLS 栈处理，不受此限制。
 *   若两端都失败（网络不通 / 接口变更），cmbcFetch 会依次回落到 minshengApi 单点与
 *   发行方路由，不会比改之前更差。
 * ========================================================================== */
const CMBCWM_HOST = "https://www.cmbcwm.com.cn";
const CMBCWM_API = CMBCWM_HOST + "/gw/po_web";
const CMBCWM_REF = CMBCWM_HOST + "/cmbcwm/grlc/cpxq/index.html";
const CMBCWM_TIMEOUT_MS = 20000;

// 民生理财官网通用交易调用：成功返回 JSON（returnCode.code === "AAAAAAA"），否则 null
async function cmbcWmRaw(txn, params, transport) {
  const body = new URLSearchParams(params).toString();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CMBCWM_TIMEOUT_MS);
  try {
    const res = await nyHttp(CMBCWM_API + "/" + txn, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Accept: "application/json, text/plain, */*",
        "User-Agent": UA,
        Origin: CMBCWM_HOST,
        Referer: CMBCWM_REF,
      },
      body,
      signal: ctrl.signal,
    }, transport);
    if (!res || !res.ok) return null;
    const j = await res.json();
    if (!j || !j.returnCode || j.returnCode.code !== "AAAAAAA") return null;
    return j;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 产品信息：按销售码精确命中 REAL_PRD_CODE（个人 / 机构两组都试）
async function cmbcWmInfo(code, transport) {
  for (const pt of ["0", "1"]) {
    const j = await cmbcWmRaw("BTAProductQry",
      { prd_type: pt, pageNo: "1", pageSize: "20", code_or_name: code }, transport);
    const list = j && Array.isArray(j.list) ? j.list : null;
    if (!list || !list.length) continue;
    const hit = list.find((x) => String(x.REAL_PRD_CODE || "").toUpperCase() === code);
    if (hit) return hit;
  }
  return null;
}

// 历史净值序列：iss_date 正序 → { series:[[YYYY-MM-DD, nav], ...], kind, navBasis }
// 【项目规则 2026-10-21 立】现金管理类（如天天增利现金管理：NAV 恒为 1.0，真实收益在
// INCOME 万份收益）一律不抓：历史上的「从 1.0 复利合成 + navBasis:"wan"」处理已删除，
// 命中现金判据直接返回空序列并标 cash，上层据此排除。
async function cmbcWmNav(code, transport) {
  const j = await cmbcWmRaw("BTADailyQry",
    { chart_type: "0", real_prd_code: code, begin_date: "", end_date: "" }, transport);
  const rows = j && Array.isArray(j.list) ? j.list : null;
  if (!rows) return { series: [], kind: "nav", navBasis: "nav" };
  const pts = [];
  for (const r of rows) {
    const d = cmbcNormDate(r.ISS_DATE);
    const v = parseFloat(r.NAV);
    if (d && Number.isFinite(v) && v > 0) pts.push({ d, nav: v });
  }
  if (!pts.length) return { series: [], kind: "nav", navBasis: "nav" };
  pts.sort((a, b) => (a.d < b.d ? -1 : 1));
  // 现金管理类判据（与 BOC/CCB 同源）：单位净值整段恒为 1（±1e-4）且有万份收益
  const navFlat = pts.every((p) => Math.abs(p.nav - 1) < 1e-4);
  if (navFlat) return { series: [], kind: "nav", navBasis: "nav", cash: true };
  const series = pts.map((p) => [p.d, Number(p.nav.toFixed(8))]);
  return { series, kind: "nav", navBasis: "nav" };
}

// 最短持有天数：CYCLE_DAYS + CYCLE_UNIT（0天/1周/2月/3季/4半年/5年）优先，其次按产品名推断
// 口径与 app 端 typeToQixian 对齐：期限型产品「最短持有{CYCLE_DAYS}{单位}」；日开/现金管理无持有期。
function cmbcHoldDays(name, fd) {
  const cyc = Number(fd && fd.CYCLE_DAYS);
  if (fd && Number.isFinite(cyc) && cyc > 0) {
    const mult = { "0": 1, "1": 7, "2": 30, "3": 90, "4": 180, "5": 365 }[String(fd.CYCLE_UNIT || "0")] || 1;
    const days = Math.round(cyc * mult);
    if (days > 0) return days;
  }
  const n = String(name || "");
  const m = n.match(/(\d{1,4})\s*天持有/);
  if (m) return Number(m[1]);
  if (/日开|天天|每日开放|现金管理|活期/.test(n)) return 1;
  const c = n.match(/封闭\s*(\d{1,4})\s*天/);
  if (c) return Number(c[1]);
  if (fd && String(fd.OPEN_DAYS) === "1" && !/封闭/.test(n)) return 1;
  return null;
}
// 兼容旧调用点（民生理财官网 BTAProductQry 无 CYCLE_DAYS 字段，走名称推断分支）
function cmbcWmHoldDays(name, info) {
  return cmbcHoldDays(name, { CYCLE_DAYS: 0, OPEN_DAYS: info && info.OPEN_DAYS });
}

/* ==========================================================================
 * 民生银行 App 端口（m1.cmbc.com.cn/gw/m_app，2026-10-16 打通，免登录）
 *
 * 背景：手机银行 / 微信分享的「产品详情」页（fund-commission/details?prdCode=…）走
 *   移动端网关，匿名可访问。前置条件（缺一不可，已 A/B 实测）：
 *    ① 移动端 UA——桌面 UA 会被页面拦成「请在手机端打开本页面」，网关回 IGW0002；
 *    ② 先经 CDP 无头 Chrome 打开分享页，抓到页面真实报文头（Origin/Referer/Content-Type
 *       与 JSON 信封 {request:{header:{appId:"",appVersion:"web",appExt:"999",…},body:{…}}}）。
 *   本机 Node/undici 直连该域被 TLS 重置（ECONNRESET），本地经 nodeTransport 握手；
 *   Cloudflare Workers 出网走自家 TLS 栈，无需该选项。
 *
 * 三个服务（均 form=JSON，免登录，prodCode 不认识时回 PeException「无此产品信息」）：
 *   · FinFundDetailInfo.do   {prdCode} → fundDetail 全字段：PRD_NAME / TA_NAME(管理人) /
 *     NAV / NAV_DATE / TOT_NAV / RISK_LEVEL+ RISK_LEVEL_NAME / COM_PARISON(业绩基准) /
 *     ASSO_CODE(登记编码) / ES_TAB_DATE(成立日) / CYCLE_DAYS+CYCLE_UNIT(最短持有) /
 *     PRD_ATTR_NAME(代销理财-净值型) / STATUS_NAME(开放期) / PFIRST_AMT(起购) /
 *     CURR_TYPE_NAME(币种) / CHANNELS_NAME / CLIENT_GROUPS_NAME(客群)
 *   · FundKline.do           {prdCode, timeScope:"3"} → resultMap.assemData:
 *     [[YYYYMMDD, nav, totNav], …] 成立以来全量净值（timeScope 0=近1周/1=近1月/2=近3月/3起=全部）
 *   · QueryLimitByPrdCode.do {prdCode} → resultMap.TotSaleAmt = 剩余额度(元)
 *     （代销理财剩余额度查询开关 FundQryBaseConfig 默认开；登录态之外的额度通道）
 * 覆盖边界：仅「民生代销/本行在售」产品有数据（天然充当「本行是否销售」判据）；
 *   自营（民生理财 TA_NAME）产品该网关回「无此产品」，回落民生理财官网 cmbcwm。
 * ========================================================================== */
const CMBC_APP_HOST = "https://m1.cmbc.com.cn";
const CMBC_APP_EP = CMBC_APP_HOST + "/gw/m_app/";
const CMBC_APP_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.42(0x18002a2f) NetType/WIFI Language/zh_CN";
const CMBC_APP_REF = CMBC_APP_HOST + "/CMBC_MBServer/new/app/mobile-bank/fund-commission/details";
const CMBC_APP_TIMEOUT_MS = 20000;

async function cmbcAppRaw(svc, body, transport) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CMBC_APP_TIMEOUT_MS);
  try {
    const res = await nyHttp(CMBC_APP_EP + svc + ".do", {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        Accept: "application/json, text/plain, */*",
        Origin: CMBC_APP_HOST,
        Referer: CMBC_APP_REF,
        "User-Agent": CMBC_APP_UA,
      },
      body: JSON.stringify({
        request: {
          header: { appId: "", appVersion: "web", appExt: "999", device: { appExt: "999", osType: "01", osVersion: "", uuid: "" } },
          body: body || {},
        },
      }),
      signal: ctrl.signal,
    }, transport);
    if (!res || !res.ok) return null;
    const txt = await res.text();
    try { return JSON.parse(txt); } catch { return null; }
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ① 产品详情（信息六项 + 净值单点 + 状态）
async function cmbcAppInfo(code, transport) {
  const j = await cmbcAppRaw("FinFundDetailInfo", { prdCode: code }, transport);
  const fd = j && j.response && j.response.fundDetail;
  if (!fd || !fd.PRD_NAME) return null;
  return fd;
}

// ② 成立以来全量净值序列。募集期占位点（成立前 nav 恒 1）裁掉，与其它银行「成立以来」口径一致。
async function cmbcAppNav(code, established, transport) {
  const j = await cmbcAppRaw("FundKline", { prdCode: code, timeScope: "3" }, transport);
  const rows = j && j.response && j.response.resultMap && j.response.resultMap.assemData;
  if (!Array.isArray(rows) || !rows.length) return { series: [], kind: "nav", navBasis: "nav" };
  const pts = [];
  for (const r of rows) {
    const d = cmbcNormDate(r && r[0]);
    const nav = parseFloat(r && r[1]);
    const tot = parseFloat(r && r[2]);
    if (d && Number.isFinite(nav) && nav > 0) pts.push({ d, nav, tot: Number.isFinite(tot) ? tot : nav });
  }
  if (!pts.length) return { series: [], kind: "nav", navBasis: "nav" };
  pts.sort((a, b) => (a.d < b.d ? -1 : 1));
  // 【项目规则 2026-10-21 立】现金管理类：nav 恒 1 而累计净值递增 → 一律排除。
  // 历史上的「取 TOT_NAV 作展示序列（navBasis:"tot"）」现金类处理已删除：
  // 标记 cash 让上层直接返回 null，不做任何展示序列合成，勿再 reintroduce。
  const flatNav = pts.every((p) => Math.abs(p.nav - 1) < 1e-4);
  const totVar = pts.some((p) => Math.abs(p.tot - 1) > 1e-4);
  if (flatNav && totVar) return { series: [], kind: "nav", navBasis: "nav", cash: true };
  let out = pts.filter((p) => {
    return !(established && p.d < established && Math.abs(p.nav - 1) < 1e-4);
  }).map((p) => [p.d, Number(p.nav.toFixed(8))]);
  if (!out.length) out = pts.map((p) => [p.d, Number(p.nav.toFixed(8))]);
  return { series: out, kind: "nav", navBasis: "nav" };
}

// ③ 剩余额度（元）
async function cmbcAppQuota(code, transport) {
  const j = await cmbcAppRaw("QueryLimitByPrdCode", { prdCode: code }, transport);
  const rm = j && j.response && j.response.resultMap;
  const raw = rm && rm.TotSaleAmt;
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

const CMBC_APP_CURR = { 人民币: "CNY", 美元: "USD", 港元: "HKD", 欧元: "EUR", 英镑: "GBP", 日元: "JPY", 澳元: "AUD", 加元: "CAD" };

// App 端口一键抓取：详情 + 全量净值 + 额度（三并行）。净值≥2 点才算可用（单点不采用，交由编排层续走）。
async function cmbcAppFetch(code, transport, mode = "all") {
  // 2026-10-22 拆分：nav 模式只抓净值——跳过产品信息(cmbcAppInfo)与额度(cmbcAppQuota)两路并行请求
  // 【2026-10-23 用户规则】刷信息只刷信息、刷额度只刷额度——两者都不抓净值（跳过 cmbcAppNav）。
  const __navOnly = mode === "nav";
  const __infoOnly = mode === "info";
  const __noNav = __infoOnly || mode === "quota";
  const [fd, nav, quota] = await Promise.all([
    __navOnly ? Promise.resolve(null) : cmbcAppInfo(code, transport).catch(() => null),
    __noNav ? Promise.resolve({ series: [], kind: "nav", navBasis: "nav" }) : cmbcAppNav(code, null, transport).catch(() => ({ series: [], kind: "nav", navBasis: "nav" })),
    (__navOnly || __infoOnly) ? Promise.resolve(null) : cmbcAppQuota(code, transport).catch(() => null),
  ]);
  if (!fd && !(nav && nav.series && nav.series.length)) return null;
  // 【项目规则 2026-10-21】现金管理类（nav 恒 1 + 累计净值递增）不抓：
  // 返回哨兵（产品信息也不收录），交编排层下发 isCash 让前端提示原因。
  if (nav && nav.cash) return { _excludedCash: true, code };
  const established = cmbcNormDate(fd && (fd.ES_TAB_DATE || fd.IPO_START_DATE));
  // 成立日已知后重裁募集期占位点（上面并行时还不知道成立日）
  let series = nav.series || [];
  if (established && series.length) {
    const trimmed = series.filter((p) => !(p[0] < established && Math.abs(p[1] - 1) < 1e-4));
    if (trimmed.length) series = trimmed;
  }
  const name = (fd && fd.PRD_NAME) || null;
  const last = series.length ? series[series.length - 1] : null;
  const remainQuota = quota;
  const base = {
    name,
    manager: (fd && fd.TA_NAME) || null,
    established: established || (series.length ? series[0][0] : null),
    establishedFromSeries: !established, // ES_TAB_DATE/IPO_START_DATE 缺位时退序列首点
    risk: cmbcRiskToR(fd && (fd.RISK_LEVEL_NAME || fd.RISK_LEVEL)),
    benchmark: (fd && fd.COM_PARISON) || null,
    holdDays: cmbcHoldDays(name, fd),
    regCode: (fd && fd.ASSO_CODE) || null,
    series,
    kind: (nav && nav.kind) || "nav",
    navBasis: (nav && nav.navBasis) || "nav",
    source: "live",
    bank: "cmbc",
    navVia: "cmbc",
    navPort: "app",
    navViaCode: code,
    navLatest: last ? last[1] : (fd && fd.NAV != null ? Number(fd.NAV) : null),
    navLatestDate: last ? last[0] : cmbcNormDate(fd && fd.NAV_DATE),
    // 附加可见信息（详情页展示用）
    appStatus: (fd && fd.STATUS_NAME) || null,
    appPrdAttr: (fd && fd.PRD_ATTR_NAME) || null,
    appMinAmt: (fd && fd.PFIRST_AMT != null) ? Number(fd.PFIRST_AMT) : null,
    appClientGroups: (fd && fd.CLIENT_GROUPS_NAME) || null,
  };
  if (remainQuota != null) {
    base.remainQuota = remainQuota;
    base.currency = CMBC_APP_CURR[(fd && fd.CURR_TYPE_NAME) || ""] || (fd && fd.CURR_TYPE_NAME) || null;
    base.quotaState = remainQuota > 0 ? "available" : "sold_out";
    base.saleStatus = null;
  }
  if (series.length < 2) base.infoOnly = true;
  return base;
}

// 民生银行入口（2026-10-16 用户规则：抓净值和信息先走 app 端口）：
//   ① App 端口（m1.cmbc.com.cn/gw/m_app，免登录）：全量净值 + 产品信息 + 剩余额度，一次三并行
//   ② 民生理财官网直连（自营产品完整历史净值；App 端口对自营产品回「无此产品」）
//   ③ cmbc.com.cn 自有接口（仅最新净值单点）
//   ④ 发行方路由 / 中国理财网 xpl 兜底
export async function cmbcFetch(code, opts = {}) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  const transport = opts && opts.transport;

  // ① App 端口（优先）：净值序列 + 产品信息 + 剩余额度
  try {
    const r = await cmbcAppFetch(c, transport, opts.mode || "all");
    // 现金管理类哨兵：透传给编排层（不回落官网，避免官网信息把现金类重新收录）
    if (r && r._excludedCash) return r;
    if (r && r.series && r.series.length >= 2) return r;
    // 有产品信息但净值不足 2 点（新发/募集期）：带信息返回，让编排层显示名称风险并继续兜底
    if (r && (r.name || r.regCode || r.risk)) return { ...r, series: r.series || [], infoOnly: true };
  } catch (e) { /* App 端口异常，回落官网 */ }

  // ② 民生理财官网直连：净值序列 + 产品信息并行取（自营产品；App 端口对自营回「无此产品」）
  try {
    const __navOnly = (opts.mode || "all") === "nav";
    // 【2026-10-23 用户规则】info/quota 不抓净值——cmbcWmNav 是民生理财官网的全量净值序列，整段跳过。
    const __noNav = opts.mode === "info" || opts.mode === "quota";
    const [wm, info] = await Promise.all([
      __noNav ? Promise.resolve(null) : cmbcWmNav(c, transport).catch(() => null),
      __navOnly ? Promise.resolve(null) : cmbcWmInfo(c, transport).catch(() => null),
    ]);
    const series = wm && wm.series;
    const name = (info && (info.PRD_NAME || info.PRD_NAME2)) || null;
    // 【项目规则 2026-10-21】现金管理类（nav 恒 1 + 万份收益）不抓：返回哨兵，
    // 交编排层下发 isCash 让前端提示原因（此前返回 null 会被当成「未收录」）。
    if (wm && wm.cash) return { _excludedCash: true, code: c };
    if (series && series.length) {
      const last = series[series.length - 1];
      return {
        name,
        manager: (name && MANAGER_HINTS.some(([kw]) => name.includes(kw))) ? inferManager(name) : "民生理财",
        established: (info && cmbcNormDate(info.SUB_SHARE_ESTAB_DATE || info.ESTAB_DATE)) || series[0][0] || null,
        establishedFromSeries: !(info && cmbcNormDate(info.SUB_SHARE_ESTAB_DATE || info.ESTAB_DATE)), // 详情口无成立日字段时退序列首点
        series,
        kind: (wm && wm.kind) || "nav",
        navBasis: (wm && wm.navBasis) || "nav",
        risk: cmbcRiskToR(info && info.RISK_LEVEL),
        benchmark: (info && info.BENCHMARK_CUSTO) || null,
        holdDays: cmbcWmHoldDays(name, info),
        regCode: (info && info.TBPRDEXTEND_DEBT_REGIST_CODE) || null,
        source: "live",
        bank: "cmbc",
        navVia: "cmbcwm",
        navPort: "web",
        navViaCode: c,
        navLatest: last[1],
        navLatestDate: last[0],
      };
    }
    // 序列为空但认得产品（新发 / 募集期尚未披露净值）：返回产品信息，让上层能显示名称风险
    if (info) {
      return {
        name,
        manager: (name && MANAGER_HINTS.some(([kw]) => name.includes(kw))) ? inferManager(name) : "民生理财",
        established: cmbcNormDate(info.SUB_SHARE_ESTAB_DATE || info.ESTAB_DATE) || null,
        series: [],
        kind: "nav",
        risk: cmbcRiskToR(info.RISK_LEVEL),
        benchmark: info.BENCHMARK_CUSTO || null,
        holdDays: cmbcWmHoldDays(name, info),
        regCode: info.TBPRDEXTEND_DEBT_REGIST_CODE || null,
        source: "live",
        bank: "cmbc",
        navVia: "cmbcwm",
        navPort: "web",
        navViaCode: c,
        infoOnly: true,
      };
    }
  } catch (e) { /* 直连异常，回落到下面的单点/路由 */ }

  // ③ cmbc.com.cn 自有接口（仅最新净值单点）
  try {
    const r = await minshengApi(c, opts);
    if (r) return { ...r, bank: "cmbc" };
  } catch (e) { /* 自有接口异常，回退发行方路由 */ }

  // ④「只走 3 家」规则（2026-10-15）：民生自有源取不到时，仅保留中国理财网信息披露平台
  // （XPL = 规则允许的第 3 家）作为代销阶段兜底，不再试探工行/招行等其它银行。
  return xplShareFastLane("cmbc", c, opts);
}

export async function jsbFetch(code, opts = {}) {
  // 江苏银行 App 端口（mbank5h5 H5，2026-10-18 打通 + 二次打通）：经页面内 YT.ajaxData 直连，
  //   全量净值序列 + 七字段 + 额度 + 登记编码；免登录、免签名。
  //   ① 传了分享链接 → 解析其中 prdCode 后按码直查（兼容旧调用）；
  //   ② 未传链接 → 直接用产品代码直查（★常规路径：/api/product /api/fetch 走这里）。
  //   硬约束：App 端口是唯一直连通道，禁止走中国理财网兜底；Chrome 不可用时返回 null 优雅失败。
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  let r = null;

  // ── 线上 Worker 路径（2026-10-29 新增）：Cloudflare Browser Rendering ──
  // 江苏银行全线（mbank5h5 H5 / www 官网 / 苏银理财官网）都挂同一套 WAF：
  //   首访 202/412/445 + JS 挑战页 → 挑战脚本是多层 eval 虚拟机 → 解出
  //   cookie + **每个请求都要带的 URL 签名 XhC8Wb**；实测不带签名的请求，
  //   一次挑战只放行第 1 个，之后全 202。而 Workers 禁止 eval()/new Function，
  //   所以纯 fetch 必然失败 —— 只能在 Worker 里驱动真 Chromium（Browser Rendering）。
  // 本机 Node 走下面的本机 Chrome 路径（本机有 Chrome，行为一致）。
  const env = getWorkerEnv();
  if (env && env.BROWSER) {
    try {
      const connect = makeBrowserBindingConnector(env, "BROWSER");
      r = await jsbBrowserFetch(c, { connect });
    } catch (e) {
      r = null;
    }
  }

  if (!r && opts && (opts.jsbShareUrl || opts.shareUrl)) {
    r = await jsbAppFetch(opts.jsbShareUrl || opts.shareUrl, opts);
  }
  if (!r) r = await jsbAppFetchByCode(c, opts);
  // 【2026-10-23 用户规则】刷信息只刷信息、刷额度只刷额度——两者都不抓净值。
  // 江苏银行只有一条通道（页面内 YT.ajaxData 抓取，净值+七字段+额度一次拿全），
  // 协议层无法只取一半；故按 mode 丢弃序列，保证刷信息/刷额度不回传、不落库净值。
  if (r && (opts.mode === "info" || opts.mode === "quota")) return { ...r, series: [], infoOnly: true };
  return r;
}

/* ==========================================================================
 * 平安银行（PINGAN）实时抓取 —— 直连平安网端/App 同源 H5 接口
 *
 * 背景：用户明确要求「在平安银行 web 端或 app 端抓净值，不要在中国理财网抓净值」。
 * 平安口袋银行 H5 详情页（b.pingan.com.cn/fin/mobile/finance_regular_detail.html）
 * 与 App 共用同一套后端，且免登录即可取到净值序列，故逆向其两个公开接口作为直连源。
 *
 * ① 产品详情：
 *      GET https://b.pingan.com.cn/bron/ibank/pop/cdn/finachild/finacDetail.do
 *          ?prdCode=<码>&access_source=H5
 *      关键字段：data.prdName（产品全称）、data.riskLevel（"1".."5"）、
 *               data.latestRate.nav（最新单位净值）、
 *               data.latestRate.fromEstablishIncrease（成立以来涨幅 %）、
 *               data.saleStartDate（募集起始日）
 *
 * ② 净值序列（成立以来，dateType=9 为最大区间）：
 *      GET https://b.pingan.com.cn/bron/ibank/pop/cdn/finachild/queryFinaChildNavIncrease.do
 *          ?prdCode=<码>&dateType=9&withIndex=true&access_source=H5
 *      返回：data.date[]（YYYYMMDD）+ data.navIncrease[]（成立以来**累计涨幅 %**）
 *
 * ⚠️ 关键推导：平安 H5 只公开「成立以来涨幅」，不公开绝对净值序列。但净值型产品初始
 *    单位净值为 1.0000，故可用最新净值反解基准：
 *        base = latestRate.nav / (1 + inc_last/100)
 *        nav_i = base * (1 + inc_i/100)
 *    实测 XCTLG2702A：base = 1.000000（精确等于 1），末点还原 1.0228 = 官方
 *    latestRate.nav，与 fromEstablishIncrease=2.28% 完全自洽。若某产品初始值非 1，
 *    该公式仍能靠 latestRate.nav 自动校准，无需硬编码 1.0。
 *
 * ③ 补充（成立日）：
 *      GET https://rmb.pingan.com.cn/bron/ibank/pop/fund/bootpage/queryPrdAttachedFile.do
 *          ?prdCode=<码>&prdType=20&attachType=11&access_source=H5
 *      → data.prdInfo.establishDate（YYYYMMDD）。失败不致命，回落到序列首日。
 * ========================================================================== */
const PINGAN_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const PINGAN_REF = "https://b.pingan.com.cn/fin/mobile/finance_regular_detail.html";

async function pinganGet(url, transport, timeout = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await nyHttp(url, {
      headers: { "User-Agent": PINGAN_UA, Referer: PINGAN_REF, Accept: "application/json, text/plain, */*" },
      signal: ctrl.signal,
    }, transport);
    if (!res || !res.ok) return null;
    return await res.json().catch(() => null);
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 风险等级 "1".."5" → R1..R5
function pinganRiskToR(level) {
  const n = Number(level);
  if (!Number.isFinite(n) || n < 1 || n > 5) return null;
  return "R" + Math.round(n);
}

// 最短持有天数：平安产品名形如「…日开270天持有2号A」
// 详情里的 indexContentSecond（形如 "270天"）比名称更权威，故优先用它
function pinganHoldDays(name, indexContentSecond) {
  const rawName = String(name || "");
  const m = rawName.match(/(\d+)\s*天持有/);
  const m2 = String(indexContentSecond || "").match(/^(\d+)\s*天$/);
  if (m2) return Number(m2[1]);
  if (m) return Number(m[1]);
  // 2026-10-23：官网给的是「7天(含)以内」这种区间写法，取其中数字
  const m3 = String(indexContentSecond || "").match(/(\d+)\s*天/);
  return m3 ? Number(m3[1]) : null;
}

/* ==========================================================================
 * 平安理财官网端口（wm.pingan.com）—— 2026-10-23 接入
 *
 * 用户报障：QWCG00728A「安稳启元稳利日开7天持有28号A」官网 10-23 已披露
 * 单位净值 1.0359，我们只到 10-22。
 *
 * 【根因】此前只走平安口袋银行 H5（b.pingan.com.cn，见下方「平安银行」段），
 *   该端口比发行人官网慢一个披露日；且它**只公开「成立以来涨幅 %」**，净值是靠
 *   `base = latestNav/(1+inc/100)` 反解重建的（QWCG00728A 首日被算成 1.0000，
 *   官网真实首日是 1.0002），既慢又系统性失真。
 *
 * 【官网接口（2026-10-23 逆向，免登录）】
 *   网关 host = https://wmm.pingan.com.cn/app（SPA 里 gw.host / intfgwHost 同值）
 *   ① GET  /product/getProductInfo?productCode=<份额码>   ← 明文，免鉴权
 *        productName/productSname、registerCode（份额访问码）、productRiskRating（"2"→R2）、
 *        establishmentDay（成立日）、perComBen（业绩比较基准）、maturityVarietyTxt（"7天(含)以内"）、
 *        isCashManagementCategory、incurredStatus 等。
 *   ② POST /nvl/getNvlView  {productId,pageNum:0,pageSize:0,currentTimeMillis,uuid}
 *        返回**成立以来全量**单位净值（升序，dataDate/unitValue/cumulativeValue），含当日。
 *   ③ POST /nvl/getNvlShow  {同上,pageNum,pageSize}  分页版（我们只用 ②，一次拿全）。
 *
 * 【加密】②③ 的请求体是 **SM4-ECB + PKCS#7，输出 hex 字符串**（不是 JSON）：
 *   - key = "B34440569682494CCADDAA9D603961D2"（SPA 模块 221 的 t.d）
 *   - 载荷 = JSON.stringify({...业务字段, currentTimeMillis: 毫秒时间戳, uuid: 随机串})
 *     缺 currentTimeMillis → "请求参数随机因子为空"；缺 uuid → 同样报该错。
 *     时间戳只要在合理窗口内即可（实测本地 Date.now() 与「减 1 天」都通过，填 123 报
 *     "300315 illegal request"），故无需再打 /common/getCurrentTimeMillis 多一次往返。
 *   - 响应是明文 JSON，无需解密。
 *   本文件内置纯 JS SM4（见下），**不依赖 OpenSSL 的 sm4-ecb**，Node 与 Workers 双端可用
 *   （Web Crypto 不支持 SM4）。
 * ========================================================================== */
const PINGAN_WM_GW = "https://wmm.pingan.com.cn/app";
const PINGAN_WM_REF = "https://wm.pingan.com/";
const PINGAN_WM_KEY = "B34440569682494CCADDAA9D603961D2";

// ---- 纯 JS SM4（ECB / PKCS#7 / hex 输出）----
const PINGAN_SM4_SBOX = new Uint8Array([
  0xd6, 0x90, 0xe9, 0xfe, 0xcc, 0xe1, 0x3d, 0xb7, 0x16, 0xb6, 0x14, 0xc2, 0x28, 0xfb, 0x2c, 0x05,
  0x2b, 0x67, 0x9a, 0x76, 0x2a, 0xbe, 0x04, 0xc3, 0xaa, 0x44, 0x13, 0x26, 0x49, 0x86, 0x06, 0x99,
  0x9c, 0x42, 0x50, 0xf4, 0x91, 0xef, 0x98, 0x7a, 0x33, 0x54, 0x0b, 0x43, 0xed, 0xcf, 0xac, 0x62,
  0xe4, 0xb3, 0x1c, 0xa9, 0xc9, 0x08, 0xe8, 0x95, 0x80, 0xdf, 0x94, 0xfa, 0x75, 0x8f, 0x3f, 0xa6,
  0x47, 0x07, 0xa7, 0xfc, 0xf3, 0x73, 0x17, 0xba, 0x83, 0x59, 0x3c, 0x19, 0xe6, 0x85, 0x4f, 0xa8,
  0x68, 0x6b, 0x81, 0xb2, 0x71, 0x64, 0xda, 0x8b, 0xf8, 0xeb, 0x0f, 0x4b, 0x70, 0x56, 0x9d, 0x35,
  0x1e, 0x24, 0x0e, 0x5e, 0x63, 0x58, 0xd1, 0xa2, 0x25, 0x22, 0x7c, 0x3b, 0x01, 0x21, 0x78, 0x87,
  0xd4, 0x00, 0x46, 0x57, 0x9f, 0xd3, 0x27, 0x52, 0x4c, 0x36, 0x02, 0xe7, 0xa0, 0xc4, 0xc8, 0x9e,
  0xea, 0xbf, 0x8a, 0xd2, 0x40, 0xc7, 0x38, 0xb5, 0xa3, 0xf7, 0xf2, 0xce, 0xf9, 0x61, 0x15, 0xa1,
  0xe0, 0xae, 0x5d, 0xa4, 0x9b, 0x34, 0x1a, 0x55, 0xad, 0x93, 0x32, 0x30, 0xf5, 0x8c, 0xb1, 0xe3,
  0x1d, 0xf6, 0xe2, 0x2e, 0x82, 0x66, 0xca, 0x60, 0xc0, 0x29, 0x23, 0xab, 0x0d, 0x53, 0x4e, 0x6f,
  0xd5, 0xdb, 0x37, 0x45, 0xde, 0xfd, 0x8e, 0x2f, 0x03, 0xff, 0x6a, 0x72, 0x6d, 0x6c, 0x5b, 0x51,
  0x8d, 0x1b, 0xaf, 0x92, 0xbb, 0xdd, 0xbc, 0x7f, 0x11, 0xd9, 0x5c, 0x41, 0x1f, 0x10, 0x5a, 0xd8,
  0x0a, 0xc1, 0x31, 0x88, 0xa5, 0xcd, 0x7b, 0xbd, 0x2d, 0x74, 0xd0, 0x12, 0xb8, 0xe5, 0xb4, 0xb0,
  0x89, 0x69, 0x97, 0x4a, 0x0c, 0x96, 0x77, 0x7e, 0x65, 0xb9, 0xf1, 0x09, 0xc5, 0x6e, 0xc6, 0x84,
  0x18, 0xf0, 0x7d, 0xec, 0x3a, 0xdc, 0x4d, 0x20, 0x79, 0xee, 0x5f, 0x3e, 0xd7, 0xcb, 0x39, 0x48,
]);
const PINGAN_SM4_FK = [0xa3b1bac6, 0x56aa3350, 0x677d9197, 0xb27022dc];
const PINGAN_SM4_CK = (() => {
  const a = new Uint32Array(32);
  for (let i = 0; i < 32; i++) {
    a[i] =
      (((4 * i) * 7) & 0xff) * 0x1000000 +
      (((4 * i + 1) * 7) & 0xff) * 0x10000 +
      (((4 * i + 2) * 7) & 0xff) * 0x100 +
      (((4 * i + 3) * 7) & 0xff);
  }
  return a;
})();
let PINGAN_SM4_RK = null;

function pinganSm4RoundKeys() {
  if (PINGAN_SM4_RK) return PINGAN_SM4_RK;
  const key = [];
  for (let i = 0; i < 32; i += 2) key.push(parseInt(PINGAN_WM_KEY.substr(i, 2), 16));
  const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
  const tau = (b) =>
    ((PINGAN_SM4_SBOX[(b >>> 24) & 0xff] << 24) |
      (PINGAN_SM4_SBOX[(b >>> 16) & 0xff] << 16) |
      (PINGAN_SM4_SBOX[(b >>> 8) & 0xff] << 8) |
      PINGAN_SM4_SBOX[b & 0xff]) >>> 0;
  const k = [0, 1, 2, 3].map(
    (i) => ((key[i * 4] << 24) | (key[i * 4 + 1] << 16) | (key[i * 4 + 2] << 8) | key[i * 4 + 3]) ^ PINGAN_SM4_FK[i]
  );
  const rk = new Uint32Array(32);
  for (let i = 0; i < 32; i++) {
    const t = tau((k[i + 1] ^ k[i + 2] ^ k[i + 3] ^ PINGAN_SM4_CK[i]) >>> 0);
    k[i + 4] = (k[i] ^ t ^ rotl(t, 13) ^ rotl(t, 23)) >>> 0;
    rk[i] = k[i + 4];
  }
  PINGAN_SM4_RK = rk;
  return rk;
}

// 纯 JS 版 UTF-8 编码（Workers/Node 都不保证有 TextEncoder 之外的 Buffer）
function pinganUtf8(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const d = str.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { c = ((c - 0xd800) << 10) + (d - 0xdc00) + 0x10000; i++; }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return out;
}

function pinganSm4EncryptHex(plain) {
  const rk = pinganSm4RoundKeys();
  const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
  const T = (b) => {
    const t =
      ((PINGAN_SM4_SBOX[(b >>> 24) & 0xff] << 24) |
        (PINGAN_SM4_SBOX[(b >>> 16) & 0xff] << 16) |
        (PINGAN_SM4_SBOX[(b >>> 8) & 0xff] << 8) |
        PINGAN_SM4_SBOX[b & 0xff]) >>> 0;
    return (t ^ rotl(t, 2) ^ rotl(t, 10) ^ rotl(t, 18) ^ rotl(t, 24)) >>> 0;
  };
  const bytes = pinganUtf8(String(plain));
  const pad = 16 - (bytes.length % 16);
  for (let i = 0; i < pad; i++) bytes.push(pad);
  let hex = "";
  for (let off = 0; off < bytes.length; off += 16) {
    let x0 = ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
    let x1 = ((bytes[off + 4] << 24) | (bytes[off + 5] << 16) | (bytes[off + 6] << 8) | bytes[off + 7]) >>> 0;
    let x2 = ((bytes[off + 8] << 24) | (bytes[off + 9] << 16) | (bytes[off + 10] << 8) | bytes[off + 11]) >>> 0;
    let x3 = ((bytes[off + 12] << 24) | (bytes[off + 13] << 16) | (bytes[off + 14] << 8) | bytes[off + 15]) >>> 0;
    for (let r = 0; r < 32; r++) {
      const x4 = (x0 ^ T((x1 ^ x2 ^ x3 ^ rk[r]) >>> 0)) >>> 0;
      x0 = x1; x1 = x2; x2 = x3; x3 = x4;
    }
    for (const w of [x3, x2, x1, x0]) hex += ("00000000" + w.toString(16)).slice(-8);
  }
  return hex;
}

// 随机因子（服务端只要求非空随机串，不校验 UUID 格式）
function pinganUuid() {
  let s = "";
  for (let i = 0; i < 32; i++) s += "0123456789abcdef"[(Math.random() * 16) | 0];
  return s.slice(0, 8) + "-" + s.slice(8, 12) + "-" + s.slice(12, 16) + "-" + s.slice(16, 20) + "-" + s.slice(20);
}

const PINGAN_WM_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  Referer: PINGAN_WM_REF,
  Origin: "https://wm.pingan.com",
};

async function pinganWmGet(path, transport, timeout = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await nyHttp(PINGAN_WM_GW + path, { headers: PINGAN_WM_HEADERS, signal: ctrl.signal }, transport);
    if (!res || !res.ok) return null;
    return await res.json().catch(() => null);
  } catch (e) {
    return null;
  } finally { clearTimeout(timer); }
}

async function pinganWmPost(path, body, transport, timeout = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const payload = JSON.stringify({ ...body, currentTimeMillis: Date.now(), uuid: pinganUuid() });
    const res = await nyHttp(PINGAN_WM_GW + path, {
      method: "POST",
      // 【性能 2026-10-23】getNvlView 一次回 20 万字符 JSON，不压缩时走直连要 3.4s；
      // 带上 Accept-Encoding: gzip 后服务端回 12KB，实测 3.4s → 0.24s（14 倍）。
      // Workers/undici 的 fetch 会自己解压（此时下面 magic 判定走不到），
      // 本机 nodeTransport 不解压，故这里按 gzip magic 自己解 —— 双端同一份代码。
      headers: { ...PINGAN_WM_HEADERS, "Content-Type": "application/json", "Accept-Encoding": "gzip" },
      body: pinganSm4EncryptHex(payload),
      signal: ctrl.signal,
    }, transport);
    if (!res || !res.ok) return null;
    let text;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b && typeof DecompressionStream === "function") {
      text = await new Response(new Response(buf).body.pipeThrough(new DecompressionStream("gzip"))).text();
    } else {
      text = new TextDecoder("utf-8").decode(buf);
    }
    const j = JSON.parse(text);
    return j && j.responseCode === "000000" ? j : null;
  } catch (e) {
    return null;
  } finally { clearTimeout(timer); }
}

/**
 * 平安理财官网抓取（web 端口）。
 * @param {string} code 份额代码（如 QWCG00728A）
 * @param {{transport?:Function, infoOnly?:boolean}} opts
 *   infoOnly=true 只取产品档案（getProductInfo），**不拉 getNvlView 净值序列**（刷信息用）。
 */
export async function pinganWmFetch(code, opts = {}) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  const transport = opts.transport;
  const t0 = Date.now();

  // ① 产品档案（明文 GET）
  const ij = await pinganWmGet("/product/getProductInfo?productCode=" + encodeURIComponent(c), transport);
  const d = ij && ij.responseCode === "000000" ? ij.data : null;
  if (!d || !d.productCode) {
    navLog("pinganwm code=" + c + " 官网未收录 -> 回落母行端口 (" + (Date.now() - t0) + "ms)");
    return null; // 他行理财子代销品：官网无此码
  }

  const name = String(d.productSname || d.productName || "").trim() || null;
  const regCode = d.registerCode || null;
  const risk = pinganRiskToR(d.productRiskRating);
  const established = bobNormDate(String(d.establishmentDay || d.shareEstablishDate || "").replace(/-/g, "")) || null;
  const benchmark = (typeof d.perComBen === "string" && d.perComBen.trim()) ? d.perComBen.trim() : null;
  const holdDays = pinganHoldDays(name, d.maturityVarietyTxt);
  const currency = d.procurrecy || null;
  // 现金管理类：官网 isCashManagementCategory="1"，或序列整段恒 1（下方二次判定）
  const cashFlag = String(d.isCashManagementCategory || "") === "1";

  // ② 历史净值（SM4 加密 POST，pageSize=0 一次拿成立以来全量）
  let series = [];
  let cash = cashFlag;
  if (!opts.infoOnly && !cashFlag) {
    const nj = await pinganWmPost("/nvl/getNvlView", { productId: c, pageNum: 0, pageSize: 0 }, transport);
    const rows = (nj && Array.isArray(nj.data)) ? nj.data : [];
    const byDate = new Map();
    for (const r of rows) {
      const dt = bobNormDate(String((r && r.dataDate) || "").replace(/-/g, ""));
      const v = Number(r && r.unitValue);
      if (dt && Number.isFinite(v) && v > 0) byDate.set(dt, Number(v.toFixed(8)));
    }
    series = [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    // 【项目规则 2026-10-21】现金管理类（单位净值整段恒 1）不收录
    if (series.length && series.every(([, v]) => Math.abs(v - 1) <= 1e-6)) { cash = true; series = []; }
  }

  navLog("pinganwm code=" + c + " -> name=" + (name || "-") + " reg=" + (regCode || "-") +
    " n=" + series.length + " last=" + (series.length ? series[series.length - 1][0] : "-") +
    " (" + (Date.now() - t0) + "ms)");

  return {
    name,
    manager: "平安理财",
    established,
    establishedFromSeries: !established,
    series,
    cash,
    kind: "nav",
    risk,
    benchmark,
    holdDays,
    regCode,
    currency,
    source: "live",
    bank: "pingan",
    navVia: "pinganwm",
    navPort: "web",
    infoOnly: opts.infoOnly === true,
    navLatest: series.length ? series[series.length - 1][1] : null,
    navLatestDate: series.length ? series[series.length - 1][0] : null,
  };
}

// 同一产品码 60s 内复用结果：自动/去重抓取时不必重复打上游（平安单次 stub 抓约 1~2s）。
// ⚠ 2026-10-18：用户点「刷新」是明确要拿最新净值的动作，必须绕过本缓存 ——
//   否则 60s 内二次刷新会直接命中缓存返回 0ms（表现为「以后再刷新都是 0 秒」）。
//   前端刷新会带 noCache=1 → /api/product → fetchProductFull → opts.noCache。
const PINGAN_CACHE = new Map();
const PINGAN_CACHE_TTL = 60000;

async function pinganLive(code, opts = {}) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  // 【2026-10-23 修复】缓存键必须带 mode：此前只按产品码缓存，
  // nav 模式（跳过详情，series 有但信息全空）的结果会被 60s 内的 all/info 请求直接命中，
  // 表现为「刷全量时名称/风险/登记编码全 null、耗时 0ms」。
  const ck = c + "|" + (opts.mode || "all");
  const cached = PINGAN_CACHE.get(ck);
  if (!opts.noCache && cached && Date.now() - cached.t < PINGAN_CACHE_TTL) return cached.res;
  const transport = opts && opts.transport;
  const q = "?prdCode=" + encodeURIComponent(c);
  // 2026-10-22 修复：nav 模式只抓净值，跳过 ① 详情接口（finacDetail.do 含产品信息+额度）；quota 模式跳过净值序列。
  const __navMode = opts.mode === "nav";
  const __quotaMode = opts.mode === "quota";
  const __infoMode = opts.mode === "info";
  // 【2026-10-23 用户规则】刷信息只刷信息、刷额度只刷额度——两者都不抓净值。
  // 平安净值走 queryFinaChildNavIncrease（成立以来全量），信息/额度都在 finacDetail 一个接口里。
  const __noNav = __infoMode || __quotaMode;

  // ① 详情 + ② 净值序列（并行，互不依赖）
  //    注：成立日取自详情 startDate（与 indexName「成立以来年化(2026.05.07)」及序列首日一致），
  //    不再串行调用 rmb.pingan.com.cn 的附件接口 —— 省掉一个往返，端到端延迟减半。
  const [dj, nj] = await Promise.all([
    __navMode ? Promise.resolve(null) : pinganGet("https://b.pingan.com.cn/bron/ibank/pop/cdn/finachild/finacDetail.do" + q + "&access_source=H5", transport),
    __noNav ? Promise.resolve(null) : pinganGet("https://b.pingan.com.cn/bron/ibank/pop/cdn/finachild/queryFinaChildNavIncrease.do" + q + "&dateType=9&withIndex=true&access_source=H5", transport),
  ]);
  const d = (dj && dj.data) || null;
  const nd = (nj && nj.data) || null;
  const dates = (nd && Array.isArray(nd.date)) ? nd.date : [];
  const inc = (nd && Array.isArray(nd.navIncrease)) ? nd.navIncrease : [];
  if (!__noNav && (!dates.length || dates.length !== inc.length)) return null; // 平安源不认识该码 → 走回退路由（quota 模式不抓净值，放行）

  // ③ 基准净值：用官方最新净值反解（初始净值非 1 的产品也能自动校准）
  const latestNav = d && d.latestRate ? Number(d.latestRate.nav) : NaN;
  const lastInc = Number(inc[inc.length - 1]);
  const base = (Number.isFinite(latestNav) && latestNav > 0 && Number.isFinite(lastInc))
    ? latestNav / (1 + lastInc / 100)
    : 1;

  const raw = [];
  for (let i = 0; i < dates.length; i++) {
    const dt = bobNormDate(dates[i]);
    const iv = Number(inc[i]);
    if (!dt || !Number.isFinite(iv)) continue;
    const v = base * (1 + iv / 100);
    if (!Number.isFinite(v) || v <= 0) continue;
    raw.push([dt, Number(v.toFixed(6))]);
  }
  if (!__noNav && !raw.length) return null;
  raw.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const ded = [];
  for (const r of raw) {
    if (ded.length && ded[ded.length - 1][0] === r[0]) ded[ded.length - 1] = r;
    else ded.push(r);
  }

  // 成立日：详情 startDate（本期成立日，权威）→ 序列首日兜底。
  // 注意：saleStartDate 是「销售开始日」（比成立日早一天），不能当成立日用。
  let established = bobNormDate(d && d.startDate);
  if (!established && ded.length) established = ded[0][0];

  const name = (d && d.prdName) || null;
  // 注意运算优先级：`a || b ? x : y` 会被解析成 `(a||b) ? x : y`，必须用括号显式分组，
  // 否则代销他行理财子时（prdManager 是别家名）也会被错标成「平安理财」。
  const manager = (d && d.prdManager) || ((name && /^平安理财/.test(name)) ? "平安理财" : null) || inferManager(name) || "平安理财";

  // 剩余可购额度：remainQuota（单位随 currencyName，人民币为元、美元产品为美元）
  // 售罄产品（prdSaleStatus=SALE_OUT）恒为 0；remainQuotaPct 为剩余比例 0~1。
  let remainQuota = null, remainQuotaPct = null, quotaState = null;
  if (d && d.remainQuota != null && d.remainQuota !== "") {
    const n = Number(d.remainQuota);
    if (Number.isFinite(n) && n >= 0) remainQuota = n;
  }
  if (d && d.remainQuotaPct != null && d.remainQuotaPct !== "") {
    const p = Number(d.remainQuotaPct);
    if (Number.isFinite(p) && p >= 0) remainQuotaPct = p;
  }
  // 额度状况三态：remainQuota>0 → 具体数值(available)；==0 或 prdSaleStatus=SALE_OUT → 已售罄(sold_out)。
  if (remainQuota != null) quotaState = (remainQuota <= 0) ? "sold_out" : "available";
  else if (d && d.prdSaleStatus === "SALE_OUT") quotaState = "sold_out";

  const res = {
    name,
    manager,
    established,
    series: ded,
    kind: "nav",
    risk: pinganRiskToR(d && d.riskLevel),
    benchmark: null,
    holdDays: pinganHoldDays(name, d && d.indexContentSecond),
    regCode: (d && (d.bankFundRegisterCode || d.regCode || d.registerCode)) || null,
    remainQuota,
    remainQuotaPct,
    saleStatus: (d && d.prdSaleStatus) || null,
    // 母行给的是 "RMB"（非 ISO 代码），官网给 "CNY"；统一成 CNY，避免同一产品
    // 刷全量显示 CNY、刷额度显示 RMB 的不一致（2026-10-23）。
    currency: (d && d.currencyName) ? (d.currencyName === "RMB" ? "CNY" : d.currencyName) : null,
    quotaState,
    source: "live",
  };
  PINGAN_CACHE.set(ck, { t: Date.now(), res });
  return res;
}

/**
 * 平安银行/平安理财 统一入口。
 *
 * 【2026-10-23 双端口重构】用户报障 QWCG00728A 官网有 10-23 净值、我们只到 10-22。
 *   端口① web = 平安理财官网 wm.pingan.com（发行方权威，**含当日**真实单位净值，
 *                并直给登记编码/风险/基准/成立日/持有期 → 编排层可跳过中国理财网）
 *   端口② app = 平安口袋银行 H5 b.pingan.com.cn（净值慢一个披露日、且是按涨幅反解的，
 *                但**剩余额度 remainQuota 只有它有**）
 * 分工：
 *   nav   → 只打官网（getProductInfo + getNvlView）
 *   info  → 只打官网档案（getProductInfo）；官网未收录才回落母行详情
 *   quota → 只打母行详情（官网无额度字段）
 *   all   → 官网 + 母行详情并发，信息/净值取官网、额度取母行
 */
export async function pinganFetch(code, opts = {}) {
  const mode = opts.mode || "all";
  const __navMode = mode === "nav";
  const __infoMode = mode === "info";
  const __quotaMode = mode === "quota";

  // 刷信息：官网档案（1 次 GET ≈220ms）就已给全名称/登记编码/风险/成立日/持有期，
  // 命中即返回，不必再等母行详情（实测母行 finacDetail 常 1.2s，白等）。
  // 官网未收录（他行理财子代销品）才回落母行详情。
  if (__infoMode) {
    const wm = await pinganWmFetch(code, { transport: opts.transport, infoOnly: true }).catch(() => null);
    // 现金管理类（isCashManagementCategory="1"）→ 项目铁律：不收录。必须先于 wm.name 判断，
    // 否则现金类产品刷信息会被当普通产品下发（2026-10-23 审计修复）。
    if (wm && wm.cash) return { _excludedCash: true, code };
    if (wm && wm.name) return wm;
    return (await pinganLive(code, { ...opts, mode: "info" }).catch(() => null)) || null;
  }

  // 刷额度：官网无额度字段（remainQuota 只在母行），走母行详情。
  // 但母行详情没有类型字段 → 并发打一次官网档案（≈220ms，与母行 1.5s 重叠，不增加墙钟时间），
  // 只为拿 isCashManagementCategory 判定现金管理类。
  if (__quotaMode) {
    const [h5q, wm] = await Promise.all([
      pinganLive(code, { ...opts, mode: "quota" }).catch(() => null),
      pinganWmFetch(code, { transport: opts.transport, infoOnly: true }).catch(() => null),
    ]);
    if (wm && wm.cash) return { _excludedCash: true, code };
    return h5q || null;
  }

  // nav / all：官网 + 母行详情并发。nav 模式母行不需要（净值已由官网给全）；
  // all 模式母行只为拿额度。
  const wmP = pinganWmFetch(code, { transport: opts.transport }).catch(() => null);
  const h5P = __navMode
    ? Promise.resolve(null)
    : pinganLive(code, { ...opts, mode: "info" }).catch(() => null);
  const [wm, h5] = await Promise.all([wmP, h5P]);

  if (wm && !wm.cash && wm.series && wm.series.length) {
    const out = { ...wm };
    if (h5) {
      if (out.holdDays == null && h5.holdDays != null) out.holdDays = h5.holdDays;
      if (out.remainQuota == null && h5.remainQuota != null) {
        out.remainQuota = h5.remainQuota;
        out.remainQuotaPct = h5.remainQuotaPct;
        out.saleStatus = h5.saleStatus;
        out.quotaState = h5.quotaState;
      }
      if (!out.currency && h5.currency) out.currency = h5.currency;
    }
    return out;
  }
  // 官网明确是现金管理类 → 按项目规则不收录（返回哨兵，让编排层下发 isCash 提示）
  if (wm && wm.cash) return { _excludedCash: true, code };

  // 官网未收录（他行理财子代销品）：走母行原净值路径，再不认识才落 XPL
  try {
    const r = await pinganLive(code, opts);
    if (r && r.series && r.series.length) return r;
  } catch (e) { /* 直连源异常 → 走回退路由 */ }
  // 「只走 3 家」规则（2026-10-15）：直连源不认识该码时，仅保留中国理财网信息披露平台
  // （XPL = 规则允许的第 3 家）作为代销阶段兜底，不再试探工行/招行等其它银行。
  return xplShareFastLane("pingan", code, opts);
}

/* ===== 东莞银行 App 端口（2026-10-19 逆向，源自用户 PCAPdroid 截图）=====
 * 抓包路径：截图域名（mas/msm/wx/mgs/qdyy.dongguanbank.cn）→ fh.dongguanbank.cn
 *   fncWeb 推广壳 → 挖到 wx.dongguanbank.cn/wxbank 微信银行 Vue SPA（与 App WebView
 *   同款的公开 H5）→ finance-product_detail / _history chunk 的 $request 映射表 →
 *   CDP 无头 Chrome 实跑详情页拿 wire format。瑞数 WAF 只挡裸 curl（999 无体），
 *   接口本身免登录、无 token、无加密（enc-tk 空串服务端直接收）。
 * 接口（POST plain JSON，Node 直连实测 207~879ms）：
 *   /wxbApp/financialProductCenter/queryDetail  {prodNo}
 *     → 全字段：prodName / nav+navDate / taCode+taName(发行方) / riskLevel+riskName /
 *       estabDate(成立日真字段) / adjustUseLimit(额度) / statusName(开放期) / prdScale …
 *   /wxbApp/financialProductCenter/queryFinancialQuotation  {prodNo, dateInterval}
 *     → quotationList[{issDate,nav,totNav}]；dateInterval 1=近1月 2=近3月 3=近6月
 *       4=近1年 5=成立以来【一次回全量：RRK01A 744 点 / GYT360 498 点；代销信银理财
 *       AF251894M 14 点——该产品披露历史本就 14 点，与 App「近1月」一致】
 *   /wxbApp/financialProductCenter/queryProductNav
 *     {pageNo,pageSize,prodNo,taCode,startDate,endDate} → 分页版（服务端每页固定 20 条，
 *     pageSize 传大只影响偏移不影响页长；仅作行情接口空结果时的回落）。
 * 覆盖：自营玉兰理财（taCode=Y30 → taName=东莞银行）+ 代销他行理财子（YZX=信银理财…）。
 *   不存在的码 errorCode=0 但 body 空 → 返回 null 交编排层。
 * 备注：queryDetail 的 prodName 与用户截图（财盈聚）不一致（接口回「安盈象」）——净值
 *   逐点一致（1.0242@10-16…），系产品更名/系列调整，以银行接口实时返回为准。
 * ⚠ Cloudflare Workers 出网对瑞数 WAF 的通过性未实测；失败时 dongguanFetch 自动
 *   回落 XPL 渠道份额快速通道，不影响编排层。 */
const DG_WXB = "https://wx.dongguanbank.cn/wxbApp/";
const DG_REF = "https://wx.dongguanbank.cn/wxbank/index.html";

async function dgCall(transCode, bd, transport) {
  const res = await transport(DG_WXB + transCode, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      Referer: DG_REF,
      Accept: "application/json",
    },
    body: JSON.stringify({
      reqHeaderData: { corporateBankNo: "001", systemID: "WXB", srcSystemID: "WXB", transCode, ISSTREAMTYPE: false, ISUPLOADFILE: false },
      bodyData: bd || {},
    }),
  });
  const txt = await res.text();
  if (!txt) return null;
  let j = null;
  try { j = JSON.parse(txt); } catch (e) { return null; }
  return j && j.header && String(j.header.errorCode) === "0" ? j : null;
}

// YYYYMMDD → YYYY-MM-DD（不合法返回 null）
function dgYmd(v) {
  const s = String(v || "");
  return /^\d{8}$/.test(s) && s.slice(0, 4) !== "0000" ? s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6, 8) : null;
}
// 风险等级码 → R1~R5（容忍零填充："2"→R2，"02"→R2）
function dgRisk(v) {
  const c = String(v || "").replace(/^0+(?=\d)/, "");
  return /^[1-5]$/.test(c) ? "R" + c : null;
}
// 最短持有天数：先走既有逻辑（日开→1 / 数字天 / 月 / 年），再补中文数字天（「七天持有期」→7）
function dgHoldDays(name) {
  const base = ccbHoldDays(name);
  if (base != null) return base;
  const m = String(name || "").match(/(?:^|\D)([一二两三四五六七八九十])\s*天/);
  return m ? ({ "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10 })[m[1]] : null;
}

export async function dongguanAppNav(code, transport, mode = "all") {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  // 2026-10-22 用户规则：nav 模式只抓净值——跳过 queryDetail（信息接口，曾兼作存在性闸门）；
  // 行情接口 queryFinancialQuotation 与详情无依赖（不依赖 taCode），nav 模式单抓它。
  // 【2026-10-23 用户规则】刷信息只刷信息、刷额度只刷额度——两者都不抓净值：
  // 只抓 queryDetail（信息+adjustUseLimit 额度），跳过行情/分页两个净值接口。
  const __navOnly = mode === "nav";
  const __noNav = mode === "info" || mode === "quota";
  let det = null;
  let q;
  if (__navOnly) {
    q = await dgCall("financialProductCenter/queryFinancialQuotation", { prodNo: c, dateInterval: "5" }, transport).catch(() => null);
  } else if (__noNav) {
    const d = await dgCall("financialProductCenter/queryDetail", { prodNo: c }, transport).catch(() => null);
    det = d && d.body;
  } else {
    // 两接口无依赖（行情不需要 taCode）→ 并发发起
    const [d, qq] = await Promise.all([
      dgCall("financialProductCenter/queryDetail", { prodNo: c }, transport).catch(() => null),
      // dateInterval：1=近1月 2=近3月 3=近6月 4=近1年 5=成立以来（实测 RRK01A iv=5 一次回 744 点全量）
      dgCall("financialProductCenter/queryFinancialQuotation", { prodNo: c, dateInterval: "5" }, transport).catch(() => null),
    ]);
    det = d && d.body;
    q = qq;
  }
  // 存在性闸门仅非 nav 模式保留（nav 模式直接抓净值，不存在即序列空=抓空）
  if (!__navOnly && (!det || !det.prodNo)) return null; // 目录外/不存在码：body 空
  // 序列：行情全量 → 去重升序；行情空则回落分页接口第一页（近 20 点）
  let rows = (q && q.body && q.body.quotationList) || [];
  if (!__noNav && !rows.length) {
    const n = await dgCall("financialProductCenter/queryProductNav",
      { pageNo: 1, pageSize: 20, prodNo: c, taCode: (det && det.taCode) || "", startDate: "19900101", endDate: CCB_TODAY }, transport).catch(() => null);
    rows = (n && n.body && n.body.productNavList) || [];
  }
  const byDate = new Map();
  for (const r of rows) {
    const dt = dgYmd(r && r.issDate);
    const v = r && Number(parseFloat(r.nav).toFixed(8));
    if (dt && Number.isFinite(v) && v > 0) byDate.set(dt, v);
  }
  const series = [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  // 现金管理类价值判据（单位净值整段恒 1）——数据质量守卫（非信息接口闸门），保留。
  // 返回哨兵让编排层下发 isCash（2026-10-23 统一）。
  if (series.length && series.every((p) => Math.abs(p[1] - 1) < 1e-4)) return { _excludedCash: true, code };
  // 额度：adjustUseLimit ≥1e10 为「充足」哨兵（99956564194.94 形态，与存续规模 3765 万明显失衡）
  let quota = null;
  const lim = Number(det && det.adjustUseLimit);
  const currency = ccbCurrency(det && det.currType) || "CNY";
  if (Number.isFinite(lim) && lim > 0) {
    quota = lim >= 1e10
      ? { remainQuota: null, remainQuotaPct: null, quotaState: "available", quotaText: "额度充足" }
      : { remainQuota: lim, remainQuotaPct: null, quotaState: "available", quotaText: null };
  }
  const navLatest = (det && det.nav) ? Number(parseFloat(det.nav).toFixed(8)) : (series.length ? series[series.length - 1][1] : null);
  const navLatestDate = dgYmd(det && det.navDate) || (series.length ? series[series.length - 1][0] : null);
  return {
    name: (det && det.prodName) || null,
    manager: (det && det.taName) || null, // 自营=东莞银行 / 代销=信银理财等发行方全称
    established: dgYmd(det && det.estabDate), // 成立日真字段（用户规则：不得以净值系列判断）
    establishedFromSeries: false,
    series,
    kind: "nav",
    risk: dgRisk(det && det.riskLevel),
    benchmark: null, // 端口无业绩基准字段（3.18% 成立以来年化由详情页前端算）
    holdDays: dgHoldDays(det && det.prodName),
    regCode: null, // 端口无登记编码，交编排层 XPL/中国理财网补
    source: "live",
    bank: "dongguan",
    navPort: "app", // 微信银行 H5 = App WebView 同款端口，前端显示「东莞银行·App」
    navLatest,
    navLatestDate,
    saleStatus: (det && det.statusName) || null, // 开放期/封闭期…
    ...(quota || {}),
    ...(quota ? { currency } : {}),
  };
}

// 东莞银行无理财子公司，在售多为他行理财子 / 兄弟行产品，故多挂一路北银理财信披站
export async function dongguanFetch(code, opts = {}) {
  // 【直连主路径】东莞银行 App 端口：微信银行 H5 同款接口（免登录，2026-10-19 逆向）
  try {
    const r = await dongguanAppNav(code, opts.transport, opts.mode || "all");
    // 现金管理类哨兵：直接透传（不回落 XPL，避免现金类被兜底通道收录）
    if (r && r._excludedCash) return r;
    if (r && r.series && r.series.length) return r;
    // 【2026-10-23】info/quota 模式：东莞端口只回了详情（信息+额度），没有净值 —— 直接采用，
    // 不再往下走 xpl（xpl 是净值兜底，刷信息/刷额度不该触发）。
    if (r && (opts.mode === "info" || opts.mode === "quota") && (r.name || r.quotaState != null)) {
      return { ...r, series: [], infoOnly: true };
    }
  } catch (e) { /* 直连失败 → 回落发行行路由 */ }
  // 【回落】「只走 3 家」规则（2026-10-15）：东莞银行代销他行理财子时，代销阶段仅保留
  // 中国理财网信息披露平台（XPL = 规则允许的第 3 家），不再试探 icbc/cmb/bob/comm。
  return xplShareFastLane("dongguan", code, opts);
}

// 网商银行 / 微众银行：互联网银行，自身无净值信披站，零售端产品全部是他行理财子发行的
// 代销品。「只走 3 家」规则（2026-10-15 用户拍板）：刷净值只走 发行银行 → 代销银行 →
// 中国理财网兜底，不得试探其它银行。净值由编排层 fetchProductFull 的「发行银行」阶段
// 负责（/api/predict 预判 issuer → safeBank(issuer) 先抓）；代销银行阶段（下方
// mybankFetch/webankFetch）不再按 21 家发行行优先级试探——那会抓到既非发行也非代销的
// 银行（实测 667497K：icbc→boc→psbc→nbcb→cmb 全部 miss，白等 29.1s，且中银/邮储既非
// 发行银行也非代销银行，违反规则）。本阶段仅保留中国理财网信息披露平台的「渠道份额
// 快速通道」（XPL = 规则允许的第 3 家，覆盖网商 N / 微众 G 专享份额码，预判失效时仍
// 能命中）；其余一律返回 null，由 fetchProductFull 的中国理财网兜底接管
// （navVia=chinawealth/xpl，数据不丢）。

// 网商/微众代销阶段的唯一通道：中国理财网信息披露平台「渠道份额快速通道」。
// 仅对已登记的渠道子份额代码（网商 N / 微众 G，XPL_SHARE_REG）生效——纯内存查表 +
// 最多 4 个子请求 ≈5s；普通代码零请求直接返回 null，交编排层的中国理财网兜底。
// 注：此快速通道不受「发行银行阶段已先抓」影响——predict 失效时它仍能命中份额码；
//     predict 正常时发行银行阶段（如 abcFetch 自带的 XPL 回落）已先覆盖，本通道极少触发。
async function xplShareFastLane(bank, code, opts) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  // 【2026-10-23 用户规则】刷信息只刷信息、刷额度只刷额度——两者都不抓净值。
  // 本通道是纯净值兜底（xplFetch 只回净值序列），info/quota 一律不进入（统一拦截点，
  // 覆盖 fminbank/dongguan/pingan/webank/mybank/nanyin 各家的兜底调用）。
  if (opts && (opts.mode === "info" || opts.mode === "quota")) return null;
  if (XPL_SHARE_REG[c]) {
    try {
      const r = await xplFetch(c, opts);
      if (r && r.series && r.series.length) return { ...r, bank, navVia: "xpl", navViaCode: c };
    } catch (e) { /* 快速通道失败 → 交编排层中国理财网兜底 */ }
  }
  return null;
}

export async function mybankFetch(code, opts = {}) {
  return xplShareFastLane("mybank", code, opts);
}

/* ==========================================================================
 * 微众银行 App 端口（personal.webank.com 理财网关）—— 2026-10-17 新增
 *
 * 端口形态：App 内「理财」是 RN，数据走 HTTP JSON 网关
 *   POST https://personal.webank.com/wm-hjhtr/wm_product/productinfo/getproductlistbycode
 *   body {"productInfoList":[{"name":"NYJXLD1409G"}]}   UA 必须是 webank/9.5.2
 *   → ret_data.productInfoList[0].content = 210 字段 JSON 字符串
 * 免登录、免签名、免 PDF，一次请求拿全：名称/发行方/TA/成立日/到期日/风险等级/期限/
 *   最新净值/净值日期/规模/总额度/起购金额/费率/买卖规则。
 *
 * ✅ 2026-10-19 突破：历史净值序列已打通 —— POST
 *      https://personal.webank.com/wm-hjhtr/wm_product/history/query/stock_rates
 *      body {"prod_code":code,"start_date":"20200101","end_date":"20991231"}  UA webank/9.5.2
 *      → 20350000, ret_data = { "YYYYMMDD": {unit_net_value,...}, ... }（升序），免登录全量。
 *   （此前 2026-10-17 误判「wm-pqs / wm-htrserver 恒回 23525003/21405001 = 服务端准入」，
 *     实为选错端点；那两个旧端点至今仍拒，但正确的聚合网关 POST stock_rates 可用。）
 *   NYCF000010 实测 144 点，与用户截图逐日吻合。故 webank 已从 BANK_ONE_NAV 移出，
 *   净值主源=微众 App 端口全序列；XPL 仅作兜底并补 regCode/benchmark/发行方。
 *   详见 scrape/webank_app.mjs 文件头与《微众银行_净值端口_逆向报告.md》。
 *
 * ⚠ Cloudflare Workers 无 process，本段不执行（动态 import 只在 Node 运行时解析）。
 * ========================================================================== */

/** 只填 base 里为空/缺失的键，不覆盖已有值 */
function fillMissing(base, extra) {
  const out = Object.assign({}, base);
  for (const k of Object.keys(extra || {})) {
    if (out[k] == null || out[k] === "") out[k] = extra[k];
  }
  return out;
}

/**
 * 微众 App 端口抓取（仅本机 Node）
 * @param {string} code 产品代码
 * @param {{transport?:Function, infoOnly?:boolean, probe?:boolean}} opts
 */
export async function webankAppFetch(code, opts = {}) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  const t0 = Date.now();
  try {
    const mod = await import(new URL("./webank_app.mjs", import.meta.url).href);
    // 【2026-10-23 用户规则】刷信息只刷信息、刷额度只刷额度——两者都不抓净值：
    // 传 infoOnly=true 让端口只取 productinfo（信息 + 总额度/起购），不构造 series。
    const d = await mod.webankAppFetch(c, { transport: opts.transport, infoOnly: !!opts.infoOnly || opts.mode === "info" || opts.mode === "quota", probe: !!opts.probe, navOnly: (opts.mode || "all") === "nav" });
    if (!d || d.error) {
      navLog("webank app code=" + c + " -> " + ((d && d.error) || "null") + " (" + (Date.now() - t0) + "ms)");
      return null;
    }
    navLog("webank app code=" + c + " -> nav=" + (d.latestNav != null ? d.latestNav : "-") + "@" + (d.netvalueDate || "-")
      + " name=" + (d.name || "-") + " (" + (Date.now() - t0) + "ms)");
    return d;
  } catch (e) {
    navLog("webank app code=" + c + " throw " + ((e && e.message) || e) + " (" + (Date.now() - t0) + "ms)");
    return null;
  }
}

export async function webankFetch(code, opts = {}) {
  const c = String(code || "").trim().toUpperCase();
  // 【首选】微众 App 端口：2026-10-19 打通历史净值序列（POST stock_rates，全量 144+ 点）
  let app = null;
  // 【2026-10-23 用户规则】info/quota 不抓净值：App 端口以 infoOnly 只取信息，XPL 兜底也关闭。
  const __noNav = opts.mode === "info" || opts.mode === "quota";
  if (typeof process !== "undefined" && process.versions && process.versions.node) {
    app = await webankAppFetch(c, opts).catch(() => null);
    if (app && (opts.infoOnly || __noNav)) return app;
  }
  // 【兜底】中国理财网渠道份额快速通道（XPL，覆盖微众 G 专享份额码）—— 仅当 App 端口无全序列时兜底
  // 2026-10-22：nav 模式跳过 XPL（只补登记编码/基准，属信息，nav 模式不需要）
  const __navMode = (opts.mode || "all") === "nav";
  const xpl = (__navMode || __noNav) ? null : await xplShareFastLane("webank", c, opts);

  if (app && app.series && app.series.length >= 2) {
    // App 端口已拿到全量序列 → 净值主源为 App 端口（navVia=webank / navPort=app，前端「净值来源」显示微众银行App）
    if (xpl) {
      // XPL 补 App 端口缺失的登记编码 / 业绩基准 / 发行方（210 字段无这三项）。
      // xpl 返回的是 regCode，同时回填两种拼写（编排层读 regCode，webank 自用 regCode）。
      return fillMissing(app, {
        regCode: xpl.regCode || null,
        benchmark: xpl.benchmark || null,
        manager: xpl.manager || null,
        wbInfoSource: "webank/app+xpl",
      });
    }
    return app;
  }
  // App 端口无全序列（单点/未收录）→ XPL 兜底（含全序列）
  if (xpl) {
    if (!app) return xpl;
    return fillMissing(xpl, {
      risk: app.risk, holdDays: app.holdDays, established: app.established,
      manager: app.manager, taCode: app.taCode,
      latestNav: app.latestNav, netvalueDate: app.netvalueDate,
      totalAmount: app.totalAmount, quotaTotal: app.quotaTotal, minFirstAmount: app.minFirstAmount,
      wbInfoSource: "webank/app",
    });
  }
  return app || null;
}

/* ==========================================================================
 * 华夏银行（huaxia）—— 手机银行理财产品目录（WAP 接口，真实净值单点）
 *
 * 逆向来源：WAP 站 https://wap.hxb.com.cn/wap/sjblccpxx/index.shtml（手机银行理财产品信息）
 *   其脚本 /phone/js/licaiSearchWap.js 内的两个接口：
 *     ① 全量目录（按码定位所需）
 *        POST /precious-metal-mall/LchqController/selectWapByCode?date=<ts>
 *        Content-Type: application/json；body 为空
 *        ⚠ 服务端忽略入参（实测带 code / licaiCode 都一样），恒返回全量（821 条）
 *        → 响应 { code:200, body:[ {…} ] }
 *     ② 名称分页搜索
 *        POST /precious-metal-mall/LchqController/getWapFindAll?pageNum=&pageSize=&date=
 *        body JSON {licaiName, licaiBuyOriginOrderFlag, licaiVieldMaxOrderFlag, licaiTimeLimitOrderFlag}
 *        ⚠ licaiName 只匹配**名称**，按产品码搜返回 0 条 —— 故按码定位必须走 ① 全量目录本地匹配。
 * 字段：licaiCode(产品码) / licaiName / mannagerName(管理人) / licaiNewNet(最新单位净值) /
 *       licaiFoundDay(成立日 YYYYMMDD) / licaiTimeLimit(如"最短180天") / publicDate /
 *       licaiModel / currencyYield / nearlyAnnualYield / preformanceMark(业绩基准) 等。
 *
 * ⚠ 两个已知边界（已实测确认，勿当作 bug）：
 *   1) 接口**不返回净值日期**，只有 publicDate（记录更新 / as-of 时间，如 2026-08-31）。
 *      这里取其日期部分作为净值日期的**合理代理**，含义＝「最新净值截止该日」。
 *      华夏的净值历史序列接口不对外（getWapDetail / getNetValue / selectWapDetail 等候选均 404），
 *      产品说明书页（/lcpdf/…_98.html）也只有条款、无净值历史 → 只能取单点。
 *   2) 风险等级该接口不返回 → risk 恒为 null（可由 /api/meta 从中国理财网补全）。
 */
const HUXIA_WAP_HOST = "https://wap.hxb.com.cn";
const HUXIA_CATALOG_EP = HUXIA_WAP_HOST + "/precious-metal-mall/LchqController/selectWapByCode";

function huxiaNormDate(s) {
  const d = String(s || "").replace(/[^0-9]/g, "");
  const m = d.match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
// publicDate 形如 "2026-08-31T13:40:01Z" → "2026-08-31"
function huxiaPubDate(s) {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
// licaiTimeLimit 形如 "最短180天" → 180；"交易日申赎" / "每半月定开" → null
function huxiaHoldDays(t) {
  const m = String(t || "").match(/(\d+)\s*天/);
  return m ? Number(m[1]) : null;
}

/* ==========================================================================
 * 华夏银行 App 端口（mobileh5.hxb.com.cn 理财详情 H5）—— 2026-10-17 打通
 *
 * 逆向来源：手机银行分享/内置 H5
 *   https://mobileh5.hxb.com.cn/H5/financePage/financePage.html?financial_id=<码>&entryId=...
 * 页面 Vue SPA，数据来自唯一业务接口（免登录、无签名、无 cookie）：
 *   POST https://mobileh5.hxb.com.cn/bcf/financialNew/queryFinancialDetailV1.do
 *   Content-Type: application/json
 *   body: {"head":{"H_TIME":"<ms>","H_CHNL_ID":"1002"},"body":{"financial_id":"<码>"}}
 *   ⚠ head 只有 H_CHNL_ID="1002" 必需（缺它回 "GW渠道号不能为空"）；其余可空。
 *   ⚠ financial_id 与 WAP 目录 licaiCode 同码（实测 FBAE41917F 两端一致）。
 * 关键字段（body）：
 *   halfYearList:[{net_date(YYYYMMDD), net_money(单位净值)}] ← 净值历史序列（实测 25 点）
 *   name / ta_name(发行人) / financial_risk("R2中低风险") / rist("PR2(稳健型)")
 *   reg_code(登记编码) / product_setup(成立日YYYYMMDD) / benchmark(业绩基准全文)
 *   product_time("最短1天") / remian_limit(剩余额度,元) / currency("156"=CNY)
 * ========================================================================== */
const HUXIA_APP_HOST = "https://mobileh5.hxb.com.cn";
const HUXIA_APP_EP = HUXIA_APP_HOST + "/bcf/financialNew/queryFinancialDetailV1.do";
const HUXIA_APP_REF = HUXIA_APP_HOST + "/H5/financePage/financePage.html";
const HUXIA_APP_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.40(0x1800282a) NetType/WIFI Language/zh_CN";

// net_date / product_setup "20260605" → "2026-06-05"
function huxiaAppDate(s) {
  const d = String(s || "").replace(/[^0-9]/g, "");
  const m = d.match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
// financial_risk "R2中低风险" / rist "PR2(稳健型)" → "R2"
function huxiaAppRisk(s) {
  const m = String(s || "").match(/R\s*([1-5])/i);
  return m ? "R" + m[1] : null;
}
// product_time "最短1天" → 1；"最短180天" → 180
function huxiaAppHoldDays(s) {
  const m = String(s || "").match(/(\d+)\s*天/);
  return m ? Number(m[1]) : null;
}
// benchmark 去掉「业绩比较基准：」标签，保留公式+说明
function huxiaBench(s) {
  let t = String(s || "").trim();
  if (!t) return null;
  t = t.replace(/^业绩比较基准[:：]?\s*/, "").replace(/^业绩基准[:：]?\s*/, "").trim();
  return t || null;
}

// App 端口抓取：全序列净值 + 七字段 + 额度（免登录直连）
async function huaxiaAppFetch(code, opts = {}) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  const transport = opts.transport;
  // 【2026-10-23 用户规则】刷信息只刷信息、刷额度只刷额度——两者都不抓净值。
  // 华夏 queryFinancialDetailV1.do 一个响应同时含 halfYearList（净值）与七字段/remian_limit（信息+额度），
  // 协议层无法只取一半 —— 故照常请求，但 info/quota 下丢弃序列（不回传、不落库）。
  const __noNav = opts.mode === "info" || opts.mode === "quota";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await nyHttp(HUXIA_APP_EP, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
        Referer: HUXIA_APP_REF + "?financial_id=" + c,
        "User-Agent": HUXIA_APP_UA,
      },
      body: JSON.stringify({ head: { H_TIME: String(Date.now()), H_CHNL_ID: "1002" }, body: { financial_id: c } }),
      signal: ctrl.signal,
    }, transport);
    if (!res || !res.ok) return null;
    const j = JSON.parse(await res.text());
    const b = j && j.body;
    if (!b || b.STATUS !== "1" || !b.name) return null;

    // 净值历史序列（升序）
    const list = Array.isArray(b.halfYearList) ? b.halfYearList : [];
    const series = [];
    for (const it of list) {
      const dt = huxiaAppDate(it && it.net_date);
      const nav = parseFloat(it && it.net_money);
      if (dt && Number.isFinite(nav) && nav > 0) series.push([dt, Number(nav.toFixed(8))]);
    }
    series.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    if (__noNav) series.length = 0; // info/quota：丢弃净值序列（见函数头注释）
    const last = series.length ? series[series.length - 1] : null;

    // 剩余额度（元）
    let remainQuota = null, quotaState = null;
    const rl = parseFloat(b.remian_limit);
    if (Number.isFinite(rl)) {
      if (rl > 0) { remainQuota = rl; quotaState = "available"; }
      else quotaState = "sold_out";
    }

    const out = {
      name: b.name || null,
      manager: b.ta_name || null, // 发行人原名（民生理财/华夏理财…），不用 inferManager 以免误映射
      established: huxiaAppDate(b.product_setup),
      risk: huxiaAppRisk(b.financial_risk) || huxiaAppRisk(b.rist),
      benchmark: huxiaBench(b.benchmark),
      holdDays: huxiaAppHoldDays(b.product_time),
      regCode: b.reg_code || null,
      series,
      kind: "nav",
      source: "live-huaxia",
      bank: "huaxia",
      navVia: "huaxia",
      navPort: "app",
      navViaCode: c,
      navLatest: last ? last[1] : null,
      navLatestDate: last ? last[0] : null,
      remainQuota,
      quotaState,
      currency: "CNY",
    };
    if (series.length < 2) out.infoOnly = true;
    return out;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function huaxiaFetch(code, opts = {}) {
  const transport = opts.transport;
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;

  // ① App 端口（mobileh5 理财详情 H5）优先：全序列净值 + 七字段 + 额度
  const app = await huaxiaAppFetch(c, opts).catch(() => null);
  const appPts = app && app.series ? app.series.length : 0;
  if (appPts >= 2) return app;
  // 【2026-10-23 用户规则】info/quota 只用 App 端口的信息壳（序列已在 huaxiaAppFetch 内丢弃），
  // 不再走 WAP 全量目录（821 条，且只回最新净值单点，属净值）。
  if (opts.mode === "info" || opts.mode === "quota") return app || null;

  // ② WAP 端口回退（wap.hxb.com.cn 目录）：仅最新净值单点 + 部分信息
  // 目录接口偶发返回空 / 异常（实测有一定概率，非必现），故最多重试 3 次
  let list = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await nyHttp(HUXIA_CATALOG_EP + "?date=" + Date.now(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Referer: HUXIA_WAP_HOST + "/wap/sjblccpxx/index.shtml",
        },
        body: "",
      }, transport);
      if (res && res.ok) {
        const j = JSON.parse(await res.text());
        if (j && Array.isArray(j.body) && j.body.length) { list = j.body; break; }
      }
    } catch (e) { /* 换下一次重试 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!list) return app || null;

  // 全量目录里按产品码精确匹配（大小写不敏感）
  const p = list.find((o) => String(o.licaiCode || "").trim().toUpperCase() === c);
  if (!p) return app || null;
  const name = p.licaiName || null;
  if (!name) return app || null;

  const nav = parseFloat(p.licaiNewNet);
  const dt = huxiaPubDate(p.publicDate);
  const series = (dt && Number.isFinite(nav) && nav > 0) ? [[dt, Number(nav.toFixed(8))]] : [];
  const bench = p.preformanceMark && p.preformanceMark !== "0%-0%" ? p.preformanceMark : null;

  const wap = {
    name,
    manager: p.mannagerName || null,
    established: huxiaNormDate(p.licaiFoundDay),
    series,
    kind: "nav",
    risk: null, // 该目录接口不含风险等级
    benchmark: bench,
    holdDays: huxiaHoldDays(p.licaiTimeLimit),
    regCode: null,
    source: "live-huaxia",
    bank: "huaxia",
    navVia: "huaxia",
    navPort: "app",
    navViaCode: c,
    navLatest: series.length ? series[0][1] : null,
    navLatestDate: series.length ? series[0][0] : null,
    infoOnly: series.length === 0,
  };

  // App 端口给了信息/额度但序列不足（极少见）：以 App 七字段+额度覆盖 WAP 单点
  if (app) {
    return {
      ...wap,
      manager: app.manager || wap.manager,
      risk: app.risk || wap.risk,
      benchmark: app.benchmark || wap.benchmark,
      holdDays: app.holdDays != null ? app.holdDays : wap.holdDays,
      established: app.established || wap.established,
      regCode: app.regCode || wap.regCode,
      remainQuota: app.remainQuota != null ? app.remainQuota : null,
      quotaState: app.quotaState || null,
      currency: "CNY",
      navPort: "app",
    };
  }
  return wap;
}

/* ==========================================================================
 * 南京银行 / 南银理财（nanyin）—— 净值披露接口（ePortal CMS，AES-ECB + RSA 加密）
 *
 * 官网产品净值页 /nanyinwealth/lccp/cpjz/index.html?id=<销售代码> 调用 ePortal 接口：
 *   - 产品详情：/eportal/ui?moduleId=5&portal.url=/portlet/article-data!queryProductDetail.portlet
 *   - 净值列表：/eportal/ui?moduleId=5&portal.url=/portlet/article-data!queryNetValueList.portlet
 * 请求体 { data, aesKey, timeStamp } 均加密：
 *   - data / timeStamp：AES-128-ECB(Pkcs7)，密钥 = 16 位随机串(keyBuf)
 *   - aesKey：以服务端 RSA-1024 公钥(PKCS#1 v1.5)加密该 keyBuf
 * 响应外层 { code, message, data:{ data:"<密文>" } }，密文用同一 keyBuf AES-128-ECB 解密。
 * 产品详情 variety==="3" 为现金管理类(万份收益)——按项目规则直接排除不抓（见 nanyinFetch）；
 * 其余为净值型(variety=2 等)，netValue 即单位净值。
 * ========================================================================== */

const NANYIN_HOST = "https://www.nanyinwealth.com";
const NANYIN_PUBKEY_URL = NANYIN_HOST + "/eportal/ui?moduleId=5&portal.url=/portlet/login-handle!publicKey.portlet&TopModelId=e7db4f2628vb40548f6101d71695ada2";
const NANYIN_PD_URL = NANYIN_HOST + "/eportal/ui?moduleId=5&portal.url=/portlet/article-data!queryProductDetail.portlet&TopModelId=e7db4f2628cb40548f6101d71695ada2";
const NANYIN_NVL_URL = NANYIN_HOST + "/eportal/ui?moduleId=5&portal.url=/portlet/article-data!queryNetValueList.portlet&TopModuelId=e7db4f2628cb40548f6101d71695ada2";
const NANYIN_PAGE_SIZE = 10; // 南银净值分页单页条数（接口默认；与下方「短页即末页」判据一致）
let nanyinSession = null; // { n, e, keyBytes, cookie } —— 缓存一次会话，失败即作废重取
// 把服务端 Set-Cookie 收敛成可回放的 Cookie 请求头（只取 name=value，去掉 Path/HttpOnly 等属性）
function nyCookieHeader(setCookie) {
  if (!setCookie) return undefined;
  const segs = String(setCookie).split(",").map((s) => s.trim()).filter(Boolean);
  const pairs = segs.map((s) => s.split(";")[0].trim()).filter(Boolean);
  return pairs.length ? pairs.join("; ") : undefined;
}

function nyGenKey() {
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let k = "";
  for (let i = 0; i < 16; i++) k += alpha[Math.floor(Math.random() * alpha.length)];
  return new TextEncoder().encode(k);
}
function nySleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---- DER / RSA 工具（复用文件顶部 bytesToB64/b64ToBytes/bytesToBigInt/bigIntToBytes）----
function nyReadLen(buf, off) {
  let len = buf[off++];
  if (len & 0x80) { const n = len & 0x7f; len = 0; for (let i = 0; i < n; i++) len = (len << 8) | buf[off++]; }
  return { len, next: off };
}
function nyDerReadInt(buf, off) {
  if (buf[off] !== 0x02) throw new Error("DER INT expected");
  off++; let len = buf[off++];
  if (len & 0x80) { const n = len & 0x7f; len = 0; for (let i = 0; i < n; i++) len = (len << 8) | buf[off++]; }
  const b = buf.slice(off, off + len);
  let s = 0; while (s < b.length - 1 && b[s] === 0x00) s++;
  return { value: bytesToBigInt(b.slice(s)), next: off + len };
}
function nySpkiToKeys(spkiB64) {
  const buf = b64ToBytes(spkiB64);
  let off = 0;
  if (buf[off] !== 0x30) throw new Error("not SEQUENCE");
  off++; let r = nyReadLen(buf, off); off = r.next;
  off++; r = nyReadLen(buf, off); off = r.next + r.len;       // 跳过 algorithmIdentifier
  if (buf[off] !== 0x03) throw new Error("expected BIT STRING");
  off++; r = nyReadLen(buf, off); off = r.next; off++;        // 跳过 unused bits
  const inner = buf.slice(off, off + r.len - 1);
  let o = 0;
  if (inner[o] !== 0x30) throw new Error("expected inner SEQUENCE");
  o++; let ir = nyReadLen(inner, o); o = ir.next;
  const nR = nyDerReadInt(inner, o);
  const eR = nyDerReadInt(inner, nR.next);
  return { n: nR.value, e: eR.value, keyBytes: Math.ceil(nR.value.toString(2).length / 8) };
}
function nyModPow(base, exp, mod) {
  base %= mod; let r = 1n;
  while (exp > 0n) { if (exp & 1n) r = (r * base) % mod; exp >>= 1n; base = (base * base) % mod; }
  return r;
}
// RSA PKCS#1 v1.5 加密（EME）：M=keyBuf(16字节)，返回 base64 密文
function nyRsaEncrypt(keyBuf, n, e, keyBytes) {
  const k = keyBytes;
  const mLen = keyBuf.length;
  const psLen = k - 3 - mLen;
  const ps = new Uint8Array(psLen);
  for (let i = 0; i < psLen; i++) { let b; do { b = Math.floor(Math.random() * 256); } while (b === 0); ps[i] = b; }
  const em = new Uint8Array(k);
  em[0] = 0x00; em[1] = 0x02; em.set(ps, 2); em[2 + psLen] = 0x00; em.set(keyBuf, 3 + psLen);
  const m = bytesToBigInt(em);
  const c = nyModPow(m, e, n);
  return bytesToB64(bigIntToBytes(c, k));
}

// ---- 纯 JS AES-128-ECB（Pkcs7），跨 Node / Cloudflare Worker 无依赖 ----
const NY_SBOX = new Uint8Array([
0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16]);
const NY_INV_SBOX = new Uint8Array(256);
for (let i = 0; i < 256; i++) NY_INV_SBOX[NY_SBOX[i]] = i;
const NY_RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];
function nyXtime(a) { return ((a << 1) ^ ((a & 0x80) ? 0x1b : 0)) & 0xff; }
function nyMul2(a) { return nyXtime(a); }
function nyMul3(a) { return nyXtime(a) ^ a; }
function nyMul9(a) { return nyXtime(nyXtime(nyXtime(a))) ^ a; }
function nyMul11(a) { return nyXtime(nyXtime(nyXtime(a))) ^ nyXtime(a) ^ a; }
function nyMul13(a) { return nyXtime(nyXtime(nyXtime(a))) ^ nyXtime(nyXtime(a)) ^ a; }
function nyMul14(a) { return nyXtime(nyXtime(nyXtime(a))) ^ nyXtime(nyXtime(a)) ^ nyXtime(a); }
function nyKeyExpansion(key) {
  const w = new Uint8Array(176); w.set(key);
  for (let i = 4; i < 44; i++) {
    let t0 = w[(i - 1) * 4], t1 = w[(i - 1) * 4 + 1], t2 = w[(i - 1) * 4 + 2], t3 = w[(i - 1) * 4 + 3];
    if (i % 4 === 0) { const a = t1, b = t2, c = t3, d = t0; t0 = NY_SBOX[a] ^ NY_RCON[i / 4 - 1]; t1 = NY_SBOX[b]; t2 = NY_SBOX[c]; t3 = NY_SBOX[d]; }
    const p0 = w[(i - 4) * 4], p1 = w[(i - 4) * 4 + 1], p2 = w[(i - 4) * 4 + 2], p3 = w[(i - 4) * 4 + 3];
    w[i * 4] = p0 ^ t0; w[i * 4 + 1] = p1 ^ t1; w[i * 4 + 2] = p2 ^ t2; w[i * 4 + 3] = p3 ^ t3;
  }
  return w;
}
function nyAR(s, w, r) { for (let i = 0; i < 16; i++) s[i] ^= w[r * 16 + i]; }
function nySB(s) { for (let i = 0; i < 16; i++) s[i] = NY_SBOX[s[i]]; }
function nyISB(s) { for (let i = 0; i < 16; i++) s[i] = NY_INV_SBOX[s[i]]; }
function nySR(s) { const t = s.slice(); for (let r = 1; r < 4; r++) for (let c = 0; c < 4; c++) s[r + 4 * c] = t[r + 4 * ((c + r) % 4)]; }
function nyISR(s) { const t = s.slice(); for (let r = 1; r < 4; r++) for (let c = 0; c < 4; c++) s[r + 4 * ((c + r) % 4)] = t[r + 4 * c]; }
function nyMC(s) { for (let c = 0; c < 4; c++) { const i = 4 * c, a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3]; s[i] = nyMul2(a0) ^ nyMul3(a1) ^ a2 ^ a3; s[i + 1] = a0 ^ nyMul2(a1) ^ nyMul3(a2) ^ a3; s[i + 2] = a0 ^ a1 ^ nyMul2(a2) ^ nyMul3(a3); s[i + 3] = nyMul3(a0) ^ a1 ^ a2 ^ nyMul2(a3); } }
function nyIMC(s) { for (let c = 0; c < 4; c++) { const i = 4 * c, a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3]; s[i] = nyMul14(a0) ^ nyMul11(a1) ^ nyMul13(a2) ^ nyMul9(a3); s[i + 1] = nyMul9(a0) ^ nyMul14(a1) ^ nyMul11(a2) ^ nyMul13(a3); s[i + 2] = nyMul13(a0) ^ nyMul9(a1) ^ nyMul14(a2) ^ nyMul11(a3); s[i + 3] = nyMul11(a0) ^ nyMul13(a1) ^ nyMul9(a2) ^ nyMul14(a3); } }
function nyEncBlock(b, w) { const s = b.slice(); nyAR(s, w, 0); for (let r = 1; r <= 9; r++) { nySB(s); nySR(s); nyMC(s); nyAR(s, w, r); } nySB(s); nySR(s); nyAR(s, w, 10); return s; }
function nyDecBlock(b, w) { const s = b.slice(); nyAR(s, w, 10); for (let r = 9; r >= 1; r--) { nyISR(s); nyISB(s); nyAR(s, w, r); nyIMC(s); } nyISR(s); nyISB(s); nyAR(s, w, 0); return s; }
function nyAesEncrypt(plaintext, keyBuf) {
  const w = nyKeyExpansion(keyBuf);
  const pt = new TextEncoder().encode(plaintext);
  const pad = 16 - (pt.length % 16);
  const p = new Uint8Array(pt.length + pad); p.set(pt);
  for (let i = pt.length; i < p.length; i++) p[i] = pad;
  const out = new Uint8Array(p.length);
  for (let off = 0; off < p.length; off += 16) out.set(nyEncBlock(p.slice(off, off + 16), w), off);
  return bytesToB64(out);
}
function nyAesDecrypt(b64, keyBuf) {
  const w = nyKeyExpansion(keyBuf);
  const ct = b64ToBytes(b64);
  const out = new Uint8Array(ct.length);
  for (let off = 0; off < ct.length; off += 16) out.set(nyDecBlock(ct.slice(off, off + 16), w), off);
  let len = out.length; const p = out[len - 1];
  if (p >= 1 && p <= 16) len -= p;
  return new TextDecoder().decode(out.slice(0, len));
}

// 统一 HTTP 出口：本地 serve.mjs 注入 nodeTransport（直连 https，绕过全局代理），
// 线上 Workers 用原生 fetch。transport 缺省时退化为全局 fetch（浏览器/Worker 环境）。
async function nyHttp(url, init, transport) {
  return transport ? transport(url, init) : fetch(url, init);
}
// 拉取一次「公钥 + 会话 Cookie」：南银 ePortal 的 RSA 私钥按 JSESSIONID 存于会话，
// 必须回放该 Cookie 服务端才能用对应私钥解密，且公钥每次请求都会轮换，故缓存按失败作废。
async function nanyinGetSession(transport) {
  if (nanyinSession) return nanyinSession;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await nyHttp(NANYIN_PUBKEY_URL, {
      headers: { "User-Agent": "Mozilla/5.0", "Referer": NANYIN_HOST + "/nanyinwealth/lccp/cpjz/index.html" },
      signal: ctrl.signal,
    }, transport);
    const cookie = nyCookieHeader(res.headers.get("set-cookie"));
    const j = await res.json();
    nanyinSession = { ...nySpkiToKeys(j.data), cookie };
    return nanyinSession;
  } finally { clearTimeout(timer); }
}
async function nanyinPost(url, body, transport, cookie) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const headers = { "Content-Type": "application/json; charset=utf-8", "User-Agent": "Mozilla/5.0", "Referer": NANYIN_HOST + "/nanyinwealth/lccp/cpjz/index.html" };
    if (cookie) headers["Cookie"] = cookie;
    const res = await nyHttp(url, { method: "POST", headers, body, signal: ctrl.signal }, transport);
    return await res.text();
  } finally { clearTimeout(timer); }
}
// 单次加密调用（内部带 RSA 偶发失败重试）；成功返回解密后的 JSON 对象，失败返回 null
async function nanyinCall(url, payload, tries = 4, transport) {
  for (let t = 0; t < tries; t++) {
    if (t > 0) await nySleep(500 * t);
    let pub;
    try { pub = await nanyinGetSession(transport); }
    catch (e) { nanyinSession = null; continue; } // 取公钥/会话失败，作废后重试
    const keyBuf = nyGenKey();
    try {
      const body = JSON.stringify({
        data: await nyAesEncrypt(JSON.stringify(payload), keyBuf),
        aesKey: nyRsaEncrypt(keyBuf, pub.n, pub.e, pub.keyBytes),
        timeStamp: await nyAesEncrypt(String(Date.now()), keyBuf),
      });
      const j = JSON.parse(await nanyinPost(url, body, transport, pub.cookie));
      let cipher = (j && j.data && typeof j.data === "object" && j.data.data) ? j.data.data
                 : (j && typeof j.data === "string") ? j.data : null;
      if (!cipher) {
        nanyinSession = null; // 服务端无法解密（会话失效/公钥轮换）→ 作废，下次取新会话
        if (j && j.errorMessage && /产品编码/.test(j.errorMessage)) continue;
        return null;
      }
      return JSON.parse(nyAesDecrypt(cipher, keyBuf));
    } catch (e) {
      nanyinSession = null; // 解密/网络异常，作废会话后重试
      /* 重试 */
    }
  }
  return null;
}
function nyNormDate(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}
function nyRiskToR(level) {
  const m = { 1: "R1", 2: "R2", 3: "R3", 4: "R4", 5: "R5" };
  return m[parseInt(level, 10)] || null;
}
function nyHoldDays(detail) {
  const title = String(detail.title || detail.parentProductName || "");
  const m = title.match(/最低持有(\d+)天/);
  if (m) return parseInt(m[1], 10);
  if (/日开|每日开放|每日/.test(title)) return 1;
  const pt = parseInt(detail.productTerm, 10);
  return isNaN(pt) || pt < 1 ? null : pt;
}
async function nanyinFetchSeries(code, maxPoints = 600, transport, since) {
  if (since) {
    // 2026-10-31 增量：通用 early-stop（DESC/ASC 自动判定，提前停翻页只回 >since 的新增点）
    const getPage = async (pn) => {
      const r = await nanyinCall(NANYIN_NVL_URL, { productCode: code, currentPage: pn }, 4, transport);
      if (!r || !Array.isArray(r.aaData)) return { rows: [], totalPages: null, isLast: true, pageSize: NANYIN_PAGE_SIZE };
      const rows = r.aaData
        .map((it) => ({ date: nyNormDate(it.date), value: parseFloat(it.netValue) }))
        .filter((x) => x.date && Number.isFinite(x.value) && x.value > 0);
      const len = r.aaData.length || NANYIN_PAGE_SIZE;
      const totalPages = Number.isFinite(Number(r.totalCount)) && Number(r.totalCount) > 0
        ? Math.ceil(Number(r.totalCount) / len) : null;
      const isLast = !r.aaData.length || r.aaData.length < NANYIN_PAGE_SIZE;
      return { rows, totalPages, isLast, pageSize: len };
    };
    const res = await incrementalNavPages(getPage, since);
    return res.rows;
  }
  // 原有全量路径（添加产品 / 旧前端）
  const all = [];
  let page = 1;
  while (page <= 60) {
    const r = await nanyinCall(NANYIN_NVL_URL, { productCode: code, currentPage: page }, 4, transport);
    if (!r || !Array.isArray(r.aaData)) break;
    if (!r.aaData.length) break;
    for (const it of r.aaData) {
      const d = nyNormDate(it.date);
      const v = parseFloat(it.netValue);
      if (d && !isNaN(v)) all.push([d, v]);
    }
    if (all.length >= (r.totalCount || maxPoints)) break;
    if (r.aaData.length < 10) break;
    if (all.length >= maxPoints) break;
    page++;
  }
  all.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return all;
}
export async function nanyinFetch(code, opts = {}) {
  const c = String(code || "").trim().toUpperCase();
  const transport = opts && opts.transport;
  if (!c) return null;
  // 2026-10-22 用户规则：信息接口不再当「存在性/现金类」闸门——nav 模式直接抓净值，
  // 跳过产品详情 NANYIN_PD_URL（现金类已在添加产品 UI 拦截，产品均为真实产品，不存在即抓空）。
  const __navMode = (opts.mode || "all") === "nav";
  // 【2026-10-23 用户规则】刷信息只刷信息、刷额度只刷额度——两者都不抓净值。
  // 南银净值走 nanyinFetchSeries（逐点翻页），信息在 NANYIN_PD_URL 详情。
  const __noNav = opts.mode === "info" || opts.mode === "quota";
  let detail = null;
  if (!__navMode) {
    for (let attempt = 0; attempt < 3; attempt++) {
      detail = await nanyinCall(NANYIN_PD_URL, { productCode: c }, 4, transport);
      if (detail && detail.title) break;
      await nySleep(400);
    }
  }
  const series = __noNav ? [] : await nanyinFetchSeries(c, 600, transport, opts.since);
  // 增量模式(since)：0 新增点=已最新（有效结果），不可按「无序列」拒绝（否则回落中国理财网全量兜底）
  if (!__noNav && !series.length && !opts.since) return null;
  const d = detail || {}; // nav 模式 detail 为空 → 信息字段自然为 null（由 d.x 安全取值）
  // 【项目规则 2026-10-21】现金管理类（官网详情 variety==="3"，净值口径为万份收益）
  // → 净值/信息/额度一律不收录。此前只在注释里声明、代码未落地，
  // info/quota 模式（不抓序列、「整段恒 1」判据失效）会把现金类当普通产品收录（2026-10-23 审计修复）。
  if (String(d.variety) === "3") return { _excludedCash: true, code: c };
  const name = d.title || d.parentProductName || c;
  const manager = "南银理财";
  return {
    name,
    manager,
    established: nyNormDate(d.firstShareDate),
    series,
    kind: "nav", // 走到这里的都是单位净值型固收产品
    risk: nyRiskToR(d.riskLevel),
    benchmark: null,
    holdDays: nyHoldDays(d),
    regCode: d.financingRegisterCode || d.regCode || null,
    source: "nanyin",
    raw: { variety: d.variety },
    navIncremental: !!opts.since && !__noNav,
  };
}

/* ==========================================================================
 * 上海银行（BOSC）—— 净值披露接口（无需登录，仅需 Referer；响应无 CORS 头，
 *       浏览器直连被拦，须 Worker 代理）。
 *
 * 历史净值接口（GET）：
 *   /apiQry/apiPCQry/v2/qryMCFinanceNetProHisValueForPersonPage
 *     ?prdCode=<CODE>&taCode=&prodSeries=&size=20&current=N
 *   响应 data.records[]：prdCode / prdName / navDate(YYYY/MM/DD) / nav(单位净值)
 *     / totNav(累计净值) / taCode / taShortName(管理人) / prodSeriesName / compareMark(业绩比较基准)
 *   分页：data.total / data.pages，size 固定 20（50 会 502）。prdCode 精确过滤，
 *        空 taCode 即可返回数据（旧资料称"需 taCode"，实测空值即生效）。
 *   注：该接口不返回风险等级与登记编码（监管 Z7…），本实现 risk/regCode 置 null。
 * 净值口径：净值型，统一取 nav（单位净值）当单位净值用，kind:"nav"。
 * ========================================================================== */

const BOSC_HOST = "https://www.bosc.cn";
const BOSC_NAV_EP = "/apiQry/apiPCQry/v2/qryMCFinanceNetProHisValueForPersonPage";
const BOSC_PAGE_SIZE = 20;
const BOSC_MAX_PAGES = 40;
// 2026-10-22：15s→10s。旧值 15s 从未真正生效——nodeTransport 忽略 AbortSignal，
// 银行 WAF 挂起连接时白等 OS 级 TCP 超时（实测 21.5s/次）；已修 transport 支持 signal。
const BOSC_TIMEOUT_MS = 10000;
// 剩余页并发翻页批次参数：6 并发 + 200ms 批次间隔（402 点 21 页：串行 25s → ~7s）
const BOSC_PAGE_CONC = 6;
const BOSC_BATCH_GAP_MS = 200;

// 最短持有天数：日日开 / 每日开放 / 现金管理 → 1；否则从「X天 / X个月 / X年」提取
function boscHoldDays(desc) {
  const t = String(desc || "");
  if (/日日开|每日开放|日开|天天开|现金管理|活期/.test(t)) return 1;
  const m = t.match(/(\d+)\s*天/);
  if (m) return Number(m[1]);
  const mo = t.match(/(\d+)\s*个?月/);
  if (mo) return Number(mo[1]) * 30;
  const y = t.match(/(\d+)\s*年/);
  if (y) return Number(y[1]) * 365;
  return null;
}

const boscSleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boscGet(path, params, transport, retries = 3) {
  const qs = Object.entries(params).map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BOSC_TIMEOUT_MS);
  try {
    const res = await (transport || fetch)(BOSC_HOST + path + "?" + qs, {
      headers: {
        "User-Agent": UA,
        Referer: "https://www.bosc.cn/zh/dtjr/grlc/jzx/",
        Accept: "application/json, text/plain, */*",
      },
      signal: ctrl.signal,
    });
    const ct = res.headers.get("content-type") || "";
    if (!res.ok || !/json/i.test(ct)) {
      // 偶发 HTML 错误页（bosc.cn 对非 JSON 响应）—交给重试
      if (retries > 0) { await boscSleep(350); return boscGet(path, params, transport, retries - 1); }
      return null;
    }
    const j = await res.json();
    return j && j.data != null ? j.data : null;
  } catch (e) {
    if (retries > 0) { await boscSleep(350); return boscGet(path, params, transport, retries - 1); }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function boscWebFetch(code, opts = {}) {
  const transport = opts.transport;
  const since = opts.since;
  const raw = [];
  let meta = null;
  let upstreamFailed = false;

  // 收集一页记录（只收本产品码；顺带记住首个带名称的行作 meta）
  const collect = (d) => {
    const recs = (d && d.records) || [];
    for (const r of recs) {
      if (r.prdCode !== code) continue; // 防御：确保只收本产品
      if (!meta && r.prdName) meta = r;
      const dt = bobNormDate(r.navDate);
      const v = parseFloat(r.nav);
      if (!dt || !Number.isFinite(v) || v <= 0) continue;
      raw.push([dt, Number(v.toFixed(8))]);
    }
    return recs.length;
  };

  if (since) {
    // 2026-10-31 增量：since 给定 → 通用 early-stop（DESC/ASC 自动判定，提前停翻页只回 >since 的新增点）
    let maxSeen = ""; // 本腿在 bosc 见到的最新净值日（判「bosc 是否落后于本地」用）
    const getPage = async (pn) => {
      const d = await boscGet(BOSC_NAV_EP, {
        prdCode: code, taCode: "", prodSeries: "", size: BOSC_PAGE_SIZE, current: pn,
      }, transport, pn === 1 ? 0 : 1);
      if (d === null) return { rows: [], totalPages: null, isLast: true, pageSize: BOSC_PAGE_SIZE, failed: true };
      const recs = (d && d.records) || [];
      // 增量路径也要记住 meta（首个带名称的本产品行）——全量路径由 collect() 负责；
      // 增量路径不记则 0 新增点时 name/benchmark 恒空，前端只能沿用旧值。
      if (!meta) {
        const m = recs.find((r) => r && r.prdCode === code && r.prdName);
        if (m) meta = m;
      }
      const rows = recs
        .filter((r) => r.prdCode === code)
        .map((r) => ({ date: bobNormDate(r.navDate), value: parseFloat(r.nav) }))
        .filter((x) => x.date && Number.isFinite(x.value) && x.value > 0);
      for (const x of rows) if (x.date > maxSeen) maxSeen = x.date;
      const totalPages = Number.isFinite(d.pages) ? Math.min(d.pages, BOSC_MAX_PAGES) : null;
      const isLast = pn >= (totalPages || 0) || recs.length < BOSC_PAGE_SIZE;
      return { rows, totalPages, isLast, pageSize: BOSC_PAGE_SIZE };
    };
    // 第 1 页 null = 上游不可达（与全量路径一致：boscGet 在 retries=0 时返回 null）
    const first = await getPage(1);
    if (first.failed) {
      upstreamFailed = true;
    } else {
      const res = await incrementalNavPages(getPage, since);
      for (const p of res.rows) raw.push(p);
      // 2026-11-01 (B) 根治之二：0 新增点必须分三种情形，不能一律 return null——
      //   ① res.ok=false → bosc 首页即无该产品数据（含被拦截返空）→ 本腿无数据 → null 交编排层回落中国理财网；
      //   ② res.ok=true 且 bosc 最新披露日 === since → bosc 与本地同步、确无新点 =「已是最新」→
      //      按铁律**禁止回落全量源**（回落 = 白等 20~40s + 撞 xpl 503 限流 = 用户说的「偶尔抓不到」）→
      //      故返回 0 点成功标记（navIncremental:true），编排层 navLegOk 据此直接采纳本腿；
      //   ③ res.ok=true 但 bosc 最新披露日 < since → bosc 披露**落后于**本地 → 不敢断言已是最新 → 仍 null 回落。
      //   （旧实现三态一律走到 ded[0][0]，ded 为空 → TypeError 崩腿 → 被拒 → 回落中国理财网 → 撞 503。）
      if (!raw.length && res.ok && maxSeen === since) {
        return {
          name: meta ? meta.prdName : null,
          manager: meta && meta.taShortName ? meta.taShortName.trim()
            : (meta && meta.prdName ? inferManager(meta.prdName) : null),
          established: null, // 无序列，不能从首点推成立日（宁可空缺也不写错）
          establishedFromSeries: false,
          series: [],
          kind: "nav",
          risk: null,
          benchmark: meta && meta.compareMark ? meta.compareMark.trim() : null,
          holdDays: meta ? boscHoldDays(meta.prdName) : null,
          regCode: null,
          source: "live",
          bank: "bosc",
          navVia: "bosc",
          navPort: "web",
          navIncremental: true,
        };
      }
    }
  } else {
    // 原有全量路径（添加产品 / 旧前端）：首頁 + 剩余页 6 并发批量抓
    // ① 第 1 页：单次尝试不重试——被拦截/不可达时 10s 内明确失败（旧实现重试 1 次，
    //    叠加 signal 失效白等 OS TCP 超时，首页就要 43s），随即由循环外 xpl 兜底接住。
    const d1 = await boscGet(BOSC_NAV_EP, {
      prdCode: code, taCode: "", prodSeries: "", size: BOSC_PAGE_SIZE, current: 1,
    }, transport, 0);
    if (d1 === null) {
      // boscGet 返回 null = 拿不到 JSON（超时 / 被拦截 / HTML 错误页）→ 上游不可达
      upstreamFailed = true;
    } else {
      collect(d1);
      const total = Number.isFinite(d1.total) ? d1.total : null;
      const pages = Number.isFinite(d1.pages) ? Math.min(d1.pages, BOSC_MAX_PAGES) : null;
      if (pages && pages > 1) {
        // ② 剩余页并发抓：4 页一批、批间 250ms。整段从「串行+每页 sleep150」的
        //    21 页 25s 降到 ~6s；偶发失败页/空页就地重试，仍失败则跳过（已抓部分可用）。
        const rest = [];
        for (let p = 2; p <= pages; p++) rest.push(p);
        for (let i = 0; i < rest.length; i += BOSC_PAGE_CONC) {
          const batch = rest.slice(i, i + BOSC_PAGE_CONC);
          await Promise.all(batch.map(async (p) => {
            for (let t = 0; t < 3; t++) {
              const d = await boscGet(BOSC_NAV_EP, {
                prdCode: code, taCode: "", prodSeries: "", size: BOSC_PAGE_SIZE, current: p,
              }, transport, 1);
              if (d && (d.records || []).length) { collect(d); return; }
              if (d === null) return; // 网络层失败（boscGet 内部已重试 1 次）→ 放弃该页
              await boscSleep(200);   // 空页：稍等再试
            }
          }));
          if (total && raw.length >= total) break; // 已收满 total 条 → 提前收工
          await boscSleep(BOSC_BATCH_GAP_MS);
        }
      } else if (!pages) {
        // 极端情况：响应未回 pages 字段 → 退化原串行翻页（连续 2 页空即停）
        let page = 2, emptyStreak = 0;
        for (;;) {
          const d = await boscGet(BOSC_NAV_EP, {
            prdCode: code, taCode: "", prodSeries: "", size: BOSC_PAGE_SIZE, current: page,
          }, transport, 2);
          if (!d || !(d.records || []).length) {
            if (++emptyStreak >= 2) break;
            await boscSleep(300);
            continue;
          }
          emptyStreak = 0;
          collect(d);
          if (total && raw.length >= total) break;
          if (++page > BOSC_MAX_PAGES) break;
          await boscSleep(150);
        }
      }
    }
  }
  // bosc 直连被拦截/不可达，或查无数据：
  // 若本产品已在 XPL_SHARE_REG 登记登记编码 → 回落中国理财网「信息披露平台」(xinxipilu)
  // 取完整净值序列（规避银行拦截数据中心 IP）；否则被拦截时抛明确错误提示用户。
  if ((upstreamFailed || !raw.length) && XPL_SHARE_REG[code]) {
    const x = await xplFallback(code, opts);
    if (x) return x;
  }
  if (upstreamFailed) {
    const e = new Error("上海银行(bosc.cn)净值接口连接失败或被拦截：请检查部署网络，或该银行可能拦截了数据中心(Cloudflare)出口 IP。可改用本机 serve.mjs 直连（住宅 IP 通常可达），或确认已在 XPL_SHARE_REG 为该代码登记登记编码以走中国理财网回落。");
    e.upstream = true; e.bankBlocked = true;
    throw e;
  }
  // 2026-11-01 (B) 根治：增量(since)模式下若 bosc 无新增点，raw 为空必须干净返回 null，
  // 让编排层从容回落（或标记已是最新），绝不能继续往下走到 ded[0][0] 崩溃。
  if (!raw.length) return null;
  raw.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const ded = [];
  for (const r of raw) {
    if (ded.length && ded[ded.length - 1][0] === r[0]) ded[ded.length - 1] = r;
    else ded.push(r);
  }
  const name = meta ? meta.prdName : null;
  const manager = meta && meta.taShortName ? meta.taShortName.trim() : (meta && meta.prdName ? inferManager(meta.prdName) : null);
  // 【项目规则 2026-10-21 立】现金管理类在 web 披露口表现为「单位净值整段恒 1」
  // （真实收益在万份收益，本接口不取该口径）→ 一律排除，不抓不处理。
  // 返回哨兵让编排层下发 isCash（2026-10-23 统一）。空序列(ded.length=0)不误判现金类。
  if (ded.length && ded.every((p) => Math.abs(p[1] - 1) < 1e-4)) return { _excludedCash: true, code };
  return {
    name,
    manager,
    established: ded.length ? ded[0][0] : null, // 2026-11-01 (B) 守卫：ded 为空时返回 null 而非崩溃
    establishedFromSeries: true, // 上银 web 披露无成立日字段（App 端口 EstabDate 走 boscAppFetch）
    series: ded,
    kind: "nav",
    risk: null,
    benchmark: meta && meta.compareMark ? meta.compareMark.trim() : null,
    holdDays: meta ? boscHoldDays(meta.prdName) : null,
    regCode: null,
    source: "live",
    navPort: "web", // 2026-11-01 (B)：显式标注端口（bosc 有 app/web 双端口，bankPortOf 推不出单端口）
    navIncremental: !!since,
  };
}

/* ==========================================================================
 * 上海银行（BOSC）App 端口 —— 手机银行 H5 网关（2026-10-16 打通，免登录）
 *
 * 站点：https://mbank.bankofshanghai.com/pweixin/<Service>.do（form-urlencoded POST）
 *   ① 产品详情：FinanceProductQry.do {PrdCode, MChannelId:"PMBS"} → List[0]
 *      ProductCode / ProductName / RiskLev(1-5)+RiskLevName / TrsPrice(最新净值) /
 *      IssueDate(发行日) / ValueDate(起息日) / ProductTerm(距到期天数；开放式=70年占位) /
 *      SoldOut(1=已售罄 / 0=在售) / ProductState / InTimeFlag / StartAmt / CustHiAmount …
 *   ② 历史净值：ProHistoryNetQry.do {PrdCode, BeginDate, EndDate} → List[]
 *      {PrdCode, PrdName, NavDate(YYYY/MM/DD), Nav, TotNav, DivDate…}，时间倒序。
 *      成立前有募集期占位点（Nav=TotNav=1.00000），按「前导 nav==1」裁剪；其后首个
 *      真实点即成立日（与 xpl 登记成立日一致，如 WPBK24M0201A=2024-09-10）。
 *   覆盖边界：仅「上海银行在售/代销」的产品（含代销他行理财，如交银稳享鑫荣日日开24号B
 *        5811225682）；认不得时 List 空（天然充当本行是否销售判据，无误抓）。
 *   网络：form-urlencoded + 移动端 UA（MicroMessenger/iPhone）即可，无需登录态/签名。
 *        本机 Node/undici 直连 www.bosc.cn 被墙（20s+ 挂起），但 mbank 子域可直连；
 *        Cloudflare Workers 出网栈未实测。
 *   不返回：登记编码(监管Z7…)、业绩比较基准(CompareMark 仅封闭式 PrdTemplate=1303 返回)、
 *        具体剩余额度数字（仅有 SoldOut 售罄标志）——登记编码/成立日/基准交编排层
 *        由中国理财网 metaFromChinaWealthXpl 按产品名补全（既有链路）。
 * ========================================================================== */

const BOSC_APP_HOST = "https://mbank.bankofshanghai.com";
const BOSC_APP_EP = BOSC_APP_HOST + "/pweixin/";
const BOSC_APP_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.42";
const BOSC_APP_REF = BOSC_APP_HOST + "/pweixin/static/index.html";
const BOSC_APP_TIMEOUT_MS = 15000;
// BOSC app 网关并发信号量（2026-10-16 性能优化）：
// 实测同一客户端 IP 下，3 个并发请求即使命请求也会被网关拖到 21s+ 后失败，
// 2 并发明显变慢（detail 4s / nav 7.3s），串行才快（0.2~1.7s / 3.7~7.6s）。
// 前端一次刷新 4 个产品 × 每产品 3 请求 = 12 并发，必然互相踩踏（用户实测单产品 32.9s）。
// 故所有 app 请求统一过本信号量：多产品并发刷新时排队分批打，单产品稳定在 ~5s。
const BOSC_APP_MAX_CONC = 2;
let boscAppActive = 0;
const boscAppWaiters = [];
function boscAppSlot() {
  if (boscAppActive < BOSC_APP_MAX_CONC) { boscAppActive++; return Promise.resolve(); }
  return new Promise((res) => boscAppWaiters.push(res));
}
function boscAppRelease() {
  const w = boscAppWaiters.shift();
  if (w) w(); else boscAppActive--;
}

// BOSC 风险等级数字（1-5）→ R1..R5
function boscRiskToR(lev) {
  const n = parseInt(lev, 10);
  return n >= 1 && n <= 5 ? "R" + n : null;
}

async function boscAppPost(svc, params, transport) {
  // 先排队拿信号量，再开始计时——排队等待不计入单请求超时（否则队尾请求还没发出就已被 abort）
  await boscAppSlot();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BOSC_APP_TIMEOUT_MS);
  try {
    const res = await nyHttp(BOSC_APP_EP + svc + ".do", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Accept: "*/*",
        Origin: BOSC_APP_HOST,
        Referer: BOSC_APP_REF,
        "User-Agent": BOSC_APP_UA,
      },
      body: new URLSearchParams(params).toString(),
      signal: ctrl.signal,
    }, transport);
    if (!res || !res.ok) return null;
    const txt = await res.text();
    try { return JSON.parse(txt); } catch { return null; }
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
    boscAppRelease();
  }
}

// ③ 产品详情（全字段）。注：FinanceProductQry 响应字段集不稳定——CompareMark/EstabDate/
//   NAVDate 等键时有时无（实测同一产品两次请求一次带一次不带），故缺关键字段时补发一次取并集。
//   2026-10-16 性能优化：串行化后单发即可稳定命中 CompareMark（实测 6 连发全带），
//   补发从「无条件双发并行」改为「仅当缺 CompareMark 时补发」，省掉常态下的多余请求。
async function boscAppInfo(code, transport) {
  const j1 = await boscAppPost("FinanceProductQry", { PrdCode: code, MChannelId: "PMBS" }, transport).catch(() => null);
  const d1 = j1 && Array.isArray(j1.List) && j1.List[0];
  if (!d1 || !d1.ProductCode) return null;
  if (d1.CompareMark) return d1; // 关键字段齐全，无需补发
  const j2 = await boscAppPost("FinanceProductQry", { PrdCode: code, MChannelId: "PMBS" }, transport).catch(() => null);
  const d2 = j2 && Array.isArray(j2.List) && j2.List[0];
  if (!d2 || !d2.ProductCode) return d1;
  const merged = { ...d1 };
  for (const [k, v] of Object.entries(d2)) {
    if (v != null && v !== "" && (merged[k] == null || merged[k] === "")) merged[k] = v;
  }
  return merged;
}

// ② 成立以来全量净值序列（顺排、去重、裁募集期占位点；现金管理类按项目规则排除）。
//   注：ProHistoryNetQry 偶发返空/超时（实测同一产品两次一次 397 点一次 0 点，
//   其中返空多为并发踩踏所致），故失败重试至多 3 次；重试经信号量重新排队，不会加剧并发。
//   窗口：网关耗时随响应体线性增长（实测 613KB/2000点→23s，336KB/1096点→7.6s，112KB/365点→2.8s），
//   官方 app 自身也用有界窗口（收益查询默认 3m）。故默认取近 3 年：成立不足 3 年的产品
//   （占绝大多数，如聚宝盈60天1号 483 点全部落在窗口内）等于全量；超长历史产品
//   （如易精灵1号 2021 年起 2000 点）按 3 年截断，最坏耗时从 23s 压到 ~8s。
const BOSC_APP_NAV_YEARS = 3;
async function boscAppNav(code, transport) {
  const now = Date.now() + 8 * 3600 * 1000; // 北京时间
  const end = new Date(now).toISOString().slice(0, 10);
  const begin = new Date(now - BOSC_APP_NAV_YEARS * 365 * 86400000).toISOString().slice(0, 10);
  let rows = [];
  for (let attempt = 1; attempt <= 3 && !rows.length; attempt++) {
    const j = await boscAppPost("ProHistoryNetQry", { PrdCode: code, BeginDate: begin, EndDate: end }, transport);
    rows = j && Array.isArray(j.List) ? j.List : [];
    if (!rows.length && attempt < 3) await new Promise((r) => setTimeout(r, 800));
  }
  if (!rows.length) return { series: [], navBasis: "nav", winBegin: null };
  const pts = [];
  for (const r of rows) {
    const d = bobNormDate(r && r.NavDate);
    const nav = parseFloat(r && r.Nav);
    const tot = parseFloat(r && r.TotNav);
    if (d && Number.isFinite(nav) && nav > 0) pts.push({ d, nav, tot: Number.isFinite(tot) ? tot : nav });
  }
  if (!pts.length) return { series: [], navBasis: "nav", winBegin: begin };
  pts.sort((a, b) => (a.d < b.d ? -1 : 1));
  // 【项目规则 2026-10-21 立】现金管理类：nav 恒 1 而累计净值递增 → 一律排除。
  // 历史上的「取 TotNav 作展示序列（navBasis:"tot"）」现金类处理已删除：
  // 标记 cash 让上层直接返回 null，不做任何展示序列合成，勿再 reintroduce。
  const flatNav = pts.every((p) => Math.abs(p.nav - 1) < 1e-4);
  const totVar = pts.some((p) => Math.abs(p.tot - 1) > 1e-4);
  if (flatNav && totVar) return { series: [], navBasis: "nav", winBegin: begin, cash: true };
  // 裁募集期占位点：前导 nav==1（认购期披露占位），至少保留 1 点
  let start = 0;
  while (start < pts.length - 1 && Math.abs(pts[start].nav - 1) < 1e-4) start++;
  const out = pts.slice(start).map((p) => [p.d, Number(p.nav.toFixed(8))]);
  const ded = [];
  for (const p of out) {
    if (ded.length && ded[ded.length - 1][0] === p[0]) ded[ded.length - 1] = p;
    else ded.push(p);
  }
  return { series: ded, navBasis: "nav", winBegin: begin };
}

// App 端口一键抓取：详情 + 全量净值（同产品内串行——实测同产品 2 并发会偶发触发网关
// stall（请求挂起 20s+ 后被 abort），串行后单连接稳定 4~9s；不同产品间仍可经信号量并行）
async function boscAppFetch(code, transport, mode = "all") {
  // 【2026-10-23 用户规则】刷信息只刷信息、刷额度只刷额度——两者都不抓净值。
  // 上海银行 App 端口：boscAppInfo（信息+售罄标志）与 boscAppNav（全量净值）是两个接口。
  const __noNav = mode === "info" || mode === "quota";
  const info = await boscAppInfo(code, transport).catch(() => null);
  const nav = __noNav ? { series: [], navBasis: "nav" } : await boscAppNav(code, transport).catch(() => ({ series: [], navBasis: "nav" }));
  // 【项目规则 2026-10-21】现金管理类（nav 恒 1 + 累计净值递增）不抓：
  // 返回哨兵（产品信息也不收录），交编排层下发 isCash 让前端提示原因。
  if (nav && nav.cash) return { _excludedCash: true, code };
  const series = (nav && nav.series) || [];
  if (!info && !series.length) return null; // 无此产品 / 未收录
  const name = (info && info.ProductName) || null;
  const last = series.length ? series[series.length - 1] : null;
  const soldOut = info != null && String(info.SoldOut) === "1";
  // 成立日期：① 详情 EstabDate（不稳定字段，有则最可信）→ ② 净值序列首点（仅当序列
  // 起点明显晚于 3 年窗口起点时才是真实成立日；贴近窗口起点说明产品早于 3 年成立，
  // 首点被窗口截断）→ ③ 起息日 ValueDate 兜底。
  const seriesStart = series.length ? series[0][0] : null;
  const winBegin = (nav && nav.winBegin) || null;
  let estFromSeries = seriesStart;
  if (seriesStart && winBegin) {
    // 序列起点距窗口起点 ≤7 天 → 产品早于 3 年成立，首点被窗口截断，不是真实成立日
    const wb = new Date(winBegin + "T00:00:00Z").getTime();
    const ss = new Date(seriesStart + "T00:00:00Z").getTime();
    if (Number.isFinite(wb) && Number.isFinite(ss) && ss - wb <= 7 * 86400000) estFromSeries = null;
  }
  const base = {
    name,
    manager: name ? inferManager(name) : null,
    established: bobNormDate(info && info.EstabDate) || estFromSeries || bobNormDate(info && info.ValueDate) || seriesStart || null,
    series,
    kind: "nav",
    navBasis: (nav && nav.navBasis) || "nav",
    risk: boscRiskToR(info && info.RiskLev),
    benchmark: (info && info.CompareMark) || null, // 开放式不返回；封闭式(1303)才有
    holdDays: boscHoldDays(name),
    regCode: null, // App 端口无登记编码，交编排层由中国理财网补
    source: "live",
    bank: "bosc",
    navVia: "bosc",
    navPort: "app",
    navViaCode: code,
    navLatest: last ? last[1] : (info && info.TrsPrice != null ? Number(info.TrsPrice) : null),
    navLatestDate: last ? last[0] : null,
    // 额度：App 端口仅有 SoldOut 售罄标志（1=已售罄/0=在售），无具体剩余额度数字
    quotaState: info != null ? (soldOut ? "sold_out" : "available") : null,
    quotaText: info != null ? (soldOut ? "已售罄" : "在售") : null,
    saleStatus: info && info.ProductState != null ? String(info.ProductState) : null,
    appStatus: info && info.InTimeFlag != null ? String(info.InTimeFlag) : null,
    appMinAmt: info && info.StartAmt != null ? Number(info.StartAmt) : null,
  };
  if (series.length < 2) base.infoOnly = true;
  return base;
}

// 上海银行入口（2026-10-16 用户规则：上海银行抓净值和信息先走 app 端口）：
//   ① App 端口（mbank.bankofshanghai.com/pweixin，免登录）：全量净值 + 产品信息 + 售罄标志
//   ② www.bosc.cn web 端口（净值披露接口；对数据中心 IP 可能不可达，本地 serve.mjs 亦常超时）
//   ③ 已在 XPL_SHARE_REG 登记的经中国理财网 xpl 兜底
export async function boscFetch(code, opts = {}) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  const transport = opts && opts.transport;
  // 2026-10-22 修复：nav 模式只抓净值 → 跳过 App 端口（boscAppFetch 会顺带回产品信息/额度，属分解杂项），
  // 直接走 www.bosc.cn web 净值接口（单一 navlist 调用）。web 失败由编排层中国理财网兜底。
  const __navMode = opts.mode === "nav";

  // ① App 端口（优先，非 nav 模式）
  if (!__navMode) {
    try {
      const r = await boscAppFetch(c, transport, opts.mode || "all");
      // 现金管理类哨兵：直接透传（不回落 web 端口）
      if (r && r._excludedCash) return r;
      if (r && r.series && r.series.length >= 2) return r;
      // 有产品信息但净值不足 2 点（新发/募集期）：带信息返回，让编排层显示名称风险并继续兜底
      if (r && (r.name || r.risk)) return { ...r, series: r.series || [], infoOnly: true };
    } catch (e) { /* App 端口异常，回落 web 端口 */ }
  }
  // 【2026-10-23 用户规则】info/quota：App 端口已回信息 + 额度（售罄标志），
  // 不再走 ② www.bosc.cn web 净值接口（纯净值序列，刷信息/刷额度不该抓）。
  if (opts.mode === "info" || opts.mode === "quota") return null;

  // ② www.bosc.cn web 端口（原实现）
  return boscWebFetch(c, { transport, since: opts.since });
}

/* ==========================================================================
 * 农业银行（ABC）实时抓取
 *
 * 站点：https://ewealth.abchina.com.cn （农行理财 e 站，官方信披平台）
 * 接口（均免签名 / 免 Token；响应无 Access-Control-Allow-Origin，浏览器直连被拦，
 *       故须服务端 / Worker 代理。CORS 不影响服务端抓取）：
 *   ① 历史净值（GET）：/app/data/api/DataService/OwnProdNetValueFilterV3?i=<页>&s=50&w=<产品代码>
 *      响应 Data.Table[{ProdNo, Prodname, NetValue, accNetValue, NetDate}]，
 *      Data.Table1[0].total 为总条数（单页上限 50）。
 *      ⚠ 成立日前有「认购期」占位行（NetValue=1.000000，日期早于 estblDate），按成立日过滤。
 *   ② 产品信息（POST）：/app/data/api/DataService/FsProdInfo
 *      body {"data":{"keyword":<代码>,"isNew":"1"}}；响应 result.Table 含名称 / 管理人 /
 *      风险等级 / 业绩比较基准 / 最短持有期 / 成立日 / 到期日等。
 *
 * 净值口径：该接口仅披露单位净值 NetValue（无万份收益字段），一律按净值型(nav)处理。
 * 难度：全行最低之一，接近工行（无签名无 Token），仅缺登记编码（监管 Z700… 编码农行公开接口不返回，
 *       如需可由中国理财网按「产品名 + 农银理财有限责任公司」补，本实现返回 null）。
 * ========================================================================== */

const ABC_HOST = "https://ewealth.abchina.com.cn";
const ABC_NAV_EP = "/app/data/api/DataService/OwnProdNetValueFilterV3";
const ABC_INFO_EP = "/app/data/api/DataService/FsProdInfo";
const ABC_PAGE_SIZE = 50;
// 分页上限：Worker 免费版单次调用最多 50 个子请求。abcFetch = 1(信息) + 翻页，
// 取 40 页(2000 点) + 1 = 41 个子请求，留足余量；可覆盖约 5.5 年日频披露历史。
const ABC_MAX_PAGES = 40;
const ABC_TIMEOUT_MS = 12000;

/* ==========================================================================
 * 农银理财官网（abcwealth.com.cn）净值主源 —— 2026-10-21 接入
 *
 * 为什么加：农行渠道净值此前只取农行母行平台 ewealth.abchina.com.cn，实测该平台
 * 比发行人（农银理财）官网慢一个披露日（NYJQLD301：官网 10-21 已出，ewealth 仅到
 * 10-20；NYJXLD90：官网 10-20，ewealth 仅到 10-19）。ewealth 的净值由农银理财报送、
 * 与官网同源（实测 1000+ 重合点零差异），故官网可作主源，ewealth 降级为
 * 「官网缺的早期历史 + 官网不可达时兜底」。
 *
 * 官网 API（Vue SPA 后端 /awpsservice，逆向自产品披露页 productDetail）：
 *   ① find?productId=<码>&startDate=<yyyymmdd>&endDate=<yyyymmdd>&yieldType=UNIT_NET
 *      → data.yieldVOS[]，每项 {dateNet:"20261021", dataValue:单位净值, vluTotNet:累计净值}
 *      宽区间一次拉全历史、降序返回；未收录返回 code:"FAW010047"（该产品不存在）、空列表
 *   ② findHistoryYield?productId=<码>
 *      → dateEstablish(成立日) / indCashManageProduct("Y"=现金管理类) / dateNet(最新净值日)
 * 访问约束（实测）：必须带 Referer https://www.abcwealth.com.cn/；裸域名经代理 502，
 * 用 www 前缀；POST body 为 "{}" 即可，无签名无 Token。
 * TLS 注意：服务器走旧版重协商，Node 全局 fetch 直接报 SSL legacy renegotiation 禁用，
 * 本机验证走 test_transport.js（SSL_OP_LEGACY_SERVER_CONNECT）；Workers 出网由
 * Cloudflare 自己的 TLS 栈处理（工行 papi 同类问题在生产一直正常，故不受影响）。
 *
 * 官网边界（实测）：只保留近 ~1081 个披露日（NYJXLD90 数据从 2022-06-17 起，缺成立
 * 初期 15 个月 332 点；NYJQLD301 成立晚则全量 156 点都有）→ 必须双源合并：
 * 官网新段 + ewealth 老段，同日以官网为准（发行人权威且更新快）。
 * 另：官网只披露农银理财本家产品，农行代销的别家产品/渠道子份额（网商N/微众G 后缀）
 * 查无此码（FAW010047）→ 由 ewealth / xplFallback 接住，链条不受影响。
 * ========================================================================== */
const ABCW_HOST = "https://www.abcwealth.com.cn";
const ABCW_NAV_EP = "/awpsservice/fpproduct/productyield/find";
const ABCW_HIST_EP = "/awpsservice/fpproduct/productyield/findHistoryYield";
const ABCW_REFERER = "https://www.abcwealth.com.cn/";
// 宽日期区间：覆盖全部在售/存续产品成立至今（农银理财 2018 年成立），一次拉全历史
const ABCW_DATE_FROM = "20150101";
const ABCW_DATE_TO = "20991231";
const ABCW_TIMEOUT_MS = 15000;

// abcwealth 日期两种形态："20261021"（dateNet）/ "2026-03-06 00:00:00.0 CST"（dateEstablish）
// → 统一归一为 "2026-03-06"（前缀匹配，兼容带时间后缀的形态）
function abcwNormDate(s) {
  const d = String(s || "").replace(/[^0-9]/g, "");
  const m = d.match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// 官网 POST 公共入口；网络/超时异常直接抛给调用方（abcFetch 内 try 接住转 ewealth）
async function abcwPost(ep, query, transport) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ABCW_TIMEOUT_MS);
  try {
    const res = await (transport || fetch)(ABCW_HOST + ep + "?" + query, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Referer": ABCW_REFERER,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: "{}",
      signal: ctrl.signal,
    });
    const j = await res.json();
    return j || null;
  } finally {
    clearTimeout(timer);
  }
}

// "2026-10-29" → "20261030"（农银官网 startDate 用 YYYYMMDD）
function ymdAdd1(s) {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  d.setUTCDate(d.getUTCDate() + 1);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${mo}${da}`;
}

// 官网全历史单位净值（UNIT_NET 口径，与 ewealth NetValue 同口径）；返回 [[日期, 单位净值]] 降序。
// 未收录（FAW010047）/ 异常 → 返回 []，由调用方转 ewealth。
// 2026-10-31 增量：since（本地序列末点）给定时，startDate 下推到 since+1（服务端过滤，少传历史），
//   并客户端再筛 d > since（双保险：即便服务端忽略 startDate 也只回新增点）。无 since → 全量。
async function abcwFetchNav(code, transport, since) {
  const start = since ? (ymdAdd1(since) || ABCW_DATE_FROM) : ABCW_DATE_FROM;
  const j = await abcwPost(
    ABCW_NAV_EP,
    `productId=${encodeURIComponent(code)}&startDate=${start}&endDate=${ABCW_DATE_TO}&yieldType=UNIT_NET`,
    transport
  );
  const rows = (j && j.data && j.data.yieldVOS) || [];
  const out = [];
  for (const v of rows) {
    const d = abcwNormDate(v.dateNet);
    const val = parseFloat(v.dataValue); // UNIT_NET 口径 dataValue=单位净值（现金类恒 1）
    if (d && Number.isFinite(val) && val > 0 && (!since || d > since)) out.push([d, val]);
  }
  return out;
}

// 官网汇总口：成立日 + 现金管理类标记（权威分类信号，铁律排除依据）
async function abcwFetchHist(code, transport) {
  const j = await abcwPost(ABCW_HIST_EP, `productId=${encodeURIComponent(code)}`, transport);
  const d = (j && j.data) || {};
  return {
    estbl: abcwNormDate(d.dateEstablish),
    cash: String(d.indCashManageProduct || "").toUpperCase() === "Y",
  };
}

// 兼容 "2026-09-29" 与 "20260513" 两种格式 → "2026-09-29"
function abcNormDate(s) {
  const d = String(s || "").replace(/[^0-9]/g, "");
  const m = d.match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// 农行风险等级文案 → R1..R5（顺序敏感：先判复合词，再判单字词）
function abcRiskToR(t) {
  if (!t) return null;
  if (/中低风险/.test(t)) return "R2";
  if (/中高风险/.test(t)) return "R4";
  if (/高风险/.test(t)) return "R5";
  if (/中风险/.test(t)) return "R3";
  if (/低风险/.test(t)) return "R1";
  return null;
}

// skipBefore：可选 {date, n}（date=官网首点日期，n=官网点数）。ewealth 只需提供「官网没有的
// 点」——早期段（< 官网首点）+ 官网末点之后的新段（实测极少）；中间覆盖段官网全有可弃。
// 降序翻页无法按日期提前停（短产品第 1 页就全晚于官网首点、更早页仍有数据），故用页数
// 估算：官网 n 点 ≈ ewealth 中 >= 官网首点的点数，直接从第 ceil((n-3)/50)+1-2 页起翻
// （冗余 2 页防两家口径差），长历史产品（NYJXLD90 1412 点）可从 ~29 页省到 ~9 页。
// 防御：起始页返回空（口径大幅偏离）时回退页 1 全量重翻。
async function abcFetchNav(code, transport, skipBefore) {
  const startPage =
    skipBefore && skipBefore.n > 3
      ? Math.max(1, Math.ceil((skipBefore.n - 3) / ABC_PAGE_SIZE) + 1 - 2)
      : 1;
  const out = [];
  let prodName = null;
  let restarted = false;
  for (let i = startPage; i <= ABC_MAX_PAGES; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ABC_TIMEOUT_MS);
    try {
      const res = await (transport || fetch)(
        ABC_HOST + ABC_NAV_EP + `?i=${i}&s=${ABC_PAGE_SIZE}&w=${encodeURIComponent(code)}`,
        { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ctrl.signal }
      );
      const j = await res.json();
      const data = (j && j.Data) || {};
      const rows = data.Table || [];
      if (!rows.length) {
        // 起始页就空：官网/ewealth 点数口径大幅偏离，回退页 1 全量重翻（仅一次）
        if (i === startPage && startPage > 1 && !restarted) {
          restarted = true;
          i = 0; // for 的 i++ 后从页 1 开始
          out.length = 0;
          prodName = null;
          continue;
        }
        break;
      }
      for (const r of rows) {
        if (!prodName && r.Prodname) prodName = r.Prodname;
        const d = abcNormDate(r.NetDate);
        const v = parseFloat(r.NetValue);
        if (d && Number.isFinite(v) && v > 0) out.push([d, v]);
      }
      const total = Number((data.Table1 && data.Table1[0] && data.Table1[0].total) || 0);
      if (out.length >= total || rows.length < ABC_PAGE_SIZE) break;
    } catch (e) {
      if (i === 1 || (i === startPage && startPage > 1 && !restarted)) {
        throw Object.assign(new Error("abc nav: " + ((e && e.message) || e)), { upstream: true });
      }
      break; // 翻页中途失败，已拿到的部分仍可用
    } finally {
      clearTimeout(timer);
    }
  }
  return { rows: out, prodName };
}

// 农行 ewealth 单页适配器（供 incrementalNavPages 复用）：返回 {rows:[{date,value}], isLast, totalPages, pageSize}
async function abcEwGetPage(code, transport, pn) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ABC_TIMEOUT_MS);
  try {
    const res = await (transport || fetch)(
      ABC_HOST + ABC_NAV_EP + `?i=${pn}&s=${ABC_PAGE_SIZE}&w=${encodeURIComponent(code)}`,
      { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ctrl.signal }
    );
    const j = await res.json();
    const data = (j && j.Data) || {};
    const raw = data.Table || [];
    const rows = raw
      .map((r) => ({ date: abcNormDate(r.NetDate), value: parseFloat(r.NetValue) }))
      .filter((r) => r.date && Number.isFinite(r.value) && r.value > 0);
    const total = Number((data.Table1 && data.Table1[0] && data.Table1[0].total) || 0);
    return {
      rows,
      isLast: rows.length < ABC_PAGE_SIZE,
      totalPages: total ? Math.ceil(total / ABC_PAGE_SIZE) : (rows.length < ABC_PAGE_SIZE ? 1 : null),
      pageSize: ABC_PAGE_SIZE,
    };
  } catch (e) {
    // 单页失败：返回空页（incrementalNavPages 会因「本页空」停翻，已抓部分仍可用）
    return { rows: [], isLast: true, totalPages: null, pageSize: ABC_PAGE_SIZE };
  } finally {
    clearTimeout(timer);
  }
}

async function abcFetchInfo(code, transport) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ABC_TIMEOUT_MS);
  try {
    const res = await (transport || fetch)(ABC_HOST + ABC_INFO_EP, {
      method: "POST",
      headers: { "Content-Type": "application/json;charset=UTF-8", "User-Agent": UA },
      body: JSON.stringify({ data: { keyword: code, isNew: "1" } }),
      signal: ctrl.signal,
    });
    const j = await res.json();
    return (j && j.result && j.result.Table) || null;
  } catch (e) {
    return null; // 信息接口失败不致命，净值接口独立可用
  } finally {
    clearTimeout(timer);
  }
}

/* ==========================================================================
 * 农行渠道净值抓取（2026-10-21 重构：官网主源 + ewealth 兜底 + 中国理财网兜底）
 *
 * 三级链路与理由：
 *   ① 农银理财官网 abcwealth.com.cn（主）：发行人官网，比农行母平台 ewealth 快一个
 *      披露日（用户报障 NYJQLD301「官网 10-21、我们 10-20」的根因与修复）。官网只
 *      存近 ~1081 个披露日，且只收录农银理财本家产品。
 *   ② 农行理财e站 ewealth.abchina.com.cn（兜底 + 早期历史）：净值由农银理财报送、
 *      与官网同源（重合点零差异），补官网缺失的成立初期历史；也是农行代销的别家
 *      产品（非农银理财发行）的唯一渠道；官网整体不可达时顶上来。
 *   ③ 中国理财网 xplFallback：农行渠道子份额（网商 N / 微众 G 后缀）两家都不收录。
 * 合并口径：ewealth 全段 ∪ 官网全段，同日以官网为准（发行人权威且更新快）。
 * 【项目规则 2026-10-21】现金管理类一律不抓：官网 indCashManageProduct="Y" 即权威
 *   分类信号直接排除；单位净值整段恒 1 作防御性判据（农银时时付 AKSSF1/AKSSFSH1/
 *   AKSSFDG1 等历史上从 ewealth 取到恒 1 净值被误收录，现一并纠正）。
 * ========================================================================== */
export async function abcFetch(code, opts = {}) {
  const transport = opts.transport;
  // 2026-10-22 修复：nav/quota 模式跳过 abcFetchInfo（产品信息/登记编码，仅信息字段，非净值主链路）。
  const __navMode = opts.mode === "nav";
  const __quotaMode = opts.mode === "quota";
  const __infoMode = opts.mode === "info";

  // 【2026-10-23 用户规则】刷信息只刷信息、刷额度只刷额度——两者都不抓净值。
  // 农行净值要走「农银理财官网 find + 农行 ewealth 翻页」两条链路（含双源合并），是耗时大头；
  // 信息全在 ewealth 的 FsProdInfo（abcFetchInfo）。农行无额度接口 → quota 模式零请求返回 null。
  if (__quotaMode) return null;
  if (__infoMode) {
    let inf = null;
    // 与信息接口并发送一次农银理财官网汇总口（≈300ms）：只为拿 indCashManageProduct
    // 这个权威现金类分类信号（农行 ewealth 的 FsProdInfo 无类型字段）。
    // 失败不影响信息返回（catch → cash:false，仍有名称兜底判据）。
    let abcwCash = false;
    try {
      const [i0, h0] = await Promise.all([
        abcFetchInfo(code, transport).catch(() => null),
        abcwFetchHist(code, transport).catch(() => null),
      ]);
      inf = i0;
      abcwCash = !!(h0 && h0.cash);
    } catch (e) { inf = null; }
    // 现金管理类 → 项目铁律：信息也不收录（三种模式一致）
    if (abcwCash) return { _excludedCash: true, code };
    if (!inf || !inf.productName) return null;
    let hd = null;
    if (inf.investTerm) {
      const mm = String(inf.investTerm).match(/(\d+)\s*天/);
      if (mm) hd = Number(mm[1]);
    }
    return {
      name: inf.productName,
      // 【2026-10-27 修复·硬编码兜底禁令】不得用「农银理财」当兜底：
      //   农行渠道货架上有他行理财子的产品（上银/招银/工银…），productSource 缺失或
      //   inferManager 认不出时一律写成「农银理财」→ 落盘净值记录的管理人被污染
      //   （实测 WPBK24M0501T/25G6728E/109463WS/FLJYXC18001/GH13201A 5 条全被写成农银理财），
      //   且前端 _computeRow 对「非自定义」产品会用净值库的 manager 覆盖登记库 → 发行行被误判。
      //   按铁律：名称能可靠识别机构才填，否则置 null（宁可空缺也不写错）。
      manager: inf.productSource ? inferManagerStrict(inf.productSource) : null,
      established: abcNormDate(inf.estblDate),
      series: [],
      kind: "nav",
      risk: abcRiskToR(inf.risk),
      benchmark: inf.mkrdBaseDscrOld || null,
      holdDays: hd,
      regCode: null, // 农行公开接口不返回登记编码
      source: "live",
      infoOnly: true,
    };
  }

  // === 增量分支（opts.since 给定 = 刷新）：只回 since 之后的新增点，不重翻历史 ===
  if (opts.since) {
    // ① 农银理财官网主源：startDate 下推到 since+1（服务端过滤）+ 客户端 d>since 双保险
    //   —— 真正源端增量（官网一次拿全的接口也能只取新增段，省掉动辄上千点的全历史传输/解析）。
    let navRows = [];
    let abcwMeta = { estbl: null, cash: false };
    try {
      navRows = await abcwFetchNav(code, transport, opts.since);
      // 判定产品是否在官网：用 hist 的 dateEstablish 信号（渠道子份额/代销别家不在官网→estbl 空）
      try { abcwMeta = await abcwFetchHist(code, transport); } catch (e) { /* 不影响主链路 */ }
    } catch (e) {
      // 官网不可达 → 转 ewealth（下方 onAbcw=false）
    }

    // 现金管理类（官网权威分类信号 indCashManageProduct="Y"）→ 铁律排除
    if (abcwMeta.cash) return { _excludedCash: true, code };

    const onAbcw = navRows.length > 0 || !!abcwMeta.estbl;
    let ew = null;
    if (!onAbcw) {
      // 不在官网（渠道子份额 网商N/微众G、农行代销别家）→ ewealth 增量早停取新增点
      const res = await incrementalNavPages((pn) => abcEwGetPage(code, transport, pn), opts.since);
      ew = { rows: res.rows, prodName: null };
    }
    // onAbcw 时：本地旧序列已含 ewealth 早期历史，增量刷新无需再拉 ewealth（省一次全量翻页）

    // ③ 双源合并（增量：仅新增点）
    const merged = new Map();
    for (const r of (ew && ew.rows) || []) merged.set(r[0], r[1]);
    for (const r of navRows) merged.set(r[0], r[1]);
    const ded = [...merged.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

    if (onAbcw && !ded.length) {
      // 官网已收录且本轮无新增点（已是最新）→ 返回空增量，不回落 xpl 全量兜底（防「0 点回落陷阱」）
      return {
        name: null, manager: null,
        established: abcwMeta.estbl,
        series: [], kind: "nav", risk: null, benchmark: null, holdDays: null,
        regCode: null, source: "live", navIncremental: true,
      };
    }
    if (!ded.length) {
      // 不在官网且 ewealth 也无 → 回落中国理财网（极少：渠道子份额双接口都空）
      const fb = (await xplFallback(code, opts)) || null;
      if (fb && !fb._excludedCash) fb.navIncremental = true; // 增量语义：全序列按日期并入本地，不整体替换
      return fb;
    }

    // 增量模式跳过现金/信息防御（新点不足以判断，本地已有分类与信息）；established 用官网权威值（不取自新点序列）
    const estbl = abcwMeta.estbl;
    let series = estbl ? ded.filter((r) => r[0] >= estbl) : ded;
    if (!series.length) series = ded;

    return {
      name: null,
      manager: null, // 增量不重抓信息，沿用本地
      established: estbl || null,
      establishedFromSeries: false,
      series,
      kind: "nav",
      risk: null,
      benchmark: null,
      holdDays: null,
      regCode: null,
      source: "live",
      navIncremental: true,
    };
  }

  // === 全量分支（无 since = 添加产品/旧前端）：保留原双源合并逻辑 ===
  // ① 农银理财官网（主源）：串行 —— 先 find 拿净值，有点数才发 findHistoryYield。
  //
  // 【2026-10-22 修复「净值慢一个披露日」】原来 nav + hist 用 Promise.all 并行打官网。
  // 实测官网对同一客户端的并发请求必令其中一个返回 500：
  //   · 挂的是 findHistoryYield（汇总口）→ 只丢成立日/现金标记，净值仍走官网，影响小；
  //   · 挂的是 find（净值）→ navRows 为空 → 本函数静默转 ewealth 兜底，而 ewealth 的
  //     净值比发行人官网慢一个披露日（NYJQLD301：官网 10-21、ewealth 10-20）。
  //     结果是「净值慢一天」且原因完全隐身 —— 正是用户报障的现象。
  // 串行后两个请求不再重叠，官网不会因并发自相残杀；代价是官网阶段耗时增加一次往返，
  // 远小于「慢一个披露日」的代价。
  let navRows = [];
  try {
    navRows = await abcwFetchNav(code, transport);
  } catch (e) {
    // 官网不可达（TLS/超时/5xx）→ 静默转 ewealth，行为与改动前一致
  }

  let abcw = null;
  if (navRows.length) {
    // 净值已拿到才补发汇总口；汇总口失败不致命：成立日退 ewealth estblDate，
    // 现金标记由下方「单位净值整段恒 1」防御判据兜底。
    let hist = { estbl: null, cash: false };
    try {
      hist = await abcwFetchHist(code, transport);
    } catch (e) { /* 汇总口失败不影响净值主链路 */ }
    abcw = { rows: navRows, estbl: hist.estbl, cash: hist.cash };
  }

  // 现金管理类（官网权威分类信号 indCashManageProduct="Y"）→ 铁律排除，不再往下抓。
  // 返回哨兵而非 null：让编排层下发 isCash（前端提示「现金管理类」）而不是「未收录」。
  if (abcw && abcw.cash) return { _excludedCash: true, code };

  // ② 农行母平台 ewealth：官网首点之前的早期历史 + 官网未收录产品的兜底
  // skipBefore 供 ewealth 做起始页估算（rows 降序，末位即官网首点）
  const skipBefore = abcw
    ? { date: abcw.rows[abcw.rows.length - 1][0], n: abcw.rows.length }
    : null;
  let ew = null;
  try {
    ew = await abcFetchNav(code, transport, skipBefore);
  } catch (e) {
    ew = null;
  }

  // ③ 双源合并：同日以官网为准（ewealth 先灌底，官网覆盖同日）
  const merged = new Map();
  for (const r of (ew && ew.rows) || []) merged.set(r[0], r[1]);
  for (const r of (abcw && abcw.rows) || []) merged.set(r[0], r[1]);
  const ded = [...merged.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  if (!ded.length) {
    // 两家都不收录（农行代销渠道子份额：网商 N / 微众 G 后缀）→ 回落中国理财网信息披露平台
    return (await xplFallback(code, opts)) || null; // 未收录该代码
  }

  // 防御性现金判据（项目铁律）：单位净值整段恒 1 ＝ 现金管理类或无有效净值 → 排除
  const varies = ded.some((r) => Number.isFinite(r[1]) && Math.abs(r[1] - 1) > 1e-6);
  if (!varies) return null;

  // 产品信息仍走 ewealth（abcwealth 无产品信息字段）；成立日优先官网（dateEstablish 权威），
  // 官网缺位时退 ewealth estblDate，用于过滤认购期占位行（成立日前 NetValue 恒 1.000000）
  const info = (__navMode || __quotaMode) ? null : await abcFetchInfo(code, transport);
  const estbl = (abcw && abcw.estbl) || (info ? abcNormDate(info.estblDate) : null);
  let series = estbl ? ded.filter((r) => r[0] >= estbl) : ded;
  if (!series.length) series = ded;

  // 管理人：productSource 形如「农银理财有限责任公司」→ 归一为「农银理财」
  // 【2026-10-27 修复】不再默认写「农银理财」：农行货架含他行理财子产品，默认值会把它们
  //   全部误标成农银理财（硬编码兜底禁令）。认不出就置 null。
  let manager = null;
  if (info && info.productSource) manager = inferManagerStrict(info.productSource);

  // 最短持有天数：investTerm 形如「最低持有90天」
  let holdDays = null;
  if (info && info.investTerm) {
    const m = String(info.investTerm).match(/(\d+)\s*天/);
    if (m) holdDays = Number(m[1]);
  }

  return {
    name: (info && info.productName) || (ew && ew.prodName) || null,
    manager,
    established: estbl || series[0][0],
    establishedFromSeries: !estbl, // estblDate 缺位时退序列首点（estblDate 是农行真字段）
    series,
    kind: "nav",
    risk: info ? abcRiskToR(info.risk) : null,
    benchmark: info ? info.mkrdBaseDscrOld || null : null,
    holdDays,
    regCode: null, // 农行公开接口不返回登记编码
    source: "live",
  };
}

/* ==========================================================================
 * 中国理财网「信息披露平台」新站（xinxipilu.chinawealth.com.cn）净值回落链
 *
 * 为什么需要它：农行 ewealth 平台不收录「代销渠道子份额」——网商银行专享份额(N)、
 * 微众银行专享份额(G) 等后缀代码在发行行自有接口查无此码，但中国理财网信息披露
 * 平台按 (登记编码, 子份额代码) 双键披露【完整净值序列】（旧版 www 站只有最新一
 * 个净值点，新版 xinxipilu 站才有时间序列）。
 *
 * 反爬机制（三层，全部已在逆向中验证）：
 *   ① /m/n RSA 密钥交换 → AES-256-ECB 加密载荷（与旧版同构，签名密钥不同）
 *   ② X-Sign：SHA256("data=<ct>&nonce=<n>&timestamp=<t>&signKey=hold?fish:palm")
 *   ③ signature 头：POST /product/getInitData 会下发【每次会话不同的 RSA-2048
 *      私钥】(license, PKCS#8 PEM，单行无换行)，后续每个 POST 都须用该私钥对
 *      「加密前的原始 JSON」做 SHA256withRSA 签名（EMSA-PKCS1-v1_5），base64。
 *      —— 密钥动态下发使硬编码签名失效，这是新版相对旧版多出的一层。
 *   实测：license 跨会话有效、全程无需 Cookie（对 Worker 无状态环境友好）。
 *
 * 关键限制：净值接口必须同时给 prodRegCode + subShareCode（缺一返回 0 条），
 * 而全站（含旧版 /prod/search）都没有「子份额代码 → 登记编码」的反查接口。
 * 故已知映射走 XPL_SHARE_REG 静态表（同 ICBC_META_SEEDS 思路，逐案维护）。
 *
 * 接口（POST /lcxp-platService/*，全部走加密通道）：
 *   /product/getInitData     {} → data = license 私钥 PEM
 *   /product/getNetValueLine {subShareCode,timeType:"1",prodRegCode}
 *                            → data.prodNetValueLine[] 全序列（最新在前），
 *                              行含 netValueDate / shareNetVal / acumltNetVal
 *   /product/getNetValueList {…,pageNum,pageSize} 分页净值表（pageSize 实测 ≥2000）
 *   /product/getProductDetail{prodRegCode,prodId:"",ssid:"",pageNum,pageSize}
 *                            → data.prodBasicInfoVo（名称/成立日/风险/基准/
 *                              全部子份额列表 prodPerfCmprBaseList 分份额基准）
 * ========================================================================== */

const XPL_HOST = "https://xinxipilu.chinawealth.com.cn";
const XPL_BASE = "/lcxp-platService";
const XPL_SIGN_KEY = "hold?fish:palm";
const XPL_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const XPL_REF = XPL_HOST + "/queryMenu/prodType/prodTypeDetail";

// 子份额代码 → 登记编码（渠道份额无法从任何公开接口反查登记编码；新样本按
// 「中国理财网信息披露平台」详情页 URL 的 prodRegCode 逐案补录）
const XPL_SHARE_REG = {
  // 农银理财「农银匠心·灵动」14天理财产品第9期（母产品代码 NYJXLD1409）
  NYJXLD1409N: "Z7001126000218", // 网商银行渠道份额
  NYJXLD1409G: "Z7001126000218", // 微众银行渠道份额
  NYJXLD1409O: "Z7001126000218", // 默认份额（理财网缺省展示份额）
  // 农银理财「农银匠心·灵动30天理财产品第20期」：代码 NYJXLD3020O 中「3020」=30天第20期，
  // O 份额。发行方(农银) App 查不到、江苏银行 App 可查；经信息披露平台双键查询取完整净值序列。
  NYJXLD3020O: "Z7001126000534",
  // 上海银行(上银理财)「聚宝盈-60天持有期1号」：bosc.cn 对数据中心 IP 不可达，
  // 回落中国理财网信息披露平台取完整序列。
  WPBK24M0201A: "Z7007124000383",
  // 上海银行(上银理财)「聚宝盈-60天持有期2号」：2026-10-16 实测——按产品名检索会命中
  // 1 号的登记 Z7001026001429（名称仅差「1号/2号」），对 2 号查净值恒 0 行；
  // 2 号自身登记为 Z7001026001435（名称全匹配「…WPBK24M0202期」，393 点，成立日 2025-01-08
  // 与上海银行 App 端口 EstabDate 一致）。故按码直查优先于按名检索。
  WPBK24M0202A: "Z7001026001435",
  // 招银理财「招睿添金7天持有期11号」：销售码 120030N，江苏银行代销。
  // 招行自身通道 getProductByPrdCode 查不到该码（404），故经信息披露平台双键查询取净值序列。
  "120030N": "Z7001626000362",
  // 浦银理财「天添鑫安泰7号A」：销售码 PY26203A，工商银行代销（登记编码 Z7006926000955）。
  // 工行代销通道(papi.icbc.com.cn)长假后首日(10-08)净值在开放接口侧漏发（9-30→10-09 断点），
  // 浦银官网(spdbwm)同漏；中国理财网信息披露平台含完整序列（含 10-08）。本映射供 fetchProductFull
  // 的「近期断点跨源补缺」走双键查询直接命中，补回漏发日净值。
  PY26203A: "Z7006926000955",
  // 招银理财「招睿增鑫90天持有期8号增强型固收类理财计划」：销售码 667468WS，宁波银行代销。
  // 三条链路各自的失败形态（2026-10-15 实测）——
  //   ① 代销 nbcb 网关（e.nbcb.com.cn/zhongtai）：只回「最新单点净值」（series=1，未达 series>=2 采用线），
  //      且 p-onsale-channel 响应里**没有任何登记编码字段**（无法就地反查）；
  //   ② 发行 cmb 自身通道 getProductByPrdCode：认不得该渠道份额码，返回空；
  //      招行理财超市目录按名称检索（cfweb）亦未收录该批次；
  //   ③ 中国理财网按名称检索可命中本产品，登记编码 Z7001626000313。
  // 故按既有分工补录登记编码 → 由中国理财网双键查询（第 3 家）取完整净值序列。
  "667468WS": "Z7001626000313",
  // 招银理财「招睿增盈180天持有期10号增强型固收类理财计划」：销售码 667497K，网商银行代销。
  // 2026-10-16 实测复现「抓不到」全链路——
  //   ① 代销 mybank：无直连端口（BANK_ONE_NAV），xplShareFastLane 查表未登记 → 秒返 null；
  //   ② 发行 cmb：getProductByPrdCode 认不得网商渠道份额码（招行理财超市目录按名检索亦无 10 号，
  //      最高只到 7 号 667462C——10 号为网商渠道专属份额，招行目录不收）；
  //   ③ 中国理财网兜底：XPL_SHARE_REG 无此码 → 回退旧站 wechatSearch 名称检索 → HTTP 429
  //      （用户规则禁退避）→ 拿不到登记编码 → 双键查询无键可查 → 整单 nav/info/bench 全空。
  // 修复：登记编码 Z7001625001244 由信披平台 getProductList 按名称检索命中（行内 subShareCode
  // = 667497K 精确核对，prodStatus=04 存续），xpl 双键查询实测 215 点（2025-11-21 ~ 2026-10-14）。
  // 同时已落地 xplNameToReg 名称检索回退（见 metaFromChinaWealthXpl/chinawealthNav），
  // 此后同类渠道份额不再依赖人工补录。
  "667497K": "Z7001625001244",
  // 光大理财「阳光金增利稳健天天购46号（14天最低持有）A」：销售码 EW7746A，光大自营。
  // 光大官网(cebbank)直连被 WAF 升级封死（JA3 指纹 400 + 瑞数 RS5 412），生产/住宅 IP 恒败，
  // 既定主源为中国理财网信息披露平台 xpl 兜底。2026-10-16 修 xplNameToReg 名检索 bug（kw 越界
  // ReferenceError 致命中即崩溃）后，按名检索精确命中 subShareCode=EW7746A（score=100），
  // xpl 双键查询实测 86 点（登记编码 Z7001426001396，成立日/持有14天/R2 与产品一致）。
  // 补录后 cebFetch 直连失败时由 XPL_SHARE_REG 直查命中，绕过易触发验证码阈值的名检索。
  "EW7746A": "Z7001426001396",
  // 光大理财「阳光金丰利1178期A」(EW7899A) / 「阳光金创利稳健日开33号（7天最低持有）A」(EW6210A)：
  // 光大自营，同走中国理财网 xpl 兜底。regCode 待补录（本机 xpl getProductList 受 per-IP 验证码阈值
  // 限流暂未取到；kw bug 修复后 name-search 回退已可命中，生产环境无需静态码亦可抓）。
  //
  // ===================== 网商银行代销份额码（2026-10-25 新增）=====================
  // 背景：用户在「网商银行」渠道添加这批产品时全部「找不到」。根因不是网商缺数据，
  //   而是**这批码是发行行的产品码，网商只是代销方**（见「所有产品_销售代码_管理方_代销方.csv」：
  //   109463WS=招银理财/网商银行、25G6728E=工银理财/网商银行、WPBK24M0501T=上银理财/网商银行、
  //   NYJXLD18015N=农银理财/网商银行、EW****D=光大理财/网商银行）。
  //   网商自身无直连端口（BANK_ONE_NAV 含 mybank），故 mybankFetch 只能走 xplShareFastLane
  //   查 XPL_SHARE_REG；未登记 → 秒返 null → 404「找不到」。
  // 实测（2026-10-25 本机 nodeTransport + 中国理财网信息披露平台）：
  //   ① xpl 净值接口（getNetValueLine）与列表接口（getProductList）**分属不同风控桶**：
  //      列表接口按 IP 约 3~5 次请求即被 503/「code=-1 验证失败」拦死；但只要拿到登记编码，
  //      净值接口可连续查询不受影响。故「渠道份额码 → 登记编码」是唯一卡点。
  //   ② 招行超市跨行目录全量 8000 条**无命中**（招行不代销网商专属份额），
  //      光大官网「历史业绩」页对 D 份额明示「暂无历史业绩数据」（对公产品入口不含零售代销份额），
  //      上海银行 bosc.cn 对本机/数据中心 IP 均 TCP 超时 → 三条替代取数通道均不通。
  //   ③ 唯一可行通道 = xpl getProductList 按发行机构/产品名检索，行内自带
  //      subShareCode（渠道子份额码，正是 EW****D 这类）与 prodRegCode 的直接映射。
  // 补录登记编码（2026-10-25 实测）：
  //   109463WS（招银理财·网商份额）→ Z7001626000337，xpl 双键查询实测 128 点（2026-10-22 最新 1.0398）
  //   25G6728E（工银理财·网商份额）→ Z7000825000929，xpl 双键查询实测 212 点（2026-10-22 最新 1.0515）
  // 未能补录者（登记编码待定位，见 _probe/xpl_name_scan.mjs）：
  //   WPBK24M0501T（上银理财·网商份额）：原记录 Z7007124000370 实测查不到（0 点），
  //     且 bosc.cn 本机不可达 → 只能等 xpl 列表命中后补录。
  //   NYJXLD18015N（农银理财·网商份额）：**无需登记编码**——农银母行 ewealth.abchina.com.cn
  //     直连可用，实测 148 点（2026-10-22 最新 1.013428），走 abcFetch 发行行通道即可。
  //   EW5902D / EW7829D / EW6729D / EW3836D（光大理财·网商份额）：光大官网 D 份额无净值，
  //     待 xpl 列表命中后补录登记编码。
  "109463WS": "Z7001626000337",
  "25G6728E": "Z7000825000929",
  // 网商 N 份额（农银匠心·灵动 14天第9期）已在上面登记；此处补登网商代销的两个已知码。
  // 光大理财「阳光金慧盈日开1号（14天最低持有）」网商代销份额：销售码 EW7663D。
  // 登记编码 Z7001426001119（2026-10-25 取数：线上 worker 的 XPL 名检索按「光大理财慧盈日开1号（14天）D」
  // 精确命中 subShareCode=EW7663D，score=100 → 登记编码 Z7001426001119）；
  // 本机 xpl 双键查询实测 106 点，2026-10-22 最新 1.0105，与网商 App「单位净值」曲线一致。
  // 光大官网「历史业绩」页对 D 份额明示「暂无历史业绩数据」（该页是**对公**理财入口，不含零售代销份额），
  // 故光大 D 份额只能走中国理财网。
  "EW7663D": "Z7001426001119",
  // 光大理财·网商代销 D 份额（渠道码即 xpl 子份额码，登记编码由 xpl 名检索实测，已校验 navShare=码）：
  //   EW6729D（阳光橙慧盈增强日开2号 180天最低持有）→ Z7001426000284，实测 169 点
  //   EW7829D（阳光橙优选多策略固收增强日开2号 180天最低持有）→ Z7001426001196，实测 105 点
  //   补录后 编排层 tryShareBridge（worker.js:3643）与 chinawealthNav（:2807/2815）直接跳过名检索
  //   → 「份额码桥接」从 21.7s 变 0ms（仅留「XPL_SHARE_REG 已登记」备注）。
  "EW6729D": "Z7001426000284",
  "EW7829D": "Z7001426001196",
  //   EW5902D（阳光金乐盈日开7号 180天最低持有）→ Z7001425001951，实测 208 点
  "EW5902D": "Z7001425001951",
  //   EW3836D（阳光金创盈日开2号 90天最低持有）→ Z7001425000415，实测 398 点
  "EW3836D": "Z7001425000415",
  // 招银理财「招睿添利日开21号固定收益类理财计划」：广发代销份额，销售码 132112D。
  // 兄弟份额家族（同一登记编码 Z7001626000062，**三者净值各不相同**，实测线上 2026-10-29：
  //   132112D=1.0177 / 132112N=1.0173 / 132112MS=1.0178 → 必须按份额码精确查，拿错=入库错净值）：
  //   132112D 招睿添利日开21D（主份额，2026-10-30 实测 46 点）
  //   132112N 招睿添利日开21N（同登记，117 点）
  //   132112MS 招睿添利日开21MS（同登记，18 点）
  // 抓取链路现状（2026-10-31 实测）：
  //   ① 发行 cmb 通道 getProductByPrdCode 对三个份额**全部返 body=0**（产品已从招行货架下架，
  //      招行超市目录当前 7482 条里也没有；PB132112D 代销渠道码同样返空）→ 招行腿拿不到；
  //   ② 代销 cgb 腿（广发 App / 广银理财官网）能拿到，但本机 IP 被封（广发官网 403、
  //      wap.cgbchina.com.cn 与 www.cgbwmc.com.cn TCP 不通）→ 本地失败、线上成功；
  //   ③ 中国理财网双键查询（regCode + shareCode）**三个份额都能拿到**，且末点更新到 10-29。
  // 故登记此映射 → 代销腿失败时由 xpl 直查兜底（本机 xpl 被风控时仍依赖线上 hourly 补齐）。
  "132112D": "Z7001626000062",
  "132112N": "Z7001626000062",
  "132112MS": "Z7001626000062",
};
// 2026-11-01：(A)「渠道码即份额码」白名单——与 XPL_SHARE_REG 语义**刻意区分**：
//   XPL_SHARE_REG 同时携带 regCode（会触发主腿 bosc.cn 回落 / gapfill 取数），而本表**只声明**
//   「该渠道码的解析份额码 === 自身」，用于桥接 ② 直接置 shareHint=c 跳过中国理财网名检索(0ms)，
//   **不参与任何 regCode 取值**（避免引入已知 0 点的 regCode Z7007124000370 污染主腿回落 / gapfill）。
//   净值仍由 ④ 中国理财网按 shareCode=c 兜底（WPBK24M0501T 该路径已验证可用，346 点）。
//   适用：渠道码与发行方子份额码完全相同、且主腿已用该码查过且失败的产品——桥接 ③ 重查必冗余。
const SHARE_EQ_CHANNEL = new Set([
  "WPBK24M0501T", // 上银理财·网商代销份额（聚宝盈5个月持有期）：渠道码 WPBK24M0501T 即中国理财网子份额码，bosc.cn 主腿已用此码查空 → ③重查冗余
]);
// 渠道子份额展示后缀：母产品同名，但 N/G/O 是不同银行/渠道的独立份额，
// 必须让名称可区分，否则 App 里两张同名卡片无法分辨（用户易把网商份额看成微众份额）。
const XPL_SHARE_LABEL = {
  NYJXLD1409N: "（网商 N 份额）",
  NYJXLD1409G: "（微众 G 份额）",
  NYJXLD1409O: "（默认 O 份额）",
  // 注意：默认后缀规则（末位 N→网商 / G→微众 / O→默认）只适用于农银理财渠道份额族；
  // 招银理财「招睿添金7天持有期11号」的 N 是招行份额编号，与网商无关，必须显式改写，
  // 否则卡片名会被错误标注成「（网商 N 份额）」。
  "120030N": "（招行 N 份额）",
};
function xplShareLabel(code) {
  if (XPL_SHARE_LABEL[code]) return XPL_SHARE_LABEL[code];
  const last = code.slice(-1).toUpperCase();
  if (last === "N") return "（网商 N 份额）";
  if (last === "G") return "（微众 G 份额）";
  if (last === "O") return "（默认 O 份额）";
  return "";
}

function xplFallback(code, opts) {
  try {
    return xplFetch(code, opts);
  } catch (e) {
    return null; // 回落链失败不影响主链路语义（返回 null = 未收录）
  }
}

async function xplReq(path, bodyStr, headers, transport) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await nyHttp(XPL_HOST + XPL_BASE + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        "Accept": "*/*",
        "User-Agent": XPL_UA,
        "Referer": XPL_REF,
        "Origin": XPL_HOST,
        ...(headers || {}),
      },
      body: bodyStr,
      signal: ctrl.signal,
    }, transport);
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

// PKCS#8 (PrivateKeyInfo) PEM → {n, e, d, keyBytes}；复用南银段 DER 读取器。
// 服务端下发的 PEM 为单行（换行丢失），先剥头尾与全部空白再 base64 解码。
function xplParsePkcs8Priv(pemStr) {
  const b = b64ToBytes(
    String(pemStr).replace(/-----BEGIN [^-]*-----/, "").replace(/-----END [^-]*-----/, "").replace(/\s+/g, "")
  );
  let off = 0;
  if (b[off++] !== 0x30) throw new Error("PKCS8 SEQUENCE expected");
  let r = nyReadLen(b, off); off = r.next;                        // 外层内容
  off++; r = nyReadLen(b, off); off = r.next + r.len;             // version INTEGER(0)
  off++; r = nyReadLen(b, off); off = r.next + r.len;             // AlgorithmIdentifier
  if (b[off] !== 0x04) throw new Error("OCTET STRING expected");
  off++; r = nyReadLen(b, off); off = r.next;                     // privateKey
  if (b[off] !== 0x30) throw new Error("RSAPrivateKey SEQUENCE expected");
  off++; r = nyReadLen(b, off); off = r.next;
  off++; r = nyReadLen(b, off); off = r.next + r.len;             // inner version
  const nR = nyDerReadInt(b, off);
  const eR = nyDerReadInt(b, nR.next);
  const dR = nyDerReadInt(b, eR.next);
  return { n: nR.value, e: eR.value, d: dR.value, keyBytes: Math.ceil(nR.value.toString(2).length / 8) };
}

// EMSA-PKCS1-v1_5 + SHA256withRSA：m = 00 01 FF…FF 00 || DigestInfo || hash，
// 签名 = m^d mod n（与 rsaPkcs1v15Decrypt 同一套 BigInt 数学，仅 padding 方向相反）
const XPL_SHA256_DIGESTINFO = new Uint8Array([
  0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20,
]);
async function xplSignRsa(priv, payloadStr) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payloadStr)));
  const k = priv.keyBytes;
  const tLen = XPL_SHA256_DIGESTINFO.length + h.length; // 19 + 32 = 51
  if (k < tLen + 11) throw new Error("RSA key too small");
  const em = new Uint8Array(k);
  em[0] = 0x00; em[1] = 0x01;
  for (let i = 2; i < k - tLen - 1; i++) em[i] = 0xff;
  em[k - tLen - 1] = 0x00;
  em.set(XPL_SHA256_DIGESTINFO, k - tLen);
  em.set(h, k - h.length);
  const sig = modPow(bytesToBigInt(em), priv.d, priv.n);
  return bytesToB64(bigIntToBytes(sig, k));
}

// 会话状态（AES key + license 私钥）：实测跨会话有效、无需 Cookie，
// 模块级缓存 5 分钟，把每次抓取的子请求从 4 个压到 2 个。
let xplState = null;
const XPL_STATE_TTL = 5 * 60 * 1000;

// 加密业务请求：signature(如有 license) + AES-ECB 密文体 + X-Nonce/X-Timestamp/X-Sign。
// 用户规则（2026-10-13）：xpl 遇 503 不退避、禁重试——立即失败（前端显示「未抓到」）；
// 其余非 200 状态仍重试 ≤3 次；业务 code!==200 视为协议层失败抛错。
async function xplPostCore(keyBuf, lic, path, payloadObj, transport, sink = null) {
  const payload = JSON.stringify(payloadObj); // 键序即签名序（与前端一致的插入序）
  let res;
  let attempts = 0;                            // 循环外计数：let attempt 是 for 块作用域，循环外不可见
  let sigLen = 0;                              // 诊断用：最近一次请求的 RSA 签名长度（0=未签）
  const t0 = Date.now();
  let backoffMs = 0;
  for (let attempt = 0; ; attempt++) {
    attempts = attempt + 1;
    const headers = {};
    if (lic) headers.signature = await xplSignRsa(lic, payload);
    sigLen = (headers.signature || "").length;
    const encData = await cwAesEncrypt(payload, keyBuf);
    const nonce = Math.random().toString(36).slice(2, 12);
    const timestamp = Date.now().toString();
    const sg = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`data=${encData}&nonce=${nonce}&timestamp=${timestamp}&signKey=${XPL_SIGN_KEY}`)
    );
    headers["X-Nonce"] = nonce;
    headers["X-Timestamp"] = timestamp;
    headers["X-Sign"] = [...new Uint8Array(sg)].map((b) => b.toString(16).padStart(2, "0")).join("");
    res = await xplReq(path, encData, headers, transport);
    if (res.status === 200 || res.status === 503 || res.status === 429 || attempt >= 3) break; // 429/503：不退避不重试，立即失败节省时间
    backoffMs += 600 * (attempt + 1);
    await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
  }
  // 2026-10-14：计时 note 带上尝试次数与退避——「xpl./product/getProductDetail 13.9s」
  // 这类长耗时由此可自证：无 #试N = 上游单次响应慢；有 #试N = 非 503 状态重试所致
  //（503 从不重试，见上行 break 条件）。
  navTiming(sink, "xpl." + path + (attempts > 1 ? "#试" + attempts : ""), Date.now() - t0,
    "HTTP " + res.status + (attempts > 1 ? "（重试" + (attempts - 1) + "次，含退避" + (backoffMs / 1000).toFixed(1) + "s；503 不重试）" : ""));
  if (res.status !== 200) throw new Error("xpl " + path + " HTTP " + res.status);
  let j;
  try { j = JSON.parse(res.text); } catch (e) { throw new Error("xpl response unparseable"); }
  if (!j || j.code !== 200) {
    // 诊断：code=-1「验证失败」= RSA 签名/许可不匹配（lic 缺失或会话错配），与「查无数据」不同
    navLog("[xpl] FAIL " + path + " code=" + (j && j.code) + " msg=" + ((j && j.msg) || "") +
      " lic=" + (lic ? "y" : "n") + " sig=" + sigLen + " payload=" + payload.length + "B");
    throw new Error("xpl " + path + " code=" + (j && j.code) + " " + ((j && j.msg) || ""));
  }
  return j;
}

async function xplInit(transport, sink = null) {
  if (xplState && Date.now() - xplState.t < XPL_STATE_TTL) return xplState;
  // 握手子请求此前未单独计时 → 时间分解里「0.2+2.7 < 4.4」的 1.5s 差额无法对账；
  // 现以 xpl.handshake 单列（含在 xpl.getProductDetail 包 total 内）。
  const hsT0 = Date.now();
  const keyBuf = await cwHandshakeVia((p, b, h) => xplReq(p, b, h, transport));
  navTiming(sink, "xpl.handshake", Date.now() - hsT0, "会话握手（AES key）");
  const j = await xplPostCore(keyBuf, null, "/product/getInitData", {}, transport, sink);
  if (!j.data || !String(j.data).includes("PRIVATE KEY")) throw new Error("xpl init: no license");
  const lic = xplParsePkcs8Priv(j.data);
  xplState = { t: Date.now(), keyBuf, lic };
  return xplState;
}

// 结果缓存：命中 10 分钟，未命中 60 秒（同 cwSearchCache 节奏）
const XPL_CACHE_TTL = 10 * 60 * 1000;
const XPL_NULL_TTL = 60 * 1000;
const xplCache = new Map();

/**
 * 【2026-10-31 用户实测】本机 IP 被中国理财网风控：握手/初始化要么超时、要么拿不到 license，
 *   而 xplFetch 的 for(attempt<2) 会把失败重试一遍 → 单只产品白等 40s+（实测 42.4s / 43.5s）。
 *   线上 Worker IP 正常（1.5~4s 命中）。
 *
 * 修法（进程内熔断）：握手/初始化失败（抛错）= 本机被风控 → 记熔断 → 后续 xpl 腿
 *   **立即返回 null 快速失败**，让编排层把时间留给还有希望的腿，而不是耗尽 60s 预算。
 *   熔断窗口 10 分钟；握手一旦成功立即清零（风控解除即恢复）。
 */
const XPL_CIRCUIT = { open: false, until: 0, fails: 0, probing: false, lastProbe: 0 };
const XPL_CIRCUIT_MS = 10 * 60 * 1000;
// 【2026-11-01 修复】熔断分级 + 半开探测（详见 xplGuardHandshake 注释）：
//   单次握手失败不再直接熔断 10 分钟 → 连续失败 ≥XPL_CIRCUIT_FAILS 才熔断；
//   首次熔断窗口短（XPL_CIRCUIT_FIRST_MS），连续失败递增，最长 XPL_CIRCUIT_MS。
const XPL_CIRCUIT_FIRST_MS = 30 * 1000;
const XPL_CIRCUIT_FAILS = 2;
// 半开探测：熔断窗口内每 XPL_PROBE_INTERVAL_MS 放行一个请求去试握手（成功即恢复），
//   避免「一次抖动 → 全站 10 分钟瘫痪」；同刻只放行一个（probing 标志），防并发雪崩。
const XPL_PROBE_INTERVAL_MS = 20 * 1000;

/**
 * 熔断守卫：判定本次是否允许发起 xpl 握手。
 * 【2026-11-01 修复根因】原实现是「模块级全局熔断 + 单次失败即熔 10 分钟 + 窗口内绝不做试探」，
 *   在 Cloudflare Workers 里 XPL_CIRCUIT 是**同一 isolate 内所有请求共享**的模块级变量 →
 *   **任何一次握手抖动（网络抖动/上游瞬时 5xx）都会让该 isolate 上随后 10 分钟内
 *   所有产品的中国理财网兜底全部 0ms 秒返 null → 全站该通道集体「未抓到」**。
 *   实测（2026-11-01 线上）：5 个互不相关的产品（120030N / PY26203A / EW7746A / 667497K /
 *   109463WS）在同一时刻全部 404，且兜底阶段均 0ms null —— 熔断全局污染的铁证。
 * 现在改为：①连续失败 ≥2 次才熔断；②窗口分级递增；③窗口内定期放行**单个**探测请求，
 *   握手成功即清熔断立即恢复（上游已恢复时不必等满 10 分钟）。
 * @returns {boolean} true=允许发起握手；false=熔断中，快速失败
 */
function xplGuardHandshake() {
  if (!XPL_CIRCUIT.open) return true;
  const now = Date.now();
  if (now >= XPL_CIRCUIT.until) {
    // 窗口已过 → 半开：重置计数并放行一次（等同重新开始）
    XPL_CIRCUIT.open = false;
    XPL_CIRCUIT.fails = 0;
    XPL_CIRCUIT.probing = false;
    return true;
  }
  // 窗口内：按间隔放行一个探测请求（上游可能已恢复 → 探测成功即刻全站恢复）
  if (now - XPL_CIRCUIT.lastProbe >= XPL_PROBE_INTERVAL_MS && !XPL_CIRCUIT.probing) {
    XPL_CIRCUIT.lastProbe = now;
    XPL_CIRCUIT.probing = true;
    return true;
  }
  return false;
}

/** 握手成功 → 清零熔断状态（风控解除即恢复） */
function xplMarkHandshakeOk() {
  XPL_CIRCUIT.open = false;
  XPL_CIRCUIT.fails = 0;
  XPL_CIRCUIT.probing = false;
}

/** 握手失败 → 连续失败计数；达到阈值才熔断（单次抖动不熔断） */
function xplMarkHandshakeFail() {
  XPL_CIRCUIT.probing = false;
  XPL_CIRCUIT.fails += 1;
  if (XPL_CIRCUIT.fails < XPL_CIRCUIT_FAILS) return; // 未达阈值 → 仍允许后续请求再试
  XPL_CIRCUIT.open = true;
  // 窗口分级：连续失败越多窗口越长（30s → 60s → … → 10min 上限）
  const win = Math.min(XPL_CIRCUIT_FIRST_MS * Math.pow(2, XPL_CIRCUIT.fails - XPL_CIRCUIT_FAILS), XPL_CIRCUIT_MS);
  XPL_CIRCUIT.until = Date.now() + win;
}

export async function xplFetch(code, opts = {}) {
  const __NM = __navMock();
  if (__NM && __NM.xpl) {
    const r = __NM.xpl(String(code || "").trim().toUpperCase(), opts);
    if (r !== undefined) return r; // 返回 undefined 表示不接管，走真实信息披露平台链路
  }
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  const regCode = XPL_SHARE_REG[c] || opts.regCode || null;
  if (!regCode) return null; // 无登记编码映射：信息披露平台必须双键查询
  // 【2026-10-25 新增】份额码可独立于渠道码给出（opts.shareCode）。
  // 原因：代销渠道卖的是「发行方的某一个份额」，渠道码本身不是份额码。实证浦发代销
  // 信银安盈象2号：渠道码 2301232123、发行方份额码 AF223066H，二者毫无字面关系。
  // 同一登记编码下多份额各有独立净值（B=1.104 / H=1.0809），subShareCode 传错或留空
  // 都查不到（留空只在「单份额产品」时才等价于全量，多份额产品返回空）。
  // 故允许调用方显式指定；未指定时维持原行为（用渠道码）。
  const share = String(opts.shareCode || "").trim().toUpperCase() || c;
  const ck = share === c ? c : c + "|" + share; // 份额码进缓存键，防两份额串缓存

  const cached = xplCache.get(ck);
  if (cached && Date.now() - cached.t < (cached.res ? XPL_CACHE_TTL : XPL_NULL_TTL)) return cached.res;

  // 【2026-11-01 修复】熔断守卫：原实现为「单次握手失败即熔断 10 分钟、窗口内绝不做试探」，
  //   而 XPL_CIRCUIT 是 isolate 内**全站共享**的模块级变量 → 一次抖动就让该 isolate 上
  //   所有产品的中国理财网兜底集体 0ms 秒返 null（全站「未抓到」）。现改为连续失败才熔断 +
  //   窗口内定期放行单个探测请求（详见 xplGuardHandshake 注释）。
  if (!xplGuardHandshake()) return null;

  const transport = opts.transport;
  const sink = opts.sink || null; // 耗时采集（fetchProductFull → chinawealthNav 下传）
  let res = null;
  // 【2026-11-01 修复】握手失败**按请求计数**（不是按内部重试次数）：
  //   本循环有 2 次 attempt，若每次握手失败都调 xplMarkHandshakeFail()，则**单次请求**
  //   就会累计 2 次失败 → 立即熔断，等于没修（熔断仍会被一次抖动触发）。
  //   故此处只在「整个调用（含全部重试）都没握手成功」时记一次失败。
  let handshakeOk = false;
  // 【2026-11-01 修复】区分「确定性无数据」与「瞬时失败」：
  //   definitive = true 仅当**明确查完确认该登记编码下无净值**（11660 行的 break）；
  //   限流(503)/网络错误等瞬时失败 → definitive=false → **不写负缓存**，
  //   否则一次限流会把该产品钉死 60s（线上实测 109463WS 兜底 0ms null 即此因）。
  let definitive = false;
  for (let attempt = 0; attempt < 2 && !res; attempt++) {
    try {
      let st = null;
      try {
        st = await xplInit(transport, sink);
      } catch (initErr) {
        // 握手/初始化失败 → 抛到外层 catch（那里统一记一次失败）
        throw initErr;
      }
      // 握手成功 → 风控已解除，清熔断
      handshakeOk = true;
      xplMarkHandshakeOk();

      // ① 净值全序列：getNetValueLine 一次返回全部（最新在前；行内自带 prodName，
      //    详情接口偶发失败时用它兜底产品名，避免整条记录缺名）。
      //    subShareCode 优先用渠道码 c；但单份额产品的子份额码在 xpl 即空串
      //    （subShareCodeList=null，如建信龙鑫第3期），渠道码（民生 JXLX1M265143）
      //    查不到 → 回落登记编码直查（subShareCode 留空）取完整序列。
      let rows = [];
      let rowName = null;
      const pushRows = (arr) => {
        if (!Array.isArray(arr)) return;
        for (const r of arr) {
          if (!rowName && r.prodName) rowName = r.prodName;
          const d = normDate(r.netValueDate);
          const v = parseFloat(r.shareNetVal != null && r.shareNetVal !== "" ? r.shareNetVal : r.acumltNetVal);
          if (d && Number.isFinite(v) && v > 0) rows.push([d, Number(v.toFixed(8))]);
        }
      };

      let jl = await xplPostCore(st.keyBuf, st.lic, "/product/getNetValueLine",
        { subShareCode: share, timeType: "1", prodRegCode: regCode }, transport, sink);
      pushRows(jl.data && jl.data.prodNetValueLine);
      navLog("[xpl] line(c=" + c + " share=" + share + ") reg=" + regCode + " -> " + rows.length + " 点");

      // ② 单份额产品回落：subShareCode 留空，仅按登记编码查（实测返回该登记编码下
      //    完整序列，行内 subShareCode 为空，净值即产品净值；渠道码 ≠ xpl 子份额码时唯一可用路径）
      if (!rows.length) {
        // 2026-10-16：xpl 对连续两次 getNetValueLine 有限流（同会话下第二发常 503）；
        // 此回落仅单份额产品触发（占比极低），加 5s 间隔避让，避免白白吃 503 退回未抓到。
        await new Promise((r) => setTimeout(r, 5000));
        jl = await xplPostCore(st.keyBuf, st.lic, "/product/getNetValueLine",
          { subShareCode: "", timeType: "1", prodRegCode: regCode }, transport, sink);
        pushRows(jl.data && jl.data.prodNetValueLine);
        navLog("[xpl] line(reg-only) reg=" + regCode + " -> " + rows.length + " 点");
      }
      // ③ 分页净值接口兜底（getNetValueList，pageSize≥2000 一页拉全）
      if (!rows.length) {
        const jn = await xplPostCore(st.keyBuf, st.lic, "/product/getNetValueList",
          { subShareCode: share, timeType: "1", prodRegCode: regCode, pageNum: 1, pageSize: 2000 }, transport, sink);
        pushRows(jn.data && jn.data.list);
        navLog("[xpl] list(c=" + c + " share=" + share + ") reg=" + regCode + " -> " + rows.length + " 点");
      }
      if (!rows.length) {
        const jn0 = await xplPostCore(st.keyBuf, st.lic, "/product/getNetValueList",
          { subShareCode: "", timeType: "1", prodRegCode: regCode, pageNum: 1, pageSize: 2000 }, transport, sink);
        pushRows(jn0.data && jn0.data.list);
        navLog("[xpl] list(reg-only) reg=" + regCode + " -> " + rows.length + " 点");
      }
      if (!rows.length) { definitive = true; break; } // 登记编码下确无净值 → 未收录（确定性结论，可落负缓存）

      rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      const ded = [];
      for (const r of rows) {
        if (ded.length && ded[ded.length - 1][0] === r[0]) ded[ded.length - 1] = r;
        else ded.push(r);
      }

      // 2026-10-21 项目铁律：只收录有净值的固收产品，现金管理类一律不抓。xpl 兜底通道
      // 若整段 shareNetVal 恒 ≈1（现金管理类单位净值归一），与 bosc/dongguan 同模式直接
      // 排除。返回哨兵（而非静默 break 留 null）让编排层下发 isCash（2026-10-23 统一），
      // 前端据此提示「该产品为现金管理类」而不是「未查到该产品」。
      if (ded.length && ded.every((p) => Math.abs(p[1] - 1) < 1e-4)) {
        res = { _excludedCash: true, code: c };
        break;
      }

      // ③ 产品详情（失败不致命；净值序列独立可用。503 不退避不重试——用户规则 2026-10-13）
      let b = null;
      for (let at = 0; at < 2 && !b; at++) {
        try {
          const jd = await xplPostCore(st.keyBuf, st.lic, "/product/getProductDetail",
            { prodRegCode: regCode, prodId: "", ssid: "", pageNum: 1, pageSize: 10 }, transport, sink);
          b = (jd.data && jd.data.prodBasicInfoVo) || null;
        } catch (e) {
          if (/HTTP 503/.test((e && e.message) || "")) break; // 503：禁重试
          if (at === 0) await new Promise((r) => setTimeout(r, 800));
        }
      }

      // 基础信息统一解析（与 xplProductDetail 共用）；shareTag 仅在含净值序列时使用
      // 2026-10-14：detail 503 时 b=null → parseXplBasicInfo 返回 null → 此前 bi.name 直接
      // 解包抛 TypeError，被外层 catch 误判为「会话失效」而整链重跑（重新握手+重拉净值），
      // 既违反「503 禁重试」又白丢已抓到的净值序列。此处 || {} 兜底，保净值、弃详情。
      const bi = parseXplBasicInfo(b, regCode, rowName) || {};
      // 中国理财网权威「投资性质」= 现金管理类 → 铁律排除。打 cash 标记让编排层
      // 统一收口（nav.cash===true）判定，覆盖 info/quota 模式拿不到序列的场合。
      if (bi.cash) {
        navLog("[xpl] code=" + c + " 投资性质=现金管理类 -> 按项目铁律不收录");
        res = { _excludedCash: true, code: c, name: null };
        break;
      }
      const shareTag = xplShareLabel(c);
      // 【2026-10-27 修复】管理人兜底：详情口 orgName 缺失时按**产品名**里的机构关键词推导。
      // 此前硬编码 "农银理财"——任何详情失败的产品都会被标成农银理财：
      //   ① 显示错（招银理财的产品显示成农银理财）；
      //   ② 更要紧：编排层按 manager→issuer 推导发行行（农银理财→abc），
      //      会把招银理财的产品错判成农行发行 → 去农行门户找一个招银理财的产品，必然抓不到。
      // 现改为：名称能可靠识别机构才填（MANAGER_HINTS 有命中），否则置 null——宁可空缺也不写错。
      const mgrFallback = (bi.name && MANAGER_HINTS.some(([kw]) => bi.name.includes(kw)))
        ? inferManager(bi.name) : null;
      res = {
        name: bi.name ? (bi.name + shareTag) : null,
        manager: bi.manager || mgrFallback,
        established: bi.established || ded[0][0],
        establishedFromSeries: !bi.established, // 登记记录无成立日字段时退序列首点
        series: ded,
        kind: "nav",
        risk: bi.risk,
        benchmark: bi.benchmark,
        holdDays: bi.holdDays,
        regCode: regCode,
        source: "live-xpl",
        navShare: share, // 实际查询所用份额码（排查用：与渠道码不同即走了份额码桥接）
      };
    } catch (e) {
      xplState = null; // 会话态失效 → 作废缓存会话，下次握手=新会话（绕过同会话连续调用限流）
      // 【2026-11-01 修复】握手失败**按请求计数**：整个调用（含 2 次 attempt）都没握手成功
      //   才记一次失败。记在 catch 里而非握手处，是为避免「单次请求内部重试 2 次 =
      //   累计 2 次失败 → 立即熔断」（那等于没修，熔断仍会被一次抖动触发）。
      if (!handshakeOk) xplMarkHandshakeFail();
      // 2026-11-01 (B) 根治：本 catch 捕获的 503 仅来自**净值查询端点**（getNetValueLine /
      //   getNetValueList；产品详情 503 已在 11583 内部 break，名检索 503 在 xplNameToReg 单独处理）
      //   —— 属「同会话连续调用限流」（见 11536：xpl 对连续两次 getNetValueLine 常 503），
      //   作废会话换一手干净会话重跑一次即可命中，故净值查询 503 不再立即失败、重试一次（fresh session）。
      //   名检索 503（2026-10-13 规则：换词/截短只会再 503）仍保持禁重试，不受影响。
      const _xplIs503 = /HTTP 503/.test((e && e.message) || "");
      if (attempt === 1) break; // 仅重试一次（首次失败换会话重跑，二次仍败则放弃）
      if (_xplIs503) navLog("[xpl] " + c + " 净值查询 503 -> 作废会话重试一次（绕同会话连续调用限流）");
      // attempt===0 且非二次失败：循环顶部 xplInit 以新会话重跑整链
    }
  }
  // 【2026-11-01 修复】**只有确定性结论才写负缓存**：
  //   原实现对「握手失败」「限流 503」「网络错误」「查无此产品」一律写 60s 的 null 缓存 →
  //   一次瞬时故障就把该产品钉死 60s；熔断期更是让大批产品集体卡住 → 表现为「偶尔抓不到」。
  //   现区分三类：
  //     · definitive=true  → 查完确认无净值 → 写负缓存（是确定结论，可省流量）
  //     · handshakeOk=false → 握手就没成功（瞬时故障）→ 不写，可立即重试
  //     · 其余（限流 503 / 网络错误）→ 不写，可立即重试
  if (!res && !definitive) return null;
  // 注：熔断 guard 在函数开头就 return null（快速失败），那时尚未到此处 → 熔断期不写负缓存，
  //   窗口结束后可立即重试（不会再多等 60s 负缓存 TTL）。
  xplCache.set(ck, { t: Date.now(), res });
  return res;
}

// 2026-10-13 续：中文数字归一——xpl 的 minHoldTerm 还有「一个月 / 三个月 / 六个月 / 一年 / 两周」
// 等中文数字格式（与产品名写法一致），纯 \d+ 正则认不出 → holdDays 恒 null → 四项永远不齐
// → 前端 infoComplete「只抓一次」标记永远置不上（如 ZNZQCY115 汇华趋势指南一个月 115 期，
// 实测每次刷新都重查 xinxipilu 3.5s）。先把这些数字段翻成阿拉伯数字再走原正则。
const CJK_DIGIT = { "零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };
function cjkNumToArabic(t) {
  if (!t) return null;
  if (t === "十") return 10;
  const i10 = t.indexOf("十");
  if (i10 === -1) {
    let v = 0;
    for (const ch of t) {
      if (!(ch in CJK_DIGIT)) return null;
      v = v * 10 + CJK_DIGIT[ch];
    }
    return v;
  }
  let v = 10; // 「十X / X十 / X十Y」
  const left = t.slice(0, i10), right = t.slice(i10 + 1);
  if (left) {
    let lv = 0;
    for (const ch of left) {
      if (!(ch in CJK_DIGIT)) return null;
      lv = lv * 10 + CJK_DIGIT[ch];
    }
    v = lv * 10;
  }
  if (right) {
    let rv = 0;
    for (const ch of right) {
      if (!(ch in CJK_DIGIT)) return null;
      rv = rv * 10 + CJK_DIGIT[ch];
    }
    v += rv;
  }
  return v;
}

// 从产品名兜底解析最短持有天数：xpl 对部分产品 minHoldTerm 返回空串，持有期只写在名字里。
// 仅认「数字+单位(天/月/年/周)」与「持有」紧邻的写法，且单位数值需落在合理区间(1~3650)，
// 以免误把「理财产品115期」的 115 当 115 天。中文数字（一个月/六个月）先归一成阿拉伯数字。
// 2026-10-14：从产品全称推导最短持有天数（基于 4478 条「全称×最短持有天数」实测校准）。
// 返回 {days, confident} 或 null。confident=true 表示可放心替代中国理财网抓取。
// 用户 2026-10-13 第二轮简化规则（频率词无条件生效、N个月+持有 查表）：
//   1)【最高优先级】名称出现 "N天"（x/xx/xxx/xxxx 天，数字或中文数字均可）→ N 天，
//      不看前后是否有"持有"字样，也不考虑任何冲突（例：日开30天持有→30；最低持有180天→180；7天→7）。
//   2) "N个月 + ...持有"（N 中文大写或阿拉伯数字）→ 查表：1/一个月→30、2/两个月→60、3/三个月→90、6/六个月→180。
//   3) 频率词【无条件生效，不看封闭式/鑫/最短持有期等任何字样】：周周/每周/按周→7；月月/每月/按月→30；季季/季赎/季开/每季/按季→90。
//   4) 日开/天天 家族（无显式天数）→ 1 天。
//   5) 双周 → 14 天。
//   6) 月份×30 / 年份×365 / 周×7 → 可推导但非100% → confident=false，不用于跳过抓取。
// 综合（2026-10-13 二轮实测）：confident 子集 96.19%（4204 条，覆盖 93.9%）；名称无法确定/仅近似 274 条（见未匹配xls）。
// 已知冲突（用户知悉并拍板接受）：季季鑫封闭式 实际 103~180 天；"3个月持有" 有 35 条源数据记 91 天；月月开 实际 3650/9999。
const NH_NDAY = /(\d{1,4}|[零〇一二两三四五六七八九十]+)\s*天/;
const NH_MHOLD = /(\d+|[零〇一二两三四五六七八九十两]+)\s*个?\s*月.{0,8}?持有/;
const NH_MHOLD_MAP = { 1: 30, 2: 60, 3: 90, 6: 180 };
const NH_MON = /(月月|每月|按月|月月开|月月赎|月月盈|月月鑫)/;
const NH_WEEK = /(周周|每周|按周|周周开)/;
const NH_SEASON = /(季季|季赎|季开|每季|按季|季季开|季季赎|季季鑫)/;
const NH_DAILY = /(日开|日日开|天天开|天天利|天天购|天天盈|天添利|天添鑫|日添利|日添鑫|天天鑫|每日开放|按日开放|日开式)/;
const NH_MONTH = /(\d+|[一二三四五六七八九十两]+)\s*个?\s*月/;
const NH_YEAR = /(\d+|[一二三四五六七八九十两]+)\s*年(?!滚续)/;
const NH_WEEK_N = /(\d+|[一二三四五六七八九十两]+)\s*周/;
const NH_MONTH_MAP = { 1: 30, 2: 60, 3: 90, 4: 120, 6: 180, 9: 270, 12: 365, 14: 420, 18: 540 };
const NH_YEAR_MAP = { 1: 365, 2: 730, 3: 1095, 5: 1825 };
function nhParseNum(s) {
  s = String(s);
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return cjkNumToArabic(s);
}
function nameHoldDays(name) {
  if (!name) return null;
  const s = String(name);
  // 1) N天 最高优先级（数字或中文数字均可，忽略一切冲突）
  const nd = s.match(NH_NDAY);
  if (nd) {
    const v = nhParseNum(nd[1]);
    if (typeof v === "number" && v >= 1 && v <= 3650) return { days: v, confident: true };
  }
  // 2) N个月 + ...持有 → 用户拍板映射（1/2/3/6 个月 → 30/60/90/180）
  const mh = s.match(NH_MHOLD);
  if (mh) {
    const v = nhParseNum(mh[1]);
    if (typeof v === "number" && v in NH_MHOLD_MAP) return { days: NH_MHOLD_MAP[v], confident: true };
  }
  // 3) 频率词：无条件生效（只要有周周/月月/季季就是 7/30/90，不看任何冲突）
  if (NH_WEEK.test(s)) return { days: 7, confident: true };
  if (NH_MON.test(s)) return { days: 30, confident: true };
  if (NH_SEASON.test(s)) return { days: 90, confident: true };
  // 4) 日开/天天 家族（无显式天数）→ 1天
  if (NH_DAILY.test(s)) return { days: 1, confident: true };
  // 5) 双周 → 14天
  if (/双周/.test(s)) return { days: 14, confident: true };
  // 6) 以下可推导但非100%准确，confident=false，不用于跳过抓取
  const mm = s.match(NH_MONTH);
  if (mm) { const v = nhParseNum(mm[1]); if (typeof v === "number" && v in NH_MONTH_MAP) return { days: NH_MONTH_MAP[v], confident: false }; }
  const ym = s.match(NH_YEAR);
  if (ym) { const v = nhParseNum(ym[1]); if (typeof v === "number" && v in NH_YEAR_MAP) return { days: NH_YEAR_MAP[v], confident: false }; }
  const wm = s.match(NH_WEEK_N);
  if (wm) { const v = nhParseNum(wm[1]); if (typeof v === "number" && v >= 1 && v <= 520) return { days: v * 7, confident: false }; }
  return null;
}
function parseXplBasicInfo(b, regCode, rowName) {
  if (!b) return null;
  let bench = null;
  if (Array.isArray(b.prodPerfCmprBaseList)) {
    const hit = b.prodPerfCmprBaseList.find((x) => x && x.subShareCode && x.baseIndex);
    if (hit) bench = hit.baseIndex;
  }
  if (!bench) bench = b.performanceCompareBaseRmk || b.performanceCompareBase || null;
  // 2026-10-13：minHoldTerm 除「N天」外还有「N个月 / N年 / N周 / 中文数字」格式（如「2个月持有期」「一个月最短持有」）。
  // 旧解析只认「N天」→ holdDays 恒 null → 四项永远不齐 → 前端 infoComplete 标记永远置不上，
  // 「四项只抓一次」规则对这类产品失效（每次刷新都重查中国理财网）。折算：月=30天、年=365天、周=7天。
  let holdDays = null;
  if (b.minHoldTerm) {
    const s = String(b.minHoldTerm).replace(/[零〇一二两三四五六七八九十]+/g, (m) => {
      const v = cjkNumToArabic(m);
      return v != null ? String(v) : m;
    });
    const mD = s.match(/(\d+)\s*天/);
    const mM = s.match(/(\d+)\s*个?\s*月/);
    const mY = s.match(/(\d+)\s*年/);
    const mW = s.match(/(\d+)\s*周/);
    if (mD) holdDays = Number(mD[1]);
    else if (mM) holdDays = Number(mM[1]) * 30;
    else if (mY) holdDays = Number(mY[1]) * 365;
    else if (mW) holdDays = Number(mW[1]) * 7;
  }
  // 2026-10-13 续：实测 xpl 对不少产品（中银稳富系列、汇华趋势指南等）minHoldTerm 返回空串——
  // 持有期只写在产品名里（「30天持有期」「一个月最短持有」「最短持有90天」）。此时从产品名兜底
  // 解析：仅认「数字+单位」与「持有」紧邻的写法，避免把「理财产品115期」的 115 误当天数。
  if (holdDays == null) {
    const nd = nameHoldDays(b.prodName || rowName);
    // 仅当名称解析 confident=true 才采用（N天最高优先级 / 月月·周周·季 频率词 / 日开·天天→1 / 双周→14）；
    // month/year 近似（confident=false）不采用，仍交中国理财网取权威值，避免误用错误天数替代抓取。
    if (nd && nd.confident) {
      holdDays = nd.days;
    }
  }
  const rawName = b.prodName || rowName || null;
  // 投资性质（中国理财网权威分类）：固定收益类/现金管理类/权益类/混合类/商品及金融衍生品类。
  // 【项目铁律 2026-10-21 立、2026-10-23 补齐】现金管理类一律不收录——这是**唯一**在
  // info / quota 模式（不抓净值序列，「整段恒 1」判据失效）也能拿到的权威类型信号，
  // 且中国理财网对全市场产品都有登记，覆盖所有银行端口（2026-10-23 实测字段确认）。
  const investNature = String(b.prodInvestNatureName || b.prodInvestNature || "");
  const cash = /现金管理/.test(investNature);
  return {
    name: rawName,
    manager: b.orgName ? inferManager(b.orgName) : null,
    established: normDate(b.prodSdate) || null,
    risk: cwRiskToR(b.prodRiskLevelName),
    benchmark: bench,
    holdDays,
    regCode: regCode || null,
    source: "xinxipilu",
    investNature: investNature || null,
    cash,
  };
}

// 信息披露平台·产品元数据（仅四项信息+业绩基准，不抓净值序列）：按登记编码直查 getProductDetail。
// 与旧站 wechatSearch 是两套独立风控——直接按编码查，避开名称搜索的 429 高发，
// 用于 fetchProductFull 第2步补全（用户规则：银行未回登记编码时改走 xinxipilu 拿登记编码）。
async function xplProductDetail(regCode, sink, transport) {
  if (!regCode) return null;
  // 【2026-11-01 修复】熔断守卫改用 xplGuardHandshake（连续失败才熔断 + 半开探测），
  //   原「单次失败即熔 10 分钟」会让该 isolate 全站的中国理财网通道集体瘫痪。
  if (!xplGuardHandshake()) return null;
  // 2026-10-14：不再自报 "xpl.getProductDetail" 包络计时——该名以 "xpl." 开头会被前端
  // 归类成【子项】（与真正的子请求 "xpl./product/getProductDetail" 前缀撞车），
  // 且与调用方的顶层阶段（2.信息·xinxipilu直查 / 2b.信息·xinxipilu补全）量的是同一段。
  // 包络交由调用方阶段承载，这里只留子请求计时（xpl.handshake / xpl./product/getProductDetail）。
  try {
    let st = null;
    try {
      st = await xplInit(transport, sink);
    } catch (initErr) {
      xplMarkHandshakeFail();
      return null;
    }
    xplMarkHandshakeOk();
    let b = null;
    for (let at = 0; at < 2 && !b; at++) {
      try {
        const jd = await xplPostCore(st.keyBuf, st.lic, "/product/getProductDetail",
          { prodRegCode: regCode, prodId: "", ssid: "", pageNum: 1, pageSize: 10 }, transport, sink);
        b = (jd.data && jd.data.prodBasicInfoVo) || null;
      } catch (e) {
        if (/HTTP 503/.test((e && e.message) || "")) break; // 503：不退避不重试（用户规则 2026-10-13）
        if (at === 0) await new Promise((r) => setTimeout(r, 800));
      }
    }
    return b ? parseXplBasicInfo(b, regCode, null) : null;
  } catch (e) {
    navLog("xplProductDetail throw reg=" + regCode + " -> " + ((e && e.message) || e));
    return null;
  }
}


// 信披平台·按产品名检索拿登记编码（2026-10-16，根治旧站 wechatSearch 429 断链）：
//   与旧站 wechatSearch 是两套独立风控——实测旧站连续请求即 429（用户规则禁退避重试，
//   曾致网商代销 667497K 整单 nav/info/bench 全空：拿不到编码 → 双键查询无键可查）；
//   本接口按名称检索稳定可用（实测 2.5s 命中），且列表行内自带 subShareCode（渠道份额码），
//   可与产品码精确核对，从根上避免「聚宝盈60天2号错挂1号登记」类近名错配。
// 打分：① subShareCode 与产品码全等 = 100；② 归一化全名全等 = 90；
//       ③ 代码数字核一致 = 80；④ 关键词互为子串 = 60。取最高分，>0 才采用。
const xplNameCache = new Map();               // kw#code -> {t, res}
const XPL_NAME_TTL = 10 * 60 * 1000;          // 命中缓存 10min（同旧站 cwSearchCache）
const XPL_NAME_NULL_TTL = 60 * 1000;          // 未命中 60s
// App 产品名 → 信披平台可检索的核心词：
//   「招银理财 | 招睿增盈180天持有期10号增强型固收类理财计划」→「招睿增盈180天持有期10号增强型固收类理财计划」
//   （去尾部括号代码、去「银行 | 」前缀段、去「招银理财-」式管理人前缀；平台 prodName 为子串匹配，无需带前缀）
function xplSearchKeyword(name) {
  let s = String(name || "").trim();
  s = s.replace(/[（(][^)）]*[)）]\s*$/u, "");                 // 尾部括号代码「…(667497K)」
  const seg = s.split(/\s*[|｜]\s*/u);                          // 「招银理财 | 产品名」→ 取产品名段
  s = (seg.length > 1 ? seg[seg.length - 1] : s).trim();
  s = s.replace(MANAGER_PREFIX, "").replace(/\s+/gu, "").trim(); // 「招银理财-产品名」形态
  return s;
}

// 渠道产品名尾部的「份额字母」：平台 prodName 不含份额字母（平台按 subShareCode 区分份额），
// 而代销渠道的货架名常把它缀在末尾（「安盈象固收稳健十四天持有期2号H」）。
// 要求前一个字符是非 ASCII（中文/全角括号），避免把英文单词尾字母误当份额字母。
function xplNameShareLetter(name) {
  const m = /[^\x00-\x7F]([A-Za-z])$/.exec(String(name || "").trim());
  return m ? m[1].toUpperCase() : null;
}
function xplStripShareLetter(name) {
  const t = String(name || "").trim();
  return xplNameShareLetter(t) ? t.slice(0, -1).trim() : t;
}

/**
 * 产品码的「族形态」：字母骨架（去数字）+ 数字体。
 * 例：26H6399E → {letters:"H", digits:"266399"}；26H6066A → {letters:"H", digits:"266066"}。
 * 尾部份额字母先剥掉（/\d[A-Z]$/），因为同一产品的各份额码**数字体相同、只差尾字母**。
 */
function xplCodeFamily(s) {
  const t = String(s || "").trim().toUpperCase();
  if (!t) return null;
  const body = /\d[A-Z]$/.test(t) ? t.slice(0, -1) : t;
  // 字母骨架：去数字 + **折叠连续重复字母**（平台的 prodCode 26HH6399 与发行方码 26H6399E
  // 只差一个重复的 H，属同一产品的两种写法；折叠后骨架才可比）。
  const letters = body.replace(/[0-9]/g, "").replace(/(.)\1+/g, "$1");
  const digits = body.replace(/[^0-9]/g, "");
  if (!letters || !digits) return null;   // 无字母骨架（如纯数字渠道码 2301232123）→ 不可比
  return { letters, digits };
}

/**
 * 判定「渠道码」与「命中行的码」是否**必属不同产品**（2026-11-01 用户铁律：产品唯一标识是产品代码）。
 *
 * 背景：信披平台按名称检索会把**同名不同码**的产品一并返回（普遍现象，非个例）——
 *   工银·鑫悦打新策略优选最短持有90天混合类开放 就有两个：
 *     26H6066A / Z7000826001265（净值 1.0085，工行官网唯一收录的）
 *     26HH6399 / Z7000826001311（净值 1.0121，工行官网查无此产品）
 *   若按名称命中了「另一个产品」并拿它的份额码去发行行官网查，就会把**别的产品**的净值
 *   当本产品入库（来源还显示成该发行行官网 —— 比抓不到更坏）。
 *
 * 判定规则（可证伪、不误伤）：
 *   两侧字母骨架**都非空且相同**（同族形态，如 26H6399E / 26H6066A 都是「H」+6 位数字）
 *   **且数字体不同** ⇒ 必是不同产品（同一产品的各份额码数字体恒相同）→ 剔除。
 *   字母骨架不同 / 有一侧为空 ⇒ 属「渠道码与发行方份额码无字面关系」形态
 *   （浦发 2301232123 ↔ 信银 AF223066H、招行 667497K ↔ 招银 109463N），
 *   名检索是唯一手段 → 放行，不误伤。
 */
function xplForeignCode(code, other) {
  const a = xplCodeFamily(code), b = xplCodeFamily(other);
  if (!a || !b) return false;
  if (a.letters !== b.letters) return false;
  return a.digits !== b.digits;
}


// 检索候选词：原名之外，补一个「去掉所有括号段」的变体。
// 平台 prodName 常比 App 显示名短（如 App「阳光金增利稳健天天购46号（14天最低持有）A」
// vs 平台「阳光金增利稳健天天购46号A」），xplSearchKeyword 只去尾部括号，中间括号段
// （持有期说明等）会令整词零命中，故生成去括号变体兜底（2026-10-16 EW7746A 实测）。
// 【2026-10-25】再补一个「去掉尾部份额字母」变体，且排在最前：带份额字母的整词在平台
// 恒零命中（实测「…2号H」list=0），而 getProductList 连续请求极易 503，一次白跑就可能
// 把整链打成 miss（503 立即中止，不再换词）。先去字母再检索可一次命中。
function xplKeywordCandidates(name) {
  const base = xplSearchKeyword(name);
  if (!base) return [];
  const out = [];
  const push = (s) => {
    s = String(s || "").trim();
    if (s.length >= 8 && !out.includes(s)) out.push(s);
  };
  push(xplStripShareLetter(base));
  push(base);
  const noParen = base.replace(/[（(][^)）]*[)）]/gu, "").trim();
  push(noParen);
  push(xplStripShareLetter(noParen));
  return out;
}
// 【诊断用】原样返回 getProductList 的命中列表（不做打分/收敛），
// 用于排查「同名多份额」类产品（如信银安盈象2号 的 B/H 份额）。
// 与 __probeCmbSearch 同性质：只给排查脚本调用，不参与生产链路。
export async function __probeXplProductList(kw, transport, sink = null, pageNum = 1, pageSize = 50) {
  const st = await xplInit(transport, sink);
  const j = await xplPostCore(st.keyBuf, st.lic, "/product/getProductList", {
    orgName: "", prodName: String(kw || ""), prodRegCode: "", pageNum: Number(pageNum) || 1, pageSize: Number(pageSize) || 50,
    prodStatus: "", prodSpclAttr: "", prodInvestNature: "", prodOperateMode: "",
    prodRiskLevel: "", prodTermCode: "", actDaysStart: null, actDaysEnd: null,
  }, transport, sink);
  return ((j && j.data && j.data.list) || []).map((p) => ({
    prodName: p.prodName, subShareCode: p.subShareCode, prodCode: p.prodCode,
    prodRegCode: p.prodRegCode, prodStatus: p.prodStatus,
  }));
}

// 通用检索探针：可按 发行机构(orgName) / 产品名(prodName) / 登记编码(prodRegCode) 组合查。
// 用途：批量定位「渠道份额码 → 登记编码」映射（XPL_SHARE_REG 人工补录的取数通道）。
export async function __probeXplSearch(opts = {}, transport, sink = null) {  const st = await xplInit(transport, sink);
  const j = await xplPostCore(st.keyBuf, st.lic, "/product/getProductList", {
    orgName: String(opts.orgName || ""), prodName: String(opts.prodName || ""),
    prodRegCode: String(opts.prodRegCode || ""),
    pageNum: Number(opts.pageNum) || 1, pageSize: Number(opts.pageSize) || 50,
    prodStatus: "", prodSpclAttr: "", prodInvestNature: "", prodOperateMode: "",
    prodRiskLevel: "", prodTermCode: "", actDaysStart: null, actDaysEnd: null,
  }, transport, sink);
  return ((j && j.data && j.data.list) || []).map((p) => ({
    prodName: p.prodName, subShareCode: p.subShareCode, prodCode: p.prodCode,
    prodRegCode: p.prodRegCode, prodStatus: p.prodStatus,
  }));
}

// 详情端点探针（/product/getProductDetail，与列表端点 getProductList 分属不同风控桶）：
// 按登记编码取产品基础信息（名称/发行方/成立日/风险/基准/持有期），用于核对
// 「渠道份额码 → 登记编码」映射是否对得上产品名。
export async function __probeXplDetail(regCode, transport, sink = null) {
  const b = await xplProductDetail(String(regCode || "").trim().toUpperCase(), sink, transport);
  return b || null;
}

// 探针用：强制丢弃 XPL 会话状态（keyBuf + license），下一次调用重新握手。
// 用途：排查「code=-1 验证失败」——该码含义是 RSA 许可/会话错配（lic 失效或会话失配），
// 与「查无数据」不同；重新握手通常可恢复。仅供 _probe 脚本使用，生产路径不调用。
export function __probeXplResetState() {
  xplState = null;
  return true;
}

export async function xplNameToReg(name, code, transport, sink) {
  const c = String(code || "").trim().toUpperCase();
  const candidates = xplKeywordCandidates(name);
  if (!candidates.length) return null;
  const cacheKey = candidates[0] + "#" + c;
  const hit = xplNameCache.get(cacheKey);
  if (hit && Date.now() - hit.t < (hit.res ? XPL_NAME_TTL : XPL_NAME_NULL_TTL)) return hit.res;
  const miss = () => { xplNameCache.set(cacheKey, { t: Date.now(), res: null }); return null; };
  // 【2026-11-01 修复】熔断守卫改用 xplGuardHandshake（连续失败才熔断 + 半开探测），
  //   原「单次失败即熔 10 分钟」会让该 isolate 全站的中国理财网通道集体瘫痪。
  if (!xplGuardHandshake()) return miss();
  let st = null;
  try {
    st = await xplInit(transport, sink);
  } catch (initErr) {
    // 握手失败 → 记一次失败（连续 ≥2 次才熔断）
    xplMarkHandshakeFail();
    return miss();
  }
  // 握手成功 → 风控已解除，清熔断
  xplMarkHandshakeOk();
  let list = [];
  let hitKw = "";
  // 整词零命中时逐步截短尾部（同旧站 metaFromChinaWealth 策略；平台 prodName 为子串匹配，
  // 截短只扩大候选，最终由打分收敛——subShareCode 精确核对优先于任何名称相似度）。
  // 候选词多个（原名 + 去括号变体），逐个尝试，有结果即进入打分。
  // 用户规则（2026-10-13 / 2026-10-23 重申）：getProductList 遇 503 禁重试——立即失败，交旧站 cw 回退。
  // 原「等 2s 重试一次」已删除（实测两次 503 白吃 ~4s）；503 = 同会话高频限流，继续换词/截短只会再 503，
  // 故一旦 503 直接中止本次 xpl 名检索（xplAbort），由上层回落 cw wechatSearch。
  let xplAbort = false;
  for (const kw of candidates) {
    for (let cut = kw.length; cut >= 8 && !list.length; cut -= 4) {
      try {
        const j = await xplPostCore(st.keyBuf, st.lic, "/product/getProductList", {
          orgName: "", prodName: kw.slice(0, cut), prodRegCode: "", pageNum: 1, pageSize: 20,
          prodStatus: "", prodSpclAttr: "", prodInvestNature: "", prodOperateMode: "",
          prodRiskLevel: "", prodTermCode: "", actDaysStart: null, actDaysEnd: null,
        }, transport, sink);
        list = (j && j.data && j.data.list) || [];
        navLog("xpl名检索调试 kw=" + JSON.stringify(kw.slice(0, cut)) + " -> list=" + list.length);
        if (list.length) hitKw = kw;
      } catch (e) {
        const msg = (e && e.message) || String(e);
        navLog("xpl名检索调试 kw=" + JSON.stringify(kw.slice(0, cut)) + " throw " + msg);
        list = [];
        if (/503/.test(msg)) { xplAbort = true; break; } // 503：立即失败，不再换词重试
      }
      if (!list.length) await new Promise((r) => setTimeout(r, 300));
    }
    if (list.length || xplAbort) break;
  }
  if (!list.length) return miss();
  const normName = normNameFull(name).replace(/[|｜]/gu, "");
  const normKw = normNameFull(hitKw);
  const cDigits = codeDigits(c);
  let best = null, bestScore = -1;
  for (const p of list) {
    // 【2026-11-01 修复】剔除「同形不同数」的**另一个产品**行。
    // 平台按名称检索会把同名不同码产品一并返回（工银·鑫悦90天就有 26H6066A 与 26HH6399 两个）。
    // 若让这样的行胜出（它的 subShareCode 属另一产品），后续拿该份额码去发行行官网查，
    // 会把**别的产品**的净值当本产品入库，来源还显示成该发行行官网 —— 比抓不到更坏。
    // 判据见 xplForeignCode：字母骨架相同（同族形态）而数字体不同 ⇒ 必是不同产品。
    if (xplForeignCode(c, p.subShareCode) || xplForeignCode(c, p.prodCode)) {
      navLog("xpl名检索剔除异产品行 code=" + c + " hit=" + (p.prodCode || "-") + "/" + (p.subShareCode || "-") + " name=" + (p.prodName || ""));
      continue;
    }
    const cn = normNameFull(p.prodName);
    let score = 0;
    if (c && p.subShareCode && String(p.subShareCode).toUpperCase() === c) score = 100;
    else if (cn && cn === normName) score = 90;
    else if (cDigits && codeDigits(p.prodCode || p.subShareCode) === cDigits) score = 80;
    else if (cn && (cn.includes(normKw) || normKw.includes(cn))) score = 60;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  if (!best || bestScore <= 0 || !best.prodRegCode) return miss();
  const res = { regCode: best.prodRegCode, subShareCode: best.subShareCode || null, name: best.prodName || null };
  xplNameCache.set(cacheKey, { t: Date.now(), res });
  navLog("xpl名检索 kw=" + hitKw + " -> reg=" + res.regCode + " subShare=" + (res.subShareCode || "-") + " score=" + bestScore);
  return res;
}

// ==========================================================================
// 渠道码 → 发行方份额码桥接（2026-10-25）
//
// 问题：代销渠道（浦发/招行/…）货架上的产品码是**渠道自己的码**，与发行方份额码毫无
//   字面关系（实证：浦发 2301232123 = 信银 AF223066H）。发行行端口（信银官网
//   getTAProductDetail?prodCode=）和中国理财网双键查询都只认份额码，故这类产品在
//   「代销行 + 发行行 + 中国理财网」三处全部抓空 → 前端显示「演示」。
//
// 桥接手段（按可靠性降序）：
//   ① 代销行端口自己回 regCode（多数银行有，浦发没有）；
//   ② XPL_SHARE_REG 人工映射——**仅当渠道码本身等于 xpl 的 subShareCode 时有效**，
//      多份额产品（同一登记编码下 A/B/H… 各有独立净值）不适用，切勿盲目补录；
//   ③ 名检索拿到「平台收录的份额码」，再用渠道产品名尾部份额字母替换尾字母
//      （同产品各份额码主体相同，仅尾字母不同）→ 得渠道真正在售的份额。
//
// 本文件实现 ③，并把结果按渠道码缓存 6 小时（首次 ~3s，之后零成本）。
// ==========================================================================
const SHARE_CODE_RE = /^([A-Z]{2}\d{5,6})([A-Z])$/;   // 份额码形态：AF223066H
// 缓存 10 分钟（与 xplNameCache 命中 TTL 同节奏），不设更长：推导是「尾字母替换」这一
// 启发式，万一渠道名尾部字母不是份额字母、推导出的份额码不存在，长 TTL 会让该产品在
// 数小时内都抓不到且无法自愈；10 分钟内名检索结果仍在缓存，重算几乎零成本。
const CHANNEL_SHARE_TTL = 10 * 60 * 1000;
const channelShareCache = new Map();                  // 渠道码 → { t, share, reg }

/**
 * 把「平台份额码」改写为「渠道在售份额码」：份额字母取自渠道产品名尾部 或 渠道码尾部
 * （任一 ≠ 平台尾字母即采用）。例：
 *   名字带字母：platformShare="AF223066B" + name="安盈象固收稳健十四天持有期2号H" → "AF223066H"
 *   字母在码里：platformShare="WPBK24M0501A" + code="WPBK24M0501T"（名字只到「期」）→ "WPBK24M0501T"
 * 返回 null 表示无需改写（无法推导 / 尾字母已一致），调用方沿用原值。
 */
// 从「渠道码」尾部提取份额字母：仅当渠道码本身是「字母前缀 + 数字 + 末位字母」的份额码形态、
// 且其前缀与平台份额码前缀一致时（即同产品不同份额），才采用。避免把普通产品码尾字母误当份额。
// 覆盖上银 WPBK24M0501T（4 字母前缀、中间夹字母）等 SHARE_CODE_RE 框不住的形态。
function xplCodeShareLetter(code, platformPrefix) {
  const c = String(code || "").trim().toUpperCase();
  if (!c || !platformPrefix) return null;
  if (!/^[A-Z0-9]{2,}[A-Z]$/.test(c)) return null;       // 渠道码须以字母结尾、全字母数字
  // ① 严格前缀匹配：渠道码 = 平台前缀 + 单字母（上银 WPBK24M0501T vs WPBK24M0501A）
  if (c.slice(0, -1) === platformPrefix) return c.slice(-1);
  // ② 渠道码以平台前缀开头且更长：超出的尾段即份额（招银 109463WS vs 平台 109463N → WS）。
  //    CMB/招银这类「产品码 + 多字母份额后缀」形态，平台默认份额（109463N）与渠道份额
  //    （109463WS）仅尾段不同 → 取渠道码超出平台前缀的部分作份额字母。
  if (c.startsWith(platformPrefix) && c.length > platformPrefix.length) {
    return c.slice(platformPrefix.length);
  }
  return null;
}

// 份额字母来源优先级：① 渠道产品名尾部字母（信银安盈象2号H 等，名字就带份额字母）；
//   ② 渠道码尾部字母（上银 WPBK24M0501T 等，份额字母在码里、名字只到「期」不带字母，
//      如本案：网商代销 T 份额、微众代销 B 份额、上银自销 A 份额，同一「期」三种净值各异）。
// 任一来源命中且 ≠ 平台份额尾字母即采用，把平台默认份额（常为主份额 A）改写为渠道在售份额，
// 避免「把 A 份额净值当成 T 份额入库」（比抓不到更糟，实测 WPBK24M0501T 误取 A=1.101120）。
function xplShareVariant(platformShare, channelName, channelCode) {
  const s = String(platformShare || "").trim().toUpperCase();
  // 平台份额码拆成「前缀 + 末位字母」：优先 SHARE_CODE_RE（信银式 2 字母 + 5-6 数字），
  // 否则宽松匹配（上银式 WPBK24M0501A 等前缀更长 / 中间夹字母）。
  let m = SHARE_CODE_RE.exec(s);
  if (!m) m = /^(.+?)([A-Z])$/.exec(s);
  if (!m) return null;
  const letter = xplNameShareLetter(channelName) || xplCodeShareLetter(channelCode, m[1]);
  if (!letter || letter === m[2]) return null;
  return m[1] + letter;
}

// 纯字符串工具（无网络、无状态）：导出供回归脚本单测，避免每次都打线上接口。
export { xplShareVariant, xplStripShareLetter, xplNameShareLetter, xplKeywordCandidates, chinawealthNav, xplCodeFamily, xplForeignCode };

/**
 * 解析「渠道码 → 发行方份额码」。仅当本渠道按渠道码抓空后才会被调用（见 fetchProductFull）。
 * 依赖名检索（xplNameToReg，自带 10min 命中缓存 / 60s 未命中缓存），故与
 * chinawealthNav 内部的同一次检索共享缓存，净增成本≈0。
 */
/**
 * 按**登记编码**取该产品的份额族（全程不碰产品名）——2026-11-01 用户铁律落地。
 * 平台 getProductList 支持 prodRegCode 过滤，返回该登记编码下的全部份额行。
 */
async function xplRegToShareFamily(regCode, transport, sink) {
  const reg = String(regCode || "").trim().toUpperCase();
  if (!reg) return null;
  let st = null;
  try { st = await xplInit(transport, sink); }
  catch (e) { navLog("xpl reg=" + reg + " 握手失败 " + ((e && e.message) || e)); return null; }
  let rows = [];
  try {
    const j = await xplPostCore(st.keyBuf, st.lic, "/product/getProductList", {
      orgName: "", prodName: "", prodRegCode: reg,
      pageNum: 1, pageSize: 20,
      prodStatus: "", prodSpclAttr: "", prodInvestNature: "", prodOperateMode: "",
      prodRiskLevel: "", prodTermCode: "", actDaysStart: null, actDaysEnd: null,
    }, transport, sink);
    rows = (j && j.data && j.data.list) || [];
  } catch (e) { navLog("xpl reg=" + reg + " 取份额族 throw " + ((e && e.message) || e)); return null; }
  const out = [];
  for (const p of rows) {
    if (p && p.prodRegCode && String(p.prodRegCode).toUpperCase() !== reg) continue;
    out.push({ prodCode: p.prodCode || null, subShareCode: p.subShareCode || null, name: p.prodName || null });
  }
  return out.length ? out : null;
}

async function resolveChannelShare(code, name, transport, sink, regCode) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  const hit = channelShareCache.get(c);
  if (hit && Date.now() - hit.t < CHANNEL_SHARE_TTL) return hit.share;
  const t0 = Date.now();
  let platformShare = null, reg = String(regCode || "").trim().toUpperCase() || null, src = "";
  // ① 首选：按登记编码取本产品自己的份额族 —— 全程不碰产品名，
  //    天然排除「同名不同码」的其它产品（工银·鑫悦90天：26H6066A/Z7000826001265
  //    与 26HH6399/Z7000826001311 同名，净值 1.0085 vs 1.0121）。
  if (reg) {
    const rows = await xplRegToShareFamily(reg, transport, sink);
    if (rows && rows.length) {
      const same = rows.find((r) => r.subShareCode && !xplForeignCode(c, r.subShareCode));
      const pick = same || rows[0];
      platformShare = pick.subShareCode || null;
      src = "按登记编码 " + reg;
      navLog("share-bridge code=" + c + " " + src + " -> platform=" + platformShare + " (行数 " + rows.length + ")");
    } else {
      navLog("share-bridge code=" + c + " 按登记编码 " + reg + " 取份额族无果 -> 回退名检索");
    }
  }
  // ② 回退：按名检索（xplNameToReg 内部已剔除「同形不同数」的异产品行）
  if (!platformShare && name) {
    let x = null;
    try { x = await xplNameToReg(name, c, transport, sink); }
    catch (e) { navLog("share-bridge code=" + c + " 名检索 throw " + ((e && e.message) || e)); }
    if (x) {
      platformShare = x.subShareCode || null;
      reg = reg || x.regCode || null;
      src = src || "名检索";
    }
  }
  if (!platformShare) { navTiming(sink, "1x.份额码桥接", Date.now() - t0, "miss"); return null; }
  const share = xplShareVariant(platformShare, name, c) || platformShare;
  // 【2026-11-01 守卫】推导出的份额码若与渠道码「同形不同数」⇒ 属另一个产品 → 拒绝采用。
  // 不拒的话：拿异产品的份额码去发行行官网查 → 把**别的产品**的净值当本产品入库，
  // 来源还显示成该发行行官网（比抓不到更坏）。
  if (xplForeignCode(c, share)) {
    navLog("share-bridge code=" + c + " 份额码 " + share + " 与渠道码同形不同数 → 判为异产品，拒绝采用");
    navTiming(sink, "1x.份额码桥接", Date.now() - t0, "reject 异产品份额码 " + share);
    return null;
  }
  navTiming(sink, "1x.份额码桥接", Date.now() - t0,
    "reg=" + (reg || "-") + " platform=" + platformShare + " -> share=" + share + (src ? " [" + src + "]" : ""));
  channelShareCache.set(c, { t: Date.now(), share, reg: reg || null });
  navLog("share-bridge code=" + c + " -> share=" + share + " reg=" + (reg || "-") + " src=" + (src || "-"));
  return share;
}

// 四项信息补全（fetchProductFull 第2步）：优先信息披露平台 xinxipilu（按登记编码直查，独立风控、避开旧站
//   wechatSearch 的 429 高发）；仅当银行未回登记编码（regCode 为空）才回退旧站 wechatSearch 先拿编码，
//   再用该编码转 xinxipilu 补全（更权威）。
async function metaFromChinaWealthXpl(icbcName, icbcCode, regCode, sink, transport) {
  if (regCode) {
    const t0 = Date.now();
    const x = await xplProductDetail(regCode, sink, transport);
    navTiming(sink, "2.信息·xinxipilu直查", Date.now() - t0, x ? ("hit reg=" + (x.regCode || "-")) : "null(回退旧站)");
    if (x) return x;
  }
  // 2026-10-16：无登记编码（银行未回、XPL_SHARE_REG 未登记的新渠道份额）时，先走信披平台
  // getProductList 按名称检索拿编码——与旧站 wechatSearch 是两套独立风控，不受其 429 限流
  // 牵连（实测旧站连续请求即 429 且用户规则禁退避，曾致网商代销 667497K 整单 nav/info/bench
  // 全空）；且列表行内自带 subShareCode（渠道份额码），可与产品码精确核对，从根上避免
  // 「聚宝盈60天2号错挂1号登记」类近名错配（旧站名检索无此字段可核）。
  // 命中即转 xinxipilu 按码直查；直查失败也把编码回传——净值阶段 chinawealthNav 复用它。
  let reg2 = regCode || null;
  if (!reg2 && icbcName) {
    const t0 = Date.now();
    let x = null;
    try { x = await xplNameToReg(icbcName, icbcCode, transport, sink); }
    catch (e) { navLog("cw xpl名检索 code=" + (icbcCode || "-") + " throw " + ((e && e.message) || e)); }
    navTiming(sink, "2.信息·xinxipilu名检索", Date.now() - t0,
      x ? ("hit reg=" + (x.regCode || "-") + " subShare=" + (x.subShareCode || "-")) : "null(回退旧站)");
    if (x && x.regCode) {
      reg2 = x.regCode;
      const d = await xplProductDetail(reg2, sink, transport);
      if (d) return d;
      // 直查失败（罕见）：至少把名检索所得编码带回，供净值阶段双键查询使用
      navLog("cw xpl名检索命中 reg=" + reg2 + " 但详情直查失败 → 仅回传编码");
      return { regCode: reg2, name: x.name || null, source: "xinxipilu" };
    }
  }
  // 旧站 wechatSearch 拿编码 + 四项（按码直查失败/无码时都要走：无码时它负责找编码，
  //   有码而直查失败时它负责补基准/风险等其它字段），再尝试 xinxipilu 以编码补全
  const t1 = Date.now();
  const old = await metaFromChinaWealth(icbcName, null, icbcCode, reg2, sink);
  navTiming(sink, "2.信息·中国理财网(回退)", Date.now() - t1, old ? ("hit reg=" + (old.regCode || "-")) : "null");
  if (old && old.regCode) {
    // 2026-10-16：regCode 是按码所得（银行直连 regCode / XPL_SHARE_REG 份额映射 /
    // 调用方显式传入 / xpl 名检索 subShareCode 核对）时，登记编码一律以它为准——旧站按名
    // 检索会把近名产品错配（实测聚宝盈60天2号 曾错挂 1 号的登记 Z7001026001429，对 2 号
    // 查净值恒 0 行）。名检索结果只用来补基准/风险等其它字段，登记编码不让它覆盖。
    if (reg2 && old.regCode !== reg2) {
      navLog("cw 名检索 reg=" + old.regCode + " 与按码 reg=" + reg2 + " 不一致 → 采用按码值");
      old.regCode = reg2;
    }
    // 2026-10-14：xinxipilu 补全此前没有自己的顶层阶段包络 → xpl.* 子项被归到后面的
    // 「3.基准」阶段名下，且顶层分项相加对不上总耗时（差的正是这段，如 13.9s 的详情请求）。
    // 现补 2b 阶段包络：子项（xpl.handshake / xpl./product/getProductDetail）归其名下。
    const t2 = Date.now();
    const x = await xplProductDetail(old.regCode, sink, transport);
    navTiming(sink, "2b.信息·xinxipilu补全", Date.now() - t2, x ? ("hit reg=" + (x.regCode || "-")) : "null(沿用旧站结果)");
    if (x) return x;
  }
  return old;
}

/* ==========================================================================
 * 北京银行 / 北银理财（BOB）实时抓取
 *
 * 站点：https://beijingbobwealth.com.cn （北银理财有限责任公司，北京银行理财子公司 = 发行方）
 * 接口（均免签名 / 免 Token；响应无 CORS 头，浏览器直连被拦，须服务端 / Worker 代理）：
 *   ① 产品信息（GET）：/bylc-api/product/info?PROD_CODE=<代码>
 *      响应 {state:"ok", data:{...}}；data:null 即查无此码。
 *      关键字段：PROD_NAME / PROD_FLAG（1=有子份额的父码，2=子份额）/ OPEN_TYPE
 *       （1封闭净值 2每日净值 5最短持有 6现金管理）/ RISK_LEVEL_DESC（低风险…）/
 *       PROD_MANAGER|MANAGER_NAME（北银理财有限责任公司）/ ESTABLISH_DATE（YYYYMMDD）/
 *       PROD_TERM_DESC（每日开放 / 最短持有X天）/ CHINABOND_REGCODE（登记编码）/
 *       PERFORMANCE_BENCHMARK（业绩基准）
 *   ② 子份额（GET）：/bylc-api/product/subs?PROD_CODE=<父码>
 *      PROD_FLAG==1 时 navlist 父码返回 0 行，须用子码（取首个子份额 PROD_CODE）。
 *   ③ 历史净值（GET）：/bylc-api/product/navlist?PROD_CODE=<子码>&pageSize=2000&pageNumber=1
 *      响应 data.list[{NAV_DATE(YYYYMMDD), NAV, ACCUMULATIVE_NAV, INCOME_UNIT(万份收益),
 *      INCOME_RATIO(七日年化)}]，data.totalRow 为总条数。现金管理类(OPEN_TYPE=6)的 NAV 字段
 *      实际是万份口径——按项目规则该类产品在 bobWebFetch 开头即 return null 排除（不抓不处理），
 *      其余类型 NAV 即单位净值，直接取用。
 *
 * 限制：封闭净值型(OPEN_TYPE=1)该接口不披露历史净值（navlist 恒返回 0 行），仅每日净值 /
 *      最短持有 / 现金管理类产品可抓。登记编码经 CHINABOND_REGCODE 直接返回（监管 Z700… 编码）。
 *
 * App 端口（cdnmobibank 手机银行 H5，SM2/SM4 国密网关 POST /H，借无头 Chrome + JSON.parse
 *   hook 拿解密明文，见 bob_app.mjs）：详情字段（名称/风险/最短持有 lockDays/基准/额度/成立日）+
 *   全量历史净值（页面内点图表时间 tab 后接口回 cd.list=[{navDate,nav,totNav}]，按交易日
 *   发布，2026-10-17 晚间 F12 抓包打通）。按需单抓：web 有全序列时热路径不跑 Chrome；
 *   web 查无此码/无序列（北银代销他行产品）才 fallback，或 /api/bobapp 显式触发。
 *   份额码在 App 查无时自动按父码重试一次（App 按父码上架，如 TG01190701A→TG01190701）。
 *   现金管理类（OPEN_TYPE=6）在 web 端口即被项目规则排除（bobWebFetch 开头 return null），
 *   不会进入 App 端口合并。
 * ========================================================================== */

const BOB_HOST = "https://beijingbobwealth.com.cn";
const BOB_INFO_EP = "/bylc-api/product/info";
const BOB_SUBS_EP = "/bylc-api/product/subs";
const BOB_NAV_EP = "/bylc-api/product/navlist";
const BOB_PAGE_SIZE = 2000;
const BOB_TIMEOUT_MS = 12000;

// "20260621" / "2026-06-21" → "2026-06-21"
function bobNormDate(s) {
  const d = String(s || "").replace(/[^0-9]/g, "");
  const m = d.match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// 风险等级文案 → R1..R5（顺序敏感：先判复合词，再判单字词）
function bobRiskToR(t) {
  if (!t) return null;
  if (/中低风险/.test(t)) return "R2";
  if (/中高风险/.test(t)) return "R4";
  if (/高风险/.test(t)) return "R5";
  if (/中风险/.test(t)) return "R3";
  if (/低风险/.test(t)) return "R1";
  return null;
}

// 最短持有天数：每日开放 / 现金管理 → 1；否则从「最短持有X天 / X天」提取
function bobHoldDays(desc, days) {
  const t = String(desc || "");
  if (/每日开放|现金管理/.test(t)) return 1;
  const m = t.match(/(\d+)\s*天/);
  if (m) return Number(m[1]);
  const d = Number(days);
  if (Number.isFinite(d) && d > 0) return d;
  return null;
}

/* ==========================================================================
 * 招商银行「最短持有天数」解析（移植自「银行所有产品总汇」项目的 parseHoldDays / cn2num / daysBetween，
 * 2026-10-31 采纳）。比 bobHoldDays 更全：覆盖 月/年/季/周/半年/天 + 中文数字（二十三/十八月），
 * 并对「封闭式/期次型」用「到期日 − 成立日」兜底（定开类不适用）。
 *
 * 入参：name=产品名（主判据）、finDate=超市 finDate 原始值（数字天数或脏值，仅兜底）、
 *       expireDate=到期日(YYYY-MM-DD)、establishedDate=成立日(YYYY-MM-DD)。
 * 返：纯数字天数 | null。日开/每日开放 → 1（随时可赎）；现金管理类（天添金/日日/活钱管家）本函数不判，
 *      由上层按净值形态判现金管理，此处按名称词形视作 1（随时可赎）。
 * ========================================================================== */
const CMB_HD_CN = { 零: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const CMB_HD_NUM = "(\\d+|[零一两二三四五六七八九十]+)";
function cmbHdCn2num(s) {
  const t = String(s || "").trim();
  if (/^\d+$/.test(t)) return Number(t);
  if (!t) return null;
  if (t === "十") return 10;
  if (t.length === 1) return CMB_HD_CN[t] ?? null;
  if (t.length === 2) {
    if (t[0] === "十") return 10 + (CMB_HD_CN[t[1]] || 0);
    if (t[1] === "十") return (CMB_HD_CN[t[0]] || 0) * 10;
  }
  if (t.length === 3 && t[1] === "十") return (CMB_HD_CN[t[0]] || 0) * 10 + (CMB_HD_CN[t[2]] || 0);
  return null;
}
function cmbHdDaysBetween(a, b) {
  if (!a || !b) return null;
  const t = (new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400000;
  return isFinite(t) && t > 0 ? Math.round(t) : null;
}
function cmbHoldDays(name, finDate, expireDate, establishedDate) {
  const s = String(name || "");
  const D = (n, unit) => (n == null ? null : unit === "m" ? n * 30 : unit === "y" ? n * 365 : unit === "w" ? n : n);
  // 1) 词形规则（无数字，按约定开放周期 / 现金管理随时赎）
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
  // 2) 数字 + 单位（优先级：语义最强的「持有/滚动」写法在前）
  const rules = [
    [new RegExp(CMB_HD_NUM + "\\s*天(?:持有|滚动)"), "d"],
    [new RegExp(CMB_HD_NUM + "\\s*个?月(?:持有|滚动)"), "m"],
    [new RegExp(CMB_HD_NUM + "\\s*年(?:持有|期)"), "y"],
    [new RegExp("(?:滚动持有|持有|滚动)\\s*" + CMB_HD_NUM + "\\s*天"), "d"],
    [new RegExp("(?:滚动持有|持有|滚动)\\s*" + CMB_HD_NUM + "\\s*个?月"), "m"],
    [new RegExp("(?:滚动持有|持有|滚动)\\s*" + CMB_HD_NUM + "\\s*年"), "y"],
    [new RegExp(CMB_HD_NUM + "\\s*个?月封闭"), "m"],
    [new RegExp(CMB_HD_NUM + "\\s*年封闭"), "y"],
    [new RegExp(CMB_HD_NUM + "\\s*天封闭"), "d"],
    [new RegExp(CMB_HD_NUM + "\\s*个?月\\s*(?:定开|定期开放|开(?![放始]))"), "m"],
    [new RegExp(CMB_HD_NUM + "\\s*年\\s*(?:定开|定期开放|开(?![放始]))"), "y"],
    [new RegExp(CMB_HD_NUM + "\\s*天\\s*(?:定开|定期开放)"), "d"],
    [new RegExp(CMB_HD_NUM + "\\s*个?月"), "m"],
    [new RegExp(CMB_HD_NUM + "\\s*年"), "y"],
    [new RegExp(CMB_HD_NUM + "\\s*天"), "d"],
  ];
  for (const [re, unit] of rules) {
    const m = re.exec(s);
    if (m) { const n = cmbHdCn2num(m[1]); if (n != null && n > 0) return D(n, unit); }
  }
  // 3) 兜底：超市 finDate 是纯天数（脏值如 29115/10957 会被下面 >3650 拦掉）
  const fd = Number(finDate);
  if (Number.isFinite(fd) && fd > 0 && fd <= 3650) return fd;
  // 4) 兜底：封闭式/期次型用「到期日 − 成立日」（定开类到期日=产品终止日，不适用）
  if (!/定开/.test(s) && /封闭|期|目标盈/.test(s)) {
    const hd = cmbHdDaysBetween(establishedDate || null, expireDate || null);
    if (hd != null && hd <= 3650) return hd;
  }
  return null;
}

async function bobGet(path, params, transport) {
  const qs = Object.entries(params).map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BOB_TIMEOUT_MS);
  try {
    const res = await (transport || fetch)(BOB_HOST + path + "?" + qs, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: ctrl.signal,
    });
    const j = await res.json();
    return j && j.data != null ? j.data : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* App 端口抓取（cdnmobibank 手机银行 H5，国密加密）：仅本机 Node 生效（借无头 Chrome 解密，
 * 见 bob_app.mjs）。Cloudflare Workers 无 process / 无 Chrome，此分支不执行、动态导入也不解析。
 * 份额码在 App 查无时的父码重试已内置于 bob_app.mjs 的 bobAppCapture（TG01190701A→TG01190701）。
 *
 * 2026-10-22：恢复启用无头 Chrome App 端口（用户要求放出来预热并实测 132040B 耗时）。
 * 仅作「web 查无/无序列产品」的窄口径兜底；现金管理类仍在 bobWebFetch 开头排除，不会误触发。
 * 若实测确认过慢，改回 return null 即可。 */
async function bobAppFetch(code, opts = {}) {
  try {
    const mod = await import(new URL("./bob_app.mjs", import.meta.url).href);
    return await mod.bobAppCapture(code, opts);
  } catch (e) {
    return null;
  }
}

/* 农业银行 App 端口（wx.abchina.com/webank 分享落地页）—— 见 abc_app.mjs。
 * 与 bob/ceb 同约束：Cloudflare Workers 无 Chrome，此分支本地 Node 才运行；
 * 须传「分享码」(链接 ?code= 参数 <ACCESSID>_<f产品码>)，按产品代码通用查询不可行
 * （accessId 无法反推）。定位为 app 端口信息补充(partial:true)：成立日/最短持有/风险/
 * 业绩比较基准/收益类型/投资性质/起点金额；净值须走 web 端口 ewealth，登记编码/额度农行
 * 公开接口均不返回。不调用中国理财网。 */
export async function abcAppFetch(shareCode, opts = {}) {
  try {
    const mod = await import(new URL("./abc_app.mjs", import.meta.url).href);
    return await mod.abcAppCapture(shareCode, opts);
  } catch (e) {
    return null;
  }
}

/* 江苏银行 App 端口（mbank5h5.jsbchina.cn 手机银行 H5）—— 见 jsb_app.mjs。
 * 加密协议：YT.SecurityJSBANK(AES-CBC 载荷 + RSA 会话密钥 + MD5，以 \u001d 拼接)；
 *   不复刻算法，而是在页面上下文里调用页面自己的 YT.ajaxData（加密/公钥/解密全由页面完成）。
 *   Cloudflare Workers 无 Chrome 不执行（本机 serve 生效）。
 * ★ 2026-10-18 二次打通：业务入参只有 prdCode（shareCode 仅在公共头 _currentUrl 里，与产品无关），
 *   故**不再需要分享链接**，任意产品码可直查；净值用 dateFlag=4 一次拿「成立以来」全量。
 *   全量端口：净值序列 + 七字段 + 额度 + 登记编码。不调用中国理财网（用户硬性要求）。 */
export async function jsbAppFetchByCode(code, opts = {}) {
  try {
    const mod = await import(new URL("./jsb_app.mjs", import.meta.url).href);
    return await mod.jsbAppByCode(code, opts);
  } catch (e) {
    return null;
  }
}

/* 兼容旧入口：按分享链接触发（内部解析 prdCode 后走按码直查） */
export async function jsbAppFetch(shareUrl, opts = {}) {
  try {
    const mod = await import(new URL("./jsb_app.mjs", import.meta.url).href);
    return await mod.jsbAppCapture(shareUrl, opts);
  } catch (e) {
    return null;
  }
}

/* Web 端口（北银理财官网）：净值序列 + 登记编码 + 信息字段（原有主源）。
 * 封闭净值型(OPEN_TYPE=1)该端口无历史净值 → 返回 null，交由 App 端口兜底。 */
async function bobWebFetch(code, opts = {}) {
  const transport = opts.transport;
  // 【2026-10-23 用户规则】刷信息只刷信息——只调 BOB_INFO_EP（信息+登记编码），
  // 跳过 BOB_NAV_EP 净值接口。原先 info 模式会连净值一起抓（navOnly 只覆盖 nav/quota）。
  if (opts.infoOnly) {
    const info = await bobGet(BOB_INFO_EP, { PROD_CODE: code }, transport);
    if (!info || !info.PROD_NAME) return null;
    if (String(info.OPEN_TYPE) === "6") return { _excludedCash: true, code };
    const mgrRaw = info.PROD_MANAGER || info.MANAGER_NAME || "";
    return {
      name: info.PROD_NAME || null,
      manager: /北银/.test(mgrRaw) ? "北银理财" : (mgrRaw ? (inferManager(mgrRaw) || "北银理财") : "北银理财"),
      established: bobNormDate(info.ESTABLISH_DATE) || null,
      series: [],
      kind: "nav",
      risk: bobRiskToR(info.RISK_LEVEL_DESC),
      benchmark: info.PERFORMANCE_BENCHMARK || null,
      holdDays: bobHoldDays(info.PROD_TERM_DESC, info.PROD_TERM_DAYS),
      regCode: info.CHINABOND_REGCODE || null,
      source: "live",
      bank: "bob",
      navVia: "bob",
      navPort: "web",
      navViaCode: code,
      infoOnly: true,
    };
  }
  // 2026-10-22 用户规则（额度和净值已拆分）：nav / quota 模式不调 BOB_INFO_EP 产品信息接口，
  // 只抓 navlist。好处：① 省一次信息接口往返；② 彻底不碰产品信息（与「刷净值/刷额度不抓信息」一致）。
  // 代价：父码产品（PROD_FLAG=1）无法在此解析子份额、OPEN_TYPE=6 现金类也不在此拦截——
  // 前者在当前产品目录中无此类北银产品；后者已删除并在添加时从源头拦截，故可接受。
  // 仅 info / all（添加产品 / 刷信息）模式才走下方 BOB_INFO_EP 分支（拿信息 + 源头识别现金类）。
  if (opts.navOnly) {
    const nav = await bobGet(BOB_NAV_EP, { PROD_CODE: code, pageSize: BOB_PAGE_SIZE, pageNumber: 1 }, transport);
    const rows = (nav && (nav.list || [])) || [];
    const raw = [];
    for (const r of rows) {
      const d = bobNormDate(r.NAV_DATE);
      if (!d) continue;
      const v = parseFloat(r.NAV);
      if (!Number.isFinite(v) || v <= 0) continue;
      raw.push([d, v]);
    }
    if (!raw.length) return null;
    raw.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const ded = [];
    for (const r of raw) {
      if (ded.length && ded[ded.length - 1][0] === r[0]) ded[ded.length - 1] = r;
      else ded.push(r);
    }
    if (!ded.length) return null;
    return {
      name: null,
      manager: "北银理财",
      established: null,
      series: ded,
      kind: "nav",
      risk: null,
      benchmark: null,
      holdDays: null,
      regCode: null,
      source: "live",
      bank: "bob",
      navVia: "bob",
      navPort: "web",
      navViaCode: code,
      navLatest: ded.length ? ded[ded.length - 1][1] : null,
      navLatestDate: ded.length ? ded[ded.length - 1][0] : null,
      infoOnly: ded.length < 2,
    };
  }
  const info = await bobGet(BOB_INFO_EP, { PROD_CODE: code }, transport);
  if (!info || !info.PROD_NAME) {
    // 2026-10-28 修复：web INFO 接口对部分码（北银代销他行 / 信息仅 App 端口的产品，如 BY040204）
    // 返回 data:null，但 NAVLIST 仍有净值序列。此类情况不再整体返回 null，改走 navlist 兜底，
    // 保证 /api/fetch（不带 mode）也能拿到净值序列 —— 与浏览器直连 fetchBob 行为一致，
    // 否则 Cloudflare 路径对这类码恒 404，App 只能静默回落浏览器直连。
    return await bobWebFetch(c, { ...opts, navOnly: true }).catch(() => null);
  }

  // 【项目规则 2026-10-21 立】只收录有净值的固收产品：OPEN_TYPE=6 是现金管理类
  // （其 navlist 的 NAV 字段实际是万份口径，历史上的「INCOME_UNIT 复利合成 +
  // kind:"wan"」处理已删除）→ 直接排除，连 navlist 都不必请求。
  // 返回哨兵对象（而非 null）以便 bobFetch 区分「被规则排除」与「查无此码」，
  // 从而避免对现金管理类误启动无头 Chrome（原 35s 卡顿来源）。
  if (String(info.OPEN_TYPE) === "6") return { _excludedCash: true, code };

  // 父码（PROD_FLAG==1）需取子份额代码再查净值
  let navCode = code;
  if (String(info.PROD_FLAG) === "1") {
    const subs = await bobGet(BOB_SUBS_EP, { PROD_CODE: code }, transport);
    const arr = (subs && (subs.list || subs)) || [];
    if (arr.length && arr[0].PROD_CODE) navCode = arr[0].PROD_CODE;
  }

  const nav = await bobGet(BOB_NAV_EP, { PROD_CODE: navCode, pageSize: BOB_PAGE_SIZE, pageNumber: 1 }, transport);
  const rows = (nav && (nav.list || [])) || [];
  if (!rows.length) {
    // 无历史净值（封闭净值型 / 代销产品官网无披露）：不再整体丢弃——info 里仍有
    // 名称/风险/基准/登记编码等，返回 info-only（series 空、infoOnly=true），
    // 交由编排层继续发行行/兜底取序列，产品信息不白抓一次（2026-10-17 修订）。
    if (!info.PROD_NAME) return null;
    return {
      name: info.PROD_NAME || null,
      manager: (() => {
        const mgrRaw = info.PROD_MANAGER || info.MANAGER_NAME || "";
        if (/北银/.test(mgrRaw)) return "北银理财";
        return mgrRaw ? (inferManager(mgrRaw) || "北银理财") : "北银理财";
      })(),
      established: bobNormDate(info.ESTABLISH_DATE) || null,
      series: [],
      kind: "nav",
      risk: bobRiskToR(info.RISK_LEVEL_DESC),
      benchmark: info.PERFORMANCE_BENCHMARK || null,
      holdDays: bobHoldDays(info.PROD_TERM_DESC, info.PROD_TERM_DAYS),
      regCode: info.CHINABOND_REGCODE || null,
      source: "live",
      bank: "bob",
      navVia: "bob",
      navPort: "web",
      navViaCode: code,
      navLatest: null,
      navLatestDate: null,
      infoOnly: true,
    };
  }

  // 现金管理类（OPEN_TYPE=6）已在函数开头排除，这里全是单位净值型固收产品。
  const raw = [];
  for (const r of rows) {
    const d = bobNormDate(r.NAV_DATE);
    if (!d) continue;
    const v = parseFloat(r.NAV);
    if (!Number.isFinite(v) || v <= 0) continue;
    raw.push([d, v]);
  }
  if (!raw.length) return null;
  raw.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  // 同日去重，保留最后一条
  const ded = [];
  for (const r of raw) {
    if (ded.length && ded[ded.length - 1][0] === r[0]) ded[ded.length - 1] = r;
    else ded.push(r);
  }

  const series = ded;
  if (!series.length) return null;

  // 管理人：北银理财有限责任公司 → 北银理财
  let manager = "北银理财";
  const mgrRaw = info.PROD_MANAGER || info.MANAGER_NAME || "";
  if (/北银/.test(mgrRaw)) manager = "北银理财";
  else if (mgrRaw) manager = inferManager(mgrRaw) || "北银理财";

  return {
    name: info.PROD_NAME || null,
    manager,
    established: bobNormDate(info.ESTABLISH_DATE) || series[0][0],
    establishedFromSeries: !bobNormDate(info.ESTABLISH_DATE), // web info 无 ESTABLISH_DATE 时退序列首点
    series,
    kind: "nav", // 现金管理类已排除，走到这里的都是单位净值型固收产品
    risk: bobRiskToR(info.RISK_LEVEL_DESC),
    benchmark: info.PERFORMANCE_BENCHMARK || null,
    holdDays: bobHoldDays(info.PROD_TERM_DESC, info.PROD_TERM_DAYS),
    regCode: info.CHINABOND_REGCODE || null,
    source: "live",
    bank: "bob",
    navVia: "bob",
    navPort: "web",
    navViaCode: code,
    navLatest: series.length ? series[series.length - 1][1] : null,
    navLatestDate: series.length ? series[series.length - 1][0] : null,
    infoOnly: series.length < 2,
  };
}

/* App 端口 fallback 内存缓存：web 端口拿不到结果（代销产品：北银理财官网查无此码 /
 * 无历史序列）时才跑一次无头 Chrome。TTL 内复用，避免「每次刷新都跑 Chrome」
 * （2026-10-17 按需单抓改造；app 净值当日不变、信息字段更稳定，10 分钟 TTL 可接受）。 */
const BOB_APP_CACHE = new Map(); // code -> { t, data }
const BOB_APP_TTL_MS = 10 * 60 * 1000;
async function bobAppFallback(c, opts) {
  const isNode = (typeof process !== "undefined" && process.versions && process.versions.node);
  if (!isNode) return null; // Cloudflare 侧无 Chrome，不兜底
  const hit = BOB_APP_CACHE.get(c);
  if (hit && Date.now() - hit.t < BOB_APP_TTL_MS) return hit.data;
  const app = await bobAppFetch(c, opts).catch(() => null);
  if (app) BOB_APP_CACHE.set(c, { t: Date.now(), data: app });
  return app;
}

/* web + app 两端结果合并：
 * - 净值序列：按日期并集，同日 App 优先（App 端口 cd.list 全量历史，2026-10-17 晚间 F12 抓包
 *   打通：点图表时间 tab 后接口回全量记录，按交易日发布；对成立不久的产品近六月/近一年即全量，
 *   老产品取最大窗口）。navPort 按谁提供最新净值日判定。
 * - 登记编码取 Web（App 无）；额度取 App；信息字段 Web 优先、App 补缺。 */
function bobMerge(web, app, c) {
  if (!web && !app) return null;
  const appSeries = app && Array.isArray(app.series) && app.series.length >= 2 ? app.series : null;
  if (web && !app) return web;
  if (app && !web) {
    // Web 无结果（北银代销他行产品，官网查无此码）：用 App 全量净值序列；无序列才退单点
    const series = appSeries || ((app.navDate && app.nav > 0) ? [[app.navDate, app.nav]] : []);
    const last = series.length ? series[series.length - 1] : null;
    return {
      name: app.name || null,
      manager: app.manager || "北银理财",
      established: app.established,
      series,
      kind: "nav",
      risk: app.risk,
      benchmark: app.benchmark,
      holdDays: app.holdDays,
      regCode: null, // App 端口无登记编码，交编排层中国理财网兜底
      remainQuota: app.remainQuota != null ? app.remainQuota : null,
      quotaState: app.quotaState || null,
      quotaText: app.quotaText || null,
      currency: app.currency || null,
      source: "live",
      bank: "bob",
      navVia: "bob",
      navPort: "app",
      navViaCode: c,
      navLatest: last ? last[1] : null,
      navLatestDate: last ? last[0] : null,
      infoOnly: series.length < 2,
    };
  }
  // 两边都有：净值序列按日期并集（同日 App 优先）；登记编码/成立日取 Web；额度取 App
  let series = web.series && web.series.length ? web.series.slice() : [];
  let navPort = "web";
  if (appSeries) {
    const byDate = new Map();
    for (const p of series) byDate.set(p[0], p);
    for (const p of appSeries) byDate.set(p[0], p); // App 覆盖同日值
    series = [...byDate.values()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const webLast = web.series && web.series.length ? web.series[web.series.length - 1][0] : null;
    const appLast = appSeries[appSeries.length - 1][0];
    if (!webLast || appLast >= webLast) navPort = "app"; // App 提供最新净值日 → 落 app
  }
  const last = series.length ? series[series.length - 1] : null;
  return {
    ...web,
    name: web.name || app.name,
    manager: web.manager || app.manager,
    risk: web.risk || app.risk,
    benchmark: web.benchmark || app.benchmark,
    holdDays: web.holdDays != null ? web.holdDays : app.holdDays,
    established: web.established || app.established,
    series,
    navPort,
    navVia: "bob",
    navViaCode: c,
    navLatest: last ? last[1] : null,
    navLatestDate: last ? last[0] : null,
    infoOnly: series.length < 2,
    remainQuota: app.remainQuota != null ? app.remainQuota : null,
    quotaState: app.quotaState || null,
    quotaText: app.quotaText || null,
    currency: app.currency || null,
  };
}

export async function bobFetch(code, opts = {}) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;

  // —— 按需单抓架构（2026-10-17 用户规则：额度不进每次刷新的热路径）——
  // 默认热路径：只走 Web 端口（纯 HTTP，秒回，不启动 Chrome，不返回额度）。
  // 显式按需：opts.withQuota === true → 并发跑 app+web 合并（/api/bobapp 调试端点用）。
  // Web 无结果/无全序列（北银代销他行产品，官网查无此码/序列不足，如 132040B）→ fallback
  //   跑一次 app（无头 Chrome，带 10 分钟 TTL 缓存，开机已预热），拿净值序列+信息+额度。
  // 2026-10-22 用户决定：北银无头 Chrome **放行 + 开机预热**，nav / quota 模式同样走该兜底
  //   ——北银代销他行产品的净值/额度只能来自 App 端口；现金管理类（OPEN_TYPE=6）已在
  //   web 侧 _excludedCash 提前返回，不会误触发 Chrome。
  // 2026-10-23 用户审计修复（刷信息/刷额度只抓各自那一类，都不抓净值）：
  //   ① 原 `navOnly = (mode==="nav" || mode==="quota")` 是错的——quota 被当成 nav 处理，
  //      bobWebFetch 只回 navlist（无信息、无额度）→ 北银刷额度恒空，还白抓了净值。
  //      北银额度只在 App 端口（无头 Chrome）上，故 quota 必须走 app 分支。
  //   ② info 原来完全没门控 → 连 navlist 一起抓。现改走 bobWebFetch({infoOnly:true})，只调信息接口。
  if (opts.mode === "info") {
    return await bobWebFetch(c, { ...opts, infoOnly: true }).catch(() => null);
  }
  if (opts.mode === "quota") {
    // 北银 web 端口无额度字段 → 走 App 端口（10 分钟 TTL 缓存），并丢弃序列。
    // 但 App 端口拿不到产品类型（OPEN_TYPE）→ 并发跑一次 web 信息口（纯 HTTP，秒回），
    // 只为判定现金管理类（OPEN_TYPE=6）。与 App 端口并行，不增加墙钟时间（2026-10-23 审计补齐）。
    const [qa, wq] = await Promise.all([
      bobAppFallback(c, opts).catch(() => null),
      bobWebFetch(c, { ...opts, infoOnly: true }).catch(() => null),
    ]);
    if (wq && wq._excludedCash) return { _excludedCash: true, code: c };
    if (!qa) return null;
    return {
      name: qa.name || null,
      manager: qa.manager || "北银理财",
      established: qa.established || null,
      series: [],
      kind: "nav",
      risk: qa.risk, benchmark: qa.benchmark, holdDays: qa.holdDays,
      regCode: null,
      remainQuota: qa.remainQuota != null ? qa.remainQuota : null,
      quotaState: qa.quotaState || null,
      quotaText: qa.quotaText || null,
      currency: qa.currency || null,
      source: "live", bank: "bob", navVia: "bob", navPort: "app", navViaCode: c,
      infoOnly: true,
    };
  }
  const navOnly = opts.mode === "nav";
  const web = await bobWebFetch(c, { ...opts, navOnly }).catch(() => null);
  if (web && web._excludedCash) return { _excludedCash: true, code: c }; // 现金管理类（OPEN_TYPE=6）：透传哨兵给上层识别
  if (opts && opts.withQuota === true) {
    const app = await bobAppFetch(c, opts).catch(() => null);
    return bobMerge(web, app, c);
  }
  if (web && web.series && web.series.length >= 2) return web; // web 有全序列：热路径到此为止
  // web 无/只有 info（封闭净值/代销他行产品）→ app fallback 补净值序列+信息+额度
  // （无头 Chrome 已于 2026-10-22 放行；10 分钟 TTL 缓存防同产品重复跑 Chrome）
  const app = await bobAppFallback(c, opts);
  return bobMerge(web, app, c);
}

/* ==========================================================================
 * 兴业银行（CIB）实时抓取 —— 两条路径
 *
 * ① 兴银理财官网（cibwm.com.cn）：干净 JSON，免登录、免国密握手。
 *      · 净值：POST /api/public/pc/productVal/page（详情页「历史净值」表格同源，数据最新）
 *            body {criteria:{productCode,startDate,endDate},page:{pageNumber,pageSize:100}}
 *            按 netvalDt 倒序、pageSize 上限 100 需翻页；返回 data.list[]：
 *            netvalDt(净值日, "YYYY-MM-DD 00:00:00") / dataDt(披露日) /
 *            effIopv(固收产品=单位净值；现金管理类=万份收益，见下) / effTotNetVal(累计净值或七日年化)
 *            ⚠ 不能用走势图 GET performanceTrend/<code>/ALL 当主接口：它更新慢
 *            （2026-10-22 实测官网已显示 10-21 时它仍缺该点），时间窗参数也被服务端忽略；
 *            仅在 productVal/page 失败时兜底。
 *      · 产品信息：POST /api/public/pc/productInfo/getProdInfoByPage
 *            服务端只在访问 /api/* 时种下 XSRF-TOKEN cookie，需先 warmup。
 *            搜索结果带 productType1（XJL=现金管理类）。
 *      ⚠ 项目规则（2026-10-21 立）：只收录有净值的固收产品；现金管理类（productType1==="XJL"，
 *            或数值特征全序列 0<v<0.95）在 cibFetch 里直接 return null 排除，
 *            历史上的「万份收益复利合成净值」处理已删除，勿再 reintroduce。
 *      适用：兴银理财自营产品（如 9S65005A；用户输入的 Y05A9S65005A 取后缀 8 位）。
 *
 * ② 兴业手机银行（z.cib.com.cn）：国密握手（SM2 协商会话密钥 + SM4-CBC/SM3 报文）。
 *      · GET /app-fin/public/financial/detail?prodCode=<code> 建立会话 cookie
 *      · POST /api/secure/security/cert/apply {certEncoding:MODULE,encModeIndex:3} → pubCert
 *      · SM2 加密会话密钥：plain = "40"+keyString(40)+随机填充(86)，doEncrypt(pc:1)
 *      · POST /api/secure/security/key/handle {key_type:HSM_KEY,key_str,key_id} → formtoken
 *      · POST /api/financing/finProd/finShelf/qryFinSaleDetail {prodCode,custTag:null} → 产品信息
 *      · POST /api/financing/finProd/finShelf/obtainNavList {prodCode,dateScope:4} → finNavList
 *      适用：跨行代销产品（如 民生理财 MSFBAE60334M）。
 *
 * 注意：Worker 运行时无 Buffer（未开 nodejs_compat），base64 用 btoa/atob 处理。
 * ========================================================================== */

const CIBWM_HOST = "https://www.cibwm.com.cn";
const CIB_RET_HOST = "https://z.cib.com.cn";

function cibNormDate(s) {
  if (!s) return null;
  let t = String(s).trim();
  if (t.indexOf(" ") >= 0) t = t.slice(0, t.indexOf(" "));
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const d = t.replace(/[^0-9]/g, "");
  if (d.length === 8) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  return null;
}
function cibRiskToR(t) {
  if (!t) return null;
  const n = String(t).trim();
  if (/^1$/.test(n)) return "R1";
  if (/^2$/.test(n)) return "R2";
  if (/^3$/.test(n)) return "R3";
  if (/^4$/.test(n)) return "R4";
  if (/^5$/.test(n)) return "R5";
  if (/低风险/.test(n)) return "R1";
  if (/中低风险/.test(n)) return "R2";
  if (/中风险/.test(n)) return "R3";
  if (/中高风险/.test(n)) return "R4";
  if (/高风险/.test(n)) return "R5";
  return null;
}
// 十六进制 <-> base64（Worker 无 Buffer，用 btoa/atob）
function cibHexToB64(hex) {
  let s = "";
  for (let i = 0; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
  return btoa(s);
}
function cibB64ToHex(b64) {
  const s = atob(b64);
  let h = "";
  for (let i = 0; i < s.length; i++) h += s.charCodeAt(i).toString(16).padStart(2, "0");
  return h;
}

async function cibwmXsrf(transport) {
  const doFetch = transport || fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await doFetch(CIBWM_HOST + "/api/public/pc/productInfo/getProdInfoByPage", {
      method: "POST",
      headers: { "User-Agent": UA, "Referer": CIBWM_HOST + "/personal-products", "Accept": "application/json", "Content-Type": "application/json;charset=UTF-8" },
      body: JSON.stringify({ page: { pageNumber: 1, pageSize: 1, orders: [{ field: "default", direction: "DESC" }] }, pageFilterCriteria: { preferredTypeKey: ["all"] } }),
      signal: ctrl.signal,
    });
    const sc = res.headers.get("set-cookie");
    const m = sc && sc.match(/XSRF-TOKEN=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  } catch (e) { return ""; } finally { clearTimeout(timer); }
}
async function cibwmPerfTrend(code, tok, transport) {
  const doFetch = transport || fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await doFetch(CIBWM_HOST + `/api/public/pc/productVal/performanceTrend/${encodeURIComponent(code)}/ALL`, {
      headers: { "User-Agent": UA, "Referer": CIBWM_HOST + "/personal-products", "Accept": "application/json", "X-XSRF-TOKEN": tok },
      signal: ctrl.signal,
    });
    const j = await res.json();
    return (j && j.data && j.data.list) || [];
  } catch (e) { return []; } finally { clearTimeout(timer); }
}
// 兴银理财官网「历史净值」列表（详情页净值表格同源接口）。
// ⚠ 2026-10-22 实测（9K41081A）：performanceTrend（走势图）更新慢——当天凌晨官网
//   「最新净值 1.0187 / 历史净值表首行 2026-10-21」已上新，performanceTrend 仍缺该点
//   （停在 10-20，214 点 vs 本接口 215 点，重合点取值完全一致）。官网「最新净值」
//   latestNavPerUnit/latestDisclosureDate 与历史净值表均取自本接口，故以本接口为准，
//   performanceTrend 仅作兜底。按 netvalDt 倒序返回；pageSize 上限 100，需翻页拉全量。
//   公开接口不强制 XSRF（带了也无妨）；timeRange 参数被服务端忽略，各窗口返回相同。
async function cibwmValPage(code, tok, transport, since) {
  const doFetch = transport || fetch;
  const out = [];
  let ok = false;
  // 2026-10-30 增量：DESC（page 1 最新）→ 只留 > since 的点，并在追上 since 的页提前停翻页
  const keepNew = (list) => (list || []).filter((r) => {
    const d = cibNormDate(r && r.netvalDt);
    return d && d > since;
  });
  for (let pn = 1; pn <= 60; pn++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
    let list = [];
    try {
      const res = await doFetch(CIBWM_HOST + "/api/public/pc/productVal/page", {
        method: "POST",
        headers: { "User-Agent": UA, "Referer": CIBWM_HOST + "/personal-products", "Accept": "application/json", "Content-Type": "application/json;charset=UTF-8", "X-XSRF-TOKEN": tok },
        body: JSON.stringify({ criteria: { endDate: "", productCode: code, startDate: "" }, page: { pageNumber: pn, pageSize: 100 } }),
        signal: ctrl.signal,
      });
      const j = await res.json();
      list = (j && j.data && j.data.list) || [];
    } catch (e) { break; } finally { clearTimeout(timer); }
    if (pn === 1 && list.length) ok = true;
    if (since) {
      out.push(...keepNew(list));
      // 页内最旧点已 <= since → 更早的页都是旧数据，不必再翻（日常刷新 page 1 即止）
      let oldest = "";
      for (const r of list) { const d = cibNormDate(r && r.netvalDt); if (d && (!oldest || d < oldest)) oldest = d; }
      if (oldest && oldest <= since) break;
      if (list.length < 100) break;
      continue;
    }
    out.push(...list);
    if (list.length < 100) break;
  }
  // ok=false 表示首页就没数据（抓取失败/产品未收录）；增量腿据此区分「无新增点」与「抓不到」
  return { rows: out, ok };
}
async function cibwmSearch(code, tok, transport) {
  const doFetch = transport || fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await doFetch(CIBWM_HOST + "/api/public/pc/productInfo/getProdInfoByPage", {
      method: "POST",
      headers: { "User-Agent": UA, "Referer": CIBWM_HOST + "/personal-products", "Accept": "application/json", "Content-Type": "application/json;charset=UTF-8", "X-XSRF-TOKEN": tok },
      body: JSON.stringify({ page: { pageNumber: 1, pageSize: 20, orders: [{ field: "default", direction: "DESC" }] }, pageFilterCriteria: { preferredTypeKey: ["all"], fuzzyStr: code } }),
      signal: ctrl.signal,
    });
    const j = await res.json();
    const list = (j && j.data && j.data.list) || [];
    return list.find((p) => p.productCode === code || (p.productName && p.productName.indexOf(code) >= 0)) || list[0] || null;
  } catch (e) { return null; } finally { clearTimeout(timer); }
}

// 零售国密：cookie 罐 + 单次请求
function cibRetailJar() { return {}; }
function cibMergeCookie(jar, header) {
  if (!header) return;
  const parts = Array.isArray(header) ? header : String(header).split(/,(?=[^ ])/);
  for (const c of parts) {
    const p = c.split(";")[0];
    const i = p.indexOf("=");
    if (i > 0) jar[p.slice(0, i).trim()] = p.trim();
  }
}
function cibCookieStr(jar) { return Object.values(jar).join("; "); }
async function cibRetailReq(doFetch, method, path, jar, body, extra) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const headers = Object.assign({
      "User-Agent": UA, "Accept": "application/json, text/plain, */*",
      "Content-Type": "application/json;charset=UTF-8",
      "Referer": CIB_RET_HOST + "/app-fin/public/financial/detail?prodCode=" + encodeURIComponent(CODE_GUARD || "x"),
      "Page-Url": "/public/financial/detail?prodCode=" + encodeURIComponent(CODE_GUARD || "x"),
      "terminal-type": "08", "viewfrom": "1", "channel": "208",
      "reqid": (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Math.random()),
    }, extra || {});
    const ck = cibCookieStr(jar);
    if (ck) headers["Cookie"] = ck;
    const res = await doFetch(CIB_RET_HOST + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
    cibMergeCookie(jar, res.headers.getSetCookie ? res.headers.getSetCookie() : res.headers.get("set-cookie"));
    let text = "";
    try { text = await res.text(); } catch (e) {}
    return { status: res.status, headers: res.headers, body: text };
  } finally { clearTimeout(timer); }
}

// 因 Referer/Page-Url 需要动态 prodCode，用模块级变量传递（cibRetailReq 内读取）
let CODE_GUARD = "x";

export async function cibFetch(code, opts = {}) {
  const transport = opts.transport;
  const doFetch = transport || fetch;
  const CODE = String(code || "").trim().toUpperCase();
  // 2026-10-22 用户规则：信息接口（cibwmSearch / qryFinSaleDetail）不再当「存在性/现金类」闸门——
  // nav 模式直接抓净值，跳过信息接口（现金类已在添加产品 UI 拦截，产品均为真实产品）。
  const __navMode = (opts.mode || "all") === "nav";

  // 【2026-10-23 用户规则】刷信息只刷信息、刷额度只刷额度——两者都不抓净值。
  // 兴业净值走 productVal/page 翻页 + 手机银行 obtainNavList；信息在 cibwmSearch（官网搜索接口）。
  // 兴业无额度接口 → quota 模式零请求返回 null（额度本就无来源，交上层按空处理）。
  if (opts.mode === "quota") return null;
  if (opts.mode === "info") {
    try {
      const tok = await cibwmXsrf(transport);
      const cands = [CODE];
      if (CODE.length > 8) cands.push(CODE.slice(-8));               // Y05A9S65005A -> 9S65005A
      const lead = CODE.replace(/^[A-Za-z]+/, "");
      if (lead && lead !== CODE && CODE.length - lead.length <= 5) cands.push(lead);
      for (const cc of cands) {
        const inf = await cibwmSearch(cc, tok, transport).catch(() => null);
        // 现金管理类（官网权威分类 productType1==="XJL"）→ 项目铁律：信息也不收录。
        // 搜索接口本身就带类型字段，刷信息时零额外请求即可判定（2026-10-23 审计补齐）。
        if (inf && inf.productType1 === "XJL") return { _excludedCash: true, code: CODE };
        if (inf && inf.productName) {
          return {
            name: inf.productName,
            manager: "兴银理财",
            established: null,
            series: [],
            kind: "nav",
            risk: cibRiskToR(inf.riskLevel),
            benchmark: null,
            holdDays: null,
            regCode: null,
            source: "live",
            bank: "cib",
            navPort: "web",
            infoOnly: true,
          };
        }
      }
    } catch (e) { /* 搜索接口异常 → 交编排层中国理财网补信息 */ }
    return null;
  }
  // 端口优先级（用户规则 2026-10-21）：兴业银行「先 web 后 app」。
  //   web = 兴银理财官网 www.cibwm.com.cn（路径①，全量历史净值 + 产品名/风险）
  //   app = 兴业手机银行 z.cib.com.cn 国密接口（路径②，全量净值 + 七字段 + 登记编码/基准/持有天数）
  // 两端口都试，谁先回有效净值就用谁；回写 navPort 让前端「净值来源」显示实际命中的端口
  // （此前 cib 被登记成单端口 app，官网抓到的也一律标 App，与实际不符）。

  // ---- 路径①：兴银理财官网（cibwm）＝ web 端口，优先 ----
  //   净值取「历史净值」列表 POST /api/public/pc/productVal/page（详情页同源、数据最新），
  //   走势图 GET /api/public/pc/productVal/performanceTrend/{code}/ALL 仅兜底（更新慢，实测会缺最新点）。
  try {
    const tok = await cibwmXsrf(transport);
    const cands = [CODE];
    if (CODE.length > 8) cands.push(CODE.slice(-8));                 // Y05A9S65005A -> 9S65005A
    const lead = CODE.replace(/^[A-Za-z]+/, "");
    if (lead && lead !== CODE && CODE.length - lead.length <= 5) cands.push(lead);
    let navList = [], info = null, usedCode = null, __wmOk = false;
    for (const c of cands) {
      // 净值列表：优先详情页同源的 productVal/page（数据最新，含当日凌晨新披露点）；
      // 失败/为空时回退老走势图接口 performanceTrend（更新慢，可能缺最新 1~N 点）。
      // 2026-10-30 增量：opts.since 给定 → 只取新增点；官网命中但本轮无新增点时
      //   不再回退走势图、也不落手机银行全量腿（那会把历史全翻一遍）。
      let nl = await cibwmValPage(c, tok, transport, opts.since);
      let rows = nl.rows;
      if (!rows.length && !nl.ok) {
        rows = await cibwmPerfTrend(c, tok, transport);
        nl.ok = rows.length > 0;
      }
      if (rows.length) { navList = rows; usedCode = c; info = __navMode ? null : await cibwmSearch(c, tok, transport); break; }
      if (opts.since && nl.ok) { usedCode = c; __wmOk = true; break; } // 官网命中、本轮无新增点
    }
    if (navList.length) {
      const raw = [];
      for (const r of navList) {
        const d = cibNormDate(r.netvalDt);
        const v = parseFloat(r.effIopv);
        if (!d || !Number.isFinite(v) || v <= 0) continue;
        raw.push([d, Number(v.toFixed(8))]);
      }
      if (raw.length) {
        raw.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        const ded = [];
        for (const r of raw) { if (ded.length && ded[ded.length - 1][0] === r[0]) ded[ded.length - 1] = r; else ded.push(r); }
        // 【项目规则·2026-10-21 立】本项目只收录「有净值的固收产品」，现金管理类一律不抓。
        // 兴银理财官网对现金管理类（如日日新系列）披露的 effIopv 是【万份收益】（典型值 0.3~0.7）
        // 而非单位净值，早期版本靠 ccbCompound 从 1.0 复利合成净值曲线——该合成逻辑已按项目规则删除，
        // 现金类现在直接排除（返回 null），不再有任何「现金类处理」代码路径。
        // 判定用搜索接口的权威分类 productType1==="XJL"（与 bankscrape 目录口径一致）；
        // 搜索未命中的产品（如跨行代销码）退数值特征：全序列 0<v<0.95 视为万份收益口径，同样排除。
        // ⚠ 数值特征可能被个别异常值带偏（如日日新5号 2025-03 两个 2.x 的点令 every 失效），
        //   故它只用于「排除」，绝不可用于「合成」；productType1 拿得到时以它为准。
        // 2026-10-30 增量：序列仅含新增点，不能作现金类数值判据 → 增量模式跳过（沿用既有分类）。
        if ((info && info.productType1 === "XJL") || (!opts.since && ded.length > 1 && ded.every(([, v]) => v > 0 && v < 0.95))) return { _excludedCash: true, code: CODE };
        const manager = "兴银理财";
        const name = (info && info.productName) || usedCode;
        const risk = cibRiskToR(info && info.riskLevel);
        // ⚠ 成立日一律取首个净值日（latestDisclosureDate 是「最新披露日」不是成立日，误用会把成立日算成今天附近）。
        const established = ded[0][0];
        const holdDays = null; // cibwm 搜索结果无明确持有天数，前端让用户补
        // 走到这里的都是单位净值型固收产品（现金管理类已在上面排除），kind 恒为 "nav"。
        // 【项目规则】不要 reintroduce kind:"wan" 之类的现金类口径标记——现金管理类不抓、不处理。
        return { name, manager, established, series: ded, kind: "nav", risk, benchmark: null, holdDays, regCode: null, source: "live", navPort: "web", navIncremental: !!opts.since };
      }
    } else if (opts.since && __wmOk) {
      // 2026-10-30 增量：官网命中但本轮无新披露点 = 已是最新 → 有效结果（空序列），
      // 不能落到路径② 手机银行腿（那会按全量翻历史，抵消增量收益）。
      return {
        name: usedCode, manager: "兴银理财", established: null,
        series: [], kind: "nav", risk: null, benchmark: null, holdDays: null,
        regCode: null, source: "live", navPort: "web", navIncremental: true,
      };
    }
  } catch (e) { /* cibwm 失败退回零售 */ }

  // ---- 路径②：兴业手机银行（z.cib.com.cn 国密）＝ app 端口，web 无结果才走 ----
  try {
    const jar = cibRetailJar();
    CODE_GUARD = CODE;
    // 1) GET 详情页建立会话 cookie
    await cibRetailReq(doFetch, "GET", "/app-fin/public/financial/detail?prodCode=" + encodeURIComponent(CODE), jar, null, {});
    // 2) cert/apply
    const ca = await cibRetailReq(doFetch, "POST", "/api/secure/security/cert/apply", jar, { certEncoding: "MODULE", encModeIndex: "3" }, {});
    const cj = JSON.parse(ca.body || "{}");
    const pubCert = cj.pubCert || (cj.data && cj.data.pubCert);
    if (!pubCert) return null;
    // 3) 随机会话密钥 + SM2 加密（复刻 hsm.js doHandleEncrypt：明文 = "40"+keyString(40)+随机填充(86)）
    const secret = (crypto && crypto.getRandomValues)
      ? Array.from(crypto.getRandomValues(new Uint8Array(16))).map((b) => b.toString(16).padStart(2, "0")).join("")
      : Array.from({ length: 32 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
    const macWord = (() => { const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"; let s = ""; for (let i = 0; i < 8; i++) s += c[Math.floor(Math.random() * c.length)]; return s; })();
    const keyString = secret + macWord;       // 40 chars
    // 注意：原 sm-crypto 调用带着 {output:"hex", pc:1}，但该版本 doEncrypt 只认 cipherMode，
    // 这两个选项被静默忽略 => 实际就是「标准 C1C3C2、不带 04 前缀」，与下面的调用等价。
    const keyStrEnc = sm2Encrypt(gmU8("40" + keyString + "A".repeat(86)), pubCert);
    const handleId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Math.random());
    const kh = await cibRetailReq(doFetch, "POST", "/api/secure/security/key/handle", jar, { key_type: "HSM_KEY", key_length: "128", key_str: keyStrEnc, key_id: handleId }, { handleid: handleId });
    if (kh.status !== 200 || /会话|密钥/.test(kh.body || "")) return null;
    const formtoken = kh.headers.get ? (kh.headers.get("formtoken") || "") : "";

    const encBody = (obj) => {
      const pb = JSON.stringify(obj);
      const ct = gmSm4CbcEnc(pb, secret, secret);
      return { data: cibHexToB64(ct), mac: gmSm3(pb + macWord) };
    };
    const decBody = (b) => {
      try {
        const j = JSON.parse(b || "{}");
        const b64 = j.data || (j.data && j.data.data);
        if (!b64) return null;
        return gmSm4CbcDec(cibB64ToHex(b64), secret, secret);
      } catch (e) { return null; }
    };

    // 4) 产品信息（2026-10-22：nav 模式跳过该信息接口——不再当「存在性/现金类」闸门，直接抓净值）
    let info = null;
    if (__navMode) {
      info = {}; // 空对象占位：nav 模式信息字段为 null，同时避免下方 info.* 取值崩
    } else {
      const infoReq = await cibRetailReq(doFetch, "POST", "/api/financing/finProd/finShelf/qryFinSaleDetail", jar, encBody({ prodCode: CODE, custTag: null }), {});
      const infoTxt = decBody(infoReq.body);
      if (infoTxt && infoTxt.indexOf("prodInfoDetail") >= 0) {
        try { const o = JSON.parse(infoTxt); info = (o.data && o.data.prodInfoDetail) || null; } catch (e) {}
      }
    }
    // 移除存在性闸门：不再因 info 缺失而 return null——产品不存在即 nav 抓空，交上层兜底

    // 5) 净值（成立以来 dateScope=4）
    const navReq = await cibRetailReq(doFetch, "POST", "/api/financing/finProd/finShelf/obtainNavList", jar, encBody({ prodCode: CODE, dateScope: "4" }), {});
    const navTxt = decBody(navReq.body);
    let finNavList = [];
    if (navTxt) { try { const o = JSON.parse(navTxt); finNavList = (o.data && o.data.finNavList) || []; } catch (e) {} }
    if (!finNavList.length) return null;

    const raw = [];
    for (const r of finNavList) {
      const d = cibNormDate(r.navDate);
      const v = parseFloat(r.unitNav);
      if (!d || !Number.isFinite(v) || v <= 0) continue;
      raw.push([d, Number(v.toFixed(8))]);
    }
    if (!raw.length) return null;
    raw.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const ded = [];
    for (const r of raw) { if (ded.length && ded[ded.length - 1][0] === r[0]) ded[ded.length - 1] = r; else ded.push(r); }

    let manager = "兴银理财";
    const ta = info.taName || info.taNameAbb || "";
    if (/民生/.test(ta)) manager = "民生理财";
    else if (/兴银/.test(ta)) manager = "兴银理财";
    else if (/兴业/.test(ta)) manager = "兴业银行";
    else if (ta) manager = ta.replace(/有限责任公司|有限公司|理财/g, "") || ta;
    const name = info.prodName || CODE;
    const risk = cibRiskToR(info.riskLevel);
    const established = cibNormDate(info.establishDate) || ded[0][0];
    const holdDays = info.cycleValue != null ? Number(info.cycleValue) : null;
    const regCode = info.regCode || info.regCode || null;
    const benchmark = info.resultValue || null;
    return { name, manager, established, series: ded, kind: "nav", risk, benchmark, holdDays, regCode, source: "live", navPort: "app" };
  } catch (e) {
    return null;
  }
}

/* ==========================================================================
 * 宁波银行（NBCB）实时抓取 —— 官网 + 移动端双通道
 *
 * ① 宁银理财官网（www.wmbnb.com）—— 覆盖宁银理财自营产品（如 ZGN2660104A）
 *    反爬：所有 /ningbo-web/* 接口必须带 valid_token cookie
 *          = base64(encodeURIComponent("<毫秒时间戳>-<随机串>-<指纹>"))，否则 403。
 *    接口（均已实测可用）：
 *      GET /ningbo-web/product/search.json?str=<码>
 *          → { status, total, list:[{ projectcode, projectname, projectshortname, id(登记编码),
 *              projectsetupdate(成立日, 毫秒) }] }
 *      GET /ningbo-web/product/funddaytable.json?code=&startdate=&enddate=&request_num=&request_pageno=
 *          → { status, total, list:[{ cdate(毫秒), netvalue, incomeratio, totalnetvalue }], ishb }
 *      日期口径 YYYY-M-D；cdate 为北京时间当日 0 点对应的毫秒。
 *      ishb=true 视为现金管理类（netvalue 为万份收益）——按项目规则直接 return null 排除，不抓不处理。
 *
 * ② 宁波银行个人网银/移动端网关（e.nbcb.com.cn/zhongtai）—— 覆盖跨行代销产品（如 667468WS，招银理财）
 *    网关头：X-GW-BACK-HTTP-METHOD / X_GW_APP_ID / X-GW-NONCE / X-GW-TIME / X-GW-TIME-OFFSET。
 *      GET /zhongtai/finance/prds/p-onsale-channel?prdNameOrCode=&turnPageBeginPos=1&turnPageShowNum=12
 *          → { head:{H_STATUS}, body:{ list:[{ prdCode, prdName, prdNameNew, taName, riskLevel, riskName,
 *              incomeDate(起息日), ipoStartDate, prdDeadlineShow, prdDeadlineSortInt, expectedRateShowName,
 *              bmkMsg }] } }（分页参数必传，缺省返回 -9999）
 *      POST /zhongtai/bfflc/finance/prds-details/finance-page  body {prdCode}
 *          → { head:{H_STATUS}, body:{ netAssetWorth(最新单位净值), issDate(净值日期), estabDate(成立日),
 *              riskLevel/riskName, minHoldDays/prdDeadlineShow, bmkMsg, taName, ... } }
 *          无效代码 H_STATUS=FC1305。该接口只给「最新单点净值」，不含历史序列，
 *          故仅作 app 端口的兜底（主通道见 ③）。
 *
 * ③ 宁波银行【移动端 App 网关】（aapw.nbcb.com.cn/mobilebank/api/split_finance）—— app 端口主通道
 *    报文三段加密 + 响应混淆，详见本节「移动端 App 网关」块的注释。
 *    common/newFinaChart.do → 本行代销/自营产品的**全量历史净值序列**（667468WS 实测 128+ 点）。
 *    bff/finance/product-detail → 元数据 + 剩余额度（limit 元 / percent 已售）。
 * ========================================================================== */

const NBCB_SITE_HOST = "https://www.wmbnb.com";
const NBCB_GW_HOST = "https://e.nbcb.com.cn";
const NBCB_TIMEOUT_MS = 20000;
const NBCB_PAGE_SIZE = 50;
const NBCB_MAX_PAGES = 8;

// 反爬令牌：官网校验 valid_token cookie，格式为 base64(encodeURIComponent("<ts>-<rand>-<fp>"))
function nbcbToken() {
  let rand = "";
  for (let i = 0; i < 24; i++) {
    const c = Math.random().toString(36).charAt(2);
    rand += c || "0";
  }
  const raw = Date.now() + "-" + rand + "-abcdefghijklmnopqrstuvwxyz012345";
  return btoa(encodeURIComponent(raw));
}

// 网关随机 nonce（与官网 SHINE 组件一致的 uuid v4 形态）
function nbcbNonce() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 3) | 8).toString(16);
  });
}

function nbcbDateStr(d) {
  return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
}

// 毫秒 → YYYY-MM-DD（上游按北京时间当日 0 点存储，+8h 后取 UTC 分量即北京时间日期）
function nbcbNormDate(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n + 8 * 3600 * 1000);
  const p = (x) => String(x).padStart(2, "0");
  return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate());
}

// 风险等级：网关给的是 1..5 或中文文案
function nbcbRiskToR(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  const n = Number(s);
  if (Number.isFinite(n) && n >= 1 && n <= 5) return "R" + n;
  if (/中低风险/.test(s)) return "R2";
  if (/中高风险/.test(s)) return "R4";
  if (/高风险/.test(s)) return "R5";
  if (/中风险/.test(s)) return "R3";
  if (/低风险/.test(s)) return "R1";
  return null;
}

// 剩余可购额度（宁波银行移动端网关 prds/p-onsale-channel 的 perUseLimit，单位：元）：
//   >0  → 具体数值(available)，如 12.11 亿；==0 → 已售罄(sold_out)。
// 注：宁银理财官网自营通道(nbcbSelfFetch)不返回该字段，须由移动端网关 prds 列表补齐。
const NBCB_CURRENCY = { "01": "CNY", "156": "CNY", "USD": "USD" };
function nbcbQuota(gw) {
  if (!gw) return null;
  const per = (gw.perUseLimit != null && gw.perUseLimit !== "") ? Number(gw.perUseLimit) : null;
  const status = String(gw.status == null ? "" : gw.status);
  let remainQuota = null, quotaState = null, saleStatus = null;
  if (per != null && Number.isFinite(per)) {
    if (per > 0) { remainQuota = per; quotaState = "available"; }
    else quotaState = "sold_out"; // per<=0（通常为 0）→ 已售罄
  }
  saleStatus = status === "0" ? "ON_SALE" : (status || null);
  const currency = NBCB_CURRENCY[String(gw.currType || "").toUpperCase()] || null;
  return { remainQuota, quotaState, saleStatus, currency };
}

// 最短持有天数：优先「X天」，再判日开/现金管理
function nbcbHoldDays(desc, days) {
  const t = String(desc || "");
  const m = t.match(/(\d+)\s*天/);
  if (m) return Number(m[1]);
  if (/每日开放|日开|现金管理|天天/.test(t)) return 1;
  const d = Number(days);
  if (Number.isFinite(d) && d > 0) return d;
  return null;
}

/* ==========================================================================
 * 宁波银行【移动端 App 网关】(aapw / split_finance) —— app 端口的真实数据源（2026-10-16 打通）
 *
 * 页面：https://aapw.nbcb.com.cn/mobilebank/page/vueArea/financeNew/vVueFinanceNew/finance.html
 * 网关：POST https://aapw.nbcb.com.cn/mobilebank/api/split_finance/<path>
 *
 * 为什么单开一条通道：此前只接 `e.nbcb.com.cn/zhongtai`（个人网银网关），其 finance-page
 * 只回「最新单点净值」，导致 nbcb 的 app 端口被判定为「无历史序列」。实际宁波银行 App/移动端
 * 页面（Vue3 版）走的是 aapw + `common/newFinaChart.do`，**返回全量历史净值序列**，
 * 且覆盖本行代销产品（如 667468WS 招银理财）与自营产品（如 ZGN2613357A 宁银理财）。
 *
 * 报文加密（isMessageEncrypt；明文、错 md5、大写 md5 一律 GW:0302 security.message.decode.fail）：
 *   aesKey = 16 位随机 [0-9A-Za-z]
 *   body   = md5(aesKey + plainJSON)                          // 小写 hex
 *          + '\x1d' + b64(AES-128-CBC(plainJSON, aesKey, iv="SHYTBASESHYTBASE", PKCS7))
 *          + '\x1d' + b64(RSA-PKCS1v1.5(aesKey, 页面证书公钥))
 *   响应 body 为「14 字符混淆头 + hex 密文」，用同一 aesKey 解（见 nbcbAapwUnseal）。
 *
 * 关键接口：
 *   common/newFinaChart.do   {prdCode,startIssDate,endIssDate,sortFlag,rateType,techCode,ifFirst}
 *     → data:[{nav, issDate(YYYYMMDD), totNav, yield, ...}] 全量净值（宁波银行渠道口径；
 *       非本行代销/自营的产品 data 为空 → 天然充当「本行是否销售该产品」的判据）
 *   bff/finance/product-detail {prdCode}
 *     → riskLevel/riskName、estabDate、nowBenchmark、minHoldDays/prdDeadlineShow、taName、
 *       netAssetWorth/issDate、limit(剩余可投 元)、percent(已售%)、currType、status
 * ========================================================================== */
const NBCB_AAPW_HOST = "https://aapw.nbcb.com.cn/mobilebank/api/split_finance/";
const NBCB_AAPW_PAGE =
  "https://aapw.nbcb.com.cn/mobilebank/page/vueArea/financeNew/vVueFinanceNew/finance.html";
// vlib/encrypt.js 里 me.getPublicKey() 证书的 RSA 公钥（模数 / 指数 65537）
const NBCB_RSA_N_HEX =
  "c0069b4ad6b42fed7047a6703d9a40b7212888b06df1ec898ce336eef81ca992585a1b045853faccbd62c9928f8abd1492b6675cc1df46642fb5ba9406f82040cf3e399c9b02ec4ddac684af90be6ea5ecb32e12293b8db44192b14dadb37d44d7ae4f5721ba629dbd23539915ad59994401e62f7a4280eeb6b7eda33514389abd16a91e09d101addb7b69ac4d9ee4c453e359f1af2d6a7ba04d388d14b60f9994a54eeffd4988366e9786d830694ad281a57b25146b6773f98b9b427f333d4633d37ddb265510cf1e278dd3b3379094a7931d56819e2fcbc5b8d089fd999737dadbb67b60837b5eb108f3f43cdb54547a8b30b8cec247e3cea2a920541c6371";
const NBCB_RSA_E = 65537n;
const NBCB_AAPW_KEY_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// 纯 JS MD5（Worker 无 WebCrypto MD5）。网关强校验 md5(aesKey+明文) 的小写十六进制。
const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = new Uint32Array(64);
for (let i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
function md5Hex(input) {
  const src = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const len = src.length;
  const blocks = ((len + 8) >> 6) + 1;
  const total = blocks * 64;
  const buf = new Uint8Array(total);
  buf.set(src);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, (len << 3) >>> 0, true);
  dv.setUint32(total - 4, Math.floor(len / 536870912), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + MD5_K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + (((F << MD5_S[i]) | (F >>> (32 - MD5_S[i]))) >>> 0)) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const hex = (n) => {
    let s = "";
    for (let i = 0; i < 4; i++) s += (((n >>> (i * 8)) & 0xff) + 0x100).toString(16).slice(1);
    return s;
  };
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}

function bytesToHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] + 0x100).toString(16).slice(1);
  return s;
}
function hexToBytes(hex) {
  const h = String(hex);
  const out = new Uint8Array(h.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

// RSA PKCS#1 v1.5 公钥加密（Worker 无 node:crypto，用 BigInt 直接算 m^e mod n）
function rsaPkcs1v15Encrypt(msgBytes, nHex, e) {
  const n = BigInt("0x" + String(nHex).replace(/^0x/i, ""));
  const k = (String(nHex).replace(/^0x/i, "").length + 1) >> 1;
  if (msgBytes.length > k - 11) throw new Error("RSA message too long");
  const psLen = k - msgBytes.length - 3;
  if (psLen < 8) throw new Error("RSA padding too short");
  const em = new Uint8Array(k);
  em[0] = 0x00; em[1] = 0x02;
  for (let i = 0; i < psLen; i++) {
    let b = 0;
    while (b === 0) b = (Math.random() * 256) | 0; // PS 必须非零
    em[2 + i] = b;
  }
  em[2 + psLen] = 0x00;
  em.set(msgBytes, 3 + psLen);
  return bigIntToBytes(modPow(bytesToBigInt(em), e, n), k);
}

// 组装请求体：[md5, aes, rsa].join('\x1d')，返回 { key, body }
async function nbcbAapwSeal(obj) {
  let key = "";
  for (let i = 0; i < 16; i++) key += NBCB_AAPW_KEY_CHARS.charAt((Math.random() * 62) | 0);
  const plain = JSON.stringify(obj);
  const kb = new TextEncoder().encode(key);
  const iv = new TextEncoder().encode("SHYTBASESHYTBASE");
  const ck = await crypto.subtle.importKey("raw", kb, { name: "AES-CBC" }, false, ["encrypt"]);
  const ct = await crypto.subtle.encrypt({ name: "AES-CBC", iv }, ck, new TextEncoder().encode(plain));
  const aes = bytesToB64(new Uint8Array(ct));
  const rsa = bytesToB64(rsaPkcs1v15Encrypt(kb, NBCB_RSA_N_HEX, NBCB_RSA_E));
  return { key, body: [md5Hex(key + plain), aes, rsa].join(String.fromCharCode(29)) };
}

// 响应解封：14 字符头（[3,5)=混淆起点hex [5,7)=混淆长度hex [7,8)=规则hex [8,14)=原文长度hex）+ hex 密文
async function nbcbAapwUnseal(data, key) {
  let enc = String(data);
  const start = parseInt(enc.substring(3, 5), 16);
  const cLen = parseInt(enc.substring(5, 7), 16);
  const rule = parseInt(enc.substring(7, 8), 16);
  const origLen = parseInt(enc.substring(8, 14), 16);
  let body = enc.substring(14);
  const seg = body.substring(start, start + cLen);
  const n = seg.length;
  let merged = body.substring(0, start);
  if (rule === 1) merged += seg.charAt(n - 1) + seg.substring(1, n - 1) + seg.charAt(0);
  else if (rule === 2) {
    for (let j = 2; j <= n; j++) if (j % 2 === 0) merged += seg.charAt(j - 1) + seg.charAt(j - 2);
    if (n % 2 !== 0 && n > 0) merged += seg.charAt(n - 1);
  }
  if (rule !== 0) { merged += body.substring(start + cLen); body = merged; }
  body = body.substring(0, origLen);
  const kb = new TextEncoder().encode(key);
  const iv = new TextEncoder().encode("SHYTBASESHYTBASE");
  const ck = await crypto.subtle.importKey("raw", kb, { name: "AES-CBC" }, false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, ck, hexToBytes(body));
  return new TextDecoder().decode(pt);
}

/**
 * 宁波银行移动端 App 网关 POST：自动加密请求体、解封响应体。
 * 成功返回业务 body 对象（网关 head 非 000000 或解析失败返回 null）。
 */
async function nbcbAapwPost(path, body, transport) {
  const sealed = await nbcbAapwSeal(body || {});
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), NBCB_TIMEOUT_MS);
  try {
    const res = await (transport || fetch)(NBCB_AAPW_HOST + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
        "User-Agent": UA,
        Referer: NBCB_AAPW_PAGE,
        Origin: "https://aapw.nbcb.com.cn",
        "X-GW-APP-ID": "1301",
        "X-GW-NONCE": nbcbNonce(),
        "X-GW-TIME": String(Date.now()),
        "X-GW-TIME-OFFSET": "0",
        "X-GW-SESSION-ID": "ONEAPP_" + nbcbNonce(),
        "X-GW-DATA-ENCRYPT-VERSION": "V3",
        "X-GW-DATA-ENCRYPT-ID": "1301",
        "X-GW-DATA-DIGEST": "",
      },
      body: sealed.body,
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const raw = await res.json();
    if (!raw || !raw.head || raw.head.H_STATUS !== "000000") return null;
    let b = raw.body;
    if (typeof b === "string") {
      const s = b.trim();
      if (s.charAt(0) === "{") { try { b = JSON.parse(s); } catch (e) { return null; } }
      else {
        try { b = JSON.parse(await nbcbAapwUnseal(s, sealed.key)); } catch (e) { return null; }
      }
    }
    if (!b || typeof b !== "object") return null;
    if (b.STATUS != null && String(b.STATUS) !== "1") return null;
    return b;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 北京时间 YYYYMMDD（网关日期口径）
function nbcbYmd(d) {
  const t = new Date((d ? d.getTime() : Date.now()) + 8 * 3600 * 1000);
  const p = (x) => String(x).padStart(2, "0");
  return t.getUTCFullYear() + p(t.getUTCMonth() + 1) + p(t.getUTCDate());
}

/**
 * 移动端 App 网关「历史净值」序列：common/newFinaChart.do
 * 返回 [[YYYY-MM-DD, nav], ...]（升序）。
 *
 * 【2026-10-31 用户实证】这个端点是宁银**唯一覆盖跨行代销**的净值源——
 *   用户手机 H5（aapw.nbcb.com.cn/mobilebank/.../financialDetail?tokenId=667468WS）
 *   能看到净值，而宁银理财官网（www.wmbnb.com 自营通道）只收录**自营**产品，
 *   代销品（如 667468WS 招银理财）在官网 search.json 里 list 为空 → 官网腿返 null。
 *   故 nbcb 的 nav 模式必须走本腿。
 *
 * 增量（since = 本地序列末点）：startIssDate 下推到 since+1（服务端过滤）
 *   + 客户端 d > since 双保险（万一同服务端语义不同）。
 *
 * ⚠ 「0 新增点」与「产品不存在」在本端点**无法区分**（都只回 MSG/STATUS，无 data）。
 *   二者的区分交给调用方用 detail（product-detail）做存在性判定。
 */
async function nbcbAapwNav(code, transport, since) {
  const r = await nbcbAapwNavRaw(code, transport, since);
  return r.series;
}

/**
 * 同 nbcbAapwNav，但额外区分「网关/接口故障」与「接口跑通但 0 点」：
 *   apiOk=false → 网关层失败（连不上 / 解封失败 / head 非 000000）→ 腿失败；
 *   apiOk=true, series=[] → 接口跑通但本区间无数据（0 新增点 或 产品不在架）。
 * 这个区分是增量契约的关键：0 新增点必须算成功（已是最新），而接口故障必须让腿失败，
 * 否则故障会被伪装成「已是最新」而静默跳过真实的新数据。
 */
async function nbcbAapwNavRaw(code, transport, since) {
  const b = await nbcbAapwPost("common/newFinaChart.do", {
    prdCode: code,
    startIssDate: since ? (ymdAdd1(since) || "19700101") : "19700101",
    endIssDate: nbcbYmd(null),
    sortFlag: "1",
    rateType: "4",
    techCode: "TotalReturnCY",
    ifFirst: "1",
  }, transport);
  if (!b) return { apiOk: false, series: [] };        // 网关/解封层失败
  if (!Array.isArray(b.data) || !b.data.length) return { apiOk: true, series: [] };
  const out = [];
  for (const it of b.data) {
    const d = String((it && it.issDate) || "");
    const nav = parseFloat(it && it.nav);
    if (!/^\d{8}$/.test(d) || !Number.isFinite(nav) || nav <= 0) continue;
    const iso = d.slice(0, 4) + "-" + d.slice(4, 6) + "-" + d.slice(6, 8);
    if (since && iso <= since) continue;   // 客户端双保险：只留 since 之后的新增点
    out.push([iso, nav]);
  }
  out.sort((a, b2) => (a[0] < b2[0] ? -1 : a[0] > b2[0] ? 1 : 0));
  return { apiOk: true, series: out };
}

/**
 * 移动端 App 网关产品详情：bff/finance/product-detail
 * 返回元数据 + 额度（limit=剩余可投金额/元、percent=已售比例、currType、status）。
 */
async function nbcbAapwDetail(code, transport) {
  const b = await nbcbAapwPost("bff/finance/product-detail", { prdCode: code }, transport);
  if (!b || !b.prdCode) return null;
  const showLimit = b.showLimitFlag == null ? "" : String(b.showLimitFlag).trim();
  const limit = b.limit == null || b.limit === "" ? null : Number(b.limit);
  const soldPct = b.percent == null || b.percent === "" ? null : parseFloat(String(b.percent));
  let remainQuota = null, quotaState = null, remainQuotaPct = null;
  if (showLimit) quotaState = "available"; // 页面口径：>500万，不给具体数
  else if (limit != null && Number.isFinite(limit)) {
    if (limit > 0) { remainQuota = limit; quotaState = "available"; }
    else quotaState = "sold_out";
  }
  if (soldPct != null && Number.isFinite(soldPct)) remainQuotaPct = Math.max(0, Math.min(100, 100 - soldPct));
  // 注意：新网关 product-detail 的 status 与旧网关 e.nbcb.com.cn 相反 —— 此处 status=1 为在售、0 为停售/售罄
  // （667468WS 已售罄 → 0；ZGN2613357A 有剩余额度 → 1）。
  const sv = b.status == null ? null : String(b.status);
  const saleStatus = sv === "1" ? "ON_SALE" : (sv === "0" ? "OFF_SALE" : sv);
  const nav = parseFloat(b.netAssetWorth);
  return {
    name: b.prdNameNew || b.prdName || null,
    manager: b.taName ? inferManager(b.taName) || b.taName : null,
    risk: nbcbRiskToR(b.riskLevel != null && b.riskLevel !== "" ? b.riskLevel : b.riskName),
    benchmark: b.nowBenchmark || b.bmkMsg || null,
    holdDays: nbcbHoldDays(b.prdDeadlineShow, b.minHoldDays != null ? b.minHoldDays : b.prdDeadlineSortInt),
    established: /^\d{4}-\d{2}-\d{2}$/.test(String(b.estabDate || "")) ? String(b.estabDate) : null,
    nav: Number.isFinite(nav) && nav > 0 ? nav : null,
    navDate: /^\d{4}-\d{2}-\d{2}$/.test(String(b.issDate || "")) ? String(b.issDate) : null,
    remainQuota, remainQuotaPct, quotaState, saleStatus,
    currency: NBCB_CURRENCY[String(b.currType || "").toUpperCase()] || null,
  };
}

// 官网 GET（带 valid_token），失败返回 null
async function nbcbSiteGet(path, params, transport) {
  const qs = Object.entries(params).map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), NBCB_TIMEOUT_MS);
  try {
    const res = await (transport || fetch)(NBCB_SITE_HOST + path + "?" + qs, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        Referer: NBCB_SITE_HOST + "/product/index.html",
        Cookie: "valid_token=" + nbcbToken(),
      },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 移动端网关 GET，失败返回 null
async function nbcbGwGet(path, params, transport) {
  const qs = Object.entries(params).map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), NBCB_TIMEOUT_MS);
  try {
    const res = await (transport || fetch)(NBCB_GW_HOST + "/zhongtai/" + path + "?" + qs, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json, text/plain, */*",
        Referer: NBCB_GW_HOST + "/nebank/?start=EXTWB03&extWealth=1",
        "X-GW-BACK-HTTP-METHOD": "GET",
        X_GW_APP_ID: "1101",
        "X-GW-NONCE": nbcbNonce(),
        "X-GW-TIME": String(Date.now()),
        "X-GW-TIME-OFFSET": "0",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 移动端网关 POST（JSON body），失败返回 null。finance-page 等详情接口只认 POST。
async function nbcbGwPost(path, body, transport) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), NBCB_TIMEOUT_MS);
  try {
    const res = await (transport || fetch)(NBCB_GW_HOST + "/zhongtai/" + path, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json",
        Referer: NBCB_GW_HOST + "/nebank/?start=EXTWB03&extWealth=1",
        "X-GW-BACK-HTTP-METHOD": "POST",
        X_GW_APP_ID: "1101",
        "X-GW-NONCE": nbcbNonce(),
        "X-GW-TIME": String(Date.now()),
        "X-GW-TIME-OFFSET": "0",
      },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 移动端网关「产品详情」POST（bfflc/finance/prds-details/finance-page）：
 * 返回最新单位净值 netAssetWorth + 净值日期 issDate，以及成立日 estabDate、
 * 风险等级 riskLevel/riskName、最短持有期 minHoldDays/prdDeadlineShow、业绩基准 bmkMsg、管理人 taName。
 * 这是跨行代销产品在「发行方目录未收录」时的兜底净值来源（单点净值）。
 * 无效代码返回 H_STATUS=FC1305，故必须校验 H_STATUS 与 prdCode 回显。
 */
async function nbcbGwDetail(code, transport) {
  const j = await nbcbGwPost("bfflc/finance/prds-details/finance-page", { prdCode: code }, transport);
  if (!j || !j.head || j.head.H_STATUS !== "000000" || !j.body) return null;
  const b = j.body;
  const echo = String(b.prdCode || "").toUpperCase();
  if (!b.prdName || (echo && echo !== code)) return null;
  return b;
}

// finance-page 详情 → 统一产品结构（净值序列最多为最新单点）
function nbcbDetailToProduct(b, code) {
  const name = b.prdName || b.prdNameNew || null;
  const manager = b.taName ? inferManager(b.taName) || b.taName : inferManager(name);
  const nav = parseFloat(b.netAssetWorth);
  const navDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.issDate || "")) ? String(b.issDate) : null;
  const series = Number.isFinite(nav) && nav > 0 && navDate ? [[navDate, nav]] : [];
  const established = /^\d{4}-\d{2}-\d{2}$/.test(String(b.estabDate || ""))
    ? String(b.estabDate)
    : series.length
      ? series[0][0]
      : null;
  return {
    name,
    manager,
    established,
    series,
    kind: "nav",
    risk: nbcbRiskToR(b.riskLevel != null && b.riskLevel !== "" ? b.riskLevel : b.riskName),
    benchmark: b.bmkMsg || b.nowBenchmark || null,
    holdDays: nbcbHoldDays(b.prdDeadlineShow, b.minHoldDays != null ? b.minHoldDays : b.prdDeadlineSortInt),
    singlePoint: series.length === 1,
    infoOnly: series.length === 0,
    source: "live",
    bank: "nbcb",
  };
}

// 官网通道：宁银理财自营产品 → 产品信息 + 完整净值序列
async function nbcbSelfFetch(code, transport) {
  const s = await nbcbSiteGet("/ningbo-web/product/search.json", { str: code }, transport);
  const list = s && s.status === "success" && Array.isArray(s.list) ? s.list : [];
  const hit = list.find((x) => String(x.projectcode || "").toUpperCase() === code) || list[0];
  if (!hit) return null;

  const end = new Date();
  const start = new Date(end.getTime() - 3650 * 24 * 3600 * 1000);
  const startStr = nbcbDateStr(start);
  const endStr = nbcbDateStr(end);

  const raw = [];
  let total = 0;
  for (let page = 1; page <= NBCB_MAX_PAGES; page++) {
    const t = await nbcbSiteGet(
      "/ningbo-web/product/funddaytable.json",
      { code, startdate: startStr, enddate: endStr, request_num: NBCB_PAGE_SIZE, request_pageno: page },
      transport
    );
    if (!t || t.status !== "success" || !Array.isArray(t.list) || !t.list.length) break;
    total = Number(t.total) || 0;
    // 【项目规则 2026-10-21 立】ishb=true 即现金管理类（netvalue 实为万份收益）→ 一律排除。
    // 历史上的「按万份收益复利合成单位净值 + kind:"wan"」处理已删除，勿再 reintroduce。
    if (t.ishb) return null;
    for (const r of t.list) {
      const d = nbcbNormDate(r.cdate);
      const v = parseFloat(r.netvalue);
      if (!d || !Number.isFinite(v)) continue;
      raw.push([d, v]);
    }
    if (raw.length >= total) break;
  }
  if (!raw.length) return null;

  raw.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const ded = [];
  for (const r of raw) {
    if (ded.length && ded[ded.length - 1][0] === r[0]) ded[ded.length - 1] = r;
    else ded.push(r);
  }

  const series = ded;
  if (!series.length) return null;

  const name = hit.projectname || hit.projectshortname || null;
  const manager = hit.trustmanager ? inferManager(hit.trustmanager) || hit.trustmanager : inferManager(name);
  return {
    name,
    manager,
    established: nbcbNormDate(hit.projectsetupdate) || series[0][0],
    establishedFromSeries: !nbcbNormDate(hit.projectsetupdate), // projectsetupdate（产品设立更新日）缺位时退序列首点
    series,
    kind: "nav", // 现金管理类（ishb）已排除，走到这里的都是单位净值型固收产品
    risk: null,
    benchmark: null,
    holdDays: nbcbHoldDays(name, null),
    regCode: hit.id || null,
    source: "live",
    bank: "nbcb",
  };
}

// 移动端网关通道：跨行代销产品 → 产品信息（无净值序列，infoOnly）
async function nbcbGwInfo(code, transport) {
  // 该接口强制要求分页参数 turnPageBeginPos / turnPageShowNum，缺省会返回 -9999
  const j = await nbcbGwGet(
    "finance/prds/p-onsale-channel",
    { prdNameOrCode: code, turnPageBeginPos: 1, turnPageShowNum: 12 },
    transport
  );
  if (!j || !j.head || j.head.H_STATUS !== "000000" || !j.body) return null;
  const list = Array.isArray(j.body.list) ? j.body.list : [];
  const it = list.find((x) => String(x.prdCode || "").toUpperCase() === code) || list[0];
  if (!it) return null;

  const name = it.prdName || it.prdNameNew || null;
  const manager = it.taName ? inferManager(it.taName) || it.taName : inferManager(name);
  return {
    name,
    manager,
    established: it.incomeDate || it.ipoStartDate || null,
    series: [],
    kind: "nav",
    risk: nbcbRiskToR(it.riskLevel != null && it.riskLevel !== "" ? it.riskLevel : it.riskName),
    benchmark: it.bmkMsg || it.expectedRateShowName || null,
    holdDays: nbcbHoldDays(it.prdDeadlineShow, it.prdDeadlineSortInt),
    regCode: null,
    infoOnly: true,
    source: "live",
    bank: "nbcb",
    // 剩余额度：网关 prds 列表 perUseLimit（个人单户剩余可购，元；>0 数值，==0 已售罄）
    ...nbcbQuota(it),
  };
}

/**
 * 网关代销产品名形如「招银理财 | 招睿增鑫90天持有期8号增强型固收类理财计划」：
 * 取竖线后的产品名、剥掉发行机构前缀，避免把机构名与分隔符带进检索关键字
 * （否则招行目录按关键字检索会直接落空）。
 */
function nbcbSaleName(info) {
  let s = String((info && info.name) || "").trim();
  if (s.indexOf("|") >= 0) {
    const parts = s.split("|").map((x) => x.trim()).filter(Boolean);
    if (parts.length > 1) s = parts[parts.length - 1];
  }
  const mgr = String((info && info.manager) || "").trim();
  if (mgr && s.indexOf(mgr) === 0) s = s.slice(mgr.length).trim();
  return s;
}

/**
 * 代销产品的发行方路由：按产品名称到招行理财超市目录检索，命中即返回该目录条目。
 *
 * 为什么走招行目录：宁银理财官网只收录自营产品，跨行代销产品（如招银/浦银/建信/兴银/
 * 光大/农银理财等）在宁银官网拿不到净值；而招行 cfweb 目录有 7000+ 只、恰好覆盖这些
 * 发行方，且其净值序列可直接取用。与浦发 spdbFetch 用的是同一条发行方路由。
 *
 * 只认「发行机构前缀 + 数字签名」双重校验，避免把「30天持有期12号」错配到「13号」。
 */
async function nbcbFindInCmb(info, transport) {
  let kw = spdbBaseName(nbcbSaleName(info));
  if (!kw) return null;
  const wantDigits = spdbDigits(kw);
  const issuer = String((info && info.manager) || "")
    .replace(/(有限责任公司|有限公司|股份)$/gu, "")
    .trim();
  for (let guard = 0; guard < 12 && kw.length >= 4; guard++) {
    const list = await cmbSearchByKeyword(kw, transport).catch(() => []);
    if (list.length) {
      let best = null;
      for (const it of list) {
        const nm = String(it.prdName || "");
        if (!nm || !it.prdCode) continue;
        if (issuer && nm.indexOf(issuer) === -1) continue;
        if (wantDigits && spdbDigits(nm) !== wantDigits) continue;
        // 有多只同名期号时，取名称最短的（最贴近主份额）
        if (!best || nm.length < String(best.prdName || "").length) best = it;
      }
      if (best) return best;
    }
    kw = kw.slice(0, -1);
    // 数字（期号/持有期）已被削光，再缩短只会降低精度 → 停
    if (wantDigits && !spdbDigits(kw)) break;
  }
  return null;
}

/**
 * 代销产品净值补全（两级兜底）：
 *   ① 发行方路由：按产品名到招行理财超市目录检索命中 → 取完整净值序列（最优）。
 *   ② 网关兜底：目录未收录时，用宁波银行移动端网关详情接口的最新单位净值构造单点序列，
 *      保证代销产品至少有一个可用净值点，而不是完全空白。
 */
async function nbcbEnrichViaIssuer(gw, code, transport) {
  if (!gw || !gw.infoOnly) return gw;
  // 「只走 3 家」规则（2026-10-15）：不再经招行目录路由(cmbFetch)补净值；代销阶段缺口
  // 由编排层中国理财网兜底覆盖。此处仅用宁波银行移动端网关详情接口补最新单点净值与元数据。
  // ② 网关兜底（最新单点净值 + 缺失元数据补齐）
  const b = await nbcbGwDetail(code, transport).catch(() => null);
  if (b) {
    const d = nbcbDetailToProduct(b, code);
    if (!gw.risk && d.risk) gw.risk = d.risk;
    if (!gw.benchmark && d.benchmark) gw.benchmark = d.benchmark;
    if (gw.holdDays == null && d.holdDays != null) gw.holdDays = d.holdDays;
    if (!gw.established && d.established) gw.established = d.established;
    if (d.series.length) {
      gw.series = d.series;
      gw.kind = "nav";
      gw.infoOnly = false;
      gw.singlePoint = true;
      gw.navVia = "nbcb-gw";
    }
  }
  return gw;
}

// APP 端口（宁波银行移动端）：
//   ① 主通道（2026-10-16 起）：aapw / split_finance 的 newFinaChart.do，**全量历史净值序列**，
//      元数据/额度取同端的 product-detail。命中即返回 navPort=app 的完整序列。
//   ② 兜底：e.nbcb.com.cn/zhongtai 个人网银网关（只回最新单点净值 + 元数据），
//      仅当主通道无序列（如产品非宁波银行销售、或网关暂时异常）时使用。
async function nbcbAppFetch(code, transport, noNav = false) {
  const [series, det] = await Promise.all([
    noNav ? Promise.resolve(null) : nbcbAapwNav(code, transport).catch(() => null),
    nbcbAapwDetail(code, transport).catch(() => null),
  ]);
  // 【2026-10-23 用户规则】刷信息只刷信息、刷额度只刷额度——两者都不抓净值。
  // 宁波银行 App 端口：nbcbAapwDetail（信息+额度）与 nbcbAapwNav（全量净值）是两个接口，
  // noNav=true 时只调详情；下方个人网银网关兜底（nbcbGwInfo/nbcbEnrichViaIssuer）也属净值链路，一并跳过。
  if (noNav) {
    if (!det) return null;
    return {
      name: det.name || null,
      manager: det.manager || inferManager(det.name || "") || null,
      risk: det.risk || null,
      benchmark: det.benchmark || null,
      holdDays: det.holdDays != null ? det.holdDays : null,
      established: det.established || null,
      establishedFromSeries: false,
      series: [],
      kind: "nav",
      bank: "nbcb",
      navVia: "nbcb",
      navPort: "app",
      remainQuota: det.remainQuota != null ? det.remainQuota : null,
      remainQuotaPct: det.remainQuotaPct != null ? det.remainQuotaPct : null,
      quotaState: det.quotaState || null,
      saleStatus: det.saleStatus || null,
      currency: det.currency || null,
      infoOnly: true,
    };
  }
  if (series && series.length >= 2) {
    // 与页面「成立以来」口径对齐：以成立日为首（募集期的 1.0000 期初点剔除，除非成立日缺失）
    let use = series;
    if (det && det.established) {
      const f = series.filter((p) => p[0] >= det.established);
      if (f.length >= 2) use = f;
    }
    const last = use[use.length - 1];
    return {
      name: (det && det.name) || null,
      manager: (det && det.manager) || inferManager((det && det.name) || "") || null,
      risk: (det && det.risk) || null,
      benchmark: (det && det.benchmark) || null,
      holdDays: det ? det.holdDays : null,
      established: (det && det.established) || use[0][0],
      establishedFromSeries: !(det && det.established), // 详情口无成立日时退序列首点
      series: use,
      kind: "nav",
      bank: "nbcb",
      navVia: "nbcb",
      navPort: "app",
      navDate: last[0],
      remainQuota: det ? det.remainQuota : null,
      remainQuotaPct: det ? det.remainQuotaPct : null,
      quotaState: det ? det.quotaState : null,
      saleStatus: det ? det.saleStatus : null,
      currency: det ? det.currency : null,
    };
  }
  // ② 个人网银网关兜底（最新单点）
  const gw = await nbcbGwInfo(code, transport);
  if (!gw) return null;
  const routed = await nbcbEnrichViaIssuer(gw, code, transport); // 网关详情补最新单点净值 + 缺失元数据
  if (!routed) return null;
  routed.navPort = "app";
  return routed;
}

/**
 * 【2026-10-31 新增】宁银 nav 模式专用 App 腿。
 *
 * 为什么单独开一条腿（不能直接复用 nbcbAppFetch）：
 *   ① nbcbAppFetch 是「全量模式」的实现——它会顺带跑 product-detail 拿额度/元数据，
 *      且「全量」语义下不认 since。而 nav 模式按项目规则只该抓净值序列。
 *   ② nbcbAppFetch 的兜底链（个人网银网关 nbcbGwInfo → 招行目录路由）在 nav 模式里
 *      既慢又会带回别人家的份额口径。
 *   ③ 【核心】宁银理财官网（www.wmbnb.com）**只收录自营产品**：代销品（如 667468WS
 *      招银理财代销、用户手机 H5 可查净值）在官网 search.json 里 list 为空 → 官网腿返 null。
 *      原实现 nav 模式**只走官网腿**（2026-10-22「nav 模式只抓净值→直接走 web」），
 *      于是代销品整条腿失败 → 回落中国理财网 → 本机 IP 被风控 → 抓不到。
 *      移动端 App 网关（aapw）才是覆盖代销的源，本腿即该通道。
 *
 * 增量契约（2026-10-30）：
 *   - since 存在 → startIssDate 下推到 since+1 + 客户端 d>since 双保险，只回新增点；
 *   - 本轮 0 新增点（= 已是最新）必须算成功 → 带 navIncremental:true，禁止回落全量源。
 *     ⚠ chart 端点对「0 新增点」与「产品不存在」返回同样的结构（只有 MSG/STATUS），
 *       故用 product-detail（对不在宁银货架的产品返 null）做存在性判定：
 *       detail 返 null = 该产品根本不在宁银货架 → 腿失败（交编排层兜底）；
 *       detail 有值 = 产品在架，只是本轮没出新点 → 0 新增点 = 已是最新（成功）。
 *
 * 现金管理类（项目铁律：不收录）：整段恒 1 → 返 _excludedCash 哨兵。
 */
async function nbcbAppNavLeg(code, transport, since) {
  const [raw, det] = await Promise.all([
    nbcbAapwNavRaw(code, transport, since).catch(() => ({ apiOk: false, series: [] })),
    nbcbAapwDetail(code, transport).catch(() => null),
  ]);
  const series = raw.series || [];
  // 产品不在宁银货架（detail 对非货架产品恒返 null）→ 腿失败，交编排层继续找下一源。
  // ⚠ 不能靠 chart 判断：它对「0 新增点」与「产品不存在」返回完全相同的结构。
  if (!det) return null;
  // 网关/解封层故障（连不上、head 非 000000）→ 腿失败。
  // ⚠ 必须与「0 新增点」区分：把故障伪装成「已是最新」会静默跳过真实的新数据。
  if (!raw.apiOk) return null;
  // 现金管理类：单位净值整段恒 1（万份收益口径的产品 nav 恒 1）→ 排除。
  if (series && series.length && series.every((p) => Math.abs(p[1] - 1) < 1e-4)) {
    return { _excludedCash: true, code, bank: "nbcb", navVia: "nbcb", navPort: "app" };
  }
  // 有序列 → 采用（口径与「成立以来」对齐：以成立日为首，募集期的 1.0000 期初点剔除）
  if (series && series.length >= 2) {
    let use = series;
    if (det.established) {
      const f = series.filter((p) => p[0] >= det.established);
      if (f.length >= 2) use = f;
    }
    const last = use[use.length - 1];
    return {
      name: det.name || null,
      manager: det.manager || inferManager(det.name || "") || null,
      established: det.established || use[0][0],
      establishedFromSeries: !det.established,
      series: use,
      kind: "nav",
      bank: "nbcb",
      navVia: "nbcb",
      navPort: "app",
      navDate: last[0],
      // 增量模式：本轮只回 since 之后的新增点（0 点也是合法结果=已是最新）
      navIncremental: !!since,
    };
  }
  // 0 新增点：detail 证明产品在架 → 已是最新（成功），带 navIncremental 禁止回落全量源。
  if (since) {
    return {
      name: det.name || null,
      manager: det.manager || inferManager(det.name || "") || null,
      established: det.established || null,
      establishedFromSeries: !det.established,
      series: [],
      kind: "nav",
      bank: "nbcb",
      navVia: "nbcb",
      navPort: "app",
      navIncremental: true,
    };
  }
  // 全量模式且真的没数据 → 腿失败
  return null;
}

// WEB 端口（宁银理财官网）：自营产品完整历史净值序列。navPort=web。
async function nbcbWebFetch(code, transport) {
  const self = await nbcbSelfFetch(code, transport);
  if (!self) return null;
  self.navPort = "web";
  return self;
}

// 双端口级联（用户规则 2026-10-15：先 app，后 web）：
//   ① 先试 APP 端口（移动端网关）——若其返回完整序列(series>=2)则直接采用（未来接入网关历史净值端点即生效）；
//   ② 否则试 WEB 端口（官网）取自营完整序列；WEB 缺失的风险/基准/剩余额度由 APP 网关补齐（同属宁波银行官方数据）；
//   ③ 两端都无完整序列：返回 APP 端口的 infoOnly/单点结果作最弱兜底（仍带 navPort=app），交由编排层中国理财网兜底覆盖。
export async function nbcbFetch(code, opts = {}) {
  const transport = opts.transport;
  const c = (code || "").trim().toUpperCase();
  if (!c) return null;
  const since = opts.since || null;
  // 2026-10-22 修复：nav 模式只抓净值 → 直接走 web（宁银理财官网 nbcbSelfFetch，纯净值序列），
  // 跳过 App 端口（nbcbAppFetch 会顺带回产品信息/额度，属分解杂项）。web 失败由编排层中国理财网兜底。
  //
  // 【2026-10-31 修正】上面那条规则有个致命漏洞：**宁银理财官网只收录自营产品**，
  //   跨行代销品（如 667468WS 招银理财代销）官网 search.json 里 list 为空 → 官网腿恒 null
  //   → 代销品在 nav 模式永远抓不到 → 回落中国理财网（本机 IP 被风控 → 42s 超时 → 60s 预算爆掉）。
  //   而用户手机 H5（aapw.nbcb.com.cn/.../financialDetail?tokenId=667468WS）**能看到净值**
  //   —— 说明移动端 App 网关才是覆盖代销的源。
  //   故 nav 模式改为**双腿并发**：App 腿（nbcbAppNavLeg，覆盖自营+代销、纯净值、支持增量）
  //   与官网腿（自营产品）同时跑，谁先给出有效序列用谁；App 腿空且官网腿空才算失败。
  if (opts.mode === "nav") {
    const [app, web] = await Promise.all([
      nbcbAppNavLeg(c, transport, since).catch(() => null),
      nbcbWebFetch(c, transport).catch(() => null),
    ]);
    // ① App 腿优先：它同时覆盖自营与代销，且**比官网腿更完整**（实测 ZGN2660104A：
    //    App 腿 110 点 vs 官网腿只有 86 点——官网 funddaytable 少了 24 个中间日期），
    //    又是用户手机 H5 同款口径 → 主源。
    if (app && !app._excludedCash) {
      if (app.series && app.series.length >= 2) return app;   // 有序列
      if (app.navIncremental) return app;                      // 0 新增点 = 已是最新（成功）
      // ⚠ 不可在此回落官网腿：官网腿不支持增量、会返回**全量**历史 → 正是「0 点回落陷阱」
      //   （增量收益归零、白翻全量页）。App 腿失败才轮到官网腿。
    }
    // ② 官网腿兜底（只覆盖自营产品；增量模式下同样只回 since 之后的新增点）
    if (web && web.series && web.series.length >= 2) {
      if (since) {
        const f = web.series.filter((p) => p[0] > since);
        if (f.length) return Object.assign({}, web, { series: f, navIncremental: true });
        return Object.assign({}, web, { series: [], navIncremental: true });  // 官网腿也无新点 = 已是最新
      }
      return web;
    }
    // ③ 现金类哨兵优先于一切（项目铁律：不收录现金管理类）
    if (app && app._excludedCash) return app;
    return null;
  }
  // 【2026-10-23 用户规则】刷信息只刷信息、刷额度只刷额度——两者都不抓净值：
  // 只走 App 端口的详情接口（nbcbAapwDetail 回信息 + 额度），不碰净值序列与官网 web 端口。
  if (opts.mode === "info" || opts.mode === "quota") {
    return (await nbcbAppFetch(c, transport, true)) || null;
  }

  const app = await nbcbAppFetch(c, transport);
  if (app && app.series && app.series.length >= 2) return app; // 命中 app 完整序列

  const web = await nbcbWebFetch(c, transport);
  if (web) {
    // web（官网）缺失的风险/基准/额度，由 app（移动端网关）补齐（仅在确有缺项时覆盖）
    if (app) {
      if (!web.risk && app.risk) web.risk = app.risk;
      if (!web.benchmark && app.benchmark) web.benchmark = app.benchmark;
      if (web.holdDays == null && app.holdDays != null) web.holdDays = app.holdDays;
      if (web.remainQuota == null && (app.remainQuota != null || app.quotaState != null)) {
        web.remainQuota = app.remainQuota;
        web.quotaState = app.quotaState;
        web.saleStatus = app.saleStatus;
        web.currency = app.currency;
      }
    }
    return web;
  }
  // 两端都无完整序列：返回 app 端口（infoOnly/单点）兜底，navPort=app 已置
  if (app) return app;
  return null;
}


// ==========================================================================
// 销售代码 -> 抓取银行顺序预判（Worker 版，纯函数；规则从 RULES_JSON_URL 拉取并缓存）
// 与本地 serve.mjs 用的 predict_bank.js（端口自 predict_银行.py v4）保持同口径，
// 前端据此把「查询」改成多银行有序尝试：预判发行行 → 下拉框代销行 → 预判其它发行行
// → 预判其它代销行 → 剩余行。规则 JSON 由本地 serve.mjs 同款（销售代码-预判规则.json）提供。
// ==========================================================================
// 部署时把下面的 URL 改成规则 JSON 的可访问地址（如 GitHub Pages 上的 销售代码-预判规则.json）；
// 留空则 /api/predict 返回 503，前端自动回退为「仅查下拉框所选银行」（与改造前一致，无回归）。
// 现指向 Pages 上的 predict-rules.json —— 与仓库根目录 predict_bank.js 读的是同一份 v4 规则，
// 保证「本地预判顺序」与「线上预判顺序」完全一致（此前留空 → 线上 /api/predict 恒 503，
// 线上只查下拉框单家，与本地多银行有序尝试不一致）。
// 用 ASCII 文件名是为避开中文路径在 URL 中的百分号编码差异。
const RULES_JSON_URL = "https://lclist.github.io/predict-rules.json";
let _rulesCache = null;
let _rulesLoading = null;
async function loadRules() {
  if (_rulesCache) return _rulesCache;
  if (!RULES_JSON_URL) return null;
  if (!_rulesLoading) {
    _rulesLoading = (async () => {
      const r = await fetch(RULES_JSON_URL);
      if (!r.ok) throw new Error("rules http " + r.status);
      _rulesCache = await r.json();
      return _rulesCache;
    })();
  }
  return _rulesLoading;
}
function _parseRules(rdict) {
  const out = {};
  for (const k in rdict) {
    const t = k.slice(0, k.indexOf(":"));
    const val = k.slice(k.indexOf(":") + 1);
    const v = rdict[k];
    out[t + " " + val] = [v.value, v.purity != null ? v.purity : 1.0, v.support != null ? v.support : 0];
  }
  return out;
}
function _spec(f) {
  const t = f[0], v = f[1];
  let base = v.length;
  if (t === "LP" || t === "LS") base += 3;
  else if (t === "D3") base += 2;
  else if (t === "D") base += 1;
  return base;
}
function _feats(code, maxp, maxs) {
  const c = (code || "").trim().toUpperCase();
  const L = String(c.length);
  const out = [];
  for (let k = 1; k <= Math.min(maxp, c.length); k++) out.push(["P", c.slice(0, k)]);
  for (let k = 1; k <= Math.min(maxs, c.length); k++) out.push(["S", c.slice(c.length - k)]);
  if (/^\d+$/.test(c)) {
    out.push(["D", c.length + "-" + c.slice(0, 2)]);
    out.push(["D3", c.length + "-" + c.slice(0, 3)]);
    out.push(["DL", String(c.length)]);
  }
  for (let k = 1; k <= Math.min(maxp, c.length); k++) out.push(["LP", L + ":" + c.slice(0, k)]);
  for (let k = 1; k <= Math.min(maxs, c.length); k++) out.push(["LS", L + ":" + c.slice(c.length - k)]);
  return out;
}
function _best(code, rmap, maxp, maxs) {
  const cands = [];
  for (const f of _feats(code, maxp, maxs)) {
    const key = f[0] + " " + f[1];
    if (rmap[key]) {
      const [v, p, s] = rmap[key];
      cands.push([_spec(f), p, s, v]);
    }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]);
  return cands[0][3];
}
function _matchManual(m, code) {
  const c = (code || "").trim().toUpperCase();
  const mc = m.match || {};
  if (mc.regex && !new RegExp(mc.regex).test(c)) return false;
  if (mc.lengths && mc.lengths.indexOf(c.length) < 0) return false;
  if (mc.prefix && !c.startsWith(mc.prefix)) return false;
  const at = mc.at;
  if (at) {
    const pos = at.pos;
    if (c.length <= pos) return false;
    const ch = c[pos];
    if (at.kind === "alpha" && !/[A-Za-z]/.test(ch)) return false;
    if (at.kind === "digit" && !/\d/.test(ch)) return false;
  }
  return true;
}
function _hitManual(code, manual) {
  for (const m of manual) if (_matchManual(m, code)) return m;
  return null;
}
async function predictBanksWorker(code) {
  const d = await loadRules();
  if (!d) return null;
  const mr = _parseRules(d.manager_rules);
  const ar = _parseRules(d.agent_rules);
  const m2p = d.manager_to_parent_key;
  const a2k = d.agent_to_key;
  const mta = d.manager_top_agents || {};
  const fs = d.feature_space || {};
  const manual = d.manual_rules || [];
  const mfa = d.manager_fallback_agents || {};
  const gpo = d.global_probe_order || [];
  const maxp = (fs.prefix_max_len || 8), maxs = (fs.suffix_max_len || 4);
  const mm = _hitManual(code, manual);
  let p;
  if (mm) {
    const mg = mm.manager || _best(code, mr, maxp, maxs);
    let ags = (mm.agents || []).slice();
    if (!ags.length) {
      let a = _best(code, ar, maxp, maxs);
      if (!a && mg && mta[mg]) a = Object.keys(mta[mg]).sort((x, y) => mta[mg][y] - mta[mg][x])[0];
      ags = a ? [a] : [];
    }
    p = { manager: mg, agents: ags, prefer: mm.prefer || "issuer", rule: mm.id };
  } else {
    const mg = _best(code, mr, maxp, maxs);
    const ags = [];
    const a = _best(code, ar, maxp, maxs);
    if (a) ags.push(a);
    if (mg && mta[mg]) for (const x of Object.keys(mta[mg]).sort((x, y) => mta[mg][y] - mta[mg][x])) if (ags.indexOf(x) < 0) ags.push(x);
    p = { manager: mg, agents: ags, prefer: "issuer", rule: null };
  }
  const pk = p.manager ? m2p[p.manager] : null;
  const agentKey = p.agents.length ? a2k[p.agents[0]] : null;
  const otherIssuerKeys = (pk ? [] : (mfa[p.manager] || []).map(x => x.key));
  const otherAgentKeys = p.agents.slice();
  if (p.manager && mta[p.manager]) for (const x of Object.keys(mta[p.manager]).sort((x, y) => mta[p.manager][y] - mta[p.manager][x])) if (otherAgentKeys.indexOf(x) < 0) otherAgentKeys.push(x);
  const restKeys = gpo.map(x => x.bank_key);
  return {
    code: (code || "").trim().toUpperCase(),
    manager: p.manager,
    issuerKey: pk,
    agent: p.agents[0] || null,
    agentKey: agentKey,
    otherIssuerKeys: otherIssuerKeys,
    otherAgentKeys: otherAgentKeys.map(a => a2k[a]).filter(Boolean).slice(0, 5),
    restKeys: restKeys,
    prefer: p.prefer,
    rule: p.rule,
    plan: null,
  };
}

export default {
  async fetch(request, env) {
    // 把 env（含 browser binding）挂到模块级，供 jsbFetch 等按需取用
    setWorkerEnv(env);
    // CORS 预检
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== "GET") {
      return jsonResponse({ error: "method not allowed" }, 405);
    }

    const url = new URL(request.url);

    if (url.pathname === "/health" || url.pathname === "/") {
      return jsonResponse({
        ok: true,
        service: "lclist-finance-api",
        live: ["icbc", "boc", "psbc", "ceb", "abc", "bob", "cmb", "bosc", "spdb", "ccb", "cib", "comm", "citic", "cgb", "fminbank", "nbcb",
          // jsb 依赖 Cloudflare Browser Rendering（browser binding）：配了 wrangler.browser.toml 才有
          ...((env && env.BROWSER) ? ["jsb"] : [])],
        note: "GET /api/fetch?bank=icbc|boc|psbc|ceb|abc|bob|cmb|bosc|spdb|ccb|cib|comm|citic|cgb|fminbank|nbcb&code=<PRODID>（ceb 双端口：App 端口 eoap 营销 H5 eoap.cebbank.com/uiap/ebdcService（真 Chrome 过瑞数 RS5 + 借 App 自身国密模块调 eproduct/productDetail + financeProduct/performanceGraph，全量净值 + 七字段，需该产品分享链 accessId，一个 accessId 只对应一个产品）优先，官网 eportal（瑞数+WAF 常拒）兜底；abc 走农行理财e站；bob 双端口：App 端口 cdnmobibank 手机银行 H5（SM2/SM4 国密网关 POST /H，借无头 Chrome + JSON.parse hook 解密；详情七字段 + 额度 + 全量历史净值——页面内点图表时间 tab 后接口回 cd.list=[{navDate,nav,totNav}]，按交易日发布，2026-10-17 晚间 F12 抓包打通；按需单抓不进热路径，web 无结果时 fallback 或 /api/bobapp 显式触发，与 web 按日期并集合并）+ web 北银理财信披站 beijingbobwealth.com.cn（净值序列 + 登记编码，默认热路径只走它）；cmb 走招行 cfweb 理财超市 SM4 签名通道；bosc 走上海银行净值披露接口 qryMCFinanceNetProHisValueForPersonPage；spdb 产品信息取浦发 per.spdb.com.cn/api/search，净值按发行方路由到招行目录匹配；ccb 走建行 tool3.ccb.cn 理财净值披露；cib 双路径：兴银理财官网 cibwm.com.cn 干净 JSON + 兴业手机银行 z.cib.com.cn 国密(SM2握手+SM4/SM3)通道，覆盖兴银理财自营与跨行代销(如民生理财)产品；comm 双端口：App 端口 mbank.95559.com.cn 手机银行网关（POST /mobs6/MobileBank//MOBS.MOBS-PRODUCTSRV.V-1.0/PRDAFD0007.ajax 取名称/风险2R/最短持有minInvestTerm/业绩基准/发行机构 + PRDAFD0002.ajax 取净值序列，免登录免签名免会话；shareCode 默认 JY（App 产品超市通用访问码，在架产品即通），分享链登记表可覆盖，app 无数据（未上架/已下架）自动走 web；app 净值比 web 新一天但长产品只回近3年滚动窗，故按日期与 web 并集合并）优先，web 交银理财官网 www.bocommwm.com queryJylcProductDetail/queryJylcBreakDetail（免签名，仅校验 Referer；登记编码 Z7…/成立日取自此端口）兜底；citic 主走中信银行直连接口（RSA握手+3DES-ECB）取完整净值，H5 精选目录兜底回填产品信息；cgb 双端口：App MDP 网关 wap.cgbchina.com.cn/h5-mobilebank-app/noSessionServlet/hbss/*.lgx（会话号=页面 cookie MDP_A_KEY，fn10025 产品七字段 + fn10003 全量净值 + fn20004 说明书 PDF 取登记编码，免登录免签名）优先，官网 financing_details.jsp（GBK 页面，仅最新净值单点 + 名称/风险/投资期限）兜底；fminbank 富民银行 App 端口 = 理财代销 H5 公网网关 open.fbank.com/gateway/（fm-wealth-fund 应用，AES-128-CBC+PBKDF2 免登录免签名，productDetail 全字段 + getNetInfoList 全量净值自上架日 + 剩余额度；内部 product_no 经 FMBANK_CODE_MAP 静态表/排行榜 263 款目录名匹配映射，映射未命中回落中国理财网 XPL；2026-10-19 打通，Node/Workers 双端通用，瑞数 WAF 只挡浏览器不挡直连）；nbcb 双通道：宁银理财官网 www.wmbnb.com 取自营产品完整净值(需 valid_token 反爬 cookie) + 宁波银行网银/移动端网关 e.nbcb.com.cn/zhongtai 取跨行代销产品信息(网关不提供净值序列，返回 infoOnly)）",
      });
    }

    if (url.pathname === "/api/fetch") {
      const bank = url.searchParams.get("bank") || "";
      const code = (url.searchParams.get("code") || "").trim().toUpperCase();
      if (!code) return jsonResponse({ error: "missing code" }, 400);

      // 中行等上游对 Workers 出网很不稳定，成功结果进 Cache API：后续命中即瞬时返回，
      // 既提速，也把偶发超时的影响压到最低。只缓存成功，失败不留底（否则一次抖动会被固化）。
      const cache = caches.default;
      // 缓存 key 带版本号：返回结构一变（如新增字段），旧结构会被继续命中 6 小时，
      // 而 Cache API 无法远程清除。递增 CACHE_VERSION 即可让旧缓存自然失效。
      const cacheKey = new Request(url.toString() + "&_cv=" + CACHE_VERSION, { method: "GET" });
      try {
        const hit = await cache.match(cacheKey);
        if (hit) {
          const body = await hit.text();
          return new Response(body, {
            status: 200,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              ...CORS_HEADERS,
              "X-Cache": "HIT",
            },
          });
        }
      } catch (e) { /* 缓存不可用不致命，直接走实时抓取 */ }

      try {
        const result = await fetchFromBank(bank, code);
        // 浦发渠道专属份额可能只有产品信息、没有净值序列（infoOnly），
        // 这类结果仍按 200 返回，让前端能填出真实的名称/管理人/风险等级。
        if (result && (result.series || result.infoOnly)) {
          const resp = jsonResponse(result, 200, {
            "Cache-Control": "public, max-age=" + CACHE_TTL_SEC,
            "X-Cache": "MISS",
          });
          try { await cache.put(cacheKey, resp.clone()); } catch (e) {}
          return resp;
        }
        return jsonResponse({ error: "not found", bank, code }, 404);
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        // 上游连不上 = 502（前端降级到内嵌快照）；其它意外才是 500
        return jsonResponse({ error: msg }, e && e.upstream ? 502 : 500);
      }
    }

    if (url.pathname === "/api/meta") {
      const bank = url.searchParams.get("bank") || "";
      const code = (url.searchParams.get("code") || "").trim().toUpperCase();
      if (!code) return jsonResponse({ error: "missing code" }, 400);
      try {
        const meta = await fetchMeta(bank, code);
        if (meta && (meta.risk || meta.established || meta.holdDays != null || meta.name)) {
          return jsonResponse(meta);
        }
        return jsonResponse({ error: "no meta", bank, code }, 404);
      } catch (e) {
        return jsonResponse({ error: e && e.message ? e.message : String(e) }, 500);
      }
    }

    if (url.pathname === "/api/predict") {
      const code = (url.searchParams.get("code") || "").trim().toUpperCase();
      if (!code) return jsonResponse({ error: "missing code" }, 400);
      try {
        const pred = await predictBanksWorker(code);
        if (!pred) return jsonResponse({ error: "predict unavailable（RULES_JSON_URL 未配置或规则加载失败）" }, 503);
        return jsonResponse(pred);
      } catch (e) {
        return jsonResponse({ error: e && e.message ? e.message : String(e) }, 500);
      }
    }

    if (url.pathname === "/api/abcinfo") {
      // 轻量农行信息端点：只抓 e 站 FsProdInfo（~1s），走 Cloudflare 出口，
      // 不经用户本地 IP（用户加拿大 IP 常被农行 e 站 403 时可用此通道补信息）。
      const code = (url.searchParams.get("code") || "").trim().toUpperCase();
      if (!code) return jsonResponse({ error: "missing code" }, 400);
      try {
        const t = await abcFetchInfo(code); // 默认 transport=fetch → Cloudflare 出口
        if (!t) return jsonResponse({ ok: false, code, reason: "no data" }, 404);
        const riskRaw = String(t.risk || "");
        let risk = null;
        if (riskRaw) {
          if (/中低|较低/.test(riskRaw)) risk = "R2(中低)";
          else if (/低/.test(riskRaw) && !/中/.test(riskRaw)) risk = "R1(低)";
          else if (/中高/.test(riskRaw)) risk = "R4(中高)";
          else if (/中/.test(riskRaw)) risk = "R3(中)";
          else if (/高/.test(riskRaw)) risk = "R5(高)";
          else risk = riskRaw;
        }
        const holdMatch = String(t.investTerm || "").match(/(\d+)/);
        const out = {
          ok: true,
          code,
          name: t.productName || t.prodName || null,
          minHold: holdMatch ? parseInt(holdMatch[1], 10) : null,
          risk,
          riskRaw,
          establishDate: t.estblDate || null,
          benchmark: t.mkrdBaseDscr || null,
          saleStatus: t.saleState || null,
          isCashMng: t.isCashMng || null,
        };
        return jsonResponse(out, 200);
      } catch (e) {
        return jsonResponse({ error: e && e.message ? e.message : String(e) }, 500);
      }
    }

    if (url.pathname === "/api/jsb-diag") {
      // 江苏银行 Browser Rendering 诊断端点：暴露内部每一步（会话/导航/挑战形态/YT 就绪/API 结果）
      // 用于线上排查「Browser Rendering 已上线但仍抓不到」——例如 WAF 把 Cloudflare 出网 IP 判为 bot。
      // 用法：GET /api/jsb-diag?code=J04946
      const code = (url.searchParams.get("code") || "J04946").trim().toUpperCase();
      const variant = (url.searchParams.get("variant") || "v2").trim();
      const env = getWorkerEnv();
      if (!env || !env.BROWSER) {
        return jsonResponse({ error: "browser binding not configured（需用 wrangler.browser.toml 部署）" }, 503);
      }
      try {
        const connect = makeBrowserBindingConnector(env, "BROWSER");
        const diag = await jsbBrowserDiag(code, { connect, timeoutMs: 120000, variant });
        return jsonResponse(diag, 200);
      } catch (e) {
        return jsonResponse({ error: "jsb diag failed: " + ((e && e.message) || e) }, 500);
      }
    }

    if (url.pathname === "/api/jsb-batch") {
      // 江苏银行批量抓取：一个 Chromium 会话连抓多只产品（Cloudflare Browser Rendering）
      //   复用会话 → WAF 的 JS 挑战只付一次（约 15~25s），之后每只约 1~3s；
      //   若每个产品各开一次会话，每个都要重过挑战（慢 10 倍、且很快撞到 Browser 配额）。
      // 用法：GET /api/jsb-batch?codes=J04946,J09652,120030N
      const codes = (url.searchParams.get("codes") || "")
        .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
      if (!codes.length) return jsonResponse({ error: "missing codes" }, 400);
      if (codes.length > 30) return jsonResponse({ error: "too many codes (max 30)" }, 400);
      const env = getWorkerEnv();
      if (!env || !env.BROWSER) {
        return jsonResponse({ error: "browser binding not configured（需用 wrangler.browser.toml 部署）", bank: "jsb" }, 503);
      }
      try {
        const connect = makeBrowserBindingConnector(env, "BROWSER");
        const results = await jsbBrowserFetchMany(codes, { connect, timeoutMs: 120000 });
        return jsonResponse({ bank: "jsb", count: codes.length, results }, 200);
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        return jsonResponse({ error: "jsb batch failed: " + msg, bank: "jsb" }, 500);
      }
    }

    if (url.pathname === "/api/product") {
      const code = (url.searchParams.get("code") || "").trim().toUpperCase();
      const issuer = (url.searchParams.get("issuer") || "").trim().toLowerCase();
      const agent = (url.searchParams.get("agent") || "").trim().toLowerCase();
      // 发行机构（产品记录里已存的 manager，详情卡红圈字段）：issuer 为空时由
      // fetchProductFull 按 MANAGER_TO_KEY 换算成发行银行 key（不按 code 预判）。
      const manager = (url.searchParams.get("manager") || "").trim();
      const name = (url.searchParams.get("name") || "").trim();
      const regCode = (url.searchParams.get("regCode") || "").trim().toUpperCase();
      // 2026-11-02 用户规则：富民内部产品码（DX…）落库后刷新时回传，跳过静态映射表 + 30min 目录缓存。
      const fmInternalCode = (url.searchParams.get("fmInternalCode") || "").trim().toUpperCase();
      const infoComplete = url.searchParams.get("infoComplete") === "1";
      // 业绩比较基准本地缓存复用：前端在「已查过（含空白）」的产品刷新时透传，后端据此跳过中国理财网/银行重查
      const benchmark = url.searchParams.has("benchmark") ? (url.searchParams.get("benchmark") || "") : null;
      const benchmarkKnown = url.searchParams.get("benchmarkKnown") === "1";
      // 偏好银行标记（首次双抓定标后由前端持久化；以后只抓该银行，不再试另一家）
      const preferBank = (url.searchParams.get("preferBank") || "").trim().toLowerCase();
      // 概要齐全标记（中行 ProductSummaryQueryOutlay 含 名称/登记编码/风险/基准，抓一次即齐全 → 跳过该请求）
      const summaryComplete = url.searchParams.get("summaryComplete") === "1";
      const sName = url.searchParams.get("sName") || "";
      const sRegCode = (url.searchParams.get("sRegCode") || "").trim().toUpperCase();
      const sRisk = (url.searchParams.get("sRisk") || "").trim();
      const sBenchmark = (url.searchParams.get("sBenchmark") || "").trim();
      // 增量抓取：刷新时前端透传本地序列最后净值日；后端只翻到追上该日的页、只回新增点。
      const since = (url.searchParams.get("since") || "").trim();
      // 2026-10-30 修复：此前线上 /api/product **未解析 mode**，恒按 "all" 全抓
      // （净值+产品信息+额度），而前端 mode=nav 只写净值 → 信息/额度全被丢弃、白跑一趟
      // （含中国理财网名检索，线上最贵的一段）。本地 serve.mjs 一直认 mode，线上此前不一致。
      const mode = (url.searchParams.get("mode") || "all");
      // 2026-10-30 新增：用户主动刷新（noCache=1）应真实回源，不吃 CDN 缓存。
      // 此前线上不解析该参数 → 同一 since 的增量请求在 TTL 内会一直命中旧缓存，
      // 导致「当天出了新净值点却仍返回 0 新增点」。
      const noCache = url.searchParams.get("noCache") === "1";
      if (!code) return jsonResponse({ error: "missing code" }, 400);
      // 缓存键带版本号，结构一变旧缓存自然失效（同 /api/fetch）
      const cacheKey = new Request(url.toString() + "&_cv=" + CACHE_VERSION, { method: "GET" });
      try {
        if (!noCache) {
          const hit = await cache.match(cacheKey);
          if (hit) {
            return new Response(await hit.text(), {
              status: 200,
              headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS, "X-Cache": "HIT" },
            });
          }
        }
      } catch (e) { /* 缓存不可用不致命 */ }
      try {
        // transport 必须透传第二参数 init（method/headers/body/signal）！
        // 2026-10-19 修复：此前写成 (p) => fetch(p)，丢掉 init → 所有 POST 类银行（富民网关、
        // 农行、招行 SM4、交银等）在线上全变成无 body 的 GET，上游一律判失败，
        // 表现为 /api/product 404 not found 而本地 serve（nodeTransport 支持 init）正常。
        // 对照组已实证：Workers 出网到 open.fbank.com 正常（383ms 拿回密文），故障纯在本次传参。
        const result = await fetchProductFull(code, { issuer, agent, manager, name, regCode, infoComplete, benchmark, benchmarkKnown, transport: (p, init) => fetch(p, init), preferBank: preferBank || null, summaryComplete, sName, sRegCode, sRisk, sBenchmark, since: since || undefined, mode, noCache, fmInternalCode: fmInternalCode || undefined });
        if (result && (result.nav || result.info || result.benchmark || result.quota != null)) {
          const resp = jsonResponse(result, 200, {
            "Cache-Control": "public, max-age=" + CACHE_TTL_SEC,
            "X-Cache": "MISS",
          });
          if (!noCache) { try { await cache.put(cacheKey, resp.clone()); } catch (e) {} }
          return resp;
        }
        // 2026-11-01 防御性：即便「未抓到」（nav/info/benchmark/quota 全空）也把已采集的
        // 时间分解(timings)随 404 带回，前端「时间分解」不再一片空白，便于定位是哪条链没跑通。
        return jsonResponse({ error: "not found", code, issuer, agent, timings: (result && result.timings) || [] }, 404);
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        return jsonResponse({ error: msg }, e && e.upstream ? 502 : 500);
      }
    }

    return jsonResponse({ error: "not found", path: url.pathname }, 404);
  },
};

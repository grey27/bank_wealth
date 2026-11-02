/* 手写国密（SM3 / SM4 / SM2）回归自检 —— node scrape/test_gm.mjs
 *
 * 为什么要这个：worker.js 里的国密是纯 JS 手写的（目的是让 worker.js 保持单文件、
 * 零依赖，可直接部署到 Cloudflare Workers）。手写密码学的风险在于「改错一个 hex 位
 * 不会报错，只会让服务端静默拒绝」——这次踩到的正是 SM2 基点 Gx 多了一位。
 * 本脚本用官方向量 + 曲线代数性质做断言，任何一处笔误都会在这里红出来。
 *
 * 运行方式：node scrape/test_gm.mjs   （不需要任何依赖、不需要联网）
 */
import fs from "node:fs";

/* worker.js 没导出内部加密函数（避免污染 API 面），这里把源码原样重 import 一遍
 * 并临时追加导出，达到「测的就是线上那份代码」的目的。 */
const src = fs.readFileSync(new URL("./worker.js", import.meta.url), "utf8");
const EXT = "\nexport { sm3, sm4Ecb, gmPkcs7, gmU8Hex, gmHexU8, gmU8, gmStr, SM2_P, SM2_A, SM2_B, SM2_N, SM2_GX, SM2_GY, sm2Add, sm2Mul, gmSm3, gmSm4EcbEnc, gmSm4EcbDec, gmSm4CbcEnc, gmSm4CbcDec };\n";
const G = await import("data:text/javascript;base64," + Buffer.from(src + EXT, "utf8").toString("base64"));

let pass = 0, fail = 0;
const check = (name, actual, expect) => {
  const ok = actual === expect;
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `\n         got    ${actual}\n         expect ${expect}`}`);
};
const assertTrue = (name, v, note = "") => check(name, String(v) + (note || ""), "true" + (note || ""));

console.log("SM3 摘要");
// GB/T 32905 官方向量
check('sm3("abc")', G.gmSm3("abc"), "66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0");
check('sm3("")', G.gmSm3(""), "1ab21d8355cfa17f8e61194831e81a8f22bec8c728fefb747ed035eb5082aa2b");

console.log("SM4 分组密码");
// GM/T 0002 官方向量：密钥与明文同为 0123456789abcdeffedcba9876543210
{
  const key = "0123456789abcdeffedcba9876543210";
  const pt = "0123456789abcdeffedcba9876543210";
  const ct = G.gmU8Hex(G.sm4Ecb(G.gmHexU8(key), G.gmHexU8(pt)));
  check("ECB 加密向量", ct, "681edf34d206965e86b3e94f536e4246");
  check("ECB 解密还原", G.gmU8Hex(G.sm4Ecb(G.gmHexU8(key), G.gmHexU8(ct), true)), pt);
  // 加解密往返（含 PKCS7 与 UTF-8 多字节）
  const s = '{"productCode":"2601KD001A","备注":"中文#$%"}';
  const k = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
  check("ECB 封装往返", G.gmSm4EcbDec(G.gmSm4EcbEnc(s, k), k), s);
  check("CBC 封装往返", G.gmSm4CbcDec(G.gmSm4CbcEnc(s, k, k), k, k), s);
  // CBC 与 ECB 必须不同（防止 mode 参数写反却看不出来）
  assertTrue("CBC ≠ ECB", G.gmSm4CbcEnc(s, k, k) !== G.gmSm4EcbEnc(s, k));
}

console.log("SM2 曲线参数（sm2p256v1）");
{
  const { SM2_P: P, SM2_A: A, SM2_B: B, SM2_N: N, SM2_GX: GX, SM2_GY: GY, sm2Add, sm2Mul } = G;
  const modp = (x) => { const r = x % P; return r < 0n ? r + P : r; };
  assertTrue("G 在曲线上", modp(GY * GY - (GX * GX * GX + A * GX + B)) === 0n,
    modp(GY * GY - (GX * GX * GX + A * GX + B)).toString(16) === "0" ? "" : ` 残差=${modp(GY * GY - (GX * GX * GX + A * GX + B)).toString(16)}`);
  assertTrue("n·G = 无穷远点", sm2Mul(N, [GX, GY]) === null);
  assertTrue("(n-1)·G 的 y = p-Gy", sm2Mul(N - 1n, [GX, GY])[1] === modp(-GY));
  // 群律：结合律 + 加法同态（能抓住绝大部分标量乘写错）
  const a = 123456789n, b = 987654321n;
  const A1 = sm2Mul(b, sm2Mul(a, [GX, GY]));
  const A2 = sm2Mul((a * b) % N, [GX, GY]);
  assertTrue("标量乘结合律 b·(a·G) = (ab)·G", A1 && A2 && A1[0] === A2[0] && A1[1] === A2[1]);
  const S = sm2Add(sm2Mul(a, [GX, GY]), sm2Mul(b, [GX, GY]));
  assertTrue("加法同态 a·G + b·G = (a+b)·G", S && S[0] === sm2Mul((a + b) % N, [GX, GY])[0]);
  assertTrue("常量位宽均为 64 位十六进制", [P, A, B, N, GX, GY].every((v) => v.toString(16).length === 64));
}

console.log(`\n${fail === 0 ? "全部通过" : "存在失败"}：${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

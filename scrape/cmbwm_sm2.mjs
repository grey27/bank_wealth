/* 纯 JS 实现的国密 SM2（加密）+ SM3 + 对应 KDF —— 零依赖，可在 Cloudflare Workers（BigInt）运行。
 * 严格对齐 sm-crypto v2 的 doEncrypt：cipherMode=1 → C1C3C2，C1 输出 04 前缀由调用方拼接。
 * 字段口径见 cmbwm_app.mjs 头部注释。
 *
 * 用法（Node 测试）：
 *   import { sm3hex, sm2EncryptHex, sm2DecryptHex } from "./cmbwm_sm2.mjs";
 */

/* ---------------- SM3（BigInt 字运算，规避有符号/无符号歧义） ---------------- */
const M32 = 0xFFFFFFFFn;
const rotl = (x, n) => { n = BigInt(n) & 31n; return (((x << n) | (x >> (32n - n))) & M32); };
const P0 = (x) => (x ^ rotl(x, 9) ^ rotl(x, 17)) & M32;
const P1 = (x) => (x ^ rotl(x, 15) ^ rotl(x, 23)) & M32;
const FF = (x, y, z, j) => (j < 16) ? (x ^ y ^ z) & M32 : ((x & y) | (x & z) | (y & z)) & M32;
const GG = (x, y, z, j) => (j < 16) ? (x ^ y ^ z) & M32 : ((x & y) | ((~x & M32) & z)) & M32;

/** SM3：输入 Uint8Array，输出 32 字节 Uint8Array */
export function sm3bytes(msg) {
  let IV = [
    0x7380166fn, 0x4914b2b9n, 0x172442d7n, 0xda8a0600n,
    0xa96f30bcn, 0x163138aan, 0xe38dee4dn, 0xb0fb0e4en,
  ].slice();
  const T = (j) => (j < 16 ? 0x79cc4519n : 0x7a879d8an);
  const l = msg.length;
  const bitLen = BigInt(l * 8);
  let padLen = l + 1;
  padLen += (padLen % 64 === 0 ? 0 : 64 - (padLen % 64));
  const m = new Uint8Array(padLen);
  m.set(msg);
  m[l] = 0x80;
  for (let i = 0; i < 8; i++) m[padLen - 8 + i] = Number((bitLen >> BigInt(8 * (7 - i))) & 0xffn);

  for (let off = 0; off < padLen; off += 64) {
    const W = new Array(68);
    for (let i = 0; i < 16; i++) {
      W[i] = (BigInt(m[off + i * 4]) << 24n) | (BigInt(m[off + i * 4 + 1]) << 16n) | (BigInt(m[off + i * 4 + 2]) << 8n) | BigInt(m[off + i * 4 + 3]);
    }
    for (let j = 16; j < 68; j++) {
      W[j] = P1(W[j - 16] ^ W[j - 9] ^ rotl(W[j - 3], 15n)) ^ rotl(W[j - 13], 7n) ^ W[j - 6];
    }
    const W2 = new Array(64);
    for (let j = 0; j < 64; j++) W2[j] = W[j] ^ W[j + 4];

    let A = IV[0], B = IV[1], C = IV[2], D = IV[3], E = IV[4], F = IV[5], G = IV[6], H = IV[7];
    for (let j = 0; j < 64; j++) {
      const SS1 = rotl((rotl(A, 12n) + E + rotl(T(j), BigInt(j))) & M32, 7n);
      const SS2 = (SS1 ^ rotl(A, 12n)) & M32;
      const TT1 = (FF(A, B, C, j) + D + SS2 + W2[j]) & M32;
      const TT2 = (GG(E, F, G, j) + H + SS1 + W[j]) & M32;
      const D2 = C, C2 = rotl(B, 9n), B2 = A, A2 = TT1;
      const H2 = G, G2 = rotl(F, 19n), F2 = E, E2 = P0(TT2);
      A = A2; B = B2; C = C2; D = D2; E = E2; F = F2; G = G2; H = H2;
    }
    IV[0] ^= A; IV[1] ^= B; IV[2] ^= C; IV[3] ^= D;
    IV[4] ^= E; IV[5] ^= F; IV[6] ^= G; IV[7] ^= H;
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[i * 4] = Number((IV[i] >> 24n) & 0xffn);
    out[i * 4 + 1] = Number((IV[i] >> 16n) & 0xffn);
    out[i * 4 + 2] = Number((IV[i] >> 8n) & 0xffn);
    out[i * 4 + 3] = Number(IV[i] & 0xffn);
  }
  return out;
}

export function sm3hex(msgBytes) {
  const b = sm3bytes(msgBytes);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/* ---------------- SM2 ---------------- */
const P = 0xFFFFFFFEFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00000000FFFFFFFFFFFFFFFFn;
const A = 0xFFFFFFFEFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00000000FFFFFFFFFFFFFFFCn;
const B = 0x28E9FA9E9D9F5E344D5A9E4BCF6509A7F39789F515AB8F92DDBCBD414D940E93n;
const GX = 0x32C4AE2C1F1981195F9904466A39C9948FE30BBFF2660BE1715A4589334C74C7n;
const GY = 0xBC3736A2F4F6779C59BDCEE36B692153D0A9877CC62A474002DF32E52139F0A0n;
const N = 0xFFFFFFFEFFFFFFFFFFFFFFFFFFFFFFFF7203DF6B21C6052B53BBF40939D54123n;

function modInv(a, m) {
  a = ((a % m) + m) % m;
  let [old_r, r] = [a, m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  return ((old_s % m) + m) % m;
}

// 仿射坐标点运算
function ecAdd(p1, p2) {
  if (!p1) return p2;
  if (!p2) return p1;
  const [x1, y1] = p1, [x2, y2] = p2;
  if (x1 === x2 && (y1 + y2) % P === 0n) return null;
  let lambda;
  if (x1 === x2 && y1 === y2) {
    lambda = (3n * x1 * x1 + A) * modInv(2n * y1, P) % P;
  } else {
    lambda = (y2 - y1) * modInv(x2 - x1, P) % P;
  }
  const x3 = (lambda * lambda - x1 - x2) % P;
  const y3 = (lambda * (x1 - x3) - y1) % P;
  return [((x3 % P) + P) % P, ((y3 % P) + P) % P];
}

export function ecMul(k, point) {
  k = ((k % N) + N) % N;
  if (k === 0n) return null;
  let result = null;
  let addend = point;
  while (k > 0n) {
    if (k & 1n) result = ecAdd(result, addend);
    addend = ecAdd(addend, addend);
    k >>= 1n;
  }
  return result;
}

function b2h(b) { return b.toString(16).padStart(64, "0"); }

/** 生成随机 k ∈ [1, N-1] */
export function randomK(cryptoObj) {
  const c = cryptoObj || globalThis.crypto;
  let k;
  do {
    const buf = new Uint8Array(32);
    c.getRandomValues(buf);
    k = 0n;
    for (const x of buf) k = (k << 8n) | BigInt(x);
    k = k % N;
  } while (k === 0n);
  return k;
}

/** 公钥(04+x+y 130hex) → 点 [x,y] */
export function decodePointHex(pubHex) {
  const h = pubHex.startsWith("04") ? pubHex.slice(2) : pubHex;
  const x = BigInt("0x" + h.slice(0, 64));
  const y = BigInt("0x" + h.slice(64, 128));
  return [x, y];
}

/**
 * SM2 加密（对齐 sm-crypto doEncrypt，cipherMode=1 → C1C3C2）。
 * @param plaintext String（会被 UTF-8 编码）
 * @param pubHex 04+x+y 公钥
 * @param cryptoObj 提供 getRandomValues 的对象（Node 用 webcrypto，Worker 用 crypto）
 * @returns 完整 hex：'04' + C1(128h) + C3(64h) + C2
 */
export function sm2EncryptHex(plaintext, pubHex, cryptoObj) {
  const data = new TextEncoder().encode(plaintext); // UTF-8 字节
  const Pp = decodePointHex(pubHex);
  const k = randomK(cryptoObj);
  const C1 = ecMul(k, [GX, GY]); // k*G
  const S = ecMul(k, Pp); // k*P = (x2, y2)
  const x2 = S[0], y2 = S[1];
  const x2b = hexToBytes(b2h(x2));
  const y2b = hexToBytes(b2h(y2));

  // C3 = sm3(x2 || data || y2)
  const c3 = sm3bytes(concatBytes(x2b, data, y2b));

  // KDF（sm-crypto 同款）：g = sm3(x2||y2||counter)，counter 从 1 起
  const yb = concatBytes(x2b, y2b);
  const c2 = new Uint8Array(data.length);
  let d = 1, v = 0, g = null;
  const refill = () => {
    const ctr = new Uint8Array(4);
    ctr[0] = (d >>> 24) & 0xff; ctr[1] = (d >>> 16) & 0xff; ctr[2] = (d >>> 8) & 0xff; ctr[3] = d & 0xff;
    g = sm3bytes(concatBytes(yb, ctr));
    d++; v = 0;
  };
  refill();
  for (let i = 0; i < data.length; i++) {
    if (v >= g.length) refill();
    c2[i] = data[i] ^ g[v++];
  }

  const C1hex = "04" + b2h(C1[0]) + b2h(C1[1]);
  const C3hex = c3hex(c3);
  const C2hex = [...c2].map((x) => x.toString(16).padStart(2, "0")).join("");
  return C1hex + C3hex + C2hex;
}

/** SM2 解密（用于本地回合测试） */
export function sm2DecryptHex(cipherHex, privHex, cryptoObj) {
  let data = cipherHex;
  if (data.startsWith("04")) data = data.slice(2); // 兼容带/不带 04 前缀
  const C1hex = data.slice(0, 128); // x(64) + y(64)
  const x1 = BigInt("0x" + C1hex.slice(0, 64));
  const y1 = BigInt("0x" + C1hex.slice(64, 128));
  const rest = data.slice(128);
  // C3 在前（cipherMode 1）：C3 = rest 前 64h，C2 = 余下
  const C3hex = rest.slice(0, 64);
  const C2hex = rest.slice(64);
  const k = BigInt("0x" + privHex);
  const S = ecMul(k, [x1, y1]);
  const x2 = S[0], y2 = S[1];
  const x2b = hexToBytes(b2h(x2));
  const y2b = hexToBytes(b2h(y2));
  const c2 = hexToBytes(C2hex);
  const yb = concatBytes(x2b, y2b);
  const plain = new Uint8Array(c2.length);
  let d = 1, v = 0, g = null;
  const refill = () => {
    const ctr = new Uint8Array(4);
    ctr[0] = (d >>> 24) & 0xff; ctr[1] = (d >>> 16) & 0xff; ctr[2] = (d >>> 8) & 0xff; ctr[3] = d & 0xff;
    g = sm3bytes(concatBytes(yb, ctr));
    d++; v = 0;
  };
  refill();
  for (let i = 0; i < c2.length; i++) {
    if (v >= g.length) refill();
    plain[i] = c2[i] ^ g[v++];
  }
  return new TextDecoder().decode(plain);
}

/* ---------------- 小工具 ---------------- */
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function concatBytes(...arrs) {
  let n = 0; for (const a of arrs) n += a.length;
  const out = new Uint8Array(n); let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}
function c3hex(b) { return [...b].map((x) => x.toString(16).padStart(2, "0")).join(""); }

// 兼容 Node 测试：导出 TextEncoder/Decoder（浏览器/Worker 原生）

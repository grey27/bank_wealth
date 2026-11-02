/* 本机验证专用「传输层」—— 替代 Cloudflare Workers 的原生 fetch。
 *
 * 为什么需要它：
 *   papi.icbc.com.cn 握手走「旧版不安全重协商」，OpenSSL 3 默认禁止，于是
 *   Node 的全局 fetch(undici) 直接报 ERR_SSL_UNSAFE_LEGACY_RENEGOTIATION_DISABLED。
 *   加上 secureOptions: SSL_OP_LEGACY_SERVER_CONNECT 就能连上（已实测 HTTP 200 + 真实数据）。
 *
 * 这不是生产代码：Workers 出网由 Cloudflare 自己的 TLS 栈处理，不需要这个选项。
 * 它只在 test_local.js 里被注入，用来验证 worker.js 的业务逻辑（探测/分页/口径转换）
 * 拿到的是真实响应，而不是 mock。
 */
import crypto from "node:crypto";
import https from "node:https";
import { URL } from "node:url";

const SECURE_OPTS = crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT;

/**
 * fetch -like：入参 (url, init) → 返回带 text()/json() 的最小 Response 实现。
 */
export function nodeTransport(url, init = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = init.body == null ? null : String(init.body);

    // 【2026-10-31 广发修复】本机到广发系（cgbchina.com.cn）的 IPv4 被地域/防火墙封禁
    // （实测 www 直接 403、m./wap. 连接超时 000），但 IPv6 完全放行（curl -6 全部 200）。
    // 手机同 wifi 能开正是因为协商到了 IPv6。故对广发系强制 family=6，让本机走 IPv6 通路；
    // 其他银行保持默认（IPv4，autoSelectFamily 回退），不受影响。线上 Worker 不引用本传输层，无影响。
    const forceV6 = /\.cgbchina\.com\.cn$/.test(u.hostname);

    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: (init.method || "GET").toUpperCase(),
        headers: Object.assign({}, init.headers, {
          "Content-Length": body ? Buffer.byteLength(body) : 0,
        }),
        secureOptions: SECURE_OPTS,
        timeout: 25000,
        ...(forceV6 ? { family: 6 } : null),
      },
      (res) => {
        // 保留原始字节：部分上游（如广发官网）返回 GBK 页面，
        // 需按 charset 二次解码，故同时提供 arrayBuffer()（与浏览器 fetch 对齐）。
        const chunks = [];
        res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          // 复刻浏览器 fetch 的 Headers 行为：worker.js 多处调用
          // res.headers.get("content-type" / "set-cookie") 以及 getSetCookie()，
          // 旧实现缺 headers 会导致 boscGet 等直接抛 TypeError → 抓取失败。
          const rawHeaders = res.headers || {};
          const headers = {
            get(name) {
              const v = rawHeaders[String(name).toLowerCase()];
              if (v == null) return null;
              return Array.isArray(v) ? v.join(", ") : v;
            },
            has(name) {
              return rawHeaders[String(name).toLowerCase()] != null;
            },
            getSetCookie() {
              const sc = rawHeaders["set-cookie"];
              if (!sc) return [];
              return Array.isArray(sc) ? sc.slice() : [sc];
            },
            forEach(cb, thisArg) {
              for (const k in rawHeaders) cb.call(thisArg, rawHeaders[k], k, headers);
            },
            entries() {
              return Object.entries(rawHeaders)[Symbol.iterator]();
            },
            keys() {
              return Object.keys(rawHeaders)[Symbol.iterator]();
            },
            values() {
              return Object.values(rawHeaders)[Symbol.iterator]();
            },
            [Symbol.iterator]() {
              return Object.entries(rawHeaders)[Symbol.iterator]();
            },
          };
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            headers,
            async text() {
              return buf.toString("utf8");
            },
            async arrayBuffer() {
              return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
            },
            async json() {
              return JSON.parse(buf.toString("utf8"));
            },
          });
        });
      }
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("upstream timeout"));
    });

    // AbortSignal 支持（2026-10-22 修）：worker.js 各银行抓取都用 AbortController 设超时
    // （如 bosc 15s），但旧实现完全不读 init.signal → 银行 WAF 挂起连接时abort 不生效，
    // 白等 OS 级 TCP 超时（实测 bosc.cn 每次 21.5s），重试一次就是 43s+。
    if (init.signal) {
      const sig = init.signal;
      const onAbort = () => req.destroy(new Error("aborted"));
      if (sig.aborted) { req.destroy(new Error("aborted")); }
      else {
        sig.addEventListener("abort", onAbort, { once: true });
        req.on("close", () => sig.removeEventListener("abort", onAbort));
      }
    }

    if (body) req.write(body);
    req.end();
  });
}

export default nodeTransport;

/* 零依赖 CDP 客户端（移植自「银行所有产品总汇」bankscrape/src/core/chrome-eval.js + chrome-cookie.js，2026-10-31 采纳）
 *
 * 用途：招银理财官网（www.cmbchinawm.com）所有 POST 请求体都是 SM2 加密（vm.SmAencrypt），
 *       纯 HTTP 客户端复现不了 → 借真实页面自己的加密器。本模块用 Node 22 内置 WebSocket +
 *       child_process 驱动无头 Chrome，无需 puppeteer 等任何第三方依赖。
 *
 * 为什么不用 puppeteer：本项目铁律「不引入重依赖、零运行时风险」。puppeteer-core 在部分环境
 *       需手动指定路径、易解析失败；而 CDP 通道本身就几十行，Node 原生有 WebSocket，直接手写更稳。
 *
 * 用法：
 *   const page = await CdpPage.open({ url, port, profileDir, readyExpr });
 *   const v = await page.evalAsync("(async()=>{...})()");
 *   page.close();
 */
"use strict";

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

export function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try { if (p && fs.existsSync(p)) return p; } catch {}
  }
  throw new Error("找不到 Chrome/Edge，可用 CHROME_PATH 环境变量指定");
}

async function cdpVersion(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (r.ok) return (await r.json()).webSocketDebuggerUrl;
  } catch {}
  return null;
}

/** 端口已占用（Chrome 已起）→ 复用其 ws；否则启动一个无头 Chrome 并等 CDP 就绪。 */
export async function ensureChrome({ port, profileDir, log = () => {} }) {
  let ws = await cdpVersion(port);
  if (ws) return ws;
  const exe = findChrome();
  fs.mkdirSync(profileDir, { recursive: true });
  log(`  [cmbwm-cdp] 启动 ${exe} :${port}`);
  spawn(exe, [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--window-size=1440,900",
    "--lang=zh-CN",
    "about:blank",
  ], { stdio: "ignore", detached: true }).unref();
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    ws = await cdpVersion(port);
    if (ws) return ws;
  }
  throw new Error("Chrome 启动失败（CDP 端口无响应）");
}

export class CdpPage {
  constructor(ws, sid, targetId) {
    this.ws = ws;
    this.sid = sid;
    this.targetId = targetId;
    this._id = 0;
    this._pending = new Map();
    this.closed = false;
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this._pending.has(m.id)) {
        const { resolve, reject, timer } = this._pending.get(m.id);
        this._pending.delete(m.id);
        clearTimeout(timer);
        if (m.error) reject(new Error(m.error.message || "CDP 错误"));
        else resolve(m.result);
      }
    };
    ws.onclose = () => {
      this.closed = true;
      for (const [, p] of this._pending) { clearTimeout(p.timer); p.reject(new Error("CDP 连接已关闭")); }
      this._pending.clear();
    };
  }

  send(method, params = {}, timeoutMs = 120000) {
    if (this.closed) return Promise.reject(new Error("CDP 连接已关闭"));
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`${method} 超时 ${timeoutMs}ms`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, sessionId: this.sid }));
    });
  }

  /** 打开页面并等待 readyExpr 为真（如页面 Vue 根实例上的 SmAencrypt 就绪） */
  static async open({ url, port = 9423, profileDir, readyExpr = "true", timeoutMs = 90000, log = () => {} }) {
    const wsUrl = await ensureChrome({ port, profileDir, log });
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error("CDP WebSocket 连接失败"));
    });
    const { targetId } = await new Promise((resolve, reject) => {
      const id = Math.floor(Math.random() * 1e9);
      ws.send(JSON.stringify({ id, method: "Target.createTarget", params: { url: "about:blank" } }));
      const onMsg = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === id) { ws.removeEventListener("message", onMsg); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
      };
      ws.addEventListener("message", onMsg);
    });
    const att = await new Promise((resolve, reject) => {
      const id = Math.floor(Math.random() * 1e9) + 1;
      ws.send(JSON.stringify({ id, method: "Target.attachToTarget", params: { targetId, flatten: true } }));
      const onMsg = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === id) { ws.removeEventListener("message", onMsg); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
      };
      ws.addEventListener("message", onMsg);
    });
    const page = new CdpPage(ws, att.sessionId, targetId);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    // ⚠ 必须在导航前覆盖 UA，否则请求头带 HeadlessChrome 被 WAF 拦（412→400 死循环）
    await page.send("Emulation.setUserAgentOverride", { userAgent: UA, acceptLanguage: "zh-CN,zh;q=0.9", platform: "Win32" });
    log(`  [cmbwm-cdp] 打开 ${url}`);
    await page.send("Page.navigate", { url });

    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await sleep(600);
      const ok = await page.eval(readyExpr).catch(() => false);
      if (ok) { log(`  [cmbwm-cdp] 页面就绪（${((Date.now() - t0) / 1000).toFixed(1)}s）`); return page; }
    }
    throw new Error(`页面未就绪：${readyExpr}`);
  }

  /** 同步表达式求值 */
  async eval(expression, opts = {}) {
    const r = await this.send("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: false,
    }, opts.timeoutMs || 30000);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || "页面脚本异常");
    return r.result ? r.result.value : undefined;
  }

  /** 异步表达式（返回 Promise，自动 await 后取值） */
  async evalAsync(expression, opts = {}) {
    const r = await this.send("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true,
    }, opts.timeoutMs || 180000);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error((d.exception && d.exception.description) || d.text || "页面脚本异常");
    }
    return r.result ? r.result.value : undefined;
  }

  async close() {
    if (this.closed) return;
    try { await this.send("Target.closeTarget", { targetId: this.targetId }, 5000); } catch {}
    try { this.ws.close(); } catch {}
    this.closed = true;
  }
}

// 服务器端 JShield(APSign) 签名器
// 复刻网商 H5 的 MyBankH5Main 通道签名：
//   x-data = md5(JSON.stringify(requestData))
//   x-sign = APSign.getSign("MyBankH5Main", "W3g6PvhSk11pFCmtGKQWavpk", x-data)
// 用法: node jshield_signer.mjs "<md5hex>" [appName] [bizToken]
// 多人调用可加 --serve 走 stdin JSON-lines 模式（保持 Chrome 常驻）
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pickTmpRoot } from "./cache_root.mjs";

// Chrome 路径：Linux（GitHub Actions runner）经 CHROME_BIN 注入；Windows 本机回落默认安装路径。
const CHROME = process.env.CHROME_BIN || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const MOD_DIR = path.dirname(fileURLToPath(import.meta.url));
const SDK = fs.readFileSync(path.join(MOD_DIR, "site/jshield.dec.js"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// pickTmpRoot 已迁至 ./cache_root.mjs（缓存根移到项目外的 网商银行cache）。

const PORT = 9500 + Math.floor(Math.random() * 400);
// profile 优先用父进程给的（jshield_client.mjs 持有并负责删除）；
// 独立 CLI 直跑时自己建一个，自己负责删。
const profile = process.env.JSIGN_PROFILE_DIR
  ? process.env.JSIGN_PROFILE_DIR
  : fs.mkdtempSync(path.join(pickTmpRoot("jsign-"), "jsign-"));
const profileOwnedByParent = !!process.env.JSIGN_PROFILE_DIR;
const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--ignore-certificate-errors",
  "--disable-features=IsolateOrigins,site-per-process",
  "--allow-running-insecure-content",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-ipc-flooding-protection",
  "about:blank",
]);
chrome.on("error", (e) => console.error("chrome err", e.message));

async function getWsUrl() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error("chrome devtools not ready");
}

if (typeof globalThis.WebSocket !== "function") {
  throw new Error("当前 Node 运行时缺少全局 WebSocket（需 Node ≥ 22）：Chrome CDP 客户端依赖它");
}
const ws = new WebSocket(await getWsUrl());
let id = 0;
const pending = new Map();
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
function send(method, params = {}, sessionId) {
  const mid = ++id;
  const msg = { id: mid, method, params };
  if (sessionId) msg.sessionId = sessionId;
  ws.send(JSON.stringify(msg));
  return new Promise((r) => pending.set(mid, r));
}

async function evaluate(sessionId, expression, awaitPromise = true) {
  const r = await send("Runtime.evaluate", {
    expression, awaitPromise, returnByValue: true, allowUnsafeEvalBlockedByCSP: true,
  }, sessionId);
  if (r.error) return { error: r.error.message };
  if (r.result?.exceptionDetails) {
    return { error: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text };
  }
  return { value: r.result?.result?.value };
}

// 打开一个真实 origin 页面（jshield 需要 document/navigator 环境）
const PAGE_URL = "https://render.mybank.cn/p/h5/alipay-yulibao/www/";
const { result: target } = await send("Target.createTarget", { url: PAGE_URL });
const { result: att } = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
const SID = att.sessionId;
await send("Runtime.enable", {}, SID);
await send("Page.enable", {}, SID);

// SDK 注入（SDK 期望 webpack node-polyfill 变量 global）
const PRELUDE = `window.global=window.global||window;window.globalThis=window.globalThis||window;`;
const SDK_SRC = PRELUDE + SDK + "\n;window.__JSHIELD_READY__=typeof window.APSign;";

// 1) 文档级注入：每次新文档都执行，避免被页面导航冲掉
await send("Page.addScriptToEvaluateOnNewDocument", { source: SDK_SRC }, SID);
// 2) 当前上下文再注入一次，并轮询确认
let loaded = false;
for (let i = 0; i < 12; i++) {
  await evaluate(SID, SDK_SRC, false);
  const has = await evaluate(SID, "JSON.stringify({sign:typeof window.APSign, ready:window.__JSHIELD_READY__||''})", false);
  if (has.value && has.value.includes('"sign":"function"')) { loaded = true; break; }
  await sleep(800);
}
console.error("SDK loaded:", loaded);

// 退出时回收 Chrome **并删除它的 user-data-dir**（一个 profile ≈ 200MB）。
// 2026-10-26：之前只 kill 不删，累积出 96 个孤儿目录、7.3GB，把系统盘写满 →
// ENOSPC 让说明书 PDF 下载失败 → 七字段全丢 → 添加产品时名称为空、保存被拦。
const killChrome = () => {
  try { chrome.kill(); } catch {}
  // Windows：chrome.kill() 只杀父进程，renderer / GPU / utility 子进程会活下来并继续
  // 锁住 user-data-dir 里的文件 → profile 删不掉（实测每次残留 46MB）。
  // 用 taskkill /T 杀整棵进程树。
  try {
    if (chrome.pid) {
      spawnSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"],
        { stdio: "ignore", timeout: 10000, windowsHide: true });
    }
  } catch (e) { /* taskkill 不可用时退回上面的 chrome.kill() */ }
  // exit 处理器里只能同步快速操作：先试删一次，失败就算了（下面的 cleanupProfile 会再兜底）
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 1, retryDelay: 50 }); } catch {}
};
// Chrome 的子进程（renderer/GPU）在 Windows 上会短暂占住 profile 文件句柄，立刻删会失败 → 退避重试。
async function cleanupProfile() {
  if (profileOwnedByParent) return true;   // 父进程持有 → 由父进程删
  for (let i = 0; i < 10; i++) {
    if (!fs.existsSync(profile)) return true;
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 }); } catch {}
    if (!fs.existsSync(profile)) return true;
    await sleep(300);
  }
  return false;
}
process.on("exit", killChrome);
process.on("SIGINT", async () => { killChrome(); await cleanupProfile(); process.exit(0); });
process.on("SIGTERM", async () => { killChrome(); await cleanupProfile(); process.exit(0); });

// init
const initExpr = `(async()=>{
  try{
    if(!window.APSecuritySdk) return "no-APSecuritySdk";
    if(window.APSecuritySdk.init) await window.APSecuritySdk.init("MyBankH5Main",{host:"https://tscenter.alipay.com",apdid:true,color:true,sign:true});
    return "ok";
  }catch(e){ return "init-err:"+(e&&e.message||e); }
})()`;
const initR = await evaluate(SID, initExpr);
console.error("init:", JSON.stringify(initR.value));

export async function sign(md5hex, appName = "MyBankH5Main", bizToken = "W3g6PvhSk11pFCmtGKQWavpk") {
  const expr = `(async()=>{
    try{
      if(!window.APSign) return {err:"no-APSign"};
      const s = await Promise.race([
        window.APSign.getSign(${JSON.stringify(appName)}, ${JSON.stringify(bizToken)}, ${JSON.stringify(md5hex)}),
        new Promise((_,rej)=>setTimeout(()=>rej(new Error("in-page sign timeout")),8000))
      ]);
      return {sign: s};
    }catch(e){ return {err:(e&&e.message)||String(e)}; }
  })()`;
  const r = await evaluate(SID, expr);
  return r.value;
}

/** 对任意 JSON 值（对象/数组/字符串）签名 —— h5WebSign 用法 */
export async function signJson(jsonText, appName = "WECHAT_TINY_H5_MYBANK", bizToken = "W3g6PvhSk11pFCmtGKQWavpk") {
  // 用 JSON.parse 求值，避免裸串（非合法 JSON）被当作 JS 源码导致求值异常/挂起
  const expr = `(async()=>{
    try{
      if(!window.APSign) return {err:"no-APSign"};
      const val = JSON.parse(${JSON.stringify(jsonText)});
      const s = await Promise.race([
        window.APSign.getSign(${JSON.stringify(appName)}, ${JSON.stringify(bizToken)}, val),
        new Promise((_,rej)=>setTimeout(()=>rej(new Error("in-page sign timeout")),8000))
      ]);
      return {sign: s};
    }catch(e){ return {err:(e&&e.message)||String(e)}; }
  })()`;
  const r = await evaluate(SID, expr);
  return r.value;
}

/** 对任意 JS 值签名（自动 JSON 编码，字符串/对象皆可） */
export async function signValue(value, appName = "WECHAT_TINY_H5_MYBANK", bizToken = "W3g6PvhSk11pFCmtGKQWavpk") {
  return signJson(JSON.stringify(value), appName, bizToken);
}

// ---- CLI 模式 ----
if (process.argv[2] && process.argv[2] !== "--serve") {
  const md5hex = process.argv[2];
  const appName = process.argv[3] || "MyBankH5Main";
  const bizToken = process.argv[4] || "W3g6PvhSk11pFCmtGKQWavpk";
  const out = await sign(md5hex, appName, bizToken);
  console.log(JSON.stringify(out));
  chrome.kill();
  await cleanupProfile();          // 等 Chrome 释放 profile 文件句柄（Windows 上锁着删不掉）
  process.exit(0);
} else {
  // 常驻服务模式：stdin 每行一个 JSON {md5, appName, bizToken}
  console.log("READY");
  // 父进程关闭 stdin（父已退出）→ 自杀，避免留下孤儿 Chrome + 孤儿 profile
  process.stdin.on("end", async () => { killChrome(); await cleanupProfile(); process.exit(0); });
  process.stdin.on("close", async () => { killChrome(); await cleanupProfile(); process.exit(0); });
  let buf = "";
  process.stdin.on("data", async (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const job = JSON.parse(line);
        const out = job.value !== undefined
          ? await signValue(job.value, job.appName, job.bizToken)
          : job.json !== undefined
          ? await signJson(job.json, job.appName, job.bizToken)
          : await sign(job.md5, job.appName, job.bizToken);
        process.stdout.write(JSON.stringify(out) + "\n");
      } catch (e) {
        process.stdout.write(JSON.stringify({ err: String(e) }) + "\n");
      }
    }
  });
}

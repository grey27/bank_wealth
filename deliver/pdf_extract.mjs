// PDF 文本提取器：headless Chrome + pdf.js（服务器端可用）
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pickTmpRoot } from "./cache_root.mjs";

// Chrome 路径：Linux（GitHub Actions runner）经 CHROME_BIN 注入；Windows 本机回落默认安装路径。
const CHROME = process.env.CHROME_BIN || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const MOD_DIR = path.dirname(fileURLToPath(import.meta.url));

// pickTmpRoot 已迁至 ./cache_root.mjs（缓存根移到项目外的 网商银行cache）。

const DL = path.join(pickTmpRoot("pdfjs"), "pdfjs");
fs.mkdirSync(DL, { recursive: true });
const PDFJS = path.join(DL, "pdf.min.js");
const WORKER = path.join(DL, "pdf.worker.min.js");
if (!fs.existsSync(PDFJS)) {
  for (const [f, u] of [["pdf.min.js", "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"], ["pdf.worker.min.js", "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"]]) {
    const r = await fetch(u); fs.writeFileSync(path.join(DL, f), Buffer.from(await r.arrayBuffer()));
  }
}

export async function extractPdfText(pdfPath, opts = {}) {
  const { maxPages = 60, keywords = null } = opts;

  // 本地静态服务（供页面 fetch）
  const root = path.dirname(pdfPath);
  const PDF_ROUTE = "/__doc__.pdf";
  const srv = http.createServer((req, res) => {
    let url = req.url.split("?")[0];
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><script src="/pdf.min.js"></script></head><body>pdfjs ready</body></html>`);
      return;
    }
    if (url === "/pdf.min.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      fs.createReadStream(PDFJS).pipe(res);
      return;
    }
    if (url === "/pdf.worker.min.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      fs.createReadStream(WORKER).pipe(res);
      return;
    }
    if (url === PDF_ROUTE) {
      res.writeHead(200, { "content-type": "application/pdf", "content-length": fs.statSync(pdfPath).size });
      fs.createReadStream(pdfPath).pipe(res);
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;

  const PORT = 9900 + Math.floor(Math.random() * 80);
  const profile = fs.mkdtempSync(path.join(pickTmpRoot("pdfc"), "pdfc-"));
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--no-sandbox", "--disable-setuid-sandbox", "--ignore-certificate-errors",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "about:blank"]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 回收 Chrome **并删除它的 user-data-dir**（一个 profile ≈ 200MB）。
  // 2026-10-26：之前只 kill 不删 → 累积 317 个孤儿目录、4.7GB，把系统盘写满。
  const kill = () => {
    try { chrome.kill(); } catch {}
    // Windows：只杀父 Chrome 的话，renderer/GPU 子进程会留着并锁住 profile → 删不掉。
    try {
      if (chrome.pid) {
        spawnSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"],
          { stdio: "ignore", timeout: 10000, windowsHide: true });
      }
    } catch (e) { /* 忽略 */ }
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 1, retryDelay: 50 }); } catch {}
  };
  process.on("exit", kill);
  // 退避重试删除 Chrome profile（Windows 上 Chrome 子进程退出有延迟，会短暂锁住文件）
  const rmProfile = async () => {
    for (let i = 0; i < 10; i++) {
      try {
        if (!fs.existsSync(profile)) return true;
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 });
        if (!fs.existsSync(profile)) return true;
      } catch (e) { /* 文件还被占用 → 退避后重试 */ }
      await sleep(300);
    }
    return false;
  };

  let wsUrl = null;
  for (let i = 0; i < 80; i++) {
    try { const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); wsUrl = j.webSocketDebuggerUrl; if (wsUrl) break; } catch {}
    await sleep(250);
  }
  const ws = new WebSocket(wsUrl);
  let id = 0; const pending = new Map();
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (method, params = {}, sessionId) => {
    const mid = ++id; ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((r) => pending.set(mid, r));
  };
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const evaluate = async (sid, expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sid);
    if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text };
    return { value: r.result?.result?.value };
  };

  const { result: t2 } = await send("Target.createTarget", { url: `http://127.0.0.1:${port}/` });
  const { result: a2 } = await send("Target.attachToTarget", { targetId: t2.targetId, flatten: true });
  const SID = a2.sessionId;
  await send("Runtime.enable", {}, SID);
  await send("Page.enable", {}, SID);
  // 等待 pdf.js 加载
  let ready = false;
  for (let i = 0; i < 60; i++) {
    const r = await evaluate(SID, "typeof pdfjsLib");
    if (r.value === "object" || r.value === "function") { ready = true; break; }
    await sleep(250);
  }
  if (!ready) {
    kill();
    await sleep(500);
    await rmProfile();
    srv.close();
    return { error: "pdf.js 未加载" };
  }

  const fileUrl = `http://127.0.0.1:${port}/__doc__.pdf`;
  const expr = `(async()=>{
    try{
      pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";
      const doc = await pdfjsLib.getDocument(${JSON.stringify(fileUrl)}).promise;
      const pages = [];
      const n = Math.min(doc.numPages, ${maxPages});
      for(let i=1;i<=n;i++){
        const p = await doc.getPage(i);
        const tc = await p.getTextContent();
        const txt = tc.items.map(it => (it.str || "") + (it.hasEOL ? "\\n" : " ")).join("");
        pages.push({page:i, text:txt});
      }
      return {numPages: doc.numPages, pages};
    }catch(e){ return {err: String(e && e.message || e)}; }
  })()`;
  const r = await evaluate(SID, expr);

  kill();
  await sleep(500);                       // 等 Chrome 释放 profile 文件句柄（Windows 上锁着删不掉）
  await rmProfile();                      // 退避重试删干净
  srv.close();
  if (r.error) return { error: r.error };
  if (r.value && r.value.err) return { error: r.value.err };
  return r.value;
}

// CLI 用法
if (process.argv[1] && process.argv[1].endsWith("pdf_extract.mjs")) {
  const file = process.argv[2];
  const kw = process.argv.slice(3);
  const res = await extractPdfText(file, { maxPages: 80 });
  if (res.error) { console.log("ERROR:", res.error); process.exit(1); }
  console.log("总页数:", res.numPages, " 已提取页:", res.pages.length);
  for (const p of res.pages) {
    if (!kw.length || kw.some((k) => p.text.includes(k))) {
      console.log(`\n=========== 第 ${p.page} 页 ===========`);
      console.log(p.text.slice(0, 2600));
    }
  }
  process.exit(0);
}

// 复用常驻 JShield 签名器（spawn --serve 模式，JSON-lines 协议）
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pickTmpRoot } from "./cache_root.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let proc = null;
let buf = "";
const waiters = [];

// pickTmpRoot 已迁至 ./cache_root.mjs（缓存根移到项目外的 网商银行cache）。

// 2026-10-26：Chrome 的 user-data-dir（约 150~200MB）由【父进程】创建并负责删除。
// 原因（实测）：本机父进程退出时，Windows 会把整棵进程树直接终止 —— 子进程收不到 stdin EOF、
// 也跑不了 exit 处理器（已用 _probe/eof_test.mjs 验证：父退出后子进程什么都没做），
// 所以「让子进程自己删」行不通；只能由父进程持有路径并在退出时清理。
let profileDir = null;
function ensureProfile() {
  if (!profileDir) profileDir = fs.mkdtempSync(path.join(pickTmpRoot("jsign-"), "jsign-"));
  return profileDir;
}
function cleanupProfile() {
  if (!profileDir) return;
  const p = profileDir;
  profileDir = null;
  // Windows 上 Chrome 的子进程退出有延迟 → rmSync 自带的 maxRetries 不够时再补几轮退避重试
  for (let i = 0; i < 10; i++) {
    try {
      if (!fs.existsSync(p)) return;
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      if (!fs.existsSync(p)) return;
    } catch (e) { /* 文件还被占用 → 退避后重试 */ }
    sleepSync(250);
  }
}
// 同步退避（exit/SIGTERM 处理器里不能 await）
function sleepSync(ms) {
  try {
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, ms);
  } catch (e) { /* 忽略 */ }
}

// kill 子进程连同它的 Chrome 整棵树（只杀父 Chrome 的话，renderer/GPU 会继续锁住 profile）
function killSignerTree() {
  try {
    if (proc && proc.pid) {
      spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"],
        { stdio: "ignore", timeout: 15000, windowsHide: true });
    }
  } catch (e) { /* 忽略 */ }
}

process.on("exit", () => {
  killSignerTree();
  cleanupProfile();
});

// ⚠ process.on("exit") 在 SIGTERM 下【不会执行】——Node 对 SIGTERM 的默认动作是直接终止进程。
// serve.mjs 被 Ctrl-C / 任务管理器结束、或被 e2e 脚本 kill() 时都走 SIGTERM，
// 于是 profile 就留在磁盘上（实测每次 92MB）。所以这里必须显式装 SIGTERM/SIGINT 处理器。
const bye = () => { killSignerTree(); cleanupProfile(); process.exit(0); };
process.on("SIGTERM", bye);
process.on("SIGINT", bye);

function boot() {
  if (proc) return proc;
  const profile = ensureProfile();
  proc = spawn(process.execPath, [path.join(HERE, "jshield_signer.mjs"), "--serve"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, JSIGN_PROFILE_DIR: profile },   // profile 由父进程持有 → 父进程负责删
  });
  proc.on("exit", (code) => {
    // 进程退出时拒绝所有挂起的等待，避免连锁超时
    while (waiters.length) {
      const w = waiters.shift();
      w.reject(new Error("jshield signer exited (code=" + code + ")"));
    }
    proc = null;
    cleanupProfile();          // 子进程没了，它那份 profile 也用不着了 → 立即回收
  });
  // 父进程 stdin 关闭（父已死）→ 子进程自杀，避免孤儿
  proc.stdin.on("error", () => { try { proc && proc.stdin.end(); } catch {} });
  proc.stdout.on("data", (c) => {
    buf += c.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let job;
      try { job = JSON.parse(line); } catch { continue; }
      const w = waiters.shift();
      if (w) w.resolve(job);
    }
  });
  proc.stderr.on("data", (c) => process.stderr.write("[jsign] " + c.toString()));
  return proc;
}

function request(payload, attempt = 0) {
  const p = boot();
  let timer = null;
  const promise = new Promise((resolve, reject) => {
    const w = { resolve, reject };
    waiters.push(w);
    timer = setTimeout(async () => {
      // 从队列中摘掉自己，避免污染后续请求
      const i = waiters.indexOf(w);
      if (i >= 0) waiters.splice(i, 1);
      if (attempt === 0) {
        // 自愈：签名器卡死时重启并重试一次
        // 用 stdin.end() 而不是 kill()：Windows 上 kill 是强制终止，子进程来不及删自己的
        // Chrome profile（~150MB）→ 残留堆积。stdin EOF 走子进程的优雅收尾路径。
        try { if (proc) proc.stdin.end(); } catch {}
        proc = null;
        try {
          const r2 = await request(payload, 1);
          resolve(r2);
          return;
        } catch (e) {
          reject(e);
          return;
        }
      }
      reject(new Error("jshield sign timeout"));
    }, 20000);
  }).finally(() => clearTimeout(timer));
  p.stdin.write(JSON.stringify(payload) + "\n");
  return promise;
}

/** 对 md5 字符串求 x-sign */
export async function apSign(md5hex, appName = "MyBankH5Main", bizToken = "W3g6PvhSk11pFCmtGKQWavpk") {
  const r = await request({ md5: md5hex, appName, bizToken });
  if (!r || r.err) throw new Error("jshield sign failed: " + JSON.stringify(r));
  return r.sign;
}

/** 对任意 JSON 值签名（h5WebSign 用法） */
export async function apSignJson(jsonText, appName = "WECHAT_TINY_H5_MYBANK", bizToken = "W3g6PvhSk11pFCmtGKQWavpk") {
  const r = await request({ json: jsonText, appName, bizToken });
  if (!r || r.err) throw new Error("jshield sign failed: " + JSON.stringify(r));
  return r.sign;
}

/** 对任意 JS 值（对象 / 数组 / 字符串）签名 —— 自动 JSON 编码 */
export async function apSignValue(value, appName = "WECHAT_TINY_H5_MYBANK", bizToken = "W3g6PvhSk11pFCmtGKQWavpk") {
  const r = await request({ value: JSON.stringify(value), appName, bizToken });
  if (!r || r.err) throw new Error("jshield sign failed: " + JSON.stringify(r));
  return r.sign;
}

export function closeSigner() {
  try { if (proc) proc.kill(); } catch {}
  proc = null;
}

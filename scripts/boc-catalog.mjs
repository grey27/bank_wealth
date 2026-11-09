/**
 * 中国银行理财产品库：以官网「当日代销理财产品净值」为来源，
 * 把产品代码补进 产品数据.json 的中国银行（boc）目录。
 *
 * 页面：https://www.bankofchina.com/sourcedb/srfd6_2024/
 * 分页：index.html、index_1.html …（页数以页面里的 createPageHTML 为准）
 *
 * 只收录「截止日期」为昨天的行。当天披露往往不完整，更早的历史行不入库。
 * 已在目录里的代码不会改银行、不会改用户填过的持有天数。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG_FILE = path.join(ROOT, "产品数据.json");
const CATALOG_BAK = path.join(ROOT, "产品数据.备份.json");
const LOG_FILE = path.join(ROOT, "中行产品库日志.jsonl");
const SOURCE = "https://www.bankofchina.com/sourcedb/srfd6_2024/";
const BANK = "boc";

function normCode(code) {
  return String(code || "").trim().toUpperCase();
}
function decodeEntities(s) {
  return String(s || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
function cleanText(s) {
  return decodeEntities(String(s || "").replace(/<[^>]*>/g, ""))
    .replace(/[<>"'&]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function guessManager(name) {
  const m = String(name || "").match(/([\u4e00-\u9fa5]{2,10}理财)/);
  return m ? m[1] : "";
}

export function normalizeNavDate(s) {
  const m = String(s || "").match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (!m) return "";
  return m[1] + "-" + m[2].padStart(2, "0") + "-" + m[3].padStart(2, "0");
}

export function shanghaiYesterday(now = new Date()) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  const [y, m, d] = today.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  utc.setUTCDate(utc.getUTCDate() - 1);
  return utc.toISOString().slice(0, 10);
}

export function parseBocNavHtml(html) {
  const rows = [];
  const trRe = /<tr[\s\S]*?<\/tr>/gi;
  let m;
  while ((m = trRe.exec(html))) {
    const cells = [...m[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => cleanText(x[1]));
    if (cells.length < 2) continue;
    const code = normCode(cells[0]);
    if (!code || code === "产品代码") continue;
    const name = (cells[1] || "").slice(0, 80);
    const asOf = normalizeNavDate(cells[7] || "");
    rows.push({ code, name, asOf });
  }
  const page = html.match(/createPageHTML\(\s*(\d+)\s*,\s*(\d+)/);
  return {
    rows,
    pageCount: page ? Number(page[1]) : 1,
    pageIndex: page ? Number(page[2]) : 0,
  };
}

function pageUrl(index) {
  if (index <= 0) return SOURCE + "index.html";
  return SOURCE + "index_" + index + ".html";
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; bank-wealth-boc-catalog/1.0)" },
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPage(index) {
  const url = pageUrl(index);
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const html = await fetchText(url);
      return { url, ...parseBocNavHtml(html) };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  throw new Error(url + " " + ((lastErr && lastErr.message) || lastErr));
}

function readRegFile(filePath) {
  const name = path.basename(filePath);
  const text = fs.readFileSync(filePath, "utf8");
  if (!text.trim()) throw new Error(name + " 是空的，没读到产品目录");
  let j;
  try { j = JSON.parse(text); }
  catch (e) { throw new Error(name + " 内容不完整：" + ((e && e.message) || e)); }
  let reg = j && j.data ? j.data.observer_reg_v1 : null;
  if (typeof reg === "string") {
    if (!reg.trim()) reg = null;
    else {
      try { reg = JSON.parse(reg); }
      catch (e) { throw new Error(name + " 里的产品目录不完整：" + ((e && e.message) || e)); }
    }
  }
  if (!reg || typeof reg !== "object") reg = {};
  if (!Array.isArray(reg.custom)) reg.custom = [];
  if (!reg.patches || typeof reg.patches !== "object") reg.patches = {};
  if (!Array.isArray(reg.hidden)) reg.hidden = [];
  return { file: j, reg };
}

export async function fetchBocShelf(asOf) {
  const target = asOf || shanghaiYesterday();
  const byCode = new Map();
  const errors = [];
  let pageCount = 1;
  let pagesRead = 0;
  for (let i = 0; i < pageCount && i < 40; i++) {
    let page;
    try {
      page = await fetchPage(i);
    } catch (e) {
      errors.push(String((e && e.message) || e));
      break;
    }
    pagesRead++;
    if (i === 0) pageCount = Math.max(1, Math.min(page.pageCount || 1, 500));
    let newest = "";
    for (const row of page.rows) {
      if (row.asOf && row.asOf > newest) newest = row.asOf;
      if (row.asOf !== target) continue;
      if (!byCode.has(row.code)) byCode.set(row.code, row);
      else if (!byCode.get(row.code).name && row.name) byCode.set(row.code, row);
    }
    // 列表从新到旧。整页都早于昨天，后面的历史页不用再翻。
    if (newest && newest < target) break;
  }
  return { asOf: target, pageCount, pagesRead, products: [...byCode.values()], errors };
}

function readCatalog() {
  return readRegFile(CATALOG_FILE);
}

function writeCatalog(file, reg) {
  const data = Object.assign({}, (file && file.data) || {});
  delete reg.deleted;
  data.observer_reg_v1 = JSON.stringify({
    custom: reg.custom,
    patches: reg.patches || {},
    hidden: reg.hidden || [],
  });
  const out = {
    savedAt: new Date().toISOString(),
    port: file.port || 8766,
    kind: file.kind || "core",
    label: file.label || "产品目录与偏好",
    count: Object.keys(data).length,
    data,
  };
  const tmp = CATALOG_FILE + ".tmp-" + process.pid + "-" + Date.now();
  try {
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), "utf8");
    fs.renameSync(tmp, CATALOG_FILE);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (err) { /* 临时文件可能已被换走 */ }
    throw e;
  }
  try { fs.copyFileSync(CATALOG_FILE, CATALOG_BAK); } catch (e) { /* 备份失败不阻断 */ }
}

function appendLog(entry) {
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n", "utf8");
}

export async function syncBocCatalog() {
  const started = Date.now();
  const at = new Date().toISOString();
  const shelf = await fetchBocShelf();
  const { file, reg } = readCatalog();
  let removedHistory = 0;
  try {
    const prev = readRegFile(CATALOG_BAK);
    // 上次误把全部历史页写进了目录。备份仍是误导入之前的目录时，先收回那些代码。
    if (prev.reg.custom.length < 500 && reg.custom.length > 1000) {
      removedHistory = reg.custom.length - prev.reg.custom.length;
      reg.custom = prev.reg.custom;
      reg.patches = prev.reg.patches;
      reg.hidden = prev.reg.hidden;
    }
  } catch (e) { /* 没有备份就只追加昨天的新代码 */ }
  const existing = new Map();
  for (const item of reg.custom) {
    if (item && item.code) existing.set(normCode(item.code), item);
  }
  const patchCodes = new Set(Object.keys(reg.patches || {}).map(normCode));
  const hidden = new Set((reg.hidden || []).map(normCode));
  const added = [];
  const renamed = [];
  let skippedOther = 0;
  let skippedSame = 0;
  let skippedHidden = 0;
  let invalid = 0;
  for (const row of shelf.products) {
    const code = normCode(row.code);
    if (!/^[A-Z0-9_-]{1,32}$/.test(code)) { invalid++; continue; }
    if (hidden.has(code)) { skippedHidden++; continue; }
    const name = row.name || code;
    const cur = existing.get(code);
    if (cur) {
      if (cur.bank && cur.bank !== BANK) { skippedOther++; continue; }
      if (row.name && cur.name !== row.name) {
        cur.name = row.name.slice(0, 80);
        const mgr = guessManager(cur.name);
        if (mgr) cur.manager = mgr;
        renamed.push(code);
      } else skippedSame++;
      continue;
    }
    if (patchCodes.has(code)) { skippedOther++; continue; }
    reg.custom.push({
      bank: BANK,
      code,
      name,
      manager: guessManager(name),
      term: "daily",
      termDays: 1,
      risk: "R2",
      established: "",
      target: 0.028,
      confirm: null,
      stock: "",
      quota: "",
      benchmark: "—",
    });
    existing.set(code, reg.custom[reg.custom.length - 1]);
    added.push(code);
  }
  const changed = added.length > 0 || renamed.length > 0 || removedHistory > 0;
  if (changed) writeCatalog(file, reg);
  const entry = {
    at,
    ok: shelf.errors.length === 0,
    source: SOURCE,
    asOf: shelf.asOf,
    pages: shelf.pagesRead,
    fetched: shelf.products.length,
    added: added.length,
    removedHistory,
    renamed: renamed.length,
    skippedSame,
    skippedOther,
    skippedHidden,
    invalid,
    pageErrors: shelf.errors,
    elapsedMs: Date.now() - started,
    addedSample: added.slice(0, 30),
    renamedSample: renamed.slice(0, 30),
    note: "只收录截止日期为昨天的产品。当天数据不完整，更早的历史不入库。持有天数页面没有，新代码暂记 1 天。",
  };
  appendLog(entry);
  const line = "[boc-catalog] 截止日期 " + shelf.asOf
    + " 翻页 " + shelf.pagesRead
    + " 命中 " + shelf.products.length
    + " 新增 " + added.length
    + " 收回历史误导入 " + removedHistory
    + " 改名 " + renamed.length
    + " 已存在 " + skippedSame
    + " 其它银行已有 " + skippedOther
    + " 失败页 " + shelf.errors.length
    + " 用时 " + (entry.elapsedMs / 1000).toFixed(1) + "s";
  console.log(line);
  if (shelf.errors.length) console.warn("[boc-catalog] 失败页：" + shelf.errors.slice(0, 5).join(" | "));
  return entry;
}

export function startBocCatalogSchedule() {
  let lastSuccessDay = "";
  let running = false;
  let nextAllowed = 0;
  const dayKey = () => new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const minutes = () => {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date());
    const h = Number(parts.find((p) => p.type === "hour").value);
    const m = Number(parts.find((p) => p.type === "minute").value);
    return h * 60 + m;
  };
  const tick = async () => {
    if (running || Date.now() < nextAllowed) return;
    if (minutes() < 7 * 60 + 30) return;
    const day = dayKey();
    if (lastSuccessDay === day) return;
    running = true;
    try {
      const r = await syncBocCatalog();
      if (r && r.pageErrors && r.pageErrors.length === 0) lastSuccessDay = day;
      else nextAllowed = Date.now() + 30 * 60 * 1000;
    } catch (e) {
      const entry = { at: new Date().toISOString(), ok: false, error: String((e && e.message) || e), source: SOURCE };
      try { appendLog(entry); } catch (err) {}
      console.warn("[boc-catalog] 更新失败：" + entry.error);
      nextAllowed = Date.now() + 30 * 60 * 1000;
    } finally {
      running = false;
    }
  };
  setInterval(tick, 60 * 1000);
  setTimeout(tick, 8000);
  console.log("[boc-catalog] 已排程：每天 07:30（北京时间）之后更新中国银行产品库，日志 " + path.basename(LOG_FILE));
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  syncBocCatalog().then((r) => {
    if (r.pageErrors && r.pageErrors.length) process.exitCode = 1;
  }).catch((e) => {
    console.error("[boc-catalog] " + ((e && e.message) || e));
    process.exitCode = 1;
  });
}

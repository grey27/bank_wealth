/**
 * 中国银行理财产品库：以 e.boc.cn 代销产品查询为准，
 * 把符合筛选条件的产品补进 产品数据.json 的中国银行（boc）目录。
 *
 * 接口：POST https://e.boc.cn/ezcms/finance/v1/query
 * 条件：在售、存续期内、代销理财、个人客户、每日申赎或每日申购定期赎回、低风险或中低风险。
 * 分页：start/rows，每页 100，按 totalNum 翻完。
 *
 * 已在其它银行名下的代码不改银行。这次查询里没有的中行产品会从目录去掉。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG_FILE = path.join(ROOT, "产品数据.json");
const CATALOG_BAK = path.join(ROOT, "产品数据.备份.json");
const LOG_FILE = path.join(ROOT, "中行产品库日志.jsonl");
const SOURCE = "https://e.boc.cn/ezcms/finance/v1/query";
const BANK = "boc";
const PAGE_ROWS = 100;
const QUERY_FILTERS = [
  { key: "productSalesStatus", value: ["在售"] },
  { key: "productSurvivalStatus", value: ["存续期内"] },
  { key: "productType", value: ["代销理财产品"] },
  { key: "salesTarget", value: ["个人客户", "YYY", "YYN", "YNY", "YNN"] },
  { key: "term", value: ["每日申购，定期赎回", "每日申赎"] },
  { key: "riskLevel", value: ["低风险", "中低风险"] },
];
const RISK_OF = { "低风险": "R1", "中低风险": "R2", "中风险": "R3", "中高风险": "R4", "高风险": "R5" };

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

function issuerShort(s) {
  const t = cleanText(s);
  const m = t.match(/([\u4e00-\u9fa5]{2,12}理财)/);
  return m ? m[1] : t.slice(0, 20);
}

function termKey(days) {
  const table = { 1: "daily", 7: "7d", 14: "14d", 30: "30d", 90: "90d", 182: "halfyear" };
  return table[days] || "daily";
}

function holdDaysOf(name, term) {
  const m = String(name || "").match(/(\d+)\s*天/);
  if (m) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 3650) return n;
  }
  return 1;
}

export function mapBocProduct(it) {
  const code = normCode(it && it.productCode);
  const name = cleanText(it && it.productName).slice(0, 80);
  const termDays = holdDaysOf(name, it && it.term);
  const established = String((it && it.productSurvivalStartTime) || "");
  return {
    code,
    name,
    manager: issuerShort(it && it.issuingInstitution) || guessManager(name),
    term: termKey(termDays),
    termDays,
    risk: RISK_OF[it && it.riskLevel] || "R2",
    established: /^\d{4}-\d{2}-\d{2}$/.test(established) ? established : "",
  };
}

async function fetchQueryPage(start) {
  const body = {
    system: "dxcp",
    ftype: "ALL",
    start,
    rows: PAGE_ROWS,
    query: QUERY_FILTERS,
    sort: {},
    count: "true",
  };
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const resp = await fetch(SOURCE, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Accept": "application/json, text/plain, */*",
          "Content-Type": "application/json",
          "Origin": "https://e.boc.cn",
          "Referer": "https://e.boc.cn/ezcms/if/ifwb.html",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
          "Cookie": "ariaappid=f0d4a7cfca52bd27ee5dbb3fdd55756e; ariauseGraymode=false",
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const j = await resp.json();
      const data = j && j.data;
      if (!j || j.success === false || !data || data.status !== "SUCCESS" || !Array.isArray(data.result)) {
        throw new Error((j && (j.errorMsg || (data && data.msg))) || "查询失败");
      }
      return { total: Number(data.totalNum) || 0, result: data.result };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 400 * attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("start=" + start + " " + ((lastErr && lastErr.message) || lastErr));
}

export async function fetchBocShelf() {
  const byCode = new Map();
  const errors = [];
  let total = 0;
  let pagesRead = 0;
  let rowsFetched = 0;
  for (let start = 0; pagesRead < 40; start += PAGE_ROWS) {
    let page;
    try {
      page = await fetchQueryPage(start);
    } catch (e) {
      errors.push(String((e && e.message) || e));
      break;
    }
    pagesRead++;
    total = page.total;
    rowsFetched += page.result.length;
    for (const it of page.result) {
      const row = mapBocProduct(it);
      if (!row.code) continue;
      if (!byCode.has(row.code)) byCode.set(row.code, row);
      else if (!byCode.get(row.code).name && row.name) byCode.set(row.code, row);
    }
    if (!page.result.length || page.result.length < PAGE_ROWS || (total && rowsFetched >= total)) break;
    await new Promise((r) => setTimeout(r, 80));
  }
  const products = [...byCode.values()];
  const complete = errors.length === 0 && total > 0 && rowsFetched === total && products.length > 0;
  return { total, pagesRead, rowsFetched, products, errors, complete };
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

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readCatalog() {
  let lastErr = null;
  for (let i = 0; i < 4; i++) {
    try { return readRegFile(CATALOG_FILE); }
    catch (e) { lastErr = e; sleepSync(40 * (i + 1)); }
  }
  let bak;
  try { bak = readRegFile(CATALOG_BAK); }
  catch (e) { throw lastErr || e; }
  const tmp = CATALOG_FILE + ".tmp-" + process.pid + "-" + Date.now();
  try {
    fs.writeFileSync(tmp, fs.readFileSync(CATALOG_BAK));
    fs.renameSync(tmp, CATALOG_FILE);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (err) { /* 临时文件可能已被换走 */ }
    throw lastErr || e;
  }
  console.warn("[boc-catalog] " + ((lastErr && lastErr.message) || "产品数据.json 读失败") + "，已用备份恢复");
  return bak;
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
  if (!shelf.complete) {
    throw new Error("分页不完整，拿到 " + shelf.rowsFetched + " / " + shelf.total
      + (shelf.errors.length ? "：" + shelf.errors[0] : ""));
  }
  const { file, reg } = readCatalog();
  const wanted = new Set(shelf.products.map((row) => row.code));
  const removedStale = [];
  reg.custom = reg.custom.filter((item) => {
    if (!item || !item.code) return false;
    if (item.bank === BANK && !wanted.has(normCode(item.code))) {
      removedStale.push(normCode(item.code));
      return false;
    }
    return true;
  });
  const existing = new Map();
  for (const item of reg.custom) {
    if (item && item.code) existing.set(normCode(item.code), item);
  }
  const patchCodes = new Set(Object.keys(reg.patches || {}).map(normCode));
  const hidden = new Set((reg.hidden || []).map(normCode));
  const added = [];
  const updated = [];
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
      const before = JSON.stringify([cur.name, cur.manager, cur.risk, cur.term, cur.termDays, cur.established]);
      if (name) cur.name = name;
      if (row.manager) cur.manager = row.manager;
      if (row.risk) cur.risk = row.risk;
      if (row.termDays) { cur.termDays = row.termDays; cur.term = row.term || termKey(row.termDays); }
      if (row.established) cur.established = row.established;
      if (JSON.stringify([cur.name, cur.manager, cur.risk, cur.term, cur.termDays, cur.established]) !== before) updated.push(code);
      else skippedSame++;
      continue;
    }
    if (patchCodes.has(code)) { skippedOther++; continue; }
    reg.custom.push({
      bank: BANK,
      code,
      name,
      manager: row.manager || guessManager(name),
      term: row.term || "daily",
      termDays: row.termDays || 1,
      risk: row.risk || "R2",
      established: row.established || "",
      target: 0.028,
      confirm: null,
      stock: "",
      quota: "",
      benchmark: "—",
    });
    existing.set(code, reg.custom[reg.custom.length - 1]);
    added.push(code);
  }
  const changed = added.length > 0 || updated.length > 0 || removedStale.length > 0;
  if (changed) writeCatalog(file, reg);
  const entry = {
    at,
    ok: true,
    source: SOURCE,
    total: shelf.total,
    pages: shelf.pagesRead,
    fetched: shelf.products.length,
    added: added.length,
    updated: updated.length,
    removedStale: removedStale.length,
    skippedSame,
    skippedOther,
    skippedHidden,
    invalid,
    pageErrors: shelf.errors,
    elapsedMs: Date.now() - started,
    addedSample: added.slice(0, 30),
    updatedSample: updated.slice(0, 30),
    removedSample: removedStale.slice(0, 30),
    note: "在售、存续期内、代销、个人客户、每日申赎或每日申购定期赎回、低风险或中低风险。分页拉全后才写入。名称里没有“N天”的，持有天数暂记 1。",
  };
  appendLog(entry);
  const line = "[boc-catalog] 共 " + shelf.total
    + " 翻页 " + shelf.pagesRead
    + " 命中 " + shelf.products.length
    + " 新增 " + added.length
    + " 更新 " + updated.length
    + " 移除过期 " + removedStale.length
    + " 已存在 " + skippedSame
    + " 其它银行已有 " + skippedOther
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

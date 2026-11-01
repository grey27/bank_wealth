/* ==========================================================================
 * GitHub Actions runner 批量补全「网商银行(mybank)代销产品」的说明书七字段：
 * 登记编码 / 发行银行 / 产品名称 / 风险 / 最短持有天数 / 成立日 / 业绩比较基准。
 *
 * 为什么需要它：Cloudflare Worker 线上禁 WASM、无法起 Chrome，跑不了网商
 * APSign 签名 + PDF 提取链路；而网商代销产品（光大/招银/工银…）的净值只能
 * 靠登记编码走中国理财网兜底。本脚本在带 Chrome 的 runner 上复用本机同款
 * deliver/mybank_manual_lookup.mjs 抠码，把结果写回 净值数据.json 的
 * observer_lookup_real[code]（前端 MULTI_REAL 读取），由 Pages 以同源 JSON
 * 提供给前端，使「线上添加网商产品」也能自动获得登记编码等七字段。
 *
 * 运行：node scripts/fetch-mybank-manual.mjs   （cwd = 仓库根，含 deliver/ 与 净值数据.json）
 * 环境变量：CHROME_BIN（runner 上的 Chrome 路径）、MYBANK_CACHE_DIR（临时目录根）
 *
 * 与 jsb-fetch 的关系：jsb-fetch 写回的是「净值序列」；本脚本写回的是「七字段
 * 元数据」，二者作用于同一张 observer_lookup_real 表的不同字段，互不冲突。
 * ========================================================================== */
import fs from "node:fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const NAV_FILE = path.join(ROOT, "净值数据.json");
const REG_FILE = path.join(ROOT, "产品数据.json");
const MYBANK = "mybank";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 解析 registry，收集 bank=mybank 的产品码 + 静态字段 ---------- */

// observer_reg_v1 可能是「内层 JSON 字符串」（双层编码），逐级解析
function safeParseReg(raw) {
  let v = raw;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch (e) { return null; }
  }
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch (e) { return null; }
  }
  return v;
}

function collectMybankCodes() {
  const map = {}; // code -> { name, manager }
  let p;
  try { p = JSON.parse(fs.readFileSync(REG_FILE, "utf8")); } catch (e) { console.warn("[mybank-manual] 注册表解析失败：" + e.message); return map; }
  const reg = safeParseReg(p.data && p.data.observer_reg_v1);
  if (!reg) { console.warn("[mybank-manual] 未发现 observer_reg_v1，回退全文扫描"); }
  const custom = reg ? reg.custom : null;
  const arr = Array.isArray(custom) ? custom : Object.values(custom || {});
  const items = [];
  const flatten = (x, out) => {
    if (Array.isArray(x)) x.forEach((y) => flatten(y, out));
    else if (x && typeof x === "object") out.push(x);
  };
  arr.forEach((x) => flatten(x, items));
  for (const r of items) {
    if (!r || typeof r !== "object") continue;
    const bank = r.bank || "";
    const agent = r.agent || "";
    if (bank !== MYBANK && agent !== MYBANK) continue;
    const code = String(r.code || "").toUpperCase();
    if (!code) continue;
    map[code] = { name: r.name || null, manager: r.manager || null };
  }
  return map;
}

/* ---------- 把抠到的七字段并入 observer_lookup_real 记录 ---------- */

function mergeManualIntoRecord(prev, info) {
  const obj = prev ? Object.assign({}, prev) : {};
  if (info.name != null) obj.name = info.name;
  if (info.manager != null) obj.manager = info.manager;
  if (info.issuer != null) obj.issuer = info.issuer;       // 发行银行 key（cmb/ceb/icbc…）
  if (info.regCode != null) obj.regCode = info.regCode;
  if (info.risk != null) obj.risk = info.risk;
  if (info.holdDays != null) obj.holdDays = info.holdDays;
  if (info.established != null) obj.established = info.established;
  if (info.benchmark != null) obj.benchmark = info.benchmark;
  obj.bank = obj.bank || MYBANK;
  obj.lastSrcMode = "info"; // 标记来源为说明书（区别于 nav 抓取）
  return obj;
}

/* ---------- 主流程 ---------- */

async function main() {
  const t0 = Date.now();
  const codeMap = collectMybankCodes();
  const codes = Object.keys(codeMap);
  console.log("[mybank-manual] registry 中网商产品：" + codes.length + " 只");
  if (!codes.length) { console.log("[mybank-manual] 无网商产品，退出"); process.exit(0); }

  // 读取现有净值库（七字段也存于此处）
  let outer;
  try { outer = JSON.parse(fs.readFileSync(NAV_FILE, "utf8")); } catch (e) { console.error("[mybank-manual] 净值数据.json 解析失败：" + e.message); process.exit(1); }
  const realRaw = outer.data && outer.data.observer_lookup_real;
  const real = typeof realRaw === "string" ? JSON.parse(realRaw) : realRaw || {};

  const { mybankManualLookup } = await import(pathToFileURL(path.join(ROOT, "deliver", "mybank_manual_lookup.mjs")).href);

  let changed = false;
  const results = [];
  for (const code of codes) {
    const prev = real[code] || null;
    // 已有登记编码则跳过：避免重复抠（省时/省网商接口配额），也避免覆盖已有净值序列
    if (prev && prev.regCode) {
      results.push({ code, ok: "skip", reason: "已有登记编码" });
      continue;
    }
    let info = null;
    for (let attempt = 1; attempt <= 2 && !info; attempt++) {
      if (attempt > 1) { console.log("[mybank-manual] " + code + " 第" + attempt + "次重试"); await sleep(2000); }
      try {
        const r = await mybankManualLookup(code, 50000);
        if (r && r.ok && r.regCode) info = r;
        else if (r) console.warn("[mybank-manual] " + code + " 抠码失败：" + (r.error || "ok=false"));
      } catch (e) { console.warn("[mybank-manual] " + code + " 异常：" + (e && e.message)); }
    }
    if (!info) {
      results.push({ code, ok: false, reason: "未抠到登记编码" });
      console.warn("[mybank-manual] " + code + " 未抠到登记编码，跳过");
      continue;
    }
    real[code] = mergeManualIntoRecord(prev, info);
    changed = true;
    results.push({ code, ok: true, regCode: info.regCode, issuer: info.issuer, name: info.name });
    console.log("[mybank-manual] " + code + " ✓ 登记编码=" + info.regCode + " 发行行=" + (info.issuer || "-") + " 名称=" + (info.name || "-"));
  }

  // 关闭网商签名器（释放常驻 Chrome），避免进程挂起
  try {
    const { closeSigner } = await import(pathToFileURL(path.join(ROOT, "deliver", "jshield_client.mjs")).href);
    closeSigner();
  } catch (e) {}

  if (!changed) {
    const ms = ((Date.now() - t0) / 1000).toFixed(1);
    console.log("[mybank-manual] 完成：无新增需抠取的网商产品，跳过写盘，用时 " + ms + "s");
    console.log("[mybank-manual] 明细：" + JSON.stringify(results));
    return;
  }

  // 写回净值数据.json（保持外层结构；仅当七字段真正变化才写盘/更新 savedAt，避免无意义 commit）
  const prevRealStr = (outer.data && outer.data.observer_lookup_real) || "";
  const newRealStr = JSON.stringify(real);
  if (newRealStr === prevRealStr) {
    console.log("[mybank-manual] 完成：七字段无变化，跳过写盘");
    console.log("[mybank-manual] 明细：" + JSON.stringify(results));
    return;
  }
  outer.data = outer.data || {};
  outer.data.observer_lookup_real = newRealStr;
  outer.count = Object.keys(real).length;
  outer.savedAt = new Date().toISOString();
  fs.writeFileSync(NAV_FILE, JSON.stringify(outer), "utf8");
  const ms = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("[mybank-manual] 完成：写回 " + path.basename(NAV_FILE) + "，" + results.filter((r) => r.ok === true).length + " 只补全，用时 " + ms + "s");
  console.log("[mybank-manual] 明细：" + JSON.stringify(results));
}

main().catch((e) => {
  console.error("[mybank-manual] 致命错误：" + (e && e.stack || e));
  process.exit(1);
});

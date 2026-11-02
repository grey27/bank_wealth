/* ==========================================================================
 * 方案 B：GitHub Actions runner 批量抓取 江苏银行(jsb) + 光大银行(ceb) 净值，
 * 归一化为 observer_lookup_real 记录后写回 净值数据.json。
 *
 * 为什么需要它：Cloudflare Worker 线上无 Chrome，江苏/光大的 WAF/瑞数链路
 * 在 Worker 里恒失败，故线上永远抓不到这两家。本脚本在带 Chrome 的 runner 上
 * 用本机同款 puppeteer 方案直连抓取，结果提交进仓库，由 Pages 以同源 JSON 提供
 * 给前端（前端 applyGhaNavOverlay 读取并叠加，仅作用于 jsb/ceb，不影响其它银行）。
 *
 * 运行：node scripts/fetch-jsb-ceb.mjs   （cwd = 仓库根，含 scrape/ 与 净值数据.json）
 * 依赖：puppeteer-core（解析到 node_modules 或 WORKBUDDY 运行时）；系统 Chrome。
 * 环境变量：CEB_CHROME（ceb 在 Linux runner 上用，指定 /usr/bin/google-chrome）。
 * ========================================================================== */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const NAV_FILE = path.join(ROOT, "净值数据.json");
const REG_FILE = path.join(ROOT, "产品数据.json");
// 随仓库提交的小清单（仅 jsb/ceb 产品）：避免暴露/提交完整 registry，且显式可控。
// 新增 jsb/ceb 产品时，在此追加一条；缺省则回退解析 产品数据.json。
const MANIFEST_FILE = path.join(__dirname, "jsb-ceb-codes.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const JSB_BANK = "jsb";
const CEB_BANK = "ceb";

/* ---------- 工具：复刻前端 normalizeProductApi / adoptRealSeries ---------- */

// 8 位日期 → YYYY-MM-DD
const nd = (d) => {
  const s = String(d == null ? "" : d);
  return /^\d{8}$/.test(s) ? s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6, 8) : s;
};

// 合并净值序列（按日去重，新值覆盖，升序）；保留 3 元组 [date, unit, cum]
function mergeNavSeries(prevSeries, newSeries) {
  const norm = (s) =>
    (Array.isArray(s) ? s : [])
      .filter((p) => p && p[0] != null)
      .map((p) => [nd(p[0]), Number(p[1]), p[2] != null ? Number(p[2]) : null]);
  const prev = norm(prevSeries);
  const neu = norm(newSeries);
  if (!prev.length) return neu.slice().sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (!neu.length) return prev.slice().sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const map = new Map();
  for (const p of prev) map.set(p[0], p);
  for (const p of neu) map.set(p[0], p); // 新值覆盖
  return [...map.values()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// 业绩比较基准 ≤150 字（就近句末截断），与前端 trimBenchmark 一致
function trimBenchmark(s) {
  if (s == null) return null;
  s = String(s);
  if (s === "—" || s.trim() === "") return null;
  if (s.length <= 150) return s;
  const cut = s.slice(0, 150);
  const m = cut.match(/.*[。；;.\n]/);
  return m ? m[0] : cut;
}

// 把一次抓取结果 res 归一化为 observer_lookup_real 最终记录（复刻 adoptRealSeries 字段映射）
function normalizeToRecord(res, prev) {
  const isFin = (x) => x != null && isFinite(Number(x));
  const obj = {
    name: res.name || (prev && prev.name) || null,
    manager: res.manager || (prev && prev.manager) || null,
    kind: res.kind || "nav",
    series: mergeNavSeries(prev && prev.series, res.series),
    risk: res.risk != null ? res.risk : prev && prev.risk != null ? prev.risk : null,
    holdDays:
      res.holdDays != null ? res.holdDays : prev && prev.holdDays != null ? prev.holdDays : null,
    remainQuota: isFin(res.remainQuota)
      ? Number(res.remainQuota)
      : prev && isFin(prev.remainQuota)
      ? Number(prev.remainQuota)
      : null,
    remainQuotaPct:
      res.remainQuotaPct != null ? res.remainQuotaPct : prev && prev.remainQuotaPct != null ? prev.remainQuotaPct : null,
    saleStatus: res.saleStatus || (prev && prev.saleStatus) || null,
    currency: res.currency || (prev && prev.currency) || null,
    quotaState: res.quotaState || (prev && prev.quotaState) || null,
    quotaText: res.quotaText || (prev && prev.quotaText) || null,
    quotaManual: (prev && prev.quotaManual) || null,
    benchmark: res.benchmark != null ? trimBenchmark(res.benchmark) : prev && prev.benchmark != null ? prev.benchmark : null,
    benchmarkFull:
      res.benchmark != null
        ? res.benchmark
        : prev && (prev.benchmarkFull || prev.benchmark)
        ? prev.benchmarkFull || prev.benchmark
        : null,
    regCode: res.regCode != null ? res.regCode : prev && prev.regCode != null ? prev.regCode : null,
    established: res.established != null ? res.established : prev && prev.established != null ? prev.established : null,
    navVia: res.navVia || (prev && prev.navVia) || null,
    navPort: res.navPort != null ? res.navPort : prev && prev.navPort != null ? prev.navPort : null,
    navSources:
      Array.isArray(res.navSources) && res.navSources.length > 1
        ? res.navSources
        : prev && Array.isArray(prev.navSources) && prev.navSources.length > 1
        ? prev.navSources
        : null,
    lastSrcMode: "nav",
    lastSrcVia: res.navVia || (prev && prev.lastSrcVia) || null,
    lastSrcPort: res.navPort != null ? res.navPort : prev && prev.lastSrcPort != null ? prev.lastSrcPort : null,
    // 方案 B 标记：前端 applyGhaNavOverlay 仅叠加带 gha:true 的记录，绝不动其它银行
    bank: res.bank || (prev && prev.bank) || null,
    gha: true,
  };
  return obj;
}

/* ---------- 读取 registry，抽取 jsb/ceb 产品码 + 静态字段 ---------- */

function safeParseReg(raw) {
  // observer_reg_v1 是「内层 JSON 字符串」（可能双层编码）
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch (e) {
      return null;
    }
  }
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch (e) {
      return null;
    }
  }
  return v;
}

function collectJsbCebStatic() {
  const map = {}; // code -> { bank, name, manager, risk, holdDays, established, benchmark, regCode }
  // 优先用随仓库提交的小清单
  if (fs.existsSync(MANIFEST_FILE)) {
    try {
      const list = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8"));
      for (const r of list) {
        if (!r || (r.bank !== JSB_BANK && r.bank !== CEB_BANK)) continue;
        map[String(r.code).toUpperCase()] = {
          bank: r.bank,
          name: r.name || null,
          manager: r.manager || null,
          risk: r.risk != null ? r.risk : null,
          holdDays: parseHoldDays(r.term != null ? r.term : r.holdDays),
          established: r.established || null,
          benchmark: r.benchmark && r.benchmark !== "—" ? r.benchmark : null,
          regCode: r.regCode || null,
        };
      }
      console.log("[jsb-ceb] 使用清单 " + MANIFEST_FILE + "（" + Object.keys(map).length + " 条）");
      return map;
    } catch (e) {
      console.warn("[jsb-ceb] 清单解析失败，回退 registry：" + e.message);
    }
  }
  // 回退：解析 产品数据.json 的 observer_reg_v1.custom
  const p = JSON.parse(fs.readFileSync(REG_FILE, "utf8"));
  const reg = safeParseReg(p.data && p.data.observer_reg_v1);
  if (!reg) return map;
  const custom = reg.custom;
  const arr = Array.isArray(custom) ? custom : Object.values(custom || {});
  const flatten = (x, out) => {
    if (Array.isArray(x)) x.forEach((y) => flatten(y, out));
    else if (x && typeof x === "object") out.push(x);
  };
  const items = [];
  arr.forEach((x) => flatten(x, items));
  for (const r of items) {
    if (!r || typeof r !== "object") continue;
    if (r.bank === JSB_BANK || r.bank === CEB_BANK) {
      map[String(r.code).toUpperCase()] = {
        bank: r.bank,
        name: r.name || null,
        manager: r.manager || null,
        risk: r.risk != null ? r.risk : null,
        holdDays: parseHoldDays(r.term),
        established: r.established || null,
        benchmark: r.benchmark && r.benchmark !== "—" ? r.benchmark : null,
        regCode: r.regCode || null,
      };
    }
  }
  return map;
}

function parseHoldDays(term) {
  if (term == null) return null;
  if (String(term).trim() === "daily" || String(term).trim() === "每日开放") return 1;
  const m = String(term).match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

/* ---------- 主流程 ---------- */

async function main() {
  const t0 = Date.now();
  const staticMap = collectJsbCebStatic();
  const codes = Object.keys(staticMap);
  if (!codes.length) {
    console.error("[jsb-ceb] registry 中未发现任何 jsb/ceb 产品，退出");
    process.exit(0);
  }
  console.log("[jsb-ceb] 从 registry 发现待抓产品：" + codes.join(", "));

  // 读取现有净值库
  const outer = JSON.parse(fs.readFileSync(NAV_FILE, "utf8"));
  const realRaw = outer.data && outer.data.observer_lookup_real;
  const real = typeof realRaw === "string" ? JSON.parse(realRaw) : realRaw || {};

  // 动态导入抓取模块（本机/runner 均通过 puppeteer-core + 系统 Chrome）
  const jsbMod = await import(pathToFileURL(path.join(ROOT, "scrape", "jsb_app.mjs")).href);
  const cebMod = await import(pathToFileURL(path.join(ROOT, "scrape", "ceb_direct_nav.mjs")).href);

  const results = []; // { code, bank, ok, points, last }

  for (const code of codes) {
    const st = staticMap[code];
    const prev = real[code] || null;
    let res = null;
    // 单产品最多 3 次（jsb 共享种子页偶发会话抖动，ceb 静态页偶发无数据），与 serve.mjs /api/jsbapp 策略一致
    for (let attempt = 1; attempt <= 3 && !res; attempt++) {
      if (attempt > 1) {
        console.log("[jsb-ceb] " + code + " 第" + attempt + "次重试");
        await sleep(2500);
      }
      try {
        if (st.bank === JSB_BANK) {
          const out = await jsbMod.jsbAppByCode(code, { timeoutMs: 30000 });
          if (out) {
            res = { ...out, regCode: out.registryCode || st.regCode || null };
          }
        } else {
          const r = await cebMod.cebWebNav(code, { timeoutMs: 30000 });
          if (r && Array.isArray(r.navs) && r.navs.length) {
            const series = r.navs.map((n) => [n.date, n.nav, null]);
            res = {
              code,
              name: st.name || r.name || null,
              manager: r.manager || st.manager || null,
              risk: st.risk,
              holdDays: st.holdDays,
              established: st.established,
              benchmark: st.benchmark,
              regCode: st.regCode,
              series,
              kind: "nav",
              bank: CEB_BANK,
              navVia: "ceb-web",
              navPort: "web",
            };
          }
        }
      } catch (e) {
        console.warn("[jsb-ceb] " + code + " 抓取异常：" + (e && e.message));
      }
    }

    if (!res || !res.series || !res.series.length) {
      results.push({ code, bank: st.bank, ok: false });
      console.warn("[jsb-ceb] " + code + " 未取到净值，保留原记录（如有）");
      continue;
    }

    const obj = normalizeToRecord(res, prev);
    real[code] = obj;
    const last = obj.series[obj.series.length - 1];
    results.push({ code, bank: st.bank, ok: true, points: obj.series.length, last: last && last[0], nav: last && last[1] });
    console.log(
      "[jsb-ceb] " + code + " (" + st.bank + ") ✓ " + obj.series.length + " 点，最新 " + (last && last[0]) + " = " + (last && last[1])
    );
  }

  // 关闭浏览器，释放资源
  try { await jsbMod.closeJsbBrowser(); } catch (e) {}
  try { await cebMod.closeCebWebBrowser(); } catch (e) {}

  // 写回净值数据.json（保持外层 compact 结构）
  // 优化：仅当 jsb/ceb 净值内容真正变化时才写盘 / 更新 savedAt，
  // 避免每小时空跑产生无意义 commit（NAV 通常每日仅更新一次）
  const prevRealStr = (outer.data && outer.data.observer_lookup_real) || "";
  const newRealStr = JSON.stringify(real);
  outer.data = outer.data || {};
  outer.count = Object.keys(real).length;

  if (newRealStr === prevRealStr) {
    const okCount = results.filter((r) => r.ok).length;
    const ms = ((Date.now() - t0) / 1000).toFixed(1);
    console.log("[jsb-ceb] 完成：成功 " + okCount + "/" + results.length + "，用时 " + ms + "s，净值无变化，跳过写盘");
    console.log("[jsb-ceb] 明细：" + JSON.stringify(results));
    return;
  }

  outer.data.observer_lookup_real = newRealStr;
  outer.savedAt = new Date().toISOString();
  fs.writeFileSync(NAV_FILE, JSON.stringify(outer), "utf8");

  const okCount = results.filter((r) => r.ok).length;
  const ms = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("[jsb-ceb] 完成：成功 " + okCount + "/" + results.length + "，用时 " + ms + "s，已写回 " + path.basename(NAV_FILE));
  console.log("[jsb-ceb] 明细：" + JSON.stringify(results));
}

main().catch((e) => {
  console.error("[jsb-ceb] 致命错误：" + (e && e.stack || e));
  process.exit(1);
});

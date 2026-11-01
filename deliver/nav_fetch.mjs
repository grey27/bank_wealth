// ============================================================================
//  网商银行净值抓取器 —— 服务器端 / 无人值守 / 不依赖手机 / 不依赖登录态
// ----------------------------------------------------------------------------
//  数据源：仅网商银行（bkmobilegw.mybank.cn）→ 产品销售文件 CDN → 定期报告 PDF
//  能力：
//    navFetch(code)          任意产品码 → 净值序列（份额净值 / 累计净值 / 规模）
//    fetchReports(code)      拉取该码的全部「报告」类 PDF（定期报告 / 投资报告）
//    fetchProfile(code)      取产品销售文件清单（说明书 / 风险揭示书 / 公告 …）
//
//  链路：
//    1) queryFundProfiles（免登录，实测 rs=1000）→ 文档 URL 清单
//    2) 下载 PDF → headless Chrome + pdf.js 提取文本
//    3) 解析「期末产品份额净值 / 份额累计净值 / 资产净值」及净值日期
//
//  说明：这是「报告披露频率」的净值（季度/半年/年度），非逐日净值。
//        网商 mgw 网关在所有可服务器端复现的通道上对逐日净值接口
//        (decisionPageView*) 均强制会话校验，实测不可免登录。
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { fetchProductProfile } from "./netbank_client.mjs";
import { extractPdfText } from "./pdf_extract.mjs";

const REPORT_RE = /定期报告|投资报告|季度报告|年度报告|半年度报告|半年度投资报告|净值报告/;

function norm(s) {
  return s.replace(/[ \t\u00a0]+/g, " ").replace(/\n{2,}/g, "\n");
}

/** 从报告文本解析净值信息（兼容光大/上银/工银/招银等排版） */
export function parseNavFromText(text) {
  const t = norm(text);
  const res = { nav: null, cumNav: null, netAsset: null, shares: null, navDate: null, period: null, yields: {} };

  // A) 表格行：CODE 1.0364 1.0364 份额 资产净值
  const rm = t.match(/([A-Za-z0-9]{5,14})\s+([01]\.\d{3,6})\s+([01]\.\d{3,6})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})/);
  if (rm) {
    res.nav = rm[2];
    res.cumNav = rm[3];
    res.shares = rm[4];
    res.netAsset = rm[5];
  }
  const g = (re) => { const m = t.match(re); return m ? m[1] : null; };
  if (!res.nav) {
    res.nav = g(/份额净值\s*[（(]?元?\s*[）)]?\s*([\d.]+)/) ?? g(/单位净值\s*[（(]?元?\s*[）)]?\s*([\d.]+)/);
    res.cumNav = g(/份额累计净值\s*[（(]?元?\s*[）)]?\s*([\d.]+)/) ?? g(/累计净值\s*[（(]?元?\s*[）)]?\s*([\d.]+)/);
    res.netAsset = g(/资产净值\s*[（(]?元?\s*[）)]?\s*([\d,\.]+)/);
    res.shares = g(/(?:期末|报告期期末)?(?:产品)?(?:总)?份额(?:总额)?\s*([\d,\.]+)/);
  }
  const dm =
    t.match(/最后\s*一个市场交易日\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/) ||
    t.match(/报告日期\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/) ||
    t.match(/截止(?:日期)?\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/) ||
    t.match(/估值日\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (dm) res.navDate = `${dm[1]}-${dm[2].padStart(2, "0")}-${dm[3].padStart(2, "0")}`;
  const pm = t.match(/报告期\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*[-—~至]\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (pm) {
    res.period = {
      from: `${pm[1]}-${pm[2].padStart(2, "0")}-${pm[3].padStart(2, "0")}`,
      to: `${pm[4]}-${pm[5].padStart(2, "0")}-${pm[6].padStart(2, "0")}`,
    };
  }
  const ytd = t.match(/([A-Za-z0-9]{5,14})\s+([\d.]+)\s*%/);
  if (ytd) res.yields.ytd = ytd[2];
  const since = t.match(/成立以来年化[^\d]{0,12}([\d.]+)\s*%/) || t.match(/成立以来[^\d]{0,12}([\d.]+)\s*%/);
  if (since) res.yields.sinceInception = since[1];
  return res;
}

/** 取产品销售文件清单（免登录，实测 rs=1000） */
export async function fetchProfile(code) {
  const r = await fetchProductProfile(code);
  if (r.rs !== "1000") throw new Error(`queryFundProfiles rs=${r.rs} ${decodeURIComponent(r.memo || "")}`);
  const d = (r.data && r.data.data) || {};
  return [...(d.archievements || []), ...(d.notices || [])];
}

/** 下载该码的报告类 PDF 到 cacheDir，返回 [{title, file, bytes}] */
export async function fetchReports(code, cacheDir = path.join(process.cwd(), "reports")) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const docs = await fetchProfile(code);
  const out = [];
  for (const d of docs.filter((x) => REPORT_RE.test(x.title))) {
    const name = code + "__" + d.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 70) + ".pdf";
    const fp = path.join(cacheDir, name);
    if (!fs.existsSync(fp) || fs.statSync(fp).size < 1000) {
      try {
        const res = await fetch(d.content);
        fs.writeFileSync(fp, Buffer.from(await res.arrayBuffer()));
      } catch (e) { continue; }
    }
    out.push({ title: d.title, file: fp, bytes: fs.statSync(fp).size });
  }
  return out;
}

/**
 * 取任意产品码的净值序列（服务器端、无人值守、免登录）
 * @returns { code, points: [{date, nav, cumNav, netAsset, shares, src}], count }
 */
export async function navFetch(code, opts = {}) {
  const { cacheDir = path.join(process.cwd(), "reports"), keepPdf = true } = opts;
  const reports = await fetchReports(code, cacheDir);
  const points = {};
  for (const rp of reports) {
    const res = await extractPdfText(rp.file, { maxPages: 60 });
    if (res.error) continue;
    const nav = parseNavFromText(res.pages.map((p) => p.text).join("\n"));
    if (!nav.nav) continue;
    const date = nav.navDate || (nav.period && nav.period.to);
    if (!date) continue;
    // 同日期取更"权威"的一条（定期报告优先于投资报告）
    const prev = points[date];
    if (!prev || (rp.title.includes("定期报告") && !prev.src.includes("定期报告"))) {
      points[date] = {
        date, nav: nav.nav, cumNav: nav.cumNav, netAsset: nav.netAsset,
        shares: nav.shares, yields: nav.yields, src: rp.title,
      };
    }
    if (!keepPdf) { try { fs.unlinkSync(rp.file); } catch {} }
  }
  const list = Object.values(points).sort((a, b) => a.date.localeCompare(b.date));
  return { code, count: list.length, points: list, reports: reports.map((r) => r.title) };
}

// CLI: node nav_fetch.mjs <code> [code2 ...]
if (process.argv[1] && process.argv[1].endsWith("nav_fetch.mjs")) {
  const codes = process.argv.slice(2);
  if (!codes.length) { console.log("用法: node nav_fetch.mjs <产品码> [更多码...]"); process.exit(1); }
  const all = {};
  for (const code of codes) {
    try {
      const r = await navFetch(code);
      all[code] = r;
      console.log(`\n### ${code}  报告 ${r.reports.length} 份 → 净值点 ${r.count} 个`);
      for (const p of r.points) {
        console.log(`   ${p.date}  份额净值=${p.nav}  累计=${p.cumNav ?? "-"}  资产净值=${p.netAsset ?? "-"}  [${p.src.slice(0, 44)}]`);
      }
      if (!r.count) console.log("   （该码在网商侧无含净值的报告披露）");
    } catch (e) {
      console.log(`\n### ${code}  ERROR ${String(e).slice(0, 120)}`);
    }
  }
  fs.writeFileSync(path.join(process.cwd(), "reports", "_nav_final.json"), JSON.stringify(all, null, 2));
  process.exit(0);
}

// ============================================================================
//  网商银行「按产品代码 → 七字段」查询（服务器端 / 免登录 / 无人值守）
// ----------------------------------------------------------------------------
//  数据源：仅网商银行（bkmobilegw.mybank.cn）→ 产品销售文件 CDN → 说明书 PDF
//  链路：queryFundProfiles（免登录）→ 取说明书 PDF → headless Chrome 提取文本 →
//        parseManual → 映射 发行银行 / 产品名称 / 登记编码 / 最短持有 / 风险(R1-R5) /
//        成立日 / 业绩比较基准
//
//  用途：产品管理页「添加产品 · 查询」当代销银行=网商时调用：
//        先在这里拿到 7 字段（发行银行 / 产品名称 / 登记编码 / 最短持有天数 /
//        风险等级 / 成立日期 / 业绩比较基准），再以发现的发行行去抓净值
//        （中国理财网按登记编码兜底）。
// ============================================================================
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchProductProfile, cookies } from "./netbank_client.mjs";
import { extractPdfText } from "./pdf_extract.mjs";
import { parseManual } from "./manual_parser.mjs";
import { pickTmpRoot } from "./cache_root.mjs";

// managerToBankKey 内联（原取自 scrape/worker.js，但本模块需独立于 Cloudflare Worker 入口，
// 以便 GitHub Actions runner（Node）直接复用，无需 load 整个 Worker 脚本）。
// 覆盖网商说明书「银行简称」→ 发行银行 key 的全部已知映射。
const MBK = {
  "交银理财": "comm", "施罗德交银理财": "comm", "汇华理财": "comm",
  "光大理财": "ceb", "浦银理财": "spdb", "中银理财": "boc", "招银理财": "cmb",
  "中邮理财": "psbc", "信银理财": "citic", "建信理财": "ccb", "贝莱德建信理财": "ccb",
  "民生理财": "cmbc", "工银理财": "icbc", "高盛工银理财": "icbc", "广银理财": "cgb",
  "宁银理财": "nbcb", "华夏理财": "huaxia", "上银理财": "bosc", "兴银理财": "cib",
  "北银理财": "bob", "农银理财": "abc", "法巴农银理财": "abc", "平安理财": "pingan",
  "南银理财": "nanyin", "苏银理财": "jsb",
};
const MBK_HINTS = [
  ["施罗德交银", "comm"], ["贝莱德建信", "ccb"], ["法巴农银", "abc"], ["高盛工银", "icbc"],
  ["招银", "cmb"], ["工银", "icbc"], ["中银", "boc"], ["中邮", "psbc"],
  ["宁银", "nbcb"], ["信银", "citic"], ["交银", "comm"], ["建信", "ccb"],
  ["民生", "cmbc"], ["农银", "abc"], ["光大", "ceb"], ["浦银", "spdb"],
  ["广银", "cgb"], ["北银", "bob"], ["上银", "bosc"], ["兴银", "cib"],
  ["兴业", "cib"], ["苏银", "jsb"], ["南银", "nanyin"], ["平安", "pingan"],
  ["华夏", "huaxia"], ["汇华", "comm"],
];
function managerToBankKey(m) {
  const s = String(m || "").trim();
  if (!s) return "";
  if (MBK[s]) return MBK[s];   // 长名归一化：说明书简称多为「招银理财」这种精确形式，直接命中
  for (const [kw, k] of MBK_HINTS) if (s.includes(kw)) return k;
  return "";
}

// pickTmpRoot 已迁至 ./cache_root.mjs（缓存根移到项目外的 网商银行cache）。

// parseManual 解析出的「银行简称」（招银 / 光大 / 上银 / 工银 / 农银 / …）→ 银行 key
const SHORT_TO_KEY = {
  "招银": "cmb", "光大": "ceb", "上银": "bosc", "工银": "icbc", "农银": "abc",
  "中银": "boc", "平安": "pingan", "兴银": "cib", "苏银": "jsb", "宁银": "nbcb",
  "华夏": "huaxia", "民生": "cmbc", "广银": "cgb", "北银": "bob", "南银": "nanyin",
  "交银": "comm", "汇华": "comm", "贝莱德建信": "ccb", "高盛工银": "icbc", "法巴农银": "abc",
};
// 银行 key → 发行理财子公司中文名（用于「管理人」字段，代表发行银行）
const KEY_TO_MANAGER = {
  cmb: "招银理财", ceb: "光大理财", bosc: "上银理财", icbc: "工银理财", abc: "农银理财",
  boc: "中银理财", pingan: "平安理财", cib: "兴银理财", jsb: "苏银理财", nbcb: "宁银理财",
  huaxia: "华夏理财", cmbc: "民生理财", cgb: "广银理财", bob: "北银理财", nanyin: "南银理财",
  comm: "交银理财", ccb: "建信理财",
};

/** 网商说明书解析出的「银行简称」→ 发行银行 key（兜底：拼「理财」走 worker.managerToBankKey） */
function issuerKeyOf(shortBank) {
  if (!shortBank) return "";
  if (SHORT_TO_KEY[shortBank]) return SHORT_TO_KEY[shortBank];
  // 徽银 / 杭银 / 青银 / 渤银 / 渝农商 等未建直连端口的银行：拼「理财」再查 worker 映射，
  // 查不到则返回空 → 下游直接走中国理财网（按登记编码）兜底。
  return managerToBankKey(shortBank + "理财") || "";
}

/** 风险等级：中文词 / PRx → 标准 R1~R5（App 的 fRisk 选项即 R1~R5） */
function riskToR(risk) {
  if (!risk) return null;
  const s = String(risk).trim();
  if (/^R[1-5]$/i.test(s)) return s.toUpperCase();
  const pr = s.match(/PR(\d)/i);
  if (pr) return "R" + pr[1];
  const MAP = {
    "低风险": "R1", "中低风险": "R2", "较低风险": "R2",
    "中等风险": "R3", "中风险": "R3", "中高风险": "R4", "高风险": "R5",
  };
  return MAP[s] || null;
}

/** 从说明书标题派生产品名称（去掉「理财产品说明书」后缀与省略号）；标题为泛称（如「产品说明书」）时返回 null */
function cleanName(title) {
  let s = String(title || "").trim();
  s = s
    .replace(/理财产品说明书\s*$/, "")
    .replace(/产品说明书\s*$/, "")
    .replace(/说明书\s*$/, "")
    .replace(/…/g, " ")
    // 【2026-11-01 修复】网商文件标题常把产品代码写进括号，如
    // 「工银理财·鑫悦打新策略优选最短持有90天混合类开放（26H6066A）理财产品说明书」——
    // 只剥「说明书」后缀会留下（26H6066A），污染显示名。产品唯一标识是**产品代码**（登记编码辅助），
    // 名称里嵌的代码绝不可当标识用（同名不同码产品极多，如工银鑫悦 90 天就有 26H6066A/26HH6399 两个），
    // 故末尾（4~20 位字母数字）必须一并剥掉。
    .replace(/[（(][0-9A-Za-z]{4,20}[）)]\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  // 标题只是泛称（「产品」「理财」「理财产品」）时认为未取得真实名称
  if (!s || s === "产品" || s === "理财" || s === "理财产品") return null;
  return s;
}

/**
 * 从说明书正文（封面页）提取产品名称。
 *
 * 背景（2026-10-26）：网商文件清单里很多产品的**文档标题只是泛称**「产品说明书」，
 * 标题里没有产品全称 → 名称取不到 → 添加产品时「产品名称」留空 → 保存被拦
 * （"请填写产品名称"）。但 PDF 封面必定写着产品全称，且是网商自己的文件（首选权威来源）。
 *
 * 封面版式实测有三套，都要认：
 *   ① 工银/光大模板：标题行下就是「产品名称 ： XXX」（带冒号）
 *                     EW5902D   → 「产品名称   阳光金乐盈日开 7 号（180 天最低持有）」
 *                     26H6399E → 「产品名称 ： 工银理财 · 鑫悦打新策略优选最短持有 90 天…」
 *   ② 招银模板：**没有「产品名称」标签**，产品名独占一行，夹在「产品登记编码」与「产品说明书」之间：
 *                     产品登记编码： Z7001626000337
 *                     招银理财招睿嘉裕日开 180 天持有期 3 号增强型固收类理财计划   ← 名称在这
 *                     产品说明书
 *                     （产品代码： 109463 ）
 *   ③ 名称与「产品说明书」同行：「XXX产品说明书」
 *
 * 只在封面页（前 2 页）里找，避免命中正文「定义」章节里对「产品名称」的引用；
 * 三套版式都找不到就返回 null，由发行行/中国理财网净值接口补真实名称。
 */
function nameFromBody(pagesText) {
  if (!pagesText) return null;
  const lines = String(pagesText).slice(0, 4000).split(/\r?\n/);
  const HEAD = Math.min(lines.length, 16);
  // 名称候选清洗：pdf.js 会在字符间插空格 → 去掉全部空白；尾部「（产品代码）」按纯字母数字判定去掉
  const clean = (raw, strict) => {
    let s = String(raw == null ? "" : raw)
      .replace(/[\s\u00a0]+/g, "")
      .replace(/[（(][0-9A-Za-z]{4,20}[）)]$/, "")
      .trim();
    if (s.length < 4 || s.length > 60) return null;                 // 太短是残片，太长多半是散文
    // 命中定义章节的散文（「变更/调整/说明/修订/如下/见/为/指/其/本/该」起头的句子）。
    // 注意：原字符集含「中」，会误杀「中银理财/中邮理财」等以"中"开头的真实产品名
    //（实测 CYQ7D2E 封面名「中银理财-稳富（7天持有期）宁享版2号」因此被拒 → name=null）。
    // 故移除「中」，定义散文里「其中…」类句子仍可经「其」字命中拦截。
    if (/^[变更调整说明修订如下见为指其本该]/.test(s)) return null;
    if (/[，。；、！？]/.test(s)) return null;                       // 含中文标点 → 是正文不是产品名
    if (strict && /[：:]/.test(s)) return null;                     // 带冒号 → 是「标签：值」不是名称行
    // 泛称不是产品名：封面「理财产品说明书」这一行会把「理财产品」当成名称（2026-10-26 实测
    // EW7829D 因此返回「理财产品」）。这些词必须显式排除。
    if (/^(产品|理财|理财产品|说明书|产品说明书|风险揭示书|投资者权益须知|投资协议书|产品投资协议书|销售文件|重要须知|风险揭示)$/.test(s)) return null;
    return s;
  };
  // 标签行黑名单：这些行长得像名称，但其实是字段名
  const LABEL = /登记编码|产品代码|产品编号|产品类型|风险等级|风险揭示|管理人|运营机构|投资范围|产品要素|产品概况|联系方式/;

  // ① 「产品名称 ： XXX」/「产品名称   XXX」
  for (let i = 0; i < HEAD; i++) {
    const line = lines[i] || "";
    const m = line.match(/^\s*产品名称\s*[：:]\s*(.*)$/) || line.match(/^\s*产品名称\s{1,}(.*)$/);
    if (!m) continue;
    let raw = m[1] || "";
    const nxt = lines[i + 1] || "";
    if (/^\s*[（(]/.test(nxt)) raw += nxt;   // 名称换行续接，下一行是「（产品代码）」
    const s = clean(raw, false);
    if (s) return s;
  }
  // ② 名称与「产品说明书」同行：「XXX产品说明书」
  for (let i = 0; i < HEAD; i++) {
    const l = (lines[i] || "").trim();
    if (!/说明书$/.test(l)) continue;
    const m = l.match(/^(.*)说明书$/);
    if (!m) continue;
    const s = clean(m[1], true);
    if (s) return s;
  }
  // ②b 名称被中文引号包裹，且可能跨行（光大模板，2026-10-26 实测 EW7829D）
  //     光大理财 “ 阳光橙优选多策略固收增强日开   2   号（ 18 0
  //     天最低持有） ”
  //     理财产品说明书
  //     → 引号内是产品名；引号前是品牌前缀（光大理财）。前缀一并带上，
  //       与「光大理财阳光金乐盈日开7号…」这类已有条目的写法保持一致。
  for (let i = 0; i < HEAD; i++) {
    const l = (lines[i] || "").trim();
    const open = l.indexOf("“");
    if (open < 0) continue;
    const brand = l.slice(0, open).trim();                 // 引号前的品牌前缀
    let raw = l.slice(open + 1);
    for (let j = i + 1; j < HEAD && j <= i + 3; j++) {
      const t = (lines[j] || "").trim();
      const close = t.indexOf("”");
      if (close >= 0) { raw += t.slice(0, close); break; }
      raw += t;
    }
    const s = clean(raw, true);
    if (!s) continue;
    const b = clean(brand, true);
    return b && b.length <= 8 && !/说明书/.test(b) ? b + s : s;
  }
  // ③ 名称独占一行，位于「产品说明书」行的上一行（招银模板）
  for (let i = 0; i < HEAD; i++) {
    const l = (lines[i] || "").trim();
    if (!/说明书$/.test(l) || LABEL.test(l)) continue;   // 找到「产品说明书」标题行
    for (let j = i - 1; j >= 0 && j >= i - 4; j--) {
      const cand = (lines[j] || "").trim();
      if (!cand) continue;
      if (LABEL.test(cand)) break;                      // 上一行是字段标签 → 名称不在更上面
      const s = clean(cand, true);
      if (s) return s;
      break;
    }
  }
  return null;
}

/**
 * 名称来源 ⑤：文件清单里的【公告】标题。
 * 网商的公告标题几乎都把产品全称包在中间，实测三种：
 *   「关于调整阳光橙优选多策略固收增强日开2号（180天最低持有）理财产品销售文件的公告」
 *   「关于招银理财招睿嘉裕日开180天持有期3号增强型固收类理财计划增加销售服务机构的公告」
 *   「关于“阳光金乐盈日开7号（180天最低持有）”理财产品费率优惠事项的公告」
 * 剥掉「关于…的公告」外壳、文件类型后缀和动作短语，剩下的就是产品全称。
 */
function nameFromNotice(docs) {
  for (const x of docs || []) {
    const t = String(x.title || "").trim();
    const m = t.match(/^关于(.+?)的公告$/);
    if (!m) continue;
    let n = m[1].trim();
    n = n.replace(/^[“"「『]/, "").replace(/[”"」』]$/, "");
    n = n.replace(/理财产品.*$/, "");                       // 去掉「理财产品销售文件/费率优惠事项」等文件类型尾巴
    n = n.replace(/(增加|调整|修订|变更|优化|暂停|恢复|终止)[^）)]*$/, "");  // 去掉尾部动作短语
    n = n.replace(/^(增加|调整|修订|变更|优化|暂停|恢复|终止)/, "");
    n = n.replace(/[“"「『”"」』]/g, "").trim();
    if (n.length < 4 || n.length > 60) continue;
    if (/[，。；、！？]/.test(n)) continue;
    if (/^(产品|理财|理财产品|说明书)$/.test(n)) continue;
    return n;
  }
  return null;
}

async function downloadPdf(url, cookieHeader) {
  const res = await fetch(url, {
    headers: cookieHeader ? { cookie: cookieHeader, referer: "https://render.mybank.cn/" } : { referer: "https://render.mybank.cn/" },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error("PDF 下载失败 HTTP " + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 500) throw new Error("PDF 过小（" + buf.length + " 字节），可能并非说明书");
  const dir = fs.mkdtempSync(path.join(pickTmpRoot("mybank-manual-"), "mybank-manual-"));
  const fp = path.join(dir, "manual.pdf");
  fs.writeFileSync(fp, buf);
  return fp;
}

async function doLookup(code) {
  // 1) 取产品销售文件清单（免登录，实测 rs=1000）
  let prof;
  try {
    prof = await fetchProductProfile(code);
  } catch (e) {
    return { ok: false, error: "网商接口请求失败：" + e.message };
  }
  if (!prof.ok) {
    return { ok: false, error: "网商网关返回 rs=" + prof.rs + " " + decodeURIComponent(prof.memo || "") };
  }
  // 业务层结果：网关 rs=1000 仅代表「请求被网关接受」，不代表业务成功。
  // 实测 YX 系列（YXTT21A / YXTT02A / YXPZ150…）会返回 success=false +
  // AE15012117000001「system is error, please retry later!」，必须显式识别，
  // 否则会被下面「无产品销售文件」误导（让人以为是该码没有说明书，其实接口直接拒了）。
  const biz = prof.data || {};
  if (biz.success === false) {
    const rc = biz.resultCode || "";
    const rd = decodeURIComponent(String(biz.resultDesc || biz.resultView || ""));
    return { ok: false, error: "网商接口业务失败（" + rc + "）：" + rd, bizCode: rc };
  }
  const d = (biz.data && typeof biz.data === "object") ? biz.data : {};
  const docs = [...(d.archievements || []), ...(d.notices || [])];
  if (!docs.length) return { ok: false, error: "该代码在网商无产品销售文件" };

  // 取说明书（标题含「说明书」），优先「理财产品说明书」
  const doc =
    docs.find((x) => /理财产品说明书/.test(x.title || "")) ||
    docs.find((x) => /说明书/.test(x.title || ""));
  if (!doc) {
    return { ok: false, error: "未找到说明书（产品文件清单中无标题含「说明书」的文档）" };
  }
  const title = doc.title || "";
  const pdfUrl = doc.content;
  if (!pdfUrl) return { ok: false, error: "说明书文档缺少 PDF 链接" };

  // 2) 下载 + 文本提取
  let pdfPath = null;
  try {
    try {
      const ck = cookies();
      const cookieHeader = Object.keys(ck).length
        ? Object.entries(ck).map(([k, v]) => `${k}=${v}`).join("; ")
        : "";
      pdfPath = await downloadPdf(pdfUrl, cookieHeader);
    } catch (e) {
      return { ok: false, error: "说明书 PDF 下载失败：" + e.message };
    }
    const txt = await extractPdfText(pdfPath, { maxPages: 40 });
    if (txt.error) return { ok: false, error: "说明书 PDF 文本提取失败：" + txt.error };

    const text = txt.pages.map((p) => p.text).join("\n");

    // 3) 解析七字段
    const m = parseManual(text, title);
    const issuerKey = issuerKeyOf(m.银行简称);
    const manager = issuerKey
      ? (KEY_TO_MANAGER[issuerKey] || (m.银行简称 + "理财"))
      : (m.银行简称 ? m.银行简称 + "理财" : "");
    // 名称：① 文档标题（标题含产品全称时最准，如「光大理财阳光金乐盈日开7号…理财产品说明书」）
    //      ② 标题是泛称「产品说明书」→ 取封面正文里的「产品名称 ： XXX」（网商自己的文件，最权威）
    //      ③ 都取不到 → 留 null，交给发行行/中国理财网净值接口补
    const nameFromTitle = cleanName(title);
    const nameFromCover = nameFromTitle ? null : nameFromBody(txt.pages.slice(0, 2).map((p) => p.text).join("\n"));
    // ⑤ 兜底：文件清单里的公告标题里带产品全称（网商自己的文件名，可信）
    const nameFromNoticeTitle = (nameFromTitle || nameFromCover) ? null : nameFromNotice(docs);
    const name = nameFromTitle || nameFromCover || nameFromNoticeTitle || null;
    const risk = riskToR(m.风险等级);
    return {
      ok: true,
      code,
      issuer: issuerKey,           // 发行银行 key（如 cmb / ceb / icbc …）
      issuerName: manager,         // 发行理财子公司名（管理人）
      name: name || null,
      nameSource: nameFromTitle ? "doc-title" : (nameFromCover ? "manual-cover" : (nameFromNoticeTitle ? "notice-title" : null)),
      manager,                     // 发行机构（= 发行人）
      regCode: m.产品登记编码 || null,
      holdDays: m.最短持有天数 != null ? m.最短持有天数 : null,
      risk,                        // R1~R5
      riskRaw: m.风险等级 || null, // 原始中文/PRx，便于审计
      established: m.成立日期 || null,
      benchmark: m.业绩比较基准 || null,
      // 诊断信息（不强制使用）
      bankShort: m.银行简称 || null,
      productCodeParsed: m.产品代码 || null,
      tPlus: m.Tplus || [],
    };
  } finally {
    if (pdfPath) {
      try { fs.rmSync(path.dirname(pdfPath), { recursive: true, force: true }); } catch {}
    }
  }
}

/**
 * 网商银行按产品代码取七字段（免登录）。
 * 内部整体预算 budgetMs，超时返回 { ok:false, error }，避免前端 60s 守护被拖爆。
 */
export async function mybankManualLookup(code, budgetMs = 50000) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return { ok: false, error: "missing code" };
  let timer = null;
  const guard = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error("网商说明书解析超时（>" + Math.round(budgetMs / 1000) + "s）")), budgetMs);
  });
  try {
    return await Promise.race([doLookup(c), guard]);
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// CLI：node mybank_manual_lookup.mjs <产品码>
if (process.argv[1] && process.argv[1].endsWith("mybank_manual_lookup.mjs")) {
  const code = process.argv[2];
  if (!code) { console.log("用法: node mybank_manual_lookup.mjs <产品码>"); process.exit(1); }
  const r = await mybankManualLookup(code);
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}

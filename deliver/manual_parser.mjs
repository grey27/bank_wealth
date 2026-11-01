// 理财产品说明书解析器：从 PDF 文本抽取关键字段
// 目标字段：银行简称 / 产品登记编码 / 产品代码 / 最短持有天数 / 风险等级 /
//          成立日期 / 业绩比较基准 / T+N 赎回规则
//
// 已知版式（招银 / 光大 / 上银），其余银行用兜底正则 + 银行名推断。
import fs from "node:fs";

const BANK_MAP = [
  [/招银理财/, "招银"], [/光大理财/, "光大"], [/上银理财/, "上银"],
  [/工银理财/, "工银"], [/工银/, "工银"], [/农银理财/, "农银"], [/中银理财/, "中银"],
  [/平安理财/, "平安"], [/兴银理财/, "兴银"], [/苏银理财/, "苏银"], [/杭银理财/, "杭银"],
  [/宁银理财/, "宁银"], [/华夏理财/, "华夏"], [/民生理财/, "民生"], [/广银理财/, "广银"],
  [/渤银理财/, "渤银"], [/北银理财/, "北银"], [/徽银理财/, "徽银"], [/南银理财/, "南银"],
  [/渝农商理财/, "渝农商"], [/汇华理财/, "汇华"], [/施罗德交银理财/, "交银"], [/交银理财/, "交银"],
  [/贝莱德建信理财/, "贝莱德建信"], [/高盛工银理财/, "高盛工银"], [/法巴农银理财/, "法巴农银"],
  [/青银理财/, "青银"], [/新疆银行/, "新疆银行"], [/浙江农商/, "浙江农商"],
];

function norm(s) {
  let x = s.replace(/[ \t\u00a0]+/g, " ").replace(/　/g, " ");
  // 修复 PDF 文本被空格割裂的数字（如 "202 5 年" → "2025 年"，"EW 3836" → "EW3836"）
  x = x.replace(/\d\s+\d/g, (m) => m.replace(/\s+/g, ""));
  return x;
}

function findDates(txt) {
  const out = [];
  const re = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日|(\d{4})-(\d{2})-(\d{2})/g;
  let m;
  while ((m = re.exec(txt))) out.push(m[0].replace(/\s+/g, ""));
  return out;
}

/** 在 text 中定位所有 key 出现位置 */
function allIdx(txt, key) {
  const out = []; let i = -1;
  while ((i = txt.indexOf(key, i + 1)) >= 0) out.push(i);
  return out;
}

export function parseManual(text, title = "") {
  const t = norm(text);
  // 去全部空白（含换行）的副本：PDF 抽取常把中文/数字拆开（"内部 风险评 级"、"EW 3836"、
  // "202 5 年"），也会在锚点词与评级之间插入换行，导致正则匹配失败。压缩后这些都能还原。
  const c = t.replace(/\s+/g, "");
  const r = { raw: {} };

  // 1) 银行简称
  let bank = "";
  for (const [re, name] of BANK_MAP) { if (re.test(title)) { bank = name; break; } }
  if (!bank) for (const [re, name] of BANK_MAP) { if (re.test(t)) { bank = name; break; } }
  r.银行简称 = bank || null;

  // 2) 产品登记编码（在 c 上匹配）
  let m = c.match(/(?:产品)?登记编码[^A-Z]{0,8}?([A-Z]\d{6,})/)
        || c.match(/产品登记编码[:：】]*(?:【\[]?)([A-Z]\d{6,})/);
  r.产品登记编码 = m ? m[1] : null;

  // 3) 产品代码（优先 产品代码 / 产品编号 / 销售代码）
  //    优先在带空白的 t 上取（可得干净代码，如 109463 / EW5902）；若因拆字失败再试去空白 c。
  const codeRe = (src) =>
    src.match(/产品代码[:：】\s]*[【\[]?\s*([A-Z0-9]{4,})/)
    || src.match(/产品编号[:：】\s]*[【\[]?\s*([A-Z0-9]{4,})/)
    || src.match(/销售代码[:：】\s]*([A-Z0-9]{4,})/);
  let code = codeRe(t);
  if (!code) code = codeRe(c);
  let codeStr = code ? code[1] : null;
  // 仅当末位字母确为份额类后缀（其后紧跟"类/份/额"）时才剥离，避免误伤真实产品代码（如 NYJXLD18015N）
  if (codeStr && /[A-Z]$/.test(codeStr)) {
    const at = c.indexOf(codeStr);
    const after = at >= 0 ? c.slice(at + codeStr.length, at + codeStr.length + 1) : "";
    if (/[类份额]/u.test(after)) codeStr = codeStr.slice(0, -1);
  }
  r.产品代码 = codeStr;

  // 4) 最短持有天数（在 c 上匹配，规避拆字；文件名兜底）
  let holdDays = null;
  m = c.match(/(\d+)个自然日/)
    || c.match(/(\d+)个?月(?:持有期|最低持有|最短持有)/)
    || c.match(/(?:最短)?持有(?:期限|期)[^。\d]{0,12}?(\d+)天/)
    || c.match(/(\d+)天(?:最低|持有|最短|期限)/)
    || title.match(/(\d+)\s*天\s*(?:最低|持有)/);
  if (m) {
    const n = parseInt(m[1], 10);
    holdDays = /月/.test(m[0]) ? n * 30 : n;
  }
  r.最短持有天数 = holdDays;

  // 5) 风险等级 —— 锚定「评级」上下文，取其紧邻的等级表述（避开免责声明里的「高风险类型」）
  //    全部在去空白副本 c 上匹配，规避换行/拆字导致的漏匹配。
  const LEVELS = "(中低风险|较低风险|中等风险|中高风险|低风险|高风险)";
  const STAR = "([一二三四五])星级";
  const riskAnchors = [
    new RegExp("风险评级[^，。]{0,16}?" + LEVELS),
    new RegExp("风险等级[^，。]{0,16}?" + LEVELS),
    new RegExp("内部风险评级[^，。]{0,16}?" + LEVELS),
    new RegExp("风险评级[^，。]{0,16}?" + STAR),
    new RegExp("内部风险评级[^，。]{0,16}?" + STAR),
  ];
  let risk = null;
  for (const a of riskAnchors) { const mm = c.match(a); if (mm) { risk = mm[1]; break; } }
  if (!risk) {
    const pr = c.match(/风险(?:收益)?评级[^，。]{0,16}?PR(\d)/i) || c.match(/风险等级[^，。]{0,16}?PR(\d)/i);
    if (pr) risk = "PR" + pr[1];
  }
  if (!risk) {
    // 兜底：取全文首个等级词，但排除免责声明里的「高风险类型」
    const cr = c.replace(/高风险类型/g, "高风险X类型");
    const fm = cr.match(new RegExp(LEVELS)) || cr.match(/PR(\d)/);
    if (fm) risk = fm[0].startsWith("P") ? "PR" + fm[1] : fm[0];
  }
  const STAR_CHAR_MAP = { "一": "低风险", "二": "中低风险", "三": "中风险", "四": "中高风险", "五": "高风险" };
  if (risk && STAR_CHAR_MAP[risk]) risk = STAR_CHAR_MAP[risk];
  r.风险等级 = risk;

  // 6) 成立日期 —— 取「产品成立日 YYYY年M月D日」的真实值（兼容【】包裹与定义段），在 c 上匹配
  m = c.match(/产品成立日[【\[]?(\d{4})[】\]]?年[【\[]?(\d{1,2})[】\]]?月[【\[]?(\d{1,2})[】\]]?日/)
    || c.match(/成立日期?[：:】]?[【\[]?(\d{4})[】\]]?年[【\[]?(\d{1,2})[】\]]?月[【\[]?(\d{1,2})[】\]]?日/);
  r.成立日期 = m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;

  // 7) 业绩比较基准 —— 跨所有「业绩比较基准」出现处抽取具体数值/公式，不整段跳过（光大数值段也含定义套话）
  //    优先级：区间(1.50%~3.50%) > 指数公式(中债...指数×99.5%+沪深300...×0.5% / ...+0.25%) > 公式文本(选取...) > 单值(兜底，仅取非定义段)
  const benchIdxs = allIdx(c, "业绩比较基准");
  const isDef = (s) => /不具有法律约束力|类似表述|不是预期收益率|设定为投资目标|指管理人|是指/.test(s);
  let benchRange = null, singleBench = null;
  const fmlCands = [];
  for (const idx of benchIdxs) {
    const seg = c.slice(idx, idx + 320);
    if (!benchRange) {
      const rng = seg.match(/(\d\.\d{2}%)[－\-~至](\d\.\d{2}%)|(\d\.\d{2}%)\s*[－\-~至]\s*(\d\.\d{2}%)|(\d\.\d{2}%)至(\d\.\d{2}%)/);
      if (rng) {
        const a = rng[1] || rng[3] || rng[5], b = rng[2] || rng[4] || rng[6];
        benchRange = a.replace(/\s/g, "") + "~" + b.replace(/\s/g, "");
      }
    }
    const idxF = seg.match(/[中沪深证上][^\n。]{2,80}?(?:指数|收益率)[^\n。]{0,40}%/);   // 指数类公式（含 ×/* 加权），须含"指数/收益率"以排除"中度限制…10%"等
    if (idxF) fmlCands.push(idxF[0].replace(/\s+/g, ""));
    const fml = seg.match(/选取[:：]([^\n。]{8,160})/);      // 招银式"选取：…收益率"
    if (fml) fmlCands.push(fml[1].replace(/\s+/g, " ").trim());
    if (!singleBench && !isDef(seg)) {
      const sgl = seg.match(/\d\.\d{2}%/);
      if (sgl) singleBench = sgl[0].replace(/\s/g, "");
    }
  }
  // 取最长的公式候选（更完整），再退单值
  fmlCands.sort((a, b) => b.length - a.length);
  r.业绩比较基准 = benchRange || fmlCands[0] || singleBench;

  // 8) T+N 赎回规则（兼容 ASCII + 与全角 ＋）
  const tPlus = [];
  const tm = c.matchAll(/T[＋+]\s*[【\[]?(\d+)/g);
  for (const x of tm) tPlus.push("T+" + x[1]);
  r.Tplus = [...new Set(tPlus)];

  return r;
}

// CLI：node manual_parser.mjs <pdf> <title>
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { extractPdfText } = await import("./pdf_extract.mjs");
  const f = process.argv[2];
  const title = process.argv[3] || f;
  const r = await extractPdfText(f, { maxPages: 40 });
  const text = r.pages.map(p => p.text).join("\n");
  const res = parseManual(text, title);
  console.log(JSON.stringify(res, null, 2));
  process.exit(0);
}

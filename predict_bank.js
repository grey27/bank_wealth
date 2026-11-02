// predict_bank.js —— 销售代码 -> 发行方/代销方/抓取优先序 预判（Node 版，端口自 predict_银行.py v4）
// 仅服务端使用：serve.mjs / worker.js 调用 predictBanks(code) 得到抓取银行顺序。
// 浏览器不直接加载本文件，统一走 /api/predict 端点，避免把 1.2MB 规则 JSON 推到前端。
const fs = require("fs");
const path = require("path");

// 规则 JSON 文件名候选：优先 ASCII 名（predict-rules.json，线上 Worker 也用它，
// URL 免中文编码问题），回退中文名（历史命名，本地旧目录里是这个名字）。
const RULE_FILES = ["predict-rules.json", "销售代码-预判规则.json"];
let _d = null;
function load() {
  if (_d === null) {
    for (const f of RULE_FILES) {
      const p = path.join(__dirname, f);
      try {
        _d = JSON.parse(fs.readFileSync(p, "utf8"));
        break;
      } catch (e) {
        // 下一个候选
      }
    }
    if (_d === null) {
      throw new Error(
        "预判规则 JSON 未找到，已尝试: " + RULE_FILES.join(", ") + "（请确认文件在仓库根目录）"
      );
    }
  }
  return _d;
}

function parseRules(rdict) {
  const out = {};
  for (const k in rdict) {
    const t = k.slice(0, k.indexOf(":"));
    const val = k.slice(k.indexOf(":") + 1);
    const v = rdict[k];
    out[t + " " + val] = [v.value, v.purity != null ? v.purity : 1.0, v.support != null ? v.support : 0];
  }
  return out;
}
let _parsed = null;
function rules() {
  if (_parsed) return _parsed;
  const d = load();
  _parsed = [
    parseRules(d.manager_rules),
    parseRules(d.agent_rules),
    d.manager_to_parent_key,
    d.agent_to_key,
    d.manager_top_agents || {},
    d.feature_space || {},
    d.manual_rules || [],
    d.manager_fallback_agents || {},
    d.global_probe_order || [],
  ];
  return _parsed;
}

function spec(f) {
  const t = f[0], v = f[1];
  let base = v.length;
  if (t === "LP" || t === "LS") base += 3;
  else if (t === "D3") base += 2;
  else if (t === "D") base += 1;
  return base;
}
function feats(code, maxp, maxs) {
  const c = (code || "").trim().toUpperCase();
  const L = String(c.length);
  const out = [];
  for (let k = 1; k <= Math.min(maxp, c.length); k++) out.push(["P", c.slice(0, k)]);
  for (let k = 1; k <= Math.min(maxs, c.length); k++) out.push(["S", c.slice(c.length - k)]);
  if (/^\d+$/.test(c)) {
    out.push(["D", c.length + "-" + c.slice(0, 2)]);
    out.push(["D3", c.length + "-" + c.slice(0, 3)]);
    out.push(["DL", String(c.length)]);
  }
  for (let k = 1; k <= Math.min(maxp, c.length); k++) out.push(["LP", L + ":" + c.slice(0, k)]);
  for (let k = 1; k <= Math.min(maxs, c.length); k++) out.push(["LS", L + ":" + c.slice(c.length - k)]);
  return out;
}
function best(code, rmap, maxp, maxs) {
  const cands = [];
  for (const f of feats(code, maxp, maxs)) {
    const key = f[0] + " " + f[1];
    if (rmap[key]) {
      const [v, p, s] = rmap[key];
      cands.push([spec(f), p, s, v]);
    }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]);
  return cands[0][3];
}
function matchManual(m, code) {
  const c = (code || "").trim().toUpperCase();
  const mc = m.match || {};
  if (mc.regex && !new RegExp(mc.regex).test(c)) return false;
  if (mc.lengths && mc.lengths.indexOf(c.length) < 0) return false;
  if (mc.prefix && !c.startsWith(mc.prefix)) return false;
  const at = mc.at;
  if (at) {
    const pos = at.pos;
    if (c.length <= pos) return false;
    const ch = c[pos];
    if (at.kind === "alpha" && !/[A-Za-z]/.test(ch)) return false;
    if (at.kind === "digit" && !/\d/.test(ch)) return false;
  }
  return true;
}
function hitManual(code) {
  const manual = rules()[6];
  for (const m of manual) if (matchManual(m, code)) return m;
  return null;
}
function predictFull(code) {
  const [mr, ar, m2p, a2k, mta, fs, manual, mfa, gpo] = rules();
  const maxp = (fs.prefix_max_len || 8), maxs = (fs.suffix_max_len || 4);
  const mm = hitManual(code);
  if (mm) {
    const mg = mm.manager || best(code, mr, maxp, maxs);
    let ags = (mm.agents || []).slice();
    if (!ags.length) {
      let a = best(code, ar, maxp, maxs);
      if (!a && mg && mta[mg]) a = Object.keys(mta[mg]).sort((x, y) => mta[mg][y] - mta[mg][x])[0];
      ags = a ? [a] : [];
    }
    return { manager: mg, agents: ags, prefer: mm.prefer || "issuer", rule: mm.id, desc: mm.desc || "" };
  }
  const mg = best(code, mr, maxp, maxs);
  const ags = [];
  const a = best(code, ar, maxp, maxs);
  if (a) ags.push(a);
  if (mg && mta[mg]) {
    for (const x of Object.keys(mta[mg]).sort((x, y) => mta[mg][y] - mta[mg][x])) {
      if (ags.indexOf(x) < 0) ags.push(x);
    }
  }
  return { manager: mg, agents: ags, prefer: "issuer", rule: null, desc: "" };
}
function agentCandidates(code, topn) {
  const [mr, ar, m2p, a2k, mta, fs, manual, mfa, gpo] = rules();
  const maxp = (fs.prefix_max_len || 8), maxs = (fs.suffix_max_len || 4);
  const p = predictFull(code);
  const out = p.agents.slice();
  if (p.manager && mta[p.manager]) {
    for (const a of Object.keys(mta[p.manager]).sort((x, y) => mta[p.manager][y] - mta[p.manager][x])) {
      if (out.indexOf(a) < 0) out.push(a);
    }
  }
  return out.slice(0, topn);
}
function fetchPlan(code, topn) {
  const [mr, ar, m2p, a2k, mta, fs, manual, mfa, gpo] = rules();
  const p = predictFull(code);
  const keys = [];
  const pk = p.manager ? m2p[p.manager] : null;
  if (p.prefer === "issuer" && pk) keys.push(pk);
  for (const a of p.agents) {
    const k = a2k[a];
    if (k && keys.indexOf(k) < 0) keys.push(k);
  }
  if (pk && keys.indexOf(pk) < 0) keys.push(pk);
  if (!keys.length && p.manager) {
    for (const x of (mfa[p.manager] || [])) if (keys.indexOf(x.key) < 0) keys.push(x.key);
  }
  if (!keys.length) keys.push(...gpo.map(x => x.bank_key));
  return keys.slice(0, topn);
}

/**
 * 前端查询顺序所需的全部预判信息。
 * 返回：
 *   issuerKey       预判的发行银行（母行 key）
 *   dropdownTier    占位（由前端填入下拉框代销银行 key）
 *   otherIssuerKeys 预判的其它发行银行（母行不可抓时回落的历史代销渠道）
 *   otherAgentKeys  预判的其它代销银行（代销候选，除首选外）
 *   restKeys        剩下的其它银行（global_probe_order）
 *   plan            完整抓取序列（predict_fetch_plan）
 */
function predictBanks(code) {
  const [mr, ar, m2p, a2k, mta, fs, manual, mfa, gpo] = rules();
  const p = predictFull(code);
  const pk = p.manager ? m2p[p.manager] : null;
  const agentKey = p.agents.length ? a2k[p.agents[0]] : null;
  const otherIssuerKeys = (pk ? [] : (mfa[p.manager] || []).map(x => x.key));
  // 其它代销银行：列出「除下拉框所选之外」的全部预判代销候选（含首选），
  // 前端会按下拉框银行去重，故这里包含首选不会重复尝试；
  // 这样 M1 类（首选代销浦发）等产品也能被尽早尝试。
  const otherAgentKeys = agentCandidates(code, 5).map(a => a2k[a]).filter(Boolean);
  const restKeys = gpo.map(x => x.bank_key);
  return {
    code: (code || "").trim().toUpperCase(),
    manager: p.manager,
    issuerKey: pk,
    agent: p.agents[0] || null,
    agentKey: agentKey,
    otherIssuerKeys: otherIssuerKeys,
    otherAgentKeys: otherAgentKeys,
    restKeys: restKeys,
    prefer: p.prefer,
    rule: p.rule,
    plan: fetchPlan(code, 8),
  };
}

module.exports = { predictBanks, predictFull, fetchPlan, load };

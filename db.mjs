/**
 * 服务端数据：wealth.sqlite。
 * 浏览器接口仍按原来的 observer_* 字符串形状读写，落盘拆进下面这些表。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(ROOT, "wealth.sqlite");

const LABELS = {
  core: "产品目录与偏好",
  nav: "净值缓存",
  log: "运行日志（抓取调试）",
};

const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS product (
  code TEXT PRIMARY KEY,
  bank TEXT NOT NULL,
  name TEXT,
  manager TEXT,
  term TEXT,
  term_days INTEGER,
  risk TEXT,
  established TEXT,
  target REAL,
  confirm_days INTEGER,
  stock TEXT,
  quota TEXT,
  benchmark TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_product_bank ON product(bank);

CREATE TABLE IF NOT EXISTS product_patch (
  code TEXT PRIMARY KEY,
  name TEXT,
  manager TEXT,
  term TEXT,
  term_days INTEGER,
  risk TEXT,
  established TEXT,
  stock TEXT,
  edited INTEGER,
  extra_json TEXT
);

CREATE TABLE IF NOT EXISTS product_hidden (
  code TEXT PRIMARY KEY,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS product_fav (
  code TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS product_prefer_bank (
  code TEXT PRIMARY KEY,
  bank TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS product_mark (
  code TEXT NOT NULL,
  mark TEXT NOT NULL,
  PRIMARY KEY (code, mark)
);

CREATE TABLE IF NOT EXISTS bank_refresh_msg (
  bank TEXT PRIMARY KEY,
  message TEXT
);

CREATE TABLE IF NOT EXISTS nav_snapshot (
  code TEXT PRIMARY KEY,
  name TEXT,
  manager TEXT,
  bank TEXT,
  kind TEXT,
  nav REAL,
  nav_date TEXT,
  nav_latest REAL,
  currency TEXT,
  remain_quota REAL,
  quota_state TEXT,
  nav_via TEXT,
  nav_port TEXT,
  last_src_mode TEXT,
  last_src_via TEXT,
  last_src_port TEXT,
  benchmark TEXT,
  benchmark_full TEXT,
  sources_json TEXT,
  extra_json TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS nav_point (
  code TEXT NOT NULL,
  nav_date TEXT NOT NULL,
  nav REAL NOT NULL,
  acc_nav REAL,
  PRIMARY KEY (code, nav_date)
);

CREATE TABLE IF NOT EXISTS refresh_state (
  code TEXT PRIMARY KEY,
  refreshed_at INTEGER,
  duration_ms INTEGER,
  failed INTEGER NOT NULL DEFAULT 0,
  breakdown_json TEXT
);

CREATE TABLE IF NOT EXISTS holding (
  holding_id TEXT PRIMARY KEY,
  product_id TEXT,
  product_name TEXT,
  agency_name TEXT,
  product_category TEXT,
  trades_json TEXT,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_holding_product ON holding(product_id);

CREATE TABLE IF NOT EXISTS boc_sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at TEXT,
  ok INTEGER,
  source TEXT,
  total_count INTEGER,
  pages INTEGER,
  fetched INTEGER,
  added INTEGER,
  updated INTEGER,
  removed_stale INTEGER,
  skipped_same INTEGER,
  skipped_other INTEGER,
  skipped_hidden INTEGER,
  invalid INTEGER,
  elapsed_ms INTEGER,
  error TEXT,
  note TEXT,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_boc_sync_ran ON boc_sync_log(ran_at);

CREATE TABLE IF NOT EXISTS app_setting (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS aux_map (
  namespace TEXT NOT NULL,
  code TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (namespace, code)
);
`);

function parseVal(v) {
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch (e) { return v; }
}
function asStored(v) {
  if (v == null) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}
function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function getSetting(key) {
  const row = db.prepare("SELECT value FROM app_setting WHERE key = ?").get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  db.prepare("INSERT INTO app_setting(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value == null ? null : String(value));
}

const NAV_KEYS = new Set([
  "series", "name", "manager", "kind", "remainQuota", "currency", "quotaState",
  "navVia", "navPort", "navSources", "lastSrcMode", "lastSrcVia", "lastSrcPort",
  "code", "bank", "nav", "navDate", "navLatest", "benchmark", "benchmarkFull",
]);

function replaceRegistry(reg) {
  db.prepare("DELETE FROM product").run();
  db.prepare("DELETE FROM product_patch").run();
  db.prepare("DELETE FROM product_hidden").run();
  const ins = db.prepare(`INSERT INTO product(
    code, bank, name, manager, term, term_days, risk, established, target,
    confirm_days, stock, quota, benchmark, updated_at
  ) VALUES (
    @code, @bank, @name, @manager, @term, @term_days, @risk, @established, @target,
    @confirm_days, @stock, @quota, @benchmark, @updated_at
  )`);
  const now = new Date().toISOString();
  for (const item of reg.custom || []) {
    if (!item || !item.code) continue;
    const code = String(item.code).trim().toUpperCase();
    if (!code) continue;
    ins.run({
      code,
      bank: String(item.bank || ""),
      name: item.name || "",
      manager: item.manager || "",
      term: item.term || "",
      term_days: numOrNull(item.termDays),
      risk: item.risk || "",
      established: item.established || "",
      target: numOrNull(item.target),
      confirm_days: item.confirm == null || item.confirm === "" ? null : numOrNull(item.confirm),
      stock: item.stock || "",
      quota: item.quota || "",
      benchmark: item.benchmark || "",
      updated_at: now,
    });
  }
  const pins = db.prepare(`INSERT INTO product_patch(
    code, name, manager, term, term_days, risk, established, stock, edited, extra_json
  ) VALUES (
    @code, @name, @manager, @term, @term_days, @risk, @established, @stock, @edited, @extra_json
  )`);
  const known = new Set(["name", "manager", "term", "termDays", "risk", "established", "stock", "edited"]);
  for (const code of Object.keys(reg.patches || {})) {
    const p = reg.patches[code] || {};
    const extra = {};
    for (const k of Object.keys(p)) if (!known.has(k)) extra[k] = p[k];
    pins.run({
      code: String(code).trim().toUpperCase(),
      name: p.name == null ? null : String(p.name),
      manager: p.manager == null ? null : String(p.manager),
      term: p.term == null ? null : String(p.term),
      term_days: p.termDays == null ? null : numOrNull(p.termDays),
      risk: p.risk == null ? null : String(p.risk),
      established: p.established == null ? null : String(p.established),
      stock: p.stock == null ? null : String(p.stock),
      edited: p.edited ? 1 : 0,
      extra_json: Object.keys(extra).length ? JSON.stringify(extra) : null,
    });
  }
  const hide = db.prepare("INSERT INTO product_hidden(code, created_at) VALUES(?, ?)");
  for (const code of reg.hidden || []) {
    const c = String(code || "").trim().toUpperCase();
    if (c) hide.run(c, now);
  }
}

function loadRegistry() {
  const custom = db.prepare("SELECT * FROM product ORDER BY code").all().map((r) => ({
    bank: r.bank,
    code: r.code,
    name: r.name || "",
    manager: r.manager || "",
    term: r.term || "",
    termDays: r.term_days == null ? null : r.term_days,
    risk: r.risk || "",
    established: r.established || "",
    target: r.target == null ? 0.028 : r.target,
    confirm: r.confirm_days,
    stock: r.stock || "",
    quota: r.quota || "",
    benchmark: r.benchmark || "",
  }));
  const patches = {};
  for (const r of db.prepare("SELECT * FROM product_patch").all()) {
    const p = {};
    if (r.name != null) p.name = r.name;
    if (r.manager != null) p.manager = r.manager;
    if (r.term != null) p.term = r.term;
    if (r.term_days != null) p.termDays = r.term_days;
    if (r.risk != null) p.risk = r.risk;
    if (r.established != null) p.established = r.established;
    if (r.stock != null) p.stock = r.stock;
    if (r.edited) p.edited = true;
    if (r.extra_json) {
      try { Object.assign(p, JSON.parse(r.extra_json)); } catch (e) {}
    }
    patches[r.code] = p;
  }
  const hidden = db.prepare("SELECT code FROM product_hidden ORDER BY code").all().map((r) => r.code);
  return { custom, patches, hidden };
}

function replaceObjectRows(table, obj, insertSql, mapRow) {
  db.prepare("DELETE FROM " + table).run();
  if (!obj || typeof obj !== "object") return;
  const ins = db.prepare(insertSql);
  for (const key of Object.keys(obj)) ins.run(mapRow(key, obj[key]));
}

function saveCore(data) {
  if (data.observer_reg_v1 != null) {
    const reg = parseVal(data.observer_reg_v1) || {};
    replaceRegistry({
      custom: Array.isArray(reg.custom) ? reg.custom : [],
      patches: reg.patches && typeof reg.patches === "object" ? reg.patches : {},
      hidden: Array.isArray(reg.hidden) ? reg.hidden : [],
    });
  }
  if (data.observer_favs != null) {
    const favs = parseVal(data.observer_favs);
    db.prepare("DELETE FROM product_fav").run();
    if (Array.isArray(favs)) {
      const ins = db.prepare("INSERT INTO product_fav(code, sort_order) VALUES(?, ?)");
      favs.forEach((code, i) => {
        const c = String(code || "").trim().toUpperCase();
        if (c) ins.run(c, i);
      });
    }
  }
  if (data.observer_prefer_bank != null) {
    replaceObjectRows(
      "product_prefer_bank",
      parseVal(data.observer_prefer_bank),
      "INSERT INTO product_prefer_bank(code, bank) VALUES(?, ?)",
      (code, bank) => [String(code).trim().toUpperCase(), String(bank || "")],
    );
  }
  if (data.observer_info_complete != null || data.observer_summary_ok != null) {
    const keepOther = data.observer_info_complete == null || data.observer_summary_ok == null;
    if (!keepOther) db.prepare("DELETE FROM product_mark").run();
    const fill = (mark, raw) => {
      if (raw == null) return;
      db.prepare("DELETE FROM product_mark WHERE mark = ?").run(mark);
      const obj = parseVal(raw);
      if (!obj || typeof obj !== "object") return;
      const ins = db.prepare("INSERT INTO product_mark(code, mark) VALUES(?, ?)");
      for (const code of Object.keys(obj)) {
        if (obj[code]) ins.run(String(code).trim().toUpperCase(), mark);
      }
    };
    fill("info_complete", data.observer_info_complete);
    fill("summary_ok", data.observer_summary_ok);
  }
  if (data.observer_bank_refresh_msg != null) {
    replaceObjectRows(
      "bank_refresh_msg",
      parseVal(data.observer_bank_refresh_msg),
      "INSERT INTO bank_refresh_msg(bank, message) VALUES(?, ?)",
      (bank, message) => [String(bank), String(message || "")],
    );
  }
  if (data.observer_show_time != null) setSetting("observer_show_time", asStored(parseVal(data.observer_show_time)));
  const known = new Set([
    "observer_reg_v1", "observer_favs", "observer_prefer_bank", "observer_info_complete",
    "observer_summary_ok", "observer_bank_refresh_msg", "observer_show_time",
  ]);
  const extras = Object.keys(data).filter((k) => !known.has(k));
  if (extras.length || data.observer_reg_v1 != null) {
    const old = db.prepare("SELECT key FROM app_setting WHERE key LIKE 'core_extra:%'").all();
    for (const row of old) db.prepare("DELETE FROM app_setting WHERE key = ?").run(row.key);
    for (const k of extras) setSetting("core_extra:" + k, asStored(data[k]));
  }
}

function readCoreData() {
  const data = {};
  const reg = loadRegistry();
  if (reg.custom.length || Object.keys(reg.patches).length || reg.hidden.length) {
    data.observer_reg_v1 = JSON.stringify(reg);
  }
  const favs = db.prepare("SELECT code FROM product_fav ORDER BY sort_order").all().map((r) => r.code);
  if (favs.length) data.observer_favs = JSON.stringify(favs);
  const prefer = {};
  for (const r of db.prepare("SELECT code, bank FROM product_prefer_bank").all()) prefer[r.code] = r.bank;
  if (Object.keys(prefer).length) data.observer_prefer_bank = JSON.stringify(prefer);
  for (const mark of ["info_complete", "summary_ok"]) {
    const obj = {};
    for (const r of db.prepare("SELECT code FROM product_mark WHERE mark = ?").all(mark)) obj[r.code] = 1;
    if (Object.keys(obj).length) data[mark === "info_complete" ? "observer_info_complete" : "observer_summary_ok"] = JSON.stringify(obj);
  }
  const msgs = {};
  for (const r of db.prepare("SELECT bank, message FROM bank_refresh_msg").all()) msgs[r.bank] = r.message;
  if (Object.keys(msgs).length) data.observer_bank_refresh_msg = JSON.stringify(msgs);
  const show = getSetting("observer_show_time");
  if (show != null) data.observer_show_time = show;
  for (const row of db.prepare("SELECT key, value FROM app_setting WHERE key LIKE 'core_extra:%'").all()) {
    data[row.key.slice("core_extra:".length)] = row.value;
  }
  return data;
}

function saveNav(data) {
  let map = parseVal(data.observer_lookup_real) || {};
  const legacy = parseVal(data.observer_lookup_icbc);
  if (legacy && typeof legacy === "object") {
    for (const code of Object.keys(legacy)) if (map[code] == null) map[code] = legacy[code];
  }
  if (!map || typeof map !== "object") return;
  db.prepare("DELETE FROM nav_point").run();
  db.prepare("DELETE FROM nav_snapshot").run();
  const snap = db.prepare(`INSERT INTO nav_snapshot(
    code, name, manager, bank, kind, nav, nav_date, nav_latest, currency, remain_quota,
    quota_state, nav_via, nav_port, last_src_mode, last_src_via, last_src_port,
    benchmark, benchmark_full, sources_json, extra_json, updated_at
  ) VALUES (
    @code, @name, @manager, @bank, @kind, @nav, @nav_date, @nav_latest, @currency, @remain_quota,
    @quota_state, @nav_via, @nav_port, @last_src_mode, @last_src_via, @last_src_port,
    @benchmark, @benchmark_full, @sources_json, @extra_json, @updated_at
  )`);
  const point = db.prepare("INSERT OR REPLACE INTO nav_point(code, nav_date, nav, acc_nav) VALUES(?, ?, ?, ?)");
  const now = new Date().toISOString();
  for (const rawCode of Object.keys(map)) {
    const rec = map[rawCode];
    if (!rec || typeof rec !== "object") continue;
    const code = String(rec.code || rawCode).trim().toUpperCase();
    const extra = {};
    for (const k of Object.keys(rec)) if (!NAV_KEYS.has(k)) extra[k] = rec[k];
    snap.run({
      code,
      name: rec.name || "",
      manager: rec.manager || "",
      bank: rec.bank || "",
      kind: rec.kind || "",
      nav: numOrNull(rec.nav),
      nav_date: rec.navDate || "",
      nav_latest: numOrNull(rec.navLatest),
      currency: rec.currency || "",
      remain_quota: numOrNull(rec.remainQuota),
      quota_state: rec.quotaState || "",
      nav_via: rec.navVia || "",
      nav_port: rec.navPort || "",
      last_src_mode: rec.lastSrcMode || "",
      last_src_via: rec.lastSrcVia || "",
      last_src_port: rec.lastSrcPort || "",
      benchmark: rec.benchmark || "",
      benchmark_full: rec.benchmarkFull || "",
      sources_json: JSON.stringify(rec.navSources || []),
      extra_json: Object.keys(extra).length ? JSON.stringify(extra) : null,
      updated_at: now,
    });
    const series = Array.isArray(rec.series) ? rec.series : [];
    for (const pt of series) {
      if (!pt || !pt[0]) continue;
      const nav = Number(pt[1]);
      if (!Number.isFinite(nav)) continue;
      const acc = pt.length > 2 && pt[2] != null && pt[2] !== "" ? numOrNull(pt[2]) : null;
      point.run(code, String(pt[0]), nav, acc);
    }
  }
}

function readNavMap() {
  const map = {};
  for (const r of db.prepare("SELECT * FROM nav_snapshot").all()) {
    let sources = [];
    try { sources = JSON.parse(r.sources_json || "[]"); } catch (e) { sources = []; }
    let extra = {};
    try { extra = r.extra_json ? JSON.parse(r.extra_json) : {}; } catch (e) { extra = {}; }
    map[r.code] = Object.assign(extra, {
      code: r.code,
      name: r.name || "",
      manager: r.manager || "",
      bank: r.bank || "",
      kind: r.kind || "nav",
      nav: r.nav,
      navDate: r.nav_date || "",
      navLatest: r.nav_latest,
      currency: r.currency || "",
      remainQuota: r.remain_quota,
      quotaState: r.quota_state || "",
      navVia: r.nav_via || "",
      navPort: r.nav_port || "",
      lastSrcMode: r.last_src_mode || "",
      lastSrcVia: r.last_src_via || "",
      lastSrcPort: r.last_src_port || "",
      benchmark: r.benchmark || "",
      benchmarkFull: r.benchmark_full || "",
      navSources: sources,
      series: [],
    });
  }
  for (const r of db.prepare("SELECT code, nav_date, nav, acc_nav FROM nav_point ORDER BY code, nav_date").all()) {
    if (!map[r.code]) {
      map[r.code] = { code: r.code, series: [] };
    }
    map[r.code].series.push([r.nav_date, r.nav, r.acc_nav]);
  }
  return map;
}

function saveLog(data) {
  const at = data.observer_refresh_at != null ? (parseVal(data.observer_refresh_at) || {}) : null;
  const dur = data.observer_refresh_dur != null ? (parseVal(data.observer_refresh_dur) || {}) : null;
  const fail = data.observer_fetch_fail != null ? (parseVal(data.observer_fetch_fail) || {}) : null;
  const br = data.observer_refresh_breakdown != null ? (parseVal(data.observer_refresh_breakdown) || {}) : null;
  if (at || dur || fail || br) {
    const codes = new Set([
      ...Object.keys(at || {}),
      ...Object.keys(dur || {}),
      ...Object.keys(fail || {}),
      ...Object.keys(br || {}),
    ]);
    db.prepare("DELETE FROM refresh_state").run();
    const ins = db.prepare(`INSERT INTO refresh_state(code, refreshed_at, duration_ms, failed, breakdown_json)
      VALUES(?, ?, ?, ?, ?)`);
    for (const code of codes) {
      const c = String(code).trim().toUpperCase();
      let breakdown = br ? br[code] : null;
      if (breakdown != null && typeof breakdown !== "string") breakdown = JSON.stringify(breakdown);
      ins.run(
        c,
        at && at[code] != null ? Number(at[code]) : null,
        dur && dur[code] != null ? Number(dur[code]) : null,
        fail && fail[code] ? 1 : 0,
        breakdown == null ? null : String(breakdown),
      );
    }
  }
  const resetKeys = Object.keys(data).filter((k) => k.indexOf("observer_breakdown_reset") === 0);
  if (resetKeys.length) {
    for (const row of db.prepare("SELECT key FROM app_setting WHERE key LIKE 'observer_breakdown_reset%'").all()) {
      db.prepare("DELETE FROM app_setting WHERE key = ?").run(row.key);
    }
    for (const k of resetKeys) setSetting(k, asStored(data[k]));
  }
}

function readLogData() {
  const at = {};
  const dur = {};
  const fail = {};
  const br = {};
  for (const r of db.prepare("SELECT * FROM refresh_state").all()) {
    if (r.refreshed_at != null) at[r.code] = r.refreshed_at;
    if (r.duration_ms != null) dur[r.code] = r.duration_ms;
    if (r.failed) fail[r.code] = 1;
    if (r.breakdown_json != null) {
      const parsed = parseVal(r.breakdown_json);
      br[r.code] = parsed == null ? r.breakdown_json : parsed;
    }
  }
  const data = {};
  if (Object.keys(at).length) data.observer_refresh_at = JSON.stringify(at);
  if (Object.keys(dur).length) data.observer_refresh_dur = JSON.stringify(dur);
  if (Object.keys(fail).length) data.observer_fetch_fail = JSON.stringify(fail);
  if (Object.keys(br).length) data.observer_refresh_breakdown = JSON.stringify(br);
  for (const row of db.prepare("SELECT key, value FROM app_setting WHERE key LIKE 'observer_breakdown_reset%'").all()) {
    data[row.key] = row.value;
  }
  return data;
}

export function readStateFile(kind) {
  const data = kind === "core" ? readCoreData() : kind === "nav" ? { observer_lookup_real: JSON.stringify(readNavMap()) } : readLogData();
  if (kind === "nav" && data.observer_lookup_real === "{}") {
    const n = db.prepare("SELECT COUNT(*) AS n FROM nav_snapshot").get().n;
    if (!n) data.observer_lookup_real = JSON.stringify({});
  }
  return {
    savedAt: getSetting("state." + kind + ".savedAt"),
    port: Number(getSetting("state.port") || 8766),
    kind,
    label: LABELS[kind] || kind,
    count: Object.keys(data).length,
    data,
  };
}

export function writeStateFile(kind, data, stamp, port) {
  const tx = db.transaction(() => {
    const body = data && typeof data === "object" ? data : {};
    if (kind === "core") saveCore(body);
    else if (kind === "nav") saveNav(body);
    else if (kind === "log") saveLog(body);
    setSetting("state." + kind + ".savedAt", stamp || new Date().toISOString());
    if (port) setSetting("state.port", String(port));
  });
  tx();
  return readStateFile(kind);
}

export function clearRefreshLogs() {
  db.prepare("DELETE FROM refresh_state").run();
  for (const row of db.prepare("SELECT key FROM app_setting WHERE key LIKE 'observer_breakdown_reset%'").all()) {
    db.prepare("DELETE FROM app_setting WHERE key = ?").run(row.key);
  }
  setSetting("state.log.savedAt", new Date().toISOString());
}

export function readLedger() {
  const holdings = db.prepare("SELECT * FROM holding").all().map((r) => ({
    holdingId: r.holding_id,
    productId: r.product_id || "",
    productName: r.product_name || "",
    agencyName: r.agency_name || "",
    productCategory: r.product_category || "",
    trades: parseVal(r.trades_json) || [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
  const aliases = parseVal(getSetting("ledger.aliases"));
  const trades = parseVal(getSetting("ledger.trades"));
  return {
    version: Number(getSetting("ledger.version") || 1),
    holdings,
    aliases: aliases && typeof aliases === "object" ? aliases : {},
    savedAt: getSetting("ledger.saved_at"),
    rev: Number(getSetting("ledger.rev") || 0),
    trades: Array.isArray(trades) ? trades : undefined,
  };
}

export function writeLedger(d) {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM holding").run();
    const ins = db.prepare(`INSERT INTO holding(
      holding_id, product_id, product_name, agency_name, product_category, trades_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const h of (d && d.holdings) || []) {
      if (!h) continue;
      const id = String(h.holdingId || h.holding_id || "");
      if (!id) continue;
      ins.run(
        id,
        String(h.productId || h.product_id || ""),
        String(h.productName || h.product_name || ""),
        String(h.agencyName || h.agency_name || ""),
        String(h.productCategory || h.product_category || ""),
        JSON.stringify(h.trades || []),
        Number(h.createdAt || h.created_at || Date.now()),
        Number(h.updatedAt || h.updated_at || Date.now()),
      );
    }
    setSetting("ledger.version", String((d && d.version) || 1));
    setSetting("ledger.rev", String((d && d.rev) || 0));
    setSetting("ledger.saved_at", (d && d.savedAt) || "");
    setSetting("ledger.aliases", JSON.stringify((d && d.aliases) || {}));
    if (d && Array.isArray(d.trades)) setSetting("ledger.trades", JSON.stringify(d.trades));
  });
  tx();
  return true;
}

export function auxGet(namespace, code) {
  const row = db.prepare("SELECT value FROM aux_map WHERE namespace = ? AND code = ?").get(namespace, code);
  return row ? row.value : "";
}
export function auxSet(namespace, code, value) {
  db.prepare("INSERT INTO aux_map(namespace, code, value) VALUES(?, ?, ?) ON CONFLICT(namespace, code) DO UPDATE SET value = excluded.value")
    .run(namespace, String(code), String(value));
}
export function auxObject(namespace) {
  const out = {};
  for (const r of db.prepare("SELECT code, value FROM aux_map WHERE namespace = ?").all(namespace)) out[r.code] = r.value;
  return out;
}

export function readPidMap() {
  const byCode = auxObject("ledger_pid");
  const byId = {};
  for (const code of Object.keys(byCode)) {
    byCode[code] = Number(byCode[code]);
    byId[String(byCode[code])] = code;
  }
  return { byCode, byId, next: Number(getSetting("ledger_pid.next") || 100001) };
}
export function savePidMap(m) {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM aux_map WHERE namespace = 'ledger_pid'").run();
    for (const code of Object.keys((m && m.byCode) || {})) auxSet("ledger_pid", code, m.byCode[code]);
    setSetting("ledger_pid.next", String((m && m.next) || 100001));
  });
  tx();
}

export function appendBocLog(entry) {
  const e = entry || {};
  db.prepare(`INSERT INTO boc_sync_log(
    ran_at, ok, source, total_count, pages, fetched, added, updated, removed_stale,
    skipped_same, skipped_other, skipped_hidden, invalid, elapsed_ms, error, note, detail_json
  ) VALUES (
    @ran_at, @ok, @source, @total_count, @pages, @fetched, @added, @updated, @removed_stale,
    @skipped_same, @skipped_other, @skipped_hidden, @invalid, @elapsed_ms, @error, @note, @detail_json
  )`).run({
    ran_at: e.at || e.ran_at || new Date().toISOString(),
    ok: e.ok ? 1 : 0,
    source: e.source || "",
    total_count: numOrNull(e.total),
    pages: numOrNull(e.pages),
    fetched: numOrNull(e.fetched),
    added: numOrNull(e.added),
    updated: numOrNull(e.updated != null ? e.updated : e.renamed),
    removed_stale: numOrNull(e.removedStale != null ? e.removedStale : e.removedHistory),
    skipped_same: numOrNull(e.skippedSame),
    skipped_other: numOrNull(e.skippedOther),
    skipped_hidden: numOrNull(e.skippedHidden),
    invalid: numOrNull(e.invalid),
    elapsed_ms: numOrNull(e.elapsedMs),
    error: e.error || null,
    note: e.note || "",
    detail_json: JSON.stringify({
      pageErrors: e.pageErrors || [],
      addedSample: e.addedSample || [],
      updatedSample: e.updatedSample || e.renamedSample || [],
      removedSample: e.removedSample || [],
    }),
  });
}

function importJsonFile(file) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return null; }
}

function importAuxJson(namespace, file) {
  if (db.prepare("SELECT COUNT(*) AS n FROM aux_map WHERE namespace = ?").get(namespace).n) return;
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) return;
  try {
    const obj = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
    if (obj.byCode && obj.byId) return;
    for (const code of Object.keys(obj)) {
      if (obj[code] == null || typeof obj[code] === "object") continue;
      auxSet(namespace, code, obj[code]);
    }
  } catch (e) {}
}

function migrateFromJson() {
  if (getSetting("migrated_json") === "1") return;
  if (db.prepare("SELECT COUNT(*) AS n FROM product").get().n > 0) {
    setSetting("migrated_json", "1");
    return;
  }
  const tx = db.transaction(() => {
    const core = importJsonFile("产品数据.json");
    if (core && core.data) saveCore(core.data);
    const nav = importJsonFile("净值数据.json");
    if (nav && nav.data) saveNav(nav.data);
    const log = importJsonFile("运行日志.json");
    if (log && log.data) saveLog(log.data);
    const ledger = importJsonFile("台账数据.json");
    if (ledger && typeof ledger === "object") writeLedger(ledger);
    const pidFile = path.join(ROOT, "_ledger_app", "product-id-map.json");
    if (fs.existsSync(pidFile)) {
      try {
        const m = JSON.parse(fs.readFileSync(pidFile, "utf8"));
        if (m && m.byCode) savePidMap(m);
      } catch (e) {}
    }
    importAuxJson("ceb_access", "scrape/ceb_eoap_access.json");
    importAuxJson("comm_share", "scrape/comm_share.json");
    const logFile = path.join(ROOT, "中行产品库日志.jsonl");
    if (fs.existsSync(logFile) && !db.prepare("SELECT COUNT(*) AS n FROM boc_sync_log").get().n) {
      for (const line of fs.readFileSync(logFile, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { appendBocLog(JSON.parse(line)); } catch (e) {}
      }
    }
    const stamp = (core && core.savedAt) || new Date().toISOString();
    setSetting("state.core.savedAt", (core && core.savedAt) || stamp);
    setSetting("state.nav.savedAt", (nav && nav.savedAt) || stamp);
    setSetting("state.log.savedAt", (log && log.savedAt) || stamp);
    if (core && core.port) setSetting("state.port", String(core.port));
    setSetting("migrated_json", "1");
  });
  tx();
  const n = db.prepare("SELECT COUNT(*) AS n FROM product").get().n;
  const pts = db.prepare("SELECT COUNT(*) AS n FROM nav_point").get().n;
  console.log("[db] 已从 JSON 导入 wealth.sqlite：产品 " + n + "，净值点 " + pts);
}

migrateFromJson();

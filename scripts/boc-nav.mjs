/**
 * 每天北京时间 07:35 之后，按顺序更新中国银行产品净值。
 * 收藏的排在前面。一路一只，抓完再抓下一只。
 * 现金管理类（净值恒为 1）不写入。已有序列按日期并上，不整段覆盖。
 */
import { listBocNavTargets, readNavForCodes, touchRefreshAt, upsertNavRecord } from "../db.mjs";

const GAP_MS = 400;

function mergeSeries(prev, neu) {
  const m = new Map();
  for (const p of prev || []) if (p && p[0]) m.set(String(p[0]), p);
  for (const p of neu || []) if (p && p[0]) m.set(String(p[0]), p);
  return [...m.values()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function hasText(v) {
  return v != null && String(v).trim() !== "";
}

function mergeRecord(code, prev, got) {
  const series = mergeSeries(prev && prev.series, got.series);
  const last = series.length ? series[series.length - 1] : null;
  const out = Object.assign({}, prev || {});
  out.code = code;
  out.bank = "boc";
  out.kind = got.kind || out.kind || "nav";
  if (hasText(got.name)) out.name = got.name;
  if (hasText(got.manager)) out.manager = got.manager;
  if (hasText(got.risk)) out.risk = got.risk;
  if (got.holdDays != null) out.holdDays = got.holdDays;
  if (hasText(got.established)) out.established = got.established;
  if (hasText(got.regCode)) out.regCode = got.regCode;
  if (hasText(got.benchmark)) out.benchmark = got.benchmark;
  out.series = series;
  out.nav = last ? last[1] : out.nav;
  out.navDate = last ? String(last[0]) : (out.navDate || "");
  if (got.latestNav != null) out.navLatest = got.latestNav;
  out.navVia = "boc";
  out.navPort = got.navPort || out.navPort || "web";
  out.lastSrcMode = "nav";
  out.lastSrcVia = "boc";
  out.lastSrcPort = out.navPort;
  return out;
}

async function runOnce(bocFetch) {
  const targets = listBocNavTargets();
  const favN = targets.filter((t) => t.fav).length;
  console.log("[boc-nav] 开始更新中国银行净值，共 " + targets.length + " 只，其中收藏 " + favN + " 只优先。一路顺序抓取");
  let ok = 0;
  let skip = 0;
  let fail = 0;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const label = (i + 1) + "/" + targets.length + (t.fav ? " 收藏" : "") + " " + t.code;
    const t0 = Date.now();
    try {
      const got = await bocFetch(t.code, { mode: "nav" });
      if (!got || got._excludedCash || !Array.isArray(got.series) || !got.series.length) {
        skip++;
        console.log("[boc-nav] " + label + " 跳过（无净值或现金管理）");
      } else {
        const prev = readNavForCodes([t.code])[t.code] || null;
        const merged = mergeRecord(t.code, prev, got);
        if (!merged.series.length) {
          skip++;
          console.log("[boc-nav] " + label + " 跳过（合并后没有净值）");
        } else {
          upsertNavRecord(t.code, merged);
          touchRefreshAt(t.code, Date.now() - t0);
          ok++;
          console.log("[boc-nav] " + label + " " + (t.name || merged.name || "") + " 净值 " + merged.series.length + " 点 最新 " + merged.navDate);
        }
      }
    } catch (e) {
      fail++;
      console.warn("[boc-nav] " + label + " 失败：" + ((e && e.message) || e));
    }
    if (i + 1 < targets.length) await new Promise((r) => setTimeout(r, GAP_MS));
  }
  console.log("[boc-nav] 完成 成功 " + ok + " 跳过 " + skip + " 失败 " + fail);
  return { ok, skip, fail, total: targets.length };
}

export function startBocNavSchedule() {
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
    if (minutes() < 7 * 60 + 35) return;
    const day = dayKey();
    if (lastSuccessDay === day) return;
    running = true;
    try {
      const worker = await import("../scrape/worker.js");
      const result = await runOnce(worker.bocFetch);
      if (result.total > 0 && result.ok === 0 && result.fail > 0) {
        nextAllowed = Date.now() + 30 * 60 * 1000;
        console.warn("[boc-nav] 一只都没更新成功，30 分钟后再试");
      } else {
        lastSuccessDay = day;
      }
    } catch (e) {
      console.warn("[boc-nav] 更新失败：" + ((e && e.message) || e));
      nextAllowed = Date.now() + 30 * 60 * 1000;
    } finally {
      running = false;
    }
  };
  setInterval(tick, 60 * 1000);
  setTimeout(tick, 8000);
  console.log("[boc-nav] 已排程：每天 07:35（北京时间）之后更新中国银行净值，收藏优先，一路顺序抓取");
}

/* 持仓年化（列表「持有年化率」与详情「持仓年化」共用）
 * 经典脚本：浏览器里挂到 window.computeHeldAnn；node --test 直接 require。
 *
 * 口径：赎回/卖出按确认日从最早买入批次扣减，只对剩余份额计算。
 * 总收益 = 剩余份额市值 / 剩余份额成本 - 1（成本 = 份额 × 买入确认净值）。
 * 持有天数 = 剩余份额加权平均（确认日 → 最新净值日）。
 * 年化 = (1 + 总收益) ^ (365 / 加权天数) - 1，结果为百分比。
 * 买入净值缺失时，回落到确认日（含）之后首个 v===1 且净值 > 0 的序列点。
 * 无成交、无剩余份额、缺净值、持有天数 ≤ 0、总收益 ≤ -100% 时返回 null。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.computeHeldAnn = api.computeHeldAnn;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  var SELL_TYPES = { sell: 1, redeem: 1, redemption: 1 };

  function utcDay(ds) {
    if (!ds || !/^\d{4}-\d{2}-\d{2}/.test(String(ds))) return NaN;
    return Date.parse(String(ds).slice(0, 10) + "T00:00:00Z");
  }

  function resolveBuyNav(nav, date, daily) {
    var n = Number(nav);
    if (n > 0 && isFinite(n)) return n;
    if (!daily || !date) return null;
    for (var i = 0; i < daily.length; i++) {
      var p = daily[i];
      if (p && p.date >= date && p.v === 1 && Number(p.nav) > 0 && isFinite(Number(p.nav))) return Number(p.nav);
    }
    return null;
  }

  function computeHeldAnn(trades, daily) {
    if (!Array.isArray(trades) || !trades.length || !Array.isArray(daily) || !daily.length) return null;
    var last = null;
    for (var i = daily.length - 1; i >= 0; i--) {
      var row = daily[i];
      if (row && Number(row.nav) > 0 && isFinite(Number(row.nav)) && row.date) { last = row; break; }
    }
    if (!last) return null;
    var latestDate = String(last.date).slice(0, 10);
    var latestNav = Number(last.nav);
    var latestMs = utcDay(latestDate);
    if (!(latestNav > 0) || !isFinite(latestNav) || !isFinite(latestMs)) return null;

    var lots = [];
    var events = trades.slice().sort(function (a, b) {
      var da = String((a && a.date) || ""), db = String((b && b.date) || "");
      if (da < db) return -1;
      if (da > db) return 1;
      var sa = a && SELL_TYPES[a.type] ? 1 : 0;
      var sb = b && SELL_TYPES[b.type] ? 1 : 0;
      return sa - sb;
    });
    for (var t = 0; t < events.length; t++) {
      var ev = events[t];
      if (!ev) continue;
      var q = Number(ev.shares);
      if (!(q > 0) || !isFinite(q)) continue;
      var date = String(ev.date || "").slice(0, 10);
      if (SELL_TYPES[ev.type]) {
        var left = q;
        for (var k = 0; k < lots.length; k++) {
          if (!(left > 1e-9)) break;
          var take = Math.min(lots[k].shares, left);
          lots[k].shares -= take;
          left -= take;
        }
        continue;
      }
      if (ev.type && ev.type !== "buy") continue;
      var nav = resolveBuyNav(ev.nav, date, daily);
      if (!(nav > 0) || !isFinite(nav)) continue;
      lots.push({ date: date, nav: nav, shares: q });
    }

    var totalCost = 0, totalValue = 0, wDays = 0, wShares = 0, earliest = null;
    for (var j = 0; j < lots.length; j++) {
      var lot = lots[j];
      var shares = lot.shares;
      if (!(shares > 1e-9)) continue;
      var days = Math.round((latestMs - utcDay(lot.date)) / 86400000);
      if (!isFinite(days) || days <= 0) continue;
      totalCost += shares * lot.nav;
      totalValue += shares * latestNav;
      wDays += shares * days;
      wShares += shares;
      if (!earliest || lot.date < earliest) earliest = lot.date;
    }
    if (!(totalCost > 0) || !(wShares > 0) || !isFinite(totalCost) || !isFinite(totalValue)) return null;
    var totalRet = totalValue / totalCost - 1;
    var avgDays = wDays / wShares;
    if (!(avgDays > 0) || !isFinite(avgDays) || !(1 + totalRet > 0)) return null;
    var ann = (Math.pow(1 + totalRet, 365 / avgDays) - 1) * 100;
    if (!isFinite(ann)) return null;
    return {
      ann: Math.round(ann * 100) / 100,
      totalRetPct: Math.round(totalRet * 10000) / 100,
      avgDays: Math.round(avgDays),
      startDate: earliest,
      latestDate: latestDate,
      shares: Math.round(wShares * 100) / 100,
    };
  }

  return { computeHeldAnn: computeHeldAnn };
});

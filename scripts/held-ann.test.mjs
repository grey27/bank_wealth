import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { computeHeldAnn } = require("../held-ann.js");

function daily(points) {
  return points.map(([date, nav]) => ({ date, nav, v: 1 }));
}

test("单笔买入：按确认日到最新净值日年化", () => {
  const trades = [{ type: "buy", date: "2026-01-01", nav: 1, shares: 100 }];
  const r = computeHeldAnn(trades, daily([["2026-01-01", 1], ["2026-01-31", 1.01]]));
  assert.ok(r);
  assert.equal(r.startDate, "2026-01-01");
  assert.equal(r.avgDays, 30);
  assert.equal(r.shares, 100);
  assert.equal(r.totalRetPct, 1);
  const expect = Math.round((Math.pow(1.01, 365 / 30) - 1) * 100 * 100) / 100;
  assert.equal(r.ann, expect);
  assert.ok(Number.isFinite(r.ann));
});

test("多笔加仓：剩余份额加权天数与加权成本", () => {
  const trades = [
    { type: "buy", date: "2026-01-01", nav: 1, shares: 100 },
    { type: "buy", date: "2026-01-11", nav: 1.02, shares: 50 },
  ];
  const r = computeHeldAnn(trades, daily([
    ["2026-01-01", 1],
    ["2026-01-11", 1.02],
    ["2026-01-31", 1.05],
  ]));
  assert.ok(r);
  assert.equal(r.shares, 150);
  assert.equal(r.startDate, "2026-01-01");
  assert.equal(r.avgDays, Math.round((100 * 30 + 50 * 20) / 150));
  const cost = 100 * 1 + 50 * 1.02;
  const totalRet = (150 * 1.05) / cost - 1;
  const ann = Math.round((Math.pow(1 + totalRet, 365 / ((100 * 30 + 50 * 20) / 150)) - 1) * 100 * 100) / 100;
  assert.equal(r.ann, ann);
});

test("部分赎回：只对剩余份额计成本、市值和天数", () => {
  const trades = [
    { type: "buy", date: "2026-01-01", nav: 1, shares: 100 },
    { type: "buy", date: "2026-01-11", nav: 1.1, shares: 40 },
    { type: "sell", date: "2026-01-21", shares: 60 },
  ];
  const r = computeHeldAnn(trades, daily([
    ["2026-01-01", 1],
    ["2026-01-21", 1.05],
    ["2026-01-31", 1.2],
  ]));
  assert.ok(r);
  assert.equal(r.shares, 80);
  const cost = 40 * 1 + 40 * 1.1;
  const days = (40 * 30 + 40 * 20) / 80;
  const totalRet = (80 * 1.2) / cost - 1;
  assert.equal(r.avgDays, Math.round(days));
  assert.equal(r.ann, Math.round((Math.pow(1 + totalRet, 365 / days) - 1) * 100 * 100) / 100);
});

test("全部赎回、缺净值、0 或负持有天数、非持仓都不产出虚假年化", () => {
  const series = daily([["2026-01-01", 1], ["2026-01-31", 1.02]]);
  assert.equal(computeHeldAnn([
    { type: "buy", date: "2026-01-01", nav: 1, shares: 10 },
    { type: "redeem", date: "2026-01-20", shares: 10 },
  ], series), null);
  assert.equal(computeHeldAnn([
    { type: "buy", date: "2026-01-01", nav: null, shares: 10 },
  ], [{ date: "2026-01-31", nav: 1.02, v: 0 }]), null);
  assert.equal(computeHeldAnn([
    { type: "buy", date: "2026-01-01", nav: 0, shares: 10 },
  ], [{ date: "2026-01-31", nav: NaN, v: 1 }]), null);
  assert.equal(computeHeldAnn([
    { type: "buy", date: "2026-02-01", nav: 1, shares: 10 },
  ], series), null);
  assert.equal(computeHeldAnn([
    { type: "buy", date: "2026-01-31", nav: 1, shares: 10 },
  ], series), null);
  assert.equal(computeHeldAnn([], series), null);
  assert.equal(computeHeldAnn(null, series), null);
  assert.equal(computeHeldAnn([{ type: "buy", date: "not-a-date", nav: 1, shares: 10 }], series), null);
  const loss = computeHeldAnn([
    { type: "buy", date: "2026-01-01", nav: 1, shares: 10 },
  ], daily([["2026-01-01", 1], ["2026-01-31", 0]]));
  assert.equal(loss, null);
});

test("买入净值缺失时回落到确认日之后首个有效净值", () => {
  const r = computeHeldAnn(
    [{ type: "buy", date: "2026-01-01", nav: null, shares: 10 }],
    [
      { date: "2026-01-01", nav: 0, v: 1 },
      { date: "2026-01-02", nav: 1, v: 1 },
      { date: "2026-02-01", nav: 1.02, v: 1 },
    ]
  );
  assert.ok(r);
  assert.equal(r.shares, 10);
  assert.equal(r.avgDays, 31);
  const expect = Math.round((Math.pow(1.02, 365 / 31) - 1) * 100 * 100) / 100;
  assert.equal(r.ann, expect);
});

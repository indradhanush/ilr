// Tests for the sliding-window model in src/model.ts (compiled to dist/model.js).
//
// The point of this file is off-by-one safety: window length, boundary
// inclusion, the breach threshold, and the block-start optimisation are each
// pinned by an exact case, and the optimisation is also cross-checked against
// a brute-force daily sweep over randomised trip sets.
//
// Run with: make test

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");

const M = require(path.join(__dirname, "..", "dist", "model.js"));
const { WINDOW, toDay, tripBlocks, initialBlock, overlappingTrips, tripBounds, daysIn, analyseWindows, analysePastBlocks, series } = M;

const LIMIT = 180;

/** Trip literal helper: model trips use `ret`, the data file uses `return`. */
function trip(depart, ret) {
  return { depart, ret, place: "", reason: "" };
}

/** Blocks from day-number pairs, when the trip layer is not under test. */
function blk(pairs) {
  return pairs.map(([s, e], i) => ({ s, e, trip: i }));
}

/**
 * Brute-force reference: evaluate EVERY window start from well before the
 * first block to past the last one. Any off-by-one in the block-start
 * optimisation shows up as a disagreement with this sweep.
 */
function brutePeak(bs) {
  if (!bs.length) return 0;
  const minS = Math.min(...bs.map((b) => b.s));
  const maxE = Math.max(...bs.map((b) => b.e));
  let peak = 0;
  for (let d = minS - WINDOW; d <= maxE + 1; d++) {
    const n = daysIn(bs, d, d + WINDOW - 1);
    if (n > peak) peak = n;
  }
  return peak;
}

/** Deterministic PRNG so a fuzz failure reproduces. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- day arithmetic ---------- */

test("toDay counts consecutive days across month, year and leap boundaries", () => {
  assert.equal(toDay("2025-01-02") - toDay("2025-01-01"), 1);
  assert.equal(toDay("2025-02-01") - toDay("2025-01-31"), 1);
  assert.equal(toDay("2026-01-01") - toDay("2025-12-31"), 1);
  assert.equal(toDay("2024-02-29") - toDay("2024-02-28"), 1);
  assert.equal(toDay("2024-03-01") - toDay("2024-02-29"), 1);
  assert.equal(toDay("2025-01-01") - toDay("2024-01-01"), 366); // 2024 is a leap year
});

/* ---------- tripBlocks: the travel-day convention ---------- */

test("a 10-Jan to 20-Jan trip costs 11/10/10/9 days across the four conventions", () => {
  const t = [trip("2025-01-10", "2025-01-20")];
  const d = toDay("2025-01-10");
  const r = toDay("2025-01-20");

  const both = tripBlocks(t, true, true);
  assert.deepEqual(both, [{ s: d, e: r, trip: 0 }]);
  assert.equal(both[0].e - both[0].s + 1, 11);

  const noDep = tripBlocks(t, false, true);
  assert.deepEqual(noDep, [{ s: d + 1, e: r, trip: 0 }]);
  assert.equal(noDep[0].e - noDep[0].s + 1, 10);

  const noArr = tripBlocks(t, true, false);
  assert.deepEqual(noArr, [{ s: d, e: r - 1, trip: 0 }]);
  assert.equal(noArr[0].e - noArr[0].s + 1, 10);

  const neither = tripBlocks(t, false, false);
  assert.deepEqual(neither, [{ s: d + 1, e: r - 1, trip: 0 }]);
  assert.equal(neither[0].e - neither[0].s + 1, 9);
});

test("a same-day trip costs 1 day when both travel days count, else nothing", () => {
  const t = [trip("2025-03-05", "2025-03-05")];
  assert.equal(tripBlocks(t, true, true).length, 1);
  assert.equal(daysIn(tripBlocks(t, true, true), 0, 1e9), 1);
  assert.equal(tripBlocks(t, false, true).length, 0);
  assert.equal(tripBlocks(t, true, false).length, 0);
  assert.equal(tripBlocks(t, false, false).length, 0);
});

test("inverted and incomplete trips are dropped", () => {
  assert.equal(tripBlocks([trip("2025-03-05", "2025-03-01")], true, true).length, 0);
  assert.equal(tripBlocks([trip("", "2025-03-01")], true, true).length, 0);
  assert.equal(tripBlocks([trip("2025-03-05", "")], true, true).length, 0);
});

/* ---------- initialBlock: visa validity until first arrival ---------- */

test("the visa-valid-from day always counts; the arrival day follows its switch", () => {
  // 1 Jan through 20 Jan 2024: 20 days inclusive.
  const withArrival = initialBlock("2024-01-01", "2024-01-20", true);
  assert.deepEqual(withArrival, { s: toDay("2024-01-01"), e: toDay("2024-01-20"), trip: -1 });
  assert.equal(withArrival.e - withArrival.s + 1, 20);

  const withoutArrival = initialBlock("2024-01-01", "2024-01-20", false);
  assert.equal(withoutArrival.s, toDay("2024-01-01"));
  assert.equal(withoutArrival.e - withoutArrival.s + 1, 19);
});

test("arriving the day the visa starts costs 1 day or nothing, by the arrival switch", () => {
  assert.equal(initialBlock("2024-01-01", "2024-01-01", true).e -
               initialBlock("2024-01-01", "2024-01-01", true).s + 1, 1);
  assert.equal(initialBlock("2024-01-01", "2024-01-01", false), null);
});

test("a missing or inverted initial pair yields no block", () => {
  assert.equal(initialBlock("", "2024-01-20", true), null);
  assert.equal(initialBlock("2024-01-01", "", true), null);
  assert.equal(initialBlock("2024-01-20", "2024-01-01", true), null);
});

/* ---------- overlappingTrips: no shared calendar days ---------- */

test("disjoint and back-to-back trips do not overlap", () => {
  assert.deepEqual(overlappingTrips([
    trip("2025-01-01", "2025-01-10"),
    trip("2025-02-01", "2025-02-10"),
  ]), []);
  // Departing the day after returning is the tightest legal spacing.
  assert.deepEqual(overlappingTrips([
    trip("2025-01-01", "2025-01-10"),
    trip("2025-01-11", "2025-01-20"),
  ]), []);
});

test("sharing a single day is an overlap, including return-day departures", () => {
  // Returning and departing again on the same day would double-count that
  // day under the strictest convention, so it is rejected.
  assert.deepEqual(overlappingTrips([
    trip("2025-01-01", "2025-01-10"),
    trip("2025-01-10", "2025-01-20"),
  ]), [[0, 1]]);
});

test("partial and nested overlaps are detected, in either row order", () => {
  assert.deepEqual(overlappingTrips([
    trip("2025-01-01", "2025-01-15"),
    trip("2025-01-10", "2025-01-20"),
  ]), [[0, 1]]);
  // One trip entirely inside another.
  assert.deepEqual(overlappingTrips([
    trip("2025-01-01", "2025-01-31"),
    trip("2025-01-10", "2025-01-12"),
  ]), [[0, 1]]);
  // Later row starting earlier still pairs up.
  assert.deepEqual(overlappingTrips([
    trip("2025-02-01", "2025-02-10"),
    trip("2025-01-25", "2025-02-03"),
  ]), [[0, 1]]);
});

test("incomplete and inverted trips never count as overlapping", () => {
  assert.deepEqual(overlappingTrips([
    trip("2025-01-01", "2025-01-31"),
    trip("2025-01-10", ""),           // no return yet
    trip("2025-01-20", "2025-01-05"), // inverted: already flagged elsewhere
  ]), []);
});

test("every overlapping pair is reported, not just the first", () => {
  assert.deepEqual(overlappingTrips([
    trip("2025-01-01", "2025-01-31"),
    trip("2025-01-05", "2025-01-10"),
    trip("2025-01-20", "2025-02-05"),
  ]), [[0, 1], [0, 2]]);
});

test("the shipped example data has no overlaps, initial stay included", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "trips.js.example"), "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(src, sandbox);
  const data = sandbox.window.ILR_DATA;
  assert.ok(data.visaValidFrom && data.firstArrivalOn);
  const rows = [
    trip(data.visaValidFrom, data.firstArrivalOn),
    ...data.trips.map((t) => trip(t.depart, t.return)),
  ];
  assert.deepEqual(overlappingTrips(rows), []);
});

/* ---------- tripBounds: what the date pickers grey out ---------- */

test("a trip between two others is bounded to the gap it sits in", () => {
  const ts = [
    trip("2025-01-01", "2025-01-10"),
    trip("2025-02-01", "2025-02-10"),
    trip("2025-03-01", "2025-03-10"),
  ];
  const b = tripBounds(ts, 1);
  // The day after the previous return through the day before the next departure.
  assert.deepEqual(b, { min: toDay("2025-01-11"), max: toDay("2025-02-28") });
});

test("first and last trips are unbounded on the open side; a lone trip on both", () => {
  const ts = [
    trip("2025-01-01", "2025-01-10"),
    trip("2025-02-01", "2025-02-10"),
  ];
  assert.deepEqual(tripBounds(ts, 0), { min: null, max: toDay("2025-01-31") });
  assert.deepEqual(tripBounds(ts, 1), { min: toDay("2025-01-11"), max: null });
  assert.deepEqual(tripBounds([trip("2025-01-01", "2025-01-10")], 0), { min: null, max: null });
});

test("bounds use the nearest neighbours regardless of row order", () => {
  const ts = [
    trip("2025-03-01", "2025-03-10"), // later trip listed first
    trip("2025-02-01", "2025-02-10"),
    trip("2025-01-01", "2025-01-10"),
  ];
  assert.deepEqual(tripBounds(ts, 1), { min: toDay("2025-01-11"), max: toDay("2025-02-28") });
});

test("incomplete, inverted and already-overlapping rows impose no bound", () => {
  const ts = [
    trip("2025-02-01", "2025-02-10"),
    trip("2025-01-01", ""),           // no return yet
    trip("2025-01-20", "2025-01-05"), // inverted
    trip("2025-02-05", "2025-02-15"), // overlaps row 0: must stay fixable
  ];
  assert.deepEqual(tripBounds(ts, 0), { min: null, max: null });
  // And a row with no dates at all is unbounded.
  assert.deepEqual(tripBounds([trip("", ""), trip("2025-01-01", "2025-01-10")], 0),
    { min: null, max: null });
});

test("a row missing one date is anchored by the date it still has", () => {
  const ts = [
    trip("2025-01-01", "2025-01-10"),
    trip("2025-02-01", ""), // departure only
    trip("2025-03-01", "2025-03-10"),
  ];
  assert.deepEqual(tripBounds(ts, 1), { min: toDay("2025-01-11"), max: toDay("2025-02-28") });
});

/* ---------- daysIn: inclusive boundaries ---------- */

test("daysIn includes both window edges and nothing beyond them", () => {
  const bs = blk([[10, 20]]);
  assert.equal(daysIn(bs, 10, 20), 11); // exact fit
  assert.equal(daysIn(bs, 20, 30), 1);  // touches the last block day
  assert.equal(daysIn(bs, 21, 30), 0);  // starts one past the block
  assert.equal(daysIn(bs, 0, 10), 1);   // touches the first block day
  assert.equal(daysIn(bs, 0, 9), 0);    // ends one short of the block
  assert.equal(daysIn(bs, 12, 15), 4);  // window inside the block
  assert.equal(daysIn(bs, 0, 100), 11); // block inside the window
});

/* ---------- the 365-day window itself ---------- */

test("a window is exactly 365 days: day s+364 is in, day s+365 is out", () => {
  // One absent day at s, another 364 days later: both fit in one window.
  let bs = blk([[0, 0], [364, 364]]);
  let A = analyseWindows(bs, LIMIT);
  assert.equal(A.peak, 2);
  assert.deepEqual({ start: A.peakWin.start, end: A.peakWin.end }, { start: 0, end: 364 });

  // 365 days later: no single window holds both.
  bs = blk([[0, 0], [365, 365]]);
  A = analyseWindows(bs, LIMIT);
  assert.equal(A.peak, 1);
});

test("365 consecutive absent days fill a window; a 366th day does not raise the peak", () => {
  assert.equal(analyseWindows(blk([[100, 100 + 364]]), LIMIT).peak, 365);
  assert.equal(analyseWindows(blk([[100, 100 + 365]]), LIMIT).peak, 365);
});

/* ---------- the breach threshold ---------- */

test("exactly 180 days is within the limit; 181 is a breach", () => {
  // Departure 1 Jan counted, arrival counted: 1 Jan..29 Jun inclusive = 180 days.
  const ok = analyseWindows(tripBlocks([trip("2025-01-01", "2025-06-29")], true, true), LIMIT);
  assert.equal(ok.peak, 180);
  assert.equal(ok.peakWin.breach, false);
  assert.equal(ok.windows.every((w) => !w.breach), true);

  const bad = analyseWindows(tripBlocks([trip("2025-01-01", "2025-06-30")], true, true), LIMIT);
  assert.equal(bad.peak, 181);
  assert.equal(bad.peakWin.breach, true);
});

test("two trips 6 months apart combine inside one window", () => {
  // 90 days in Jan-Mar plus 91 days in Jul-Sep of the same year: one window
  // sees both, so the peak is the sum even though each trip alone is fine.
  const bs = tripBlocks([
    trip("2025-01-01", "2025-03-31"), // 90 days
    trip("2025-07-01", "2025-09-29"), // 91 days
  ], true, true);
  const A = analyseWindows(bs, LIMIT);
  assert.equal(A.total, 181);
  assert.equal(A.peak, 181);
  assert.equal(A.peakWin.breach, true);
  assert.equal(A.peakWin.start, toDay("2025-01-01"));
});

/* ---------- the block-start optimisation vs brute force ---------- */

test("peak equals a brute-force sweep of every window start (fuzz, seeded)", () => {
  const rand = mulberry32(0x11a042);
  for (let iter = 0; iter < 300; iter++) {
    const n = 1 + Math.floor(rand() * 6);
    const bs = [];
    let cursor = Math.floor(rand() * 200);
    for (let i = 0; i < n; i++) {
      const s = cursor + Math.floor(rand() * 250);
      const len = 1 + Math.floor(rand() * 120);
      bs.push({ s, e: s + len - 1, trip: i });
      cursor = s + len + 1; // non-overlapping, like real trips
    }
    const A = analyseWindows(bs, LIMIT);
    assert.equal(A.peak, brutePeak(bs), `iter ${iter}: ${JSON.stringify(bs)}`);
  }
});

/* ---------- analysePastBlocks: elapsed windows only ---------- */

test("a window ending exactly today counts as fully elapsed", () => {
  const t = 10000;
  const bs = blk([[t - 364, t]]); // 365 absent days ending today
  assert.equal(analysePastBlocks(bs, t).days, 365);
});

test("absence after today is invisible; a trip in progress is cut off at today", () => {
  const t = 10000;
  // Future trip: ignored entirely.
  assert.deepEqual(analysePastBlocks(blk([[t + 1, t + 50]]), t), { days: 0, win: null });
  // In progress: departed 50 days ago, returns in 50 days. Only 51 days
  // (departure day through today, inclusive) have been incurred.
  assert.equal(analysePastBlocks(blk([[t - 50, t + 50]]), t).days, 51);
  // Departing today costs exactly 1 day so far.
  assert.equal(analysePastBlocks(blk([[t, t + 50]]), t).days, 1);
});

test("past peak can be lower than the all-time peak when the worst window has not elapsed", () => {
  const t = 10000;
  // 100 absent days ending 300 days from now: the worst window is in the
  // future, but 41 of those days (t-40..t) have already been incurred.
  const bs = blk([[t - 40, t + 59]]);
  assert.equal(analyseWindows(bs, LIMIT).peak, 100);
  assert.equal(analysePastBlocks(bs, t).days, 41);
});

/* ---------- series: the trailing window the chart plots ---------- */

test("series value at d equals the 365-day window ending on d", () => {
  const bs = blk([[500, 560], [700, 730]]);
  const pts = series(bs, 400, 1200);
  for (const p of [pts[0], pts[100], pts[164], pts[165], pts[464], pts[465], pts[800]]) {
    assert.equal(p.v, daysIn(bs, p.d - WINDOW + 1, p.d));
  }
  // The curve's value at a block's window end matches the window table.
  const A = analyseWindows(bs, LIMIT);
  for (const w of A.windows) {
    const p = pts.find((q) => q.d === w.end);
    assert.equal(p.v, w.days);
  }
  // First absent day appears in exactly the 365 windows ending on days
  // 500..864: day 499's window misses it, day 865's window has aged it out.
  assert.equal(pts.find((q) => q.d === 499).v, 0);
  assert.equal(pts.find((q) => q.d === 500).v, 1);
  assert.equal(pts.find((q) => q.d === 864).v > 0, true);
  assert.equal(pts.find((q) => q.d === 560 + WINDOW).v, daysIn(bs, 560 + 1, 560 + WINDOW));
});

/* ---------- the real data file stays internally consistent ---------- */

test("the example data loads and its peak matches the brute-force sweep", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "trips.js.example"), "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(src, sandbox);
  const data = sandbox.window.ILR_DATA;
  assert.ok(Array.isArray(data.trips) && data.trips.length > 0);

  const trips = data.trips.map((t) => trip(t.depart, t.return));
  for (const [cd, ca] of [[true, true], [false, true], [true, false], [false, false]]) {
    const bs = tripBlocks(trips, cd, ca);
    const ib = initialBlock(data.visaValidFrom, data.firstArrivalOn, ca);
    if (ib) bs.push(ib);
    bs.sort((a, b) => a.s - b.s);
    assert.equal(analyseWindows(bs, data.limit).peak, brutePeak(bs));
  }
});

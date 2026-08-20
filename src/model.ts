/**
 * The pure sliding-window model for the ILR absence tracker.
 *
 * Everything here is a plain function of its arguments: no DOM, no module
 * state. app.ts drives it in the browser; test/model.test.js drives it in
 * Node through the CommonJS guard at the bottom. Both files compile as plain
 * scripts sharing one global scope, so there are no import/export statements.
 */

/** A trip as the page holds it. `ret` avoids clashing with the reserved word. */
interface Trip {
  depart: string;
  ret: string;
  place: string;
  reason: string;
}

/** The run of days a trip actually costs, after the convention is applied. */
interface Block {
  s: number;
  e: number;
  trip: number;
}

interface Win {
  start: number;
  end: number;
  days: number;
  trip: number;
  breach: boolean;
}

interface PastWin {
  start: number;
  end: number;
  days: number;
}

interface WindowAnalysis {
  windows: Win[];
  peak: number;
  peakWin: Win | null;
  total: number;
}

const DAY = 86400000;
const WINDOW = 365; // a 12-month window is 365 days, counted inclusively

function toDay(iso: string): number {
  const p = String(iso).split("-");
  return Math.floor(Date.UTC(+p[0], +p[1] - 1, +p[2]) / DAY);
}

/** Trips become inclusive day ranges under the chosen travel-day convention. */
function tripBlocks(trips: Trip[], countDeparture: boolean, countArrival: boolean): Block[] {
  const so = countDeparture ? 0 : 1;
  const eo = countArrival ? 0 : -1;
  const out: Block[] = [];
  trips.forEach((t, i) => {
    if (!t.depart || !t.ret) return;
    const s = toDay(t.depart) + so;
    const e = toDay(t.ret) + eo;
    if (e < s) return; // same-day trip under a lenient convention: costs nothing
    out.push({ s, e, trip: i });
  });
  out.sort((a, b) => a.s - b.s);
  return out;
}

/**
 * The stretch between the visa becoming valid and the first arrival in the
 * UK. Every day of it is spent wholly outside the UK except the arrival day,
 * which is a part day and follows the arrival switch; there is no departure
 * day, so the departure switch does not apply and the visa-valid-from day
 * always counts. Returns null when either date is missing or the stretch is
 * empty. trip is -1: this block belongs to no row in the trips array.
 */
function initialBlock(visaValidFrom: string, firstArrivalOn: string, countArrival: boolean): Block | null {
  if (!visaValidFrom || !firstArrivalOn) return null;
  const s = toDay(visaValidFrom);
  const e = toDay(firstArrivalOn) + (countArrival ? 0 : -1);
  if (e < s) return null;
  return { s, e, trip: -1 };
}

/**
 * Pairs of trips whose [depart, return] date ranges share at least one
 * calendar day. Raw dates are compared, not convention-adjusted blocks:
 * daysIn sums blocks independently, so a shared day is counted twice under
 * the strictest convention, and the data should be valid under every
 * convention. Trips with missing or inverted dates are skipped here; they
 * cost nothing and are flagged separately.
 */
function overlappingTrips(trips: Trip[]): [number, number][] {
  const ivs: { i: number; s: number; e: number }[] = [];
  trips.forEach((t, i) => {
    if (!t.depart || !t.ret) return;
    const s = toDay(t.depart);
    const e = toDay(t.ret);
    if (e < s) return;
    ivs.push({ i, s, e });
  });
  const out: [number, number][] = [];
  for (let a = 0; a < ivs.length; a++) {
    for (let b = a + 1; b < ivs.length; b++) {
      if (Math.max(ivs[a].s, ivs[b].s) <= Math.min(ivs[a].e, ivs[b].e)) {
        out.push([ivs[a].i, ivs[b].i]);
      }
    }
  }
  return out;
}

/** Days of absence inside [ws, we], summed across all blocks. */
function daysIn(bs: { s: number; e: number }[], ws: number, we: number): number {
  let n = 0;
  for (const b of bs) {
    const lo = Math.max(b.s, ws);
    const hi = Math.min(b.e, we);
    if (hi >= lo) n += hi - lo + 1;
  }
  return n;
}

/**
 * The maximum of a sliding 365-day count is always reached by a window that
 * begins on the first day of some absence block: a window starting on a
 * non-absent day can slide right at no cost, and a window starting mid-block
 * can slide left to the block start, gaining only absent days on the left and
 * dropping at most as many on the right. That makes one window per trip an
 * exact check, not a sample. Verified against a brute-force daily sweep in
 * test/model.test.js.
 */
function analyseWindows(bs: Block[], limit: number): WindowAnalysis {
  const windows: Win[] = bs.map((b) => {
    const days = daysIn(bs, b.s, b.s + WINDOW - 1);
    return { start: b.s, end: b.s + WINDOW - 1, days, trip: b.trip, breach: days > limit };
  });

  let peak = 0;
  let peakWin: Win | null = null;
  for (const w of windows) {
    if (w.days > peak) { peak = w.days; peakWin = w; }
  }

  const total = bs.reduce((a, b) => a + (b.e - b.s + 1), 0);
  return { windows, peak, peakWin, total };
}

/**
 * Has a breach already happened? Counts only absence actually incurred (a
 * trip still in progress is cut off at today) and only windows that have
 * fully elapsed.
 *
 * The block-start shortcut above does NOT hold here. It works by sliding a
 * window rightwards, which can push the window's end past today and out of
 * the eligible set, so this sweeps every eligible window start directly.
 */
function analysePastBlocks(bs: Block[], today: number): { days: number; win: PastWin | null } {
  const real = bs
    .filter((b) => b.s <= today)
    .map((b) => ({ s: b.s, e: Math.min(b.e, today) }));
  if (!real.length) return { days: 0, win: null };

  const lo = real[0].s;
  let best = 0;
  let win: PastWin | null = null;
  for (let d = lo - WINDOW + 1; d + WINDOW - 1 <= today; d++) {
    const n = daysIn(real, d, d + WINDOW - 1);
    if (n > best) { best = n; win = { start: d, end: d + WINDOW - 1, days: n }; }
  }
  return { days: best, win };
}

/** Trailing-12-month count for every day across the chart's span. */
function series(bs: Block[], d0: number, d1: number): { d: number; v: number }[] {
  const pts: { d: number; v: number }[] = [];
  for (let d = d0; d <= d1; d++) pts.push({ d, v: daysIn(bs, d - WINDOW + 1, d) });
  return pts;
}

// Node test harness. In the browser `module` is undefined and this is a no-op.
declare const module: { exports: unknown };
if (typeof module !== "undefined") {
  module.exports = { DAY, WINDOW, toDay, tripBlocks, initialBlock, overlappingTrips, daysIn, analyseWindows, analysePastBlocks, series };
}

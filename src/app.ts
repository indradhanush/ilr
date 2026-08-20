/**
 * UK ILR absence tracker.
 *
 * The rule being modelled: you may not spend more than 180 days outside the
 * UK in ANY rolling 12-month window across the
 * qualifying period. There is no annual budget and no averaging, so a single
 * bad 365-day stretch anywhere is enough to break continuous residence.
 *
 * Data comes from trips.js, which stays plain JavaScript so it can be edited
 * without a build step.
 */

interface RawTrip {
  depart: string;
  return: string;
  place?: string;
  reason?: string;
}

interface ILRData {
  limit?: number;
  visaValidFrom?: string;
  firstArrivalOn?: string;
  trips?: RawTrip[];
}

interface Window {
  ILR_DATA?: ILRData;
}

/* Trip, Block, Win and PastWin live in model.ts, which also owns the
 * sliding-window arithmetic. Both files compile as plain scripts into one
 * global scope, so the types and functions are used here directly. */

interface Analysis {
  bs: Block[];
  windows: Win[];
  peak: number;
  peakWin: Win | null;
  total: number;
  pastPeak: number;
  pastWin: PastWin | null;
}

/** What one chart exposes so another can drive its crosshair and window band. */
interface Hover {
  show: (d: number) => string;
  hide: () => void;
  dateAt: (clientX: number) => number;
}

interface Domain {
  d0: number;
  d1: number;
}

(function () {
  "use strict";

  /* ---------- day arithmetic (integer day numbers, no timezone drift) ---------- */
  // DAY, WINDOW, toDay and the window maths come from model.ts.
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function toISO(d: number): string {
    return new Date(d * DAY).toISOString().slice(0, 10);
  }
  function fmt(d: number): string {
    const t = new Date(d * DAY);
    return t.getUTCDate() + " " + MONTHS[t.getUTCMonth()] + " " + t.getUTCFullYear();
  }
  function fmtShort(d: number): string {
    const t = new Date(d * DAY);
    return MONTHS[t.getUTCMonth()] + " " + String(t.getUTCFullYear()).slice(2);
  }
  function esc(s: string): string {
    return String(s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" } as Record<string, string>)[c]);
  }
  function el<T extends HTMLElement>(id: string): T {
    const n = document.getElementById(id);
    if (!n) throw new Error("missing element: " + id);
    return n as T;
  }

  /* ---------- state ---------- */
  const D: ILRData = window.ILR_DATA || {};
  const LIMIT = D.limit || 180;

  /**
   * How the two travel days are treated. The Continuous residence caseworker
   * guidance ("Calculating absences") is explicit: "You must only include
   * whole days when calculating an applicant's absences. Part day absences,
   * less than 24 hours are not counted." Both travel days are part days, the
   * applicant being in the UK for part of the day they leave and part of the
   * day they land, so neither counts and both default off.
   *
   * The switches remain for planning against the stricter reading, which
   * costs the most days.
   */
  let countDeparture = false;
  let countArrival = false;

  const CONV_KEY = "ilr.conv";

  /**
   * Browsers restore checkbox state across a reload, so the boxes cannot be
   * assumed to start checked. The stored preference is the single source of
   * truth: it is loaded first, then pushed onto the DOM, so the two can never
   * disagree about what is being counted.
   */
  function restoreConvention(): void {
    let saved: string | null = null;
    try { saved = localStorage.getItem(CONV_KEY); } catch { /* private mode */ }
    if (saved) {
      countDeparture = saved.indexOf("d") >= 0;
      countArrival = saved.indexOf("a") >= 0;
    }
    el<HTMLInputElement>("cdep").checked = countDeparture;
    el<HTMLInputElement>("carr").checked = countArrival;
  }

  function saveConvention(): void {
    const v = (countDeparture ? "d" : "") + (countArrival ? "a" : "") || "-";
    try { localStorage.setItem(CONV_KEY, v); } catch { /* private mode */ }
  }
  let trips: Trip[] = [];
  let visaValidFrom = "";
  let firstArrivalOn = "";
  const TODAY = Math.floor(Date.now() / DAY);

  function loadFromFile(): void {
    visaValidFrom = D.visaValidFrom || "";
    firstArrivalOn = D.firstArrivalOn || "";
    trips = (D.trips || []).map((t) => ({
      depart: t.depart,
      ret: t.return,
      place: t.place || "",
      reason: t.reason || "",
    }));
  }

  /**
   * The initial stay as a pseudo-trip in front of the real ones, so overlap
   * and picker-bound checks can treat all occupied date ranges uniformly.
   * Index 0 is the initial stay; trip i sits at index i + 1.
   */
  function withInitial(): Trip[] {
    return [{ depart: visaValidFrom, ret: firstArrivalOn, place: "", reason: "" }, ...trips];
  }

  /* ---------- the model (pure parts live in model.ts) ---------- */
  function analyse(): Analysis {
    const bs = tripBlocks(trips, countDeparture, countArrival);
    const ib = initialBlock(visaValidFrom, firstArrivalOn, countArrival);
    if (ib) {
      bs.push(ib);
      bs.sort((a, b) => a.s - b.s);
    }
    const w = analyseWindows(bs, LIMIT);
    const past = analysePastBlocks(bs, TODAY);
    return { bs, windows: w.windows, peak: w.peak, peakWin: w.peakWin,
             total: w.total, pastPeak: past.days, pastWin: past.win };
  }

  function domain(bs: Block[]): Domain {
    if (!bs.length) return { d0: TODAY - 200, d1: TODAY + 200 };
    let lo = bs[0].s;
    let hi = bs[0].e;
    for (const b of bs) { lo = Math.min(lo, b.s); hi = Math.max(hi, b.e); }
    return { d0: lo - 20, d1: hi + WINDOW + 20 };
  }

  /* ---------- shared chart chrome ---------- */
  const PAD = { l: 44, r: 18, t: 14, b: 26 };

  /**
   * The 365-day window under the cursor, drawn as a band on every chart at
   * once. Both charts share a time axis, so the band lines up across them and
   * shows which trips fall inside the window being measured.
   */
  interface Band { rect: SVGRectElement; X: (d: number) => number; }
  let bands: Band[] = [];

  function showBand(ws: number, we: number): void {
    for (const b of bands) {
      const x0 = b.X(ws);
      const w = b.X(we + 1) - x0;
      b.rect.setAttribute("x", String(x0));
      b.rect.setAttribute("width", String(Math.max(1, w)));
      b.rect.setAttribute("opacity", "1");
    }
  }
  function hideBand(): void {
    for (const b of bands) b.rect.setAttribute("opacity", "0");
  }

  /**
   * Crossing from one chart to the other means briefly leaving both, which used
   * to clear the readout. Clearing is deferred so a short gap between charts
   * does not count as leaving.
   */
  const HIDE_DELAY = 220;
  let hideTimer = 0;

  function keepAlive(): void {
    clearTimeout(hideTimer);
    hideTimer = 0;
  }

  function scheduleHide(fn: () => void): void {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(fn, HIDE_DELAY);
  }

  /** Tooltip body for the window ending on `d`. */
  function windowTip(d: number, out: number): string {
    const inUK = WINDOW - out;
    const over = out > LIMIT;
    return `<b>${fmt(d - WINDOW + 1)} &ndash; ${fmt(d)}</b><br>` +
      `<span class="muted">the 365 days ending ${fmt(d)}</span><hr>` +
      `<div class="row"><span><span class="sw" style="background:var(--series-1)"></span>Outside the UK</span>` +
      `<b style="color:${over ? "var(--critical)" : "var(--text-primary)"}">${out}</b></div>` +
      `<div class="row"><span><span class="sw" style="background:var(--win-edge)"></span>In the UK</span>` +
      `<b>${inUK}</b></div><hr>` +
      `<span class="muted">${over ? `${out - LIMIT} over the ${LIMIT}-day limit`
                                  : `${LIMIT - out} days of headroom`}</span>`;
  }

  function mkFrag(html: string): DocumentFragment {
    const d = document.createElement("div");
    d.innerHTML = html;
    const f = document.createDocumentFragment();
    while (d.firstChild) f.appendChild(d.firstChild);
    return f;
  }

  /**
   * Positions the tooltip against the viewport, not its chart. The chart clips
   * its own overflow, so a tooltip placed inside that box gets cut off near the
   * edges; position:fixed escapes it. Flips to the other side of the cursor
   * rather than being pushed back over it.
   */
  function place(tt: HTMLElement, ev: MouseEvent): void {
    const GAP = 14;
    const EDGE = 8;
    tt.style.opacity = "1";
    const w = tt.offsetWidth;
    const h = tt.offsetHeight;

    let x = ev.clientX + GAP;
    if (x + w > window.innerWidth - EDGE) x = ev.clientX - w - GAP;

    let y = ev.clientY + GAP;
    if (y + h > window.innerHeight - EDGE) y = ev.clientY - h - GAP;

    tt.style.left = Math.max(EDGE, x) + "px";
    tt.style.top = Math.max(EDGE, y) + "px";
  }

  /** Month gridlines and labels, thinned so they never collide. */
  function monthTicks(
    dom: Domain, pw: number, X: (d: number) => number,
    y1: number, y2: number, labelY: number
  ): string[] {
    const out: string[] = [];
    const every = pw < 520 ? 6 : 3;
    const t = new Date(dom.d0 * DAY);
    const y0 = t.getUTCFullYear();
    const m0 = t.getUTCMonth();
    for (let k = 0; k < 80; k++) {
      const mm = m0 + k;
      if (mm % every !== 0) continue;
      const dd = Math.floor(Date.UTC(y0, mm, 1) / DAY);
      if (dd < dom.d0 || dd > dom.d1) continue;
      out.push(`<line x1="${X(dd)}" x2="${X(dd)}" y1="${y1}" y2="${y2}" stroke="var(--grid)" stroke-width="1"/>`);
      out.push(`<text x="${X(dd)}" y="${labelY}" text-anchor="middle" font-size="11" fill="var(--text-muted)">${fmtShort(dd)}</text>`);
    }
    return out;
  }

  /* ---------- chart 1: trailing 12-month absence ---------- */
  function drawRolling(host: HTMLElement, tt: HTMLElement, A: Analysis, dom: Domain): Hover {
    const W = host.clientWidth || 900;
    const H = Math.max(150, host.clientHeight || 220);
    lastPlotH = H;
    const pw = W - PAD.l - PAD.r;
    const ph = H - PAD.t - PAD.b;
    const pts = series(A.bs, dom.d0, dom.d1);
    const yMax = Math.max(LIMIT + 40, A.peak + 24);

    const X = (d: number) => PAD.l + ((d - dom.d0) / (dom.d1 - dom.d0)) * pw;
    const Y = (v: number) => PAD.t + ph - (v / yMax) * ph;

    const s: string[] = [];
    s.push(`<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Days absent in the trailing twelve months over time">`);

    for (const v of [0, 60, 120, 180]) {
      if (v > yMax) continue;
      s.push(`<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--grid)" stroke-width="1"/>`);
      s.push(`<text x="${PAD.l - 8}" y="${Y(v) + 4}" text-anchor="end" font-size="11" fill="var(--text-muted)" style="font-variant-numeric:tabular-nums">${v}</text>`);
    }
    s.push(...monthTicks(dom, pw, X, PAD.t, PAD.t + ph, H - 8));

    // the 365-day window under the cursor, behind everything else
    s.push(`<rect class="band" x="0" y="${PAD.t}" width="0" height="${ph}" fill="var(--win-wash)" opacity="0"/>`);

    // wash under the curve
    const area = [`M ${X(pts[0].d)} ${Y(0)}`];
    for (const p of pts) area.push(`L ${X(p.d)} ${Y(p.v)}`);
    area.push(`L ${X(pts[pts.length - 1].d)} ${Y(0)} Z`);
    s.push(`<path d="${area.join(" ")}" fill="var(--series-1-wash)"/>`);

    // the part that sits above the limit, called out in red
    let over: string[] | null = null;
    for (const p of pts) {
      if (p.v > LIMIT) {
        if (!over) over = [`M ${X(p.d)} ${Y(LIMIT)}`];
        over.push(`L ${X(p.d)} ${Y(p.v)}`);
      } else if (over) {
        over.push(`L ${X(p.d)} ${Y(LIMIT)} Z`);
        s.push(`<path d="${over.join(" ")}" fill="var(--critical-wash)"/>`);
        over = null;
      }
    }
    if (over) {
      over.push(`L ${X(pts[pts.length - 1].d)} ${Y(LIMIT)} Z`);
      s.push(`<path d="${over.join(" ")}" fill="var(--critical-wash)"/>`);
    }

    s.push(`<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${Y(LIMIT)}" y2="${Y(LIMIT)}" stroke="var(--critical)" stroke-width="2"/>`);
    s.push(`<text x="${W - PAD.r}" y="${Y(LIMIT) - 7}" text-anchor="end" font-size="11" font-weight="600" fill="var(--critical)">${LIMIT}-day limit</text>`);

    const line = pts.map((p, i) => (i ? "L " : "M ") + X(p.d) + " " + Y(p.v)).join(" ");
    s.push(`<path d="${line}" fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);

    if (TODAY >= dom.d0 && TODAY <= dom.d1) {
      s.push(`<line x1="${X(TODAY)}" x2="${X(TODAY)}" y1="${PAD.t}" y2="${PAD.t + ph}" stroke="var(--axis)" stroke-width="1"/>`);
      s.push(`<text x="${X(TODAY) + 5}" y="${PAD.t + 11}" font-size="11" fill="var(--text-muted)">today</text>`);
    }

    // only the peak gets a direct label; the axis and tooltip carry the rest
    if (A.peakWin) {
      const pd = A.peakWin.end;
      const anchor = X(pd) > W - 90 ? "end" : "start";
      const dx = anchor === "end" ? -10 : 10;
      s.push(`<circle cx="${X(pd)}" cy="${Y(A.peak)}" r="4.5" fill="var(--series-1)" stroke="var(--surface-1)" stroke-width="2"/>`);
      s.push(`<text x="${X(pd) + dx}" y="${Y(A.peak) - 9}" text-anchor="${anchor}" font-size="12" font-weight="600" fill="var(--text-primary)">peak ${A.peak}</text>`);
    }

    s.push(`<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${Y(0)}" y2="${Y(0)}" stroke="var(--axis)" stroke-width="1"/>`);
    s.push(`<line id="cross1" x1="0" x2="0" y1="${PAD.t}" y2="${PAD.t + ph}" stroke="var(--axis)" stroke-width="1" opacity="0"/>`);
    s.push(`<circle id="dot1" r="5" fill="var(--series-1)" stroke="var(--surface-1)" stroke-width="2" opacity="0"/>`);
    s.push("</svg>");
    host.insertBefore(mkFrag(s.join("")), tt);

    const svg = host.querySelector("svg") as SVGSVGElement;
    const cross = host.querySelector("#cross1") as SVGLineElement;
    const dot = host.querySelector("#dot1") as SVGCircleElement;
    bands.push({ rect: host.querySelector(".band") as SVGRectElement, X });

    const clampDate = (d: number) => Math.max(dom.d0, Math.min(dom.d1, d));

    const show = (d: number): string => {
      const v = pts[clampDate(d) - dom.d0].v;
      cross.setAttribute("x1", String(X(d)));
      cross.setAttribute("x2", String(X(d)));
      cross.setAttribute("opacity", "1");
      dot.setAttribute("cx", String(X(d)));
      dot.setAttribute("cy", String(Y(v)));
      dot.setAttribute("opacity", "1");
      showBand(d - WINDOW + 1, d);
      return windowTip(d, v);
    };

    const hide = (): void => {
      cross.setAttribute("opacity", "0");
      dot.setAttribute("opacity", "0");
      hideBand();
    };

    const dateAt = (clientX: number): number => {
      const r = svg.getBoundingClientRect();
      const px = (clientX - r.left) * (W / r.width);
      return clampDate(Math.round(dom.d0 + ((px - PAD.l) / pw) * (dom.d1 - dom.d0)));
    };

    // The whole plot area is the target, padding and axis band included. A
    // narrow hit rect made the readout feel twitchy to pick up.
    host.addEventListener("mousemove", (ev: MouseEvent) => {
      keepAlive();
      tt.innerHTML = show(dateAt(ev.clientX));
      place(tt, ev);
    });
    host.addEventListener("mouseleave", () => { tt.style.opacity = "0"; scheduleHide(hide); });

    return { show, hide, dateAt };
  }

  /* ---------- chart 2: the trips themselves ---------- */
  function drawTrips(host: HTMLElement, tt: HTMLElement, A: Analysis, dom: Domain, link: Hover): void {
    const W = host.clientWidth || 900;
    const barH = 16;
    const lane = PAD.t + 2;
    const H = lane + barH + 26;
    const pw = W - PAD.l - PAD.r;
    const X = (d: number) => PAD.l + ((d - dom.d0) / (dom.d1 - dom.d0)) * pw;

    const s: string[] = [`<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Trips outside the UK on a time axis">`];
    s.push(...monthTicks(dom, pw, X, lane, lane + barH, H - 8));
    s.push(`<rect class="band" x="0" y="${lane - 4}" width="0" height="${barH + 8}" rx="3" fill="var(--win-wash)" opacity="0"/>`);
    s.push(`<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${lane + barH + 6}" y2="${lane + barH + 6}" stroke="var(--axis)" stroke-width="1"/>`);

    // today sits behind the bars so it never cuts through a label
    if (TODAY >= dom.d0 && TODAY <= dom.d1) {
      s.push(`<line x1="${X(TODAY)}" x2="${X(TODAY)}" y1="${lane - 5}" y2="${lane + barH + 5}" stroke="var(--axis)" stroke-width="1"/>`);
    }

    A.bs.forEach((b, i) => {
      const x0 = X(b.s);
      const w = Math.max(3, X(b.e + 1) - x0 - 2);
      const days = b.e - b.s + 1;
      s.push(`<rect class="bar" data-i="${i}" x="${x0}" y="${lane}" width="${w}" height="${barH}" rx="4" fill="var(--series-1)"/>`);
      if (w > 26) {
        s.push(`<text x="${x0 + w / 2}" y="${lane + barH / 2 + 4}" text-anchor="middle" font-size="11" font-weight="600" fill="#fff" style="pointer-events:none">${days}</text>`);
      }
    });
    s.push("</svg>");
    host.insertBefore(mkFrag(s.join("")), tt);

    bands.push({ rect: host.querySelector(".band") as SVGRectElement, X });

    // The strip drives the same crosshair and band as the chart above it, so
    // the two read as one instrument rather than two pictures.
    host.addEventListener("mousemove", (ev: MouseEvent) => {
      keepAlive();
      tt.innerHTML = link.show(link.dateAt(ev.clientX));
      place(tt, ev);
    });
    host.addEventListener("mouseleave", () => { tt.style.opacity = "0"; scheduleHide(link.hide); });

    host.querySelectorAll<SVGRectElement>(".bar").forEach((r) => {
      r.addEventListener("mousemove", (ev: MouseEvent) => {
        ev.stopPropagation();          // the bar's own readout wins over the strip's
        keepAlive();
        const b = A.bs[Number(r.dataset.i)];
        // trip -1 is the initial stay, which belongs to no row in trips.
        const tr = b.trip >= 0 ? trips[b.trip] : null;
        const name = tr ? tr.place || tr.reason || "Trip" : "Before first arrival";
        const from = tr ? tr.depart : visaValidFrom;
        const to = tr ? tr.ret : firstArrivalOn;
        // A trip's own window is the one the limit is actually tested against.
        const days = daysIn(A.bs, b.s, b.s + WINDOW - 1);
        link.show(b.s + WINDOW - 1);
        tt.innerHTML =
          `<b>${esc(name)}</b><br>` +
          `${fmt(toDay(from))} &rarr; ${fmt(toDay(to))}<br>` +
          `<b>${b.e - b.s + 1} days</b> counted<hr>` +
          `<span class="muted">the 365 days from this departure</span><br>` +
          `<div class="row"><span>Outside the UK</span>` +
          `<b style="color:${days > LIMIT ? "var(--critical)" : "var(--text-primary)"}">${days}</b></div>` +
          `<div class="row"><span>In the UK</span><b>${WINDOW - days}</b></div>`;
        place(tt, ev);
      });
      r.addEventListener("mouseleave", () => { scheduleHide(link.hide); });
    });
  }

  /* ---------- tiles & tables ---------- */
  function tile(k: string, v: string, n: string): string {
    return `<div class="tile"><div class="k">${k}</div><div>${v}</div><div class="n">${n}</div></div>`;
  }

  function renderTiles(A: Analysis): void {
    const head = LIMIT - A.peak;
    const breach = A.peak > LIMIT;
    const t = [
      tile("Peak in any 12 months",
        `<span class="v ${breach ? "breach" : "ok"}">${A.peak}</span>`,
        A.peakWin ? `${fmt(A.peakWin.start)} &ndash; ${fmt(A.peakWin.end)}` : ""),
      tile(breach ? "Over the limit by" : "Headroom",
        `<span class="v ${breach ? "breach" : ""}">${Math.abs(head)}</span>`,
        breach ? "days to cut from the peak window" : `days to spare before ${LIMIT}`),
      tile("Status",
        `<span class="v ${breach ? "breach" : "ok"}" style="font-size:22px">${breach ? "Breach" : "Within limit"}</span>`,
        breach ? "continuous residence would break" : `no window exceeds ${LIMIT}`),
      tile("Already breached?",
        `<span class="v ${A.pastPeak > LIMIT ? "breach" : "ok"}" style="font-size:22px">${A.pastPeak > LIMIT ? "Yes" : "No"}</span>`,
        `worst elapsed window: ${A.pastPeak} days`),
      tile("Total days outside",
        `<span class="v">${A.total}</span>`, "since the visa became valid"),
    ];
    el("tiles").innerHTML = t.join("");
  }

  /** True when both dates are set but the return lands before the departure. */
  function isInverted(t: Trip): boolean {
    return !!t.depart && !!t.ret && toDay(t.ret) < toDay(t.depart);
  }

  function renderTripTable(): void {
    // Overlap and picker-bound checks run over the initial stay plus the
    // trips as one list; index 0 is the initial stay. The UI refuses to
    // create overlaps, so any overlap here came from trips.js.
    const rows = withInitial();
    const ovSet = new Set<number>();
    for (const p of overlappingTrips(rows)) { ovSet.add(p[0]); ovSet.add(p[1]); }
    const attr = (n: string, d: number | null) => (d === null ? "" : ` ${n}="${toISO(d)}"`);

    // The initial stay first, under its own labels, with no delete button.
    // Its header scrolls away with its row; the trips header keeps the
    // default sticky th styling.
    const initialInv = !!visaValidFrom && !!firstArrivalOn &&
      toDay(firstArrivalOn) < toDay(visaValidFrom);
    const initialBad = initialInv || ovSet.has(0);
    const initialTitle = initialInv
      ? "First arrival is before the visa start, so this stretch counts as nothing"
      : ovSet.has(0) ? "This stretch shares days with a trip, so those days are counted twice"
      : "";
    const b0 = tripBounds(rows, 0);
    const visaMax = firstArrivalOn && !initialInv ? toDay(firstArrivalOn) : b0.max;
    const firstMin = visaValidFrom && !initialInv ? toDay(visaValidFrom) : b0.min;
    let h = "<tbody>" +
      '<tr><th class="plainhead">Visa valid from</th><th class="plainhead">First arrival</th>' +
      '<th class="plainhead" colspan="3"></th></tr>' +
      `<tr class="${initialBad ? "bad" : ""}"${initialTitle ? ` title="${initialTitle}"` : ""}>` +
      `<td><input type="date" data-f="visa" value="${esc(visaValidFrom)}"${attr("min", b0.min)}${attr("max", visaMax)}></td>` +
      `<td><input type="date" data-f="first" value="${esc(firstArrivalOn)}"${attr("min", firstMin)}${attr("max", b0.max)}></td>` +
      '<td colspan="3" class="firstnote">counts as absence until you first arrive</td></tr>' +
      "<tr><th>Depart</th><th>Return</th><th>Where</th><th>Reason</th><th></th></tr>";

    trips.forEach((t, i) => {
      const inv = isInverted(t);
      const bad = inv || ovSet.has(i + 1);
      const title = inv ? "Return is before departure, so this trip counts as nothing"
                  : ovSet.has(i + 1) ? "This trip shares days with another trip, so those days are counted twice"
                  : "";
      // Days occupied by other trips are greyed out in the native pickers:
      // depart and return are bounded to the gap this trip sits in, and the
      // pair is bounded to each other so a row cannot be inverted either.
      const b = tripBounds(rows, i + 1);
      const depMax = t.ret && !inv ? toDay(t.ret) : b.max;
      const retMin = t.depart && !inv ? toDay(t.depart) : b.min;
      h += `<tr class="${bad ? "bad" : ""}"${title ? ` title="${title}"` : ""}>` +
        `<td><input type="date" data-i="${i}" data-f="depart" value="${esc(t.depart)}"${attr("min", b.min)}${attr("max", depMax)}></td>` +
        `<td><input type="date" data-i="${i}" data-f="ret" value="${esc(t.ret)}"${attr("min", retMin)}${attr("max", b.max)}></td>` +
        `<td><input type="text" data-i="${i}" data-f="place" value="${esc(t.place)}"></td>` +
        `<td><input type="text" data-i="${i}" data-f="reason" value="${esc(t.reason)}"></td>` +
        `<td><button class="link" data-del="${i}" title="Remove this trip">&times;</button></td></tr>`;
    });
    el("triptable").innerHTML = h + "</tbody>";

    // An inverted row silently drops out of the maths, which flatters the
    // peak; an overlapping pair double-counts the shared days, which inflates
    // it. Say so rather than letting a typo pass as a real number.
    const msgs: string[] = [];
    if (initialInv) {
      msgs.push("The first arrival is before the visa start, so the initial stay is " +
        "being counted as zero days. Fix the dates.");
    }
    const n = trips.filter(isInverted).length;
    if (n) {
      msgs.push(`${n} trip${n > 1 ? "s have" : " has"} a return date before the departure date, so ` +
        `${n > 1 ? "they are" : "it is"} being counted as zero days. Fix the dates or remove the row.`);
    }
    if (ovSet.size) {
      msgs.push(`${ovSet.size} rows share days with another row, so the shared days are ` +
        `counted twice. Fix the dates in trips.js.`);
    }
    el("tripwarn").innerHTML = msgs.join("<br>");
  }

  function renderWinTable(A: Analysis): void {
    let h = '<thead><tr><th>Window start</th><th>Window end</th><th class="num">Days absent</th>' +
            '<th class="num">Headroom</th><th>Status</th></tr></thead><tbody>';
    A.windows.slice().sort((a, b) => b.days - a.days).forEach((w) => {
      h += `<tr><td>${fmt(w.start)}</td><td>${fmt(w.end)}</td>` +
        `<td class="num">${w.days}</td><td class="num">${LIMIT - w.days}</td>` +
        `<td><span class="pill ${w.breach ? "breach" : "ok"}">${w.breach ? "Breach" : "OK"}</span></td></tr>`;
    });
    el("wintable").innerHTML = h + "</tbody>";
  }

  /* ---------- orchestration ---------- */
  function render(): void {
    const A = analyse();
    const dom = domain(A.bs);

    el("subtitle").innerHTML =
      `No more than <b>${LIMIT}</b> ` +
      `days outside the UK in any rolling 12 months &middot; ${conventionLabel()}`;

    // Tables and tiles first. They are what decides how much height is left for
    // the chart, so measuring the chart box before they are filled measures a
    // box that is about to change, and the drawing ends up the wrong size.
    renderTiles(A);
    renderTripTable();
    renderWinTable(A);

    for (const id of ["plot1", "plot2"]) {
      el(id).querySelectorAll("svg").forEach((s) => s.remove());
    }
    bands = [];   // the old rects went out with the old svgs
    const rolling = drawRolling(el("plot1"), el("tt1"), A, dom);
    drawTrips(el("plot2"), el("tt2"), A, dom, rolling);
  }

  /** Plain-English summary of the two switches, for the subtitle. */
  function conventionLabel(): string {
    if (countDeparture && countArrival) return "both travel days counted";
    if (countDeparture) return "departure day counted, arrival day not";
    if (countArrival) return "arrival day counted, departure day not";
    return "neither travel day counted";
  }

  function flash(msg: string): void {
    const n = el("copied");
    n.textContent = msg;
    setTimeout(() => { n.textContent = ""; }, 2600);
  }

  el<HTMLInputElement>("cdep").addEventListener("change", (e) => {
    countDeparture = (e.target as HTMLInputElement).checked;
    saveConvention();
    render();
  });

  el<HTMLInputElement>("carr").addEventListener("change", (e) => {
    countArrival = (e.target as HTMLInputElement).checked;
    saveConvention();
    render();
  });

  /** True when row i of withInitial() shares a day with any other row; the
   *  initial stay is i = 0 and trip k sits at i = k + 1. */
  function overlapsRow(i: number): boolean {
    return overlappingTrips(withInitial()).some((p) => p[0] === i || p[1] === i);
  }

  el("triptable").addEventListener("change", (e) => {
    const t = e.target as HTMLInputElement;
    const f = t.dataset.f;
    if (f === undefined) return;

    // The pickers grey out days occupied by other rows, but a typed date
    // still comes through outside min/max, so an edit that would create an
    // overlap is quietly reverted. Only NEW overlaps are reverted: rows that
    // arrived overlapping from trips.js stay editable, so they can be fixed.
    if (f === "visa" || f === "first") {
      const prev = f === "visa" ? visaValidFrom : firstArrivalOn;
      const had = overlapsRow(0);
      if (f === "visa") visaValidFrom = t.value; else firstArrivalOn = t.value;
      if (!had && overlapsRow(0)) {
        if (f === "visa") visaValidFrom = prev; else firstArrivalOn = prev;
      }
      render();
      return;
    }

    if (t.dataset.i === undefined) return;
    const i = Number(t.dataset.i);
    const trip = trips[i];
    if (f === "depart" || f === "ret") {
      const prev = trip[f];
      const had = overlapsRow(i + 1);
      trip[f] = t.value;
      if (!had && overlapsRow(i + 1)) trip[f] = prev;
    } else {
      trip[f as keyof Trip] = t.value;
    }
    render();
  });

  el("triptable").addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.dataset.del === undefined) return;
    trips.splice(Number(t.dataset.del), 1);
    render();
  });

  el("addrow").addEventListener("click", () => {
    // The new row lands after the first arrival and after every existing
    // return, so it can never overlap.
    let last = TODAY;
    if (firstArrivalOn) last = Math.max(last, toDay(firstArrivalOn) + 30);
    for (const t of trips) {
      if (t.depart && t.ret) last = Math.max(last, toDay(t.ret) + 30);
    }
    trips.push({ depart: toISO(last), ret: toISO(last + 7), place: "", reason: "" });
    render();
  });

  el("reset").addEventListener("click", () => {
    loadFromFile();
    render();
    flash("reset to trips.js");
  });

  el("copy").addEventListener("click", () => {
    const body = trips.map((t) =>
      `    { depart: "${t.depart}", return: "${t.ret}", place: "${t.place}", reason: "${t.reason}" },`
    ).join("\n");
    const txt = "window.ILR_DATA = {\n" +
      `  limit: ${LIMIT},\n` +
      `  visaValidFrom: "${visaValidFrom}",\n` +
      `  firstArrivalOn: "${firstArrivalOn}",\n` +
      "\n  trips: [\n" + body + "\n  ],\n};\n";
    navigator.clipboard.writeText(txt).then(
      () => flash("copied — paste into trips.js"),
      () => { flash("copy blocked; see the console"); console.log(txt); }
    );
  });

  let rt: number;
  window.addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(render, 140);
  });


  /**
   * The rolling chart is drawn at whatever height its box had at draw time. Zoom
   * or a window resize changes that box without redrawing, and the chart then
   * spills over the card below it. Redraw whenever the box actually changes.
   * Drawing sets the svg to the measured height, so this settles in one pass.
   */
  let lastPlotH = 0;

  function watchPlotHeight(): void {
    if (typeof ResizeObserver === "undefined") return;
    new ResizeObserver(() => {
      const h = Math.max(150, el("plot1").clientHeight || 220);
      if (Math.abs(h - lastPlotH) > 2) render();
    }).observe(el("plot1"));
  }

  /* ---------- resizable split ---------- */
  // The left column is never narrower than its date inputs need, and never
  // takes more than half the width — past that the charts stop being readable.
  const MIN_LEFT = 330;
  const SPLIT_KEY = "ilr.split";

  function maxLeft(): number {
    return Math.max(MIN_LEFT, el("main").clientWidth * 0.5);
  }

  function applySplit(px: number, save: boolean): void {
    const clamped = Math.round(Math.min(maxLeft(), Math.max(MIN_LEFT, px)));
    el("main").style.setProperty("--split", clamped + "px");
    el("splitter").setAttribute("aria-valuenow", String(clamped));
    if (save) {
      try { localStorage.setItem(SPLIT_KEY, String(clamped)); } catch { /* private mode */ }
    }
  }

  function restoreSplit(): void {
    let saved: string | null = null;
    try { saved = localStorage.getItem(SPLIT_KEY); } catch { /* private mode */ }
    const px = saved ? Number(saved) : el("main").clientWidth * 0.3;
    applySplit(px, false);
  }

  function initSplitter(): void {
    const bar = el("splitter");
    let raf = 0;

    const move = (ev: PointerEvent) => {
      applySplit(ev.clientX - el("main").getBoundingClientRect().left, false);
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); });
    };

    const up = (ev: PointerEvent) => {
      bar.classList.remove("active");
      document.body.classList.remove("resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      applySplit(ev.clientX - el("main").getBoundingClientRect().left, true);
      render();
    };

    bar.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      bar.classList.add("active");
      document.body.classList.add("resizing");
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });

    bar.addEventListener("keydown", (ev: KeyboardEvent) => {
      const step = ev.shiftKey ? 48 : 16;
      if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
      ev.preventDefault();
      const now = parseFloat(getComputedStyle(el("main")).getPropertyValue("--split")) || MIN_LEFT;
      applySplit(now + (ev.key === "ArrowRight" ? step : -step), true);
      render();
    });

    // a narrower window can push the saved split past the half-width ceiling
    window.addEventListener("resize", () => {
      const now = parseFloat(getComputedStyle(el("main")).getPropertyValue("--split")) || MIN_LEFT;
      applySplit(now, false);
    });
  }

  restoreConvention();
  restoreSplit();
  initSplitter();
  loadFromFile();
  render();
  watchPlotHeight();
})();

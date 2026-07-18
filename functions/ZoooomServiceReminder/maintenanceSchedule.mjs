/**
 * maintenanceSchedule.mjs — server-side OEM maintenance schedule resolver,
 * scanned-record matcher, and next-service predictor.
 *
 * This is the deterministic core behind service reminders. Given a vehicle
 * (year/make/model/trim + current mileage) and its de-duplicated service
 * history, it:
 *   1. resolveIntervals()  — picks the OEM interval set for the MMYT. Uses a
 *      maintained MMYT table (seeded with the 2014 Prius), then a brand-level
 *      fallback, then a generic default. Each interval carries BOTH a mileage
 *      axis and a time (months) axis so we can honor "whichever comes first".
 *   2. matchRecordsToSchedule() — snaps each scanned record to the closest
 *      scheduled service by keyword, so we know when each service was last done.
 *   3. predictNext() — for every service with evidence, projects the next due
 *      point on BOTH axes and takes the earlier one; the soonest across all
 *      services is the vehicle's next service.
 *
 * Reference rule (user-provided): a 2014 Prius should get an oil change every
 * 6 months OR every 5,000 miles, whichever comes first.
 *
 * Pure functions, no AWS deps — unit-testable in plain node (see test.mjs).
 */

// ── de-dup helpers (ported from lambda-vehicle-report/handler.mjs) ───────────
export function normDate(d) {
  if (!d) return null;
  const s = String(d).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  const dt = new Date(s);
  return isNaN(dt) ? null : dt.toISOString().slice(0, 10);
}

// Odometer values of null/0/1 are "not captured" — never let junk mileage split
// (or falsely equate) a real record.
function realMileage(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 1 ? n : null;
}
function mileEq(a, b) {
  const ma = realMileage(a), mb = realMileage(b);
  if (ma == null || mb == null) return true; // fall back to date/summary
  return Math.abs(ma - mb) <= 1;
}
function trigrams(s) {
  const t = String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const out = new Set();
  const padded = `  ${t} `;
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}
function fuzzySim(a, b) {
  const ta = trigrams(a), tb = trigrams(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const g of ta) if (tb.has(g)) inter++;
  return inter / Math.min(ta.size, tb.size); // overlap coefficient
}

/**
 * Collapse duplicate service records. Input records are normalized to
 * { date, mileage, service, serviceType, raw }. Keeps the longer/richer text.
 */
export function dedupeServiceHistory(list) {
  const kept = [];
  for (const r of list) {
    const dup = kept.find(
      (k) =>
        k.date === r.date &&
        mileEq(k.mileage, r.mileage) &&
        fuzzySim(k.service, r.service) >= 0.5
    );
    if (!dup) {
      kept.push(r);
    } else if ((r.service || "").length > (dup.service || "").length) {
      Object.assign(dup, r); // richer text wins
    }
  }
  return kept;
}

/** Normalize a raw ZoooomServiceRecord row into the shape we reason over. */
export function normalizeRecord(r) {
  const service = Array.isArray(r.serviceDetails)
    ? r.serviceDetails.filter(Boolean).join("; ")
    : r.serviceType || r.service || "";
  return {
    date: normDate(r.date),
    mileage: realMileage(r.mileage != null ? r.mileage : r.odometer),
    service,
    serviceType: r.serviceType || null,
    raw: r,
  };
}

// ── OEM schedule tables ──────────────────────────────────────────────────────
// Each scheduled service carries a mileage interval AND a months interval so
// predictNext() can honor "whichever comes first". `match` is a RegExp tested
// against a record's combined service text to decide which service it satisfies.

const OIL = { key: "oil", label: "Engine Oil & Filter Change", intervalMiles: 5000, intervalMonths: 6, match: /\b(oil|lube|lof|oil\s*filter)\b/i };
const ROTATION = { key: "rotation", label: "Tire Rotation", intervalMiles: 5000, intervalMonths: 6, match: /\b(rotat|tire\s*rotation)\b/i };
const INSPECTION = { key: "inspection", label: "Multi-Point Inspection", intervalMiles: 5000, intervalMonths: 6, match: /\b(multi[-\s]?point|inspection)\b/i };
const CABIN_FILTER = { key: "cabin_filter", label: "Cabin Air Filter", intervalMiles: 30000, intervalMonths: 36, match: /\bcabin\b.*\bfilter|\bcabin air\b/i };
const ENGINE_AIR = { key: "engine_air", label: "Engine Air Filter", intervalMiles: 30000, intervalMonths: 36, match: /\b(engine|air)\s*filter\b/i };
const BRAKE_FLUID = { key: "brake_fluid", label: "Brake Fluid", intervalMiles: 30000, intervalMonths: 36, match: /\bbrake\s*fluid\b/i };

// Keyed by MAKE|MODEL (year-agnostic within a generation is fine for the
// intervals we reminder on). Extend as coverage grows.
const MMYT_SCHEDULES = {
  "TOYOTA|PRIUS": [OIL, ROTATION, INSPECTION, CABIN_FILTER, ENGINE_AIR, BRAKE_FLUID],
  "TOYOTA|COROLLA": [OIL, ROTATION, INSPECTION, CABIN_FILTER],
  "TOYOTA|CAMRY": [OIL, ROTATION, INSPECTION, CABIN_FILTER],
  "LEXUS|ES": [OIL, ROTATION, INSPECTION],
  "HONDA|CIVIC": [{ ...OIL, intervalMiles: 7500 }, { ...ROTATION, intervalMiles: 7500 }, INSPECTION],
  "HONDA|ACCORD": [{ ...OIL, intervalMiles: 7500 }, { ...ROTATION, intervalMiles: 7500 }, INSPECTION],
};

// Brand-level mileage fallback when we have no MMYT row. Time axis defaults to
// 6 months for oil (industry norm) so the "whichever comes first" rule still works.
const BRAND_INTERVAL_MILES = {
  "LAND ROVER": 12000, "RANGE ROVER": 12000, TOYOTA: 5000, LEXUS: 5000,
  HONDA: 7500, ACURA: 7500, BMW: 10000, "MERCEDES-BENZ": 10000,
  MERCEDES: 10000, FORD: 7500, CHEVROLET: 7500, TESLA: 10000, NISSAN: 5000,
  SUBARU: 6000, MAZDA: 7500, VOLKSWAGEN: 10000, HYUNDAI: 7500, KIA: 7500,
};

const GENERIC = [{ ...OIL, intervalMiles: 5000, intervalMonths: 6 }];

/**
 * Resolve the OEM interval set for a vehicle. Optional `mainSch` is the
 * (best-effort) response from the deployed MAIN_SCH lambda; when it carries
 * usable mileage/months intervals we merge them in as enrichment, but the
 * maintained table stays authoritative for the axes we reminder on.
 */
export function resolveIntervals({ make, model } = {}) {
  const mk = String(make || "").toUpperCase().trim();
  const md = String(model || "").toUpperCase().trim();
  const byModel = MMYT_SCHEDULES[`${mk}|${md}`];
  if (byModel) return { source: "mmyt", services: byModel };

  const brandMiles = BRAND_INTERVAL_MILES[mk];
  if (brandMiles) {
    return {
      source: "brand",
      services: [
        { ...OIL, intervalMiles: brandMiles, intervalMonths: 6 },
        { ...ROTATION, intervalMiles: brandMiles, intervalMonths: 6 },
      ],
    };
  }
  return { source: "generic", services: GENERIC };
}

// ── mileage-per-day estimation ───────────────────────────────────────────────
const DEFAULT_MILES_PER_DAY = 37; // ~13.5k mi/yr

/** Learn miles/day from history date+mileage deltas; fall back to a default. */
export function estimateMilesPerDay(history) {
  const pts = history
    .filter((r) => r.date && r.mileage != null)
    .map((r) => ({ t: new Date(r.date).getTime(), m: r.mileage }))
    .sort((a, b) => a.t - b.t);
  const rates = [];
  for (let i = 1; i < pts.length; i++) {
    const days = (pts[i].t - pts[i - 1].t) / 86400000;
    const miles = pts[i].m - pts[i - 1].m;
    if (days >= 7 && miles > 0) rates.push(miles / days);
  }
  if (!rates.length) return DEFAULT_MILES_PER_DAY;
  const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
  // Clamp to a sane band (5–200 mi/day) to avoid a single bad odometer read
  // producing a wild projection.
  return Math.min(200, Math.max(5, Math.round(avg)));
}

// ── matching ─────────────────────────────────────────────────────────────────
/**
 * For each scheduled service, find the most recent record that satisfies it.
 * A record can satisfy multiple services (a visit often does oil + rotation).
 * Returns a Map<serviceKey, { date, mileage, record }>.
 */
export function matchRecordsToSchedule(history, services) {
  const byService = new Map();
  for (const svc of services) {
    let best = null;
    for (const r of history) {
      const text = `${r.service || ""} ${r.serviceType || ""}`;
      if (!svc.match.test(text)) continue;
      // "most recent" by date, then mileage
      const better =
        !best ||
        (r.date || "") > (best.date || "") ||
        ((r.date || "") === (best.date || "") && (r.mileage || 0) > (best.mileage || 0));
      if (better) best = r;
    }
    if (best) byService.set(svc.key, { date: best.date, mileage: best.mileage, record: best });
  }
  return byService;
}

// ── prediction ───────────────────────────────────────────────────────────────
function addMonths(dateStr, months) {
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  // guard month-overflow (e.g. Aug 31 + 6mo)
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d;
}
const dayMs = 86400000;

/**
 * Predict the next due point for every service that has evidence, then return
 * the soonest as `nextService`.
 *
 * @param {object[]} history   normalized+deduped records
 * @param {object}   vehicle   { make, model, mileage }
 * @param {object}   opts      { asOf?: Date, mainSch? }
 * @returns { nextService, predictions[], milesPerDay, intervalSource }
 */
export function predictNext(history, vehicle, opts = {}) {
  const asOf = opts.asOf ? new Date(opts.asOf) : new Date();
  const currentMileage = Number(vehicle?.mileage || 0) ||
    Math.max(0, ...history.map((r) => r.mileage || 0));
  const { source, services } = resolveIntervals(vehicle);
  const milesPerDay = estimateMilesPerDay(history);
  const matched = matchRecordsToSchedule(history, services);

  const predictions = [];
  for (const svc of services) {
    const last = matched.get(svc.key);
    if (!last || !last.date) continue; // only predict where we have evidence

    // Mileage axis → project a due date using miles/day.
    let dueByMiles = null, dueMileage = null;
    if (last.mileage != null) {
      dueMileage = last.mileage + svc.intervalMiles;
      const milesRemaining = dueMileage - currentMileage;
      dueByMiles = new Date(asOf.getTime() + (milesRemaining / milesPerDay) * dayMs);
    }
    // Time axis → due date directly.
    const dueByTime = svc.intervalMonths ? addMonths(last.date, svc.intervalMonths) : null;

    // "Whichever comes first".
    const candidates = [dueByMiles, dueByTime].filter(Boolean);
    if (!candidates.length) continue;
    const dueDate = candidates.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b));
    const basis =
      dueByMiles && dueDate.getTime() === dueByMiles.getTime() ? "mileage" : "time";

    predictions.push({
      key: svc.key,
      label: svc.label,
      lastDate: last.date,
      lastMileage: last.mileage,
      intervalMiles: svc.intervalMiles,
      intervalMonths: svc.intervalMonths,
      dueMileage,
      dueDate: dueDate.toISOString().slice(0, 10),
      dueDateTime: dueDate,
      basis,
      milesRemaining: dueMileage != null ? dueMileage - currentMileage : null,
      daysRemaining: Math.round((dueDate.getTime() - asOf.getTime()) / dayMs),
    });
  }

  predictions.sort((a, b) => a.dueDateTime - b.dueDateTime);
  const nextService = predictions[0] || null;
  return { nextService, predictions, milesPerDay, currentMileage, intervalSource: source };
}

/** One-call convenience: raw rows → prediction. */
export function computeSchedule(rawRecords, vehicle, opts = {}) {
  const normalized = (rawRecords || []).map(normalizeRecord).filter((r) => r.service);
  const history = dedupeServiceHistory(normalized);
  return { ...predictNext(history, vehicle, opts), recordCount: history.length };
}

export const _internals = { DEFAULT_MILES_PER_DAY, MMYT_SCHEDULES, BRAND_INTERVAL_MILES };

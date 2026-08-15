/**
 * VIN → unified vehicle condition SUMMARY.
 *
 * Assembles every signal (title, flood, theft, recalls, known issues, AI inspection,
 * maintenance) into ONE object designed for effective communication:
 *   - a single headline status + plain-language one-liner (the bottom line)
 *   - per-category traffic lights (scan for problems instantly)
 *   - a PRIORITIZED action list (what to actually do)
 *   - coverage/honesty (what we know vs don't) + sources (trust)
 *
 * In production the inputs come from: Vehicle Databases (decode/title/saleshistory/recalls/
 * maintenance), NHTSA (issues), the flood + inspection + health prototypes, and Zoooom's
 * service history. Here they're passed in as `signals` so the SUMMARY logic is testable.
 *
 * Run:  node summary.js     # prints two example VIN summaries (text)
 * Also generates the data the HTML mockup (report.html) renders.
 */

import { getStateRequirement } from "./stateRules.mjs";

// Status ladder, worst-wins for the headline.
const RANK = { clear: 0, review: 1, caution: 2, serious: 3 };
const STATUS_LABEL = {
  clear: "Looks clear",
  review: "A few things to know",
  caution: "Worth a closer look",
  serious: "Important issues found",
};

/**
 * Build the summary from raw signals.
 * @param {object} s signals — see demo for shape
 */
export function buildSummary(s) {
  const cats = [];
  // Whether we have service records at all. Several cards depend on it: we can't
  // claim an issue was "addressed" or maintenance is "up to date" without records.
  const hasRecords = !!s.maintenance && s.maintenance.noRecords !== true;

  // --- Title ---
  cats.push(
    s.title?.floodBrand
      ? cat("title", "Title", "serious", "Branded FLOOD title on record.")
      : s.title?.salvage
      ? cat("title", "Title", "caution", salvageDetailMsg(s.title), { salvageDetails: s.title.salvageDetails || [] })
      : s.title?.checked === false
      ? // Source didn't respond — be honest, don't claim "Clean title" (false-clear).
        cat("title", "Title", "review", "Title-brand check didn't return in time — not yet verified. We'll re-check when this report refreshes.", { soft: true, noData: true })
      : cat("title", "Title", "clear", "Clean title — no salvage or flood brand.")
  );

  // --- Flood ---
  // Flood risk is a LOCATION signal, not a damage finding: it matches where/when this
  // VIN was recorded against FEMA disaster declarations. Only a branded title proves
  // actual water damage — so every state carries `more` spelling that out (owner
  // feedback, July 2026: readers took an area match to mean the car was flooded).
  cats.push(
    s.flood?.verdict === "FLOOD_TITLE"
      ? cat("flood", "Flood risk", "serious", "Branded flood title — water damage recorded on the title itself.", floodExtra(s.flood))
      : s.flood?.verdict === "HIGH" || s.flood?.verdict === "MEDIUM"
      ? cat("flood", "Flood risk", s.flood.verdict === "HIGH" ? "serious" : "caution", floodMsg(s.flood), floodExtra(s.flood))
      : cat("flood", "Flood risk", "clear", "No flood brand on the title and no flood-disaster area match.", floodExtra(s.flood))
  );

  // --- Theft ---
  // Honesty: only claim "no record" when the stolen-check actually ran. If it's
  // unavailable (e.g. key/service not yet active), say so instead of a false clear.
  cats.push(
    s.theft?.possibleStolen
      ? cat("theft", "Theft check", "serious", "Possible stolen record — verify before any purchase.", { checkedAt: s.theft?.checkedAt || null })
      : s.theft?.available === false
      ? cat("theft", "Theft check", "review", "Theft check pending — not yet confirmed against the stolen-vehicle database.", { soft: true, noData: true })
      : cat("theft", "Theft check", "clear", "No theft record found.", { checkedAt: s.theft?.checkedAt || null })
  );

  // --- Open recalls (VIN-specific) ---
  // `repaired` = campaigns the OWNER checked off in their garage. That's a self-
  // reported claim, not a dealer record, so when it's what cleared this category we
  // SAY so rather than showing a bare "No open recalls" — same honesty rule as the
  // title check above (never present an unverified clear as a verified one).
  const open = s.recalls?.open || 0;
  const repaired = s.recalls?.repaired || 0;
  cats.push(
    open > 0
      ? cat("recalls", "Open recalls", "caution",
          `${open} open recall${open > 1 ? "s" : ""} — often a FREE dealer fix.`,
          { count: open, ...(repaired ? { repaired } : {}) })
      : repaired > 0
      ? cat("recalls", "Open recalls", "clear",
          `No open recalls — the owner marked ${repaired === 1 ? "the recall" : `all ${repaired} recalls`} repaired. Owner-reported; ask for the dealer repair receipt.`,
          { repaired, ownerReported: true })
      : cat("recalls", "Open recalls", "clear", "No open recalls.")
  );

  // --- Known issues (NHTSA) vs service history ---
  // The model's top issues are known from NHTSA regardless of records. What needs
  // records is the claim that THIS car had them addressed — so split on hasRecords.
  const top = s.knownIssues?.top || [];
  const worstKnown = top[0];
  if (!worstKnown) {
    cats.push(cat("knownIssues", "Known issues", "clear", "No major reported issues for this model."));
  } else if (!hasRecords) {
    cats.push(cat("knownIssues", "Known issues", worstKnown.severe ? "caution" : "review",
      `${titleCase(worstKnown.component)} is this model's most-reported issue (${worstKnown.count} reports). Upload service records to check if yours was addressed.`,
      { soft: true, noData: true }));
  } else {
    const worst = top.filter((i) => !i.addressed)[0];
    cats.push(
      worst
        ? cat("knownIssues", "Known issues", worst.severe ? "serious" : "caution",
            `${titleCase(worst.component)} is this model's top reported issue (${worst.count} reports) — not seen in your service history.`)
        : cat("knownIssues", "Known issues", "clear", "Top reported issues appear addressed in your service history.")
    );
  }

  // --- AI inspection condition ---
  if (s.inspection) {
    const dmg = (s.inspection.exteriorDamage || []).length;
    cats.push(
      s.inspection.floodIndicators?.length
        ? cat("condition", "Condition (walkaround)", "serious", "Visual flood indicators seen in the walkaround photos.")
        : dmg > 2
        ? cat("condition", "Condition (walkaround)", "caution", `${dmg} cosmetic issues noted (not mechanically inspected).`)
        : cat("condition", "Condition (walkaround)", "review", "Minor/no cosmetic issues (not mechanically inspected).")
    );
  } else {
    cats.push(cat("condition", "Condition (walkaround)", "review", "No walkaround photos yet — add a guided photo set to verify condition.", { soft: true }));
  }

  // --- Maintenance ---
  // No service records → we CANNOT claim "up to date". Show an honest "unknown"
  // state and turn it into the upload→reminders hook (gaps become CTAs).
  if (!hasRecords) {
    cats.push(cat("maintenance", "Maintenance", "review",
      "No service records yet — upload them and Zoooom will remind you when your next service is due.",
      { soft: true, noData: true }));
  } else {
    // We surface the records we HAVE. We do NOT claim "up to date" — a real
    // maintenance-schedule comparison against OEM intervals (MMYT table) is a
    // follow-up. So the honest statement is just the count on file.
    const n = s.maintenance.recordCount || (s.serviceHistory || []).length || 0;
    cats.push(cat("maintenance", "Maintenance", "review",
      `${n} service/maintenance record${n === 1 ? "" : "s"} found. We show what's on file — a full maintenance-schedule comparison is coming.`,
      { soft: true }));
  }

  // --- Headline (worst-wins, but soft/review categories don't dominate) ---
  const worstStatus = cats.reduce((w, c) => (RANK[c.status] > RANK[w] ? c.status : w), "clear");
  const score = computeScore(cats);
  const headline = {
    status: worstStatus,
    label: STATUS_LABEL[worstStatus],
    score,
    band: score >= 85 ? "Good" : score >= 70 ? "Fair" : score >= 50 ? "Caution" : "Poor",
    oneLiner: oneLiner(s, cats, worstStatus),
  };

  return {
    vin: s.vin,
    vehicle: s.vehicle,
    powertrain: s.powertrain || null, // Gasoline|Diesel|Hybrid|Plug-in Hybrid|Electric
    mileage: s.mileage,
    headline,
    categories: cats,
    // AI walkaround condition DETAIL — the individual findings the AI saw, so the
    // report can show a real "visible damage" list (not just a count). Gated: the
    // locked preview strips this (see preview.mjs), same as other detail.
    walkaround: s.inspection
      ? {
          exteriorDamage: (s.inspection.exteriorDamage || []).map((d) => ({
            location: d.location, type: d.type, severity: d.severity,
          })),
          floodIndicators: (s.inspection.floodIndicators || []).map((f) => ({
            indicator: f.indicator, where: f.where, confidence: f.confidence,
          })),
          conditionScore: Number.isFinite(s.inspection.overallConditionScore)
            ? s.inspection.overallConditionScore : null,
        }
      : null,
    actions: buildActions(s, cats),
    reminderAvailable: !hasRecords, // drives the "upload records → service reminders" callout
    titleTransfer: titleTransferFor(s), // state smog + transfer overview (Zoooom doesn't do transfers)
    // NOTE: sales/listing history is deliberately NOT surfaced (July 2026) — an owner
    // reported the vendor timeline as inaccurate for their vehicle. The raw entries are
    // still used internally (flood location matching, identity, odometer fallback) but
    // we don't publish them as fact.
    serviceHistory: s.serviceHistory || null, // user-uploaded service records (summary-only; images gated in garage)
    marketValue: s.marketValue || null, // garage Market Price Guide (only when mileage available)
    salesTax: s.salesTax || null, // per-state buyer DMV tax + selector default

    coverage: s.coverage || { have: [], missing: [] },
    sources: ["NHTSA", "Vehicle Databases", "FEMA", "Zoooom service history"],
  };
}

function cat(key, label, status, detail, extra = {}) {
  return { key, label, status, detail, ...extra };
}

// Salvage title detail — surface the cause + recorded date when Vehicle Databases
// provides them (salvage_details), so the report says WHY/WHEN, not just "salvage".
function salvageDetailMsg(title) {
  const base = "Salvage title on record (non-flood).";
  const d = (title.salvageDetails || [])[0];
  if (!d || (!d.cause && !d.date)) return base;
  const cause = d.cause ? ` Cause: ${d.cause}.` : "";
  const date = d.date ? ` Recorded ${d.date}.` : "";
  return `${base}${cause}${date}`;
}

// State smog + title-transfer overview. Uses the vehicle's registration state
// (or seller state). Returns null if state unknown — section is hidden.
function titleTransferFor(s) {
  const state = s.state || s.registrationState;
  if (!state) return null;
  const year = s.vehicleYear || parseInt((s.vehicle || "").match(/\b(19|20)\d{2}\b/)?.[0] || "0", 10);
  return getStateRequirement(state, year);
}

// Transparent score: start at 100, deduct by finding. Shown as a guide, not gospel.
function computeScore(cats) {
  let score = 100;
  const DEDUCT = { serious: 30, caution: 12, review: 3, clear: 0 };
  for (const c of cats) score -= DEDUCT[c.status] * (c.soft ? 0.3 : 1);
  return Math.max(5, Math.round(score));
}

function oneLiner(s, cats, status) {
  const reds = cats.filter((c) => c.status === "serious").length;
  const ambers = cats.filter((c) => c.status === "caution").length;
  if (status === "clear") return `${s.vehicle} checks out across history, flood, theft, and recalls.`;
  const parts = [];
  if (reds) parts.push(`${reds} important issue${reds > 1 ? "s" : ""}`);
  if (ambers) parts.push(`${ambers} thing${ambers > 1 ? "s" : ""} to look at`);
  // Review-only (no reds/ambers): the big checks are clear, only soft "add your
  // info" items remain (no service records / no walkaround yet).
  if (!parts.length)
    return `${s.vehicle} is clear on history, flood, theft, and recalls — add a few details to complete the picture.`;
  return `${s.vehicle}: ${parts.join(" and ")}. Here's what matters most.`;
}

// External destinations for action CTAs, so a CTA is never a dead click even when
// the host app doesn't wire an onAction handler. `action` is a stable id the
// frontend can branch on (e.g. upload_records → open the records uploader).
const GUIDE_INSPECT = "https://zoooom.me/guides/ai-inspection.html";
const NHTSA_RECALLS = "https://www.nhtsa.gov/recalls";
const NICB_VINCHECK = "https://www.nicb.org/vincheck";

// Prioritized actions — safety/recalls first, then issues, then condition/maintenance.
function buildActions(s, cats) {
  const a = [];
  if (s.theft?.possibleStolen) a.push(act(1, "Verify the theft record before buying", "A possible stolen record was found. Do not transact until cleared.", "Verify", "verify_theft", NICB_VINCHECK));
  if (cats.find((c) => c.key === "flood" && c.status === "serious"))
    a.push(act(1, "Treat as possible flood vehicle",
      s.flood?.basis === "title"
        ? "The title itself carries a flood brand — water damage is on record. Get an independent inspection focused on electronics and corrosion before you buy."
        : "This is an area/history match, not confirmed damage — the title check is what records real flood damage. Confirm the title brand and get an independent inspection focused on electronics and corrosion.",
      "Get inspection", "get_inspection", GUIDE_INSPECT));
  if (s.title?.salvage && !s.title?.floodBrand)
    a.push(act(2, "Verify the salvage / branded title", "This car has a salvage (branded) title. Get an independent inspection focused on structural and safety repairs, and confirm it was properly re-titled (e.g. rebuilt) before you buy.", "Get inspection", "get_inspection", GUIDE_INSPECT));
  if ((s.recalls?.open || 0) > 0)
    a.push(act(2, `Get ${s.recalls.open} open recall${s.recalls.open > 1 ? "s" : ""} fixed`, "Open safety recalls are usually repaired free at a dealer — look up the specific recall by VIN at NHTSA.", "Look up the recall", "find_dealer", NHTSA_RECALLS));
  const watch = (s.knownIssues?.top || []).filter((i) => !i.addressed)[0];
  if (watch)
    a.push(act(3, `Have the ${titleCase(watch.component).toLowerCase()} checked`, `It's this model's most-reported issue (${watch.count} owner reports) and isn't in the service history.`, "How to check it", "why_matters", GUIDE_INSPECT));
  if ((s.maintenance?.milesOverdue || 0) > 5000)
    a.push(act(4, "Catch up on maintenance", `Service looks ~${s.maintenance.milesOverdue.toLocaleString()} mi overdue.`, "Upload records", "upload_records"));
  else if (!s.maintenance || s.maintenance.noRecords)
    a.push(act(6, "Upload your service records", "Add them once and Zoooom tracks your maintenance — we'll remind you when your next service is due, and it boosts buyer trust.", "Upload records", "upload_records"));
  if (!s.inspection)
    a.push(act(5, "Add a guided photo walkaround", "Take a quick guided photo set — Zoooom's AI gives an instant condition check and a Verified badge on the listing.", "Add walkaround photos", "record_walkaround", GUIDE_INSPECT));
  return a.sort((x, y) => x.priority - y.priority);
}

const act = (priority, title, why, cta, action, href) => ({ priority, title, why, cta, action, href });
const titleCase = (s) => (s || "").toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());
// One-line flood detail. Never claims damage unless it came from the title brand.
const floodMsg = (f) =>
  f?.basis === "disclosure"
    ? "Water damage was noted in a past listing/auction record for this VIN — it is not a title brand."
    : f?.verdict === "HIGH"
    ? "This VIN was in an area under a federal flood-disaster declaration that caused household damage — an area match, not confirmed damage to this car."
    : "This VIN was in a county under a federal flood-disaster declaration around that time — an area match, not confirmed damage to this car.";

// The expandable explainer under "Flood risk". Says plainly what the signal is,
// what it is NOT, and points at the Title check as the record of real flood damage.
const FLOOD_HOW =
  "How to read this: flood risk is a LOCATION signal. We take where and when this VIN " +
  "shows up in its history and match it against FEMA federal disaster declarations for " +
  "floods, hurricanes and tropical storms. A match means the car was in an area a flood " +
  "was declared in — it does NOT mean this car took on water. Most vehicles in a declared " +
  "county are never damaged. Actual flood damage is normally recorded as a branded " +
  "(flood or salvage) title, so the Title check above is the record to go by. Treat a " +
  "flood-risk match as a reason to look closer: confirm the title brand, and have an " +
  "inspection focused on corrosion, silt under the carpet, a damp/musty smell and " +
  "electrical faults.";

function floodExtra(f) {
  const src = "FEMA disaster declarations · title-brand check";
  if (f?.basis === "title") {
    return {
      src: "Title-brand check (Vehicle Databases)",
      more:
        "This one IS confirmed. It comes from the title-brand check, not from location: " +
        "an insurer or DMV recorded flood/water damage against this VIN, so the damage is " +
        "documented rather than inferred. See the Title row above for the recorded cause and " +
        "date, and treat the car as a flood vehicle unless a mechanic proves otherwise.",
    };
  }
  if (f?.basis === "disclosure") {
    return {
      src: "Vehicle history records (Vehicle Databases) · title-brand check",
      more:
        "This came from a damage field on a past listing or auction record for this VIN — " +
        "a seller/auction disclosure, not a title brand. It has not been confirmed by a " +
        "title authority. " + FLOOD_HOW,
    };
  }
  if (f?.verdict === "HIGH" || f?.verdict === "MEDIUM") return { src, more: FLOOD_HOW };
  // Clear: explain what we actually ruled out, so "clear" isn't read as more than it is.
  return {
    src,
    more:
      "We found no flood or water brand on this VIN's title, and no match between where " +
      "this VIN has been recorded and FEMA's federal flood-disaster declarations. " +
      FLOOD_HOW,
  };
}


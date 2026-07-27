/**
 * State smog + title-transfer requirements (REFERENCE DATA, not an API).
 *
 * IMPORTANT: there is no free, authoritative real-time API for this. Smog/emissions
 * and title-transfer rules are per-state (often per-COUNTY), have age exemptions, and
 * change over time. So this is a CURATED, SOURCED, DATED table. Every entry links to
 * the official state DMV and carries a `lastReviewed` date, and the UI must always say
 * "verify with your DMV." Presenting stale regulatory info as fact is a liability —
 * be conservative, cite the source, and date it.
 *
 * Coverage here: a few representative states populated carefully (CA/TX/NY/FL/AZ/MT),
 * plus a safe default. The full 50-state table needs research + HUMAN verification +
 * periodic review (see DESIGN.md). Zoooom does NOT offer title-transfer services — this
 * is purely an informational overview to point users to the right place.
 *
 * Run:  node stateRules.js                 # demo across states + ages
 *       node stateRules.js CA 2017
 */

import { getTransferRequirement, odometerDisclosureRequired } from "./transferRules.mjs";

const REVIEWED = "2026-06"; // bump when the table is re-verified
// Primary-source verified June 2026 (deep-research, 3-0 adversarial): AZ CA FL GA MI NY OH TX VA.
// MT carried from baseline (medium confidence, not re-verified). All others = "varies" (open work).
// KEY FINDING: smog passing is tied to REGISTRATION, not title transfer, in nearly every state —
// CALIFORNIA is the exception (seller must give the buyer a valid smog cert at sale).

// Each entry: official source + a resolve(year, curYear) -> {status, reason}.
// status: "transfer" (CA) | "register" (statewide) | "register_metro" | "none" | "varies"
const STATES = {
  CA: {
    name: "California",
    url: "https://www.dmv.ca.gov/portal/vehicle-registration/smog-inspections/",
    steps: ["California Certificate of Title (buyer + seller/lienholder signatures)", "Valid smog certificate (seller provides to buyer, if required)", "Bill of sale", "Odometer disclosure", "Transfer fee (~$15)"],
    resolve: (y) =>
      y <= 1975
        ? { status: "none", reason: "Gasoline vehicles 1975 and older are exempt from smog certification." }
        : { status: "transfer", reason: "The seller must give the buyer a valid smog certificate to complete the sale (CA ties smog to the transfer itself). Gas vehicles 1975 & older are exempt; vehicles under 4 model years old need no test (buyer pays a smog transfer fee); cert valid ~90 days." },
  },
  TX: {
    name: "Texas",
    url: "https://www.tceq.texas.gov/airquality/mobilesource/vim/overview.html",
    steps: ["Signed title", "Emissions test (certain metro counties only)", "Bill of sale", "Odometer disclosure", "Application for title (Form 130-U)"],
    resolve: (y, cur) => {
      const age = cur - y;
      return age < 2 || age > 24
        ? { status: "none", reason: "Emissions testing applies to gasoline vehicles 2–24 model years old; this vehicle falls outside that range." }
        : { status: "register_metro", reason: "Emissions testing (for annual REGISTRATION renewal, not the title transfer) is required only in 5 metro areas: Dallas–Fort Worth, Houston, Austin, El Paso, and San Antonio/Bexar (effective Nov 1, 2026), for gasoline vehicles 2–24 model years old." };
    },
  },
  NY: {
    name: "New York",
    url: "https://dmv.ny.gov/new-york-state-vehicle-safetyemissions-inspection-program",
    steps: ["Signed title", "Emissions/safety inspection (to register)", "Bill of sale (MV-912)", "Odometer & damage disclosure", "Sales tax form (DTF-802)"],
    resolve: (y, cur) =>
      cur - y >= 25
        ? { status: "none", reason: "Vehicles more than 25 model years old are exempt from emissions inspection." }
        : { status: "register", reason: "A statewide emissions inspection is required to REGISTER the vehicle (all NY counties), not as a separate title-transfer gate. Vehicles 25+ model years old are exempt." },
  },
  FL: {
    name: "Florida",
    url: "https://www.flhsmv.gov",
    steps: ["Signed title (with odometer)", "Bill of sale", "Lien release if financed", "Application for title"],
    resolve: () => ({ status: "none", reason: "Florida has no state emissions/smog testing program." }),
  },
  AZ: {
    name: "Arizona",
    url: "https://azdot.gov/mvd/services/vehicle-services/vehicle-registration/emissions",
    steps: ["Signed title", "Emissions test (Phoenix/Tucson areas, to register)", "Bill of sale", "Odometer disclosure"],
    resolve: (y) =>
      y <= 1966
        ? { status: "none", reason: "Vehicles model year 1966 and older are exempt." }
        : { status: "register_metro", reason: "Emissions testing (to register) is required only in the Phoenix and Tucson metro areas, including if you commute into them." },
  },
  GA: {
    name: "Georgia",
    url: "https://epd.georgia.gov/air-protection-branch/air-branch-programs/mobile-and-area-sources-program/inspection-and",
    steps: ["Signed title (T-4 lien forms if financed)", "Emissions test (Atlanta metro, to register)", "Bill of sale (T-7)", "Odometer disclosure"],
    resolve: () => ({ status: "register_metro", reason: "Emissions testing (to register) is required only in the 13-county metro-Atlanta area; not statewide." }),
  },
  OH: {
    name: "Ohio",
    url: "https://epa.ohio.gov/divisions-and-offices/air-pollution-control/e-check",
    steps: ["Signed title (notarized)", "E-Check (7 NE Ohio counties, for registration/plate transfer)", "Odometer disclosure", "Out-of-state VIN inspection if applicable"],
    resolve: () => ({ status: "register_metro", reason: "E-Check emissions testing (for registration/plate transfer, not title transfer) applies only in 7 NE Ohio counties (Cleveland/Akron metro). A 2026 repeal has been proposed but is NOT yet enacted." }),
  },
  VA: {
    name: "Virginia",
    url: "https://www.dmv.virginia.gov/vehicles/registration/emissions",
    steps: ["VA title with Certification of Buyer (Section H)", "Emissions test (Northern Virginia, to register)", "Bill of sale or Vehicle Price Certification", "Odometer disclosure"],
    resolve: () => ({ status: "register_metro", reason: "Emissions testing is required to REGISTER (not to transfer title), and only in Northern Virginia. (A separate statewide annual safety inspection also applies.)" }),
  },
  MI: {
    name: "Michigan",
    url: "https://www.michigan.gov/sos/all-services/title-transfer-and-vehicle-registration",
    steps: ["Signed title", "Odometer disclosure", "Lien termination if financed", "Proof of Michigan No-Fault insurance", "Title/registration fees"],
    resolve: () => ({ status: "none", reason: "Michigan has no emissions/smog program — none required to register or transfer." }),
  },
  MT: {
    name: "Montana",
    url: "https://dojmt.gov/driving",
    steps: ["Signed title", "Bill of sale", "Odometer disclosure", "Application for title"],
    resolve: () => ({ status: "none", reason: "Montana has no emissions/smog testing program. (Carried from baseline; medium confidence.)" }),
  },
};

const DEFAULT_ENTRY = {
  name: null,
  url: "https://www.usa.gov/state-motor-vehicle-services",
  steps: ["Signed title (seller + buyer)", "Bill of sale", "Odometer disclosure (federal, vehicles under 20 yrs)", "Lien release if financed"],
  resolve: () => ({ status: "varies", reason: "Smog/emissions and transfer requirements vary by state and county — check your state DMV. (Not yet primary-source verified for this state.)" }),
};

const LABEL = {
  transfer: "Smog certificate required for the title transfer",
  register: "Emissions check required to register",
  register_metro: "Emissions check required to register — some counties only",
  none: "No emissions/smog check required",
  varies: "Requirements vary — check your state DMV",
};

/**
 * @param {string} stateCode USPS code, e.g. "CA"
 * @param {number} vehicleYear
 * @param {number} [currentYear=2026]
 */
export function getStateRequirement(stateCode, vehicleYear, currentYear = 2026) {
  const code = (stateCode || "").toUpperCase();
  const e = STATES[code] || DEFAULT_ENTRY;
  const r = e.resolve(vehicleYear, currentYear);
  const t = getTransferRequirement(code); // BOS + notarization + safety + VIN (reference DB)
  // Smog: verified path wins; if verified is "varies" use the reference value (clearly labeled).
  const smog = r.status === "varies" && t.smogRef
    ? { status: "reference", label: `Smog: ${t.smogRef}`, detail: `Reference value (pending official verification): ${t.smogRef}. Verify with your DMV.` }
    : { status: r.status, label: LABEL[r.status], detail: r.reason };
  const odo = odometerDisclosureRequired(vehicleYear, currentYear);
  return {
    state: e.name || code || "Unknown",
    stateCode: code,
    smog,
    safetyInspection: t.safety === null ? null : t.safety ? { required: true, label: "Safety inspection at/near transfer", note: t.safety } : { required: false, label: "No safety inspection at transfer" },
    crossBorderVin: t.vinCheck === null ? null : { required: t.vinCheck, label: t.vinCheck ? "Out-of-state VIN check required" : "No out-of-state VIN check" },
    odometer: odo.required === null ? null : { required: odo.required, label: odo.required ? "Odometer disclosure required (20-yr rule)" : "Odometer disclosure exempt", note: odo.reason },
    bos: { status: t.bos, label: t.bosLabel },
    notarization: {
      required: t.notarizeRequired, // true | false | null(unknown)
      what: t.notarizeTitle && t.notarizeBOS ? "title + bill of sale" : t.notarizeTitle ? "title signature" : t.notarizeBOS ? "bill of sale" : null,
      ronAccepted: t.ronAccepted,
      label:
        t.notarizeRequired === null ? "Notarization — check your DMV"
        : t.notarizeRequired ? `Notarization required (${t.notarizeTitle && t.notarizeBOS ? "title + bill of sale" : t.notarizeTitle ? "title" : "bill of sale"})`
        : "No notarization required",
    },
    criticalNote: t.note,
    steps: e.steps,
    source: { name: t.dmv, url: STATES[code] ? e.url : null }, // official agency name; deep link only for .gov-verified states
    lastReviewed: REVIEWED,
    note: "Zoooom doesn't handle title transfers. This is a quick overview — verify current requirements with your state DMV before buying or selling.",
  };
}


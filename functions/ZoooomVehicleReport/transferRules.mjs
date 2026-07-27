/**
 * Per-state P2P title-transfer reference database (Bill of Sale, Notarization, Safety
 * inspection at transfer, Cross-border out-of-state VIN check) + official DMV source.
 *
 * SOURCE: Zoooom team master DB (Confluence "P2P Title Transfer Requirement Per State",
 * June 2026), which cites third-party references (headlights.com, insurify.com, etags.com,
 * formswift.com, etc.) — so this is REFERENCE-GRADE, NOT primary-source verified. The UI
 * must always say "verify with your state DMV." The weekly deep-research routine verifies
 * these fields against official .gov sources and flags changes for human approval.
 *
 * Trust tiers:
 *  - SMOG is owned by stateRules.js (9 states .gov-verified; rest "varies"). `smogRef` here
 *    is the Confluence reference value, shown ONLY when verified smog is "varies".
 *  - CONFLICT FLAG: OH smogRef says "E-Check ended", but .gov-verified (June 2026) says it's
 *    active w/ proposed-not-enacted repeal. Verified wins; weekly routine to resolve.
 *
 * Fields: bos (required|not_required|conditional) · notarizeTitle · notarizeBOS ·
 *         smogRef · safety (false=no | "<note>"=yes | null=unknown) · vinCheck (bool|null) ·
 *         ronAccepted (null=unknown) · note (critical user note) · dmv (official agency).
 */

const E = (bos, nt, nb, smogRef, safety, vin, note, dmv) => ({
  bos, notarizeTitle: nt, notarizeBOS: nb, smogRef, safety, vinCheck: vin, ronAccepted: null, note, dmv,
});

export const TRANSFER = {
  AL: E("required", false, false, "No", false, false, "Used to calculate sales tax at registration.", "Alabama Dept. of Revenue – Motor Vehicle Division"),
  AK: E("not_required", false, false, "No", false, false, "File a Notice of Vehicle Transfer online within 10 days.", "Alaska DMV – Vehicle Services & Transfers"),
  AZ: E("not_required", true, false, "Regional (Phoenix/Tucson metro)", false, true, "Seller's signature on the title must be notarized.", "Arizona DOT – eTitle Transfer"),
  AR: E("required", false, false, "No", false, false, "Recommended to use official Form 10-313.", "Arkansas Dept. of Finance and Administration"),
  CA: E("conditional", false, false, "Yes (seller provides smog cert; >4 model yrs)", false, true, "BOS needed only if the title lacks space. File Notice of Transfer & Release of Liability within 5 days.", "California DMV – Title Transfers and Changes"),
  CO: E("required", false, false, "Regional (Denver metro, Boulder)", false, true, "Required for the buyer to obtain temporary registration plates.", "Colorado DMV – Title Transfer Rules"),
  CT: E("required", false, false, "Yes (biennial)", false, false, "Must use official Form H-31.", "Connecticut DMV – Transfer Vehicle Ownership"),
  DE: E("not_required", false, false, "Yes (checked at DMV transfer)", "At DMV registration", false, "Seller submits the detached bottom portion of the title to the DMV within 5 days.", "Delaware DMV – Title and Registration"),
  FL: E("not_required", false, false, "No", false, true, "Strongly recommended; Form HSMV 82050 files the notice of sale.", "Florida Highway Safety and Motor Vehicles (FLHSMV)"),
  GA: E("not_required", false, false, "Regional (13 metro-Atlanta counties)", false, false, "Title is sufficient unless the vehicle is older/exempt from a title.", "Georgia Dept. of Revenue – Title Transfers"),
  HI: E("required", false, false, "No", "Must pass within 12 months", false, "Handled entirely at the county level (not state).", "Hawaii County DMV – Vehicle Registration & Title"),
  ID: E("required", false, false, "Regional (Ada County)", false, true, "File an ITD 3858 Notice of Release of Liability within 5 days.", "Idaho Transportation Dept. – Vehicle Titling"),
  IL: E("not_required", false, false, "Regional (Chicago / Metro East)", false, true, "Tax Form RUT-50 must be filled out to report private sale tax.", "Illinois Secretary of State – Vehicle Services"),
  IN: E("not_required", false, false, "Regional (Lake & Porter counties)", false, true, "Needed only if buying a car with an out-of-state title.", "Indiana Bureau of Motor Vehicles (BMV)"),
  IA: E("not_required", false, false, "No", false, false, "Damage Disclosure (Form 411108) required if under 7 years old.", "Iowa DOT – Transferring a Title"),
  KS: E("not_required", false, false, "No", false, true, "Needed if the title has no space for purchase price/date.", "Kansas Dept. of Revenue – Vehicle Title"),
  KY: E("not_required", true, false, "No", false, true, "Buyer and seller signatures on the title must be notarized.", "Kentucky drive.ky.gov – Title Transfers"),
  LA: E("required", true, true, "Regional (Baton Rouge area)", "Mandatory annual link", false, "Strict enforcement; both the bill of sale AND title require notarization.", "Louisiana Office of Motor Vehicles (OMV)"),
  ME: E("required", false, false, "No", "Annual link; checked at transfer", false, "Required for the buyer to pay municipal excise tax.", "Maine Bureau of Motor Vehicles (BMV)"),
  MD: E("not_required", false, false, "Regional (14 counties)", "Strictly mandatory prior to sale", true, "BOS required only if the vehicle is under 7 years old and bought below book value.", "Maryland Motor Vehicle Administration (MVA)"),
  MA: E("not_required", false, false, "Yes (annual emissions combined loop)", "Must inspect within 7 days of buying", false, "Title is primary; BOS is needed for tax validation.", "Massachusetts RMV – Transfer Vehicle"),
  MI: E("not_required", false, false, "No", false, false, "Title is sufficient; odometer reading must be on the title.", "Michigan Secretary of State (SOS) – Title Transfer"),
  MN: E("not_required", false, false, "No", false, false, "Seller must file a Report of Sale within 10 days.", "Minnesota DVS – Vehicle Title Transfers"),
  MS: E("not_required", false, false, "No", false, false, "BOS only required if the title runs out of reassignment spaces.", "Mississippi Dept. of Revenue – Title Division"),
  MO: E("not_required", false, false, "Regional (St. Louis area)", "If >10 model yrs OR 150k+ miles", true, "File Form 5049 (Notice of Sale) within 30 days.", "Missouri Dept. of Revenue – Titling & Registering"),
  MT: E("not_required", true, false, "No", false, false, "Seller's signature on the title must be notarized.", "Montana DOJ – Motor Vehicle Division"),
  NE: E("required", false, true, "No", false, true, "BOS must be notarized if the title lacks space for price.", "Nebraska DMV – Title & Registration"),
  NV: E("not_required", false, false, "Regional (Clark and Washoe counties)", false, true, "License plates must be removed by the seller immediately.", "Nevada DMV – Vehicle Registration & Transfers"),
  NH: E("not_required", false, false, "Yes (OBD-II scan, <20 yrs old)", "Must inspect within 10 days of buying", false, "BOS only required for vehicles exempt from titles (older models).", "New Hampshire DMV – Title Bureau"),
  NJ: E("not_required", false, false, "Yes (biennial inspections)", false, false, "Title must include price; BOS is optional but recommended.", "New Jersey Motor Vehicle Commission (MVC)"),
  NM: E("not_required", false, false, "Regional (Bernalillo County)", false, true, "BOS required only if the title is missing odometer/price info.", "New Mexico MVD – Title & Registration"),
  NY: E("required", false, false, "Yes (annual safety/emissions linked)", "Buyer must complete upon transfer", false, "Must use official NY DMV Form MV-912.", "New York DMV – Buy or Sell a Vehicle"),
  NC: E("not_required", true, false, "Regional (certain gas models)", "Annual safety system verification", false, "Both signatures on the title must be notarized.", "North Carolina DMV – Title Transfers"),
  ND: E("not_required", false, false, "No", false, false, "Purchaser must apply for a new title within 30 days.", "North Dakota DOT – Vehicle Title & Registration"),
  OH: E("required", true, false, "No (E-Check ended) [CONFLICT: .gov-verified says active]", false, true, "Seller's signature on the title must be notarized.", "Ohio BMV – Title Transfers"),
  OK: E("not_required", true, false, "No", false, true, "Seller's signature on the title must be notarized.", "Service Oklahoma – Motor Vehicle Services"),
  OR: E("not_required", false, false, "Regional (Portland / Medford)", false, true, "Seller must notify the DMV within 10 days of sale.", "Oregon DMV – Title Transfers"),
  PA: E("not_required", true, false, "Regional (25 designated counties)", "Strict physical annual check", true, "All title transfers must be signed before a notary.", "Pennsylvania PennDOT – Vehicle Title"),
  RI: E("required", false, false, "Yes (biennial combined loop)", "Must inspect within 5 days of sale", true, "Mandatory to register any newly purchased private vehicle.", "Rhode Island DMV – Registration & Titles"),
  SC: E("not_required", false, false, "No", false, false, "Title is sufficient; file a Notice of Vehicle Transfer (Form 416).", "South Carolina DMV – Title Transfer"),
  SD: E("required", false, false, "No", false, false, "Mandatory for title transfer and processing sales tax.", "South Dakota Dept. of Revenue"),
  TN: E("not_required", false, false, "No", false, false, "If price is unfairly low, an affidavit of low selling price is needed.", "Tennessee Dept. of Revenue – Title & Reg"),
  TX: E("not_required", false, false, "Regional (17 major metro counties)", false, false, "Buyer and seller should complete Form VTR-130U. (State safety inspection mandate ended 2025.)", "Texas Dept. of Motor Vehicles (TxDMV)"),
  UT: E("not_required", false, false, "Regional (5 major urban counties)", false, true, "File a 'Vehicle Web Transfer' notification immediately.", "Utah DMV – Vehicle Title Transfers"),
  VT: E("required", false, false, "Yes (annual emissions linked)", "Must inspect within 15 days of sale", true, "Must use official Form TA-VT-05.", "Vermont DMV – Transfer Vehicle Ownership"),
  VA: E("not_required", false, false, "Regional (Northern VA counties)", "Strict annual safety sticker law", false, "Seller should report the sale online to the DMV immediately.", "Virginia DMV – Vehicle Ownership Transfers"),
  WA: E("required", false, false, "No", false, true, "Must file a Vehicle Report of Sale within 5 days.", "Washington State DOL – Title Transfers"),
  WV: E("required", false, true, "No", "Strict mandatory annual check", true, "BOS must be notarized if bought under fair market value.", "West Virginia DMV – Vehicle Services"),
  WI: E("not_required", false, false, "No", null, null, "Seller should file a Seller Notification online.", "Wisconsin DOT – Vehicle Title and Plates"),
  WY: E("required", true, false, "No", null, null, "Seller's signature on the title must be notarized.", "Wyoming DOT – Title and Registration"),
};

const BOS_LABEL = { required: "Bill of sale required", not_required: "Bill of sale not required", conditional: "Bill of sale sometimes required" };

/**
 * NHTSA 20-year rolling odometer rule (as of 2026): vehicles model-year 2010 & older are
 * permanently exempt; 2011 & newer require disclosure until 20 calendar years from model year.
 */
export function odometerDisclosureRequired(vehicleYear, currentYear = 2026) {
  if (!vehicleYear) return { required: null, reason: "Vehicle year unknown." };
  if (vehicleYear <= 2010) return { required: false, reason: "Model year 2010 & older — permanently exempt from federal odometer disclosure." };
  const exemptAt = vehicleYear + 20;
  return currentYear < exemptAt
    ? { required: true, reason: `Federal odometer disclosure required until ${exemptAt} (20-yr rule).` }
    : { required: false, reason: `Past the 20-year window (exempt since ${exemptAt}).` };
}

export function getTransferRequirement(stateCode) {
  const code = (stateCode || "").toUpperCase();
  const t = TRANSFER[code];
  if (!t) {
    return { stateCode: code, bos: "varies", bosLabel: "Check your state DMV", notarizeTitle: null, notarizeBOS: null, notarizeRequired: null, ronAccepted: null, smogRef: null, safety: null, vinCheck: null, note: "Title-transfer rules not yet compiled for this state.", dmv: "State motor-vehicle agency", verified: false };
  }
  return {
    stateCode: code,
    bos: t.bos,
    bosLabel: BOS_LABEL[t.bos],
    notarizeTitle: t.notarizeTitle,
    notarizeBOS: t.notarizeBOS,
    notarizeRequired: !!(t.notarizeTitle || t.notarizeBOS),
    ronAccepted: t.ronAccepted,
    smogRef: t.smogRef,
    safety: t.safety, // false=no | "<note>"=yes | null=unknown
    vinCheck: t.vinCheck, // bool | null
    note: t.note,
    dmv: t.dmv,
    verified: false, // reference-grade; pending official-source verification
  };
}

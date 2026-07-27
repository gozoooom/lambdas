/**
 * Per-state private-party vehicle SALES/USE TAX (reference data, bundled — universal,
 * not env-specific). The buyer pays this at THEIR home-state/county DMV when registering,
 * based on THEIR purchase price — not to the seller. State rate only; LOCAL (county/city)
 * tax usually adds on top. Some states tax the book/fair-market value, not the price paid.
 *
 * Source: curated June 2026 (rates change — the weekly deep-research routine verifies these).
 * `verified:false` until the routine confirms against state DOR/DMV sources.
 *
 * rate: state % (0 = no state sales tax) · localAdds: county/city tax added on top
 * type: "sales" | "excise" | "highway_use" | "tavt" | "none"
 * valuationNote: states that tax the higher of price vs. book value
 */
const T = (rate, localAdds = false, type = "sales", valuationNote = null, note = null) => ({ rate, localAdds, type, valuationNote, note });

export const TAX = {
  // No state sales/use tax on private vehicle purchases
  AK: T(0, true, "none", null, "No state sales tax; some local municipalities may charge local tax."),
  DE: T(0, false, "none", null, "No sales tax (a separate document fee may apply)."),
  MT: T(0, false, "none", null, "No sales tax."),
  NH: T(0, false, "none", null, "No sales tax."),
  OR: T(0, false, "none", null, "No sales tax."),
  // Flat state rates (+ local where noted)
  AL: T(2.0, true), AZ: T(5.6, true), AR: T(6.5, true),
  CA: T(7.25, true, "sales", "Tax may be assessed on fair market value, not just the price written on the bill of sale."),
  CO: T(2.9, true), CT: T(6.35, false, "sales", "Higher rate (~7.75%) applies to vehicles over $50,000."), FL: T(6.0, true),
  GA: T(7.0, false, "tavt", null, "Title Ad Valorem Tax (TAVT) — one-time, replaces annual ad valorem tax."),
  HI: T(4.0), ID: T(6.0), IL: T(7.25, true), IN: T(7.0), IA: T(5.0), KS: T(7.5, true), KY: T(6.0),
  LA: T(4.45, true), ME: T(5.5), MD: T(6.0), MA: T(6.25),
  MI: T(6.0, false, "sales", "Tax assessed on fair market value (minimum taxable value)."),
  MN: T(6.88), MS: T(5.0), MO: T(4.225, true), NE: T(5.5, true), NV: T(8.25, true), NJ: T(6.625),
  NM: T(3.0, true, "excise"), NY: T(4.0, true),
  NC: T(3.0, false, "highway_use"), ND: T(5.0), OH: T(5.75, true), OK: T(3.25, true), PA: T(6.0, true),
  RI: T(7.0),
  SC: T(5.0, false, "sales", "Capped at a maximum dollar amount per vehicle."),
  SD: T(4.0), TN: T(7.0, true),
  TX: T(6.25, false, "sales", "Standard Presumptive Value (SPV) — tax on the higher of the price paid or the state's SPV unless you get a licensed appraisal."),
  UT: T(6.85, true), VT: T(6.0), VA: T(4.15, true), WA: T(6.5, true), WV: T(6.0), WI: T(5.0, true), WY: T(4.0, true),
};

const TYPE_LABEL = { sales: "sales/use tax", excise: "excise tax", highway_use: "Highway Use Tax", tavt: "Title Ad Valorem Tax", none: "no state sales tax" };

/** Full table for the report payload (drives the buyer's state selector). */
export function buildTaxTable() {
  const out = {};
  for (const [code, t] of Object.entries(TAX)) {
    out[code] = { rate: t.rate, localAdds: t.localAdds, type: t.type, typeLabel: TYPE_LABEL[t.type], valuationNote: t.valuationNote, note: t.note };
  }
  return out;
}

export function getStateTax(stateCode) {
  const code = (stateCode || "").toUpperCase();
  const t = TAX[code];
  if (!t) return { rate: null, localAdds: null, type: "varies", typeLabel: "varies — check your DMV", valuationNote: null, note: "Rate not on file — verify with your state DMV." };
  return { rate: t.rate, localAdds: t.localAdds, type: t.type, typeLabel: TYPE_LABEL[t.type], valuationNote: t.valuationNote, note: t.note };
}

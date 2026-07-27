/**
 * Vehicle Databases API client.
 * Docs: Sales History / Title Check / Stolen Check endpoints, base https://api.vehicledatabases.com
 * Auth: header `x-authkey: <API_KEY>`.
 *
 * Every call degrades gracefully: on error/non-200 it returns a null-ish result so a single
 * failing source never fails the whole report.
 */

const BASE = process.env.VD_API_BASE_URL || "https://api.vehicledatabases.com";
// Reuse the SAME credential the deployed VIN-decode lambdas use
// (ZoooomVINDecodeVDB / ZoooomGetMarketValue both read VEHICLE_DB_API_KEY).
// Fall back to VD_API_KEY for the standalone prototype/local runs.
const KEY = process.env.VEHICLE_DB_API_KEY || process.env.VD_API_KEY;
// Vehicle Databases title-check routinely takes ~11–12s to respond, so a 12s
// abort was tipping real "success" calls into timeouts (→ title=null → the report
// showed the title source as "unavailable" AND falsely defaulted to "Clean title").
// Give it real headroom while staying under the API Gateway 29s integration cap.
const TIMEOUT_MS = Number(process.env.VD_TIMEOUT_MS || "20000");

async function vdGet(path) {
  if (!KEY) {
    console.warn("⚠️ VEHICLE_DB_API_KEY not set — skipping Vehicle Databases call:", path);
    return null;
  }
  const url = `${BASE}${path}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "x-authkey": KEY }, signal: ctrl.signal });
    if (!res.ok) {
      console.warn(`⚠️ VD ${path} → ${res.status}`);
      return null;
    }
    const body = await res.json();
    if (body?.status && body.status !== "success") {
      console.warn(`⚠️ VD ${path} status=${body.status}`);
      return null;
    }
    return body;
  } catch (e) {
    console.warn(`❌ VD ${path} error:`, e.message);
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Title brand / salvage record. → { salvage, salvage_details:[{cause,date}] } | null */
export async function getTitleCheck(vin) {
  const b = await vdGet(`/title-check/${encodeURIComponent(vin)}`);
  return b?.data ?? null;
}

/** Theft record. → { possibleStolen, records:[...] } | null */
export async function getStolenCheck(vin) {
  const b = await vdGet(`/stolen-check/${encodeURIComponent(vin)}`);
  if (!b?.data) return null;
  const records = Array.isArray(b.data) ? b.data : [b.data];
  const possibleStolen = records.some(
    (r) => r?.possible_stolen === true || String(r?.possible_stolen).toLowerCase() === "true"
  );
  return { possibleStolen, records };
}

/**
 * Sales history (listings/auctions over time). → {
 *   vin, year, make, model, trim,
 *   entries: [{ state, city, zip, date, primaryDamage, secondaryDamage, condition,
 *               sellerType, odometerMi, images:[...] }]
 * } | null
 */
export async function getSalesHistory(vin) {
  const b = await vdGet(`/saleshistory/${encodeURIComponent(vin)}`);
  const d = b?.data;
  if (!d) return null;
  const list = d.sales_history || [];
  const entries = list.map((e) => {
    const x = e.data || e;
    return {
      state: x.state || null,
      city: x.city || null,
      zip: x.zip_code || null,
      date: e.last_updated || x.last_updated || e.post_date || x.sale_date || null,
      primaryDamage: x.primary_damage || "",
      secondaryDamage: x.secondary_damage || "",
      condition: x.condition || "",
      sellerType: x.seller_type || "",
      odometerMi: x.odometer_mi || null,
      listingPrice: x.listing_price?.price || x.listing_price?.retail_value || null,
      currency: x.listing_price?.currency || "USD",
      images: Array.isArray(x.images) ? x.images : [],
    };
  });
  return {
    vin: d.vin || vin,
    year: d.year ? Number(d.year) : null,
    make: d.make || null,
    model: d.model || null,
    trim: d.trim || null,
    entries,
  };
}

/** Convenience: most-recent listing location (state/zip) for state-rules + flood. */
export function latestLocation(salesHistory) {
  if (!salesHistory?.entries?.length) return { state: null, zip: null };
  const withDate = salesHistory.entries.filter((e) => e.date);
  const sorted = (withDate.length ? withDate : salesHistory.entries).slice().sort(
    (a, b) => new Date(b.date || 0) - new Date(a.date || 0)
  );
  return { state: sorted[0]?.state || null, zip: sorted[0]?.zip || null };
}

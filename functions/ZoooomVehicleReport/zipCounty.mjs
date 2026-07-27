/**
 * zip → county resolution via two free, no-auth APIs (zippopotam → FCC area).
 * NOTE (prod follow-up): replace with a cached HUD/Census ZIP→FIPS crosswalk to remove
 * per-request latency. In-process cache here covers repeated lookups within a warm lambda.
 */
const cache = new Map();

export async function zipToCounty(zip) {
  if (!zip) return null;
  if (cache.has(zip)) return cache.get(zip);
  try {
    const zr = await fetch(`https://api.zippopotam.us/us/${encodeURIComponent(zip)}`);
    if (!zr.ok) throw new Error(`zip ${zr.status}`);
    const zj = await zr.json();
    const p = zj.places?.[0];
    if (!p) throw new Error("no place");
    const fr = await fetch(
      `https://geo.fcc.gov/api/census/area?lat=${p.latitude}&lon=${p.longitude}&censusYear=2020&format=json`
    );
    const fj = await fr.json();
    const r = fj.results?.[0];
    const out = r ? { county: r.county_name, state: r.state_code, fips: r.county_fips } : null;
    cache.set(zip, out);
    return out;
  } catch (e) {
    console.warn(`⚠️ zipToCounty(${zip}) failed:`, e.message);
    cache.set(zip, null);
    return null;
  }
}

/**
 * Flood-risk module: Vehicle Databases title/sales-history + FEMA disaster correlation.
 * Ported from prototypes/flood-risk. Advisory signal — never a hard block.
 *
 * verdict: "FLOOD_TITLE" | "HIGH" | "MEDIUM" | "NONE"
 */
import { zipToCounty } from "./zipCounty.mjs";

const FEMA_URL = "https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries";
const FLOOD_WORDS = /\b(flood|water|submerg|hurricane|storm surge)\b/i;
const DIRECT_FLOOD_TYPES = new Set(["Flood", "Hurricane", "Coastal Storm", "Tropical Storm", "Tsunami", "Dam/Levee Break"]);
const SALES_LOOKBACK_MONTHS = 18;

function normCounty(area) {
  if (!area) return "";
  return area.toLowerCase().replace(/\(.*?\)/g, " ").replace(/\bcounty\b/g, " ").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}
const overlaps = (aS, aE, bS, bE) => aS <= bE && bS <= aE;
function monthsBefore(iso, n) {
  const d = new Date(iso);
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
}

const stateDeclCache = new Map();
async function fetchStateDeclarations(state) {
  if (stateDeclCache.has(state)) return stateDeclCache.get(state);
  const types = ["Flood", "Hurricane", "Coastal Storm", "Tropical Storm", "Tsunami", "Dam/Levee Break", "Severe Storm", "Severe Storm(s)"];
  const filter = `state eq '${state}' and (${types.map((t) => `incidentType eq '${t.replace(/'/g, "''")}'`).join(" or ")})`;
  const url =
    `${FEMA_URL}?$filter=${encodeURIComponent(filter)}` +
    `&$select=disasterNumber,declarationType,declarationTitle,incidentType,incidentBeginDate,incidentEndDate,designatedArea,iaProgramDeclared,ihProgramDeclared&$top=1000&$orderby=incidentBeginDate desc`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "zoooom-vehicle-report" } });
    if (!res.ok) throw new Error(`FEMA ${res.status}`);
    const body = await res.json();
    const out = body.DisasterDeclarationsSummaries || [];
    stateDeclCache.set(state, out);
    return out;
  } catch (e) {
    console.warn(`⚠️ FEMA(${state}) failed:`, e.message);
    return [];
  }
}

async function femaMatch({ state, county, fromDate, toDate }) {
  const decls = await fetchStateDeclarations(state);
  const target = normCounty(county);
  const winStart = new Date(fromDate);
  const winEnd = new Date(toDate);
  const matches = [];
  for (const d of decls) {
    const ds = new Date(d.incidentBeginDate);
    const de = new Date(d.incidentEndDate || d.incidentBeginDate);
    if (!overlaps(winStart, winEnd, ds, de)) continue;
    if (target && normCounty(d.designatedArea) !== target) continue;
    const direct = DIRECT_FLOOD_TYPES.has(d.incidentType);
    if (!direct && !/FLOOD/i.test(d.declarationTitle || "")) continue;
    matches.push({
      label: `${d.declarationType}-${d.disasterNumber} ${d.incidentType} ${(d.incidentBeginDate || "").slice(0, 10)}→${(d.incidentEndDate || "").slice(0, 10)}`,
      direct,
      householdDamage: !!(d.iaProgramDeclared || d.ihProgramDeclared),
    });
  }
  if (!matches.length) return { risk: "NONE", events: [] };
  const hasDirectDamage = matches.some((m) => m.direct && m.householdDamage);
  const hasDirect = matches.some((m) => m.direct);
  return { risk: hasDirectDamage ? "HIGH" : hasDirect ? "MEDIUM" : "LOW", events: matches.map((m) => m.label) };
}

/**
 * @param {object} title  Vehicle Databases title-check data ({salvage, salvage_details})
 * @param {object} sales  parsed sales history ({entries:[{state,zip,date,primaryDamage,...,images}]})
 */
export async function assessFlood(title, sales) {
  // 1. Title brand = definitive.
  if (title?.salvage && (title.salvage_details || []).some((s) => FLOOD_WORDS.test(s.cause || ""))) {
    return { verdict: "FLOOD_TITLE", events: ["Branded flood/salvage title"], images: [] };
  }
  const images = [];
  let geoRisk = "NONE";
  const events = [];
  let disclosure = false;

  for (const e of sales?.entries || []) {
    if (Array.isArray(e.images)) images.push(...e.images);
    const dmg = [e.primaryDamage, e.secondaryDamage, e.condition].filter(Boolean).join(" ");
    if (FLOOD_WORDS.test(dmg)) disclosure = true;

    if (e.zip && e.date) {
      const co = await zipToCounty(e.zip);
      if (co) {
        const r = await femaMatch({ state: co.state, county: co.county, fromDate: monthsBefore(e.date, SALES_LOOKBACK_MONTHS), toDate: e.date });
        if (r.risk === "HIGH") { geoRisk = "HIGH"; events.push(...r.events); }
        else if (r.risk !== "NONE" && geoRisk === "NONE") { geoRisk = "MEDIUM"; events.push(...r.events); }
      }
    }
  }

  const verdict = disclosure ? "HIGH" : geoRisk;
  return { verdict, events, images: images.slice(0, 12) };
}

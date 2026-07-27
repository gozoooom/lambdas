/**
 * Known-issues module: NHTSA recalls + complaints by Year/Make/Model, severity-ranked.
 * Ported from prototypes/vehicle-health. Trusted (gov data); nothing LLM-generated.
 * Returns { recallCount, recalls:[], topIssues:[{component,count,severe,...}] }.
 */
const NHTSA = "https://api.nhtsa.gov";

async function getJSON(url) {
  const r = await fetch(url, { headers: { "User-Agent": "zoooom-vehicle-report" } });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

export async function getKnownIssues(make, model, year) {
  if (!make || !model || !year) return null;
  const m = encodeURIComponent(make.toLowerCase());
  const md = encodeURIComponent(model.toLowerCase());
  let recalls = [];
  let complaints = [];
  try {
    const rd = await getJSON(`${NHTSA}/recalls/recallsByVehicle?make=${m}&model=${md}&modelYear=${year}`);
    recalls = (rd.results || []).map((x) => ({ component: x.Component, campaign: x.NHTSACampaignNumber }));
  } catch (e) {
    console.warn("⚠️ NHTSA recalls failed:", e.message);
  }
  try {
    const cd = await getJSON(`${NHTSA}/complaints/complaintsByVehicle?make=${m}&model=${md}&modelYear=${year}`);
    complaints = cd.results || [];
  } catch (e) {
    console.warn("⚠️ NHTSA complaints failed:", e.message);
  }

  const by = new Map();
  for (const c of complaints) {
    const key = (c.components || "UNKNOWN").split(",")[0].trim();
    const e = by.get(key) || { component: key, count: 0, crashes: 0, fires: 0, injuries: 0, deaths: 0 };
    e.count++;
    if (c.crash) e.crashes++;
    if (c.fire) e.fires++;
    e.injuries += c.numberOfInjuries || 0;
    e.deaths += c.numberOfDeaths || 0;
    by.set(key, e);
  }
  const topIssues = [...by.values()]
    .map((e) => ({ ...e, severityScore: e.count + e.crashes * 5 + e.fires * 10 + e.injuries * 15 + e.deaths * 50, severe: e.fires > 0 || e.deaths > 0 }))
    .sort((a, b) => b.severityScore - a.severityScore)
    .slice(0, 6);

  return { recallCount: recalls.length, recalls: recalls.map((r) => `${r.component} — ${r.campaign}`), topIssues, totalComplaints: complaints.length };
}

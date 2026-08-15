/**
 * Known-issues module: NHTSA recalls + complaints by Year/Make/Model, severity-ranked.
 * Ported from prototypes/vehicle-health. Trusted (gov data); nothing LLM-generated.
 * Returns { recallCount, recalls:[], topIssues:[{component,count,severe,...}] }.
 */
import { readExtCache, writeExtCache } from "./extApiCache.mjs";

const NHTSA = "https://api.nhtsa.gov";

async function getJSON(url) {
  // Hard timeout — NHTSA can hang, and without a signal the whole report
  // generation stalls to the 60s Lambda ceiling (the caller try/catches, so an
  // abort just degrades this section instead of hanging the report).
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 7000);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "zoooom-vehicle-report" },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  } finally {
    clearTimeout(t);
  }
}

export async function getKnownIssues(make, model, year, cache) {
  if (!make || !model || !year) return null;
  const cacheKey = `NHTSA#${make.toLowerCase()}#${model.toLowerCase()}#${year}`;
  const m = encodeURIComponent(make.toLowerCase());
  const md = encodeURIComponent(model.toLowerCase());
  let recalls = [];
  let complaints = [];
  let liveFailed = false;
  try {
    const rd = await getJSON(`${NHTSA}/recalls/recallsByVehicle?make=${m}&model=${md}&modelYear=${year}`);
    recalls = (rd.results || []).map((x) => ({ component: x.Component, campaign: x.NHTSACampaignNumber }));
  } catch (e) {
    console.warn("⚠️ NHTSA recalls failed:", e.message);
    liveFailed = true;
  }
  try {
    const cd = await getJSON(`${NHTSA}/complaints/complaintsByVehicle?make=${m}&model=${md}&modelYear=${year}`);
    complaints = cd.results || [];
  } catch (e) {
    console.warn("⚠️ NHTSA complaints failed:", e.message);
    liveFailed = true;
  }

  // Upstream hung/errored → serve the PREVIOUS good result rather than a blank
  // known-issues section. Only cache when the live pull fully succeeded.
  if (liveFailed) {
    const prev = await readExtCache(cache, cacheKey);
    if (prev) {
      console.warn(`⚠️ NHTSA ${cacheKey} live failed — using previous cached result`);
      return prev;
    }
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

  // `campaigns` (raw NHTSA campaign numbers) is what lets the report subtract the
  // recalls the owner already checked off in the garage — those rows carry the
  // same NHTSACampaignNumber. See ownerRecalls.mjs.
  const result = {
    recallCount: recalls.length,
    recalls: recalls.map((r) => `${r.component} — ${r.campaign}`),
    campaigns: recalls.map((r) => r.campaign).filter(Boolean),
    topIssues,
    totalComplaints: complaints.length,
  };
  if (!liveFailed) await writeExtCache(cache, cacheKey, result);
  return result;
}

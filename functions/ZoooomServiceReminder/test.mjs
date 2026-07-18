/**
 * Local proof for the schedule predictor. Run: node test.mjs
 * Uses a fixed asOf so results are deterministic.
 */
import { computeSchedule, estimateMilesPerDay } from "./maintenanceSchedule.mjs";

const PRIUS = { year: "2014", make: "Toyota", model: "Prius", trim: "Two", mileage: 0 };
const asOf = "2026-07-10";
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  (cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name} ${extra}`)));
};

// ── 1. Single oil record, time axis wins (6 months before 5k miles) ──────────
console.log("\n[1] Single record — time axis wins");
{
  const recs = [{ date: "2026-01-15", mileage: 40000, serviceDetails: ["Engine oil and filter change"] }];
  const r = computeSchedule(recs, { ...PRIUS, mileage: 42000 }, { asOf });
  console.log("   next:", JSON.stringify(r.nextService, (k, v) => (k === "dueDateTime" ? undefined : v)));
  ok("oil is next service", r.nextService?.key === "oil");
  ok("due 2026-07-15 (last + 6mo)", r.nextService?.dueDate === "2026-07-15", `got ${r.nextService?.dueDate}`);
  ok("basis = time", r.nextService?.basis === "time", `got ${r.nextService?.basis}`);
  ok("dueMileage = 45000", r.nextService?.dueMileage === 45000);
  ok("within a week (daysRemaining<=7)", r.nextService?.daysRemaining <= 7 && r.nextService?.daysRemaining >= 0, `got ${r.nextService?.daysRemaining}`);
}

// ── 2. Multiple records — learn miles/day, mileage axis wins ─────────────────
console.log("\n[2] Multiple records — miles/day learned, mileage axis wins");
{
  const recs = [
    { date: "2025-07-15", mileage: 35000, serviceDetails: ["Oil & filter, tire rotation"] },
    { date: "2026-01-15", mileage: 40000, serviceDetails: ["Engine oil change", "Tire rotation", "Multi-point inspection"] },
  ];
  const mpd = estimateMilesPerDay(
    recs.map((x) => ({ date: x.date, mileage: x.mileage }))
  );
  console.log("   learned miles/day:", mpd);
  const r = computeSchedule(recs, { ...PRIUS, mileage: 44900 }, { asOf });
  console.log("   next:", JSON.stringify(r.nextService, (k, v) => (k === "dueDateTime" ? undefined : v)));
  ok("learned ~27 mi/day", mpd >= 24 && mpd <= 30, `got ${mpd}`);
  ok("oil is next service", r.nextService?.key === "oil");
  ok("basis = mileage (only 100 mi left)", r.nextService?.basis === "mileage", `got ${r.nextService?.basis}`);
  ok("within a week", r.nextService?.daysRemaining <= 7, `got ${r.nextService?.daysRemaining}`);
}

// ── 3. Recently serviced — NOT due, no reminder ──────────────────────────────
console.log("\n[3] Recently serviced — not due");
{
  const recs = [{ date: "2026-07-01", mileage: 44000, serviceDetails: ["Full synthetic oil change"] }];
  const r = computeSchedule(recs, { ...PRIUS, mileage: 44200 }, { asOf });
  console.log("   next due:", r.nextService?.dueDate, "in", r.nextService?.daysRemaining, "days");
  ok("not due within a week", r.nextService && r.nextService.daysRemaining > 7, `got ${r.nextService?.daysRemaining}`);
}

// ── 4. Only a repair on file (no oil evidence) — no false oil reminder ────────
console.log("\n[4] No matching evidence — no prediction");
{
  const recs = [{ date: "2026-02-01", mileage: 41000, serviceDetails: ["Replaced 12V battery"] }];
  const r = computeSchedule(recs, { ...PRIUS, mileage: 43000 }, { asOf });
  ok("no next service predicted", r.nextService === null, `got ${JSON.stringify(r.nextService)}`);
}

// ── 5. Dedup — same visit uploaded twice collapses ───────────────────────────
console.log("\n[5] Dedup collapses duplicate uploads");
{
  const recs = [
    { date: "2026-01-15", mileage: 40000, serviceDetails: ["Engine oil change"] },
    { date: "01/15/2026", mileage: 40000, serviceDetails: ["Engine oil change; multi-point inspection"] },
  ];
  const r = computeSchedule(recs, { ...PRIUS, mileage: 42000 }, { asOf });
  ok("2 uploads → 1 record", r.recordCount === 1, `got ${r.recordCount}`);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

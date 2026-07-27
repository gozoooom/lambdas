/**
 * Preview redaction — the "sneak peek" served to logged-out / unentitled callers.
 *
 * Matches the funnel promised on public/guides/verified-report.html:
 *   FREE PREVIEW (no account): decoded vehicle + overall score/band + per-category
 *   status colour (clear/review/caution/serious) — "enough to know if a car is
 *   worth your time".
 *   FULL REPORT (free account): the specific findings, prioritized actions, known-
 *   issue counts, title-transfer steps, walkaround condition, reminder hook.
 *
 * So preview keeps the at-a-glance signal and strips everything that IS the value:
 * the one-liner, each category's `detail`/`count`, the action list, titleTransfer,
 * and the reminder callout.
 */

const UNLOCK_CTA = {
  title: "Create a free account to unlock the full report",
  body: "See the specific findings, open recalls, known-issue details, title-transfer steps, and what to do next — free while we're in early access.",
  cta: "Create free account",
};

/**
 * @param {object} summary the full buildSummary() output
 * @param {object} [opts] { promoEndsAt }
 */
export function redactToPreview(summary, opts = {}) {
  if (!summary) return summary;
  const { oneLiner, ...headlineRest } = summary.headline || {};
  return {
    vin: summary.vin,
    vehicle: summary.vehicle,
    powertrain: summary.powertrain || null, // public vehicle spec — safe in preview
    mileage: summary.mileage,
    // Keep the bottom-line signal (status/label/score/band) — drop the specific oneLiner.
    headline: headlineRest,
    // Per-category traffic light only — strip the detail/count/flags that carry the findings.
    categories: (summary.categories || []).map((c) => ({
      key: c.key,
      label: c.label,
      status: c.status,
    })),
    // "What's included" coverage teaser is safe and sells the upgrade.
    coverage: summary.coverage || { have: [], missing: [] },
    sources: summary.sources,
    // Evidence-of-quality HOOK (benchmark): show how many datasets we checked, how
    // many records we found, and how fresh the data is — WITHOUT the findings. This
    // is the "we found N records about this car" reassurance that drives sign-up.
    evidence: summary.evidence
      ? {
          sourcesChecked: (summary.evidence.sourcesChecked || []).map((s) => ({
            name: s.name, provider: s.provider, status: s.status, lastRetrieved: s.lastRetrieved,
          })),
          sourcesCheckedCount: summary.evidence.sourcesCheckedCount,
          recordsFound: summary.evidence.recordsFound,
          dataAsOf: summary.evidence.dataAsOf,
          nextRefreshEligible: summary.evidence.nextRefreshEligible,
          accessNote: summary.evidence.accessNote,
          coverageNote: summary.evidence.coverageNote,
        }
      : null,
    generatedAt: summary.generatedAt,
    locked: true,
    unlock: { ...UNLOCK_CTA, promoEndsAt: opts.promoEndsAt || null },
  };
}

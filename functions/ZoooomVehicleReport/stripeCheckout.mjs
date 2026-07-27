/**
 * Minimal Stripe Checkout client for PAID vehicle-report packs.
 *
 * A report purchase is a plain charge TO ZOOOOM (Zoooom is the merchant) — NOT a
 * marketplace payout, so there is NO Stripe Connect / seller / onboarding here.
 * We use Stripe-hosted Checkout: the buyer taps one button and pays with Apple
 * Pay / Google Pay / Link / card; card data never touches Zoooom (Stripe PCI).
 *
 * Uses the Stripe REST API over global fetch (nodejs20) so nothing needs bundling.
 * Key resolution lives in secrets.mjs: STRIPE_SECRET_ID (Secrets Manager) with a
 * STRIPE_SECRET_KEY env fallback during migration. Same PLATFORM key as ZoooomStripeOps.
 */
import { getStripeKey, stripeAvailable } from "./secrets.mjs";

const STRIPE_API = "https://api.stripe.com/v1";

/** Encode a nested object into Stripe's form bracket notation. */
function encode(obj, prefix = "") {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        const ik = `${key}[${i}]`;
        parts.push(item && typeof item === "object" ? encode(item, ik) : `${encodeURIComponent(ik)}=${encodeURIComponent(item)}`);
      });
    } else if (typeof v === "object") {
      parts.push(encode(v, key));
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
    }
  }
  return parts.filter(Boolean).join("&");
}

export function stripeConfigured() {
  return stripeAvailable();
}

export async function createCheckoutSession(params) {
  const res = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await getStripeKey()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: encode(params),
  });
  return res.json();
}

export async function retrieveCheckoutSession(id) {
  const res = await fetch(`${STRIPE_API}/checkout/sessions/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${await getStripeKey()}` },
  });
  return res.json();
}

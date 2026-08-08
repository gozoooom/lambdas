/**
 * Shared identity helper for the Cognito-authorized mechanic routes.
 *
 * ── THE GATEWAY AND THIS FILE DO DIFFERENT HALVES OF THE JOB ─────────────────
 * The API Gateway Cognito authorizer proves the token's SIGNATURE and expiry —
 * the expensive part, and the part you cannot get right by hand. But the mechanic
 * app has a separate user pool per environment while the gateway has one
 * authorizer shared by all three stages, so the authorizer necessarily trusts all
 * three pools. Left there, a dev-pool token would authorize against the prod
 * stage.
 *
 * This closes that: it checks the token's issuer against the pool that belongs to
 * the alias the Lambda was actually invoked under. Cheap string compare, and it
 * turns "signed by someone we trust" into "signed by the right environment".
 *
 * WHY THE CLAIMS ARE TRUSTED HERE AND WERE NOT BEFORE: with the authorizer in
 * place, `requestContext.authorizer.claims` is populated by API Gateway AFTER
 * signature verification. That is a different thing from the hand-decoded JWT
 * payload the un-authorized routes still use for best-effort attribution — those
 * are unverified and must never gate access.
 */

/** Pool per environment. Mirrors NEXT_PUBLIC_AWS_USER_POOL_ID on each branch. */
export const MECHANIC_POOLS = {
  dev: "us-west-2_txbLud6fS",
  staging: "us-west-2_ApaugdMWV",
  prod: "us-west-2_Zouus0I8a",
};

export function envFromContext(context) {
  const qualifier = (context?.invokedFunctionArn || "").split(":").pop() || "";
  if (/staging/i.test(qualifier)) return "staging";
  if (/prod/i.test(qualifier)) return "prod";
  return "dev";
}

/**
 * Resolve the caller from the authorizer's verified claims.
 *
 * Returns { ok:false, reason } rather than throwing so each route decides its own
 * status code — and so a wrong-environment token produces a distinct, greppable
 * reason instead of a generic 401 nobody can diagnose.
 */
export function verifiedCaller(event, context) {
  const claims = event?.requestContext?.authorizer?.claims;

  // No claims means the authorizer did not run. That is either a misconfigured
  // route or a direct invoke — never a caller to trust.
  if (!claims?.sub) return { ok: false, reason: "no_verified_claims" };

  const env = envFromContext(context);
  const expectedPool = process.env.MECHANIC_USER_POOL_ID || MECHANIC_POOLS[env];
  const iss = String(claims.iss || "");

  // iss looks like https://cognito-idp.us-west-2.amazonaws.com/us-west-2_xxx
  if (expectedPool && !iss.endsWith(`/${expectedPool}`)) {
    return {
      ok: false,
      reason: "wrong_environment_token",
      detail: `token issued by ${iss.split("/").pop() || "unknown"}, this stage expects ${expectedPool}`,
    };
  }

  // token_use distinguishes an id token from an access token. Access tokens
  // carry no email and are issued for different audiences; accepting either
  // would make the identity fields silently absent for some callers.
  if (claims.token_use && claims.token_use !== "id") {
    return { ok: false, reason: "not_an_id_token" };
  }

  return {
    ok: true,
    userId: claims.sub,
    email: claims.email || null,
    shopName: claims["custom:shopName"] || null,
    env,
  };
}

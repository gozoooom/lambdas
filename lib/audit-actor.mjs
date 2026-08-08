/**
 * audit-actor.mjs — CANONICAL actor resolver. Copy this file into any function
 * directory that writes to an audit-scoped table; audit-coverage.sh compares the
 * copies against this original and fails on drift, so there is exactly one
 * reviewed implementation of "who is doing this".
 *
 * THE RULE: the actor comes from a VERIFIED token claim, never from the request
 * body. An actor the caller supplies is an actor the caller can choose, and an
 * audit record naming a chosen actor is not evidence — it is a rumour with a
 * timestamp. That is precisely why the previous audit design (a body-supplied
 * userId posted to ZoooomInternalUserActionAuditLog) proved nothing even before
 * anyone noticed its table was empty.
 *
 * PREREQUISITE, TODAY UNMET FOR THE INTERNAL DASHBOARD: as of 2026-07-29 all 84
 * methods on ZoooomInternalUserAPI{,Prod,Staging} are authorizationType NONE
 * with no resource policy, WAF or API key. With no authorizer there is no claim,
 * so requireActor() throws rather than degrade to the body — a write that cannot
 * be attributed should fail loudly, not record a comfortable fiction. Attach a
 * Cognito authorizer (ZoooomInternalUser pool) before adopting this in the
 * internal lambdas.
 */

/** Claims as API Gateway presents them for REST (proxy and non-proxy) + HTTP API. */
function claimsOf(event = {}) {
  const rc = event.requestContext || {};
  return (
    rc.authorizer?.claims ||           // REST + Cognito authorizer
    rc.authorizer?.jwt?.claims ||      // HTTP API JWT authorizer
    rc.authorizer ||                   // Lambda authorizer passing a flat context
    null
  );
}

/**
 * The verified actor, or null. Returns the Cognito `sub` — stable and immutable —
 * rather than email, which users can change, making historical records ambiguous
 * about which person they name.
 */
export function getActor(event = {}) {
  const c = claimsOf(event);
  if (!c) return null;
  const sub = c.sub || c["cognito:username"] || c.username;
  if (!sub || typeof sub !== "string") return null;
  return {
    actorId: sub,
    actorEmail: c.email || "",
    // Which pool issued the token tells staff actions apart from customer ones —
    // the distinction segregation-of-duties evidence is built on.
    actorPool: c.iss ? String(c.iss).split("/").pop() : "",
  };
}

/**
 * Use in any handler that mutates an audit-scoped table. Throws when the caller
 * is unauthenticated so the write never happens unattributed.
 */
export function requireActor(event = {}) {
  const a = getActor(event);
  if (!a) {
    const err = new Error("UNATTRIBUTABLE_WRITE: no verified token claim on this request — refusing to mutate an audit-scoped record");
    err.statusCode = 401;
    throw err;
  }
  return a;
}

/**
 * Attributes to merge into any create. `createdBy` is written once and must never
 * be overwritten afterwards (use stampUpdate for later writes) — an audit trail
 * whose "who created this" changes is not a trail.
 */
export function stampCreate(actor, now = new Date().toISOString()) {
  return {
    createdBy: actor.actorId,
    createdAt: now,
    updatedBy: actor.actorId,
    updatedAt: now,
  };
}

/** Attributes to merge into any update. Never touches createdBy/createdAt. */
export function stampUpdate(actor, now = new Date().toISOString()) {
  return { updatedBy: actor.actorId, updatedAt: now };
}

/**
 * UpdateExpression fragment for the same, since most handlers here build
 * expressions by hand. Callers append these to their own SET list.
 */
export function stampUpdateExpression(actor, now = new Date().toISOString()) {
  return {
    set: "updatedBy = :__ab, updatedAt = :__at",
    values: { ":__ab": actor.actorId, ":__at": now },
  };
}

/**
 * A hard delete destroys the only row that could name who deleted it, so stamp
 * the actor and let the stream carry it, THEN delete. Prefer soft-delete/archive
 * (as ZoooomDeleteVehicle does) where the data model allows it.
 */
export function stampDelete(actor, now = new Date().toISOString()) {
  return { deletedBy: actor.actorId, deletedAt: now };
}

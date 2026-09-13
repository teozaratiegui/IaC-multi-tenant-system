'use strict';

/**
 * What the system can decide about a scan, and what the caller is told.
 *
 * The status codes are constrained by the Fog gateway: it forwards only
 * {200, 201, 204, 404, 422, 500, 503} to the node and collapses everything else
 * to `503 upstream_error`
 * (thesis-sketch/src/core/use_cases/relay_tag_read.py:15,137-164).
 *
 * So the outcomes a reader has to tell apart use codes that survive the trip:
 * ALLOW is 200 and DENY is 422 ("tag disabled" in the node manual). A 403 would
 * reach the reader as "the backend broke", indistinguishable from an outage.
 *
 * DENY is one decision, not two. The deployed code answered 403 when the owner
 * was reachable and 422 when they were not; for the reader those are the same
 * fact — the tag is blocked, the door stays shut — and whether anyone could be
 * notified is a backoffice configuration matter. It also could not survive the
 * gateway cache: it keys (status, body) by tag for 300 s, so binding a chat
 * afterwards would not invalidate a status that had depended on the channel.
 * Whether the alert went out is recorded on the event row instead.
 *
 * 400 and 401 are outside the decision map on purpose. They mean the caller is
 * misconfigured, never that a particular badge was refused.
 *
 * There is no 403 anywhere in this table, and a test enforces that. The one 403
 * this package can emit is Meta's webhook-verification rejection, which is a
 * literal in the WhatsApp adapter: it answers the provider during a handshake
 * and never reaches a reader.
 */

const DECISION = {
  ALLOW: 'ALLOW',
  DENY: 'DENY',
  UNKNOWN: 'UNKNOWN',
  REGISTERED: 'REGISTERED',
};

const STATUS = {
  OK: 200,
  CREATED: 201,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  DENIED: 422,
  INTERNAL_ERROR: 500,
};

/** Statuses the gateway forwards to the node untouched (it normalises 201 to 200). */
const NODE_VISIBLE_STATUSES = new Set([200, 201, 204, 404, 422, 500, 503]);

const STATUS_BY_DECISION = {
  [DECISION.ALLOW]: STATUS.OK,
  [DECISION.REGISTERED]: STATUS.CREATED,
  [DECISION.DENY]: STATUS.DENIED,
  [DECISION.UNKNOWN]: STATUS.NOT_FOUND,
};

/**
 * The single place a decision becomes a status.
 *
 * It throws on an unknown decision rather than defaulting, because the failure
 * this guards against is a new decision quietly inheriting 200.
 */
function statusForDecision(decision) {
  const status = STATUS_BY_DECISION[decision];
  if (status === undefined) throw new Error(`No status mapped for decision: ${decision}`);
  return status;
}

module.exports = { DECISION, STATUS, NODE_VISIBLE_STATUSES, statusForDecision };

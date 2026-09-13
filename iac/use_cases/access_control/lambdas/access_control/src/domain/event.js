'use strict';

const { randomUUID } = require('node:crypto');

/**
 * What a valid tag id is, and how one scan is identified.
 *
 * This lives apart from the repository on purpose. The repository speaks
 * DynamoDB; these are the concepts the use case reasons about, and it should
 * not have to import its persistence adapter to name them. What the system can
 * *decide* about a scan is domain/decisions.js.
 */

/**
 * Longest tag id accepted. An EPC-96 is 24 hex characters; the margin is for
 * EPC-198 and for the gateway's own identifiers. The cap matters because the
 * Function URL is public and the tag becomes a DynamoDB partition key: without
 * it, anyone can write 2 KB partitions into the events table.
 */
const MAX_TAG_LENGTH = 64;

/**
 * Turns whatever arrived in the request body into a tag id, or explains why it
 * is not one.
 *
 * `String(value)` on its own is not validation: it happily turns `{"a":1}` into
 * the tag `"[object Object]"` and `["x"]` into `"x"`, and both become real rows
 * in the events table.
 *
 * @returns {{ok: true, value: string} | {ok: false, reason: string}}
 */
function normaliseTag(value) {
  if (typeof value !== 'string') {
    return { ok: false, reason: 'Field `tag` must be a string' };
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return { ok: false, reason: 'Field `tag` must not be empty' };
  }
  if (trimmed.length > MAX_TAG_LENGTH) {
    return { ok: false, reason: `Field \`tag\` must be at most ${MAX_TAG_LENGTH} characters` };
  }
  return { ok: true, value: trimmed };
}

/** Zero-pads an epoch so lexicographic order on the sort key is chronological. */
function padMillis(epochMs) {
  return String(epochMs).padStart(13, '0');
}

/**
 * Builds the sort key for one event: `<13-digit epoch ms>#<discriminator>`.
 *
 * The gateway retries a failed POST up to four times without an idempotency key
 * of any kind (thesis-sketch/src/infrastructure/aws/aws_client.py:36-42), so the
 * same physical scan can arrive several times. Three strategies, in order:
 *
 *   1. the caller supplied a key — the retries then collapse onto one row;
 *   2. a dedup window is configured — all events for a tag inside the same
 *      window share an id. Note this only ever collapses a *fast* retry: an
 *      attempt that times out is already 5 s later (the gateway's timeout), so
 *      it lands in the next bucket. See the timeout note in main.tf;
 *   3. neither — a random discriminator, which is what today's traffic gets.
 *      Retries then still produce separate rows; the real fix belongs in the
 *      gateway (finding G3).
 *
 * Every branch keeps the `<13 digits>#...` shape. It used to return `w<bucket>`
 * for the window branch, which sorts *after* every timestamp key ('w' > '9'):
 * turning the window on split the table into two key spaces and a chronological
 * range query over a tag silently skipped one of them.
 */
function buildEventId({ epochMs, idempotencyKey, dedupWindowMs }) {
  if (idempotencyKey) return `${padMillis(epochMs)}#${idempotencyKey}`;
  if (dedupWindowMs > 0) {
    const bucketStart = Math.floor(epochMs / dedupWindowMs) * dedupWindowMs;
    return `${padMillis(bucketStart)}#w`;
  }
  return `${padMillis(epochMs)}#${randomUUID()}`;
}

module.exports = { MAX_TAG_LENGTH, normaliseTag, padMillis, buildEventId };

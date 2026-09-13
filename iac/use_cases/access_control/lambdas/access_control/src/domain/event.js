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
 * same physical scan can arrive several times. Two cases:
 *
 *   1. the caller supplied a key — the retries collapse onto one row, and the
 *      conditional write in the repository is what makes that stick;
 *   2. it did not — a random discriminator, which is what today's traffic gets.
 *      Retries then produce separate rows; the real fix is for the gateway to
 *      send a key (finding G3), and nothing here can substitute for it.
 *
 * There used to be a third branch: a time-bucketed id, so every scan of one tag
 * inside a configured window shared a key. It is gone. No Terraform variable
 * ever set `EVENT_DEDUP_WINDOW_MS`, so in every possible deployment the window
 * was 0 and the branch unreachable — and it could not have been turned on
 * safely anyway: it collapses a genuine second read exactly as readily as a
 * retried one, and the retry it was meant to catch arrives 5 s later (the
 * gateway's own timeout), which is past any window short enough to be safe.
 *
 * Both remaining branches keep the `<13 digits>#...` shape, so lexicographic
 * order on the sort key stays chronological.
 */
function buildEventId({ epochMs, idempotencyKey }) {
  if (idempotencyKey) return `${padMillis(epochMs)}#${idempotencyKey}`;
  return `${padMillis(epochMs)}#${randomUUID()}`;
}

module.exports = { MAX_TAG_LENGTH, normaliseTag, padMillis, buildEventId };

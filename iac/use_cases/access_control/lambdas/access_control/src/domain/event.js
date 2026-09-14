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
 * Longest event id accepted, and it exists for the same reason MAX_TAG_LENGTH
 * does. The id becomes the *sort* key of the events table, DynamoDB caps a sort
 * key at 1024 bytes, and the Function URL is public. 128 characters hold
 * `<13 digits>#<uuid>` (50) twice over and stay under the byte cap even if every
 * character is multi-byte. Past the cap DynamoDB answers `ValidationException`,
 * which a handler can only turn into a 500: the caller's mistake reported as
 * ours, with four gateway retries spent on it.
 */
const MAX_EVENT_ID_LENGTH = 128;

/**
 * Longest optional traceability field accepted (`nodeId`, the reader's own
 * `timestamp`). These are plain attributes and not keys, so the cap is only
 * about not letting a public endpoint write arbitrary bulk into a row:
 * `node-<8hex>` is 13 characters and an ISO-8601 instant is 24, so 64 is already
 * generous.
 */
const MAX_TRACE_FIELD_LENGTH = 64;

/**
 * An event id that is safe to range-query: a 13-digit epoch, then anything.
 *
 * It is a shape, not a formality. The sort key is compared lexicographically,
 * so only a fixed-width numeric prefix makes `eventId BETWEEN :a AND :b` mean
 * "between these two instants".
 */
const ORDERED_EVENT_ID = /^(\d{13})#.+$/;

/**
 * Bounds on any epoch that reached us from outside, because it decides where
 * the row sorts. The floor is the firmware's own sanity check for "NTP has
 * answered" (2021-01-01, src/net/connectivity.cpp); the ceiling allows a reader
 * whose clock runs ahead, and rejects the ones that think it is 2106.
 *
 * An epoch arrives two ways and both go through here: the `timestamp` field
 * (`parseEventEpochMs`) and the 13-digit prefix of a caller-supplied event id
 * (`normaliseEventId`). Bounding only the first was a hole, not a subtlety — a
 * reader with no clock that builds its id out of `millis()` sends
 * `0000000006123#…`, is taken verbatim, and files every scan at the start of its
 * tag's history: precisely the outcome the floor exists to prevent, reached by a
 * shorter path and with a 200 in reply.
 */
const SANE_EPOCH_MS = 1609459200000;
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

/** Whether an epoch from outside can be trusted to place an event in time. */
function isSaneEpochMs(epochMs, serverEpochMs) {
  return epochMs >= SANE_EPOCH_MS && epochMs <= serverEpochMs + MAX_CLOCK_SKEW_MS;
}

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

/**
 * Turns whatever arrived as `eventId` (or in the `Idempotency-Key` header) into
 * an idempotency key, into "the caller sent none", or into a reason to answer
 * 400. It is the counterpart of `normaliseTag`, and it exists because the two
 * fields become the two halves of the events table's primary key.
 *
 * Three checks, each one a failure mode that was reachable:
 *
 *   - **type**, because `String(value)` is not validation — the same trap
 *     `normaliseTag` names: `{"a":1}` becomes the sort key `"[object Object]"`
 *     and `["x"]` becomes `"x"`, and both are written as real rows;
 *   - **length**, because the id is the sort key and DynamoDB caps that at
 *     1024 bytes; past it the write throws and the answer is a 500;
 *   - **the epoch prefix**, when the id has one, against the same bounds as the
 *     reader's own clock. `buildEventId` takes such an id verbatim precisely
 *     because the caller owns both halves, so this is the only place its epoch
 *     half can be questioned at all.
 *
 * A blank key means no key: the id is then random *and* ordered, which is
 * strictly better than a sort key made of spaces.
 *
 * @returns {{ok: true, value: string|undefined} | {ok: false, reason: string}}
 */
function normaliseEventId(value, serverEpochMs) {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== 'string') {
    return { ok: false, reason: 'Field `eventId` must be a string' };
  }
  const trimmed = value.trim();
  if (trimmed === '') return { ok: true, value: undefined };
  if (trimmed.length > MAX_EVENT_ID_LENGTH) {
    return {
      ok: false,
      reason: `Field \`eventId\` must be at most ${MAX_EVENT_ID_LENGTH} characters`,
    };
  }
  const prefixMs = orderedPrefixMs(trimmed);
  if (prefixMs !== null && !isSaneEpochMs(prefixMs, serverEpochMs)) {
    return {
      ok: false,
      reason: 'Field `eventId` must begin with a plausible epoch in milliseconds',
    };
  }
  return { ok: true, value: trimmed };
}

/**
 * Turns an optional traceability field into a string, into "absent", or into a
 * reason to answer 400.
 *
 * The check exists because of what happens without it, which is not what one
 * would guess. These fields reach DynamoDB as `{ S: value }`
 * (adapters/dynamo/event-repository.js), and the AWS SDK does not refuse a
 * non-string there — it **coerces it to the empty string**. Verified by
 * inspecting the serialised request: `nodeId: 5` and `nodeId: {a: 1}` both go on
 * the wire as `"nodeId":{"S":""}`, DynamoDB accepts an empty non-key attribute,
 * and the row is written. So a caller that serialises its node id as a number
 * gets a 200 and an event that says a reader with no name saw the tag — the one
 * field the row exists for, blanked, with nothing anywhere reporting it. That is
 * the same shape of defect as `Boolean("false")` in provision-tag: a coercion
 * that succeeds at being wrong.
 *
 * Absent is fine — the field is optional and the gateway sends neither today.
 * *Present and not a string* is the caller being misconfigured, which is exactly
 * what this system reserves 400 for, and a 400 says so at the first scan instead
 * of leaving a history of nameless events to be discovered later.
 *
 * @returns {{ok: true, value: string|undefined} | {ok: false, reason: string}}
 */
function normaliseTraceField(value, field) {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== 'string') {
    return { ok: false, reason: `Field \`${field}\` must be a string` };
  }
  const trimmed = value.trim();
  if (trimmed === '') return { ok: true, value: undefined };
  if (trimmed.length > MAX_TRACE_FIELD_LENGTH) {
    return {
      ok: false,
      reason: `Field \`${field}\` must be at most ${MAX_TRACE_FIELD_LENGTH} characters`,
    };
  }
  return { ok: true, value: trimmed };
}

/** Zero-pads an epoch so lexicographic order on the sort key is chronological. */
function padMillis(epochMs) {
  return String(epochMs).padStart(13, '0');
}

/** True when this id can be used as a bound in a range query over one tag. */
function isOrderedEventId(eventId) {
  return ORDERED_EVENT_ID.test(String(eventId ?? ''));
}

/** The instant such an id sorts at, or null when it carries no epoch prefix. */
function orderedPrefixMs(eventId) {
  const match = ORDERED_EVENT_ID.exec(String(eventId ?? ''));
  return match ? Number(match[1]) : null;
}

/**
 * The reader's own clock, as epoch milliseconds, when it can be trusted.
 *
 * Trusted means: parseable, after 2021, and not more than a day ahead of this
 * server. A value outside that range is not corrected, it is ignored — a reader
 * that thinks it is 1970 would otherwise file every event at the very start of
 * its tag's history, which is worse than filing it at the time we received it.
 *
 * @returns {number|null}
 */
function parseEventEpochMs(clientTimestamp, serverEpochMs) {
  if (typeof clientTimestamp !== 'string' || clientTimestamp.trim() === '') return null;
  const parsed = Date.parse(clientTimestamp);
  if (Number.isNaN(parsed)) return null;
  if (!isSaneEpochMs(parsed, serverEpochMs)) return null;
  return parsed;
}

/**
 * Builds the sort key for one event.
 *
 * Two properties are wanted and they pull against each other: the id has to
 * sort chronologically (so `eventId BETWEEN` answers "this tag, between these
 * instants" without a Scan), and it has to be *the same value on a retry* (so
 * the conditional write in the repository collapses duplicates).
 *
 * The version this replaces only had the first. It prefixed the caller's key
 * with `epochMs` — the moment *this invocation* started — so the same
 * Idempotency-Key arriving 600 ms later produced a different sort key and a
 * second row. An idempotency key whose value depends on when it is received is
 * not an idempotency key; it is decoration. Nothing deduplicated, and the
 * unit test did not catch it because it froze the clock.
 *
 * So the epoch half has to come from the event, never from its arrival:
 *
 *   1. the caller supplied a whole event id, already `<13 digits>#<...>` — use
 *      it verbatim. Ordered and deterministic, and the caller owns both halves.
 *      `normaliseEventId` has already held that epoch prefix to the same bounds
 *      as a reader's clock: unchecked, this branch was the way around the very
 *      floor `parseEventEpochMs` enforces;
 *   2. the caller supplied a key plus a usable reader timestamp — prefix with
 *      the reader's clock. Ordered and deterministic;
 *   3. the caller supplied a key and nothing else — the key alone. Deterministic
 *      but unordered: the row is still written, still carries `eventTime` and
 *      `eventTimeIso`, and is still found by a plain query over its tag; it just
 *      falls outside a `BETWEEN` window. Determinism is what gets kept here
 *      because duplicates are unrecoverable and sort position is not — but the
 *      price is that the key has to be unique for the life of the tag and not
 *      merely per attempt. With no epoch of its own, a token that repeats — a
 *      per-node counter that restarts after a reboot, and the firmware's
 *      counters live in RAM — collapses a genuine later scan onto the older row,
 *      permanently, behind a success status. The use case says both out loud;
 *   4. no key at all — a random discriminator, which is what the Fog gateway's
 *      traffic gets today. Its retries do produce separate rows, and nothing
 *      here can substitute for the gateway sending a key (finding G3).
 *
 * There used to be a further branch: a time-bucketed id, so every scan of one
 * tag inside a configured window shared a key. It is gone. No Terraform
 * variable ever set `EVENT_DEDUP_WINDOW_MS`, so in every possible deployment
 * the window was 0 and the branch unreachable — and it could not have been
 * turned on safely anyway: it collapses a genuine second read exactly as
 * readily as a retried one.
 */
function buildEventId({ epochMs, clientEpochMs, idempotencyKey }) {
  if (!idempotencyKey) return `${padMillis(epochMs)}#${randomUUID()}`;
  if (isOrderedEventId(idempotencyKey)) return idempotencyKey;
  if (clientEpochMs !== null && clientEpochMs !== undefined) {
    return `${padMillis(clientEpochMs)}#${idempotencyKey}`;
  }
  return String(idempotencyKey);
}

module.exports = {
  MAX_TAG_LENGTH,
  MAX_EVENT_ID_LENGTH,
  MAX_TRACE_FIELD_LENGTH,
  SANE_EPOCH_MS,
  MAX_CLOCK_SKEW_MS,
  isSaneEpochMs,
  normaliseTag,
  normaliseEventId,
  normaliseTraceField,
  padMillis,
  isOrderedEventId,
  orderedPrefixMs,
  parseEventEpochMs,
  buildEventId,
};

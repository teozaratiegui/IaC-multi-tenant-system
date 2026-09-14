'use strict';

const {
  normaliseTag,
  normaliseEventId,
  normaliseTraceField,
  buildEventId,
  padMillis,
  isOrderedEventId,
  orderedPrefixMs,
  parseEventEpochMs,
  MAX_TAG_LENGTH,
  MAX_EVENT_ID_LENGTH,
  MAX_TRACE_FIELD_LENGTH,
} = require('./event');

describe('normaliseTag', () => {
  test('accepts a plain EPC and trims it', () => {
    expect(normaliseTag('  E280A1B2  ')).toEqual({ ok: true, value: 'E280A1B2' });
  });

  test('refuses anything that is not a string', () => {
    // `String(value)` on its own turns {"a":1} into the tag "[object Object]"
    // and ["x"] into "x", and both become real rows in the events table.
    for (const value of [{ a: 1 }, ['x'], 42, null, undefined, true]) {
      expect(normaliseTag(value).ok).toBe(false);
    }
  });

  test('refuses an empty or blank tag', () => {
    expect(normaliseTag('').ok).toBe(false);
    expect(normaliseTag('   ').ok).toBe(false);
  });

  test('caps the length, because the tag becomes a public partition key', () => {
    expect(normaliseTag('a'.repeat(MAX_TAG_LENGTH)).ok).toBe(true);
    expect(normaliseTag('a'.repeat(MAX_TAG_LENGTH + 1)).ok).toBe(false);
  });
});

describe('buildEventId', () => {
  // Two invocations of one physical scan: the gateway's POST, and the retry its
  // Retry(total=3) fires ~5.6 s later when the first one timed out.
  const ARRIVED = Date.parse('2026-09-13T12:00:03.250Z');
  const RETRIED = Date.parse('2026-09-13T12:00:08.900Z');

  test('an epoch is padded to 13 digits so sort order stays chronological', () => {
    expect(padMillis(1758000000000)).toBe('1758000000000');
    expect(padMillis(42)).toBe('0000000000042');
    expect(padMillis(999) < padMillis(1000)).toBe(true);
  });

  test('the same key yields the same id however late the retry arrives', () => {
    // The regression. The previous version prefixed the caller's key with the
    // moment *this invocation* started, so the same Idempotency-Key arriving
    // 5.6 s later produced a different sort key and a second row. Nothing
    // deduplicated, and the use-case test did not catch it because it froze the
    // clock: with a fixed `now`, a broken id and a correct one look identical.
    const first = buildEventId({ epochMs: ARRIVED, idempotencyKey: 'scan-7' });
    const retry = buildEventId({ epochMs: RETRIED, idempotencyKey: 'scan-7' });
    expect(retry).toBe(first);
  });

  test("the reader's own clock puts that id back in chronological order", () => {
    const clientEpochMs = Date.parse('2026-09-13T12:00:02Z');
    const idAt = (epochMs) => buildEventId({ epochMs, clientEpochMs, idempotencyKey: 'scan-7' });

    expect(idAt(RETRIED)).toBe(idAt(ARRIVED));
    expect(idAt(ARRIVED)).toBe(`${padMillis(clientEpochMs)}#scan-7`);
    expect(isOrderedEventId(idAt(ARRIVED))).toBe(true);
  });

  test('a caller-supplied whole event id is used verbatim', () => {
    // The caller owns both halves, so neither clock here may touch it.
    const given = '1789300802000#node-ab12cd34-41';
    expect(buildEventId({ epochMs: ARRIVED, idempotencyKey: given })).toBe(given);
    expect(buildEventId({ epochMs: RETRIED, idempotencyKey: given })).toBe(given);
    expect(
      buildEventId({ epochMs: RETRIED, clientEpochMs: Date.parse('2020-01-01'), idempotencyKey: given }),
    ).toBe(given);
  });

  test('a key with no usable reader clock is kept as is: deterministic, unordered', () => {
    // The deliberate trade. Duplicates are unrecoverable; sort position is not
    // — the row still carries eventTime and is still found by a plain query
    // over its tag. The use case warns when this branch is taken.
    const id = buildEventId({ epochMs: ARRIVED, idempotencyKey: 'scan-7' });
    expect(id).toBe('scan-7');
    expect(isOrderedEventId(id)).toBe(false);
  });

  test('an out-of-range reader clock is ignored rather than trusted', () => {
    // parseEventEpochMs is what rejects it; this asserts the two are wired so a
    // bogus clock cannot file events at the start of a tag's history.
    const clientEpochMs = parseEventEpochMs('1999-01-01T00:00:00Z', ARRIVED);
    expect(clientEpochMs).toBeNull();
    expect(buildEventId({ epochMs: ARRIVED, clientEpochMs, idempotencyKey: 'scan-7' })).toBe('scan-7');
  });

  test('without a key two calls at the same instant get different ids', () => {
    // This is what the Fog gateway's traffic gets today: it sends no key at all,
    // so its retries still produce separate rows. Nothing here can substitute
    // for the gateway sending one (finding G3).
    const args = { epochMs: ARRIVED };
    expect(buildEventId(args)).not.toBe(buildEventId(args));
    expect(isOrderedEventId(buildEventId(args))).toBe(true);
  });

  test('an unknown option is ignored, not honoured', () => {
    // The time-bucketing branch is gone — no Terraform variable ever set it, so
    // it was unreachable in every deployment. A leftover caller passing the old
    // option must get today's behaviour, not a silently different key space.
    const a = buildEventId({ epochMs: 1758000000000, dedupWindowMs: 10000 });
    const b = buildEventId({ epochMs: 1758000000000, dedupWindowMs: 10000 });
    expect(a).not.toBe(b);
    expect(a).toMatch(/^1758000000000#/);
  });
});

describe('isOrderedEventId', () => {
  test('only a 13-digit prefix makes a `BETWEEN` window mean anything', () => {
    expect(isOrderedEventId('1789300802000#scan-7')).toBe(true);
    expect(isOrderedEventId('scan-7')).toBe(false);
    expect(isOrderedEventId('178930080200#x')).toBe(false); // 12 digits
    expect(isOrderedEventId('1789300802000#')).toBe(false); // no discriminator
    expect(isOrderedEventId(undefined)).toBe(false);
  });
});

describe('parseEventEpochMs', () => {
  const SERVER = Date.parse('2026-09-13T12:00:03.250Z');

  test('accepts the ISO-8601 UTC timestamp the firmware sends', () => {
    // Exactly the shape of net::isoTimestamp() — seconds, Z, no milliseconds.
    expect(parseEventEpochMs('2026-09-13T12:00:02Z', SERVER)).toBe(
      Date.parse('2026-09-13T12:00:02Z'),
    );
  });

  test('ignores a clock that never synced', () => {
    // The firmware omits `ts` while NTP has not answered, but a third party
    // filing 1970 would put every one of its events at the start of the tag's
    // history and stay there.
    expect(parseEventEpochMs('1970-01-02T00:00:00Z', SERVER)).toBeNull();
    expect(parseEventEpochMs('2020-12-31T23:59:59Z', SERVER)).toBeNull();
  });

  test('ignores a clock running more than a day ahead of this server', () => {
    expect(parseEventEpochMs('2026-09-14T13:00:03Z', SERVER)).toBeNull();
    expect(parseEventEpochMs('2026-09-13T13:00:03Z', SERVER)).not.toBeNull();
  });

  test('ignores anything absent or unparseable', () => {
    for (const value of [undefined, null, '', '   ', 'ayer', 42, {}]) {
      expect(parseEventEpochMs(value, SERVER)).toBeNull();
    }
  });
});

describe('orderedPrefixMs', () => {
  test('reads the instant an ordered id sorts at', () => {
    expect(orderedPrefixMs('1789300802000#scan-7')).toBe(1789300802000);
    // Zero-padding is the point of the shape, so it has to survive the read.
    expect(orderedPrefixMs('0000000006123#x')).toBe(6123);
  });

  test('an id with no epoch prefix has no instant to read', () => {
    expect(orderedPrefixMs('scan-7')).toBeNull();
    expect(orderedPrefixMs('178930080200#x')).toBeNull(); // 12 digits
    expect(orderedPrefixMs(undefined)).toBeNull();
  });
});

describe('normaliseEventId', () => {
  const SERVER = Date.parse('2026-09-13T12:00:03.250Z');
  const ok = (value) => normaliseEventId(value, SERVER);

  test('accepts the shape the contract asks callers for', () => {
    expect(ok('1789300802000#n7-41')).toEqual({ ok: true, value: '1789300802000#n7-41' });
  });

  test('accepts an opaque token, which is the canonical idempotency key', () => {
    expect(ok('  550e8400-e29b-41d4-a716-446655440000  ')).toEqual({
      ok: true,
      value: '550e8400-e29b-41d4-a716-446655440000',
    });
  });

  test('no key, or a blank one, means the caller sent none', () => {
    // Not an error: the id is then random *and* ordered, which beats a sort key
    // made of spaces — which is what a bare `String()` produced.
    for (const value of [undefined, null, '', '   ']) {
      expect(ok(value)).toEqual({ ok: true, value: undefined });
    }
  });

  test('an epoch prefix outside the trusted window is refused, not honoured', () => {
    // The regression. `buildEventId` takes an ordered id verbatim, so this was
    // the way around the very floor `parseEventEpochMs` enforces: a reader with
    // no clock sends `0000000006123#…` built from millis() and files every scan
    // at the start of its tag's history, with a 200 in reply.
    for (const id of ['0000000000000#x', '0000000006123#x', '9999999999999#x']) {
      expect(ok(id).ok).toBe(false);
      expect(ok(id).reason).toMatch(/plausible epoch/);
    }
  });

  test('the same window as the reader\'s own clock, not a second opinion', () => {
    const iso = (ms) => `${padMillis(ms)}#x`;
    expect(ok(iso(Date.parse('2021-01-01T00:00:00Z'))).ok).toBe(true);
    expect(ok(iso(Date.parse('2020-12-31T23:59:59Z'))).ok).toBe(false);
    expect(ok(iso(SERVER + 24 * 60 * 60 * 1000)).ok).toBe(true);
    expect(ok(iso(SERVER + 24 * 60 * 60 * 1000 + 1)).ok).toBe(false);
  });

  test('a non-string is refused rather than coerced into a sort key', () => {
    // The trap normaliseTag names, on the other half of the primary key:
    // `String({a: 1})` is the real sort key `"[object Object]"`, and `['x']`
    // quietly becomes `'x'`.
    for (const value of [{ a: 1 }, ['x'], 12345, true]) {
      expect(ok(value)).toEqual({ ok: false, reason: 'Field `eventId` must be a string' });
    }
  });

  test('a key too long for a sort key is a 400 here, not a 500 from DynamoDB', () => {
    // DynamoDB caps a sort key at 1024 bytes; past it PutItem throws
    // ValidationException, which a handler can only report as its own failure.
    expect(ok('x'.repeat(MAX_EVENT_ID_LENGTH)).ok).toBe(true);
    const tooLong = ok('x'.repeat(MAX_EVENT_ID_LENGTH + 1));
    expect(tooLong.ok).toBe(false);
    expect(tooLong.reason).toContain(String(MAX_EVENT_ID_LENGTH));
  });
});

describe('normaliseTraceField', () => {
  test('accepts what the firmware actually sends', () => {
    expect(normaliseTraceField('node-ab12cd34', 'nodeId')).toEqual({
      ok: true,
      value: 'node-ab12cd34',
    });
    expect(normaliseTraceField(' 2026-09-13T12:00:02Z ', 'timestamp')).toEqual({
      ok: true,
      value: '2026-09-13T12:00:02Z',
    });
  });

  test('absent or blank is absent, because the field is optional', () => {
    for (const value of [undefined, null, '', '   ']) {
      expect(normaliseTraceField(value, 'nodeId')).toEqual({ ok: true, value: undefined });
    }
  });

  test('a non-string is refused rather than blanked by the SDK', () => {
    // The regression, and it is not the failure one would guess. The AWS SDK
    // does not reject a non-string in `{ S: value }` — it coerces it to the
    // empty string, so `nodeId: 5` went on the wire as `"nodeId":{"S":""}`,
    // DynamoDB accepted it, and the caller got a 200 plus an event saying a
    // reader with no name saw the tag.
    for (const value of [5, { a: 1 }, ['x'], true]) {
      expect(normaliseTraceField(value, 'nodeId')).toEqual({
        ok: false,
        reason: 'Field `nodeId` must be a string',
      });
    }
  });

  test('the reason names the field it is about', () => {
    // One function serves both, so the message has to come from the caller or
    // a bad `timestamp` would be reported as a bad `nodeId`.
    expect(normaliseTraceField(5, 'timestamp').reason).toBe('Field `timestamp` must be a string');
  });

  test('bulk is capped, since the endpoint is public', () => {
    expect(normaliseTraceField('x'.repeat(MAX_TRACE_FIELD_LENGTH), 'nodeId').ok).toBe(true);
    expect(normaliseTraceField('x'.repeat(MAX_TRACE_FIELD_LENGTH + 1), 'nodeId')).toEqual({
      ok: false,
      reason: `Field \`nodeId\` must be at most ${MAX_TRACE_FIELD_LENGTH} characters`,
    });
  });
});

'use strict';

const { normaliseTag, buildEventId, padMillis, MAX_TAG_LENGTH } = require('./event');

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
  test('an epoch is padded to 13 digits so sort order stays chronological', () => {
    expect(padMillis(1758000000000)).toBe('1758000000000');
    expect(padMillis(42)).toBe('0000000000042');
    expect(padMillis(999) < padMillis(1000)).toBe(true);
  });

  test('a caller-supplied key makes the id deterministic', () => {
    const args = { epochMs: 1758000000000, idempotencyKey: 'scan-7' };
    expect(buildEventId(args)).toBe(buildEventId(args));
    expect(buildEventId(args)).toContain('scan-7');
  });

  test('without a key two calls at the same instant get different ids', () => {
    // This is today's behaviour and it is why a gateway retry still duplicates:
    // the fix has to come from the gateway sending a key (finding G3).
    const args = { epochMs: 1758000000000 };
    expect(buildEventId(args)).not.toBe(buildEventId(args));
  });

  test('both branches keep the 13-digit-then-hash shape', () => {
    // Which is what makes a range query over one tag chronological: the sort key
    // is compared lexicographically, so the epoch half has to be fixed-width.
    const shape = /^\d{13}#.+$/;
    expect(buildEventId({ epochMs: 1758000000000 })).toMatch(shape);
    expect(buildEventId({ epochMs: 1758000000000, idempotencyKey: 'k' })).toMatch(shape);
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

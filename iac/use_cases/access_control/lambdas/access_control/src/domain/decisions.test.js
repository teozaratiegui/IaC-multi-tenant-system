'use strict';

const {
  DECISION,
  STATUS,
  NODE_VISIBLE_STATUSES,
  statusForDecision,
} = require('./decisions');

describe('status codes', () => {
  test('denial is 422, because 403 does not survive the relay', () => {
    // The gateway collapses anything outside NODE_VISIBLE_STATUSES to
    // `503 upstream_error` (relay_tag_read.py:137-164), and the node could then
    // not tell a refused badge from a broken backend.
    expect(STATUS.DENIED).toBe(422);
    expect(NODE_VISIBLE_STATUSES.has(403)).toBe(false);
  });

  test('no path anywhere in the use case answers 403', () => {
    expect(Object.values(STATUS)).not.toContain(403);
  });

  test('every business outcome survives the gateway relay', () => {
    for (const status of [STATUS.OK, STATUS.CREATED, STATUS.DENIED, STATUS.NOT_FOUND]) {
      expect(NODE_VISIBLE_STATUSES.has(status)).toBe(true);
    }
  });
});

describe('statusForDecision', () => {
  test('maps each decision to the status the node sees', () => {
    expect(statusForDecision(DECISION.ALLOW)).toBe(200);
    expect(statusForDecision(DECISION.REGISTERED)).toBe(201);
    expect(statusForDecision(DECISION.DENY)).toBe(422);
    expect(statusForDecision(DECISION.UNKNOWN)).toBe(404);
  });

  test('every decision maps to a status the gateway forwards', () => {
    // This is the single place the mapping lives, so this test is what keeps
    // the 403/422 asymmetry from creeping back in during a refactor.
    for (const decision of Object.values(DECISION)) {
      expect(NODE_VISIBLE_STATUSES.has(statusForDecision(decision))).toBe(true);
    }
  });

  test('an unmapped decision is a programming error, not a silent 200', () => {
    expect(() => statusForDecision('MAYBE')).toThrow();
  });
});

describe('DENY is one situation, not two', () => {
  test('being notifiable is not part of the decision', () => {
    // The rescued code answered 403 with a chat id and 422 without one. For the
    // reader they are the same fact — the tag is blocked — and the gateway
    // caches (status, body) per tag for 300 s, so an `associate` afterwards
    // would not invalidate a status that depended on the channel.
    expect(statusForDecision(DECISION.DENY)).toBe(statusForDecision(DECISION.DENY));
    expect(DECISION.DENY_NO_CHANNEL).toBeUndefined();
  });
});

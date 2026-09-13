'use strict';

const { timingSafeEqual } = require('node:crypto');

/**
 * API key check.
 *
 * The key lives in SSM Parameter Store (Standard tier, free) and is read
 * through the shared parameter reader, which is what caches and expires it.
 *
 * The same key guards tag-scan and associate-tag. That is a deliberate,
 * documented limit rather than an oversight: a separate administration
 * credential was evaluated and dropped as over-engineering at this scale. Its
 * consequence is that a compromised gateway can also provision and bind tags —
 * see the README, "Límites conocidos".
 */
class ApiKeyVerifier {
  constructor(parameterReader, parameterName) {
    this.reader = parameterReader;
    this.parameterName = parameterName;
  }

  async matches(received) {
    const expected = await this.reader.get(this.parameterName);
    return constantTimeEquals(received, expected);
  }
}

/** Comparison whose duration does not depend on how many characters matched. */
function constantTimeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length === 0 || b.length === 0) return false;

  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, which would leak the length.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

module.exports = { ApiKeyVerifier, constantTimeEquals };

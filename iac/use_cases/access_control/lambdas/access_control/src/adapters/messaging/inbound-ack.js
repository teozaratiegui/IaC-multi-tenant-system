'use strict';

/**
 * The HTTP answer every inbound adapter gives once a command has been accepted.
 *
 * Always 200, whatever the command did. A non-2xx makes the provider redeliver
 * the same update — indefinitely, and for a command that may already have taken
 * effect. What went wrong goes in the body and in the log instead.
 *
 * It lives here rather than in `platform/http.js` because `success` and
 * `errorMessage` are the messaging port's vocabulary, not HTTP's — and here
 * rather than in either provider directory because the rule is the same for
 * both, and it was previously copied into each byte for byte.
 *
 * @param {{success: boolean, errorMessage?: string}} result
 * @returns {import('./ports').HttpResponse}
 */
function acknowledge(result) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: Boolean(result?.success), error: result?.errorMessage ?? null }),
  };
}

module.exports = { acknowledge };

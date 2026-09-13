'use strict';

/**
 * A POST to a messaging provider, on a budget.
 *
 * The function has 4 s and the gateway gives up at 5 s (CONTRACT.md §6). A
 * provider that accepts the connection and never answers would eat the whole
 * budget *after the event row is already written*, so the gateway would retry
 * and — since it sends no idempotency key (finding G3) — that retry lands as a
 * second event. The abort is what makes "the notification does not block the
 * response" true even when the provider is the one misbehaving.
 *
 * `fetch` is global from Node 18 on, so this adds no runtime dependency: the
 * deployment package carries no node_modules (CONTRACT.md §1).
 */
const DEFAULT_TIMEOUT_MS = 1500;

async function postJson(fetchFn, url, { headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

/** Turns a thrown network or abort error into the port's failure shape. */
function sendFailure(provider, error, timeoutMs) {
  const aborted = error?.name === 'AbortError';
  return {
    success: false,
    provider,
    errorMessage: aborted
      ? `${provider} send timed out after ${timeoutMs} ms`
      : `${provider} send failed: ${error?.message ?? 'unknown error'}`,
  };
}

module.exports = { postJson, sendFailure, DEFAULT_TIMEOUT_MS };

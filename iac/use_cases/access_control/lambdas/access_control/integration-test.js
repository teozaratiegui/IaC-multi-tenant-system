#!/usr/bin/env node
'use strict';

/**
 * Optional smoke test against a deployed stack.
 *
 * Set the URLs and the API key, or put them in a `.env` next to this script,
 * then: npm run test:integration
 * Missing variables mean "skip", so it is safe to run in CI without secrets.
 *
 *   ACCESS_CONTROL_URL         tag-scan Function URL          (required)
 *   ACCESS_CONTROL_API_KEY     the tenant's API key           (required)
 *   ASSOCIATE_TAG_URL          associate-tag Function URL     (optional)
 *   WEBHOOK_URL                webhook Function URL           (optional)
 *   WHATSAPP_VERIFY_TOKEN      only checks the handshake when both are set
 *
 * Every check asserts a contract that a unit test cannot: that the thing is
 * actually deployed, reachable, and wired to the right credential.
 */

const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { NODE_VISIBLE_STATUSES } = require('./src/domain/decisions');

const env = process.env;
const failures = [];

function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

async function post(url, { apiKey, body, headers = {} } = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}

/** The status a reader ends up seeing has to survive the gateway relay. */
async function tagScan(url, apiKey) {
  const { status, body } = await post(url, {
    apiKey,
    body: {
      tag: 'integration-test-tag',
      nodeId: 'integration-test',
      timestamp: new Date().toISOString(),
    },
  });
  console.log('    tag-scan →', status, JSON.stringify(body));

  if (status === 401) {
    check('tag-scan authenticates', false, 'ACCESS_CONTROL_API_KEY does not match SSM');
    return;
  }
  check('tag-scan authenticates', true);
  // 404 and 422 are legitimate answers here: the tag simply is not allowed.
  check(
    'tag-scan answers a status the gateway forwards',
    NODE_VISIBLE_STATUSES.has(status),
    `${status} would reach the node as 503`,
  );

  const unauthorised = await post(url, { apiKey: 'definitely-not-the-key', body: { tag: 'x' } });
  check('tag-scan refuses a wrong key', unauthorised.status === 401, `got ${unauthorised.status}`);
}

/**
 * Deployed and wired, without creating anything: an EPC that does not exist has
 * to come back 404 rather than being created, which is also the check that
 * `associate` never falls back to creating a tag.
 */
async function associateTag(url, apiKey) {
  const missing = await post(url, {
    apiKey,
    body: {
      tag: `integration-test-absent-${Date.now()}`,
      chatId: '0',
      tagName: 'integration-test',
      ownerName: 'Integration',
      ownerLastName: 'Test',
    },
  });
  console.log('    associate-tag →', missing.status, JSON.stringify(missing.body));
  check('associate-tag refuses to invent a tag', missing.status === 404, `got ${missing.status}`);

  const badOp = await post(url, { apiKey, body: { op: 'delete', tag: 'x' } });
  check('associate-tag rejects an unknown op', badOp.status === 400, `got ${badOp.status}`);

  const unauthorised = await post(url, { apiKey: 'definitely-not-the-key', body: { tag: 'x' } });
  check(
    'associate-tag refuses a wrong key',
    unauthorised.status === 401,
    `got ${unauthorised.status}`,
  );
}

/**
 * The webhook's own authentication, which is the part that did not exist
 * before: a POST with no provider credential must not run a command.
 */
async function webhook(url) {
  const forged = await post(url, {
    body: { update_id: 1, message: { chat: { id: 1 }, text: '/status' } },
  });
  console.log('    webhook (no secret) →', forged.status);
  check('webhook refuses an unverified request', forged.status === 401, `got ${forged.status}`);

  if (!env.WHATSAPP_VERIFY_TOKEN) return;

  const query = new URLSearchParams({
    'hub.mode': 'subscribe',
    'hub.verify_token': env.WHATSAPP_VERIFY_TOKEN,
    'hub.challenge': 'integration-test-challenge',
  });
  const response = await fetch(`${url}?${query}`);
  const text = await response.text();
  check(
    'webhook echoes the WhatsApp handshake challenge',
    response.status === 200 && text === 'integration-test-challenge',
    `${response.status} ${text}`,
  );
}

async function main() {
  const url = env.ACCESS_CONTROL_URL;
  const apiKey = env.ACCESS_CONTROL_API_KEY;

  if (!url || !apiKey) {
    console.log('Skipped: set ACCESS_CONTROL_URL and ACCESS_CONTROL_API_KEY to run this.');
    return 0;
  }

  await tagScan(url, apiKey);
  if (env.ASSOCIATE_TAG_URL) await associateTag(env.ASSOCIATE_TAG_URL, apiKey);
  else console.log('skip  associate-tag — set ASSOCIATE_TAG_URL to check it');
  if (env.WEBHOOK_URL) await webhook(env.WEBHOOK_URL);
  else console.log('skip  webhook — set WEBHOOK_URL to check it');

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
    return 1;
  }
  console.log('\nAll checks passed.');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

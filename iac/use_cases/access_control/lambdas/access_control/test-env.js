'use strict';

/**
 * Environment for the handler tests.
 *
 * Fixed values, by design. This used to read a `.env` sitting next to it when
 * one was present, which made the result of `npm test` depend on an untracked
 * file: a developer with `AUTO_REGISTER_TAGS=true` in their local `.env` — a
 * perfectly reasonable thing to have for a manual run against dev — got a red
 * suite, and CI would have got a green one from the same commit. A test either
 * wants a value or does not care; the ones that want it pass an override.
 *
 * `.env` still exists and is still read, by `integration-test.js`: that script
 * talks to real AWS and genuinely needs real credentials. `.env.example`
 * documents both.
 */

const HANDLER_KEYS = [
  'AWS_REGION',
  'API_KEY_PARAMETER_NAME',
  'TAGS_TABLE_NAME',
  'EVENTS_TABLE_NAME',
  'ENVIRONMENT',
  'ORG_NAME',
  'AUTO_REGISTER_TAGS',
  'MESSAGING_PROVIDER',
  'MESSAGING_TOKEN_PARAMETER_NAME',
  'WEBHOOK_SECRET_PARAMETER_NAME',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_VERIFY_TOKEN',
  'ORG_DISPLAY_NAME',
  'MESSAGING_LOCALE',
  'MESSAGING_TIMEZONE',
];

const FALLBACKS = {
  AWS_REGION: 'sa-east-1',
  API_KEY_PARAMETER_NAME: '/test/acme/dev/api-key',
  TAGS_TABLE_NAME: 'acme-dev-tags',
  EVENTS_TABLE_NAME: 'acme-dev-events',
  ENVIRONMENT: 'prod',
  ORG_NAME: 'acme',
  // Tests assert the closed default explicitly; a suite that silently ran with
  // auto-registration on would pass while production let every tag through.
  AUTO_REGISTER_TAGS: 'false',
  // Messaging off by default, which is what Terraform produces for a tenant
  // with enable_messaging = false. tag-scan must work exactly like this.
  MESSAGING_PROVIDER: '',
  MESSAGING_TOKEN_PARAMETER_NAME: '',
  WEBHOOK_SECRET_PARAMETER_NAME: '',
  WHATSAPP_PHONE_NUMBER_ID: '',
  WHATSAPP_VERIFY_TOKEN: '',
  ORG_DISPLAY_NAME: '',
  MESSAGING_LOCALE: '',
  MESSAGING_TIMEZONE: '',
};

/** Applies the handler variables to process.env (call from Jest beforeEach). */
function applyHandlerTestEnv(overrides = {}) {
  for (const key of HANDLER_KEYS) {
    const value = overrides[key];
    const resolved = value !== undefined && value !== '' ? String(value).trim() : FALLBACKS[key];
    process.env[key] = resolved ?? '';
  }
}

/**
 * API key used by both the mocked SSM value and the request header in tests.
 * A literal, so the two sides of every comparison come from the same place.
 */
const UNIT_TEST_API_KEY = 'test-api-key-value';

function getUnitTestApiKey() {
  return UNIT_TEST_API_KEY;
}

module.exports = { applyHandlerTestEnv, getUnitTestApiKey, HANDLER_KEYS };

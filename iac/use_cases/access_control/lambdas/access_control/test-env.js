/**
 * Handler unit tests: read **only** `.env` in this folder (if present).
 * `.env.example` is documentation; copy it to `.env` and adjust.
 */
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

const HANDLER_KEYS = [
  'AWS_REGION',
  'API_KEY_PARAMETER_NAME',
  'TAGS_TABLE_NAME',
  'EVENTS_TABLE_NAME',
  'ENVIRONMENT',
];

function readDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    return {};
  }
  return dotenv.parse(fs.readFileSync(envPath, 'utf8'));
}

const FALLBACKS = {
  AWS_REGION: 'sa-east-1',
  API_KEY_PARAMETER_NAME: '/test/acme/dev/api-key',
  TAGS_TABLE_NAME: 'acme-dev-tags',
  EVENTS_TABLE_NAME: 'acme-dev-events',
  ENVIRONMENT: 'prod',
};

/** Apply handler-related vars to process.env (call from Jest beforeEach). */
function applyHandlerTestEnv() {
  const m = readDotEnv();
  for (const key of HANDLER_KEYS) {
    const v = m[key];
    process.env[key] =
      v !== undefined && v !== '' ? String(v).trim() : FALLBACKS[key];
  }
}

/** API key string used by mocked SSM + request headers in unit tests. */
function getUnitTestApiKey() {
  const m = readDotEnv();
  const v = m.UNIT_TEST_API_KEY;
  return v !== undefined && v !== '' ? String(v).trim() : 'test-api-key-value';
}

module.exports = { readDotEnv, applyHandlerTestEnv, getUnitTestApiKey, HANDLER_KEYS };

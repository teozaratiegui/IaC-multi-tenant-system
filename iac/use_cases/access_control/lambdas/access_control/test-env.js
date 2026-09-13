'use strict';

/**
 * Environment for the handler tests: reads `.env` in this folder when present,
 * falls back to safe defaults otherwise. `.env.example` is documentation only.
 */
const path = require('node:path');
const fs = require('node:fs');
const dotenv = require('dotenv');

const HANDLER_KEYS = [
  'AWS_REGION',
  'API_KEY_PARAMETER_NAME',
  'TAGS_TABLE_NAME',
  'EVENTS_TABLE_NAME',
  'ENVIRONMENT',
  'ORG_NAME',
  'AUTO_REGISTER_TAGS',
  'EVENT_DEDUP_WINDOW_MS',
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
  EVENT_DEDUP_WINDOW_MS: '0',
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

function readDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return {};
  return dotenv.parse(fs.readFileSync(envPath, 'utf8'));
}

/** Applies the handler variables to process.env (call from Jest beforeEach). */
function applyHandlerTestEnv(overrides = {}) {
  const fromFile = readDotEnv();
  for (const key of HANDLER_KEYS) {
    const value = overrides[key] ?? fromFile[key];
    const resolved = value !== undefined && value !== '' ? String(value).trim() : FALLBACKS[key];
    process.env[key] = resolved ?? '';
  }
}

/** API key used by both the mocked SSM value and the request header in tests. */
function getUnitTestApiKey() {
  const value = readDotEnv().UNIT_TEST_API_KEY;
  return value !== undefined && value !== '' ? String(value).trim() : 'test-api-key-value';
}

module.exports = { readDotEnv, applyHandlerTestEnv, getUnitTestApiKey, HANDLER_KEYS };

'use strict';

/**
 * Environment the handlers run with.
 *
 * Read and validated at the top of every invocation, not once per cold start:
 * it is a handful of string reads, and doing it per request means a deployment
 * whose variables were changed underneath a warm container fails loudly on the
 * next call instead of serving a stale config.
 *
 * The three handlers share one package but not one environment — Terraform
 * gives each function only the variables it needs (CONTRACT.md §2). So
 * validation is per handler: demanding EVENTS_TABLE_NAME from associate-tag,
 * which is never given one, would make a correct deployment fail at the first
 * invoke.
 */

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

const DEFAULT_LOCALE = 'es-AR';
const DEFAULT_TIMEZONE = 'America/Argentina/Buenos_Aires';

/**
 * Ceiling for the event dedup window.
 *
 * The window collapses every scan of one tag into a single row, so it swallows
 * genuine second reads as readily as retried ones. It is only ever safe below the
 * node's own debounce interval (5 s) — past that it is not deduplication, it is
 * losing events. A value over the ceiling is clamped rather than honoured: the
 * whole feature is a stopgap for the gateway sending no idempotency key
 * (finding G3), and erring towards a shorter window only costs duplicate rows.
 */
const MAX_DEDUP_WINDOW_MS = 5000;

/** What each handler cannot run without, keyed by the name its file uses. */
const REQUIREMENTS = {
  'tag-scan': ['tagsTable', 'eventsTable', 'apiKeyParameterName'],
  'associate-tag': ['tagsTable', 'apiKeyParameterName'],
  // The webhook secret is listed because it is the *only* thing authenticating
  // this endpoint: no x-api-key, a public Function URL, and a sender id the body
  // declares about itself. Without it the adapter refuses every request, which is
  // the right failure — but it surfaces as an opaque 500 on the first inbound
  // message instead of the explicit misconfiguration log the other two handlers
  // get. CONTRACT.md §2 has always marked it required.
  webhook: ['tagsTable', 'messagingTokenParameterName', 'webhookSecretParameterName'],
};

const LABELS = {
  tagsTable: 'TAGS_TABLE_NAME',
  eventsTable: 'EVENTS_TABLE_NAME',
  apiKeyParameterName: 'API_KEY_PARAMETER_NAME',
  messagingTokenParameterName: 'MESSAGING_TOKEN_PARAMETER_NAME',
  webhookSecretParameterName: 'WEBHOOK_SECRET_PARAMETER_NAME',
};

function asBoolean(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return TRUE_VALUES.has(String(value).trim().toLowerCase());
}

function asInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function asString(value, fallback = '') {
  const trimmed = String(value ?? '').trim();
  return trimmed === '' ? fallback : trimmed;
}

function loadConfig(env = process.env) {
  const orgSlug = asString(env.ORG_NAME);

  return {
    tagsTable: env.TAGS_TABLE_NAME,
    eventsTable: env.EVENTS_TABLE_NAME,
    apiKeyParameterName: env.API_KEY_PARAMETER_NAME,
    environment: asString(env.ENVIRONMENT).toLowerCase(),

    // Registering any unknown tag as allowed is a development convenience that
    // used to be implied by ENVIRONMENT=dev. It is now an explicit flag, so a
    // stray ENVIRONMENT value can no longer open the door to every tag.
    autoRegisterTags: asBoolean(env.AUTO_REGISTER_TAGS, false),

    // Collapses repeated events for one tag into a single row inside this
    // window. 0 disables it. It is only safe while the window stays below the
    // Fog cache TTL and the Edge debounce interval, and it is a workaround for
    // the gateway retrying a non-idempotent POST (finding G3).
    dedupWindowMs: Math.min(asInteger(env.EVENT_DEDUP_WINDOW_MS, 0), MAX_DEDUP_WINDOW_MS),

    // Messaging. All of these are absent when the tenant runs without it, and
    // tag-scan has to keep working: `none` selects the null messenger rather
    // than an `if` at each call site.
    messagingProvider: asString(env.MESSAGING_PROVIDER, 'none').toLowerCase(),
    messagingTokenParameterName: asString(env.MESSAGING_TOKEN_PARAMETER_NAME),
    webhookSecretParameterName: asString(env.WEBHOOK_SECRET_PARAMETER_NAME),
    whatsappPhoneNumberId: asString(env.WHATSAPP_PHONE_NUMBER_ID),
    whatsappVerifyToken: asString(env.WHATSAPP_VERIFY_TOKEN),

    // Presentation. ORG_NAME is the slug (`acme`) and the owner reads it in the
    // alert, so a tenant that wants a real name sets ORG_DISPLAY_NAME; locale
    // and timezone likewise stop being hardcoded Argentinian.
    orgSlug,
    orgDisplayName: asString(env.ORG_DISPLAY_NAME, orgSlug),
    locale: asString(env.MESSAGING_LOCALE, DEFAULT_LOCALE),
    timeZone: asString(env.MESSAGING_TIMEZONE, DEFAULT_TIMEZONE),
  };
}

/** True when this deployment has a channel to notify owners through. */
function messagingEnabled(config) {
  return config.messagingProvider !== 'none' && config.messagingProvider !== '';
}

/** Returns the list of problems that make this handler's deployment unusable. */
function validateConfig(config, handlerName) {
  const required = REQUIREMENTS[handlerName];
  if (!required) throw new Error(`Unknown handler for config validation: ${handlerName}`);

  const problems = [];
  for (const field of required) {
    if (!asString(config[field])) problems.push(`${LABELS[field]} is not set`);
  }
  if (handlerName === 'webhook' && !messagingEnabled(config)) {
    problems.push('MESSAGING_PROVIDER is not set');
  }
  return problems;
}

module.exports = {
  loadConfig,
  validateConfig,
  messagingEnabled,
  asBoolean,
  asInteger,
  DEFAULT_LOCALE,
  DEFAULT_TIMEZONE,
  MAX_DEDUP_WINDOW_MS,
};

'use strict';

/**
 * Environment the handlers run with.
 *
 * Read and validated at the top of every invocation, not once per cold start:
 * it is a handful of string reads, and doing it per request means a deployment
 * whose variables were changed underneath a warm container fails loudly on the
 * next call instead of serving a stale config.
 *
 * `loadConfig` knows this use case's variables; `validateConfig` does not, and
 * takes the requirements from its caller. The three handlers share one package
 * but not one environment — Terraform gives each function only the variables it
 * needs (CONTRACT.md §2) — so each declares what it cannot run without, next to
 * the code that uses it.
 */

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

const DEFAULT_LOCALE = 'es-AR';
const DEFAULT_TIMEZONE = 'America/Argentina/Buenos_Aires';

function asBoolean(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return TRUE_VALUES.has(String(value).trim().toLowerCase());
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

/**
 * Returns the list of problems that make a deployment unusable.
 *
 * `requirements` maps each config field the caller cannot run without to the
 * environment variable that sets it, so an operator reading the log is told the
 * name they have to fix rather than an internal field name. Handlers pass their
 * own, which is also why a misspelled handler name is no longer a failure mode:
 * there is nothing left to look up.
 */
function validateConfig(config, requirements) {
  const problems = [];
  for (const [field, label] of Object.entries(requirements)) {
    if (!asString(config[field])) problems.push(`${label} is not set`);
  }
  return problems;
}

module.exports = {
  loadConfig,
  validateConfig,
  messagingEnabled,
  asBoolean,
  DEFAULT_LOCALE,
  DEFAULT_TIMEZONE,
};

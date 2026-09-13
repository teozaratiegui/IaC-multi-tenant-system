'use strict';

const { loadConfig, validateConfig, MAX_DEDUP_WINDOW_MS } = require('./config');

// The same tables the handlers declare. Kept here rather than imported so a
// handler that quietly drops a requirement shows up as a failure, not as two
// copies of the same mistake agreeing with each other.
const SCAN_REQUIREMENTS = {
  tagsTable: 'TAGS_TABLE_NAME',
  eventsTable: 'EVENTS_TABLE_NAME',
  apiKeyParameterName: 'API_KEY_PARAMETER_NAME',
};
const ASSOCIATE_REQUIREMENTS = {
  tagsTable: 'TAGS_TABLE_NAME',
  apiKeyParameterName: 'API_KEY_PARAMETER_NAME',
};
const WEBHOOK_REQUIREMENTS = {
  tagsTable: 'TAGS_TABLE_NAME',
  messagingTokenParameterName: 'MESSAGING_TOKEN_PARAMETER_NAME',
  webhookSecretParameterName: 'WEBHOOK_SECRET_PARAMETER_NAME',
};

const SCAN_ENV = {
  TAGS_TABLE_NAME: 'acme-dev-tags',
  EVENTS_TABLE_NAME: 'acme-dev-events',
  API_KEY_PARAMETER_NAME: '/acme/dev/api-key',
  ENVIRONMENT: 'Dev',
  ORG_NAME: 'acme',
};

describe('loadConfig', () => {
  test('normalises the environment name', () => {
    expect(loadConfig(SCAN_ENV).environment).toBe('dev');
  });

  test('auto-registration is off unless it is switched on explicitly', () => {
    expect(loadConfig(SCAN_ENV).autoRegisterTags).toBe(false);
    expect(loadConfig({ ...SCAN_ENV, AUTO_REGISTER_TAGS: '' }).autoRegisterTags).toBe(false);
    expect(loadConfig({ ...SCAN_ENV, AUTO_REGISTER_TAGS: 'no' }).autoRegisterTags).toBe(false);
  });

  test('auto-registration accepts the usual truthy spellings', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(loadConfig({ ...SCAN_ENV, AUTO_REGISTER_TAGS: value }).autoRegisterTags).toBe(true);
    }
  });

  test('the dedup window defaults to 0 and rejects nonsense', () => {
    expect(loadConfig(SCAN_ENV).dedupWindowMs).toBe(0);
    expect(loadConfig({ ...SCAN_ENV, EVENT_DEDUP_WINDOW_MS: 'abc' }).dedupWindowMs).toBe(0);
    expect(loadConfig({ ...SCAN_ENV, EVENT_DEDUP_WINDOW_MS: '-5' }).dedupWindowMs).toBe(0);
    expect(loadConfig({ ...SCAN_ENV, EVENT_DEDUP_WINDOW_MS: '5000' }).dedupWindowMs).toBe(5000);

    // Clamped, not honoured. The window swallows genuine second reads as readily
    // as retried ones, so past the node's own 5 s debounce it stops being
    // deduplication and starts being lost events. The README documents the
    // ceiling; before this the code accepted any value.
    expect(loadConfig({ ...SCAN_ENV, EVENT_DEDUP_WINDOW_MS: '60000' }).dedupWindowMs).toBe(
      MAX_DEDUP_WINDOW_MS,
    );
  });
});

describe('messaging configuration', () => {
  test('no messaging variables at all means the provider is `none`', () => {
    // Terraform defines none of them when the tenant has messaging off, and
    // tag-scan still has to work (CONTRACT.md §2).
    const config = loadConfig(SCAN_ENV);
    expect(config.messagingProvider).toBe('none');
    expect(config.messagingTokenParameterName).toBe('');
    expect(validateConfig(config, SCAN_REQUIREMENTS)).toEqual([]);
  });

  test('the provider name is normalised', () => {
    expect(loadConfig({ ...SCAN_ENV, MESSAGING_PROVIDER: ' Telegram ' }).messagingProvider).toBe(
      'telegram',
    );
  });

  test('the whatsapp-only variables travel through untouched', () => {
    const config = loadConfig({
      ...SCAN_ENV,
      MESSAGING_PROVIDER: 'whatsapp',
      WHATSAPP_PHONE_NUMBER_ID: '12345',
      WHATSAPP_VERIFY_TOKEN: 'verify-me',
    });
    expect(config.whatsappPhoneNumberId).toBe('12345');
    expect(config.whatsappVerifyToken).toBe('verify-me');
  });
});

describe('presentation configuration', () => {
  test('the defaults reproduce the behaviour the deployed code had', () => {
    const config = loadConfig(SCAN_ENV);
    expect(config.orgDisplayName).toBe('acme');
    expect(config.locale).toBe('es-AR');
    expect(config.timeZone).toBe('America/Argentina/Buenos_Aires');
  });

  test('a tenant elsewhere overrides them without touching code', () => {
    const config = loadConfig({
      ...SCAN_ENV,
      ORG_DISPLAY_NAME: 'Facultad de Ingeniería',
      MESSAGING_LOCALE: 'en-US',
      MESSAGING_TIMEZONE: 'UTC',
    });
    expect(config.orgDisplayName).toBe('Facultad de Ingeniería');
    expect(config.locale).toBe('en-US');
    expect(config.timeZone).toBe('UTC');
  });

  test('the display name falls back to the slug, never to an empty string', () => {
    expect(loadConfig({ ...SCAN_ENV, ORG_DISPLAY_NAME: '  ' }).orgDisplayName).toBe('acme');
  });
});

describe('validateConfig', () => {
  test('a complete tag-scan environment has no problems', () => {
    expect(validateConfig(loadConfig(SCAN_ENV), SCAN_REQUIREMENTS)).toEqual([]);
  });

  test('every missing variable is reported, not just the first', () => {
    expect(validateConfig(loadConfig({}), SCAN_REQUIREMENTS)).toHaveLength(3);
  });

  test('each handler only requires what its own Terraform grants it', () => {
    // associate-tag gets no EVENTS_TABLE_NAME and the webhook gets no API key;
    // demanding them would make a correct deployment fail at the first invoke.
    const associateEnv = { TAGS_TABLE_NAME: 't', API_KEY_PARAMETER_NAME: '/k' };
    expect(validateConfig(loadConfig(associateEnv), ASSOCIATE_REQUIREMENTS)).toEqual([]);

    const webhookEnv = {
      TAGS_TABLE_NAME: 't',
      MESSAGING_PROVIDER: 'telegram',
      MESSAGING_TOKEN_PARAMETER_NAME: '/acme/dev/access-control/messaging-token',
      WEBHOOK_SECRET_PARAMETER_NAME: '/acme/dev/access-control/webhook-secret',
    };
    expect(validateConfig(loadConfig(webhookEnv), WEBHOOK_REQUIREMENTS)).toEqual([]);
  });

  test('the webhook is unusable without a provider and a token', () => {
    const problems = validateConfig(loadConfig({ TAGS_TABLE_NAME: 't' }), WEBHOOK_REQUIREMENTS);
    expect(problems.length).toBeGreaterThan(0);
  });

  test('a webhook without its secret is reported misconfigured, not left to fail at runtime', () => {
    // The secret is the only thing authenticating this endpoint. Missing, the
    // adapter does refuse every request — but as an opaque 500 on the first
    // inbound message, with none of the diagnosis the other two handlers get.
    const problems = validateConfig(
      loadConfig({
        TAGS_TABLE_NAME: 't',
        MESSAGING_PROVIDER: 'telegram',
        MESSAGING_TOKEN_PARAMETER_NAME: '/acme/dev/access-control/messaging-token',
      }),
      WEBHOOK_REQUIREMENTS,
    );
    expect(problems).toEqual(['WEBHOOK_SECRET_PARAMETER_NAME is not set']);
  });

  test('the validator knows nothing about this use case', () => {
    // It reports whatever the caller asked for, which is what lets a second use
    // case reuse it: the field names and the variable names are both the
    // caller's. A misspelled handler name used to be a failure mode here and is
    // no longer reachable — there is nothing left to look up.
    const problems = validateConfig({ somethingElse: '' }, { somethingElse: 'SOMETHING_ELSE' });
    expect(problems).toEqual(['SOMETHING_ELSE is not set']);
  });
});

'use strict';

const mockSsmSend = jest.fn();
const mockDynamoSend = jest.fn();

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: (...args) => mockSsmSend(...args) })),
  GetParameterCommand: jest.requireActual('@aws-sdk/client-ssm').GetParameterCommand,
}));

jest.mock('@aws-sdk/client-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/client-dynamodb');
  return {
    DynamoDBClient: jest.fn(() => ({ send: (...args) => mockDynamoSend(...args) })),
    GetItemCommand: actual.GetItemCommand,
    PutItemCommand: actual.PutItemCommand,
    QueryCommand: actual.QueryCommand,
    UpdateItemCommand: actual.UpdateItemCommand,
  };
});

const { applyHandlerTestEnv } = require('../../test-env');

const WEBHOOK_SECRET = 'webhook-secret-value';
const BOT_TOKEN = 'bot-token';

const TELEGRAM_ENV = {
  MESSAGING_PROVIDER: 'telegram',
  MESSAGING_TOKEN_PARAMETER_NAME: '/acme/dev/access-control/messaging-token',
  WEBHOOK_SECRET_PARAMETER_NAME: '/acme/dev/access-control/webhook-secret',
};

const STORED_TAG = {
  tagId: { S: 'E280' },
  allowed: { BOOL: true },
  chatId: { S: '99' },
  tagName: { S: 'bici' },
  tagNameNormalized: { S: 'bici' },
};

let fetchSpy;

function update(text = '/status', overrides = {}) {
  return {
    requestContext: { http: { method: 'POST' } },
    headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
    body: JSON.stringify({ update_id: 1, message: { chat: { id: 99 }, text } }),
    ...overrides,
  };
}

function ssmByName() {
  mockSsmSend.mockImplementation((command) => {
    const name = command.input.Name;
    const value = name.includes('webhook-secret') ? WEBHOOK_SECRET : BOT_TOKEN;
    return Promise.resolve({ Parameter: { Value: value } });
  });
}

function sentText() {
  return JSON.parse(fetchSpy.mock.calls[0][1].body).text;
}

async function loadHandler(envOverrides = TELEGRAM_ENV) {
  jest.resetModules();
  applyHandlerTestEnv(envOverrides);
  const module = require('./webhook');
  module.__resetForTests();
  return module.handler;
}

beforeEach(() => {
  mockSsmSend.mockReset();
  mockDynamoSend.mockReset();
  applyHandlerTestEnv(TELEGRAM_ENV);
  ssmByName();
  mockDynamoSend.mockResolvedValue({ Items: [STORED_TAG] });
  fetchSpy = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe('authentication', () => {
  test('401 without the provider secret, and nothing runs', async () => {
    // The Function URL is public and the chat id is self-declared in the body:
    // without this check anyone who found the URL could lock or unlock another
    // person's tags. It is the only authorisation the bot has.
    const handler = await loadHandler();
    const res = await handler(update('/lock bici', { headers: {} }));

    expect(res.statusCode).toBe(401);
    expect(mockDynamoSend).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('401 with the wrong secret', async () => {
    const handler = await loadHandler();
    const res = await handler(
      update('/status', { headers: { 'x-telegram-bot-api-secret-token': 'nope' } }),
    );
    expect(res.statusCode).toBe(401);
  });

  test('a deployment with no secret configured refuses everything', async () => {
    mockSsmSend.mockResolvedValue({ Parameter: { Value: '' } });
    const handler = await loadHandler();
    expect((await handler(update())).statusCode).toBe(401);
  });

  test('the verification happens before the payload is even parsed', async () => {
    const handler = await loadHandler();
    const res = await handler(update('/lock bici', { headers: {}, body: '{not json' }));
    expect(res.statusCode).toBe(401);
  });
});

describe('a verified command', () => {
  test('runs and the answer goes back through the messenger', async () => {
    const handler = await loadHandler();
    const res = await handler(update('/status bici'));

    expect(res.statusCode).toBe(200);
    expect(fetchSpy.mock.calls[0][0]).toContain(`api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).chat_id).toBe('99');
    expect(sentText()).toContain('ID: E280');
  });

  test('a group command with the @botname suffix is understood', async () => {
    const handler = await loadHandler();
    await handler(update('/status@mibot bici'));
    expect(sentText()).toContain('ID: E280');
  });

  test('/lock writes and warns about the propagation delay', async () => {
    mockDynamoSend.mockImplementation((command) =>
      command.constructor.name === 'QueryCommand'
        ? Promise.resolve({ Items: [STORED_TAG] })
        : Promise.resolve({}),
    );

    const handler = await loadHandler();
    await handler(update('/lock bici'));

    const updates = mockDynamoSend.mock.calls.filter(
      (call) => call[0].constructor.name === 'UpdateItemCommand',
    );
    expect(updates[0][0].input.ExpressionAttributeValues[':allowed'].BOOL).toBe(false);
    expect(sentText()).toContain('5 minutos');
  });

  test('a payload with no sender is answered without running anything', async () => {
    const handler = await loadHandler();
    const res = await handler(update('/status', { body: JSON.stringify({ update_id: 7 }) }));

    expect(res.statusCode).toBe(200);
    expect(mockDynamoSend).not.toHaveBeenCalled();
  });
});

describe('the status is always 200 once a command has been accepted', () => {
  test('even when storage fails mid-command', async () => {
    // A non-2xx makes Telegram redeliver the same update indefinitely — for a
    // command that may already have taken effect. The error goes in the body
    // and in the log instead. This is deliberate.
    mockDynamoSend.mockRejectedValue(new Error('DynamoDB is down'));
    const handler = await loadHandler();
    const res = await handler(update('/status'));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(false);
  });

  test('even when the reply itself could not be delivered', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNRESET'));
    const handler = await loadHandler();
    const res = await handler(update('/status'));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(false);
  });
});

describe('GET', () => {
  test('is a handshake for WhatsApp', async () => {
    const handler = await loadHandler({
      MESSAGING_PROVIDER: 'whatsapp',
      MESSAGING_TOKEN_PARAMETER_NAME: '/acme/dev/access-control/messaging-token',
      WEBHOOK_SECRET_PARAMETER_NAME: '/acme/dev/access-control/webhook-secret',
      WHATSAPP_VERIFY_TOKEN: 'verify-me',
      WHATSAPP_PHONE_NUMBER_ID: '12345',
    });

    const res = await handler({
      requestContext: { http: { method: 'GET' } },
      queryStringParameters: {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'verify-me',
        'hub.challenge': '31415',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('31415');
  });

  test('is 405 for Telegram, which has no handshake', async () => {
    const handler = await loadHandler();
    const res = await handler({ requestContext: { http: { method: 'GET' } } });
    expect(res.statusCode).toBe(405);
  });
});

describe('configuration', () => {
  test('500 when the function was deployed without a messaging provider', async () => {
    const handler = await loadHandler({ MESSAGING_PROVIDER: '' });
    expect((await handler(update())).statusCode).toBe(500);
  });

  test('an unsupported messaging provider fails closed, not silently', async () => {
    // tag-scan has had this test; the webhook is the endpoint where it matters
    // more, because a provider name the registry does not know means there is no
    // inbound adapter — and therefore no verification. Answering anything but
    // 500 would be running an unauthenticated command.
    const handler = await loadHandler({ ...TELEGRAM_ENV, MESSAGING_PROVIDER: 'signal' });
    const result = await handler(update());

    expect(result.statusCode).toBe(500);
    expect(mockDynamoSend).not.toHaveBeenCalled();
  });

  test('500 when the webhook secret was never wired up', async () => {
    // The secret is the only thing authenticating this endpoint: no x-api-key,
    // a public Function URL, a sender id the body declares about itself. A
    // deployment missing it must refuse, and say which variable is missing.
    const handler = await loadHandler({
      ...TELEGRAM_ENV,
      WEBHOOK_SECRET_PARAMETER_NAME: '',
    });
    expect((await handler(update())).statusCode).toBe(500);
  });
});

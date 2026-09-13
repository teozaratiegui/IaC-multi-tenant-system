'use strict';

/**
 * Handler tests with a mocked AWS SDK — no real SSM or DynamoDB, no network.
 * Commands are recognised by constructor name, not by `instanceof`: the handler
 * is reloaded between tests and class identity would not survive that.
 */

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

const { applyHandlerTestEnv, getUnitTestApiKey } = require('../../test-env');

const ALLOWED_TAG = { Item: { tagId: { S: 'tag-1' }, allowed: { BOOL: true } } };
const DENIED_TAG = { Item: { tagId: { S: 'tag-1' }, allowed: { BOOL: false } } };
const DENIED_BOUND_TAG = {
  Item: {
    tagId: { S: 'tag-1' },
    allowed: { BOOL: false },
    chatId: { S: '99' },
    tagName: { S: 'bici' },
    tagNameNormalized: { S: 'bici' },
  },
};
const NO_TAG = {};

function event(overrides = {}) {
  return {
    headers: { 'x-api-key': getUnitTestApiKey() },
    body: JSON.stringify({ tag: 'tag-1' }),
    ...overrides,
  };
}

function commandName(call) {
  return call[0].constructor.name;
}

function writesTo(tableName) {
  return mockDynamoSend.mock.calls
    .filter((call) => commandName(call) === 'PutItemCommand')
    .map((call) => call[0].input)
    .filter((input) => input.TableName === tableName);
}

const eventWrites = () => writesTo(process.env.EVENTS_TABLE_NAME);

async function loadHandler(envOverrides = {}) {
  jest.resetModules();
  applyHandlerTestEnv(envOverrides);
  const module = require('./tag-scan');
  module.__resetForTests();
  return module.handler;
}

beforeEach(() => {
  mockSsmSend.mockReset();
  mockDynamoSend.mockReset();
  applyHandlerTestEnv();
  mockSsmSend.mockResolvedValue({ Parameter: { Value: getUnitTestApiKey() } });
});

describe('authentication', () => {
  test('401 when the API key is missing', async () => {
    const handler = await loadHandler();
    const res = await handler(event({ headers: {} }));
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('Unauthorized');
  });

  test('401 when the API key is wrong', async () => {
    const handler = await loadHandler();
    expect((await handler(event({ headers: { 'x-api-key': 'wrong' } }))).statusCode).toBe(401);
  });

  test('401 when the API key is a prefix of the right one', async () => {
    const handler = await loadHandler();
    const key = getUnitTestApiKey();
    expect((await handler(event({ headers: { 'x-api-key': key.slice(0, -1) } }))).statusCode).toBe(
      401,
    );
  });

  test('the header name is matched case-insensitively', async () => {
    const handler = await loadHandler();
    mockDynamoSend.mockResolvedValue(ALLOWED_TAG);
    const res = await handler(event({ headers: { 'X-Api-Key': getUnitTestApiKey() } }));
    expect(res.statusCode).toBe(200);
  });

  test('the SSM parameter is read once per execution environment', async () => {
    const handler = await loadHandler();
    mockDynamoSend.mockResolvedValue(ALLOWED_TAG);
    await handler(event());
    await handler(event());
    expect(mockSsmSend).toHaveBeenCalledTimes(1);
  });

  test('nothing is read or written before the caller is authenticated', async () => {
    const handler = await loadHandler();
    await handler(event({ headers: {} }));
    expect(mockDynamoSend).not.toHaveBeenCalled();
  });
});

describe('request validation', () => {
  test('400 when the body is not valid JSON', async () => {
    const handler = await loadHandler();
    expect((await handler(event({ body: '{not json' }))).statusCode).toBe(400);
  });

  test('400 when the tag field is missing', async () => {
    const handler = await loadHandler();
    expect(
      (await handler(event({ body: JSON.stringify({ nodeId: 'node-1' }) }))).statusCode,
    ).toBe(400);
  });

  test('400 for a tag that is not a string, instead of a row named [object Object]', async () => {
    const handler = await loadHandler();
    const res = await handler(event({ body: JSON.stringify({ tag: { a: 1 } }) }));
    expect(res.statusCode).toBe(400);
    expect(mockDynamoSend).not.toHaveBeenCalled();
  });

  test('500 when the table environment variables are missing', async () => {
    const handler = await loadHandler({ TAGS_TABLE_NAME: ' ', EVENTS_TABLE_NAME: ' ' });
    process.env.TAGS_TABLE_NAME = '';
    expect((await handler(event())).statusCode).toBe(500);
  });
});

describe('decisions', () => {
  test('200 and an ALLOW event when the tag is allowed', async () => {
    const handler = await loadHandler();
    mockDynamoSend.mockResolvedValue(ALLOWED_TAG);

    const res = await handler(event());

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
    expect(eventWrites()).toHaveLength(1);
    expect(eventWrites()[0].Item.decision.S).toBe('ALLOW');
  });

  test('422 — not 403 — when the tag exists but is not allowed', async () => {
    const handler = await loadHandler();
    mockDynamoSend.mockResolvedValue(DENIED_TAG);

    const res = await handler(event());

    expect(res.statusCode).toBe(422);
    expect(eventWrites()[0].Item.decision.S).toBe('DENY');
  });

  test('404 and an UNKNOWN event when the tag is not registered', async () => {
    const handler = await loadHandler();
    mockDynamoSend.mockResolvedValue(NO_TAG);

    const res = await handler(event());

    expect(res.statusCode).toBe(404);
    expect(eventWrites()).toHaveLength(1);
    expect(eventWrites()[0].Item.decision.S).toBe('UNKNOWN');
  });

  test('every status returned is one the gateway forwards to the node', async () => {
    const { NODE_VISIBLE_STATUSES } = require('../domain/decisions');
    const handler = await loadHandler();

    for (const tagLookup of [ALLOWED_TAG, DENIED_TAG, NO_TAG]) {
      mockDynamoSend.mockReset();
      mockDynamoSend.mockResolvedValue(tagLookup);
      const res = await handler(event());
      expect(NODE_VISIBLE_STATUSES.has(res.statusCode)).toBe(true);
    }
  });
});

describe('auto-registration', () => {
  test('an unknown tag is refused when AUTO_REGISTER_TAGS is off, even in dev', async () => {
    const handler = await loadHandler({ ENVIRONMENT: 'dev', AUTO_REGISTER_TAGS: 'false' });
    mockDynamoSend.mockResolvedValue(NO_TAG);
    expect((await handler(event())).statusCode).toBe(404);
  });

  test('201 and a registered tag when AUTO_REGISTER_TAGS is on', async () => {
    const handler = await loadHandler({ AUTO_REGISTER_TAGS: 'true' });
    mockDynamoSend.mockResolvedValue(NO_TAG);

    const res = await handler(event());

    expect(res.statusCode).toBe(201);
    const tagWrites = writesTo(process.env.TAGS_TABLE_NAME);
    expect(tagWrites).toHaveLength(1);
    expect(tagWrites[0].Item.allowed.BOOL).toBe(true);
    expect(tagWrites[0].ConditionExpression).toBe('attribute_not_exists(tagId)');
  });
});

describe('traceability fields', () => {
  test('nodeId and the client timestamp reach the event row', async () => {
    const handler = await loadHandler();
    mockDynamoSend.mockResolvedValue(ALLOWED_TAG);

    await handler(
      event({
        body: JSON.stringify({
          tag: 'tag-1',
          nodeId: 'node-ab12cd34',
          timestamp: '2026-09-12T10:00:00Z',
        }),
      }),
    );

    const item = eventWrites()[0].Item;
    expect(item.nodeId.S).toBe('node-ab12cd34');
    expect(item.clientTimestamp.S).toBe('2026-09-12T10:00:00Z');
    expect(item.eventTime.N).toMatch(/^\d+$/);
  });

  test('the snake_case spellings the gateway may send are accepted too', async () => {
    const handler = await loadHandler();
    mockDynamoSend.mockResolvedValue(ALLOWED_TAG);

    await handler(
      event({ body: JSON.stringify({ tag: 'tag-1', node_id: 'node-1', ts: '2026-09-12T10:00:00Z' }) }),
    );

    expect(eventWrites()[0].Item.nodeId.S).toBe('node-1');
  });

  test('an event write is conditional, so a retried POST cannot duplicate it', async () => {
    const handler = await loadHandler();
    mockDynamoSend.mockResolvedValue(ALLOWED_TAG);
    await handler(event());
    expect(eventWrites()[0].ConditionExpression).toContain('attribute_not_exists');
  });

  test('an Idempotency-Key header makes the event id deterministic', async () => {
    const handler = await loadHandler();
    mockDynamoSend.mockResolvedValue(ALLOWED_TAG);

    await handler(
      event({ headers: { 'x-api-key': getUnitTestApiKey(), 'Idempotency-Key': 'scan-7' } }),
    );

    expect(eventWrites()[0].Item.eventId.S).toContain('scan-7');
  });

  test('a duplicate event is reported as success, not as a 500', async () => {
    const handler = await loadHandler();
    mockDynamoSend.mockImplementation((command) => {
      if (command.constructor.name === 'GetItemCommand') return Promise.resolve(ALLOWED_TAG);
      const error = new Error('The conditional request failed');
      error.name = 'ConditionalCheckFailedException';
      return Promise.reject(error);
    });

    expect((await handler(event())).statusCode).toBe(200);
  });
});

describe('notification', () => {
  test('with messaging off, a denial still answers 422 and calls no provider', async () => {
    // This is the deployment Terraform produces with enable_messaging = false:
    // none of the MESSAGING_* variables exist (CONTRACT.md §2).
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) });
    const handler = await loadHandler();
    mockDynamoSend.mockResolvedValue(DENIED_BOUND_TAG);

    const res = await handler(event());

    expect(res.statusCode).toBe(422);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(eventWrites()[0].Item.notified.BOOL).toBe(false);
    fetchSpy.mockRestore();
  });

  test('with Telegram configured, the owner is messaged and the row says so', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    mockSsmSend.mockImplementation((command) =>
      Promise.resolve({
        Parameter: {
          Value: command.input.Name.includes('messaging') ? 'bot-token' : getUnitTestApiKey(),
        },
      }),
    );

    const handler = await loadHandler({
      MESSAGING_PROVIDER: 'telegram',
      MESSAGING_TOKEN_PARAMETER_NAME: '/acme/dev/access-control/messaging-token',
    });
    mockDynamoSend.mockResolvedValue(DENIED_BOUND_TAG);

    const res = await handler(event());

    expect(res.statusCode).toBe(422);
    expect(fetchSpy.mock.calls[0][0]).toContain('api.telegram.org/botbot-token/sendMessage');
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).chat_id).toBe('99');
    expect(eventWrites()[0].Item.notified.BOOL).toBe(true);
    expect(eventWrites()[0].Item.notifyChannel.S).toBe('telegram');
    fetchSpy.mockRestore();
  });

  test('a provider that is down does not change what the reader is told', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'));
    mockSsmSend.mockResolvedValue({ Parameter: { Value: getUnitTestApiKey() } });

    const handler = await loadHandler({
      MESSAGING_PROVIDER: 'telegram',
      MESSAGING_TOKEN_PARAMETER_NAME: '/acme/dev/access-control/messaging-token',
    });
    mockDynamoSend.mockResolvedValue(DENIED_BOUND_TAG);

    const res = await handler(event());

    expect(res.statusCode).toBe(422);
    expect(eventWrites()[0].Item.notified.BOOL).toBe(false);
    fetchSpy.mockRestore();
  });
});

describe('failures', () => {
  test('500 when the tag lookup throws', async () => {
    const handler = await loadHandler();
    mockDynamoSend.mockRejectedValue(new Error('DynamoDB is down'));
    expect((await handler(event())).statusCode).toBe(500);
  });

  test('500 when SSM cannot be read', async () => {
    const handler = await loadHandler();
    mockSsmSend.mockRejectedValue(new Error('parameter not found'));
    expect((await handler(event())).statusCode).toBe(500);
  });

  test('an unsupported messaging provider fails closed, not silently', async () => {
    const handler = await loadHandler({ MESSAGING_PROVIDER: 'signal' });
    mockDynamoSend.mockResolvedValue(ALLOWED_TAG);
    expect((await handler(event())).statusCode).toBe(500);
  });
});

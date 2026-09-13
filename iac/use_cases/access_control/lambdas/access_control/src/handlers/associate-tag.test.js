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

const { applyHandlerTestEnv, getUnitTestApiKey } = require('../../test-env');

const ASSOCIATION = {
  tag: 'E280',
  chatId: '99',
  tagName: 'Bici',
  ownerName: 'Teo',
  ownerLastName: 'Zaratiegui',
};

const STORED = {
  tagId: { S: 'E280' },
  allowed: { BOOL: true },
  chatId: { S: '99' },
  tagName: { S: 'Bici' },
  tagNameNormalized: { S: 'bici' },
  ownerName: { S: 'Teo' },
  ownerLastName: { S: 'Zaratiegui' },
};

function event(body = ASSOCIATION, overrides = {}) {
  return {
    headers: { 'x-api-key': getUnitTestApiKey() },
    body: JSON.stringify(body),
    ...overrides,
  };
}

function commandName(call) {
  return call[0].constructor.name;
}

function callsNamed(name) {
  return mockDynamoSend.mock.calls.filter((call) => commandName(call) === name).map((c) => c[0].input);
}

/** No sibling with that name, then the write succeeds, then the record is read back. */
function happyPath() {
  mockDynamoSend.mockImplementation((command) => {
    switch (command.constructor.name) {
      case 'QueryCommand':
        return Promise.resolve({ Items: [] });
      case 'GetItemCommand':
        return Promise.resolve({ Item: STORED });
      default:
        return Promise.resolve({});
    }
  });
}

async function loadHandler(envOverrides = {}) {
  jest.resetModules();
  applyHandlerTestEnv(envOverrides);
  const module = require('./associate-tag');
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
  test('401 without the API key, and nothing is touched', async () => {
    const handler = await loadHandler();
    const res = await handler(event(ASSOCIATION, { headers: {} }));

    expect(res.statusCode).toBe(401);
    expect(mockDynamoSend).not.toHaveBeenCalled();
  });

  test('it is the same x-api-key the gateway uses — a documented trade-off', async () => {
    // A separate administration credential was evaluated and dropped as
    // over-engineering for one tenant. The consequence is written down in the
    // README: whoever holds the gateway's key can also provision and bind tags.
    happyPath();
    const handler = await loadHandler();
    const res = await handler(event());

    expect(res.statusCode).toBe(200);
    expect(mockSsmSend.mock.calls[0][0].input.Name).toBe(process.env.API_KEY_PARAMETER_NAME);
  });
});

describe('associate, the default operation', () => {
  test('200 and a single UpdateItem carrying both index attributes', async () => {
    happyPath();
    const handler = await loadHandler();
    const res = await handler(event());

    expect(res.statusCode).toBe(200);
    const updates = callsNamed('UpdateItemCommand');
    expect(updates).toHaveLength(1);
    expect(updates[0].ExpressionAttributeValues[':chatId'].S).toBe('99');
    expect(updates[0].ExpressionAttributeValues[':tagNameNormalized'].S).toBe('bici');
  });

  test('the snake_case spellings the old clients send are still accepted', async () => {
    happyPath();
    const handler = await loadHandler();
    const res = await handler(
      event({
        tag: 'E280',
        chat_id: '99',
        tag_name: 'Bici',
        name: 'Teo',
        lastname: 'Zaratiegui',
      }),
    );

    expect(res.statusCode).toBe(200);
  });

  test('404 when the tag does not exist', async () => {
    mockDynamoSend.mockImplementation((command) => {
      if (command.constructor.name === 'QueryCommand') return Promise.resolve({ Items: [] });
      const error = new Error('The conditional request failed');
      error.name = 'ConditionalCheckFailedException';
      return Promise.reject(error);
    });

    const handler = await loadHandler();
    expect((await handler(event())).statusCode).toBe(404);
  });

  test('409 when the name is taken in that chat', async () => {
    mockDynamoSend.mockImplementation((command) =>
      command.constructor.name === 'QueryCommand'
        ? Promise.resolve({ Items: [{ ...STORED, tagId: { S: 'OTHER' } }] })
        : Promise.resolve({}),
    );

    const handler = await loadHandler();
    expect((await handler(event())).statusCode).toBe(409);
  });

  test('400 when a required field is missing', async () => {
    const handler = await loadHandler();
    const res = await handler(event({ tag: 'E280', chatId: '99' }));

    expect(res.statusCode).toBe(400);
    expect(mockDynamoSend).not.toHaveBeenCalled();
  });

  test('400 for a body that is not JSON', async () => {
    const handler = await loadHandler();
    expect((await handler(event(ASSOCIATION, { body: '{oops' }))).statusCode).toBe(400);
  });
});

describe('provision, asked for by name', () => {
  test('201 and a conditional PutItem', async () => {
    mockDynamoSend.mockImplementation((command) =>
      command.constructor.name === 'GetItemCommand'
        ? Promise.resolve({ Item: { tagId: { S: 'E280' }, allowed: { BOOL: true } } })
        : Promise.resolve({}),
    );

    const handler = await loadHandler();
    const res = await handler(event({ op: 'provision', tag: 'E280' }));

    expect(res.statusCode).toBe(201);
    const puts = callsNamed('PutItemCommand');
    expect(puts).toHaveLength(1);
    expect(puts[0].ConditionExpression).toBe('attribute_not_exists(tagId)');
  });

  test('409 when the tag is already there', async () => {
    const error = new Error('The conditional request failed');
    error.name = 'ConditionalCheckFailedException';
    mockDynamoSend.mockRejectedValue(error);

    const handler = await loadHandler();
    expect((await handler(event({ op: 'provision', tag: 'E280' }))).statusCode).toBe(409);
  });

  test('creates and binds in one write when the association comes along', async () => {
    mockDynamoSend.mockImplementation((command) =>
      command.constructor.name === 'GetItemCommand'
        ? Promise.resolve({ Item: STORED })
        : Promise.resolve({}),
    );

    const handler = await loadHandler();
    const res = await handler(event({ op: 'provision', ...ASSOCIATION }));

    expect(res.statusCode).toBe(201);
    const puts = callsNamed('PutItemCommand');
    expect(puts).toHaveLength(1);
    expect(puts[0].Item.chatId.S).toBe('99');
    expect(puts[0].Item.tagNameNormalized.S).toBe('bici');
  });
});

describe('routing', () => {
  test('an absent op means associate, which is the common case', async () => {
    happyPath();
    const handler = await loadHandler();
    await handler(event());

    expect(callsNamed('UpdateItemCommand')).toHaveLength(1);
    expect(callsNamed('PutItemCommand')).toHaveLength(0);
  });

  test('the operation is routed by a body field, never by the path', async () => {
    // A Function URL ignores the path entirely, so routing on it would look
    // like it worked and silently always pick the same branch.
    happyPath();
    const handler = await loadHandler();
    const res = await handler(event({ op: ' Associate ' }, { rawPath: '/provision' }));

    expect(res.statusCode).toBe(400);
    expect(callsNamed('PutItemCommand')).toHaveLength(0);
  });

  test('400 for an operation nobody implemented', async () => {
    const handler = await loadHandler();
    const res = await handler(event({ op: 'delete', tag: 'E280' }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toContain('op');
  });
});

describe('failures', () => {
  test('500 when DynamoDB is down', async () => {
    mockDynamoSend.mockRejectedValue(new Error('DynamoDB is down'));
    const handler = await loadHandler();
    expect((await handler(event())).statusCode).toBe(500);
  });

  test('500 when the deployment has no tags table', async () => {
    const handler = await loadHandler({ TAGS_TABLE_NAME: ' ' });
    process.env.TAGS_TABLE_NAME = '';
    expect((await handler(event())).statusCode).toBe(500);
  });
});

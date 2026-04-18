/**
 * Unit tests: mocked AWS SDK (no real SSM/DynamoDB).
 * Use command constructor names — not instanceof — because jest.resetModules()
 * reloads the handler and Command class identity can differ.
 */

const mockSsmSend = jest.fn();
const mockDynamoSend = jest.fn();

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: (...args) => mockSsmSend(...args) })),
  GetParameterCommand: jest.requireActual('@aws-sdk/client-ssm').GetParameterCommand,
}));

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: (...args) => mockDynamoSend(...args) })),
  GetItemCommand: jest.requireActual('@aws-sdk/client-dynamodb').GetItemCommand,
  PutItemCommand: jest.requireActual('@aws-sdk/client-dynamodb').PutItemCommand,
}));

const { applyHandlerTestEnv, getUnitTestApiKey } = require('./test-env');

function baseEvent(overrides = {}) {
  return {
    headers: { 'x-api-key': getUnitTestApiKey() },
    body: JSON.stringify({ tag: 'tag-1' }),
    ...overrides,
  };
}

async function getHandler() {
  jest.resetModules();
  const { handler } = require('./index.js');
  return handler;
}

beforeEach(() => {
  mockSsmSend.mockReset();
  mockDynamoSend.mockReset();
  applyHandlerTestEnv();
  mockSsmSend.mockResolvedValue({
    Parameter: { Value: getUnitTestApiKey() },
  });
});

describe('access_control handler', () => {
  test('401 when x-api-key is missing', async () => {
    const handler = await getHandler();
    const res = await handler({
      headers: {},
      body: JSON.stringify({ tag: 'x' }),
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('Unauthorized');
  });

  test('401 when API key is wrong', async () => {
    const handler = await getHandler();
    const res = await handler({
      headers: { 'x-api-key': 'wrong' },
      body: JSON.stringify({ tag: 'x' }),
    });
    expect(res.statusCode).toBe(401);
  });

  test('400 when body is invalid JSON', async () => {
    const handler = await getHandler();
    const res = await handler(
      baseEvent({ body: 'not-json{' }),
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toBe('Invalid JSON body');
  });

  test('400 when tag is missing', async () => {
    const handler = await getHandler();
    const res = await handler(
      baseEvent({ body: JSON.stringify({}) }),
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toContain('tag');
  });

  test('500 when table env vars are missing', async () => {
    delete process.env.TAGS_TABLE_NAME;
    const handler = await getHandler();
    const res = await handler(baseEvent());
    expect(res.statusCode).toBe(500);
  });

  test('200 when tag exists and allowed', async () => {
    mockDynamoSend.mockImplementation((cmd) => {
      const n = cmd?.constructor?.name;
      if (n === 'GetItemCommand') {
        return Promise.resolve({
          Item: {
            tagId: { S: 'tag-1' },
            allowed: { BOOL: true },
          },
        });
      }
      if (n === 'PutItemCommand') {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    const handler = await getHandler();
    const res = await handler(baseEvent());

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.message).toBe('Access allowed');
    expect(body.tag).toBe('tag-1');
  });

  test('403 when tag exists and not allowed', async () => {
    mockDynamoSend.mockImplementation((cmd) => {
      const n = cmd?.constructor?.name;
      if (n === 'GetItemCommand') {
        return Promise.resolve({
          Item: {
            tagId: { S: 'tag-1' },
            allowed: { BOOL: false },
          },
        });
      }
      if (n === 'PutItemCommand') {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    const handler = await getHandler();
    const res = await handler(baseEvent());

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('Forbidden');
    expect(body.tag).toBe('tag-1');
  });

  test('404 when tag missing and environment is not dev', async () => {
    process.env.ENVIRONMENT = 'prod';
    mockDynamoSend.mockImplementation((cmd) => {
      const n = cmd?.constructor?.name;
      if (n === 'GetItemCommand') {
        return Promise.resolve({});
      }
      if (n === 'PutItemCommand') {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    const handler = await getHandler();
    const res = await handler(baseEvent());

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('Not Found');
  });

  test('201 dev auto-register when tag missing', async () => {
    process.env.ENVIRONMENT = 'dev';
    mockDynamoSend.mockImplementation((cmd) => {
      const n = cmd?.constructor?.name;
      if (n === 'GetItemCommand') {
        return Promise.resolve({});
      }
      if (n === 'PutItemCommand') {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    const handler = await getHandler();
    const res = await handler(baseEvent());

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.message).toContain('dev only');
  });

  test('500 when DynamoDB GetItem throws', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockDynamoSend.mockImplementation((cmd) => {
      const n = cmd?.constructor?.name;
      if (n === 'GetItemCommand') {
        return Promise.reject(new Error('throttle'));
      }
      return Promise.resolve({});
    });

    const handler = await getHandler();
    const res = await handler(baseEvent());

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toBe('Internal Server Error');
    errSpy.mockRestore();
  });

  test('X-Api-Key header variant works', async () => {
    mockDynamoSend.mockImplementation((cmd) => {
      const n = cmd?.constructor?.name;
      if (n === 'GetItemCommand') {
        return Promise.resolve({
          Item: {
            tagId: { S: 'tag-1' },
            allowed: { BOOL: true },
          },
        });
      }
      if (n === 'PutItemCommand') {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    const handler = await getHandler();
    const res = await handler({
      headers: { 'X-Api-Key': getUnitTestApiKey() },
      body: JSON.stringify({ tag: 'tag-1' }),
    });

    expect(res.statusCode).toBe(200);
  });
});

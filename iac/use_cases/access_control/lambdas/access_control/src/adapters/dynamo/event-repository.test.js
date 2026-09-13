'use strict';

const { DynamoEventRepository } = require('./event-repository');

const TABLE = { eventsTable: 'acme-dev-events' };

const SCAN = {
  tagId: 'E280',
  eventId: '1758000000000#abc',
  epochMs: 1758000000000,
  isoTime: '2026-09-16T05:20:00.000Z',
  decision: 'ALLOW',
  nodeId: 'node-1',
  clientTimestamp: '2026-09-16T05:19:59Z',
};

function dynamoOk() {
  return { send: jest.fn().mockResolvedValue({}) };
}

describe('record', () => {
  test('writes the decision and the origin of the read', async () => {
    const dynamo = dynamoOk();
    await new DynamoEventRepository(dynamo, TABLE).record(SCAN);

    const { Item, TableName } = dynamo.send.mock.calls[0][0].input;
    expect(TableName).toBe('acme-dev-events');
    expect(Item.decision.S).toBe('ALLOW');
    expect(Item.nodeId.S).toBe('node-1');
    expect(Item.clientTimestamp.S).toBe('2026-09-16T05:19:59Z');
    expect(Item.eventTime.N).toBe('1758000000000');
    expect(Item.eventTimeIso.S).toBe('2026-09-16T05:20:00.000Z');
  });

  test('the write is conditional, so a retried POST cannot duplicate it', async () => {
    const dynamo = dynamoOk();
    await new DynamoEventRepository(dynamo, TABLE).record(SCAN);

    expect(dynamo.send.mock.calls[0][0].input.ConditionExpression).toBe(
      'attribute_not_exists(tagId) AND attribute_not_exists(eventId)',
    );
  });

  test('optional fields are omitted rather than written empty', async () => {
    const dynamo = dynamoOk();
    await new DynamoEventRepository(dynamo, TABLE).record({
      ...SCAN,
      nodeId: undefined,
      clientTimestamp: undefined,
    });

    const { Item } = dynamo.send.mock.calls[0][0].input;
    expect(Item.nodeId).toBeUndefined();
    expect(Item.clientTimestamp).toBeUndefined();
  });

  test('a duplicate returns false instead of throwing', async () => {
    const error = new Error('The conditional request failed');
    error.name = 'ConditionalCheckFailedException';
    const dynamo = { send: jest.fn().mockRejectedValue(error) };

    expect(await new DynamoEventRepository(dynamo, TABLE).record(SCAN)).toBe(false);
  });

  test('any other DynamoDB failure still propagates', async () => {
    const dynamo = { send: jest.fn().mockRejectedValue(new Error('throttled')) };
    await expect(new DynamoEventRepository(dynamo, TABLE).record(SCAN)).rejects.toThrow('throttled');
  });
});

describe('the notification outcome', () => {
  test('is recorded on the row, which is the only place it is auditable', async () => {
    // It deliberately does not reach the HTTP body: the gateway caches
    // (status, body) per tag for 300 s, so a body that said "notified" would be
    // replayed to readings that notified nobody.
    const dynamo = dynamoOk();
    await new DynamoEventRepository(dynamo, TABLE).record({
      ...SCAN,
      decision: 'DENY',
      notified: true,
      notifyChannel: 'telegram',
    });

    const { Item } = dynamo.send.mock.calls[0][0].input;
    expect(Item.notified.BOOL).toBe(true);
    expect(Item.notifyChannel.S).toBe('telegram');
  });

  test('a denial nobody could be told about is written down as such', async () => {
    const dynamo = dynamoOk();
    await new DynamoEventRepository(dynamo, TABLE).record({
      ...SCAN,
      decision: 'DENY',
      notified: false,
      notifyChannel: 'NONE',
    });

    const { Item } = dynamo.send.mock.calls[0][0].input;
    expect(Item.notified.BOOL).toBe(false);
    expect(Item.notifyChannel.S).toBe('NONE');
  });

  test('a scan with no notification attempt carries neither attribute', async () => {
    const dynamo = dynamoOk();
    await new DynamoEventRepository(dynamo, TABLE).record(SCAN);

    const { Item } = dynamo.send.mock.calls[0][0].input;
    expect(Item.notified).toBeUndefined();
    expect(Item.notifyChannel).toBeUndefined();
  });
});

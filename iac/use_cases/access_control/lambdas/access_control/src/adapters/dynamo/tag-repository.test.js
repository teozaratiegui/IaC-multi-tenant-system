'use strict';

const { DynamoTagRepository } = require('./tag-repository');

const TABLE = { tagsTable: 'acme-dev-tags' };

function dynamoReturning(...results) {
  const send = jest.fn();
  for (const result of results) send.mockResolvedValueOnce(result);
  send.mockResolvedValue({});
  return { send };
}

function conditionalFailure() {
  const error = new Error('The conditional request failed');
  error.name = 'ConditionalCheckFailedException';
  return error;
}

const BOUND_ITEM = {
  tagId: { S: 'E280' },
  allowed: { BOOL: true },
  chatId: { S: '99' },
  tagName: { S: 'Bici' },
  tagNameNormalized: { S: 'bici' },
  ownerName: { S: 'Teo' },
  ownerLastName: { S: 'Zaratiegui' },
};

describe('findById', () => {
  test('reads the whole record, not just whether it is allowed', async () => {
    const dynamo = dynamoReturning({ Item: BOUND_ITEM });
    const record = await new DynamoTagRepository(dynamo, TABLE).findById('E280');

    expect(record).toEqual({
      tagId: 'E280',
      allowed: true,
      chatId: '99',
      tagName: 'Bici',
      tagNameNormalized: 'bici',
      ownerName: 'Teo',
      ownerLastName: 'Zaratiegui',
    });
  });

  test('a missing tag is null, not an empty record', async () => {
    expect(await new DynamoTagRepository(dynamoReturning({}), TABLE).findById('ghost')).toBeNull();
  });

  test('allowed is read from a boolean and from the legacy string form', async () => {
    const asString = dynamoReturning({ Item: { tagId: { S: 't' }, allowed: { S: 'true' } } });
    expect((await new DynamoTagRepository(asString, TABLE).findById('t')).allowed).toBe(true);
  });

  test('a row without the allowed attribute is treated as not allowed', async () => {
    const bare = dynamoReturning({ Item: { tagId: { S: 't' } } });
    expect((await new DynamoTagRepository(bare, TABLE).findById('t')).allowed).toBe(false);
  });

  test('only `chatId` is read — the two legacy spellings are gone', async () => {
    // The deployed code also accepted ownerChatId and notifyTo. Three ways to
    // write the field is three ways for the chat index not to see it.
    const legacy = dynamoReturning({ Item: { tagId: { S: 't' }, ownerChatId: { S: '99' } } });
    expect((await new DynamoTagRepository(legacy, TABLE).findById('t')).chatId).toBe('');
  });
});

describe('findByChatAndName', () => {
  test('is one Query for one item, not a full listing filtered in memory', async () => {
    // The GSI has tagNameNormalized as its range key precisely so this is a
    // point read. Filtering in RAM meant every /lock paid for every tag in the
    // chat, and the cost grew with the chat.
    const dynamo = dynamoReturning({ Items: [BOUND_ITEM] });
    const record = await new DynamoTagRepository(dynamo, TABLE).findByChatAndName('99', ' BICI ');

    expect(dynamo.send).toHaveBeenCalledTimes(1);
    const { input } = dynamo.send.mock.calls[0][0];
    expect(input.IndexName).toBe('chatId-index');
    expect(input.KeyConditionExpression).toBe(
      'chatId = :chatId AND tagNameNormalized = :tagNameNormalized',
    );
    expect(input.ExpressionAttributeValues[':tagNameNormalized'].S).toBe('bici');
    expect(input.Limit).toBe(1);
    expect(record.tagId).toBe('E280');
  });

  test('no match is null', async () => {
    const dynamo = dynamoReturning({ Items: [] });
    expect(await new DynamoTagRepository(dynamo, TABLE).findByChatAndName('99', 'auto')).toBeNull();
  });

  test('an empty name never reaches DynamoDB', async () => {
    const dynamo = dynamoReturning({ Items: [] });
    expect(await new DynamoTagRepository(dynamo, TABLE).findByChatAndName('99', '  ')).toBeNull();
    expect(dynamo.send).not.toHaveBeenCalled();
  });
});

describe('findByChat', () => {
  test('queries the index by chat alone and maps every row', async () => {
    const dynamo = dynamoReturning({ Items: [BOUND_ITEM, { ...BOUND_ITEM, tagId: { S: 'E281' } }] });
    const records = await new DynamoTagRepository(dynamo, TABLE).findByChat('99');

    const { input } = dynamo.send.mock.calls[0][0];
    expect(input.IndexName).toBe('chatId-index');
    expect(input.KeyConditionExpression).toBe('chatId = :chatId');
    expect(records).toHaveLength(2);
  });

  test('a chat with nothing bound to it is an empty list', async () => {
    expect(await new DynamoTagRepository(dynamoReturning({}), TABLE).findByChat('99')).toEqual([]);
  });
});

describe('associate', () => {
  const input = {
    tagId: 'E280',
    chatId: '99',
    tagName: ' Bici ',
    ownerName: 'Teo',
    ownerLastName: 'Zaratiegui',
  };

  test('writes chatId and tagNameNormalized in the same UpdateItem', async () => {
    // If they could ever be written apart, a crash between the two would leave
    // a tag bound to a chat but invisible in the index that lists it.
    const dynamo = dynamoReturning({});
    await new DynamoTagRepository(dynamo, TABLE).associate(input);

    const { input: written } = dynamo.send.mock.calls[0][0];
    expect(written.UpdateExpression).toContain('chatId = :chatId');
    expect(written.UpdateExpression).toContain('tagNameNormalized = :tagNameNormalized');
    expect(written.ExpressionAttributeValues[':chatId'].S).toBe('99');
    expect(written.ExpressionAttributeValues[':tagNameNormalized'].S).toBe('bici');
    expect(written.ExpressionAttributeValues[':tagName'].S).toBe('Bici');
    expect(written.ConditionExpression).toBe('attribute_exists(tagId)');
  });

  test('reports a tag that does not exist instead of creating one', async () => {
    // A mistyped EPC has to fail: silently creating a phantom tag is worse than
    // an error the operator can read.
    const dynamo = { send: jest.fn().mockRejectedValue(conditionalFailure()) };
    expect(await new DynamoTagRepository(dynamo, TABLE).associate(input)).toBe('not_found');
  });

  test('any other DynamoDB failure still propagates', async () => {
    const dynamo = { send: jest.fn().mockRejectedValue(new Error('throttled')) };
    await expect(new DynamoTagRepository(dynamo, TABLE).associate(input)).rejects.toThrow(
      'throttled',
    );
  });
});

describe('provision', () => {
  test('creates the tag and refuses to overwrite an existing one', async () => {
    const dynamo = dynamoReturning({});
    const result = await new DynamoTagRepository(dynamo, TABLE).provision({
      tagId: 'E280',
      allowed: true,
      registeredAt: '2026-09-12T10:00:00.000Z',
    });

    const { input } = dynamo.send.mock.calls[0][0];
    expect(result).toBe('created');
    expect(input.TableName).toBe('acme-dev-tags');
    expect(input.Item.allowed.BOOL).toBe(true);
    expect(input.Item.registeredAt.S).toBe('2026-09-12T10:00:00.000Z');
    expect(input.ConditionExpression).toBe('attribute_not_exists(tagId)');
  });

  test('an existing tag is a conflict, not an overwrite', async () => {
    const dynamo = { send: jest.fn().mockRejectedValue(conditionalFailure()) };
    expect(
      await new DynamoTagRepository(dynamo, TABLE).provision({ tagId: 'E280', allowed: true }),
    ).toBe('exists');
  });

  test('any other failure propagates — only the conditional check is an outcome', async () => {
    // The catch is there to turn one specific DynamoDB error into a domain
    // outcome. Everything else — throttling, a denied IAM policy, a table that
    // is not there — has to reach the handler and become a 500. Swallowing it
    // would answer 201 for a tag that was never written.
    const dynamo = { send: jest.fn().mockRejectedValue(new Error('ProvisionedThroughputExceeded')) };
    await expect(
      new DynamoTagRepository(dynamo, TABLE).provision({ tagId: 'E280', allowed: true }),
    ).rejects.toThrow('ProvisionedThroughputExceeded');
  });

  test('an optional association is written in the same item, both attributes', async () => {
    // Provisioning and binding in one call is the real operator gesture:
    // a new bike gets its tag and its owner at the same time.
    const dynamo = dynamoReturning({});
    await new DynamoTagRepository(dynamo, TABLE).provision({
      tagId: 'E280',
      allowed: true,
      association: {
        chatId: '99',
        tagName: 'Bici',
        tagNameNormalized: 'bici',
        ownerName: 'Teo',
        ownerLastName: 'Zaratiegui',
      },
    });

    const { Item } = dynamo.send.mock.calls[0][0].input;
    expect(Item.chatId.S).toBe('99');
    expect(Item.tagNameNormalized.S).toBe('bici');
  });
});

describe('setAllowed', () => {
  test('flips the flag on an existing tag only', async () => {
    const dynamo = dynamoReturning({});
    expect(await new DynamoTagRepository(dynamo, TABLE).setAllowed('E280', false)).toBe(true);

    const { input } = dynamo.send.mock.calls[0][0];
    expect(input.UpdateExpression).toBe('SET allowed = :allowed');
    expect(input.ExpressionAttributeValues[':allowed'].BOOL).toBe(false);
    expect(input.ConditionExpression).toBe('attribute_exists(tagId)');
  });

  test('a tag deleted between the lookup and the write reports false, not a crash', async () => {
    const dynamo = { send: jest.fn().mockRejectedValue(conditionalFailure()) };
    expect(await new DynamoTagRepository(dynamo, TABLE).setAllowed('E280', true)).toBe(false);
  });
});

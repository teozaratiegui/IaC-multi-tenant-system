'use strict';

const {
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
} = require('@aws-sdk/client-dynamodb');

const { CHAT_ID_INDEX, associationAttributes, normaliseTagName } = require('../../domain/tag');

/**
 * The tags table: `<org>-<env>-tags`, PK `tagId`, GSI `chatId-index`.
 *
 * The index is `chatId` + `tagNameNormalized`. The second key is what turns
 * "which tag is called 'bici' in this chat?" — every /status, /lock, /unlock and
 * every duplicate-name check — into a read of a single item. The deployed code
 * listed the whole chat and filtered in memory, so each command paid for every
 * tag its owner had. Adding a range key to a live GSI means destroying and
 * recreating it, so it was done while nothing was deployed.
 *
 * Nothing here reads process.env: the table name is injected by the handler.
 */
class DynamoTagRepository {
  constructor(dynamoClient, { tagsTable }) {
    this.dynamo = dynamoClient;
    this.tagsTable = tagsTable;
  }

  /** @returns {Promise<object|null>} the whole record, or null when there is none. */
  async findById(tagId) {
    const { Item } = await this.dynamo.send(
      new GetItemCommand({ TableName: this.tagsTable, Key: { tagId: { S: String(tagId) } } }),
    );
    return Item ? toRecord(Item) : null;
  }

  /** Every tag bound to a chat. Used by /status with no argument. */
  async findByChat(chatId) {
    const { Items = [] } = await this.dynamo.send(
      new QueryCommand({
        TableName: this.tagsTable,
        IndexName: CHAT_ID_INDEX,
        KeyConditionExpression: 'chatId = :chatId',
        ExpressionAttributeValues: { ':chatId': { S: String(chatId) } },
      }),
    );
    return Items.map(toRecord);
  }

  /** One tag, by the name its owner gave it. A point read on the index. */
  async findByChatAndName(chatId, tagName) {
    const normalized = normaliseTagName(tagName);
    if (!normalized) return null;

    const { Items = [] } = await this.dynamo.send(
      new QueryCommand({
        TableName: this.tagsTable,
        IndexName: CHAT_ID_INDEX,
        KeyConditionExpression: 'chatId = :chatId AND tagNameNormalized = :tagNameNormalized',
        ExpressionAttributeValues: {
          ':chatId': { S: String(chatId) },
          ':tagNameNormalized': { S: normalized },
        },
        Limit: 1,
      }),
    );
    return Items.length > 0 ? toRecord(Items[0]) : null;
  }

  /**
   * Binds an existing tag to a chat and an owner.
   *
   * `attribute_exists(tagId)` is what makes a mistyped EPC fail instead of
   * creating a phantom tag. Creating one is the separate `provision` operation.
   *
   * @returns {Promise<'ok'|'not_found'>}
   */
  async associate({ tagId, chatId, tagName, ownerName, ownerLastName }) {
    const attributes = associationAttributes({ chatId, tagName, ownerName, ownerLastName });

    try {
      await this.dynamo.send(
        new UpdateItemCommand({
          TableName: this.tagsTable,
          Key: { tagId: { S: String(tagId) } },
          // One statement, so chatId and tagNameNormalized can never be written
          // apart: an item with the first and not the second is absent from the
          // index that lists it.
          UpdateExpression:
            'SET chatId = :chatId, tagName = :tagName, tagNameNormalized = :tagNameNormalized, ' +
            'ownerName = :ownerName, ownerLastName = :ownerLastName',
          ExpressionAttributeValues: {
            ':chatId': { S: attributes.chatId },
            ':tagName': { S: attributes.tagName },
            ':tagNameNormalized': { S: attributes.tagNameNormalized },
            ':ownerName': { S: attributes.ownerName },
            ':ownerLastName': { S: attributes.ownerLastName },
          },
          ConditionExpression: 'attribute_exists(tagId)',
        }),
      );
    } catch (error) {
      if (error?.name === 'ConditionalCheckFailedException') return 'not_found';
      throw error;
    }
    return 'ok';
  }

  /**
   * Creates a tag. Optionally binds it in the same write, which is the real
   * gesture: a new bike gets its tag and its owner at once.
   *
   * @returns {Promise<'created'|'exists'>}
   */
  async provision({ tagId, allowed = true, registeredAt, association }) {
    const item = { tagId: { S: String(tagId) }, allowed: { BOOL: Boolean(allowed) } };
    if (registeredAt) item.registeredAt = { S: registeredAt };
    if (association) {
      item.chatId = { S: association.chatId };
      item.tagName = { S: association.tagName };
      item.tagNameNormalized = { S: association.tagNameNormalized };
      item.ownerName = { S: association.ownerName };
      item.ownerLastName = { S: association.ownerLastName };
    }

    try {
      await this.dynamo.send(
        new PutItemCommand({
          TableName: this.tagsTable,
          Item: item,
          ConditionExpression: 'attribute_not_exists(tagId)',
        }),
      );
    } catch (error) {
      if (error?.name === 'ConditionalCheckFailedException') return 'exists';
      throw error;
    }
    return 'created';
  }

  /** @returns {Promise<boolean>} false when the tag disappeared meanwhile. */
  async setAllowed(tagId, allowed) {
    try {
      await this.dynamo.send(
        new UpdateItemCommand({
          TableName: this.tagsTable,
          Key: { tagId: { S: String(tagId) } },
          UpdateExpression: 'SET allowed = :allowed',
          ExpressionAttributeValues: { ':allowed': { BOOL: Boolean(allowed) } },
          ConditionExpression: 'attribute_exists(tagId)',
        }),
      );
    } catch (error) {
      if (error?.name === 'ConditionalCheckFailedException') return false;
      throw error;
    }
    return true;
  }
}

/**
 * DynamoDB attribute values to a plain record.
 *
 * `chatId` has exactly one spelling here. The deployed code also accepted
 * `ownerChatId` and `notifyTo`, left over from an old migration; the index only
 * ever sees `chatId`, so the other two were rows that silently vanished from
 * their owner's listing.
 */
function toRecord(item) {
  return {
    tagId: item.tagId?.S ?? '',
    allowed: item.allowed?.BOOL === true || item.allowed?.S === 'true',
    chatId: item.chatId?.S ?? '',
    tagName: item.tagName?.S ?? '',
    tagNameNormalized: item.tagNameNormalized?.S ?? '',
    ownerName: item.ownerName?.S ?? '',
    ownerLastName: item.ownerLastName?.S ?? '',
  };
}

module.exports = { DynamoTagRepository };

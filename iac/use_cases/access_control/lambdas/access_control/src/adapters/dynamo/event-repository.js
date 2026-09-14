'use strict';

const { PutItemCommand } = require('@aws-sdk/client-dynamodb');

/**
 * The events table: `<org>-<env>-events`, PK `tagId`, SK `eventId`.
 *
 * The sort key is normally `<13-digit epoch ms>#<discriminator>`: zero-padded so
 * lexicographic order is chronological, and carrying a discriminator so the
 * write can be conditional. It replaced a plain `eventTime`, under which two
 * scans of the same tag in the same millisecond silently overwrote each other.
 *
 * "Normally", because one case gives the ordering up on purpose: a caller that
 * sends an opaque idempotency key and no reader timestamp gets that key as the
 * sort key, which deduplicates but does not sort. `domain/event.js` says why the
 * trade goes that way, and the use case logs each time it is taken — so a row
 * here is always deduplicated and *usually* range-queryable, never the reverse.
 */
class DynamoEventRepository {
  constructor(dynamoClient, { eventsTable }) {
    this.dynamo = dynamoClient;
    this.eventsTable = eventsTable;
  }

  /**
   * Records one scan.
   *
   * @returns {Promise<boolean>} true when a row was written, false when an
   *   identical event was already there (a retry) — which is a success, not an
   *   error, so the caller must not turn it into a 500.
   */
  async record(event) {
    const item = {
      tagId: { S: event.tagId },
      eventId: { S: event.eventId },
      eventTime: { N: String(event.epochMs) },
      eventTimeIso: { S: event.isoTime },
      decision: { S: event.decision },
    };

    // Who read the tag and when the reader saw it — without these the event is
    // just "this tag existed at some point", which is not traceability.
    if (event.nodeId) item.nodeId = { S: event.nodeId };
    if (event.clientTimestamp) item.clientTimestamp = { S: event.clientTimestamp };

    // Whether the owner was told, and through what. This is where that fact
    // lives: it deliberately never reaches the HTTP body, because the gateway
    // caches (status, body) per tag for 300 s and would replay "notified" to
    // readings that notified nobody.
    if (event.notified !== undefined) item.notified = { BOOL: Boolean(event.notified) };
    if (event.notifyChannel) item.notifyChannel = { S: event.notifyChannel };

    try {
      await this.dynamo.send(
        new PutItemCommand({
          TableName: this.eventsTable,
          Item: item,
          ConditionExpression: 'attribute_not_exists(tagId) AND attribute_not_exists(eventId)',
        }),
      );
      return true;
    } catch (error) {
      if (error?.name === 'ConditionalCheckFailedException') return false;
      throw error;
    }
  }
}

module.exports = { DynamoEventRepository };

const { DynamoDBClient, GetItemCommand, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

const dynamo = new DynamoDBClient({});
const ssm = new SSMClient({});

let cachedApiKey = null;

async function getExpectedApiKey() {
  if (cachedApiKey) return cachedApiKey;
  const name = process.env.API_KEY_PARAMETER_NAME;
  if (!name) throw new Error('API_KEY_PARAMETER_NAME not set');
  const res = await ssm.send(new GetParameterCommand({
    Name: name,
    WithDecryption: true,
  }));
  cachedApiKey = res.Parameter?.Value ?? '';
  return cachedApiKey;
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  // 1) API key check (valor en Parameter Store Standard = gratis)
  const received = event.headers?.['x-api-key'] ?? event.headers?.['X-Api-Key'] ?? '';
  try {
    const expected = await getExpectedApiKey();
    if (!received || received !== expected) {
      return response(401, { error: 'Unauthorized', message: 'Invalid or missing API key' });
    }
  } catch (e) {
    console.error('API key check failed', e);
    return response(500, { error: 'Internal Server Error' });
  }

  // 2) Parse POST body
  let tag, timestamp;
  try {
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body || {};
    tag = body.tag;
    timestamp = body.timestamp;
  } catch {
    return response(400, { error: 'Bad Request', message: 'Invalid JSON body' });
  }

  if (!tag) {
    return response(400, { error: 'Bad Request', message: 'Missing required field: tag' });
  }

  const tagsTableName = process.env.TAGS_TABLE_NAME;
  const eventsTableName = process.env.EVENTS_TABLE_NAME;
  const environment = (process.env.ENVIRONMENT || '').toLowerCase();

  if (!tagsTableName || !eventsTableName) {
    return response(500, { error: 'Internal Server Error' });
  }

  const tagIdStr = String(tag);
  const now = new Date();
  const eventTimeMs = now.getTime();
  const eventTimeIso = now.toISOString();

  function writeEvent() {
    return dynamo.send(new PutItemCommand({
      TableName: eventsTableName,
      Item: {
        tagId: { S: tagIdStr },
        eventTime: { N: String(eventTimeMs) },
      },
    }));
  }

  // 3) Look up tag in tags table (allowed or not)
  try {
    const { Item } = await dynamo.send(new GetItemCommand({
      TableName: tagsTableName,
      Key: {
        tagId: { S: tagIdStr },
      },
    }));

    if (!Item) {
      // In dev: auto-register unknown tag in tags (allowed=true) and record event
      if (environment === 'dev') {
        try {
          await dynamo.send(new PutItemCommand({
            TableName: tagsTableName,
            Item: {
              tagId: { S: tagIdStr },
              allowed: { BOOL: true },
            },
          }));
          await writeEvent();
        } catch (putErr) {
          console.error('Auto-register tag failed', putErr);
          return response(500, { error: 'Internal Server Error', message: 'Failed to register tag' });
        }
        return response(201, {
          ok: true,
          tag,
          timestamp: timestamp ?? eventTimeIso,
          message: 'Tag not found; registered and allowed (dev only)',
        });
      }
      await writeEvent();
      return response(404, { error: 'Not Found', message: 'Tag not found' });
    }

    const allowed = Item.allowed && (Item.allowed.BOOL === true || Item.allowed.S === 'true');
    await writeEvent();

    if (allowed) {
      return response(200, {
        ok: true,
        tag,
        timestamp: timestamp ?? eventTimeIso,
        message: 'Access allowed',
      });
    }

    return response(403, {
      error: 'Forbidden',
      message: 'Tag not allowed',
      tag,
    });
  } catch (e) {
    console.error('DynamoDB error', e);
    return response(500, { error: 'Internal Server Error' });
  }
};

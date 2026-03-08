const { DynamoDBClient, GetItemCommand } = require('@aws-sdk/client-dynamodb');
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

  const tableName = process.env.TABLE_NAME;
  if (!tableName) {
    return response(500, { error: 'Internal Server Error' });
  }

  // 3) Look up tag in DynamoDB
  try {
    const { Item } = await dynamo.send(new GetItemCommand({
      TableName: tableName,
      Key: {
        tagId: { S: String(tag) },
      },
    }));

    if (!Item) {
      return response(404, { error: 'Not Found', message: 'Tag not found' });
    }

    // DynamoDB stores BOOL as { BOOL: true/false }
    const allowed = Item.allowed && (Item.allowed.BOOL === true || Item.allowed.S === 'true');
    if (allowed) {
      return response(200, {
        ok: true,
        tag,
        timestamp: timestamp ?? new Date().toISOString(),
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

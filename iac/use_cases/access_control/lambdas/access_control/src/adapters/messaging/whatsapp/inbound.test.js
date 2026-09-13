'use strict';

const { createHmac } = require('node:crypto');
const { createWhatsAppInbound } = require('./inbound');

const APP_SECRET = 'app-secret';

function inboundWith(overrides = {}) {
  return createWhatsAppInbound({
    secretProvider: async () => APP_SECRET,
    verifyToken: 'verify-me',
    ...overrides,
  });
}

function signed(bodyObject, secret = APP_SECRET) {
  const body = JSON.stringify(bodyObject);
  const digest = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  return {
    headers: { 'x-hub-signature-256': `sha256=${digest}` },
    body,
    requestContext: { http: { method: 'POST' } },
  };
}

const MESSAGE = {
  entry: [
    {
      changes: [
        { value: { messages: [{ from: '5492211234567', type: 'text', text: { body: '/status' } }] } },
      ],
    },
  ],
};

describe('verifyRequest', () => {
  test('accepts a payload signed with the app secret', async () => {
    expect(await inboundWith().verifyRequest(signed(MESSAGE))).toMatchObject({ ok: true });
  });

  test('rejects a payload signed with the wrong secret', async () => {
    expect((await inboundWith().verifyRequest(signed(MESSAGE, 'not-the-secret'))).ok).toBe(false);
  });

  test('rejects a body that was altered after signing', async () => {
    const event = signed(MESSAGE);
    event.body = event.body.replace('5492211234567', '5490000000000');
    expect((await inboundWith().verifyRequest(event)).ok).toBe(false);
  });

  test('rejects a request with no signature header', async () => {
    const event = signed(MESSAGE);
    delete event.headers['x-hub-signature-256'];
    expect((await inboundWith().verifyRequest(event)).ok).toBe(false);
  });

  test('a deployment with no secret configured refuses everything', async () => {
    const inbound = inboundWith({ secretProvider: async () => '' });
    expect((await inbound.verifyRequest(signed(MESSAGE, ''))).ok).toBe(false);
  });

  test('signs over the decoded bytes when the Function URL base64-encodes them', async () => {
    const event = signed(MESSAGE);
    const encoded = {
      ...event,
      body: Buffer.from(event.body, 'utf8').toString('base64'),
      isBase64Encoded: true,
    };
    expect((await inboundWith().verifyRequest(encoded)).ok).toBe(true);
  });
});

describe('handleVerification', () => {
  test('echoes the challenge back as plain text when the token matches', async () => {
    const res = inboundWith().handleVerification({
      requestContext: { http: { method: 'GET' } },
      queryStringParameters: {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'verify-me',
        'hub.challenge': '31415',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/plain');
    expect(res.body).toBe('31415');
  });

  test('refuses a handshake with the wrong token', () => {
    const res = inboundWith().handleVerification({
      requestContext: { http: { method: 'GET' } },
      rawQueryString: 'hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=31415',
    });
    expect(res.statusCode).toBe(403);
  });

  test('leaves a POST alone — that is not a handshake', () => {
    expect(inboundWith().handleVerification(signed(MESSAGE))).toBeNull();
  });
});

describe('parseIncoming', () => {
  test('pulls the sender and the text out of a Graph payload', async () => {
    expect(await inboundWith().parseIncoming(signed(MESSAGE))).toMatchObject({
      from: '5492211234567',
      text: '/status',
    });
  });

  test('a button reply counts as text', async () => {
    const payload = {
      entry: [{ changes: [{ value: { messages: [{ from: '1', button: { text: '/help' } }] } }] }],
    };
    expect((await inboundWith().parseIncoming(signed(payload))).text).toBe('/help');
  });

  test('a status callback with no message yields an empty sender', async () => {
    const payload = { entry: [{ changes: [{ value: { statuses: [{ status: 'delivered' }] } }] }] };
    expect((await inboundWith().parseIncoming(signed(payload))).from).toBe('');
  });
});

describe('buildHttpResponse', () => {
  test('always 200, so Meta does not retry a command that already ran', () => {
    expect(inboundWith().buildHttpResponse({ success: false, errorMessage: 'boom' }).statusCode).toBe(
      200,
    );
  });
});

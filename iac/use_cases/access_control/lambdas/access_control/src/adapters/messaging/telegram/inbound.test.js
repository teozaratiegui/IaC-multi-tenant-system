'use strict';

const { createTelegramInbound } = require('./inbound');

function inboundWith(secret = 'webhook-secret') {
  return createTelegramInbound({ secretProvider: async () => secret });
}

function update(overrides = {}) {
  return {
    headers: { 'x-telegram-bot-api-secret-token': 'webhook-secret' },
    body: JSON.stringify({ update_id: 1, message: { chat: { id: 99 }, text: '/status' } }),
    ...overrides,
  };
}

describe('verifyRequest', () => {
  test('accepts the secret token Telegram was told to send', async () => {
    expect(await inboundWith().verifyRequest(update())).toMatchObject({ ok: true });
  });

  test('rejects a request with the wrong token, and with none at all', async () => {
    // Without this, the Function URL is public and the chat id is self-declared
    // in the body: anyone who found the URL could lock or unlock another
    // person's tags. It is the only authorisation the bot has.
    expect((await inboundWith().verifyRequest(update({ headers: {} }))).ok).toBe(false);
    expect(
      (await inboundWith().verifyRequest(update({ headers: { 'X-Telegram-Bot-Api-Secret-Token': 'nope' } })))
        .ok,
    ).toBe(false);
  });

  test('the header is matched case-insensitively', async () => {
    const event = update({ headers: { 'X-Telegram-Bot-Api-Secret-Token': 'webhook-secret' } });
    expect((await inboundWith().verifyRequest(event)).ok).toBe(true);
  });

  test('a deployment with no secret configured refuses everything', async () => {
    // Fail closed: an unset secret must not read as "no check required".
    expect((await inboundWith('').verifyRequest(update())).ok).toBe(false);
  });
});

describe('parseIncoming', () => {
  test('pulls the chat id and the text out of an update', async () => {
    expect(await inboundWith().parseIncoming(update())).toMatchObject({
      from: '99',
      text: '/status',
    });
  });

  test('an edited message is still a message', async () => {
    const event = update({
      body: JSON.stringify({ edited_message: { chat: { id: 7 }, text: '/help' } }),
    });
    expect(await inboundWith().parseIncoming(event)).toMatchObject({ from: '7', text: '/help' });
  });

  test('strips the @botname suffix Telegram adds in group chats', async () => {
    // A group sends "/status@mibot". Without this the bot answers "comando
    // desconocido" to a perfectly valid command, and only in groups.
    const event = update({
      body: JSON.stringify({ message: { chat: { id: 99 }, text: '/status@mibot bici' } }),
    });
    expect((await inboundWith().parseIncoming(event)).text).toBe('/status bici');
  });

  test('a payload with no message at all yields an empty sender', async () => {
    const event = update({ body: JSON.stringify({ update_id: 1 }) });
    expect((await inboundWith().parseIncoming(event)).from).toBe('');
  });

  test('a body that is not JSON does not throw', async () => {
    expect((await inboundWith().parseIncoming(update({ body: '{oops' }))).from).toBe('');
  });

  test('decodes a base64-encoded body, like the WhatsApp adapter does', async () => {
    // A Function URL base64-encodes the body whenever it does not recognise the
    // content type as text. Telegram sends application/json so this does not fire
    // today — but reading event.body raw meant that if it ever did, the sender
    // came back empty, the command was answered 200 and dropped, and Telegram
    // never retried it. Silent loss, no log, no redelivery.
    const payload = JSON.stringify({ message: { chat: { id: 99 }, text: '/lock bici' } });
    const event = update({
      body: Buffer.from(payload, 'utf8').toString('base64'),
      isBase64Encoded: true,
    });

    expect(await inboundWith().parseIncoming(event)).toMatchObject({
      from: '99',
      text: '/lock bici',
    });
  });
});

describe('buildHttpResponse', () => {
  test('answers 200 even when the command failed', async () => {
    // A non-2xx makes Telegram retry the same update indefinitely. The error
    // belongs in the body and the log, not in the status.
    const failed = inboundWith().buildHttpResponse({ success: false, errorMessage: 'boom' });
    expect(failed.statusCode).toBe(200);
    expect(JSON.parse(failed.body)).toMatchObject({ ok: false, error: 'boom' });
  });

  test('a success is 200 with no error', () => {
    const res = inboundWith().buildHttpResponse({ success: true });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).error).toBeNull();
  });
});

describe('handleVerification', () => {
  test('Telegram has no GET handshake', () => {
    expect(inboundWith().handleVerification).toBeUndefined();
  });
});

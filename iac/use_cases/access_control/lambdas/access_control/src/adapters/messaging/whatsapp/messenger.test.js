'use strict';

const { createWhatsAppMessenger } = require('./messenger');

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

function messengerWith(fetchFn, overrides = {}) {
  return createWhatsAppMessenger({
    tokenProvider: async () => 'graph-token',
    phoneNumberId: '12345',
    fetchFn,
    ...overrides,
  });
}

describe('a successful send', () => {
  test('posts a text message to the Graph API for this phone number', async () => {
    const fetchFn = jest.fn().mockResolvedValue(jsonResponse({ messages: [{ id: 'wamid' }] }));
    const result = await messengerWith(fetchFn).send({ to: '5492211234567', text: 'hola' });

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://graph.facebook.com/v19.0/12345/messages');
    expect(init.headers.Authorization).toBe('Bearer graph-token');
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: 'whatsapp',
      to: '5492211234567',
      type: 'text',
      text: { body: 'hola' },
    });
    expect(result).toMatchObject({ success: true, provider: 'whatsapp' });
  });
});

describe('a send that cannot succeed', () => {
  test('a missing phone number id is reported, not sent', async () => {
    const fetchFn = jest.fn();
    const result = await messengerWith(fetchFn, { phoneNumberId: '' }).send({ to: '1', text: 'x' });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.errorMessage).toContain('WHATSAPP_PHONE_NUMBER_ID');
  });

  test('an empty recipient never reaches the network', async () => {
    const fetchFn = jest.fn();
    expect((await messengerWith(fetchFn).send({ to: '', text: 'x' })).success).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test('a Graph error is reported with Meta’s own message', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValue(jsonResponse({ error: { message: 'Invalid OAuth token' } }, false, 401));
    const result = await messengerWith(fetchFn).send({ to: '1', text: 'x' });

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('Invalid OAuth token');
  });

  test('a provider that never answers is abandoned on the same budget', async () => {
    const fetchFn = jest.fn(
      (url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const error = new Error('The operation was aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );

    const result = await messengerWith(fetchFn, { timeoutMs: 20 }).send({ to: '1', text: 'x' });
    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/timed out|abort/i);
  });
});

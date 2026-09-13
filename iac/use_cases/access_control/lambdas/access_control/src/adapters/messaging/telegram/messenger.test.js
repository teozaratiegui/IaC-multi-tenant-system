'use strict';

const { createTelegramMessenger, DEFAULT_TIMEOUT_MS } = require('./messenger');

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

function messengerWith(fetchFn, overrides = {}) {
  return createTelegramMessenger({
    tokenProvider: async () => 'bot-token',
    fetchFn,
    ...overrides,
  });
}

describe('a successful send', () => {
  test('posts the chat id and the text to the bot API', async () => {
    const fetchFn = jest.fn().mockResolvedValue(jsonResponse({ ok: true, result: {} }));
    const result = await messengerWith(fetchFn).send({ to: '99', text: 'hola' });

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/botbot-token/sendMessage');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ chat_id: '99', text: 'hola' });
    expect(result).toMatchObject({ success: true, provider: 'telegram' });
  });

  test('the token is fetched through the provider, never read from the environment', async () => {
    const tokenProvider = jest.fn().mockResolvedValue('bot-token');
    const fetchFn = jest.fn().mockResolvedValue(jsonResponse({ ok: true }));
    await messengerWith(fetchFn, { tokenProvider }).send({ to: '99', text: 'hola' });

    expect(tokenProvider).toHaveBeenCalled();
  });
});

describe('a send that cannot succeed', () => {
  test('an empty recipient never reaches the network', async () => {
    const fetchFn = jest.fn();
    const result = await messengerWith(fetchFn).send({ to: '', text: 'hola' });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, provider: 'telegram' });
  });

  test('an API-level refusal is reported with Telegram’s own description', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValue(jsonResponse({ ok: false, description: 'chat not found' }, false, 400));
    const result = await messengerWith(fetchFn).send({ to: '99', text: 'hola' });

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('chat not found');
  });

  test('a 200 that says ok:false is still a failure', async () => {
    const fetchFn = jest.fn().mockResolvedValue(jsonResponse({ ok: false }));
    expect((await messengerWith(fetchFn).send({ to: '99', text: 'x' })).success).toBe(false);
  });

  test('a network error is returned, never thrown at the caller', async () => {
    // The scan path must answer the reader whatever the messaging provider does.
    const fetchFn = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    const result = await messengerWith(fetchFn).send({ to: '99', text: 'hola' });

    expect(result).toMatchObject({ success: false });
    expect(result.errorMessage).toContain('ECONNRESET');
  });
});

describe('the timeout', () => {
  test('a provider that never answers is abandoned, not waited on', async () => {
    // The function has a 4 s budget and the gateway gives up at 5 s. A hanging
    // Telegram would eat the whole budget while the event is already written,
    // and the gateway's retry would land as a second row (finding G3/I1).
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

    const started = Date.now();
    const result = await messengerWith(fetchFn, { timeoutMs: 20 }).send({ to: '99', text: 'x' });

    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/timed out|abort/i);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('every request carries an abort signal', async () => {
    const fetchFn = jest.fn().mockResolvedValue(jsonResponse({ ok: true }));
    await messengerWith(fetchFn).send({ to: '99', text: 'x' });

    expect(fetchFn.mock.calls[0][1].signal).toBeDefined();
  });

  test('the default budget is well under the function timeout', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(1500);
  });
});

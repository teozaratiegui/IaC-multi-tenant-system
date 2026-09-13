'use strict';

const { createMessenger, createInboundAdapter, PROVIDERS } = require('./registry');

const DEPS = {
  tokenProvider: async () => 'token',
  secretProvider: async () => 'secret',
  fetchFn: jest.fn(),
  whatsappPhoneNumberId: '12345',
  whatsappVerifyToken: 'verify',
};

describe('createMessenger', () => {
  test('`none` yields a messenger that does nothing, not a missing one', async () => {
    // Every call site then runs the same code path with messaging off, instead
    // of sprinkling `if (messagingEnabled)` through the use cases.
    const messenger = createMessenger('none', DEPS);
    expect(messenger.provider).toBe('none');
    expect(await messenger.send({ to: '99', text: 'hola' })).toMatchObject({ success: false });
    expect(DEPS.fetchFn).not.toHaveBeenCalled();
  });

  test('an absent provider is treated as `none`', async () => {
    expect(createMessenger(undefined, DEPS).provider).toBe('none');
    expect(createMessenger('', DEPS).provider).toBe('none');
  });

  test('builds the messenger each supported provider asks for', () => {
    expect(createMessenger('telegram', DEPS).provider).toBe('telegram');
    expect(createMessenger('whatsapp', DEPS).provider).toBe('whatsapp');
  });

  test('a provider nobody implemented fails loudly at composition time', () => {
    // Failing here — in the handler's composition root, on the first invoke —
    // is far better than a deployment that silently stops notifying.
    expect(() => createMessenger('signal', DEPS)).toThrow(/signal/);
  });

  test('every supported provider is listed, and `none` is one of them', () => {
    expect(PROVIDERS).toContain('none');
    expect(PROVIDERS).toContain('telegram');
    expect(PROVIDERS).toContain('whatsapp');
  });
});

describe('createInboundAdapter', () => {
  test('builds the adapter each supported provider asks for', () => {
    expect(createInboundAdapter('telegram', DEPS).provider).toBe('telegram');
    expect(createInboundAdapter('whatsapp', DEPS).provider).toBe('whatsapp');
  });

  test('there is no inbound side for `none`: the webhook is not even deployed', () => {
    expect(() => createInboundAdapter('none', DEPS)).toThrow();
  });

  test('a provider nobody implemented fails loudly', () => {
    expect(() => createInboundAdapter('signal', DEPS)).toThrow(/signal/);
  });
});

describe('every adapter honours the port', () => {
  test('outbound: a provider name and a send', () => {
    for (const provider of PROVIDERS) {
      const messenger = createMessenger(provider, DEPS);
      expect(typeof messenger.provider).toBe('string');
      expect(typeof messenger.send).toBe('function');
    }
  });

  test('inbound: a name, a verification, a parser and a response builder', () => {
    for (const provider of ['telegram', 'whatsapp']) {
      const inbound = createInboundAdapter(provider, DEPS);
      expect(typeof inbound.provider).toBe('string');
      expect(typeof inbound.verifyRequest).toBe('function');
      expect(typeof inbound.parseIncoming).toBe('function');
      expect(typeof inbound.buildHttpResponse).toBe('function');
    }
  });
});

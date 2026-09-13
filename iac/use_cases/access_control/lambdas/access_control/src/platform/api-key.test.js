'use strict';

const { ApiKeyVerifier, constantTimeEquals } = require('./api-key');

function readerReturning(value) {
  return { get: jest.fn().mockResolvedValue(value) };
}

describe('constantTimeEquals', () => {
  test('matches identical keys', () => {
    expect(constantTimeEquals('secret-key', 'secret-key')).toBe(true);
  });

  test('rejects a different key, a prefix and a longer key', () => {
    expect(constantTimeEquals('secret-key', 'secret-kez')).toBe(false);
    expect(constantTimeEquals('secret-ke', 'secret-key')).toBe(false);
    expect(constantTimeEquals('secret-key!', 'secret-key')).toBe(false);
  });

  test('an empty key never matches, even against an empty expected value', () => {
    // A caller that forgot to set its key must not be let through by a
    // parameter that happens to be empty too.
    expect(constantTimeEquals('', '')).toBe(false);
    expect(constantTimeEquals(undefined, 'secret')).toBe(false);
  });
});

describe('ApiKeyVerifier', () => {
  test('accepts the key the parameter holds', async () => {
    const verifier = new ApiKeyVerifier(readerReturning('k1'), '/acme/dev/api-key');
    expect(await verifier.matches('k1')).toBe(true);
  });

  test('reads through the shared parameter reader, which is what caches', async () => {
    const reader = readerReturning('k1');
    const verifier = new ApiKeyVerifier(reader, '/acme/dev/api-key');

    await verifier.matches('k1');

    expect(reader.get).toHaveBeenCalledWith('/acme/dev/api-key');
  });

  test('a parameter with no value rejects every key', async () => {
    const verifier = new ApiKeyVerifier(readerReturning(''), '/acme/dev/api-key');
    expect(await verifier.matches('anything')).toBe(false);
  });
});

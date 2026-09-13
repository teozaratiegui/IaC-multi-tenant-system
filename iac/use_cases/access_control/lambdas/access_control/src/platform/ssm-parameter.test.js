'use strict';

const { SsmParameterReader, DEFAULT_TTL_MS } = require('./ssm-parameter');

function ssmReturning(...values) {
  const send = jest.fn();
  for (const value of values) send.mockResolvedValueOnce({ Parameter: { Value: value } });
  send.mockResolvedValue({ Parameter: { Value: values[values.length - 1] } });
  return { send };
}

describe('SsmParameterReader', () => {
  test('asks for decryption, since every parameter it reads is a SecureString', async () => {
    const ssm = ssmReturning('v1');
    await new SsmParameterReader(ssm).get('/acme/dev/api-key');

    expect(ssm.send.mock.calls[0][0].input).toMatchObject({
      Name: '/acme/dev/api-key',
      WithDecryption: true,
    });
  });

  test('one fetch per interval: repeated reads inside the TTL cost no API call', async () => {
    let clock = 1000;
    const ssm = ssmReturning('v1');
    const reader = new SsmParameterReader(ssm, { ttlMs: 5000, now: () => clock });

    await reader.get('/p');
    clock += 4999;
    await reader.get('/p');

    expect(ssm.send).toHaveBeenCalledTimes(1);
  });

  test('a rotated value converges on its own once the TTL expires', async () => {
    // Cached for the life of the container, a rotated credential would be
    // refused by every warm container until AWS happened to recycle it — and
    // the gateway turns that 401 into `503 upstream_error`, so at the node it
    // looks exactly like the backend being down.
    let clock = 1000;
    const ssm = ssmReturning('old', 'new');
    const reader = new SsmParameterReader(ssm, { ttlMs: 5000, now: () => clock });

    expect(await reader.get('/p')).toBe('old');
    clock += 5001;
    expect(await reader.get('/p')).toBe('new');
    expect(ssm.send).toHaveBeenCalledTimes(2);
  });

  test('two parameter names get two caches, never one shared slot', async () => {
    // The rescued reader kept a single `cachedToken` with no key, so whichever
    // credential was read first was served to every later caller.
    const ssm = { send: jest.fn() };
    ssm.send.mockImplementation((command) =>
      Promise.resolve({ Parameter: { Value: `value-for${command.input.Name}` } }),
    );
    const reader = new SsmParameterReader(ssm);

    expect(await reader.get('/a')).toBe('value-for/a');
    expect(await reader.get('/b')).toBe('value-for/b');
    expect(await reader.get('/a')).toBe('value-for/a');
    expect(ssm.send).toHaveBeenCalledTimes(2);
  });

  test('a parameter with no value reads as the empty string, and is still cached', async () => {
    const ssm = { send: jest.fn().mockResolvedValue({}) };
    const reader = new SsmParameterReader(ssm);

    expect(await reader.get('/p')).toBe('');
    expect(await reader.get('/p')).toBe('');
    expect(ssm.send).toHaveBeenCalledTimes(1);
  });

  test('a missing name is a programming error, not an empty read', async () => {
    await expect(new SsmParameterReader({ send: jest.fn() }).get('')).rejects.toThrow();
  });

  test('a failed read is not cached, so the next call retries', async () => {
    const ssm = { send: jest.fn() };
    ssm.send.mockRejectedValueOnce(new Error('throttled'));
    ssm.send.mockResolvedValue({ Parameter: { Value: 'v1' } });
    const reader = new SsmParameterReader(ssm);

    await expect(reader.get('/p')).rejects.toThrow('throttled');
    expect(await reader.get('/p')).toBe('v1');
  });

  test('the default TTL is five minutes', () => {
    expect(DEFAULT_TTL_MS).toBe(5 * 60 * 1000);
  });
});

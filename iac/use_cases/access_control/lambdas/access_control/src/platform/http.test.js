'use strict';

const { response, header, parseBody } = require('./http');

describe('response', () => {
  test('serialises the body as JSON with the right content type', () => {
    const res = response(200, { ok: true });
    expect(res.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });
});

describe('header', () => {
  test('finds a header whatever its casing', () => {
    const event = { headers: { 'X-API-KEY': 'abc' } };
    expect(header(event, 'x-api-key')).toBe('abc');
  });

  test('returns undefined when there are no headers at all', () => {
    expect(header({}, 'x-api-key')).toBeUndefined();
    expect(header(undefined, 'x-api-key')).toBeUndefined();
  });
});

describe('parseBody', () => {
  test('parses a JSON string body', () => {
    expect(parseBody({ body: '{"tag":"A1"}' })).toEqual({ tag: 'A1' });
  });

  test('accepts an already-parsed object', () => {
    expect(parseBody({ body: { tag: 'A1' } })).toEqual({ tag: 'A1' });
  });

  test('treats an empty body as an empty object', () => {
    expect(parseBody({})).toEqual({});
    expect(parseBody({ body: '' })).toEqual({});
  });

  test('returns null for malformed JSON and for a bare JSON scalar', () => {
    expect(parseBody({ body: '{oops' })).toBeNull();
    expect(parseBody({ body: '"just a string"' })).toBeNull();
  });

  test('decodes a base64 body, which a Function URL sends for unknown content types', () => {
    const raw = Buffer.from('{"tag":"A1"}', 'utf8').toString('base64');
    expect(parseBody({ body: raw, isBase64Encoded: true })).toEqual({ tag: 'A1' });
  });
});

describe('httpMethod', () => {
  const { httpMethod } = require('./http');

  test('reads the method from a Function URL event and from a REST one', () => {
    expect(httpMethod({ requestContext: { http: { method: 'get' } } })).toBe('GET');
    expect(httpMethod({ httpMethod: 'post' })).toBe('POST');
  });

  test('defaults to POST, which is what every provider sends', () => {
    expect(httpMethod({})).toBe('POST');
  });
});

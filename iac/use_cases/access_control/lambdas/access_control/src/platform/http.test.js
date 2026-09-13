'use strict';

const { response, header, headerText, parseBody } = require('./http');

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

describe('headerText', () => {
  test('a miss is the empty string, so callers can compare and slice safely', () => {
    // The inbound adapters both compare and slice this value (a shared secret,
    // an `sha256=` prefix). They used to carry a copy of the lookup each, and
    // the copies disagreed about a miss.
    expect(headerText({ headers: { 'X-Secret': 'abc' } }, 'x-secret')).toBe('abc');
    expect(headerText({}, 'x-secret')).toBe('');
    expect(headerText(undefined, 'x-secret')).toBe('');
    expect(headerText({ headers: { 'x-secret': 42 } }, 'x-secret')).toBe('42');
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

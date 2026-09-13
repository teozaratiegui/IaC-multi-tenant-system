'use strict';

/**
 * HTTP mechanics: shaping a reply, reading a header, parsing a body.
 *
 * Deliberately free of business vocabulary. Which status a decision deserves is
 * a fact about the contract with the Fog gateway, so it lives in
 * domain/decisions.js — the domain layer is not allowed to import this file,
 * and putting the status table here would have forced it to.
 */

function response(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** Reply with a plain-text body — the WhatsApp verification handshake needs it. */
function textResponse(statusCode, text) {
  return {
    statusCode,
    headers: { 'Content-Type': 'text/plain' },
    body: String(text),
  };
}

/** Header lookup that ignores case, because API Gateway and Function URLs differ. */
function header(event, name) {
  const headers = event?.headers ?? {};
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/**
 * The same lookup, as a string, with a miss as the empty string.
 *
 * For callers that are about to compare or slice the value: a shared secret,
 * an HMAC signature. Each inbound adapter used to carry its own copy of this,
 * and the three copies disagreed about a miss — `undefined` here, `''` there,
 * `String(value)` in the third — which is precisely the kind of difference that
 * decides whether a missing header throws or fails closed.
 */
function headerText(event, name) {
  return String(header(event, name) ?? '');
}

/** The request method, normalised. A Function URL and a REST event spell it differently. */
function httpMethod(event) {
  const raw = event?.requestContext?.http?.method || event?.httpMethod || 'POST';
  return String(raw).toUpperCase();
}

/** Query string, whether it arrives raw or already split. */
function queryParams(event) {
  const raw = event?.rawQueryString || event?.queryStringParameters;
  if (typeof raw === 'string' && raw.length > 0) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  if (raw && typeof raw === 'object') return raw;
  return {};
}

/** The body exactly as it arrived, decoded but not parsed — HMAC signatures cover these bytes. */
function rawBody(event) {
  const raw = event?.body;
  if (typeof raw !== 'string') return '';
  if (!event?.isBase64Encoded) return raw;
  try {
    return Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Parses the request body; throws nothing, returns null when it is not JSON.
 *
 * A Function URL base64-encodes the body whenever it does not recognise the
 * content type as text. Both callers send `application/json` today
 * (thesis-sketch/src/infrastructure/aws/aws_client.py:33 and
 * firmware/lib/MessageGateway/HttpTransport.cpp:79), so this does not fire —
 * but without it the first caller that sets a different content type gets a
 * silent 400 with nothing in the logs to explain it.
 */
function parseBody(event) {
  const raw = event?.body;
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw !== 'string') return raw;

  const decoded = rawBody(event);
  if (decoded === '' && event?.isBase64Encoded) return null;

  try {
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

module.exports = {
  response,
  textResponse,
  header,
  headerText,
  httpMethod,
  queryParams,
  rawBody,
  parseBody,
};

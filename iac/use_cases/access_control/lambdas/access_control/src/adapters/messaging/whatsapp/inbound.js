'use strict';

const { createHmac, timingSafeEqual } = require('node:crypto');
const {
  headerText,
  httpMethod,
  parseBody,
  queryParams,
  rawBody,
  textResponse,
} = require('../../../platform/http');
const { acknowledge } = require('../inbound-ack');

const SIGNATURE_HEADER = 'x-hub-signature-256';

/**
 * Inbound WhatsApp webhook.
 *
 * Two provider-specific mechanisms, which is precisely why verification sits
 * behind the inbound port instead of in the handler:
 *
 *   - a GET subscription handshake that echoes `hub.challenge`;
 *   - an HMAC-SHA256 of the raw request body, keyed by the app secret, in
 *     `X-Hub-Signature-256`.
 *
 * @param {{secretProvider: () => Promise<string>, verifyToken?: string}} deps
 * @returns {import('../ports').InboundAdapter}
 */
function createWhatsAppInbound({ secretProvider, verifyToken = '' } = {}) {
  return {
    provider: 'whatsapp',

    /**
     * Meta's subscription handshake. The 403 here is the provider's own
     * contract for a rejected handshake; it never reaches a reader, which is
     * why it is a literal rather than a value in the decision table.
     */
    handleVerification(event) {
      if (httpMethod(event) !== 'GET') return null;

      const query = queryParams(event);
      const challenge = query['hub.challenge'];
      const tokenMatches = Boolean(verifyToken) && query['hub.verify_token'] === verifyToken;

      if (query['hub.mode'] === 'subscribe' && tokenMatches && challenge) {
        return textResponse(200, challenge);
      }
      return {
        statusCode: 403,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Forbidden', message: 'Invalid webhook verification' }),
      };
    },

    /**
     * The signature covers the exact bytes Meta sent, so it is computed over the
     * raw body — decoded first when the Function URL base64-encoded it, and
     * never over a re-serialised object, which would reorder keys and fail.
     */
    async verifyRequest(event) {
      const appSecret = await secretProvider();
      if (!appSecret) return { ok: false, reason: 'webhook secret is not configured' };

      const received = headerText(event, SIGNATURE_HEADER);
      if (!received.startsWith('sha256=')) return { ok: false, reason: 'missing signature' };

      const expected = createHmac('sha256', appSecret).update(rawBody(event), 'utf8').digest('hex');
      if (!hexEquals(received.slice('sha256='.length), expected)) {
        return { ok: false, reason: 'signature mismatch' };
      }
      return { ok: true };
    },

    async parseIncoming(event) {
      const body = parseBody(event) ?? {};
      const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0] ?? {};
      return {
        from: String(message.from ?? ''),
        text: String(message.text?.body ?? message.button?.text ?? ''),
      };
    },

    /** Always 200: a non-2xx makes Meta redeliver a command that already ran. */
    buildHttpResponse: acknowledge,
  };
}

function hexEquals(a, b) {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

module.exports = { createWhatsAppInbound };

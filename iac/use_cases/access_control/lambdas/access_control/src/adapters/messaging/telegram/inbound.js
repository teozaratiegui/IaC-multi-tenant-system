'use strict';

const { constantTimeEquals } = require('../../../platform/api-key');
const { headerText, parseBody } = require('../../../platform/http');
const { acknowledge } = require('../inbound-ack');

/** Telegram sends this header on every webhook call when setWebhook was given a secret_token. */
const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

/** In a group, Telegram appends the bot's username: "/status@mibot bici". */
const BOT_SUFFIX = /^(\/[a-z0-9_]+)@[a-z0-9_]+/i;

/**
 * Inbound Telegram webhook.
 *
 * @param {{secretProvider: () => Promise<string>}} deps
 * @returns {import('../ports').InboundAdapter}
 */
function createTelegramInbound({ secretProvider } = {}) {
  return {
    provider: 'telegram',

    /**
     * Telegram's `secret_token`, echoed back in a header on every call.
     *
     * Without it this endpoint has no authentication whatsoever: the Function
     * URL is public and the chat id is self-declared in the body, so anyone who
     * found the URL could lock or unlock someone else's tags. An unset secret
     * fails closed — it must not read as "no check required".
     */
    async verifyRequest(event) {
      const expected = await secretProvider();
      if (!expected) return { ok: false, reason: 'webhook secret is not configured' };

      const received = headerText(event, SECRET_HEADER);
      if (!constantTimeEquals(received, expected)) {
        return { ok: false, reason: 'secret token mismatch' };
      }
      return { ok: true };
    },

    async parseIncoming(event) {
      // Through the shared `parseBody`, which decodes before parsing: a Function
      // URL base64-encodes the body whenever it does not recognise the content
      // type as text. Telegram sends application/json so it does not fire today —
      // but reading `event.body` raw means that if it ever did, JSON.parse would
      // fail silently, the sender would come back empty, and the command would be
      // answered 200 and dropped with Telegram never retrying it.
      const body = parseBody(event) ?? {};
      const message = body.message || body.edited_message || {};
      return {
        from: String(message.chat?.id ?? ''),
        // The @botname suffix is stripped here rather than in the command
        // parser: it is a Telegram convention, so it belongs to the Telegram
        // adapter. The parser stays provider-agnostic.
        text: stripBotSuffix(String(message.text ?? '')),
      };
    },

    /** Always 200, even for a failed command — see `acknowledge`. */
    buildHttpResponse: acknowledge,
  };
}

function stripBotSuffix(text) {
  return text.replace(BOT_SUFFIX, '$1');
}

module.exports = { createTelegramInbound };

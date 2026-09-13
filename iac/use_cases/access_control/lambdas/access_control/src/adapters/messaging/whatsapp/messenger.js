'use strict';

const { postJson, sendFailure, DEFAULT_TIMEOUT_MS } = require('../http-send');

const GRAPH_VERSION = 'v19.0';

/**
 * Sends a message through the WhatsApp Cloud API.
 *
 * @param {{tokenProvider: () => Promise<string>, phoneNumberId?: string,
 *          fetchFn?: Function, timeoutMs?: number}} deps
 * @returns {import('../ports').Messenger}
 */
function createWhatsAppMessenger({
  tokenProvider,
  phoneNumberId,
  fetchFn = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const provider = 'whatsapp';

  return {
    provider,

    async send(message) {
      if (!phoneNumberId) {
        return { success: false, provider, errorMessage: 'WHATSAPP_PHONE_NUMBER_ID is not set' };
      }
      if (!message?.to) {
        return { success: false, provider, errorMessage: 'WhatsApp recipient is empty' };
      }

      try {
        const token = await tokenProvider();
        const { response, data } = await postJson(
          fetchFn,
          `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
          {
            headers: { Authorization: `Bearer ${token}` },
            body: {
              messaging_product: 'whatsapp',
              to: String(message.to),
              type: 'text',
              text: { body: message.text },
            },
            timeoutMs,
          },
        );

        if (!response.ok) {
          return {
            success: false,
            provider,
            errorMessage: data?.error?.message || `WhatsApp send failed (${response.status})`,
          };
        }
        return { success: true, provider };
      } catch (error) {
        return sendFailure(provider, error, timeoutMs);
      }
    },
  };
}

module.exports = { createWhatsAppMessenger };

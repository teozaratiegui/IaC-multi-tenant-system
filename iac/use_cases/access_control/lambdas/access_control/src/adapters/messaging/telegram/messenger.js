'use strict';

const { postJson, sendFailure, DEFAULT_TIMEOUT_MS } = require('../http-send');

/**
 * Sends a message through the Telegram Bot API.
 *
 * A factory rather than a module-level object, and the bot token arrives as an
 * injected `tokenProvider` rather than being read from SSM inside: that is what
 * makes it testable with a fake `fetch` and no module mocking, and it is what
 * lets one cached SSM reader serve every credential this package uses.
 *
 * @param {{tokenProvider: () => Promise<string>, fetchFn?: Function, timeoutMs?: number}} deps
 * @returns {import('../ports').Messenger}
 */
function createTelegramMessenger({
  tokenProvider,
  fetchFn = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const provider = 'telegram';

  return {
    provider,

    async send(message) {
      if (!message?.to) {
        return { success: false, provider, errorMessage: 'Telegram chat id is empty' };
      }

      try {
        const token = await tokenProvider();
        const { response, data } = await postJson(
          fetchFn,
          `https://api.telegram.org/bot${token}/sendMessage`,
          { body: { chat_id: String(message.to), text: message.text }, timeoutMs },
        );

        // Telegram answers 200 with `ok: false` for application-level refusals
        // such as "chat not found", so the HTTP status alone is not the verdict.
        if (!response.ok || !data?.ok) {
          return {
            success: false,
            provider,
            errorMessage: data?.description || `Telegram sendMessage failed (${response.status})`,
          };
        }
        return { success: true, provider };
      } catch (error) {
        return sendFailure(provider, error, timeoutMs);
      }
    },
  };
}

module.exports = { createTelegramMessenger, DEFAULT_TIMEOUT_MS };

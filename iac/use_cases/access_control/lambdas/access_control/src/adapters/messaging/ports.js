'use strict';

/**
 * The two ports the messaging layer exposes. Provider-agnostic by construction:
 * a use case that notifies an owner or answers a bot command never learns
 * whether the channel is Telegram, WhatsApp or nothing at all.
 *
 * Adding a provider is a directory with two files, one line in registry.js and
 * one more value in the `messaging_provider` validation in Terraform. Nothing
 * else changes — that is what the port is for.
 *
 * @typedef {Object} OutboundMessage
 * @property {string} to    provider-specific recipient (chat id, phone number)
 * @property {string} text
 *
 * @typedef {Object} SendResult
 * @property {boolean} success
 * @property {string} provider
 * @property {string} [errorMessage]
 *
 * @typedef {Object} Messenger
 * @property {string} provider
 * @property {(message: OutboundMessage) => Promise<SendResult>} send
 *   Never throws: the scan path has to answer the reader whatever the provider
 *   does, so a failure comes back as `success: false`.
 *
 * @typedef {Object} InboundMessage
 * @property {string} from
 * @property {string} text
 *
 * @typedef {Object} HttpResponse
 * @property {number} statusCode
 * @property {Record<string,string>} headers
 * @property {string} body
 *
 * @typedef {Object} InboundAdapter
 * @property {string} provider
 * @property {(event: object) => Promise<{ok: boolean, reason?: string}>} verifyRequest
 *   Proves the request really came from the provider. The mechanism is
 *   provider-specific — a shared secret header for Telegram, an HMAC over the
 *   body for WhatsApp — which is exactly why it belongs behind this port and
 *   not in the handler. It is async because the secret comes from SSM.
 * @property {(event: object) => HttpResponse | null} [handleVerification]
 *   The provider's subscription handshake, when it has one.
 * @property {(event: object) => Promise<InboundMessage>} parseIncoming
 * @property {(result: {success: boolean, errorMessage?: string}) => HttpResponse} buildHttpResponse
 */

module.exports = {};

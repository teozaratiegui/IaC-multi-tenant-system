'use strict';

const { createNullMessenger } = require('./null-messenger');
const { createTelegramMessenger } = require('./telegram/messenger');
const { createTelegramInbound } = require('./telegram/inbound');
const { createWhatsAppMessenger } = require('./whatsapp/messenger');
const { createWhatsAppInbound } = require('./whatsapp/inbound');

/**
 * Provider name to implementation.
 *
 * Which one a tenant gets is decided by `MESSAGING_PROVIDER`, injected by
 * Terraform from `var.messaging_provider`. Moving an organisation from Telegram
 * to WhatsApp is one line in its terraform.tfvars and an apply: no code.
 */
const PROVIDERS = ['none', 'telegram', 'whatsapp'];

/**
 * @param {string} provider
 * @param {{tokenProvider: () => Promise<string>, fetchFn?: Function,
 *          timeoutMs?: number, whatsappPhoneNumberId?: string}} deps
 * @returns {import('./ports').Messenger}
 */
function createMessenger(provider, deps = {}) {
  const name = normalise(provider);

  if (name === 'none') return createNullMessenger();
  if (name === 'telegram') return createTelegramMessenger(deps);
  if (name === 'whatsapp') {
    return createWhatsAppMessenger({ ...deps, phoneNumberId: deps.whatsappPhoneNumberId });
  }

  // Loudly, in the composition root, on the first invoke — rather than a
  // deployment that quietly stops notifying anyone.
  throw new Error(`Unsupported messaging provider: ${provider}`);
}

/**
 * @param {string} provider
 * @param {{secretProvider: () => Promise<string>, whatsappVerifyToken?: string}} deps
 * @returns {import('./ports').InboundAdapter}
 */
function createInboundAdapter(provider, deps = {}) {
  const name = normalise(provider);

  if (name === 'telegram') return createTelegramInbound(deps);
  if (name === 'whatsapp') {
    return createWhatsAppInbound({ ...deps, verifyToken: deps.whatsappVerifyToken });
  }

  // There is no inbound side for `none`: Terraform does not deploy the webhook
  // function at all in that case (count = 0), so reaching here is a bug.
  throw new Error(`Unsupported inbound messaging provider: ${provider}`);
}

function normalise(provider) {
  return String(provider ?? '').trim().toLowerCase() || 'none';
}

module.exports = { PROVIDERS, createMessenger, createInboundAdapter };

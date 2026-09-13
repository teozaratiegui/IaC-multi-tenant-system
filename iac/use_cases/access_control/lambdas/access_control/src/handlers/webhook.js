'use strict';

/**
 * webhook — inbound messages from the messaging provider.
 *
 * No API key here: the caller is the provider, and it proves who it is with its
 * own mechanism — a shared secret header for Telegram, an HMAC over the body for
 * WhatsApp. Both live behind the inbound port, because the mechanism is exactly
 * the part that differs per provider.
 *
 * That check is new. The deployed code verified nothing at all: it parsed the
 * body, took `message.chat.id` and ran the command. With a public Function URL
 * and a self-declared chat id, anyone who found the URL could lock or unlock
 * somebody else's tags.
 *
 * The other deliberate choice: once a command has been accepted, the answer is
 * always 200. A non-2xx makes Telegram redeliver the same update indefinitely —
 * for a command that may already have taken effect. Failures go in the body and
 * in the log.
 *
 * Composition root: the only file here that builds AWS clients and reads env.
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { SSMClient } = require('@aws-sdk/client-ssm');

const { SsmParameterReader } = require('../platform/ssm-parameter');
const { loadConfig, validateConfig, messagingEnabled } = require('../platform/config');

// The webhook secret is listed because it is the *only* thing authenticating
// this endpoint: no x-api-key, a public Function URL, and a sender id the body
// declares about itself. Without it the adapter refuses every request, which is
// the right failure — but it surfaces as an opaque 500 on the first inbound
// message instead of the explicit misconfiguration log the other two handlers
// get. CONTRACT.md §2 has always marked it required.
const REQUIREMENTS = {
  tagsTable: 'TAGS_TABLE_NAME',
  messagingTokenParameterName: 'MESSAGING_TOKEN_PARAMETER_NAME',
  webhookSecretParameterName: 'WEBHOOK_SECRET_PARAMETER_NAME',
};
const { response, httpMethod } = require('../platform/http');
const { STATUS } = require('../domain/decisions');
const { createMessages } = require('../domain/messages');
const { DynamoTagRepository } = require('../adapters/dynamo/tag-repository');
const { createMessenger, createInboundAdapter } = require('../adapters/messaging/registry');
const { RunBotCommandUseCase } = require('../use_cases/run-bot-command');

const dynamo = new DynamoDBClient({});
const ssm = new SSMClient({});
const parameters = new SsmParameterReader(ssm);

exports.handler = async (event) => {
  const config = loadConfig();

  // Not part of REQUIREMENTS: loadConfig defaults the provider to the string
  // 'none', which is present but unusable, so the emptiness check cannot see it.
  const problems = validateConfig(config, REQUIREMENTS);
  if (!messagingEnabled(config)) problems.push('MESSAGING_PROVIDER is not set');
  if (problems.length > 0) {
    console.error('Misconfigured deployment:', problems.join('; '));
    return response(STATUS.INTERNAL_ERROR, { error: 'Internal Server Error' });
  }

  let inbound;
  let messenger;
  try {
    inbound = createInboundAdapter(config.messagingProvider, {
      secretProvider: () => parameters.get(config.webhookSecretParameterName),
      whatsappVerifyToken: config.whatsappVerifyToken,
    });
    messenger = createMessenger(config.messagingProvider, {
      tokenProvider: () => parameters.get(config.messagingTokenParameterName),
      whatsappPhoneNumberId: config.whatsappPhoneNumberId,
    });
  } catch (error) {
    console.error('Unsupported messaging provider', error);
    return response(STATUS.INTERNAL_ERROR, { error: 'Internal Server Error' });
  }

  // 1. The provider's subscription handshake, for the providers that have one.
  if (httpMethod(event) === 'GET') {
    const verification = inbound.handleVerification?.(event);
    if (verification) return verification;
    return response(STATUS.METHOD_NOT_ALLOWED, { error: 'Method Not Allowed' });
  }

  // 2. Prove the request came from the provider, before anything is parsed or
  //    read. A failure here answers 401 and runs nothing: the provider retries,
  //    and a forged request simply fails.
  try {
    const verified = await inbound.verifyRequest(event);
    if (!verified.ok) {
      console.warn('Rejected webhook request', {
        provider: inbound.provider,
        reason: verified.reason,
        sourceIp: event?.requestContext?.http?.sourceIp,
      });
      return response(STATUS.UNAUTHORIZED, {
        error: 'Unauthorized',
        message: 'Webhook verification failed',
      });
    }
  } catch (error) {
    console.error('Webhook verification failed', error);
    return response(STATUS.INTERNAL_ERROR, { error: 'Internal Server Error' });
  }

  // 3. Run the command and answer through the same channel it arrived on.
  try {
    const incoming = await inbound.parseIncoming(event);
    if (!incoming.from) {
      return inbound.buildHttpResponse({
        success: false,
        provider: inbound.provider,
        errorMessage: 'Could not resolve the sender from the webhook payload',
      });
    }

    const useCase = new RunBotCommandUseCase({
      tagRepository: new DynamoTagRepository(dynamo, config),
      messages: createMessages(config),
    });

    const { replyText } = await useCase.execute(incoming);
    const sent = await messenger.send({ to: incoming.from, text: replyText });
    return inbound.buildHttpResponse(sent);
  } catch (error) {
    console.error('Webhook command failed', error);
    return inbound.buildHttpResponse({
      success: false,
      provider: inbound.provider,
      errorMessage: error?.message ?? 'Unknown error',
    });
  }
};

exports.__resetForTests = () => {
  parameters.clear();
};

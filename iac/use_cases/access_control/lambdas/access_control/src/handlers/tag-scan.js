'use strict';

/**
 * tag-scan — a reader saw a tag.
 *
 * Contract with the Fog gateway:
 *     POST <function url>          header  x-api-key: <key from SSM>
 *     body {"tag": "<epc>"}        optional "nodeId", "timestamp", "eventId"
 *
 * The gateway sends only `tag` today (finding G1); `nodeId` and `timestamp` are
 * accepted now so the day it forwards them nothing has to be redeployed.
 *
 * This file is a composition root, and the only kind of file that is one: it is
 * where AWS clients are constructed, where process.env is read, and where the
 * dependency graph is wired. Nothing under use_cases/ or domain/ imports an
 * adapter, an AWS SDK or an environment variable — a rule that architecture.test.js
 * enforces, and the same rule the Fog gateway's own composition root follows.
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { SSMClient } = require('@aws-sdk/client-ssm');

const { SsmParameterReader } = require('../platform/ssm-parameter');
const { ApiKeyVerifier } = require('../platform/api-key');
const { loadConfig, validateConfig } = require('../platform/config');

/** What this handler cannot run without, mapped to the variable that sets it. */
const REQUIREMENTS = {
  tagsTable: 'TAGS_TABLE_NAME',
  eventsTable: 'EVENTS_TABLE_NAME',
  apiKeyParameterName: 'API_KEY_PARAMETER_NAME',
};
const { response, header, parseBody } = require('../platform/http');
const { STATUS } = require('../domain/decisions');
const { normaliseTag } = require('../domain/event');
const { createMessages } = require('../domain/messages');
const { DynamoTagRepository } = require('../adapters/dynamo/tag-repository');
const { DynamoEventRepository } = require('../adapters/dynamo/event-repository');
const { createMessenger } = require('../adapters/messaging/registry');
const { ScanTagUseCase } = require('../use_cases/scan-tag');

// Built once per execution environment. The parameter reader is shared by every
// credential this function needs — one cache, keyed by parameter name.
const dynamo = new DynamoDBClient({});
const ssm = new SSMClient({});
const parameters = new SsmParameterReader(ssm);

// Keyed by parameter name: without that, a verifier built for one deployment
// would be reused after the name changed, and the check would be a lie.
let verifier = null;

function getVerifier(parameterName) {
  if (!verifier || verifier.parameterName !== parameterName) {
    verifier = new ApiKeyVerifier(parameters, parameterName);
  }
  return verifier;
}

exports.handler = async (event) => {
  const config = loadConfig();

  const problems = validateConfig(config, REQUIREMENTS);
  if (problems.length > 0) {
    console.error('Misconfigured deployment:', problems.join('; '));
    return response(STATUS.INTERNAL_ERROR, { error: 'Internal Server Error' });
  }

  // 1. Authenticate the caller.
  try {
    const received = header(event, 'x-api-key') ?? '';
    if (!(await getVerifier(config.apiKeyParameterName).matches(received))) {
      // The gateway collapses a 401 into `503 upstream_error` before the node
      // sees it (relay_tag_read.py:147), so at the reader a wrong key looks
      // exactly like an outage. This line is the only place the difference is
      // recorded — do not remove it without replacing it.
      console.warn('Rejected API key', {
        present: received !== '',
        sourceIp: event?.requestContext?.http?.sourceIp,
        userAgent: event?.requestContext?.http?.userAgent,
        parameter: config.apiKeyParameterName,
      });
      return response(STATUS.UNAUTHORIZED, {
        error: 'Unauthorized',
        message: 'Invalid or missing API key',
      });
    }
  } catch (error) {
    console.error('API key check failed', error);
    return response(STATUS.INTERNAL_ERROR, { error: 'Internal Server Error' });
  }

  // 2. Read and validate the request.
  const body = parseBody(event);
  if (body === null) {
    return response(STATUS.BAD_REQUEST, { error: 'Bad Request', message: 'Invalid JSON body' });
  }
  if (body.tag === undefined || body.tag === null) {
    return response(STATUS.BAD_REQUEST, {
      error: 'Bad Request',
      message: 'Missing required field: tag',
    });
  }

  const tag = normaliseTag(body.tag);
  if (!tag.ok) {
    return response(STATUS.BAD_REQUEST, { error: 'Bad Request', message: tag.reason });
  }

  // 3. Compose and run. An unsupported provider throws here rather than leaving
  // a deployment that quietly notifies nobody.
  let result;
  try {
    const useCase = new ScanTagUseCase({
      tagRepository: new DynamoTagRepository(dynamo, config),
      eventRepository: new DynamoEventRepository(dynamo, config),
      messenger: createMessenger(config.messagingProvider, {
        tokenProvider: () => parameters.get(config.messagingTokenParameterName),
        whatsappPhoneNumberId: config.whatsappPhoneNumberId,
      }),
      messages: createMessages(config),
      config,
    });

    result = await useCase.execute({
      tag: tag.value,
      nodeId: body.nodeId ?? body.node_id,
      clientTimestamp: body.timestamp ?? body.ts,
      idempotencyKey: body.eventId ?? header(event, 'idempotency-key'),
    });
  } catch (error) {
    // Labelled by what it is, not by what it usually is: wrapping the whole use
    // case and calling every failure "DynamoDB" hid decision-logic bugs behind
    // a storage message during bring-up.
    console.error('Tag scan failed', error);
    return response(STATUS.INTERNAL_ERROR, { error: 'Internal Server Error' });
  }

  if (result.duplicate) {
    // The conditional write found this event already stored — a retried POST.
    // It is the only evidence idempotency ever fires, and today it can only
    // happen when the caller supplies a key or a dedup window is configured.
    console.info('Duplicate event suppressed', { tag: tag.value });
  }

  return response(result.status, result.body);
};

// Exposed for tests that need to clear the cold-start caches.
exports.__resetForTests = () => {
  verifier = null;
  parameters.clear();
};
